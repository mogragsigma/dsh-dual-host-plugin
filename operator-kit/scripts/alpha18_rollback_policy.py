"""Independent alpha.18 initialization-only policy. See operator-v11-runtime-diff.json.
The alpha.2, alpha.14 and alpha.17 policies remain byte-identical; unknown versions do not inherit this rule.
The frozen alpha.2 policy is not inherited or altered. No data is deleted.

Binding BOTH bundle manifests is intentional: a version label alone cannot approve
unknown migrations. Notification constructor initializes its cursor at the existing
job_events maximum; derive that value from the sealed pre-upgrade backup, NEVER
from current upgraded state. All other new nonempty tables still block rollback.
"""
import hashlib,json,sqlite3
from upgrade_plan import require
from transaction_state import db_snapshot

SOURCE='9e136ebe5c216d52a1b2ca1692a50566ffbdd7690e8decdc92665b84feb8f418'
TARGET='579e2c7a06dcdba019cc2d9a58b08be43763488af45332c6bc86f2ed37807b3a'
RULE='v016a3-v024a18-reviewed-notification-initialization-only'


def initialization_additions(tx,manifest):
    p=manifest['plan'];b=manifest['state_baseline']
    if (p['source_version'],p['candidate_version'],p['source_bundle_sha256'],p['candidate_bundle_sha256'])!=('0.16.0-alpha.3','0.24.0-alpha.18',SOURCE,TARGET):return {}
    if p['role']!='cloud' or 'notification_meta' in b['databases'].get('gateway.sqlite',{}).get('tables',{}):return {}
    jobs='scheduler/jobs.sqlite';require(jobs in b['databases'],'ROLLBACK_INITIALIZATION_BASELINE_MISSING')
    file=tx/'state-backup'/jobs
    require(db_snapshot(file)==b['databases'][jobs],'ROLLBACK_INITIALIZATION_BACKUP_MISMATCH')
    db=sqlite3.connect(file.as_uri()+'?mode=ro',uri=True)
    try:cursor=db.execute('SELECT coalesce(max(seq),0) FROM job_events').fetchone()[0]
    finally:db.close()
    sql='CREATE TABLE notification_meta(singleton INTEGER PRIMARY KEY,cursor INTEGER NOT NULL)'
    row_hash=hashlib.sha256(json.dumps([1,cursor],separators=(',',':')).encode()).digest()
    row={'columns':[['singleton','INTEGER',0,None,1],['cursor','INTEGER',1,None,0]],'sql_sha256':hashlib.sha256(sql.encode()).hexdigest(),'count':1,'rows_sha256':hashlib.sha256(row_hash).hexdigest()}
    return {'gateway.sqlite':{'notification_meta':row}}
