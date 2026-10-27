import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,chmodSync,unlinkSync,symlinkSync,linkSync,renameSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fixture} from './approval-fixture.mjs';
import {TaskArtifacts,artifactName,installArtifactAccess} from '../bundle/task-artifacts.js';
import {RepositoryCatalog} from '../bundle/repository-catalog.js';
import {GiteeReadOnly} from '../bundle/repository-gitee.js';
import {TaskJobs} from '../bundle/task-jobs.js';
import {apply as workerTools} from '../bundle/worker-tools.js';
const hash=b=>createHash('sha256').update(b).digest('hex');
const blob=b=>createHash('sha1').update('blob '+Buffer.byteLength(b)+'\0').update(b).digest('hex');
function setup(t){
 const f=fixture(t),jobs=new TaskJobs(f.dir+'/jobs');let mode='valid',networkHook=null,calls=[];
 const content='隔离成果正文\n',commit='a'.repeat(40),url='https://gitee.com/test/artifacts';
 const provider=new GiteeReadOnly({}, {fetch:async(u,o)=>{calls.push({url:u,options:o});await networkHook?.();if(mode==='forbidden')return new Response('',{status:403});if(mode==='missing')return new Response('',{status:404});if(mode==='offline')throw Error('secret-provider-url');
  if(!u.includes('/contents/'))return Response.json({id:13,full_name:'test/artifacts',private:true});
  const b=mode==='changed'?'different bytes':content;
  return Response.json({type:mode==='symlink'?'symlink':'file',path:mode==='wrong-path'?'secret.txt':'reports/成果.md',size:Buffer.byteLength(b),encoding:'base64',content:Buffer.from(b).toString('base64'),sha:mode==='bad-sha'?'b'.repeat(40):blob(b)});
 }});
 const g={c:{stateDir:f.dir},store:f.store,catalog:f.catalog,scheduler:{jobs},repositories:new RepositoryCatalog(f.store,f.catalog,provider),now:()=>1792300000000,closed:false};
 const registry=new TaskArtifacts(g);g.artifacts=registry;
 const agent={},job=jobs.enqueue({task_id:f.task.id,trigger_id:'artifact-job',goal:f.catalog.head(f.task.id).goal,policy:{provider:'test',model:'test'}}),claim=jobs.claim(new Set(['plan']),new Set(['plan'])),binding={job:claim,report:null};
 const worker={artifacts:registry,binding(a){assert.equal(a,agent);jobs.assertClaim(job.id,claim.claim);return binding;}};
 g.ctx={get:()=>({listSessions:async()=>[{header:{id:claim.session_id},persisted:true,formatStatus:'current'}]})};
 const report=(name='报告.md',content='# 真实隔离报告\n',id='call-1')=>registry.registerReport(worker,agent,{name,format:'markdown',content},id);
 const finish=()=>jobs.finish(claim,{outcome:'done',summary:'done'});
 const bind=()=>{const snapshot={provider:'gitee',repository_id:13,url,branch:'main',base_sha:commit,private:true,workspace:null};g.store.db.prepare("INSERT INTO repository_associations VALUES (?,1,'bound',?,'fingerprint',?,NULL)").run(f.task.id,JSON.stringify(snapshot),g.now());};
 const args={task_id:f.task.id,expected_revision:1,expected_binding_revision:1,path:'reports/成果.md',event_id:'explicit-file',sources:[{role:'local',session_id:'s',message_id:'m',text:'请将 reports/成果.md 登记为已有成果',sha256:hash('请将 reports/成果.md 登记为已有成果')}]};
 const access=(r,action='check')=>registry.call('artifact_access',{task_id:f.task.id,artifact_id:r.id,action},'local');
 t.after(async()=>{await registry.close();jobs.close();});
 return {...f,g,registry,jobs,job,claim,worker,agent,binding,report,finish,bind,args,access,content,calls,mode:v=>mode=v,hook:fn=>networkHook=fn};
}
test('report registration is real bytes, exact task/run, pending until commit; replay survives restart',async t=>{
 const f=setup(t),r=f.report();assert.equal(r.state,'pending_run');assert.equal(f.report().replayed,true);assert.throws(()=>f.report('报告.md','changed'),/EVENT_CONFLICT/);
 assert.equal((await f.access(r,'check')).download,undefined);f.finish();
 const got=await f.access(r,'check');assert.equal(got.artifact.state,'verified');assert.equal(got.download,undefined);assert.equal(got.artifact.sha256,r.sha256);assert.equal(readFileSync(f.registry.root+'/'+r.id+'.bin','utf8'),'# 真实隔离报告\n');
 await f.registry.close();const reopened=new TaskArtifacts(f.g);f.g.artifacts=reopened;
 assert.equal(reopened.list(f.task.id).items[0].id,r.id);assert.equal((await reopened.access({task_id:f.task.id,artifact_id:r.id,action:'check'})).artifact.sha256,r.sha256);await reopened.close();
});
test('foreign task, failed/cancelled/interrupted runs and task revision changes cannot navigate',async t=>{
 const f=setup(t),r=f.report();await assert.rejects(f.registry.access({task_id:'other-task',artifact_id:r.id,action:'check'}),/NOT_FOUND/);
 for(const status of ['failed','cancelled','interrupted']){f.jobs.db.prepare('UPDATE runs SET status=? WHERE id=?').run(status,f.claim.run_id);assert.equal((await f.access(r,'check')).artifact.state,'failed_run');}
 f.jobs.db.prepare("UPDATE runs SET status='completed' WHERE id=?").run(f.claim.run_id);
 f.g.store.db.prepare('UPDATE task_catalog SET spec_revision=2 WHERE task_id=?').run(f.task.id);assert.equal((await f.access(r)).artifact.state,'stale_revision');
});
test('claim/run identity corruption, stale workers and already-final reports fail closed',async t=>{
 const f=setup(t),r=f.report();f.binding.report={};assert.throws(()=>f.report('other.md','x','x'),/ALREADY_FINAL/);f.binding.report=null;
 f.jobs.db.prepare("UPDATE runs SET claim='other',status='completed' WHERE id=?").run(f.claim.run_id);assert.equal((await f.access(r)).artifact.state,'owner_mismatch');
 f.jobs.control({id:f.job.id,event_id:'pause',action:'pause',actor:'test'});assert.throws(()=>f.report(),/STALE_JOB_CLAIM/);
});
test('local file deletion, mutation, replacement and permission revocation never yield navigation',async t=>{
 const f=setup(t),r=f.report();f.finish();const path=f.registry.root+'/'+r.id+'.bin',original=readFileSync(path);
 writeFileSync(path,'x');assert.equal((await f.access(r,'check')).error,'ARTIFACT_FILE_CHANGED');writeFileSync(path,original);
 chmodSync(path,0o644);assert.equal((await f.access(r)).error,'ARTIFACT_FILE_PERMISSIONS');chmodSync(path,0o000);assert.equal((await f.access(r)).error,'ARTIFACT_FILE_PERMISSIONS');chmodSync(path,0o600);
 renameSync(path,path+'.old');writeFileSync(path,original,{mode:0o600});assert.equal((await f.access(r)).error,'ARTIFACT_FILE_REPLACED');unlinkSync(path);
 assert.equal((await f.access(r)).error,'ARTIFACT_FILE_MISSING');
});
test('symlinks, hardlinks and changed root are rejected even when content hashes match',async t=>{
 const f=setup(t),r=f.report();f.finish();const path=f.registry.root+'/'+r.id+'.bin';renameSync(path,path+'.old');symlinkSync(path+'.old',path);
 assert.equal((await f.access(r)).error,'ARTIFACT_FILE_PERMISSIONS');unlinkSync(path);linkSync(path+'.old',path);assert.equal((await f.access(r)).error,'ARTIFACT_FILE_PERMISSIONS');
 unlinkSync(path);renameSync(path+'.old',path);renameSync(f.registry.root,f.registry.root+'.old');symlinkSync(f.registry.root+'.old',f.registry.root);assert.equal((await f.access(r)).error,'ARTIFACT_DIRECTORY_UNSAFE');
});
test('no arbitrary paths, executable report formats, hidden source leakage or unbounded storage',t=>{
 const f=setup(t);for(const name of ['../x.md','a/b.md','CON.md','x\u202e.md','.secret','a\\b.md'])assert.throws(()=>artifactName(name),/INVALID_NAME/);
 assert.throws(()=>f.report('a.md','x'.repeat(262145)),/TOO_LARGE/);assert.throws(()=>f.registry.registerReport(f.worker,f.agent,{name:'a.html',format:'html',content:'x'},'html'),/INVALID_ARGUMENT/);
 for(let i=0;i<8;i++)f.report(i+'.md','x','call'+i);assert.throws(()=>f.report('9.md','x','9'),/LIMIT/);
 const dto=JSON.stringify(f.registry.list(f.task.id));assert.equal(dto.includes(f.dir),false);assert.equal(dto.includes(f.claim.claim),false);assert.equal(dto.includes('sources'),false);
});
test('Gitee existing file fixed commit registration + live reverify + safe canonical URL',async t=>{
 const f=setup(t);f.bind();const r=await f.registry.call('artifact_register_gitee',f.args,'local');assert.equal(r.source,'user_linked_gitee_file');
 assert.equal((await f.registry.call('artifact_register_gitee',f.args,'local')).replayed,true);
 const got=await f.access(r,'check');assert.equal(got.artifact.sha256,hash(f.content));assert.equal(got.download,undefined);
 const view=await f.access(r,'gitee');assert.equal(view.url,'https://gitee.com/test/artifacts/blob/'+'a'.repeat(40)+'/reports/%E6%88%90%E6%9E%9C.md');
 assert.ok(f.calls.every(c=>c.options.method==='GET'&&c.options.redirect==='error'&&c.url.startsWith('https://gitee.com/api/v5/')));assert.ok(f.calls.filter(c=>c.url.includes('/contents/')).every(c=>c.url.endsWith('?ref='+'a'.repeat(40))));
});
test('provider permission loss, deletion/private ambiguity, failure, wrong path/type/hash all refuse access',async t=>{
 const f=setup(t);f.bind();const r=await f.registry.call('artifact_register_gitee',f.args,'local');
 for(const mode of ['forbidden','missing','offline','symlink','wrong-path','bad-sha','changed']){f.mode(mode);const got=await f.access(r,'check');assert.equal(got.download,undefined);assert.equal(got.url,undefined);assert.notEqual(got.artifact.state,'verified');assert.equal(JSON.stringify(got).includes('secret-provider-url'),false);}
 f.mode('valid');assert.equal((await f.access(r,'check')).artifact.state,'verified');
});
test('Gitee user reference, expected task/binding and after-await generations are enforced',async t=>{
 const f=setup(t);f.bind();await assert.rejects(f.registry.call('artifact_register_gitee',{...f.args,sources:[]},'local'),/USER_CONTEXT/);
 await assert.rejects(f.registry.call('artifact_register_gitee',{...f.args,expected_revision:2},'local'),/STALE_REVISION/);
 await assert.rejects(f.registry.call('artifact_register_gitee',{...f.args,expected_binding_revision:2},'local'),/REPOSITORY_CHANGED/);
 f.hook(()=>{f.g.store.db.prepare("UPDATE repository_associations SET revision=2,state='unbound' WHERE task_id=?").run(f.task.id);});
 await assert.rejects(f.registry.call('artifact_register_gitee',f.args,'local'),/SOURCE_CHANGED/);assert.equal(f.registry.list(f.task.id).items.length,0);
});
test('unbind/rebind and concurrent source change at access time invalidate URLs; registration retry is idempotent',async t=>{
 const f=setup(t);f.bind();const [r,x]=await Promise.all([f.registry.call('artifact_register_gitee',f.args,'local'),f.registry.call('artifact_register_gitee',f.args,'local')]);assert.equal(r.id,x.id);assert.equal(f.registry.list(f.task.id).items.length,1);
 f.hook(()=>f.g.store.db.prepare('UPDATE repository_associations SET revision=2 WHERE task_id=?').run(f.task.id));const got=await f.access(r,'gitee');assert.equal(got.artifact.state,'repository_changed');assert.equal(got.url,undefined);
});
test('worker tool mounted only on bounded worker, no general filesystem tool and stale claims guarded',t=>{
 const f=setup(t),tools=new Map();let guard;workerTools({taskGateway:{scheduler:{worker:f.worker}},inject(){},tools:{register:t=>tools.set(t.name,t),guard:fn=>guard=fn}});
 const r=tools.get('worker_artifact').execute({name:'工具报告.md',format:'markdown',content:'真实内容'},{agent:f.agent,callId:'worker-tool'});assert.equal(r.state,'pending_run');assert.equal(guard({name:'shell',agent:f.agent}),'WORKER_CAPABILITY_DENIED');
 assert.throws(()=>tools.get('worker_artifact').execute({name:'报告.md',format:'markdown',content:'x'},{agent:{},callId:'forged'}));
});
test('own UI endpoint exposes only explicit access actions; no registration/mutation route or cached grants',async t=>{
 const f=setup(t);let handler;f.g.call=(m,a)=>f.registry.call(m,a,'cloud');installArtifactAccess({inject(_deps,fn){fn({connection:{fetch:{register:r=>handler=r.fetch}}});}},f.g);
 const rpc=async(method,args)=>{const r=await handler(new Request('http://localhost/api/task-artifacts/control',{method:'POST',body:JSON.stringify({type:'client-request',rpcId:'x',method:'task-artifacts/control',payload:{method,args}})}));assert.equal(r.headers.get('cache-control'),'no-store');return (await r.json()).result;};
 assert.equal((await rpc('register',{path:'/etc/passwd'})).ok,false);assert.equal((await rpc('check',{task_id:f.task.id,artifact_id:'no'})).error.code,'ARTIFACT_NOT_FOUND');
 const r=f.report();f.finish();assert.equal((await rpc('check',{task_id:f.task.id,artifact_id:r.id})).value.artifact.state,'verified');
});
test('Gitee path traversal, URL substitution and overlarge/provider-invalid responses denied',async t=>{
 const f=setup(t);f.bind();for(const path of ['../secret','/etc/passwd','a//x','a/%2e%2e/x','https://x','a\\x'])await assert.rejects(f.g.repositories.provider.file({url:'https://gitee.com/test/artifacts',base_sha:'a'.repeat(40),repository_id:13},path));
});
test('access rechecks task revision after remote I/O; late file can never grant navigation',async t=>{
 const f=setup(t);f.bind();const r=await f.registry.call('artifact_register_gitee',f.args,'local');f.hook(()=>f.g.store.db.prepare('UPDATE task_catalog SET spec_revision=2 WHERE task_id=?').run(f.task.id));const a=await f.access(r,'check');assert.equal(a.artifact.state,'stale_revision');assert.equal(a.download,undefined);
});
test('close drains outstanding access without using closed DB or returning stale data',async t=>{
 const f=setup(t);f.bind();const r=await f.registry.call('artifact_register_gitee',f.args,'local');let release,started;
 const ready=new Promise(r=>started=r);f.hook(()=>{started();return new Promise(r=>release=r);});
 const promise=f.access(r,'check');await ready;const closing=f.registry.close();f.hook(null);release();await assert.rejects(promise,/ARTIFACT_CLOSED/);await closing;
});
test('report count/files survive registry migration without acquiring repo write ownership',async t=>{
 const f=setup(t),before=f.g.store.status(f.task.id);f.report();f.finish();f.registry.list(f.task.id);assert.deepEqual(f.g.store.status(f.task.id),before);assert.equal(f.g.store.db.prepare('SELECT COUNT(*) n FROM intents').get().n,0);
});
test('Gitee provider bounds response bytes; rejects type, canonical identity, size and invalid base64',async()=>{
 const base={url:'https://gitee.com/test/artifacts',repository_id:13,base_sha:'a'.repeat(40)};
 for(const invalid of [{size:1048577},{content:'!!!!'},{size:2},{sha:'z'+blob('x')+'z'},{submodule_git_url:'https://evil.invalid'}, {target:'../../secret'}, {encoding:'raw'}]){
  const provider=new GiteeReadOnly({}, {fetch:async u=>!u.includes('/contents/')?Response.json({id:13,full_name:'test/artifacts'}):Response.json({type:'file',path:'x',size:1,sha:blob('x'),content:'eA==',encoding:'base64',...invalid})});await assert.rejects(provider.file(base,'x'),/ARTIFACT_PROVIDER_FILE_INVALID/);
 }
 const oversized=new GiteeReadOnly({}, {fetch:async()=>new Response('{}',{headers:{'content-length':'2000000'}})});await assert.rejects(oversized.file(base,'x'),/RESPONSE_TOO_LARGE/);
});
test('older peer without artifact capability fails closed without weakening other features',async()=>{
 const {requireCapability,CAPABILITIES}=await import('../bundle/link-contract.js');
 const own={schema:1,protocol:{min:1,max:1},role:'local',namespace:'same',plugin_version:'0.15.0',instance_id:'12345678-1234-1234-1234-123456789abc',capabilities:{...CAPABILITIES}};
 const peer={...own,role:'cloud',plugin_version:'0.14.0',capabilities:{...CAPABILITIES}};delete peer.capabilities.artifacts;
 assert.throws(()=>requireCapability('artifact_access',own,peer),/CAPABILITY_UNAVAILABLE/);assert.doesNotThrow(()=>requireCapability('catalog',own,peer));
});
test('native registration captures real direct context, not model-supplied source; list never returns bytes',async()=>{
 const {registerNativeTools}=await import('../bundle/native-tools.js');const tools=new Map();let captured;
 const user={id:'m1',role:'user',source:{kind:'user'},content:[{type:'text',text:'为报告任务登记 reports/成果.md'}]},agent={id:'native',session:{deriveMessages:()=>[user]}};
 const g={c:{role:'local'},assertNativeAgent:a=>assert.equal(a,agent),call:(method,args)=>{captured={method,args};return {registered:true};}};
 registerNativeTools({taskGateway:g,tools:{register:t=>tools.set(t.name,t)}});
 await tools.get('task_artifact_register').execute({task_id:'t',expected_revision:1,expected_binding_revision:1,path:'reports/成果.md'},{agent,callId:'call'});
 assert.equal(captured.method,'artifact_register_gitee');assert.equal(captured.args.sources.at(-1).text,user.content[0].text);assert.equal(captured.args.sources.at(-1).role,'local');assert(!tools.has('artifact_access')&&!tools.has('worker_artifact'));assert.throws(()=>tools.get('task_artifact_register').execute({}, {agent:{},callId:'x'}));
});
test('provider supplied download/html URLs are ignored, never fetched or returned',async()=>{
 const urls=[];const p=new GiteeReadOnly({}, {fetch:async u=>{urls.push(u);return Response.json(u.includes('/contents/')?{type:'file',path:'x',size:1,sha:blob('x'),content:'eA==',encoding:'base64',download_url:'http://169.254.169.254/secret',html_url:'javascript:alert(1)'}:{id:13,full_name:'test/artifacts'});}});
 const result=await p.file({url:'https://gitee.com/test/artifacts',repository_id:13,base_sha:'a'.repeat(40)},'x');assert(result.url.startsWith('https://gitee.com/test/artifacts/blob/'));assert(urls.every(u=>u.startsWith('https://gitee.com/api/v5/')));
});
test('directory permissions are enforced explicitly even under privileged cloud uid',async t=>{
 const f=setup(t),r=f.report();f.finish();try{chmodSync(f.registry.root,0o500);assert.equal((await f.access(r,'check')).error,'ARTIFACT_DIRECTORY_UNSAFE');}finally{chmodSync(f.registry.root,0o700);}
});

