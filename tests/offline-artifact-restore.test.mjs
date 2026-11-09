import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,rmSync,cpSync,chmodSync,lstatSync,readdirSync,symlinkSync,linkSync,unlinkSync,renameSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Gateway} from '../bundle/index.js';
import {fixture,hash} from './notification-media-fixture.mjs';

const tool=process.env.OFFLINE_RESTORE_TOOL;assert(tool,'Isolated maintenance tool is required');
function invoke(args,ok=true,env=process.env){const p=spawnSync('python3',[tool,...args,'--offline-confirm'],{encoding:'utf8',env});assert.equal(p.status===0,ok,p.stdout+p.stderr);return JSON.parse(ok?p.stdout:p.stderr);}
const backup=f=>invoke(['backup','--state-dir',f.state,'--output',f.root+'/backup']);
const restore=(f,b,out=f.root+'/restored',input=f.root+'/backup',ok=true)=>invoke(['restore','--backup',input,'--manifest-sha256',b.manifest_sha256,'--output',out],ok);
function copy(a,b){cpSync(a,b,{recursive:true});function modes(x,y){chmodSync(y,lstatSync(x).mode&0o777);if(lstatSync(x).isDirectory())for(const n of readdirSync(x))modes(join(x,n),join(y,n));}modes(a,b);}
function tree(root){const out={};function walk(p){for(const n of readdirSync(p)){const f=join(p,n),s=lstatSync(f);if(s.isDirectory())walk(f);else out[f.slice(root.length+1)]={mode:s.mode&0o777,sha:hash(readFileSync(f)),inode:String(s.ino)};}}walk(root);return out;}
function tables(root,normalize=false){
 const code=`import sqlite3,json\nfrom pathlib import Path\nout={}\nfor n in ['gateway.sqlite','coordinator/tasks.sqlite','scheduler/jobs.sqlite']:\n db=sqlite3.connect((Path(${JSON.stringify(root)})/n).as_uri()+'?mode=ro&immutable=1',uri=True);db.row_factory=sqlite3.Row\n out[n]={r['name']:[dict(x) for x in db.execute('SELECT * FROM '+r['name'])] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")}\n db.close()\nprint(json.dumps(out))`;
 const p=spawnSync('python3',['-c',code],{encoding:'utf8'});assert.equal(p.status,0,p.stderr);const out=JSON.parse(p.stdout);
 if(normalize)for(const tables of Object.values(out))for(const row of tables.task_artifacts??[]){const r=JSON.parse(row.record);delete r.file_identity;row.record=JSON.stringify(r);}return out;
}
async function setup(t,{large=false,open=false}={}){
 const f=await fixture(t,{managed:true}),state=f.root+'/cloud',reportTask=await f.create(),report=f.report(reportTask),task=await f.create();await f.bind(task);const cwd=f.root+'/work';mkdirSync(cwd);
 const policy={provider:'fixture',model:'fixture'},p=await f.g.call('execution_prepare',{task_id:task.id,expected_revision:1,role:'cloud',cwd,scope:'离线成果恢复合成验收',model_policy:policy,development:{delivery:'workspace',checks:[],no_checks_reason:'核对合成文件',artifacts:['report.docx'],notification:{target_key:'cloud:media',binding_revision:1}},event_id:'plan'});
 f.g.continuity.decide('cloud',{request_id:p.id,expected_revision:1,proposal_hash:p.proposal_hash,expected_decision_id:null,action:'approve',source:f.source('同意')[0]});await f.g.call('execution_enqueue',{task_id:task.id,approval_id:p.id});
 const claim=f.g.execution.claim('cloud',{development_contract:1,instance_id:'fixture'}).item,own={task_id:task.id,claim:claim.claim,instance_id:claim.instance};f.g.execution.begin('cloud',own);
 f.g.execution.reserve('cloud',{...own,policy,purpose:'native'});f.g.execution.reserve('cloud',{...own,policy,purpose:'native'});
 async function upload(bytes,stage='candidate'){
  let a;for(let offset=0;offset<bytes.length;offset+=49152){const r=await f.g.call('execution_artifact',{...own,path:'report.docx',stage,size:bytes.length,sha256:hash(bytes),offset,content:bytes.subarray(offset,offset+49152).toString('base64')});if(r.complete)a=r.artifact;}return a;
 }
 const bytes=Buffer.alloc(large?2*1024*1024+17:37,42),draft=await upload(Buffer.from('historical draft'),'draft'),artifact=await upload(bytes);
 const deliver=a=>f.g.call('execution_deliver',{...own,artifact_id:a.id,current_sha256:a.sha256});
 const accepted=await deliver(artifact);await f.g.notifications.tick();assert.equal(f.row(accepted.id).state,'accepted');
 const uncertainArtifact=await upload(Buffer.from('uncertain original send'));
 f.hook(u=>{if(u.endsWith('/files'))throw Error('SYNTHETIC_UNKNOWN_SEND');});const uncertain=await deliver(uncertainArtifact);await f.g.notifications.tick();assert.equal(f.row(uncertain.id).state,'needs_review');f.hook(()=>{});
 if(!open){f.g.execution.finish('cloud',{...own,session_id:'managed-restored-session',drained:true,outcome:'waiting',summary:'保存当前成果'});
  await f.g.call('task_followup',{task_ids:[task.id],expected_revisions:{[task.id]:1},source:f.source('保留这条后续要求')[0]});
  await f.g.call('task_lifecycle',{task_id:task.id,action:'pause',expected_version:0,source:f.source('暂停')[0]});await f.g.close();}
 return {...f,state,task,p,own,policy,reportTask,report,draft,artifact,uncertainArtifact,accepted,uncertain,bytes,upload};
}
function reopen(t,f,state){const g=new Gateway(f.ctx,{...f.config,stateDir:state},{...f.g.io,now:f.g.now,scheduler:{allowEphemeralLock:true,now:f.g.now}});t.after(()=>g.close());return g;}

