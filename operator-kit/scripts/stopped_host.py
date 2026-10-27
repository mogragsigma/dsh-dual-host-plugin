"""Stopped lease for explicitly recorded, own isolated CLI Hosts (macOS/Linux).

Not a Desktop/systemd controller, not an OS identity boundary. Never kills a
process. The caller stops its own process first; the lease pins its launch record,
checks process identity on every assertion and reserves all declared loopback ports.
"""
from contextlib import contextmanager
from pathlib import Path
import json,socket,subprocess,os
from upgrade_plan import read,sha,require,PlanError


def processes():
    p=subprocess.run(['ps','-ax','-o','pid=','-o','command='],capture_output=True,text=True)
    require(p.returncode==0,'HOST_PROCESS_SCAN_FAILED')
    result=[]
    for line in p.stdout.splitlines():
        fields=line.strip().split(None,1)
        if len(fields)==2 and fields[0].isdigit():result.append((int(fields[0]),fields[1]))
    return result

class StoppedHostLease:
    def __init__(self,record,expected_sha256):
        self.path=Path(record).absolute();self.proof=expected_sha256;self.sockets=[]
        raw=read(self.path);require(sha(raw)==expected_sha256,'HOST_RECORD_CHANGED');self.record=json.loads(raw)
        r=self.record
        require(r.get('schema')==1 and r.get('kind')=='owned-isolated-cli','HOST_RECORD_INVALID')
        self.home=Path(r['home']);self.patch=Path(r['patch'])
        require(self.home.is_absolute() and self.home.resolve()==self.home and self.patch.is_absolute() and self.patch.resolve()==self.patch and self.patch.is_file(),'HOST_RECORD_PATH')
        require(isinstance(r.get('profile'),str) and r['profile'] and isinstance(r.get('pids'),list) and r['pids'] and all(type(p)==int and p>1 for p in r['pids']),'HOST_RECORD_IDENTITY')
        ports=r.get('ports');require(isinstance(ports,list) and ports and len(set(ports))==len(ports) and all(type(p)==int and 1024<=p<=65535 for p in ports),'HOST_RECORD_PORTS')

    def assert_processes_stopped(self):
        require(sha(read(self.path))==self.proof,'HOST_RECORD_CHANGED')
        for pid,cmd in processes():
            # PID reuse is deliberately fail-closed, not a reason to signal it.
            require(pid not in self.record['pids'],'HOST_STILL_RUNNING')
            # Operator CLI legitimately includes --home /... in its own argv.
            # Ignore only ourselves, never ancestors or any recorded Host PID.
            if pid==os.getpid():continue
            require(str(self.patch) not in cmd and str(self.home) not in cmd,'HOST_STILL_RUNNING')

    def assert_stopped(self,home,profile,required_ports=()):
        require(Path(home)==self.home and profile==self.record['profile'],'HOST_GUARD_SCOPE_MISMATCH')
        require(set(p for p in required_ports if p is not None)<=set(self.record['ports']),'HOST_GUARD_PORT_MISSING')
        require(len(self.sockets)==len(self.record['ports']) and all(s.fileno()>=0 for s in self.sockets),'HOST_GUARD_NOT_HELD')
        self.assert_processes_stopped()

    @contextmanager
    def hold(self):
        require(not self.sockets,'HOST_GUARD_ALREADY_HELD');self.assert_processes_stopped()
        try:
            for port in self.record['ports']:
                s=socket.socket(socket.AF_INET,socket.SOCK_STREAM);self.sockets.append(s)
                # No SO_REUSEADDR/PORT: a competing listener must be rejected.
                try:s.bind(('127.0.0.1',port));s.listen(1)
                except OSError:raise PlanError('HOST_PORT_NOT_RELEASED') from None
            self.assert_stopped(self.home,self.record['profile']);yield self
            self.assert_stopped(self.home,self.record['profile'])
        finally:
            for s in self.sockets:s.close()
            self.sockets=[]
