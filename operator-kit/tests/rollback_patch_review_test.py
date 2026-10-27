"""Explicit patch preservation, stale review, drift and interrupted rollback."""
import json,sys,unittest
from unittest.mock import patch as mock_patch
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import install_transaction_test as fixtures
from install_transaction import rollback,rollback_review
from upgrade_plan import PlanError
from transaction_state import snapshot

ADDITION='\n# Native UI preference, not project ownership\n- id: native-welcome\n  name: native-welcome\n  config: {welcomeNoticeVersion: "v1", token: not-public-extra}\n'


class Review(fixtures.Transaction):
 def setup_review(self):
  self.setup_install();self.tx=self.prepared();self.run_apply(self.tx)
  self.patch=self.profile/'cordis.patch.yml';self.patch.write_text(self.patch.read_text()+ADDITION)
  self.with_addition=self.patch.read_bytes()
 def preview(self):return rollback_review(self.tx['transaction'],self.tx['fingerprint'],self.guard)
 def rollback_reviewed(self,proof,hook=lambda _:None):
  return rollback(self.tx['transaction'],self.tx['fingerprint'],self.guard,hook,patch_review_fingerprint=proof)
 def test_preview_is_readonly_and_secret_free(self):
  self.setup_review();before={str(p):p.read_bytes() for p in self.home.rglob('*') if p.is_file()}
  review=self.preview();self.assertEqual(review,self.preview());self.assertNotIn('not-public',json.dumps(review))
  self.assertEqual(review['preservedAppendedEntries'],1);self.assertEqual(review['ownReferencesReverted'],2)
  self.assertEqual(before,{str(p):p.read_bytes() for p in self.home.rglob('*') if p.is_file()})
 def test_default_refuses_but_explicit_rollback_preserves_exact_unrelated_bytes(self):
  self.setup_review()
  with self.assertRaisesRegex(PlanError,'FILE_CHANGED'):self.run_rollback(self.tx)
  review=self.preview();result=self.rollback_reviewed(review['fingerprint'])
  self.assertTrue(result['unrelatedPatchPreserved']);self.assertFalse(result['stateRestored'])
  self.assertEqual(self.patch.read_bytes(),self.originals['profiles/fixture/cordis.patch.yml']+ADDITION.encode())
  self.assertEqual(snapshot(self.state),self.baseline)
  self.assertEqual((self.home/'AGENTS.md').read_bytes(),self.originals['AGENTS.md'])
  self.assertFalse((self.home/'skills/task-two').joinpath('SKILL.md').exists())
  self.rollback_reviewed(review['fingerprint'])
 def test_wrong_or_stale_review_cannot_mutate(self):
  self.setup_review();review=self.preview()
  with self.assertRaisesRegex(PlanError,'PATCH_REVIEW_FINGERPRINT_MISMATCH'):self.rollback_reviewed('0'*64)
  self.assertEqual(self.patch.read_bytes(),self.with_addition)
  self.patch.write_text(self.patch.read_text().replace('"v1"','"v2"'))
  with self.assertRaisesRegex(PlanError,'PATCH_REVIEW_FINGERPRINT_MISMATCH'):self.rollback_reviewed(review['fingerprint'])
 def test_changed_existing_entry_is_not_preserved_as_unrelated(self):
  self.setup_review();self.patch.write_text(self.patch.read_text().replace('enabled: false','enabled: true'))
  with self.assertRaisesRegex(PlanError,'PATCH_REVIEW_EXISTING_ENTRIES_CHANGED'):self.preview()
 def test_alias_duplicate_key_and_dynamic_addition_rejected(self):
  self.setup_review()
  for suffix in ['- config: !!js "process.exit(99)"\n','- id: a\n  id: b\n','- a: &x {keep: true}\n  b: *x\n']:
   with self.subTest(suffix=suffix):
    self.patch.write_bytes(self.with_addition+suffix.encode())
    with self.assertRaises(PlanError):self.preview()
 def test_collision_and_new_own_reference_rejected(self):
  self.setup_review()
  for suffix in ['- id: unrelated\n','- name: "@local/dsh-task-gateway"\n','- config: {remove: unrelated}\n','- name: "'+str(self.old)+'/native-entry.js"\n','- id: native-welcome\n']:
   with self.subTest(suffix=suffix):
    self.patch.write_bytes(self.with_addition+suffix.encode())
    with self.assertRaisesRegex(PlanError,'PATCH_REVIEW_ADDITION_COLLISION'):self.preview()
 def test_other_managed_drift_still_blocks_before_profile_write(self):
  self.setup_review();review=self.preview();(self.home/'skills/task-one/SKILL.md').write_text('user edit')
  with self.assertRaisesRegex(PlanError,'FILE_CHANGED'):self.rollback_reviewed(review['fingerprint'])
  self.assertEqual(self.patch.read_bytes(),self.with_addition)
 def test_interruption_after_patch_write_requires_same_proof_and_resumes(self):
  self.setup_review();review=self.preview()
  def crash(point):
   if point.startswith('file-restored:'):raise SystemExit('synthetic lost receipt')
  with self.assertRaises(SystemExit):self.rollback_reviewed(review['fingerprint'],crash)
  self.assertEqual(self.patch.read_bytes(),self.originals['profiles/fixture/cordis.patch.yml']+ADDITION.encode())
  with self.assertRaisesRegex(PlanError,'PATCH_REVIEW_FINGERPRINT_REQUIRED'):self.run_rollback(self.tx)
  self.rollback_reviewed(review['fingerprint']);self.assertEqual(snapshot(self.state),self.baseline)
 def test_review_record_tamper_and_post_crash_patch_drift_rejected(self):
  self.setup_review();review=self.preview()
  def crash(point):
   if point.startswith('file-restored:'):raise SystemExit()
  with self.assertRaises(SystemExit):self.rollback_reviewed(review['fingerprint'],crash)
  record=Path(self.tx['transaction'])/'rollback-patch-review.json';original=record.read_bytes()
  d=json.loads(original);d['review']['preservedAppendedEntries']=9;record.write_text(json.dumps(d))
  with self.assertRaisesRegex(PlanError,'PATCH_REVIEW_RECORD_CHANGED'):self.rollback_reviewed(review['fingerprint'])
  record.write_bytes(original);self.patch.write_text(self.patch.read_text()+'# external drift\n')
  with self.assertRaisesRegex(PlanError,'PATCH_REVIEW_CURRENT_CHANGED'):self.rollback_reviewed(review['fingerprint'])
 def test_symlink_review_record_not_followed_or_replaced(self):
  self.setup_review();review=self.preview();record=Path(self.tx['transaction'])/'rollback-patch-review.json';missing=self.root/'missing';record.symlink_to(missing)
  with self.assertRaisesRegex(PlanError,'SYMLINK_PATH'):self.rollback_reviewed(review['fingerprint'])
  self.assertTrue(record.is_symlink());self.assertFalse(missing.exists())
 def test_host_wrapped_quoted_paths_reversed_without_touching_native_suffix(self):
  self.setup_review();target=str(self.home/'task-gateway/v0.24.0-alpha.2/bundle')
  text=self.patch.read_text().replace(target,target[:15]+'\\\n    '+target[15:])
  self.patch.write_text(text);review=self.preview();self.rollback_reviewed(review['fingerprint'])
  self.assertEqual(self.patch.read_bytes(),self.originals['profiles/fixture/cordis.patch.yml']+ADDITION.encode())
 def test_oversize_private_journal_refuses_before_any_profile_mutation(self):
  self.setup_review();review=self.preview()
  with mock_patch('install_transaction.MAX_FILE',1):
   with self.assertRaisesRegex(PlanError,'PATCH_REVIEW_RECORD_TOO_LARGE'):self.rollback_reviewed(review['fingerprint'])
  self.assertEqual(self.patch.read_bytes(),self.with_addition)
  self.assertFalse((Path(self.tx['transaction'])/'rollback-patch-review.json').exists())


for base in fixtures.Transaction.__mro__:
 for name in base.__dict__:
  if name.startswith('test_') and name not in Review.__dict__:setattr(Review,name,None)
if __name__=='__main__':unittest.main()
