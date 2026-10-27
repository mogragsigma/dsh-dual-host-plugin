"""Operator-only legacy scheduler owner plan/adoption, using the verified own runtime.
No Host/service controller and no task recovery/retry. The Node migration owns the
original scheduler port; Python reserves the other Host ports during adoption.
"""
from pathlib import Path
import json,socket,subprocess
from upgrade_plan import plan,require,read,sha,target_path,PlanError
from install_transaction import locked
from transaction_state import db_snapshot,file_hash

NODE="""import {pathToFileURL} from 'node:url';
let input='';for await(const c of process.stdin)input+=c;
const a=JSON.parse(input),m=await import(pathToFileURL(a.module));
const result=a.action==='plan'?m.schedulerMigrationPlan(a.stateDir,a.options):await m.adoptSchedulerOwner(a.migration,{confirmLegacyStopped:true,backupPath:a.backup});
process.stdout.write(JSON.stringify(result));"""


def node(payload):
    p=subprocess.run(['node','--input-type=module','-e',NODE],input=json.dumps(payload),capture_output=True,text=True)
    if p.returncode:
        import re
        code=re.search(r'Error: (SCHEDULER_[A-Z_]+)',p.stderr)
        if 'EADDRINUSE' in p.stderr:raise PlanError('EADDRINUSE')
        raise PlanError(code[1] if code else 'OWNER_MIGRATION_NODE_FAILED')
    try:return json.loads(p.stdout)
    except ValueError:raise PlanError('OWNER_MIGRATION_RESULT_INVALID') from None


def scope(home,profile,candidate,expected):
    p=plan(home,profile,candidate);require(p['fingerprint']==expected,'PLAN_CHANGED')
    require(p['role']=='cloud' and p['prior_scheduler_lock_port'],'OWNER_MIGRATION_CLOUD_REQUIRED')
    cfg=Path(home)/'task-gateway'/('v'+p['source_version'])/'config.json'
    return p,{'priorLockPort':p['prior_scheduler_lock_port'],'sourceVersion':p['source_version'],'sourceConfigHash':sha(read(cfg))}


def migration_plan(home,profile,candidate,expected):
    p,options=scope(home,profile,candidate,expected)
    db=Path(home)/p['state_relative']/'scheduler/jobs.sqlite';before=db_snapshot(db)
    result=node({'module':str(Path(candidate).absolute()/'scheduler-migration.js'),'action':'plan','stateDir':str(Path(home)/p['state_relative']/'scheduler'),'options':options})
    require(db_snapshot(db)==before,'OWNER_MIGRATION_STALE_PLAN')
    return {'schema':1,'database_before':before,'configuration_plan_fingerprint':p['fingerprint'],'home':str(Path(home).absolute()),'profile':profile,'migration':result}


def adopt(home,profile,candidate,expected,migration,backup,lease):
    home=Path(home).absolute();p,options=scope(home,profile,candidate,expected)
    require(migration.get('schema')==1 and migration.get('configuration_plan_fingerprint')==expected and migration.get('home')==str(home) and migration.get('profile')==profile,'OWNER_MIGRATION_SCOPE_MISMATCH')
    m=migration['migration']
    require(all(m.get(k)==v for k,v in options.items()) and m['identity']['path']==str(home/p['state_relative']/'scheduler/jobs.sqlite'),'OWNER_MIGRATION_SCOPE_MISMATCH')
    backup=Path(backup).absolute();target_path(home,backup)
    require(backup.is_relative_to(home/'task-gateway/migrations') and backup.suffix=='.sqlite','OWNER_BACKUP_PATH_REQUIRED')
    ports=lease.record['ports'] if hasattr(lease,'record') else lease.r['ports']
    require(lease.home==home and (lease.record if hasattr(lease,'record') else lease.r)['profile']==profile and m['priorLockPort'] in ports,'HOST_GUARD_SCOPE_MISMATCH')
    # Deliberately not a normal installer lease: only Node may own the excluded port.
    sockets=[]
    with locked(home):
        lease.assert_processes_stopped()
        try:
            for port in ports:
                if port==m['priorLockPort']:continue
                s=socket.socket();sockets.append(s)
                try:s.bind(('127.0.0.1',port));s.listen(1)
                except OSError:raise PlanError('HOST_PORT_NOT_RELEASED') from None
            lease.assert_processes_stopped();backup.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
            result=node({'module':str(Path(candidate).absolute()/'scheduler-migration.js'),'action':'adopt','migration':m,'backup':str(backup)})
            lease.assert_processes_stopped()
            require(backup.is_file() and db_snapshot(backup)==migration.get('database_before'),'OWNER_BACKUP_MISMATCH')
            return {**result,'backupSha256':file_hash(backup),'stateRestored':False}
        finally:
            for s in sockets:s.close()
