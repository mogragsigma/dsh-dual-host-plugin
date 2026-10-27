import json, tempfile, unittest, sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from upgrade_plan import plan, merge_global, managed_span, bundle_manifest, PlanError, version_key

OLD='0.16.0-alpha.3';NEW='0.24.0-alpha.2'
def package(root,version,skills):
 root.mkdir(parents=True)
 pkg={'name':'@local/dsh-task-gateway','version':version,'dependencies':{'fixture':'1.0.0'},'files':['*.js','package-lock.json','compatibility.json','global-rules','skills']}
 (root/'package.json').write_text(json.dumps(pkg))
 (root/'package-lock.json').write_text(json.dumps({'version':version,'packages':{'':{'dependencies':pkg['dependencies']}}}))
 (root/'compatibility.json').write_text(json.dumps({'version':version,'globalSkills':skills}))
 for n in ['native-entry.js','native-tools.js','worker-tools.js']:(root/n).write_text('// fixture '+version)
 (root/'global-rules').mkdir();(root/'global-rules/AGENTS.md').write_text('## 双端协作（全局托管规则）\n身份：__HOST_NAME__ / __HOST_ROLE__\n'+version+'\n')
 for n in skills:
  s=root/'skills'/n;s.mkdir(parents=True);(s/'SKILL.md').write_text('---\nname: '+n+'\ndescription: Fixture\n---\n'+version)

