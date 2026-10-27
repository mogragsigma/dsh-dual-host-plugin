import io,json,tarfile,unittest,sys
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from release_bundle import build,verify
from upgrade_plan import sha,PlanError
import upgrade_plan_test as fixtures

class Release(fixtures.Planner):
 # Reuse setup/fixture helpers, not the inherited test run duplication.
 def test_package_deterministic_no_dependencies_or_private(self):
  self.fixture();nm=self.new/'node_modules';nm.mkdir();(nm/'secret').write_text('must not ship')
  a=build(self.new,self.root/'one.tar.gz');b=build(self.new,self.root/'two.tar.gz');self.assertEqual(a['sha256'],b['sha256']);self.assertFalse(a['installed']);self.assertTrue(a['contentVerified'])
  with tarfile.open(a['file']) as t:
   names=t.getnames();self.assertNotIn('bundle/node_modules/secret',names);self.assertIn('tools/upgrade_plan.py',names)
  self.assertEqual(verify(a['file'],a['sha256'])['version'],'0.24.0-alpha.2')
 def test_outside_owned_global_section_rejected_before_archive(self):
  self.fixture();p=self.new/'global-rules/AGENTS.md';p.write_text(p.read_text()+'\n## Escaped rules\nMust not package\n')
  with self.assertRaisesRegex(PlanError,'TEMPLATE_SCOPE'):build(self.new,self.root/'bad-rules.tar.gz')
  self.assertFalse((self.root/'bad-rules.tar.gz').exists())
 def test_owned_subheading_is_valid_for_both_hosts(self):
  self.fixture();p=self.new/'global-rules/AGENTS.md';p.write_text(p.read_text()+'\n### Owned detail\nSafe\n')
  self.assertTrue(build(self.new,self.root/'rules.tar.gz')['contentVerified'])
 def test_existing_output_is_never_replaced(self):
  self.fixture();p=self.root/'keep.tar.gz';p.write_bytes(b'keep')
  with self.assertRaisesRegex(PlanError,'OUTPUT_EXISTS'):build(self.new,p)
  self.assertEqual(p.read_bytes(),b'keep')
 def test_external_hash_required(self):
  self.fixture();a=build(self.new,self.root/'one.tar.gz')
  with self.assertRaisesRegex(PlanError,'ARCHIVE_HASH_MISMATCH'):verify(a['file'],'0'*64)
  with self.assertRaisesRegex(PlanError,'EXPECTED_SHA256_REQUIRED'):verify(a['file'],None)
 def bad_archive(self,entries):
  p=self.root/'bad.tar.gz'
  with tarfile.open(p,'w:gz') as t:
   for name,data,link in entries:
    info=tarfile.TarInfo(name)
    if link:info.type=tarfile.SYMTYPE;info.linkname='/tmp/elsewhere';t.addfile(info)
    else:info.size=len(data);t.addfile(info,io.BytesIO(data))
  return p,sha(p.read_bytes())
 def test_paths_links_duplicates_and_private_rejected(self):
  for entries,code in [([('../outside',b'x',False)],'ENTRY_UNSAFE'),([('x',b'',True)],'ENTRY_UNSAFE'),([('x',b'1',False),('x',b'2',False)],'DUPLICATE'),([('private/secret',b'x',False)],'PRIVATE_ENTRY')]:
   p,s=self.bad_archive(entries)
   with self.assertRaisesRegex(PlanError,code):verify(p,s)
 def test_manifest_omission_cannot_hide_file(self):
  self.fixture();a=build(self.new,self.root/'good.tar.gz')
  with tarfile.open(a['file']) as t:entries=[(m.name,t.extractfile(m).read(),False) for m in t.getmembers()]
  entries.append(('extra',b'unlisted',False));p,s=self.bad_archive(entries)
  with self.assertRaisesRegex(PlanError,'MANIFEST_CONTENT_MISMATCH'):verify(p,s)

# Do not count inherited Planner tests twice; use only helper methods and package-specific cases.
for name in list(fixtures.Planner.__dict__):
 if name.startswith('test_'):setattr(Release,name,None)
if __name__=='__main__':unittest.main()