test('sealed offline restore preserves all task facts, authority, used budget and original accepted/unknown receipts',async t=>{
 const f=await setup(t,{large:true}),before=tree(f.state),facts=tables(f.state,true),b=backup(f),sealed=tree(f.root+'/backup'),r=restore(f,b);
 assert.deepEqual(tree(f.state),before);assert.deepEqual(tree(f.root+'/backup'),sealed);assert.deepEqual(tables(r.state_dir,true),facts);
 const receipt=JSON.parse(readFileSync(r.receipt));assert.equal(receipt.artifact_rebindings.length,4);assert.equal(receipt.preserved_all_other_table_values,true);assert.equal(receipt.activation_authorized,false);
 assert(receipt.artifact_rebindings.every(a=>a.old_identity!==a.new_identity));
 const g=reopen(t,f,r.state_dir),posts=f.posts().length;
 assert.deepEqual(g.artifacts.readLocal(g.artifacts.load(f.task.id,f.artifact.id)).bytes,f.bytes);
 assert.equal(g.artifacts.readLocal(g.artifacts.load(f.task.id,f.draft.id)).bytes.toString(),'historical draft');
 assert.equal(g.artifacts.readLocal(g.artifacts.load(f.reportTask.id,f.report.id)).bytes.toString(),'隔离成果正文\n');
 assert.equal(g.execution.budgets.view(f.task.id).used,2);assert.equal(g.continuity.state(f.task.id).state,'paused');assert.equal(g.continuity.read(f.task.id).items.length,1);
 assert.equal(g.approvals.view(f.p.id).state,'approved');assert.equal(g.execution.view(f.task.id).session_id,'managed-restored-session');
 await g.tick();await g.tick();assert.equal(f.posts().length,posts);
 assert.equal(g.notifications.status(f.task.id).deliveries.find(x=>x.id===f.accepted.id).state,'accepted');
 assert.equal(g.notifications.status(f.task.id).deliveries.find(x=>x.id===f.uncertain.id).state,'needs_review');
 assert.equal(g.execution.claim('cloud',{development_contract:1,instance_id:'no-auto-resume'}).item,null);
 assert.throws(()=>g.artifacts.load(f.reportTask.id,f.artifact.id),/NOT_FOUND/);
 await assert.rejects(g.call('execution_artifact',{...f.own,path:'report.docx'}),/TASK_EXECUTION_CLAIM_DENIED/);await g.close();
});
test('an open SQLite handle blocks backup even with idle task records',async t=>{
 const f=await setup(t),db=new DatabaseSync(f.state+'/gateway.sqlite',{readOnly:true});try{const e=invoke(['backup','--state-dir',f.state,'--output',f.root+'/blocked'],false);assert.match(e.error,/STILL_OPEN|OFFLINE/);assert(!existsSync(f.root+'/blocked'));}finally{db.close();}
});
test('source replacement with identical bytes cannot be blessed into a new trusted backup',async t=>{
 const f=await setup(t),p=f.state+'/artifacts/'+f.artifact.id+'.bin',bytes=readFileSync(p);renameSync(p,p+'.saved');writeFileSync(p,bytes,{mode:0o600});rmSync(p+'.saved');
 const e=invoke(['backup','--state-dir',f.state,'--output',f.root+'/bad'],false);assert.equal(e.error,'ARTIFACT_FILE_REPLACED');assert(!existsSync(f.root+'/bad'));
});
test('changed or missing backup bytes, extra files, and weaker permissions fail before creating a target',async t=>{
 const f=await setup(t),b=backup(f);for(const kind of ['changed','missing','extra','mode']){
  const input=f.root+'/'+kind;copy(f.root+'/backup',input);const p=input+'/state/artifacts/'+f.artifact.id+'.bin';
  if(kind==='changed')writeFileSync(p,'corrupt');if(kind==='missing')unlinkSync(p);if(kind==='extra')writeFileSync(input+'/state/unexpected','x');if(kind==='mode')chmodSync(p,0o644);
  const out=f.root+'/out-'+kind,e=restore(f,b,out,input,false);assert.match(e.error,/BACKUP_(CONTENT|LAYOUT)_CHANGED/);assert(!existsSync(out));
 }
});
test('database ownership/budget tampering and manifest edits cannot pass the separately retained digest',async t=>{
 const f=await setup(t),b=backup(f),input=f.root+'/tampered';copy(f.root+'/backup',input);
 const db=new DatabaseSync(input+'/state/coordinator/tasks.sqlite');db.prepare("UPDATE task_artifacts SET task_id='foreign'").run();db.close();
 assert.equal(restore(f,b,f.root+'/out',input,false).error,'BACKUP_CONTENT_CHANGED');
 const p=input+'/manifest.json',m=JSON.parse(readFileSync(p));m.artifact_count=0;writeFileSync(p,JSON.stringify(m));assert.equal(restore(f,b,f.root+'/out',input,false).error,'BACKUP_MANIFEST_CHANGED');
});
test('symbolic and hard links are refused in source and backup trees',async t=>{
 const f=await setup(t),b=backup(f);for(const kind of ['symlink','hardlink']){
  const input=f.root+'/'+kind;copy(f.root+'/backup',input);const p=input+'/state/artifacts/'+f.artifact.id+'.bin';unlinkSync(p);
  if(kind==='symlink')symlinkSync(f.state+'/artifacts/'+f.artifact.id+'.bin',p);else linkSync(f.state+'/artifacts/'+f.artifact.id+'.bin',p);
  const e=restore(f,b,f.root+'/out-'+kind,input,false);assert.match(e.error,/TREE_UNSAFE|FILE_UNSAFE/);unlinkSync(p);
 }
});
test('restore never overwrites an existing or source directory and rejects an untrusted digest',async t=>{
 const f=await setup(t),b=backup(f),before=tree(f.state);
 assert.equal(restore(f,b,f.state,undefined,false).error,'OUTPUT_MUST_BE_NEW');
 assert.equal(restore(f,{manifest_sha256:'0'.repeat(64)},f.root+'/wrong',undefined,false).error,'BACKUP_MANIFEST_CHANGED');
 assert.equal(restore(f,b,f.root+'/backup/inside',undefined,false).error,'OUTPUT_INSIDE_BACKUP');assert.deepEqual(tree(f.state),before);
});
test('unknown execution slots are not silently reset during backup',async t=>{
 const f=await setup(t,{open:true});await f.g.close();assert.equal(invoke(['backup','--state-dir',f.state,'--output',f.root+'/blocked'],false).error,'EXECUTION_OR_DELIVERY_NOT_DRAINED');
});
test('unfinished native upload blocks backup even after the execution slot is drained',async t=>{
 const f=await setup(t,{open:true}),bytes=Buffer.alloc(60000,71);
 await f.g.call('execution_artifact',{...f.own,path:'report.docx',stage:'draft',size:bytes.length,sha256:hash(bytes),offset:0,content:bytes.subarray(0,49152).toString('base64')});
 f.g.execution.finish('cloud',{...f.own,session_id:'managed-upload',drained:true,outcome:'waiting',summary:'合成未完整上传'});await f.g.close();
 assert.equal(invoke(['backup','--state-dir',f.state,'--output',f.root+'/blocked'],false).error,'EXECUTION_OR_DELIVERY_NOT_DRAINED');
});
test('a sealed backup restores when the original state directory is unavailable',async t=>{
 const f=await setup(t),b=backup(f);renameSync(f.state,f.root+'/parked-original');const r=restore(f,b),g=reopen(t,f,r.state_dir);
 assert.deepEqual(g.artifacts.readLocal(g.artifacts.load(f.task.id,f.artifact.id)).bytes,f.bytes);assert.equal(g.execution.budgets.view(f.task.id).used,2);await g.close();
});
test('post-restore byte changes and same-byte inode replacement still fail normal product checks',async t=>{
 const f=await setup(t),b=backup(f),r=restore(f,b),g=reopen(t,f,r.state_dir),p=r.state_dir+'/artifacts/'+f.artifact.id+'.bin',record=g.artifacts.load(f.task.id,f.artifact.id);
 writeFileSync(p,Buffer.alloc(f.bytes.length,43));assert.throws(()=>g.artifacts.readLocal(record),/FILE_CHANGED/);
 writeFileSync(p,f.bytes);assert.deepEqual(g.artifacts.readLocal(record).bytes,f.bytes);renameSync(p,p+'.saved');writeFileSync(p,f.bytes,{mode:0o600});assert.throws(()=>g.artifacts.readLocal(record),/FILE_REPLACED/);await g.close();
});
test('interrupted transaction leaves only an unusable partial output, without resetting any original fact',async t=>{
 const f=await setup(t),b=backup(f),before=tree(f.state),sealed=tree(f.root+'/backup'),out=f.root+'/interrupted';
 const program=`import runpy\nm=runpy.run_path(${JSON.stringify(tool)})\ng=m['restore'].__globals__\noriginal=g['logical']\ncalls=0\ndef fail_second(db):\n global calls\n calls+=1\n if calls==2: raise ValueError('SIMULATED_FAILURE')\n return original(db)\ng['logical']=fail_second\nm['restore'](${JSON.stringify(f.root+'/backup')},${JSON.stringify(b.manifest_sha256)},${JSON.stringify(out)})\n`;
 const p=spawnSync('python3',['-c',program],{encoding:'utf8'});assert.notEqual(p.status,0);assert.match(p.stderr,/SIMULATED_FAILURE/);assert(!existsSync(out+'/restore-receipt.json'));assert(!existsSync(out+'/state'));
 assert.deepEqual(tree(f.state),before);assert.deepEqual(tree(f.root+'/backup'),sealed);assert.deepEqual(tables(out+'/.partial'),tables(f.state));
 assert.equal(restore(f,b,out,undefined,false).error,'OUTPUT_MUST_BE_NEW');assert(restore(f,b,f.root+'/fresh').state_dir);
});
test('revoked task authority remains revoked after restoration, while retained files stay independently readable',async t=>{
 const f=await setup(t);let g=reopen(t,f,f.state);g.continuity.decide('cloud',{request_id:f.p.id,expected_revision:1,proposal_hash:f.p.proposal_hash,expected_decision_id:g.approvals.view(f.p.id).decision_id,action:'revoke',source:f.source('撤销')[0]});await g.close();
 const before=tables(f.state,true),b=backup(f),r=restore(f,b);assert.deepEqual(tables(r.state_dir,true),before);g=reopen(t,f,r.state_dir);
 assert.equal(g.approvals.view(f.p.id).state,'revoked');assert.deepEqual(g.artifacts.readLocal(g.artifacts.load(f.task.id,f.artifact.id)).bytes,f.bytes);assert.equal(g.execution.budgets.view(f.task.id).used,2);await g.close();
});
test('running outside the isolated launcher and supplying a formal path are rejected before reading data',async t=>{
 const f=await setup(t);assert.equal(invoke(['backup','--state-dir',f.state,'--output',f.root+'/out'],false,{...process.env,DSH_HOME:'/not-isolated'}).error,'ISOLATED_LAUNCHER_REQUIRED');
 assert.equal(invoke(['backup','--state-dir','/not-an-isolated-state','--output',f.root+'/out'],false).error,'ISOLATED_PATH_REQUIRED');
});
