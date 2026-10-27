import json,os,socket,subprocess,sys,unittest,sqlite3
from contextlib import closing
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import upgrade_plan_test as fixtures
from upgrade_plan import sha
from release_bundle import build,unpack
CLI=Path(__file__).resolve().parents[1]/'scripts/operator_cli.py'

class Operator(fixtures.Planner):
 def call(self,*args,cli=CLI,exit_code=0):
  p=subprocess.run([sys.executable,str(cli),*map(str,args)],capture_output=True,text=True);self.assertEqual(p.returncode,exit_code,p.stdout+p.stderr);self.assertNotIn('not-public',p.stdout);return json.loads(p.stdout)
 def setup_cli(self,role="local"):
  self.fixture(role);self.before={str(p.relative_to(self.home)):p.read_bytes() for p in self.home.rglob('*') if p.is_file()}
  d=self.root/'dependencies/fixture';d.mkdir(parents=True);(d/'package.json').write_text(json.dumps({'name':'fixture','version':'1.0.0'}));self.deps=d.parent
  dead=subprocess.Popen([sys.executable,'-c','pass']);dead.wait()
  with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
  probe=self.root/'own.patch.json';probe.write_text('[]');self.record=self.root/'host.json';self.record.write_text(json.dumps({'schema':1,'kind':'owned-isolated-cli','pids':[dead.pid],'home':str(self.home),'profile':'fixture','patch':str(probe),'ports':[port]}));self.h=['--host-record',self.record,'--host-sha256',sha(self.record.read_bytes())]
 def test_extracted_cli_full_three_artifact_lifecycle(self):
  self.setup_cli();kit=build(self.new,self.root/'kit.tar.gz');dest=self.root/'extracted';self.call('unpack','--archive',kit['file'],'--sha256',kit['sha256'],'--destination',dest)
  cli=dest/'tools/operator_cli.py';p=self.call('plan','--home',self.home,'--profile','fixture','--candidate',dest/'bundle',cli=cli)
  t=self.call('prepare','--home',self.home,'--profile','fixture','--candidate',dest/'bundle','--plan-fingerprint',p['fingerprint'],'--dependencies',self.deps,*self.h,cli=cli);tx=['--transaction',t['transaction'],'--fingerprint',t['fingerprint']]
  self.assertEqual(self.call('status',*tx,cli=cli)['phase'],'prepared');self.assertEqual(self.call('apply',*tx,*self.h,cli=cli)['phase'],'applied')
  self.assertIn(fixtures.NEW,(self.home/'AGENTS.md').read_text());self.assertTrue((self.home/'skills/task-two/SKILL.md').exists())
  self.assertEqual(self.call('rollback',*tx,*self.h,cli=cli)['phase'],'rolled_back')
  for rel,data in self.before.items():self.assertEqual((self.home/rel).read_bytes(),data)
 def test_no_implicit_or_missing_proof_mutation(self):
  self.setup_cli();self.call('check-stopped',*self.h[:-1],'0'*64,exit_code=2)
  p=subprocess.run([sys.executable,str(CLI),'apply'],capture_output=True,text=True);self.assertEqual(p.returncode,2);self.assertFalse((self.home/'task-gateway/transactions').exists())
 def test_extracted_cli_explicit_patch_review_preserves_native_preference(self):
  self.setup_cli();kit=build(self.new,self.root/'review-kit.tar.gz');dest=self.root/'review-kit';unpack(kit['file'],kit['sha256'],dest);cli=dest/'tools/operator_cli.py'
  p=self.call('plan','--home',self.home,'--profile','fixture','--candidate',dest/'bundle',cli=cli)
  t=self.call('prepare','--home',self.home,'--profile','fixture','--candidate',dest/'bundle','--plan-fingerprint',p['fingerprint'],'--dependencies',self.deps,*self.h,cli=cli)
  tx=['--transaction',t['transaction'],'--fingerprint',t['fingerprint']];self.call('apply',*tx,*self.h,cli=cli)
  patch=self.profile/'cordis.patch.yml';addition='\n- id: welcome\n  name: native-welcome\n  config: {welcomeNoticeVersion: "v1"}\n';patch.write_text(patch.read_text()+addition)
  self.assertEqual(self.call('rollback',*tx,*self.h,cli=cli,exit_code=2)['error'],'FILE_CHANGED')
  review=self.call('rollback-review',*tx,*self.h,cli=cli)
  r=self.call('rollback',*tx,*self.h,'--patch-review-fingerprint',review['fingerprint'],cli=cli)
  self.assertTrue(r['unrelatedPatchPreserved']);self.assertFalse(r['stateRestored'])
  self.assertEqual(patch.read_bytes(),self.before['profiles/fixture/cordis.patch.yml']+addition.encode())
 def test_unpack_refuses_existing_destination_or_bad_hash(self):
  self.setup_cli();kit=build(self.new,self.root/'kit.tar.gz');dest=self.root/'existing';dest.mkdir();(dest/'keep').write_text('keep')
  self.assertEqual(self.call('unpack','--archive',kit['file'],'--sha256',kit['sha256'],'--destination',dest,exit_code=2)['error'],'OUTPUT_EXISTS');self.assertEqual((dest/'keep').read_text(),'keep')
  new=self.root/'not-created';self.call('unpack','--archive',kit['file'],'--sha256','0'*64,'--destination',new,exit_code=2);self.assertFalse(new.exists())
 def test_host_record_never_overwrites_existing_operator_evidence(self):
  from operator_cli import new_json
  from upgrade_plan import PlanError
  p=self.root/'keep.json';p.write_text('keep')
  with self.assertRaisesRegex(PlanError,'OUTPUT_EXISTS'):new_json(p,{'new':True})
  self.assertEqual(p.read_text(),'keep')
 def setup_owner(self):
  self.setup_cli('cloud')
  candidate=Path(__file__).resolve().parents[2]/'bundle'
  self.assertTrue(candidate.is_dir());self.new=candidate
  skill=json.loads((candidate/'compatibility.json').read_text())['globalSkills'][0]
  for parent in [self.home,self.old]:
   folder=parent/'skills/task-one';target=parent/'skills'/skill;folder.rename(target);p=target/'SKILL.md';p.write_text(p.read_text().replace('task-one',skill))
  p=self.old/'compatibility.json';d=json.loads(p.read_text());d['globalSkills']=[skill];p.write_text(json.dumps(d))
  with socket.socket() as sock:sock.bind(('127.0.0.1',0));self.scheduler_port=sock.getsockname()[1]
  p=self.profile/'cordis.patch.yml';p.write_text(p.read_text().replace('19020',str(self.scheduler_port)))
  rec=json.loads(self.record.read_text());rec['ports'].append(self.scheduler_port);self.record.write_text(json.dumps(rec));self.h=['--host-record',self.record,'--host-sha256',sha(self.record.read_bytes())]
  self.jobs=self.home/'task-gateway/state/scheduler/jobs.sqlite';self.jobs.parent.mkdir(parents=True)
  with closing(sqlite3.connect(self.jobs)) as c,c:c.executescript("CREATE TABLE jobs(id TEXT,status TEXT,version TEXT);INSERT INTO jobs VALUES('synthetic','needs_review','0.5.0');")
  self.planned=self.call('plan','--home',self.home,'--profile','fixture','--candidate',self.new)
  self.common=['--home',self.home,'--profile','fixture','--candidate',self.new,'--plan-fingerprint',self.planned['fingerprint']]
  self.owner_file=self.root/'owner.json';self.owner=self.call('owner-plan',*self.common,'--output',self.owner_file)
  self.backup=self.home/'task-gateway/migrations/fixture/before.sqlite'
  self.adoption=['owner-adopt',*self.common,'--migration-plan',self.owner_file,'--migration-sha256',self.owner['sha256'],'--backup',self.backup,*self.h]
 def test_actual_owner_cli_preserves_history_backup_and_same_plan_replay(self):
  self.setup_owner();first=self.call(*self.adoption);self.assertTrue(first['migrated']);self.assertFalse(first['replayed']);self.assertFalse(first['recoveryStarted'])
  second=self.call(*self.adoption);self.assertTrue(second['replayed']);self.assertEqual(first['backupSha256'],second['backupSha256'])
  with closing(sqlite3.connect(self.jobs)) as c:
   self.assertEqual(c.execute('SELECT * FROM jobs').fetchall(),[('synthetic','needs_review','0.5.0')]);self.assertEqual(c.execute('SELECT port FROM scheduler_owner').fetchone()[0],self.scheduler_port)
  with closing(sqlite3.connect(self.backup)) as c,c:c.execute("INSERT INTO jobs VALUES('changed','pending','new')")
  self.assertEqual(self.call(*self.adoption,exit_code=2)['error'],'OWNER_BACKUP_MISMATCH')
 def test_owner_original_lock_port_blocks_before_migration(self):
  self.setup_owner()
  with socket.socket() as sock:
   sock.bind(('127.0.0.1',self.scheduler_port));sock.listen(1)
   self.assertEqual(self.call(*self.adoption,exit_code=2)['error'],'EADDRINUSE')
  with closing(sqlite3.connect(self.jobs)) as c:self.assertIsNone(c.execute("SELECT name FROM sqlite_master WHERE name='scheduler_owner'").fetchone())
  self.assertFalse(self.backup.exists())

for name in list(fixtures.Planner.__dict__):
 if name.startswith('test_'):setattr(Operator,name,None)
if __name__=='__main__':unittest.main()
