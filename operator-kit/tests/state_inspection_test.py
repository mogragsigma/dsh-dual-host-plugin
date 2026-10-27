import sqlite3,tempfile,unittest,sys
from contextlib import closing
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from state_inspection import inspect_state,PlanError

class StateInspection(unittest.TestCase):
 def setUp(self):
  self.t=tempfile.TemporaryDirectory();self.addCleanup(self.t.cleanup);self.root=Path(self.t.name).resolve()
 def test_missing_state_does_not_create_database(self):
  r=inspect_state(self.root/'missing');self.assertEqual(r['databases'],[]);self.assertFalse((self.root/'missing').exists());self.assertFalse(r['mayDeploy'])
 def fixture(self):
  (self.root/'scheduler').mkdir();p=self.root/'scheduler/jobs.sqlite'
  with closing(sqlite3.connect(p)) as c, c:
   c.executescript('CREATE TABLE jobs(id TEXT,goal TEXT,status TEXT,version TEXT);')
   c.executemany('INSERT INTO jobs VALUES (?,?,?,?)',[('private-id','SECRET-GOAL','needs_review','0.5.0'),('other','private-text','waiting_capability','0.5.0')])
  return p
 def test_legacy_observation_no_replay_no_secrets_no_write(self):
  p=self.fixture();b=p.read_bytes();r=inspect_state(self.root);self.assertTrue(r['databases'][0]['legacyOwnerMigrationRequired']);self.assertEqual(r['databases'][0]['versions'],[['0.5.0',2]]);self.assertNotIn('SECRET',str(r));self.assertNotIn('private-id',str(r));self.assertEqual(b,p.read_bytes());self.assertFalse(r['hostStoppedVerified'])
 def test_existing_owner_recorded_not_rebound(self):
  p=self.fixture()
  with closing(sqlite3.connect(p)) as c, c:c.executescript("CREATE TABLE scheduler_owner(host TEXT,port INTEGER);INSERT INTO scheduler_owner VALUES('fixture',12345);")
  r=inspect_state(self.root);self.assertFalse(r['databases'][0]['legacyOwnerMigrationRequired']);self.assertEqual(r['databases'][0]['ownerPort'],12345)
 def test_symlink_and_unknown_schema_refuse(self):
  p=self.fixture();p.rename(p.with_name('other.sqlite'));p.symlink_to(p.with_name('other.sqlite'))
  with self.assertRaisesRegex(PlanError,'STATE_SYMLINK'):inspect_state(self.root)
  p.unlink()
  with closing(sqlite3.connect(p)) as c, c:c.execute('CREATE TABLE jobs(id TEXT)')
  with self.assertRaisesRegex(PlanError,'STATE_SCHEMA_UNREVIEWED'):inspect_state(self.root)
 def test_delivery_held_and_unclosed_operations_are_reported_readonly(self):
  p=self.root/'gateway.sqlite'
  with closing(sqlite3.connect(p)) as c,c:
   c.executescript("CREATE TABLE delivery_actions(id TEXT,state TEXT,intent TEXT);CREATE TABLE delivery_operations(id TEXT,state TEXT,detail TEXT);")
   c.execute("INSERT INTO delivery_actions VALUES('private-action','needs_review','SECRET-INTENT')")
   c.execute("INSERT INTO delivery_operations VALUES('private-operation','spawned','SECRET-DETAIL')")
  before=p.read_bytes();r=inspect_state(self.root)
  self.assertEqual(r['databases'][0]['counts'],{'delivery_actions':[['needs_review',1]],'delivery_operations':[['spawned',1]]})
  self.assertEqual(before,p.read_bytes());self.assertNotIn('private-',str(r));self.assertNotIn('SECRET',str(r));self.assertFalse(r['mayDeploy'])
 def test_unknown_delivery_schema_is_not_reported_as_idle(self):
  with closing(sqlite3.connect(self.root/'gateway.sqlite')) as c,c:c.execute('CREATE TABLE delivery_operations(status TEXT)')
  with self.assertRaisesRegex(PlanError,'STATE_SCHEMA_UNREVIEWED'):inspect_state(self.root)

if __name__=='__main__':unittest.main()
