import json,os,shutil,subprocess,sys,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]

class Integrity(unittest.TestCase):
 def exercise(self,active=True,broken=False):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);script=root/'stage/scripts/resolved-im-integrity.py';script.parent.mkdir(parents=True)
   shutil.copy2(ROOT/'scripts/resolved-im-integrity.py',script);(root/'stage/private').mkdir()
   modules=root/'.dsh/profiles/desktop/node_modules';modules.mkdir(parents=True)
   if active:
    package=modules/'@xmanrui/dsh-im';package.mkdir(parents=True);(package/'package.json').write_text('{"version":"4.39.0"}')
   if broken:(modules/'dsh-im').symlink_to(root/'missing')
   result=subprocess.run([sys.executable,str(script),'--side','local','--label','fixture'],env={**os.environ,'HOME':str(root)},capture_output=True,text=True)
   if not active or broken:self.assertNotEqual(result.returncode,0);return
   self.assertEqual(result.returncode,0,result.stderr)
   data=json.loads((root/'stage/private/im-integrity-local-fixture.json').read_text())
   self.assertIsNone(data['dsh-im']);self.assertIsNone(data['dsh-im-feishu'])
   self.assertIn('package.json',data['@xmanrui/dsh-im']);self.assertFalse((modules/'dsh-im').exists())
 def test_user_removed_legacy_is_preserved_as_absent(self):self.exercise()
 def test_required_active_im_cannot_silently_disappear(self):self.exercise(active=False)
 def test_broken_installation_is_not_treated_as_intentional_absence(self):self.exercise(broken=True)