test('introduction is bounded, replay-bound and provenance-labelled; no invented user summary',async t=>{
 const f=setup(t),a={name:'介绍.md',format:'markdown',content:'正文',description:'这是一份只读报告'};
 const report=f.registry.registerReport(f.worker,f.agent,a,'intro');assert.equal(report.description,a.description);assert.equal(report.description_source,'worker');
 assert.throws(()=>f.registry.registerReport(f.worker,f.agent,{...a,description:'另一份'},'intro'),/EVENT_CONFLICT/);
 for(const d of ['', 'x'.repeat(601), 'x\ny', 'x\u202ey'])assert.throws(()=>f.registry.registerReport(f.worker,f.agent,{...a,description:d},'invalid'),/INVALID_DESCRIPTION/);
 f.bind();await assert.rejects(f.registry.registerGitee('local',{...f.args,description:'未提供的内容简介'}),/DESCRIPTION_NOT_IN_USER_CONTEXT/);
 const desc='这是隔离已有文件';const source=f.args.sources[0],text=source.text+'。'+desc;const g=await f.registry.registerGitee('local',{...f.args,description:desc,sources:[{...source,text,sha256:hash(text)}]});assert.equal(g.description,desc);assert.equal(g.description_source,'direct_user');
});
test('legacy access cannot download; new download route requires origin; report session is task-owned',async t=>{
 const f=setup(t),r=f.report();f.finish();
 await assert.rejects(f.access(r,'download'),/INVALID_ARGUMENT/);
 const result=await f.access(r,'session');assert.equal(result.artifact.state,'verified');assert.equal(result.session_id,f.claim.session_id);assert.equal(result.download,undefined);assert.equal(result.url,undefined);
 await assert.rejects(f.registry.access({task_id:f.task.id,artifact_id:r.id,action:'session',session_id:'other'}),/INVALID_ARGUMENT/);
 f.jobs.db.prepare('UPDATE runs SET session_id=NULL WHERE id=?').run(f.claim.run_id);assert.equal((await f.access(r,'session')).error,'ARTIFACT_SESSION_UNAVAILABLE');
 f.bind();const g=await f.registry.registerGitee('local',f.args);assert.equal((await f.access(g,'session')).error,'ARTIFACT_ACTION_UNAVAILABLE');assert.equal((await f.access(r,'gitee')).error,'ARTIFACT_ACTION_UNAVAILABLE');
 let handler;installArtifactAccess({inject(_deps,fn){fn({connection:{fetch:{register:r=>handler=r.fetch}}});}},f.g);
 const reply=await handler(new Request('http://localhost/api/task-artifacts/control',{method:'POST',body:JSON.stringify({type:'client-request',rpcId:'x',method:'task-artifacts/control',payload:{method:'download',args:{}}})}));assert.equal((await reply.json()).result.error.code,'ARTIFACT_BROWSER_ORIGIN_REQUIRED');
});

