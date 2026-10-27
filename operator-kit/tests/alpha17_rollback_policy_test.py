import json,sqlite3,sys,tempfile,unittest
from pathlib import Path
from contextlib import closing
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from transaction_state import snapshot,backup,assert_rollback_compatible
from alpha17_rollback_policy import initialization_additions,SOURCE,TARGET
from upgrade_plan import PlanError

class Alpha17InitializationPolicy(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve();self.state=self.root/'state';(self.state/'scheduler').mkdir(parents=True);self.tx=self.root/'transaction';self.tx.mkdir()
  with closing(sqlite3.connect(self.state/'scheduler/jobs.sqlite')) as c,c:c.executescript('CREATE TABLE job_events(seq INTEGER PRIMARY KEY);INSERT INTO job_events VALUES(3);')
  with closing(sqlite3.connect(self.state/'gateway.sqlite')) as c,c:c.execute('CREATE TABLE old_table(id TEXT)')
  b=snapshot(self.state);backup(self.state,self.tx/'state-backup',b)
  self.m={'plan':{'role':'cloud','source_version':'0.16.0-alpha.3','candidate_version':'0.24.0-alpha.17','source_bundle_sha256':SOURCE,'candidate_bundle_sha256':TARGET},'state_baseline':b}
 def initialize(self,cursor=3):
  with closing(sqlite3.connect(self.state/'gateway.sqlite')) as c,c:
   c.execute('CREATE TABLE IF NOT EXISTS notification_meta(singleton INTEGER PRIMARY KEY,cursor INTEGER NOT NULL)');c.execute('INSERT INTO notification_meta VALUES(1,?)',(cursor,))
 def test_exact_initialization_preserved_without_restoring_database(self):
  self.initialize();before=snapshot(self.state);a=initialization_additions(self.tx,self.m);assert_rollback_compatible(self.state,self.m['state_baseline'],a);self.assertEqual(snapshot(self.state),before)
 def test_version_or_bundle_changes_do_not_inherit_exception(self):
  self.initialize()
  for field in ['source_version','candidate_version','source_bundle_sha256','candidate_bundle_sha256']:
   m=json.loads(json.dumps(self.m));m['plan'][field]='different';self.assertEqual(initialization_additions(self.tx,m),{})
   with self.assertRaisesRegex(PlanError,'STATE_NEW_TABLE_DATA'):assert_rollback_compatible(self.state,m['state_baseline'],initialization_additions(self.tx,m))
 def test_current_cursor_is_not_used_as_new_baseline(self):
  self.initialize(4)
  with self.assertRaisesRegex(PlanError,'STATE_NEW_TABLE_DATA'):assert_rollback_compatible(self.state,self.m['state_baseline'],initialization_additions(self.tx,self.m))
 def test_notification_or_other_new_data_still_block(self):
  self.initialize()
  with closing(sqlite3.connect(self.state/'gateway.sqlite')) as c,c:c.executescript("CREATE TABLE task_notifications(id TEXT);INSERT INTO task_notifications VALUES('pending');")
  with self.assertRaisesRegex(PlanError,'STATE_NEW_TABLE_DATA'):assert_rollback_compatible(self.state,self.m['state_baseline'],initialization_additions(self.tx,self.m))
 def test_old_history_changes_still_block(self):
  self.initialize()
  with closing(sqlite3.connect(self.state/'scheduler/jobs.sqlite')) as c,c:c.execute('INSERT INTO job_events VALUES(4)')
  with self.assertRaisesRegex(PlanError,'STATE_HISTORY_CHANGED'):assert_rollback_compatible(self.state,self.m['state_baseline'],initialization_additions(self.tx,self.m))
 def test_backup_changed_rejects_review(self):
  with closing(sqlite3.connect(self.tx/'state-backup/scheduler/jobs.sqlite')) as c,c:c.execute('INSERT INTO job_events VALUES(4)')
  with self.assertRaisesRegex(PlanError,'ROLLBACK_INITIALIZATION_BACKUP_MISMATCH'):initialization_additions(self.tx,self.m)
 def test_initialization_schema_change_is_not_hidden_by_same_rows(self):
  with closing(sqlite3.connect(self.state/'gateway.sqlite')) as c,c:
   c.execute('CREATE TABLE notification_meta(singleton INTEGER PRIMARY KEY,cursor INTEGER NOT NULL,extra TEXT)');c.execute('INSERT INTO notification_meta VALUES(1,3,NULL)')
  with self.assertRaisesRegex(PlanError,'STATE_NEW_TABLE_DATA'):assert_rollback_compatible(self.state,self.m['state_baseline'],initialization_additions(self.tx,self.m))
 def test_dispatch_preserves_old_rule_and_rejects_intermediate_versions(self):
  from install_transaction import rollback_state
  from current_rollback_policy import SOURCE as old_source,TARGET as old_target,RULE as old_rule
  from alpha17_rollback_policy import RULE
  self.initialize();a,rule=rollback_state(self.tx,self.m)
  self.assertEqual(rule,RULE);assert_rollback_compatible(self.state,self.m['state_baseline'],a)
  old=json.loads(json.dumps(self.m));old['plan'].update(candidate_version='0.24.0-alpha.14',candidate_bundle_sha256=old_target,source_bundle_sha256=old_source)
  a,rule=rollback_state(self.tx,old);self.assertEqual(rule,old_rule)
  for version in ['0.24.0-alpha.15','0.24.0-alpha.16','0.24.0-alpha.18']:
   m=json.loads(json.dumps(self.m));m['plan']['candidate_version']=version
   self.assertEqual(rollback_state(self.tx,m),({},None))
 def test_local_or_existing_initialization_cannot_use_exception(self):
  for role in ['local','unknown']:
   m=json.loads(json.dumps(self.m));m['plan']['role']=role
   self.assertEqual(initialization_additions(self.tx,m),{})
  self.initialize();self.m['state_baseline']=snapshot(self.state)
  self.assertEqual(initialization_additions(self.tx,self.m),{})
if __name__=='__main__':unittest.main()
