"""Aggregate read-only state observation; never a backup or a claim that the Host is stopped."""
from pathlib import Path
import json, sqlite3, sys
from upgrade_plan import require,PlanError

FILES=['gateway.sqlite','coordinator/tasks.sqlite','scheduler/jobs.sqlite']

def inspect_state(state):
    state=Path(state).absolute()
    require(state.resolve()==state,'STATE_SYMLINK')
    reports=[]
    for name in FILES:
        path=state/name
        if not path.exists():
            require(not path.is_symlink(),'STATE_SYMLINK')
            continue
        require(not path.is_symlink() and path.resolve()==path,'STATE_SYMLINK')
        connection=None
        try:
            connection=sqlite3.connect(path.as_uri()+'?mode=ro',uri=True,timeout=2)
            connection.execute('PRAGMA query_only=ON');connection.execute('BEGIN')
            tables={r[0] for r in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            item={'file':name,'tableCount':len(tables),'counts':{},'versions':None}
            for table,column in [('jobs','status'),('runs','status'),('development_requests','state'),('tasks','busy'),('approval_requests','state'),
                                 ('delivery_actions','state'),('delivery_operations','state')]:
                if table not in tables:continue
                columns={r[1] for r in connection.execute('PRAGMA table_info("'+table+'")')}
                require(column in columns,'STATE_SCHEMA_UNREVIEWED')
                item['counts'][table]=[list(row) for row in connection.execute('SELECT "'+column+'",COUNT(*) FROM "'+table+'" GROUP BY "'+column+'" ORDER BY "'+column+'"')]
                if table=='jobs' and 'version' in columns:
                    item['versions']=[list(row) for row in connection.execute('SELECT version,COUNT(*) FROM jobs GROUP BY version ORDER BY version')]
            if name=='scheduler/jobs.sqlite':
                rows=list(connection.execute('SELECT host,port FROM scheduler_owner')) if 'scheduler_owner' in tables else []
                require(len(rows)<=1,'SCHEDULER_OWNER_AMBIGUOUS')
                item['ownerPresent']=bool(rows)
                item['ownerPort']=rows[0][1] if rows else None
                item['legacyOwnerMigrationRequired']=not bool(rows)
            reports.append(item)
        except sqlite3.Error:
            raise PlanError('STATE_READ_FAILED') from None
        finally:
            if connection is not None:connection.close()
    return {'mode':'read-only-observation','databases':reports,'databaseBackup':False,'hostStoppedVerified':False,'globalAtomicSnapshot':False,'mayDeploy':False,'replayedJobs':False}

if __name__=='__main__':
    try:print(json.dumps(inspect_state(Path(sys.argv[1])),ensure_ascii=False,indent=2))
    except PlanError as e:print(json.dumps({'error':str(e),'mayDeploy':False}));raise SystemExit(2)
