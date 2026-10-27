import unittest,sys,json
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from profile_baseline import compose_profile
class Profile(unittest.TestCase):
 def test_only_own_paths_change(self):
  for role in ['local','cloud']:
   base='/test/.dsh/task-gateway/v0.13.0/bundle'
   paths=['/native-entry.js','/native-tools.js']+(['/worker-tools.js','/skills'] if role=='cloud' else [])
   raw='- name: native-original\n  config: !!js function() { return 1 }\n'+''.join('- name: '+base+p+'\n' for p in paths)
   out=compose_profile(raw,Path('/test/.dsh'),{'role':role,'legacyFeishu':False,'entryMode':'native'})
   self.assertEqual(out,raw.replace('/v0.13.0/','/v0.15.0/'))
 def test_unknown_layout_rejected(self):
  with self.assertRaises(AssertionError):compose_profile('- name: original',Path('/test/.dsh'),{'role':'local','legacyFeishu':False,'entryMode':'native'})
 def test_three_artifacts_refer_to_approval_not_execution(self):
  b=Path(__file__).resolve().parents[1]/'bundle'
  manifest=json.loads((b/'compatibility.json').read_text())
  self.assertIn('task-approval',manifest['globalSkills'])
  for p in ['skills/task-approval/SKILL.md','global-rules/AGENTS.md','native-rules/AGENTS.md']:
   txt=(b/p).read_text();self.assertIn('task_approval_request',txt);self.assertIn('通行密钥',txt)
 def test_binding_only_added_to_own_cloud_node(self):
  h=Path('/test/.dsh');base=str(h/'task-gateway/v0.13.0/bundle')
  raw='- name: third-party\n  config: !!js function() { return 1 }\n- name: '+base+'/native-entry.js\n  config:\n    role: cloud\n    legacyFeishu: false\n'+''.join('- name: '+base+p+'\n' for p in ['/native-tools.js','/worker-tools.js','/skills'])
  binding={'provider':'feishu','appId':'cli_fixture','botOpenId':'ou_fixture','chatId':'oc_fixture','approverOpenId':'ou_owner','appSecretEnv':'FEISHU_APP_SECRET'}
  c={'role':'cloud','legacyFeishu':False,'entryMode':'native','chatApproval':binding}
  out=compose_profile(raw,h,c);self.assertIn('!!js function() { return 1 }',out);self.assertEqual(out.count('chatApproval:'),1)
  self.assertIn('    chatApproval:\n      provider: feishu',out)
 def test_local_cannot_become_confirmation_authority(self):
  base='/test/.dsh/task-gateway/v0.13.0/bundle';raw=''.join('- name: '+base+p+'\n' for p in ['/native-entry.js','/native-tools.js'])
  with self.assertRaises(AssertionError):compose_profile(raw,Path('/test/.dsh'),{'role':'local','legacyFeishu':False,'entryMode':'native','chatApproval':{'provider':'feishu'}})

 def test_existing_chat_binding_preserved_and_repository_added_only_to_own_node(self):
  import yaml
  h=Path('/test/.dsh');base=str(h/'task-gateway/v0.13.0/bundle')
  binding={'provider':'feishu','appId':'cli_fixture','botOpenId':'ou_fixture','chatId':'oc_fixture','approverOpenId':'ou_owner','appSecretEnv':'FEISHU_APP_SECRET'}
  raw='- name: third-party\n  config: !!js function() { return 1 }\n- name: '+base+'/native-entry.js\n  config:\n    role: cloud\n    legacyFeishu: false\n'+''.join('- name: '+base+p+'\n' for p in ['/native-tools.js','/worker-tools.js','/skills'])
  c={'role':'cloud','legacyFeishu':False,'entryMode':'native','chatApproval':binding}
  initial=compose_profile(raw,h,c).replace('/v0.15.0/','/v0.13.0/')
  c['repositoryAccess']={'tokenFile':str(h/'task-gateway/secrets/gitee-readonly.token'),'aliases':[]}
  out=compose_profile(initial,h,c)
  self.assertEqual(out.count('chatApproval:'),1);self.assertEqual(out.count('repositoryAccess:'),1)
  self.assertIn('!!js function() { return 1 }',out)
  c['chatApproval']={**binding,'chatId':'oc_wrong'}
  with self.assertRaises(AssertionError):compose_profile(initial,h,c)
