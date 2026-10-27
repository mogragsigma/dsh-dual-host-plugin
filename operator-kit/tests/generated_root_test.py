import json,sys,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import upgrade_plan_test as fixtures
from upgrade_plan import materials,PlanError
from profile_root_policy import VERSION,BOOT_SHA

CONTRACT={'schema':1,'hostVersion':VERSION,'startupSourceSha256':BOOT_SHA,'mode':'host-regenerated-root'}

class GeneratedRoot(fixtures.Planner):
 def setup_root(self):
  self.fixture();self.rootfile=self.profile/'cordis.yml'
  self.cache='# generated runtime tree, not a second source\n- name: '+str(self.old/'native-entry.js')+'\n  config: !!js function () { throw Error("DO NOT EXECUTE"); }\n'
  self.rootfile.write_text(self.cache)
  self.addCleanup(patch.stopall);patch('upgrade_plan.profile_root_contract',return_value=CONTRACT).start()
 def test_generated_root_is_observed_but_never_rewritten(self):
  self.setup_root();p,payloads,_=materials(self.home,'fixture',self.new)
  self.assertEqual(p['profile_root']['mode'],'host-regenerated-root')
  self.assertEqual(len(p['changes']),4);self.assertNotIn('profiles/fixture/cordis.yml',payloads)
  self.assertNotIn('profiles/fixture/cordis.yml',p['unchanged_inputs']);self.assertEqual(self.rootfile.read_text(),self.cache)
  self.assertNotIn('DO NOT EXECUTE',json.dumps(p));self.assertIsNone(p['unchanged_inputs']['cordis.patch.yml'])
 def test_unknown_host_root_contract_is_not_ignored(self):
  self.setup_root()
  with patch('upgrade_plan.profile_root_contract',side_effect=PlanError('PROFILE_ROOT_CONTRACT_UNVERIFIED')):self.error('PROFILE_ROOT_CONTRACT_UNVERIFIED')
 def test_profile_patch_remains_the_authoritative_write_gate(self):
  self.setup_root();p=self.profile/'cordis.patch.yml';p.write_text(p.read_text().replace('enabled: false','enabled: true'));self.error('DEVELOPMENT_MUST_STAY_CLOSED')
 def test_home_patch_overrides_require_separate_review(self):
  self.setup_root();(self.home/'cordis.patch.yml').write_text('- update: task-gateway\n  config: {development: {enabled: true}}\n');self.error('HOME_PATCH_REQUIRES_REVIEW')
 def test_empty_home_patch_fingerprinted_not_changed(self):
  self.setup_root();p=self.home/'cordis.patch.yml';p.write_text('# user layer\n[]\n');before=p.read_bytes();v=self.run_plan();self.assertTrue(v['unchanged_inputs']['cordis.patch.yml']);self.assertEqual(p.read_bytes(),before)

for name in list(fixtures.Planner.__dict__):
 if name.startswith('test_'):setattr(GeneratedRoot,name,None)
if __name__=='__main__':unittest.main()
