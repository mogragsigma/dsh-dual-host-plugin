"""Read-only compatibility fence. Backups are retained; rollback never restores a database."""
from pathlib import Path
import hashlib,json,sqlite3,stat
from upgrade_plan import require,PlanError

MAX_ROWS=1000000

def file_hash(path,limit=None):
    h=hashlib.sha256();count=0
    with path.open('rb') as f:
        while True:
            b=f.read(min(1048576,limit-count) if limit is not None else 1048576)
            if not b:break
            h.update(b);count+=len(b)
            if limit is not None and count==limit:break
    return h.hexdigest()

def encode(value):
    if isinstance(value,bytes):return {'blob':value.hex()}
    return value

def quoted(name):return '"'+name.replace('"','""')+'"'

def db_snapshot(path):
    db=sqlite3.connect(path.as_uri()+'?mode=ro',uri=True,timeout=2)
    try:
        db.execute('PRAGMA query_only=ON');db.execute('BEGIN')
        tables=list(db.execute("SELECT name,sql FROM sqlite_master WHERE type='table' AND (name NOT LIKE 'sqlite_%' OR name='sqlite_sequence') ORDER BY name"))
        result={}
        for name,table_sql in tables:
            columns=[list(r)[1:] for r in db.execute('PRAGMA table_info('+quoted(name)+')')]
            names=[c[0] for c in columns]
            selected=names
            digests=[]
            for row in db.execute('SELECT '+','.join(map(quoted,selected))+' FROM '+quoted(name)):
                require(len(digests)<MAX_ROWS,'STATE_TOO_LARGE_FOR_AUTOMATIC_ROLLBACK')
                digests.append(hashlib.sha256(json.dumps([encode(x) for x in row],ensure_ascii=False,separators=(',',':'),allow_nan=False).encode()).digest())
            result[name]={'columns':columns,'sql_sha256':hashlib.sha256(table_sql.encode()).hexdigest(),'count':len(digests),'rows_sha256':hashlib.sha256(b''.join(sorted(digests))).hexdigest()}
        objects=[{'type':kind,'name':name,'table':table,'sql_sha256':hashlib.sha256(sql.encode()).hexdigest()} for kind,name,table,sql in db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('index','trigger','view') AND sql IS NOT NULL ORDER BY type,name")]
        return {'tables':result,'objects':objects}
    except sqlite3.Error:
        raise PlanError('STATE_SNAPSHOT_FAILED') from None
    finally:db.close()

def inventory(root):
    root=Path(root).absolute();require(root.resolve()==root,'STATE_SYMLINK')
    files=[]
    if not root.exists():return files
    for p in sorted(root.rglob('*')):
        require(not p.is_symlink(),'STATE_SYMLINK')
        s=p.stat();require(stat.S_ISDIR(s.st_mode) or stat.S_ISREG(s.st_mode) and s.st_nlink==1,'STATE_SPECIAL_FILE')
        if p.is_file():files.append(p)
    return files

def snapshot(root):
    root=Path(root).absolute();result={'databases':{},'files':{}}
    for path in inventory(root):
        rel=path.relative_to(root).as_posix()
        if rel.endswith(('.sqlite-wal','.sqlite-shm')):
            require(path.with_name(path.name.rsplit('-',1)[0]).is_file(),'STATE_ORPHAN_SIDECAR');continue
        if path.suffix=='.sqlite':result['databases'][rel]=db_snapshot(path)
        else:result['files'][rel]={'size':path.stat().st_size,'sha256':file_hash(path)}
    return result

def assert_exact(root,before):
    require(snapshot(root)==before,'STATE_CHANGED')

def assert_rollback_compatible(root,before,initialization_additions=None):
    """Retain additive empty schema and append-only audit log, never discard new state."""
    root=Path(root).absolute();current=snapshot(root)
    require(set(before['databases'])<=set(current['databases']),'STATE_DATABASE_REMOVED')
    require(set(before['files'])==set(current['files']),'STATE_FILE_SET_CHANGED')
    for name,old in before['files'].items():
        now=current['files'][name]
        if now==old:continue
        require(name=='events.jsonl' and now['size']>=old['size'] and file_hash(root/name,old['size'])==old['sha256'],'STATE_FILE_CHANGED')
    for name,now in current['databases'].items():
        tables=now['tables'];old_database=before['databases'].get(name,{'tables':{},'objects':[]});old=old_database['tables']
        require(set(old)<=set(tables),'STATE_TABLE_REMOVED')
        for table,row in tables.items():
            if table not in old:
                expected=(initialization_additions or {}).get(name,{}).get(table)
                require(row['count']==0 or expected is not None and row==expected,'STATE_NEW_TABLE_DATA');continue
            prior=old[table]
            require(row['columns']==prior['columns'] and row['sql_sha256']==prior['sql_sha256'],'STATE_SCHEMA_CHANGED')
            require(row['count']==prior['count'] and row['rows_sha256']==prior['rows_sha256'],'STATE_HISTORY_CHANGED')
        prior_objects={(x['type'],x['name']):x for x in old_database['objects']}
        current_objects={(x['type'],x['name']):x for x in now['objects']}
        require(all(current_objects.get(k)==v for k,v in prior_objects.items()),'STATE_SCHEMA_OBJECT_CHANGED')
        for key,obj in current_objects.items():
            if key in prior_objects:continue
            require(obj['type']=='index' and obj['table'] not in old and obj['table'] in tables and tables[obj['table']]['count']==0,'STATE_SCHEMA_OBJECT_REVIEW_REQUIRED')
    return current

def backup(root,destination,before):
    root,destination=Path(root).absolute(),Path(destination)
    destination.mkdir(mode=0o700)
    assert_exact(root,before)
    manifest={}
    for path in inventory(root):
        rel=path.relative_to(root).as_posix()
        if rel.endswith(('.sqlite-wal','.sqlite-shm')):continue
        target=destination/rel;target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        if path.suffix=='.sqlite':
            source=sqlite3.connect(path.as_uri()+'?mode=ro',uri=True);dest=sqlite3.connect(target)
            try:source.backup(dest)
            finally:source.close();dest.close()
        else:
            import shutil
            shutil.copyfile(path,target)
        target.chmod(0o600);manifest[rel]=file_hash(target)
    assert_exact(root,before);require(snapshot(destination)==before,'STATE_BACKUP_MISMATCH')
    return manifest
