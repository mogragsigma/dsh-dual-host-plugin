import os,json,socket,subprocess,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from stopped_host import StoppedHostLease
from upgrade_plan import PlanError,sha

class Guard(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve();self.home=self.root/'home';self.home.mkdir();self.patch=self.root/'owned.patch.json';self.patch.write_text('[]')
  p=subprocess.Popen([sys.executable,'-c','pass']);p.wait();self.pid=p.pid
  with socket.socket() as s:s.bind(('127.0.0.1',0));self.port=s.getsockname()[1]
  self.path=self.root/'process.json';self.record={'schema':1,'kind':'owned-isolated-cli','home':str(self.home),'patch':str(self.patch),'profile':'fixture','pids':[self.pid],'ports':[self.port]};self.save()
 def save(self):self.path.write_text(json.dumps(self.record));self.lease=StoppedHostLease(self.path,sha(self.path.read_bytes()))
 def test_dead_owned_process_and_reserved_port(self):
  with self.lease.hold() as lease:
   lease.assert_stopped(self.home,'fixture',[self.port])
   with socket.socket() as s:
    with self.assertRaises(OSError):s.bind(('127.0.0.1',self.port))
  with socket.socket() as s:s.bind(('127.0.0.1',self.port))
 def test_alive_pid_is_not_stopped_or_killed(self):
  self.record['pids']=[os.getpid()];self.save()
  with self.assertRaisesRegex(PlanError,'HOST_STILL_RUNNING'):
   with self.lease.hold():pass
 def test_unknown_pid_but_matching_patch_is_blocked(self):
  p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(10)',str(self.patch)])
  try:
   with self.assertRaisesRegex(PlanError,'HOST_STILL_RUNNING'):
    with self.lease.hold():pass
  finally:p.terminate();p.wait()
 def test_busy_port_refuses_and_releases_partial_lease(self):
  with socket.socket() as s:
   s.bind(('127.0.0.1',self.port));s.listen(1)
   with self.assertRaisesRegex(PlanError,'HOST_PORT_NOT_RELEASED'):
    with self.lease.hold():pass
  self.assertFalse(self.lease.sockets)
 def test_scope_and_missing_port_fail_closed(self):
  with self.lease.hold() as lease:
   with self.assertRaisesRegex(PlanError,'HOST_GUARD_SCOPE_MISMATCH'):lease.assert_stopped(self.root,'fixture')
   with self.assertRaisesRegex(PlanError,'HOST_GUARD_SCOPE_MISMATCH'):lease.assert_stopped(self.home,'other')
   with self.assertRaisesRegex(PlanError,'HOST_GUARD_PORT_MISSING'):lease.assert_stopped(self.home,'fixture',[self.port+1])
 def test_launch_record_drift_inside_lease_is_rejected(self):
  with self.assertRaisesRegex(PlanError,'HOST_RECORD_CHANGED'):
   with self.lease.hold():self.path.write_text('{}')
  self.assertFalse(self.lease.sockets)
 def test_after_release_or_false_proof_rejected(self):
  with self.assertRaisesRegex(PlanError,'HOST_GUARD_NOT_HELD'):self.lease.assert_stopped(self.home,'fixture')
  with self.assertRaisesRegex(PlanError,'HOST_RECORD_CHANGED'):StoppedHostLease(self.path,'0'*64)
 def test_current_operator_argv_does_not_count_as_a_host(self):
  with patch('stopped_host.processes',return_value=[(os.getpid(),'python operator_cli.py prepare --home '+str(self.home))]):
   with self.lease.hold():self.lease.assert_stopped(self.home,'fixture')
if __name__=='__main__':unittest.main()
