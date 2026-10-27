import {test} from 'node:test';import assert from 'node:assert/strict';
import {writeFileSync,readFileSync,chmodSync,unlinkSync,renameSync,symlinkSync,linkSync} from 'node:fs';
import {fixture} from './approval-fixture.mjs';
import {TaskArtifacts,installArtifactAccess} from '../bundle/task-artifacts.js';
import {TaskJobs} from '../bundle/task-jobs.js';
import {CAPABILITIES,requireCapability} from '../bundle/link-contract.js';
function setup(t){
 const f=fixture(t),jobs=new TaskJobs(f.dir+'/jobs'),g={c:{stateDir:f.dir},store:f.store,scheduler:{jobs},now:()=>Date.now(),closed:false};
 const artifacts=new TaskArtifacts(g);g.artifacts=artifacts;
 const j=jobs.enqueue({task_id:f.task.id,trigger_id:'download-test',goal:f.catalog.head(f.task.id).goal,policy:{provider:'synthetic',model:'not-called'}}),job=jobs.claim(new Set(['plan']),new Set(['plan']));
 const r=artifacts.registerReport({binding:()=>({job})},{},{name:'隔离报告.md',format:'markdown',content:'# 只读报告\n第二行',description:'仅用于隔离下载。'},'download-report');
 const args={task_id:f.task.id,artifact_id:r.id,expected_revision:1,expected_sha256:r.sha256};
 const finish=()=>jobs.finish(job,{outcome:'done',summary:'done'}),download=()=>artifacts.call('artifact_download',args,'local');
 t.after(async()=>{await artifacts.close();jobs.close();});
 return {...f,g,jobs,job,r,args,artifacts,finish,download,path:artifacts.root+'/'+r.id+'.bin'};
}
test('download requires durable completion and binds exact task, revision and hash; no DB mutation',async t=>{
 const f=setup(t);await assert.rejects(f.download(),/STALE_DOWNLOAD/);f.finish();const before=f.store.db.prepare('SELECT * FROM task_artifacts').all(),jobs=f.jobs.list(f.task.id),r=await f.download();
 assert.equal(Buffer.from(r.content,'base64').toString(),'# 只读报告\n第二行');assert.equal(r.mime,'application/octet-stream');assert.equal(r.disposition,'attachment');assert.equal(r.artifact.state,'verified');
 assert.deepEqual(f.jobs.list(f.task.id),jobs);assert.deepEqual(f.store.db.prepare('SELECT * FROM task_artifacts').all(),before);assert(!JSON.stringify(r).includes(f.dir));assert(!JSON.stringify(r).includes(f.job.claim));
 for(const a of [{expected_revision:2},{expected_sha256:'0'.repeat(64)},{task_id:'another'},{path:'/secret'},{url:'http://example.test'},{expected_revision:undefined}])await assert.rejects(f.artifacts.call('artifact_download',{...f.args,...a},'local'));
});
test('local removal, mutation, permission loss, inode replacement and links deny byte delivery',async t=>{
 const f=setup(t);f.finish();const bytes=readFileSync(f.path);writeFileSync(f.path,'wrong');await assert.rejects(f.download(),/CHANGED/);writeFileSync(f.path,bytes);
 for(const mode of [0,0o644]){chmodSync(f.path,mode);await assert.rejects(f.download(),/PERMISSIONS/);}chmodSync(f.path,0o600);
 renameSync(f.path,f.path+'.old');writeFileSync(f.path,bytes,{mode:0o600});await assert.rejects(f.download(),/REPLACED/);unlinkSync(f.path);symlinkSync(f.path+'.old',f.path);await assert.rejects(f.download(),/PERMISSIONS/);unlinkSync(f.path);linkSync(f.path+'.old',f.path);await assert.rejects(f.download(),/PERMISSIONS/);unlinkSync(f.path);await assert.rejects(f.download(),/MISSING/);
});
test('failed/foreign run, new revision and closed service cannot download',async t=>{
 const f=setup(t);f.finish();for(const status of ['failed','interrupted','cancelled']){f.jobs.db.prepare('UPDATE runs SET status=? WHERE id=?').run(status,f.job.run_id);await assert.rejects(f.download(),/STALE/);}
 f.jobs.db.prepare("UPDATE runs SET status='completed',claim='other' WHERE id=?").run(f.job.run_id);await assert.rejects(f.download(),/STALE/);
 f.jobs.db.prepare('UPDATE runs SET claim=? WHERE id=?').run(f.job.claim,f.job.run_id);f.store.db.prepare('UPDATE task_catalog SET spec_revision=2 WHERE task_id=?').run(f.task.id);await assert.rejects(f.download(),/STALE/);
 await f.artifacts.close();assert.throws(f.download,/CLOSED/);
});
test('Gitee record never becomes a download or a remote fetch',async t=>{
 const f=setup(t);f.finish();const row=f.store.db.prepare('SELECT record FROM task_artifacts WHERE id=?').get(f.r.id);const r=JSON.parse(row.record);r.kind='gitee';f.store.db.prepare('UPDATE task_artifacts SET record=? WHERE id=?').run(JSON.stringify(r),r.id);await assert.rejects(f.download(),/PAGE_ONLY/);
});
test('browser download is authenticated Host-origin action with no-store; not a path endpoint',async t=>{
 const f=setup(t);f.finish();let route;f.g.call=(m,a)=>f.artifacts.call(m,a,'local');installArtifactAccess({inject:(_deps,cb)=>cb({connection:{fetch:{register:r=>route=r}}})},f.g);
 const rpc=async(headers,method='download',args=f.args)=>{const r=await route.fetch(new Request('http://dsh.internal/api/task-artifacts/control',{method:'POST',headers,body:JSON.stringify({type:'client-request',rpcId:'download',method:'task-artifacts/control',payload:{method,args}})}));assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('x-content-type-options'),'nosniff');return (await r.json()).result;};
 for(const h of [{},{host:'localhost:8000',origin:'http://evil.test'},{host:'localhost:8000',origin:'null'}]){const r=await rpc(h);assert.equal(r.error.code,'ARTIFACT_BROWSER_ORIGIN_REQUIRED');assert.equal(typeof r.error.message,'string');assert.deepEqual(r.error.details,{});assert(!JSON.stringify(r).includes('content'));}
 assert((await rpc({host:'localhost:8000',origin:'http://localhost:8000'})).ok);
 assert.equal((await rpc({host:'localhost:8000',origin:'http://localhost:8000'},'download',{...f.args,path:'/tmp/x'})).error.code,'ARTIFACT_INVALID_ARGUMENT');
});
test('old peer fails capability negotiation rather than leaking into old access method',()=>{
 const hello={schema:1,protocol:{min:1,max:1},plugin_version:'0.33.0-alpha.7',role:'local',namespace:'isolated',instance_id:'00000000-0000-0000-0000-000000000000',capabilities:CAPABILITIES};
 for(const method of ['artifact_download','task_results'])assert.throws(()=>requireCapability(method,hello,{...hello,role:'cloud',capabilities:{artifacts:2,taskboard:2}}),/CAPABILITY_UNAVAILABLE/);
});

test('zero and maximum sized reports download exactly; malformed persisted file identifiers are refused',async t=>{
 const f=setup(t);
 for(const [n,content] of [['empty',''],['max','x'.repeat(262144)]]){
  const a=f.artifacts.registerReport({binding:()=>({job:f.job})},{},{name:n+'.txt',format:'text',content},n);
  f.jobs.db.prepare("UPDATE runs SET status='completed' WHERE id=?").run(f.job.run_id);
  const d=await f.artifacts.call('artifact_download',{...f.args,artifact_id:a.id,expected_sha256:a.sha256},'local');assert.equal(Buffer.from(d.content,'base64').toString(),content);
  f.jobs.db.prepare("UPDATE runs SET status='running' WHERE id=?").run(f.job.run_id);
 }
 f.finish();const r=JSON.parse(f.store.db.prepare('SELECT record FROM task_artifacts WHERE id=?').get(f.r.id).record);r.id='../outside';f.store.db.prepare('UPDATE task_artifacts SET record=? WHERE id=?').run(JSON.stringify(r),f.r.id);await assert.rejects(f.download(),/NOT_FOUND/);
});
