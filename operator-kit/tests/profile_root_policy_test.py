import json,sys,unittest,subprocess
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from profile_root_policy import profile_root_contract,VERSION,BOOT_SHA,DESKTOP_SHA
from upgrade_plan import PlanError

class RootContract(unittest.TestCase):
 def observation(self):return {'version':VERSION,'boot':BOOT_SHA,'desktopVersion':VERSION,'desktop':DESKTOP_SHA}
 def test_exact_reviewed_code_and_version_required(self):
  with patch('profile_root_policy.runtime_observation',return_value=self.observation()):
   p=profile_root_contract();self.assertEqual(p['mode'],'host-regenerated-root');self.assertFalse(p['operatorMayRewriteRoot'])
 def test_version_label_or_source_alone_is_insufficient(self):
  for field in ['version','boot']+(['desktopVersion','desktop'] if sys.platform=='darwin' else []):
   o=self.observation();o[field]='unknown'
   with patch('profile_root_policy.runtime_observation',return_value=o),self.assertRaisesRegex(PlanError,'PROFILE_ROOT_CONTRACT_UNVERIFIED'):profile_root_contract()
 def test_read_failure_or_timeout_never_implies_generated(self):
  for error in [FileNotFoundError('private detail'),ValueError('private detail'),subprocess.TimeoutExpired('reader',10)]:
   with patch('profile_root_policy.runtime_observation',side_effect=error),self.assertRaisesRegex(PlanError,'^PROFILE_ROOT_CONTRACT_UNVERIFIED$'):profile_root_contract()
