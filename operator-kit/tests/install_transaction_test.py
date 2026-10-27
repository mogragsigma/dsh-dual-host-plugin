import json,os,sqlite3,unittest,sys,subprocess
from pathlib import Path
from contextlib import contextmanager,closing
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import upgrade_plan_test as fixtures
from upgrade_plan import plan,PlanError
from install_transaction import prepare,apply,rollback,locked
from transaction_state import snapshot

class Transaction(fixtures.Planner):
 @contextmanager
 def guard(self):
  self.held=True
  try:yield self
  finally:self.held=False
 def assert_stopped(self,home,profile,required_ports=()):
  self.assertTrue(self.held);self.assertEqual(home,self.home);self.assertEqual(profile,'fixture')
 def setup_install(self,role='local'):
  self.fixture(role);self.state=self.home/'task-gateway/state';self.state.mkdir()
  self.db=self.state/'tasks.sqlite'
  with closing(sqlite3.connect(self.db)) as c,c:c.executescript("CREATE TABLE jobs(id TEXT PRIMARY KEY,status TEXT,version TEXT);INSERT INTO jobs VALUES('old','needs_review','0.5.0');")
  (self.state/'events.jsonl').write_text('{"old":true}\n')
  deps=self.root/'dependency-input/fixture';deps.mkdir(parents=True);(deps/'package.json').write_text(json.dumps({'name':'fixture','version':'1.0.0'}));(deps/'index.js').write_text('// Synthetic dependency fixture, not upstream attestation')
  self.deps=deps.parent;self.originals={str(p.relative_to(self.home)):p.read_bytes() for p in self.home.rglob('*') if p.is_file()};self.baseline=snapshot(self.state)
  self.planned=plan(self.home,'fixture',self.new)
 def prepared(self):
  return prepare(self.home,'fixture',self.new,self.planned['fingerprint'],self.guard,self.deps)
 def run_apply(self,tx,hook=lambda _:None):return apply(tx['transaction'],tx['fingerprint'],self.guard,hook)
 def run_rollback(self,tx,hook=lambda _:None):return rollback(tx['transaction'],tx['fingerprint'],self.guard,hook)
 def assert_originals(self):
  for rel,data in self.originals.items():
   if rel.startswith('task-gateway/state/'):continue
   self.assertEqual((self.home/rel).read_bytes(),data)
 def test_three_artifacts_apply_and_rollback_without_state_loss(self):
  self.setup_install();tx=self.prepared();self.assert_originals();self.assertEqual(snapshot(self.state),self.baseline)
  r=self.run_apply(tx);self.assertEqual(r['phase'],'applied');self.assertFalse(r['hostStarted']);self.assertIn('v0.24.0-alpha.2',(self.profile/'cordis.patch.yml').read_text());self.assertIn('0.24.0-alpha.2',(self.home/'AGENTS.md').read_text());self.assertTrue((self.home/'skills/task-two/SKILL.md').exists())
  self.run_apply(tx);self.assertEqual(snapshot(self.state),self.baseline)
  r=self.run_rollback(tx);self.assertFalse(r['stateRestored']);self.assert_originals();self.assertFalse((self.home/'skills/task-two/SKILL.md').exists());self.assertEqual(snapshot(self.state),self.baseline);self.run_rollback(tx)
  self.assertTrue((self.home/'task-gateway/v0.24.0-alpha.2').is_dir())
 def test_crash_after_rename_recognizes_original_staged_target(self):
  self.setup_install();tx=self.prepared()
  def crash(point):
   self.assertTrue(self.held)
   if point=='target-renamed':raise SystemExit('synthetic crash')
  with self.assertRaises(SystemExit):self.run_apply(tx,crash)
  self.assertFalse(self.held);self.run_apply(tx);self.run_rollback(tx);self.assert_originals()
 def test_crash_after_file_before_receipt_does_not_rewrite_that_file(self):
  self.setup_install();tx=self.prepared()
  def crash(point):
   if point=='file-written:0':raise SystemExit('synthetic lost acknowledgement')
  with self.assertRaises(SystemExit):self.run_apply(tx,crash)
  state=json.loads((Path(tx['transaction'])/'state.json').read_text());self.assertNotIn(0,state['done'])
  calls=[];self.run_apply(tx,calls.append);self.assertNotIn('file-written:0',calls);self.run_rollback(tx);self.assert_originals()
 def test_interrupted_rollback_resumes_without_restoring_databases(self):
  self.setup_install();tx=self.prepared();self.run_apply(tx)
  def crash(point):
   if point.startswith('file-restored:'):raise SystemExit('synthetic crash')
  with self.assertRaises(SystemExit):self.run_rollback(tx,crash)
  self.run_rollback(tx);self.assert_originals();self.assertEqual(snapshot(self.state),self.baseline)
 def test_new_job_blocks_rollback_before_any_file_changes(self):
  self.setup_install();tx=self.prepared();self.run_apply(tx);before=(self.profile/'cordis.patch.yml').read_bytes()
  with closing(sqlite3.connect(self.db)) as c,c:c.execute("INSERT INTO jobs VALUES('new','queued','0.22.0')")
  with self.assertRaisesRegex(PlanError,'STATE_HISTORY_CHANGED'):self.run_rollback(tx)
  self.assertEqual(before,(self.profile/'cordis.patch.yml').read_bytes())
  with closing(sqlite3.connect(self.db)) as c:self.assertEqual(c.execute('SELECT count(*) FROM jobs').fetchone()[0],2)
 def test_empty_additive_tables_and_appended_audit_log_retained(self):
  self.setup_install();tx=self.prepared();self.run_apply(tx)
  with closing(sqlite3.connect(self.db)) as c,c:c.execute('CREATE TABLE new_empty(id TEXT)')
  log=self.state/'events.jsonl';log.write_text(log.read_text()+'{"new":true}\n');self.run_rollback(tx);self.assert_originals();self.assertIn('"new"',log.read_text())
  with closing(sqlite3.connect(self.db)) as c:self.assertIsNotNone(c.execute("SELECT name FROM sqlite_master WHERE name='new_empty'").fetchone())
 def test_nonempty_new_table_or_new_column_data_blocks_rollback(self):
  self.setup_install();tx=self.prepared();self.run_apply(tx)
  with closing(sqlite3.connect(self.db)) as c,c:c.executescript("CREATE TABLE new_queue(id TEXT);INSERT INTO new_queue VALUES('pending');")
  with self.assertRaisesRegex(PlanError,'STATE_NEW_TABLE_DATA'):self.run_rollback(tx)
  with closing(sqlite3.connect(self.db)) as c,c:c.executescript("DELETE FROM new_queue;ALTER TABLE jobs ADD COLUMN optional TEXT;UPDATE jobs SET optional='new-data';")
  with self.assertRaisesRegex(PlanError,'STATE_SCHEMA_CHANGED'):self.run_rollback(tx)
 def test_user_file_drift_refuses_whole_apply_before_any_switch(self):
  self.setup_install();tx=self.prepared();(self.home/'AGENTS.md').write_text('user changed')
  with self.assertRaisesRegex(PlanError,'FILE_CHANGED'):self.run_apply(tx)
  self.assertEqual((self.profile/'cordis.patch.yml').read_bytes(),self.originals['profiles/fixture/cordis.patch.yml']);self.assertFalse((self.home/'task-gateway/v0.24.0-alpha.2').exists())
 def test_user_drift_refuses_rollback_instead_of_overwriting(self):
  self.setup_install();tx=self.prepared();self.run_apply(tx);(self.home/'skills/task-one/SKILL.md').write_text('user changed')
  with self.assertRaisesRegex(PlanError,'FILE_CHANGED'):self.run_rollback(tx)
  self.assertEqual((self.home/'skills/task-one/SKILL.md').read_text(),'user changed')
 def test_old_source_and_root_profile_changes_are_not_ignored(self):
  self.setup_install();tx=self.prepared();p=self.profile/'cordis.yml';p.write_text('[] # user changed\n')
  with self.assertRaisesRegex(PlanError,'UNRELATED_INPUT_CHANGED'):self.run_apply(tx)
  p.write_bytes(self.originals['profiles/fixture/cordis.yml']);(self.old/'native-tools.js').write_text('// changed')
  with self.assertRaisesRegex(PlanError,'SOURCE_BUNDLE_CHANGED'):self.run_apply(tx)
 def test_manifest_or_private_payload_tamper_refused(self):
  self.setup_install();tx=self.prepared();path=Path(tx['transaction']);f=path/'after/0';f.write_text('changed')
  with self.assertRaisesRegex(PlanError,'PAYLOAD_CHANGED'):self.run_apply(tx)
  m=path/'manifest.json';d=json.loads(m.read_text());d['home']=str(self.root/'elsewhere');m.write_text(json.dumps(d))
  with self.assertRaisesRegex(PlanError,'TRANSACTION_PROOF_MISMATCH'):self.run_apply(tx)
 def test_state_backup_tamper_refused(self):
  self.setup_install();tx=self.prepared();(Path(tx['transaction'])/'state-backup/events.jsonl').write_text('changed')
  with self.assertRaisesRegex(PlanError,'STATE_BACKUP_CHANGED'):self.run_apply(tx)
 def test_stale_plan_and_missing_or_wrong_dependencies_refused(self):
  self.setup_install()
  with self.assertRaisesRegex(PlanError,'PLAN_CHANGED'):prepare(self.home,'fixture',self.new,'0'*64,self.guard,self.deps)
  with self.assertRaisesRegex(PlanError,'DEPENDENCIES_REQUIRED'):prepare(self.home,'fixture',self.new,self.planned['fingerprint'],self.guard)
  (self.deps/'fixture/package.json').write_text(json.dumps({'name':'fixture','version':'wrong'}))
  with self.assertRaisesRegex(PlanError,'DEPENDENCY_VERSION_MISMATCH'):self.prepared()
  self.assert_originals()
 def test_changed_staged_dependency_refuses_switch(self):
  self.setup_install();tx=self.prepared();(Path(tx['transaction'])/'version/bundle/node_modules/fixture/index.js').write_text('changed')
  with self.assertRaisesRegex(PlanError,'STAGED_TARGET_CHANGED'):self.run_apply(tx)
 def test_original_lock_is_exclusive_and_running_guard_denies(self):
  self.setup_install()
  with locked(self.home):
   with self.assertRaisesRegex(PlanError,'INSTALL_TRANSACTION_BUSY'):self.prepared()
  @contextmanager
  def running():raise PlanError('HOST_STILL_RUNNING');yield
  with self.assertRaisesRegex(PlanError,'HOST_STILL_RUNNING'):prepare(self.home,'fixture',self.new,self.planned['fingerprint'],running,self.deps)
  self.assert_originals()
 def test_cloud_legacy_owner_is_not_implicitly_migrated(self):
  self.setup_install('cloud');s=self.state/'scheduler';s.mkdir()
  with closing(sqlite3.connect(s/'jobs.sqlite')) as c,c:c.execute('CREATE TABLE jobs(status TEXT,version TEXT)')
  with self.assertRaisesRegex(PlanError,'OWNER_MIGRATION_REQUIRED'):self.prepared()
  with closing(sqlite3.connect(s/'jobs.sqlite')) as c:self.assertIsNone(c.execute("SELECT name FROM sqlite_master WHERE name='scheduler_owner'").fetchone())
 def test_known_written_file_reverted_externally_is_not_replayed(self):
  self.setup_install();tx=self.prepared();self.run_apply(tx);(self.home/'AGENTS.md').write_bytes(self.originals['AGENTS.md'])
  with self.assertRaisesRegex(PlanError,'FILE_CHANGED'):self.run_apply(tx)
 def test_changed_state_rejects_apply_and_not_only_rollback(self):
  self.setup_install();tx=self.prepared()
  with closing(sqlite3.connect(self.db)) as c,c:c.execute("UPDATE jobs SET status='running'")
  with self.assertRaisesRegex(PlanError,'STATE_CHANGED'):self.run_apply(tx)
  self.assert_originals()

 def test_new_trigger_or_index_on_existing_table_blocks_rollback(self):
  self.setup_install();tx=self.prepared();self.run_apply(tx)
  with closing(sqlite3.connect(self.db)) as c,c:c.execute('CREATE UNIQUE INDEX altered_contract ON jobs(status)')
  with self.assertRaisesRegex(PlanError,'STATE_SCHEMA_OBJECT_REVIEW_REQUIRED'):self.run_rollback(tx)
 def test_even_null_column_addition_requires_version_specific_review(self):
  self.setup_install();tx=self.prepared();self.run_apply(tx)
  with closing(sqlite3.connect(self.db)) as c,c:c.execute('ALTER TABLE jobs ADD COLUMN extra TEXT')
  with self.assertRaisesRegex(PlanError,'STATE_SCHEMA_CHANGED'):self.run_rollback(tx)
 def test_actual_process_exit_after_atomic_file_then_same_transaction_resume(self):
  self.setup_install();tx=self.prepared();scripts=str(Path(__file__).resolve().parents[1]/'scripts')
  code="""import sys,os
from contextlib import contextmanager
sys.path.insert(0,sys.argv[1])
from install_transaction import apply
@contextmanager
def fixture_guard():
 class FixtureLease:
  def assert_stopped(self,*args):pass
 yield FixtureLease()
# Only this newly-created temporary fixture; not a formal stopped-Host assertion.
def crash(point):
 if point=='file-written:0':os._exit(77)
apply(sys.argv[2],sys.argv[3],fixture_guard,crash)
"""
  result=subprocess.run([sys.executable,'-c',code,scripts,tx['transaction'],tx['fingerprint']],capture_output=True)
  self.assertEqual(result.returncode,77);record=json.loads((Path(tx['transaction'])/'state.json').read_text());self.assertEqual(record['phase'],'applying');self.assertNotIn(0,record['done'])
  calls=[];self.run_apply(tx,calls.append);self.assertNotIn('file-written:0',calls);self.run_rollback(tx);self.assert_originals();self.assertEqual(snapshot(self.state),self.baseline)

 def test_final_file_hook_cannot_hide_state_change_before_success(self):
  self.setup_install();tx=self.prepared();m=json.loads((Path(tx['transaction'])/'manifest.json').read_text());last=m['rows'][-1]['index']
  def changed(point):
   if point=='file-written:'+str(last):
    with closing(sqlite3.connect(self.db)) as c,c:c.execute("UPDATE jobs SET status='running'")
  with self.assertRaisesRegex(PlanError,'STATE_CHANGED'):self.run_apply(tx,changed)
  self.assertEqual(json.loads((Path(tx['transaction'])/'state.json').read_text())['phase'],'applying')

 def test_missing_lease_evidence_rejects_before_preparation(self):
  self.setup_install()
  @contextmanager
  def empty():yield None
  with self.assertRaisesRegex(PlanError,'HOST_GUARD_REQUIRED'):prepare(self.home,'fixture',self.new,self.planned['fingerprint'],empty,self.deps)
  self.assertFalse((self.home/'task-gateway/transactions').exists());self.assert_originals()
 def test_guard_lost_after_file_write_cannot_report_success(self):
  self.setup_install();tx=self.prepared();original=self.assert_stopped
  def crash(point):
   if point=='file-written:0':
    def lost(*args):raise PlanError('HOST_STILL_RUNNING')
    self.assert_stopped=lost
  with self.assertRaisesRegex(PlanError,'HOST_STILL_RUNNING'):self.run_apply(tx,crash)
  self.assertEqual(json.loads((Path(tx['transaction'])/'state.json').read_text())['phase'],'applying')
  self.assert_stopped=original;self.run_apply(tx);self.run_rollback(tx);self.assert_originals()

for name in list(fixtures.Planner.__dict__):
 if name.startswith('test_'):setattr(Transaction,name,None)
if __name__=='__main__':unittest.main()
