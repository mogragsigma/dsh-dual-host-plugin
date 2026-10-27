"""Candidate global rules must be wholly inside the owned section, not replace user text."""
import sys,unittest
from pathlib import Path
r=Path(__file__).resolve().parents[1];sys.path.insert(0,str(r/'operator-kit/scripts'))
from upgrade_plan import role_block,merge_global,PlanError
class GlobalRulePackaging(unittest.TestCase):
 def test_both_roles_preserve_unmanaged_rules(self):
  template=(r/'bundle/global-rules/AGENTS.md').read_text()
  for role in ('local','cloud'):
   block=role_block(template,role);self.assertIn('推送后的交付成果',block)
   old='## DSH 双端任务协作（托管规则）\nold\n'
   # Use the real owned heading; the rest of this document is deliberately unrelated.
   old=block.splitlines()[0]+'\nold\n'
   original='# User identity\nKEEP_BEFORE\n\n'+old+'\n## Unmanaged memory\nKEEP_AFTER\n'
   merged=merge_global(original,old,template,role)
   self.assertIn('KEEP_BEFORE',merged);self.assertTrue(merged.endswith('KEEP_AFTER\n'));self.assertIn('推送后的交付成果',merged)
 def test_outside_heading_fails_closed(self):
  template=(r/'bundle/global-rules/AGENTS.md').read_text()
  invalid=template.replace('### 推送后的交付成果','## 推送后的交付成果')
  self.assertNotEqual(template,invalid)
  for role in ('local','cloud'):
   with self.assertRaisesRegex(PlanError,'TEMPLATE_SCOPE'):role_block(invalid,role)
if __name__=='__main__':unittest.main()
