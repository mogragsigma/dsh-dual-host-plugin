"""Operator-only three-artifact file transaction. No service control, model tool or apply CLI.

A caller must supply a real stopped-Host guard held for the whole operation. Tests
supply a fixture guard; that is not evidence a formal Host was stopped. Database
backups are retained, never automatically restored. Dependencies are pre-materialized
inputs, not fetched or patched here. This is not an OS account isolation boundary.
"""
from pathlib import Path
from contextlib import contextmanager
import fcntl,hashlib,json,os,shutil,stat,tempfile,uuid
from upgrade_plan import materials,bundle_manifest,read,sha,require,target_path,PlanError,MAX_FILE
from rollback_policy import initialization_additions,RULE
from current_rollback_policy import initialization_additions as current_initialization_additions,RULE as CURRENT_RULE
from alpha17_rollback_policy import initialization_additions as alpha17_initialization_additions,RULE as ALPHA17_RULE
from alpha18_rollback_policy import initialization_additions as alpha18_initialization_additions,RULE as ALPHA18_RULE
from rollback_patch_review import review as review_patch
import upgrade_plan
from transaction_state import snapshot,assert_exact,assert_rollback_compatible,backup,file_hash


def canonical(value):return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()
def fingerprint(value):return sha(canonical(value))
def manifest_fingerprint(value):return sha(json.dumps(value,sort_keys=True,separators=(',',':')).encode())
def sync_dir(path):
    fd=os.open(path,os.O_RDONLY)
    try:os.fsync(fd)
    finally:os.close(fd)

def atomic(path,data,mode=0o600):
    path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    fd,tmp=tempfile.mkstemp(prefix='.dsh-install-',dir=path.parent)
    try:
        with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
        os.chmod(tmp,mode);os.replace(tmp,path);sync_dir(path.parent)
    finally:Path(tmp).unlink(missing_ok=True)

def present(home,path):
    target_path(home,path)
    return sha(read(path)) if path.exists() else None