test('session navigation requires persisted native session availability and fresh task revision',async t=>{
 const f=setup(t),r=f.report();f.finish();
 for(const record of [[],[{header:{id:f.claim.session_id},persisted:false}],[{header:{id:f.claim.session_id},persisted:true,formatStatus:'unsupported'}]]){f.g.ctx={get:()=>({listSessions:async()=>record})};assert.equal((await f.access(r,'session')).error,'ARTIFACT_SESSION_UNAVAILABLE');}
 f.g.ctx={get:()=>({listSessions:async()=>{f.g.store.db.prepare('UPDATE task_catalog SET spec_revision=2 WHERE task_id=?').run(f.task.id);return [{header:{id:f.claim.session_id},persisted:true}];}})};const result=await f.access(r,'session');assert.equal(result.artifact.state,'stale_revision');assert.equal(result.session_id,undefined);
});

test('disabled development runtime cannot make unfinished or orphaned development artifacts valid',async t=>{
 const f=setup(t),a=f.report();f.finish();f.jobs.db.prepare("UPDATE jobs SET kind='development' WHERE id=?").run(f.job.id);
 assert.equal(f.g.development,undefined);assert.equal((await f.access(a)).artifact.state,'owner_mismatch');
 f.g.store.db.exec('CREATE TABLE development_requests(id TEXT PRIMARY KEY,task_id TEXT,state TEXT); CREATE TABLE development_jobs(job_id TEXT PRIMARY KEY,request_id TEXT);');
 f.g.store.db.prepare('INSERT INTO development_requests VALUES (?,?,?)').run('request',f.task.id,'needs_review');f.g.store.db.prepare('INSERT INTO development_jobs VALUES (?,?)').run(f.job.id,'request');
 assert.equal((await f.access(a)).artifact.state,'failed_run');f.g.store.db.prepare("UPDATE development_requests SET state='active'").run();assert.equal((await f.access(a)).artifact.state,'pending_run');
 f.g.store.db.prepare("UPDATE development_requests SET state='completed'").run();assert.equal((await f.access(a)).artifact.state,'verified');
 f.g.store.db.prepare("UPDATE development_requests SET task_id='other'").run();assert.equal((await f.access(a)).artifact.state,'owner_mismatch');
});