class Planner(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name).resolve()
 def fixture(self,role='local'):
  home=self.root/'home';old=home/'task-gateway'/('v'+OLD)/'bundle';new=self.root/'candidate';package(old,OLD,['task-one']);package(new,NEW,['task-one','task-two']);self.home=home;self.old=old;self.new=new
  self.profile=home/'profiles'/'fixture';self.profile.mkdir(parents=True)
  (old.parent/'config.json').write_text(json.dumps({'password':'not-public-config-text'}))
  (self.profile/'package.json').write_text(json.dumps({'dsh':{'profile':{'bundles':['native','official-im']}}}))
  (self.profile/'cordis.yml').write_text('# untouched root\n[]\n')
  paths=['native-entry.js','native-tools.js']+(['worker-tools.js','skills'] if role=='cloud' else [])
  raw='# preserve my comments\n- id: unrelated\n  name: native\n  config: !!js function () { throw Error("DO NOT EXECUTE") }\n'
  for n in paths:
   raw+='- name: "'+str(old/n)+'"\n'
   if n=='native-entry.js':raw+='  config:\n    role: '+role+'\n    legacyFeishu: false\n    development: {enabled: false}\n    token: not-public-token\n    stateDir: '+str(home/'task-gateway/state')+'\n'+('    scheduler: {lockPort: 19020}\n' if role=='cloud' else '')
  (self.profile/'cordis.patch.yml').write_text(raw)
  (home/'AGENTS.md').write_text('# User\nPERSONAL MEMORY\n\n'+(old/'global-rules/AGENTS.md').read_text().replace('__HOST_ROLE__',role).replace('__HOST_NAME__','本地大肥鱼' if role=='local' else '云端大肥鱼')+'\n## Other\nKEEP\n')
  sk=home/'skills/task-one';sk.mkdir(parents=True);(sk/'SKILL.md').write_bytes((old/'skills/task-one/SKILL.md').read_bytes())
  return home,new
 def run_plan(self):return plan(self.home,'fixture',self.new)
 def error(self,code):
  with self.assertRaisesRegex(PlanError,code):self.run_plan()
 def test_local_no_writes_no_secrets_stable_plan(self):
  self.fixture();before={str(f):f.read_bytes() for f in self.root.rglob('*') if f.is_file()};p=self.run_plan();self.assertEqual(p,self.run_plan());self.assertFalse(p['may_apply']);self.assertFalse(p['execution']);self.assertEqual(p['source_version'],OLD);self.assertEqual(len(p['changes']),4)
  self.assertNotIn('not-public',json.dumps(p));self.assertEqual(before,{str(f):f.read_bytes() for f in self.root.rglob('*') if f.is_file()});self.assertFalse((self.home/'task-gateway'/('v'+NEW)).exists())
 def test_cloud_known_original_port_required(self):
  self.fixture('cloud');p=self.run_plan();self.assertEqual(p['prior_scheduler_lock_port'],19020);self.assertFalse(p['host_stopped_verified'])
 def test_yaml_js_not_executed_and_memory_preserved(self):
  self.fixture();p=self.run_plan();self.assertEqual(len(p['changes']),4)
  old=(self.old/'global-rules/AGENTS.md').read_text();new=(self.new/'global-rules/AGENTS.md').read_text();source=(self.home/'AGENTS.md').read_text();merged=merge_global(source,old,new,'local');self.assertIn('PERSONAL MEMORY',merged);self.assertTrue(merged.endswith('## Other\nKEEP\n'));self.assertIn(NEW,merged);self.assertNotIn(OLD,merged)
 def test_skill_user_edit_not_overwritten(self):
  self.fixture();(self.home/'skills/task-one/SKILL.md').write_text('personal');self.error('INSTALLED_SKILL_DRIFT')
 def test_new_skill_collision_not_overwritten(self):
  self.fixture();p=self.home/'skills/task-two';p.mkdir();(p/'SKILL.md').write_text('personal');self.error('SKILL_NAME_COLLISION')
 def test_new_skill_dangling_link_rejected(self):
  self.fixture();(self.home/'skills/task-two').symlink_to(self.root/'missing');self.error('SYMLINK_PATH')
 def test_global_drift_not_overwritten(self):
  self.fixture();p=self.home/'AGENTS.md';p.write_text(p.read_text().replace(OLD,'user addition'));self.error('GLOBAL_MANAGED_SECTION_DRIFT')
 def test_heading_in_code_does_not_select_wrong_section(self):
  self.fixture();p=self.home/'AGENTS.md';p.write_text('```md\n## 双端协作（全局托管规则）\nKEEP CODE\n```\n'+p.read_text());self.run_plan()
 def test_duplicate_sections_and_unclosed_code_refuse(self):
  self.fixture();p=self.home/'AGENTS.md';raw=p.read_text();p.write_text(raw+'\n## 双端协作（全局托管规则）\n');self.error('GLOBAL_AMBIGUOUS');p.write_text('```\n'+raw);self.error('GLOBAL_UNCLOSED_FENCE')
 def test_unknown_bundle_reference_refused(self):
  self.fixture();p=self.profile/'cordis.patch.yml';p.write_text(p.read_text()+f'- name: {self.old}/unknown.js\n');self.error('UNREVIEWED_BUNDLE_REFERENCE')
 def test_embedded_javascript_reference_refused(self):
  self.fixture();p=self.profile/'cordis.patch.yml';p.write_text(p.read_text()+f'- custom: !!js import("{self.old}/native-entry.js")\n');self.error('EMBEDDED_BUNDLE_REFERENCE')
 def test_duplicate_entry_and_alias_rejected(self):
  self.fixture();p=self.profile/'cordis.patch.yml';raw=p.read_text();p.write_text(raw+f'- name: {self.old}/native-entry.js\n');self.error('OWN_ENTRY_AMBIGUOUS');p.write_text(raw+'- a: &ref {name: same}\n  b: *ref\n');self.error('YAML_ALIAS')
 def test_duplicate_yaml_key_refused(self):
  self.fixture();p=self.profile/'cordis.patch.yml';p.write_text(p.read_text().replace('legacyFeishu: false','legacyFeishu: false\n    legacyFeishu: true'));self.error('YAML_DUPLICATE_KEY')
 def test_target_exists_or_writer_enabled_refused(self):
  self.fixture();target=self.home/'task-gateway'/('v'+NEW);target.mkdir();self.error('TARGET_EXISTS');target.rmdir();p=self.profile/'cordis.patch.yml';p.write_text(p.read_text().replace('enabled: false','enabled: true'));self.error('DEVELOPMENT_MUST_STAY_CLOSED')
 def test_extra_profile_bundle_cannot_duplicate_entry(self):
  self.fixture();(self.profile/'package.json').write_text(json.dumps({'dsh':{'profile':{'bundles':['@local/dsh-task-gateway']}}}));self.error('OWN_ENTRY_OUTSIDE_PATCH')
 def test_node_modules_not_followed_but_other_link_refused(self):
  self.fixture();(self.new/'node_modules').symlink_to(self.root/'external');self.run_plan();(self.new/'extra').symlink_to(self.old);self.error('BUNDLE_SYMLINK')
 def test_version_lock_drift_refused(self):
  self.fixture();p=self.new/'package-lock.json';d=json.loads(p.read_text());d['version']='0.0.1';p.write_text(json.dumps(d));self.error('LOCK_VERSION_MISMATCH')
 def test_unlisted_root_file_and_hidden_environment_refused(self):
  self.fixture();p=self.new/'private-config.json';p.write_text('must not ship');self.error('BUNDLE_UNDECLARED_FILE');p.unlink();(self.new/'skills/task-one/.env.production').write_text('must not ship');self.error('BUNDLE_UNEXPECTED_FILE')
 def test_removed_skill_or_new_assets_require_review(self):
  self.fixture();p=self.new/'compatibility.json';d=json.loads(p.read_text());d['globalSkills']=['task-two'];p.write_text(json.dumps(d));self.error('SKILL_REMOVAL');d['globalSkills']=['task-one','task-two'];p.write_text(json.dumps(d));(self.new/'skills/task-two/extra.txt').write_text('needs registration');self.error('SKILL_ASSETS_REQUIRE_REVIEW')

 def test_downgrade_cannot_bypass_rollback_through_new_install(self):
  self.fixture()
  for name in ['package.json','compatibility.json','package-lock.json']:
   p=self.new/name;d=json.loads(p.read_text());d['version']='0.15.0';p.write_text(json.dumps(d))
  self.error('DOWNGRADE_REQUIRES_ROLLBACK_REVIEW')
  self.assertGreater(version_key('0.24.0-alpha.10'),version_key('0.24.0-alpha.9'))
  self.assertGreater(version_key('0.24.0'),version_key('0.24.0-rc.2'))
  with self.assertRaisesRegex(PlanError,'VERSION_INVALID'):version_key('0.24.0-alpha.01')

if __name__=='__main__':unittest.main()
