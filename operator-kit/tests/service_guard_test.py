import json,socket,tempfile,unittest,sys,subprocess
from pathlib import Path
from unittest.mock import patch
from contextlib import ExitStack
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from service_guard import configuration,capture,ServiceStoppedLease,systemd_state,static_exec_start
from upgrade_plan import sha,PlanError

class ServiceGuard(unittest.TestCase):
 def setUp(self):
  t=tempfile.TemporaryDirectory();self.addCleanup(t.cleanup);self.root=Path(t.name).resolve();self.home=self.root/'.dsh';self.port=self.free();self.web=self.free();self.app=self.root/'Fixture.app';binary=self.app/'Contents/MacOS/DeepSeek Harness';binary.parent.mkdir(parents=True);binary.write_text('synthetic executable identity, never run')
  for profile,role in [('desktop','local'),('web','cloud')]:
   folder=self.home/'profiles'/profile;folder.mkdir(parents=True);(folder/'cordis.patch.yml').write_text(json.dumps([{'name':'/own/native-entry.js','config':{'role':role,'port':self.port}}]))
  self.unit={'config_sha256':'a'*64,'active':'active','sub':'running','main_pid':12345,'control_pid':0,'cgroup':'/system.slice/s44-fixture.service'}
 def free(self):
  with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]
 def save(self,r):
  p=self.root/'record.json';p.write_text(json.dumps(r));return ServiceStoppedLease(p,sha(p.read_bytes()))
 def desktop(self,stack):
  stack.enter_context(patch('service_guard.sys.platform','darwin'));stack.enter_context(patch('service_guard.Path.home',return_value=self.root));ps=stack.enter_context(patch('service_guard.processes',return_value=[(12345,str(self.app)+'/Contents/MacOS/DeepSeek Harness')]))
  r=capture(self.home,'desktop','macos-desktop',self.app);return self.save(r),ps
 def cloud(self,stack):
  cg=self.root/'cgroup';cg.mkdir(exist_ok=True);(cg/'cgroup.controllers').write_text('synthetic');stack.enter_context(patch('service_guard.CGROUP_ROOT',cg))
  stack.enter_context(patch('service_guard.sys.platform','linux'));state=stack.enter_context(patch('service_guard.systemd_state',return_value=self.unit.copy()));stack.enter_context(patch('service_guard.proc_identity',return_value={'home':str(self.home),'profile':'web','web_port':self.web}));ps=stack.enter_context(patch('service_guard.processes',return_value=[]));r=capture(self.home,'web','systemd-service',unit='s44-fixture.service');return self.save(r),state,ps
 def test_desktop_live_rejected_then_stopped_lease_held(self):
  with ExitStack() as st:
   lease,ps=self.desktop(st)
   with self.assertRaisesRegex(PlanError,'HOST_STILL_RUNNING'):
    with lease.hold():pass
   ps.return_value=[]
   with lease.hold():lease.assert_stopped(self.home,'desktop',[self.port])
 def test_desktop_binary_changed_is_not_original_host(self):
  with ExitStack() as st:
   lease,ps=self.desktop(st);ps.return_value=[];(self.app/'Contents/MacOS/DeepSeek Harness').write_text('changed')
   with self.assertRaisesRegex(PlanError,'HOST_APPLICATION_CHANGED'):
    with lease.hold():pass
 def test_cloud_active_failed_or_exiting_not_stopped(self):
  with ExitStack() as st:
   lease,state,_=self.cloud(st)
   for active,sub,pid in [('active','running',12345),('failed','failed',0),('deactivating','stop-sigterm',12345)]:
    state.return_value={**self.unit,'active':active,'sub':sub,'main_pid':pid}
    with self.assertRaisesRegex(PlanError,'HOST_STILL_RUNNING'):
     with lease.hold():pass
 def test_cloud_verified_inactive_and_both_ports_reserved(self):
  with ExitStack() as st:
   lease,state,_=self.cloud(st);state.return_value={**self.unit,'active':'inactive','sub':'dead','main_pid':0,'cgroup':''}
   with lease.hold():
    lease.assert_stopped(self.home,'web',[self.port,self.web])
    with socket.socket() as s:
     with self.assertRaises(OSError):s.bind(('127.0.0.1',self.web))
 def test_service_configuration_change_not_ignored(self):
  with ExitStack() as st:
   lease,state,_=self.cloud(st);state.return_value={**self.unit,'config_sha256':'b'*64,'active':'inactive','sub':'dead','main_pid':0}
   with self.assertRaisesRegex(PlanError,'HOST_SERVICE_CHANGED'):
    with lease.hold():pass
 def test_running_control_pid_or_reused_pid_refused(self):
  with ExitStack() as st:
   lease,state,ps=self.cloud(st);state.return_value={**self.unit,'active':'inactive','sub':'dead','main_pid':0,'control_pid':999}
   with self.assertRaisesRegex(PlanError,'HOST_STILL_RUNNING'):
    with lease.hold():pass
   state.return_value['control_pid']=0;ps.return_value=[(12345,'unrelated reused process')]
   with self.assertRaisesRegex(PlanError,'HOST_STILL_RUNNING'):
    with lease.hold():pass
 def test_current_port_drift_refuses_original_record(self):
  with ExitStack() as st:
   lease,ps=self.desktop(st);ps.return_value=[];p=self.home/'profiles/desktop/cordis.patch.yml';p.write_text(p.read_text().replace(str(self.port),str(self.web)))
   with self.assertRaisesRegex(PlanError,'HOST_GUARD_SCOPE_MISMATCH'):
    with lease.hold():pass
 def test_service_file_hashes_change_without_exposing_environment(self):
  unit=self.root/'u.service';unit.write_text('Unit');env=self.root/'secret.env';env.write_text('SECRET=synthetic-not-real')
  fields={'Id':'test.service','LoadState':'loaded','ActiveState':'active','SubState':'running','MainPID':'12345','ControlPID':'0','ControlGroup':'/system.slice/test.service','ExecStart':self.exec_start(),'Environment':'SECRET=synthetic-not-real','EnvironmentFiles':f'{env} (ignore_errors=no)','User':'root','WorkingDirectory':str(self.root),'FragmentPath':str(unit),'DropInPaths':'','NeedDaemonReload':'no'}
  out='\n'.join(k+'='+v for k,v in fields.items())
  with patch('service_guard.subprocess.run',return_value=subprocess.CompletedProcess([],0,out,'')):
   a=systemd_state('test.service');self.assertNotIn('synthetic-not-real',json.dumps(a));env.write_text('SECRET=changed');b=systemd_state('test.service');self.assertNotEqual(a['config_sha256'],b['config_sha256'])
  # End-to-end fingerprint must survive a normal stop, not just the parser.
  fields.update(ActiveState='inactive',SubState='dead',MainPID='0',ControlGroup='')
  fields['ExecStart']=fields['ExecStart'].replace('stop_time=[n/a]','stop_time=[Tue 2026-10-20 09:16:31 CST]').replace('code=(null)','code=exited').replace('status=0/0','status=0/SUCCESS')
  with patch('service_guard.subprocess.run',return_value=subprocess.CompletedProcess([],0,'\n'.join(k+'='+v for k,v in fields.items()),'')):
   stopped=systemd_state('test.service');self.assertEqual(b['config_sha256'],stopped['config_sha256']);self.assertEqual(stopped['active'],'inactive')
 def exec_start(self):
  return '{ path=/usr/bin/node ; argv[]=/usr/bin/node /own/dsh --profile web ; ignore_errors=no ; start_time=[Tue 2026-10-20 09:14:31 CST] ; stop_time=[n/a] ; pid=12345 ; code=(null) ; status=0/0 }'
 def test_execstart_runtime_suffix_is_not_configuration(self):
  live=self.exec_start();stopped=live.replace('stop_time=[n/a]','stop_time=[Tue 2026-10-20 09:16:31 CST]').replace('code=(null)','code=exited').replace('status=0/0','status=0/SUCCESS')
  self.assertEqual(static_exec_start(live),static_exec_start(stopped))
  self.assertEqual(static_exec_start(live),static_exec_start(stopped.replace('status=0/SUCCESS','status=0')))
  self.assertEqual(static_exec_start(live),static_exec_start(stopped.replace('pid=12345','pid=67890').replace('code=exited','code=killed').replace('status=0/SUCCESS','status=15/TERM')))
 def test_execstart_configuration_fields_remain_pinned(self):
  live=self.exec_start();base=static_exec_start(live)
  for a,b in [('path=/usr/bin/node','path=/usr/local/bin/node'),('argv[]=/usr/bin/node','argv[]=/usr/local/bin/node'),('--profile web','--profile other'),('ignore_errors=no','ignore_errors=yes')]:
   with self.subTest(field=a):self.assertNotEqual(base,static_exec_start(live.replace(a,b)))
 def test_unknown_execstart_layout_fails_closed(self):
  live=self.exec_start()
  for value in ['synthetic command',live+' '+live,live.replace('status=0/0','status=unknown'),live.replace(' ; pid=12345',' ; new_field=x ; pid=12345'),live.replace('ignore_errors=no','ignore_errors=maybe')]:
   with self.subTest(value=value):
    with self.assertRaisesRegex(PlanError,'HOST_EXECSTART_LAYOUT_UNREVIEWED'):static_exec_start(value)
 def test_legacy_systemd_record_requires_live_recapture(self):
  with ExitStack() as st:
   lease,state,_=self.cloud(st);state.return_value={**self.unit,'active':'inactive','sub':'dead','main_pid':0};lease.r.pop('systemd_fingerprint_contract')
   with self.assertRaisesRegex(PlanError,'HOST_SERVICE_RECORD_RECAPTURE_REQUIRED'):
    with lease.hold():pass
 def test_cgroup_residual_process_prevents_stopped_claim(self):
  with ExitStack() as st:
   lease,state,_=self.cloud(st);state.return_value={**self.unit,'active':'inactive','sub':'dead','main_pid':0,'cgroup':''}
   p=self.root/'cgroup/system.slice/s44-fixture.service/cgroup.procs';p.parent.mkdir(parents=True);p.write_text('45678\n')
   with self.assertRaisesRegex(PlanError,'HOST_CGROUP_NOT_EMPTY'):
    with lease.hold():pass
if __name__=='__main__':unittest.main()