@contextmanager
def locked(home):
    folder=home/'task-gateway';target_path(home,folder);require(folder.is_dir(),'OWN_ROOT_REQUIRED')
    lock=folder/'.installation.lock';target_path(home,lock)
    fd=os.open(lock,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
    try:
        require(stat.S_ISREG(os.fstat(fd).st_mode) and os.fstat(fd).st_nlink==1,'INSTALL_LOCK_UNSAFE')
        try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise PlanError('INSTALL_TRANSACTION_BUSY') from None
        yield
    finally:os.close(fd)

def dependency_manifest(root,dependencies):
    if not dependencies:
        require(not root.exists(),'UNEXPECTED_DEPENDENCIES');return {}
    require(root.is_dir() and not root.is_symlink() and root.resolve()==root,'DEPENDENCIES_REQUIRED')
    result={}
    for p in sorted(root.rglob('*')):
        rel=p.relative_to(root).as_posix()
        if p.is_symlink():
            link=os.readlink(p)
            require(not os.path.isabs(link) and p.resolve().is_relative_to(root) and p.resolve().exists(),'DEPENDENCY_EXTERNAL_LINK')
            result[rel]={'link':link}
        elif p.is_file():result[rel]={'sha256':file_hash(p)}
        else:require(p.is_dir(),'DEPENDENCY_SPECIAL_FILE')
    for name,version in dependencies.items():
        require(isinstance(name,str) and '..' not in Path(name).parts and not Path(name).is_absolute(),'DEPENDENCY_NAME')
        pkg=json.loads(read(root/name/'package.json'))
        require(pkg.get('name')==name and pkg.get('version')==version,'DEPENDENCY_VERSION_MISMATCH')
    return result

def target_manifest(root,dependencies):
    own,pkg,_=bundle_manifest(root/'bundle')
    return {'own':own,'config':sha(read(root/'config.json')),'dependencies':dependency_manifest(root/'bundle/node_modules',dependencies)}

def guarded_state(home,plan,baseline,rollback=False,additions=None):
    state=home/plan['state_relative'];target_path(home,state)
    return assert_rollback_compatible(state,baseline,additions) if rollback else assert_exact(state,baseline)

def ensure_owner(home,plan):
    from state_inspection import inspect_state
    import socket,sqlite3
    for db in inspect_state(home/plan['state_relative'])['databases']:
        if db['file']!='scheduler/jobs.sqlite':continue
        require(db.get('ownerPresent') and db.get('ownerPort')==plan['prior_scheduler_lock_port'],'OWNER_MIGRATION_REQUIRED')
        c=sqlite3.connect((home/plan['state_relative']/'scheduler/jobs.sqlite').as_uri()+'?mode=ro',uri=True)
        try:require(c.execute('SELECT host FROM scheduler_owner').fetchone()[0]==socket.gethostname(),'OWNER_HOST_MISMATCH')
        finally:c.close()


def prepare(home,profile,candidate,expected_plan_fingerprint,stop_guard,dependencies=None):
    """Prepare private immutable payloads/backups; no profile or existing managed file changes."""
    home,candidate=Path(home).absolute(),Path(candidate).absolute()
    with stop_guard() as lease,locked(home):
        require(callable(getattr(lease,'assert_stopped',None)),'HOST_GUARD_REQUIRED')
        lease.assert_stopped(home,profile)
        plan,payloads,old=materials(home,profile,candidate)
        lease.assert_stopped(home,profile,[plan['prior_scheduler_lock_port']])
        require(plan['fingerprint']==expected_plan_fingerprint,'PLAN_CHANGED');ensure_owner(home,plan)
        dm=None
        if plan['candidate_dependencies']:
            require(dependencies is not None,'DEPENDENCIES_REQUIRED')
            dependencies=Path(dependencies).absolute();dm=dependency_manifest(dependencies,plan['candidate_dependencies'])
        before=snapshot(home/plan['state_relative'])
        root=home/'task-gateway/transactions';target_path(home,root);root.mkdir(exist_ok=True,mode=0o700)
        tx=root/str(uuid.uuid4());tx.mkdir(mode=0o700)
        atomic(tx/'state.json',canonical({'phase':'preparing'}))
        state_backups=backup(home/plan['state_relative'],tx/'state-backup',before)
        rows=[]
        # Activate the profile only after the complete rules/Skills are in place.
        for i,row in enumerate(sorted(plan['changes'],key=lambda x:(x['kind']=='own-entry-paths',x['path']))):
            lease.assert_stopped(home,profile,[plan['prior_scheduler_lock_port']])
            path=home/row['path'];require(present(home,path)==row['before'],'FILE_CHANGED')
            mode=stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o600
            if path.exists():atomic(tx/f'before/{i}',read(path))
            atomic(tx/f'after/{i}',payloads[row['path']]);rows.append({**row,'index':i,'mode':mode})
        stage=tx/'version';(stage/'bundle').mkdir(parents=True,mode=0o700)
        manifest,_,_=bundle_manifest(candidate)
        for name,digest in manifest.items():
            data=read(candidate/name);require(sha(data)==digest,'CANDIDATE_CHANGED');atomic(stage/'bundle'/name,data)
        atomic(stage/'config.json',read(old.parent/'config.json'))
        if dm is not None:
            shutil.copytree(dependencies,stage/'bundle/node_modules',symlinks=True)
            require(dependency_manifest(stage/'bundle/node_modules',plan['candidate_dependencies'])==dm,'DEPENDENCIES_CHANGED')
        final=target_manifest(stage,plan['candidate_dependencies'])
        require(manifest_fingerprint(final['own'])==plan['candidate_bundle_sha256'],'CANDIDATE_CHANGED')
        require(materials(home,profile,candidate)[0]==plan,'PLAN_CHANGED')
        assert_exact(home/plan['state_relative'],before)
        manifest={'schema':1,'home':str(home),'transaction':str(tx),'plan':plan,'rows':rows,'state_baseline':before,'state_backups':state_backups,'target_manifest':final}
        lease.assert_stopped(home,profile,[plan['prior_scheduler_lock_port']])
        proof=fingerprint(manifest);atomic(tx/'manifest.json',canonical(manifest))
        atomic(tx/'state.json',canonical({'phase':'prepared','done':[],'undone':[],'target_installed':False}))
        return {'transaction':str(tx),'fingerprint':proof,'phase':'prepared','profileChanged':False,'stateRestored':False}


def load(tx,proof):
    tx=Path(tx).absolute();require(tx.resolve()==tx and not tx.is_symlink(),'TRANSACTION_PATH_UNSAFE')
    m=json.loads(read(tx/'manifest.json'));require(fingerprint(m)==proof,'TRANSACTION_PROOF_MISMATCH')
    home=Path(m['home']);require(home.resolve()==home and tx==Path(m['transaction']) and tx.parent==home/'task-gateway/transactions','TRANSACTION_HOME_MISMATCH')
    target_path(home,tx);state=json.loads(read(tx/'state.json'))
    require(state.get('phase') in {'prepared','applying','applied','rolling_back','rolled_back'},'TRANSACTION_PHASE_INVALID')
    for row in m['rows']:
        target_path(home,home/row['path'])
        require(sha(read(tx/f"after/{row['index']}"))==row['after'],'PAYLOAD_CHANGED')
        if row['before'] is not None:require(sha(read(tx/f"before/{row['index']}"))==row['before'],'BACKUP_CHANGED')
    for name,digest in m['state_backups'].items():require(file_hash(tx/'state-backup'/name)==digest,'STATE_BACKUP_CHANGED')
    return tx,m,state

def invariants(home,m):
    root=m['plan'].get('profile_root')
    if root:
        require(upgrade_plan.profile_root_contract()==root['contract'],'PROFILE_ROOT_CONTRACT_CHANGED')
        read(home/root['path'])  # May be regenerated by DSH; still reject links/special files.
    changed={r['path'] for r in m['rows']}
    for rel,digest in m['plan']['unchanged_inputs'].items():
        if rel not in changed:require(present(home,home/rel)==digest,'UNRELATED_INPUT_CHANGED')
    old=home/'task-gateway'/('v'+m['plan']['source_version'])/'bundle'
    require(manifest_fingerprint(bundle_manifest(old)[0])==m['plan']['source_bundle_sha256'],'SOURCE_BUNDLE_CHANGED')

def checkpoint(tx,state):atomic(tx/'state.json',canonical(state))

def apply(tx,proof,stop_guard,hook=lambda point:None):
    tx,m,state=load(tx,proof);home=Path(m['home'])
    with stop_guard() as lease,locked(home):
        require(callable(getattr(lease,'assert_stopped',None)),'HOST_GUARD_REQUIRED')
        lease.assert_stopped(home,m['plan']['profile'],[m['plan']['prior_scheduler_lock_port']])
        tx,m,state=load(tx,proof);require(state['phase'] in {'prepared','applying','applied'},'TRANSACTION_NOT_APPLICABLE')
        invariants(home,m);guarded_state(home,m['plan'],m['state_baseline'])
        # Check the entire transaction before the first new effect, not one file at a time.
        for row in m['rows']:
            current=present(home,home/row['path'])
            require(current==row['after'] if row['index'] in state['done'] else current in (row['before'],row['after']),'FILE_CHANGED')
        target=(home/m['plan']['target_relative']).parent;target_path(home,target)
        if target.exists():require(target_manifest(target,m['plan']['candidate_dependencies'])==m['target_manifest'],'TARGET_CHANGED')
        else:require(not state['target_installed'] and target_manifest(tx/'version',m['plan']['candidate_dependencies'])==m['target_manifest'],'STAGED_TARGET_CHANGED')
        lease.assert_stopped(home,m['plan']['profile'],[m['plan']['prior_scheduler_lock_port']])
        state['phase']='applying';checkpoint(tx,state)
        if not target.exists():
            os.rename(tx/'version',target);sync_dir(target.parent);hook('target-renamed')
        state['target_installed']=True;checkpoint(tx,state)
        for row in m['rows']:
            lease.assert_stopped(home,m['plan']['profile'],[m['plan']['prior_scheduler_lock_port']])
            guarded_state(home,m['plan'],m['state_baseline']);path=home/row['path'];current=present(home,path)
            require(current in (row['before'],row['after']),'FILE_CHANGED')
            if current!=row['after']:
                data=read(tx/f"after/{row['index']}");require(sha(data)==row['after'],'PAYLOAD_CHANGED')
                atomic(path,data,row['mode']);hook('file-written:'+str(row['index']))
            if row['index'] not in state['done']:state['done'].append(row['index']);checkpoint(tx,state)
        invariants(home,m);guarded_state(home,m['plan'],m['state_baseline'])
        require(all(present(home,home/r['path'])==r['after'] for r in m['rows']),'FILE_CHANGED')
        require(target_manifest(target,m['plan']['candidate_dependencies'])==m['target_manifest'],'TARGET_CHANGED')
        lease.assert_stopped(home,m['plan']['profile'],[m['plan']['prior_scheduler_lock_port']])
        state['phase']='applied';checkpoint(tx,state)
        return {'phase':'applied','hostStarted':False,'stateRestored':False,'files':len(m['rows'])}


def rollback_state(tx,m):
    additions=initialization_additions(tx,m);rule=RULE if additions else None
    if not additions:
        additions=current_initialization_additions(tx,m);rule=CURRENT_RULE if additions else None
    if not additions:
        additions=alpha17_initialization_additions(tx,m);rule=ALPHA17_RULE if additions else None
    if not additions:
        additions=alpha18_initialization_additions(tx,m);rule=ALPHA18_RULE if additions else None
    return additions,rule


def patch_override(tx,m,proof,expected=None,save=False):
    record=tx/'rollback-patch-review.json'
    target_path(Path(m['home']),record)
    if save and expected is None:
        require(not record.exists() and not record.is_symlink(),'PATCH_REVIEW_FINGERPRINT_REQUIRED')
        return None
    rows=[r for r in m['rows'] if r['kind']=='own-entry-paths']
    require(len(rows)==1,'PATCH_REVIEW_SCOPE');row=rows[0]
    current=read(Path(m['home'])/row['path'])
    stored=json.loads(read(record)) if record.exists() else None
    source=stored['input'].encode('utf-8') if stored else current
    plan,output=review_patch(m,proof,row,read(tx/f"before/{row['index']}"),read(tx/f"after/{row['index']}"),source)
    if stored:require(stored['review']==plan,'PATCH_REVIEW_RECORD_CHANGED')
    if save:require(expected==plan['fingerprint'],'PATCH_REVIEW_FINGERPRINT_MISMATCH')
    require(sha(current) in (plan['inputSHA256'],plan['outputSHA256']),'PATCH_REVIEW_CURRENT_CHANGED')
    if save and not stored:
        sealed=canonical({'review':plan,'input':source.decode('utf-8')})
        require(len(sealed)<=MAX_FILE,'PATCH_REVIEW_RECORD_TOO_LARGE')
        atomic(record,sealed)
    return row,plan,output


def rollback_review(tx,proof,stop_guard):
    """Read-only review: only hashes/counts, never config text or credentials."""
    tx,m,state=load(tx,proof);home=Path(m['home'])
    with stop_guard() as lease,locked(home):
        require(callable(getattr(lease,'assert_stopped',None)),'HOST_GUARD_REQUIRED')
        lease.assert_stopped(home,m['plan']['profile'],[m['plan']['prior_scheduler_lock_port']])
        tx,m,state=load(tx,proof);require(state['phase']=='applied','PATCH_REVIEW_PHASE')
        additions,_=rollback_state(tx,m)
        invariants(home,m);guarded_state(home,m['plan'],m['state_baseline'],rollback=True,additions=additions)
        for row in m['rows']:
            if row['kind']!='own-entry-paths':require(present(home,home/row['path'])==row['after'],'FILE_CHANGED')
        return patch_override(tx,m,proof)[1]


def rollback(tx,proof,stop_guard,hook=lambda point:None,patch_review_fingerprint=None):
    tx,m,state=load(tx,proof);home=Path(m['home'])
    with stop_guard() as lease,locked(home):
        require(callable(getattr(lease,'assert_stopped',None)),'HOST_GUARD_REQUIRED')
        lease.assert_stopped(home,m['plan']['profile'],[m['plan']['prior_scheduler_lock_port']])
        tx,m,state=load(tx,proof);require(state['phase'] in {'prepared','applying','applied','rolling_back','rolled_back'},'TRANSACTION_NOT_ROLLBACKABLE')
        additions,compatibility_rule=rollback_state(tx,m)
        invariants(home,m);guarded_state(home,m['plan'],m['state_baseline'],rollback=True,additions=additions)
        override=patch_override(tx,m,proof,patch_review_fingerprint,save=True)
        rows=[dict(row) for row in m['rows']]
        if override:
            original,review,payload=override
            for row in rows:
                if row['index']==original['index']:row.update(before=review['outputSHA256'],after=review['inputSHA256'])
        for row in rows:
            current=present(home,home/row['path'])
            require(current==row['before'] if row['index'] in state['undone'] else current in (row['before'],row['after']),'FILE_CHANGED')
        lease.assert_stopped(home,m['plan']['profile'],[m['plan']['prior_scheduler_lock_port']])
        state['phase']='rolling_back';checkpoint(tx,state)
        # Restore entry first, still under the caller's whole-operation stopped guard.
        for row in reversed(rows):
            lease.assert_stopped(home,m['plan']['profile'],[m['plan']['prior_scheduler_lock_port']])
            guarded_state(home,m['plan'],m['state_baseline'],rollback=True,additions=additions);path=home/row['path'];current=present(home,path)
            require(current in (row['before'],row['after']),'FILE_CHANGED')
            if current!=row['before']:
                if row['before'] is None:path.unlink();sync_dir(path.parent)
                else:
                    data=payload if override and row['index']==original['index'] else read(tx/f"before/{row['index']}")
                    require(sha(data)==row['before'],'BACKUP_CHANGED')
                    atomic(path,data,row['mode'])
                hook('file-restored:'+str(row['index']))
            if row['index'] not in state['undone']:state['undone'].append(row['index']);checkpoint(tx,state)
        invariants(home,m);guarded_state(home,m['plan'],m['state_baseline'],rollback=True,additions=additions)
        require(all(present(home,home/r['path'])==r['before'] for r in rows),'FILE_CHANGED')
        lease.assert_stopped(home,m['plan']['profile'],[m['plan']['prior_scheduler_lock_port']])
        state['phase']='rolled_back';checkpoint(tx,state)
        return {'phase':'rolled_back','hostStarted':False,'stateRestored':False,'candidateDirectoryRetained':True,'compatibilityRule':compatibility_rule,
                'patchReview':review['fingerprint'] if override else None,'unrelatedPatchPreserved':bool(override)}
