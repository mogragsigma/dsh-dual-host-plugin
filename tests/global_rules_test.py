import unittest,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from global_rules import render_global
T=(Path(__file__).resolve().parents[1]/'bundle/global-rules/AGENTS.md').read_text()
class Rules(unittest.TestCase):
 def test_replace_legacy_only_preserves_memory_and_later_sections(self):
  before='# Global\n\n## Memory\nKEEP\n\n';after='\n## Unrelated\nALSO KEEP\n';old=before+'## 双端协作（本地鱼 / 云端鱼）\nold runner\n'+after
  new=render_global(old,T,'local');self.assertTrue(new.startswith(before));self.assertTrue(new.endswith(after));self.assertNotIn('old runner',new);self.assertIn('本机身份：本地大肥鱼',new)
 def test_cloud_missing_global_is_created_and_render_is_idempotent(self):
  new=render_global('',T,'cloud');self.assertIn('本机身份：云端大肥鱼',new);self.assertEqual(render_global(new,T,'cloud'),new)
 def test_unknown_role_and_ambiguous_sections_rejected(self):
  with self.assertRaises(AssertionError):render_global('',T,'unknown')
  with self.assertRaises(AssertionError):render_global('## 双端协作（本地鱼 / 云端鱼）\n## 双端协作（全局托管规则）',T,'local')
