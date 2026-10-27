import unittest,tempfile,json,hashlib,importlib.util,sys,sqlite3
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
spec=importlib.util.spec_from_file_location('deployment',ROOT/'scripts/deploy-baseline.py');deploy=importlib.util.module_from_spec(spec);spec.loader.exec_module(deploy)
class Deployment(unittest.TestCase):
 def exercise(self,role):
  with tempfile.TemporaryDirectory() as tmp:
   home=Path(tmp);dsh=home/'.dsh';old=dsh/'task-gateway/v0.13.0';old.mkdir(parents=True)
   config={'workbench':{'enabled':True,**({'port':19470,'tunnelPort':19471,'remotePort':19387} if role=='local' else {})},'role':role,'entryMode':'native','legacyFeishu':False,'stateDir':str(dsh/'shared-state'),'repositoryBindings':[]}
   (old/'config.json').write_text(json.dumps(config));profile=dsh/'profiles'/('desktop' if role=='local' else 'web');profile.mkdir(parents=True)
   raw='- name: original-native\n  config: !!js function() { return 1 }\n- id: task-gateway-r2\n  name: '+str(old/'bundle/native-entry.js')+'\n  config:\n    role: '+role+'\n    legacyFeishu: false\n'+''.join('- name: '+str(old/'bundle')+p+'\n' for p in ['/native-tools.js']+(['/worker-tools.js','/skills'] if role=='cloud' else []))
   (profile/'cordis.patch.yml').write_text(raw);(dsh/'AGENTS.md').write_text('# Existing\n\nKeep personality and user memory.\n')
   # DSH 0.2.1 composes an empty root from package bundles; own deployment must not rewrite either.
   root_files={'cordis.yml':'# native bundle-composed root\n[]\n','package.json':json.dumps({'dsh':{'profile':{'bundles':['native-base','third-party-im']}}})}
   for name,text in root_files.items():(profile/name).write_text(text)
   state=dsh/'shared-state';state.mkdir();(state/'keep').write_text('new approvals and histories are not rolled back')
   arc=home/'backup.bin';arc.write_bytes(b'quiescent fixture');backup=home/'summary.json';backup.write_text(json.dumps({'quiescent':True,'side':role,'archive':str(arc),'sha256':hashlib.sha256(arc.read_bytes()).hexdigest()}))
   args=['deployment','deploy','--side',role,'--backup',str(backup)]
   if role=='cloud':
    secret=dsh/'task-gateway/test-secret';secret.write_text('fixture');secret.chmod(0o600)
    config.update(chatApproval={'provider':'feishu','appId':'cli_fixture','botOpenId':'ou_fixture','chatId':'oc_fixture','approverOpenId':'ou_owner','appSecretEnv':'FEISHU_APP_SECRET'},repositoryAccess={'tokenFile':str(secret),'aliases':[]})
   (old/'config.json').write_text(json.dumps(config))
   import yaml
   block=''.join('    '+line+'\n' for line in yaml.safe_dump({k:config[k] for k in ['workbench','chatApproval','repositoryAccess'] if k in config},sort_keys=False).splitlines())
   raw=raw.replace('    role: '+role+'\n',block+'    role: '+role+'\n');(profile/'cordis.patch.yml').write_text(raw)
   with patch.object(Path,'home',return_value=home),patch.object(deploy,'stopped') as stopped,patch.object(sys,'argv',args):deploy.main();stopped.assert_called_once_with(role)
   self.assertIn('/v0.15.0/bundle/',(profile/'cordis.patch.yml').read_text());self.assertEqual((old/'config.json').read_text(),json.dumps(config))
   for name,text in root_files.items():self.assertEqual((profile/name).read_text(),text)
   (state/'coordinator').mkdir()
   with sqlite3.connect(state/'coordinator/tasks.sqlite') as db:
    db.execute('CREATE TABLE approval_requests (id TEXT,repository_revision INTEGER,state TEXT)')
    db.executemany('INSERT INTO approval_requests VALUES (?,?,?)',[('old',0,'pending'),('new',1,'approved')])
   with patch.object(Path,'home',return_value=home),patch.object(deploy,'stopped'),patch.object(sys,'argv',['deployment','rollback','--side',role]):deploy.main()
   with sqlite3.connect(state/'coordinator/tasks.sqlite') as db:self.assertEqual(db.execute('SELECT id,state FROM approval_requests ORDER BY id').fetchall(),[('new','approved'),('old','pending')])
   self.assertEqual((profile/'cordis.patch.yml').read_text(),raw);self.assertEqual((dsh/'AGENTS.md').read_text(),'# Existing\n\nKeep personality and user memory.\n');self.assertEqual((state/'keep').read_text(),'new approvals and histories are not rolled back')
   for name,text in root_files.items():self.assertEqual((profile/name).read_text(),text)
 def test_local_deploy_rollback(self):self.exercise('local')
 def test_cloud_deploy_rollback(self):self.exercise('cloud')
