"""Own-plugin operator tools. No default mutation, no model RPC or service control.
Every mutation requires external plan/transaction and Host record fingerprints.
"""
from pathlib import Path
import argparse,json,os,re,sys
from upgrade_plan import plan,read,sha,require,PlanError
from release_bundle import verify,unpack
from stopped_host import StoppedHostLease
from service_guard import ServiceStoppedLease,capture
from install_transaction import prepare,apply,rollback,rollback_review,load
from state_inspection import inspect_state
from owner_migration import migration_plan,adopt


def guard(path,proof):
    raw=read(path);require(sha(raw)==proof,'HOST_RECORD_CHANGED');kind=json.loads(raw).get('kind')
    return (StoppedHostLease if kind=='owned-isolated-cli' else ServiceStoppedLease)(path,proof)


def new_json(path,data):
    path=Path(path).absolute();require(path.parent.resolve()==path.parent and path.parent.is_dir(),'OUTPUT_PARENT_UNSAFE')
    require(not path.exists() and not path.is_symlink(),'OUTPUT_EXISTS')
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    raw=(json.dumps(data,ensure_ascii=False,sort_keys=True,indent=2)+'\n').encode()
    with os.fdopen(fd,'wb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
    return {'file':str(path),'sha256':sha(raw)}


def main(argv=None):
    os.umask(0o077);p=argparse.ArgumentParser(description=__doc__);s=p.add_subparsers(dest='op',required=True)
    for op in ['verify','unpack']:
        q=s.add_parser(op);q.add_argument('--archive',required=True,type=Path);q.add_argument('--sha256',required=True)
        if op=='unpack':q.add_argument('--destination',required=True,type=Path)
    for op in ['plan','prepare','owner-plan','owner-adopt']:
        q=s.add_parser(op);q.add_argument('--home',required=True,type=Path);q.add_argument('--profile',required=True);q.add_argument('--candidate',required=True,type=Path)
        if op!='plan':q.add_argument('--plan-fingerprint',required=True)
        if op=='prepare':q.add_argument('--dependencies',type=Path)
        if op in ['prepare','owner-adopt']:q.add_argument('--host-record',required=True,type=Path);q.add_argument('--host-sha256',required=True)
        if op=='owner-plan':q.add_argument('--output',required=True,type=Path)
        if op=='owner-adopt':
            q.add_argument('--migration-plan',required=True,type=Path);q.add_argument('--migration-sha256',required=True);q.add_argument('--backup',required=True,type=Path)
    for op in ['status','apply','rollback','rollback-review']:
        q=s.add_parser(op);q.add_argument('--transaction',required=True,type=Path);q.add_argument('--fingerprint',required=True)
        if op!='status':q.add_argument('--host-record',required=True,type=Path);q.add_argument('--host-sha256',required=True)
        if op=='rollback':q.add_argument('--patch-review-fingerprint')
    q=s.add_parser('host-record');q.add_argument('--home',required=True,type=Path);q.add_argument('--profile',required=True);q.add_argument('--kind',choices=['macos-desktop','systemd-service'],required=True);q.add_argument('--application',type=Path);q.add_argument('--unit');q.add_argument('--output',required=True,type=Path)
    q=s.add_parser('check-stopped');q.add_argument('--host-record',required=True,type=Path);q.add_argument('--host-sha256',required=True)
    q=s.add_parser('inspect-state');q.add_argument('--state',required=True,type=Path)
    a=p.parse_args(argv)
    if a.op=='verify':return verify(a.archive,a.sha256)
    if a.op=='unpack':return unpack(a.archive,a.sha256,a.destination)
    if a.op=='plan':return plan(a.home,a.profile,a.candidate)
    if a.op=='inspect-state':return inspect_state(a.state)
    if a.op=='host-record':return new_json(a.output,capture(a.home,a.profile,a.kind,a.application,a.unit))
    if a.op=='owner-plan':return new_json(a.output,migration_plan(a.home,a.profile,a.candidate,a.plan_fingerprint))
    if a.op=='status':
        tx,m,state=load(a.transaction,a.fingerprint)
        return {'transaction':str(tx),'phase':state['phase'],'files':len(m['rows']),'done':len(state['done']),'undone':len(state['undone']),'hostStarted':False,'stateRestored':False,'currentHostState':'not inspected'}
    lease=guard(a.host_record,a.host_sha256)
    if a.op=='check-stopped':
        with lease.hold():return {'stoppedVerifiedNow':True,'leaseReleasedOnExit':True,'notReusableBooleanApproval':True}
    if a.op=='prepare':return prepare(a.home,a.profile,a.candidate,a.plan_fingerprint,lease.hold,a.dependencies)
    if a.op=='owner-adopt':
        raw=read(a.migration_plan);require(sha(raw)==a.migration_sha256,'OWNER_PLAN_CHANGED')
        return adopt(a.home,a.profile,a.candidate,a.plan_fingerprint,json.loads(raw),a.backup,lease)
    if a.op=='rollback-review':return rollback_review(a.transaction,a.fingerprint,lease.hold)
    if a.op=='rollback':return rollback(a.transaction,a.fingerprint,lease.hold,patch_review_fingerprint=a.patch_review_fingerprint)
    return apply(a.transaction,a.fingerprint,lease.hold)

if __name__=='__main__':
    try:print(json.dumps(main(),ensure_ascii=False,indent=2))
    except Exception as e:
        code=str(e) if isinstance(e,PlanError) and re.fullmatch('[A-Z0-9_]+',str(e)) else 'OPERATOR_INPUT_OR_RUNTIME_FAILURE'
        print(json.dumps({'error':code,'inspectTransactionBeforeRetry':True,'rollbackOrRetryNotAutomatic':True}));sys.exit(2)
