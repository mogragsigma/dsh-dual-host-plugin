"""Current runtime packaging and upgrade gates; no Host/model/Git execution."""
import hashlib,json,sys,tarfile,tempfile,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import upgrade_plan_test as fixtures
from upgrade_plan import bundle_manifest,PlanError
from release_bundle import build,unpack

CANDIDATE=Path(__file__).resolve().parents[2]/'bundle'
EXPECTED='b6483b7951d8876bc9c5d9ddc70d78b8544cb39d2584326339ed322a86e3b214'

class CurrentCandidate(unittest.TestCase):
 def test_real_candidate_archive_extract_is_exact_and_complete(self):
  before,pkg,compat=bundle_manifest(CANDIDATE)
  self.assertEqual(pkg['version'],'0.24.0-alpha.21');self.assertEqual(len(before),144)
  self.assertEqual(hashlib.sha256(json.dumps(before,sort_keys=True,separators=(',',':')).encode()).hexdigest(),EXPECTED)
  with tempfile.TemporaryDirectory() as directory:
   root=Path(directory).resolve();one=build(CANDIDATE,root/'one.tar.gz');two=build(CANDIDATE,root/'two.tar.gz')
   self.assertEqual(one['sha256'],two['sha256']);self.assertFalse(one['installed'])
   unpack(one['file'],one['sha256'],root/'unpacked')
   after,p,c=bundle_manifest(root/'unpacked/bundle');self.assertEqual((before,pkg,compat),(after,p,c))
   self.assertEqual((root/'unpacked/bundle/delivery-process.py').read_bytes(),(CANDIDATE/'delivery-process.py').read_bytes())
   with tarfile.open(one['file']) as archive:
    self.assertFalse(any(set(Path(n).parts)&{'private','node_modules','.git','__pycache__'} for n in archive.getnames()))

class CandidateGates(fixtures.Planner):
 def declare(self,name):
  p=self.new/'package.json';d=json.loads(p.read_text());d['files'].append(name);p.write_text(json.dumps(d))
 def test_declared_supervisor_is_required(self):
  self.fixture();self.declare('delivery-process.py');self.error('BUNDLE_SUPERVISOR_MISSING')
 def test_exact_supervisor_only_not_python_wildcard(self):
  self.fixture();self.declare('*.py');self.error('BUNDLE_FILE_DECLARATION')
 def test_supervisor_cannot_be_symlink(self):
  self.fixture();self.declare('delivery-process.py');(self.new/'delivery-process.py').symlink_to(self.old/'native-entry.js');self.error('BUNDLE_SYMLINK')
 def config(self,value):
  p=self.profile/'cordis.patch.yml';p.write_text(p.read_text().replace('development: {enabled: false}', 'development: {enabled: false}\n    delivery: '+value))
 def test_commit_execution_cannot_survive_upgrade_unreviewed(self):
  self.fixture();self.config('{enabled: true, execute: true}');self.error('DELIVERY_EXECUTION_MUST_STAY_CLOSED')
 def test_push_execution_cannot_survive_upgrade_unreviewed(self):
  self.fixture();self.config('{enabled: true, execute: false, push: {enabled: true, execute: true}}');self.error('DELIVERY_EXECUTION_MUST_STAY_CLOSED')
 def test_static_closed_delivery_configuration_preserved(self):
  self.fixture();self.config('{enabled: true, execute: false, push: {enabled: true, execute: false}}')
  before=(self.profile/'cordis.patch.yml').read_bytes();self.run_plan();self.assertEqual(before,(self.profile/'cordis.patch.yml').read_bytes())
 def test_dynamic_delivery_execution_not_evaluated(self):
  self.fixture();self.config('{execute: !!js "process.exit(99)"}');self.error('STATIC_CONFIG_REQUIRED')

for name in list(fixtures.Planner.__dict__):
 if name.startswith('test_'):setattr(CandidateGates,name,None)
if __name__=='__main__':unittest.main()
