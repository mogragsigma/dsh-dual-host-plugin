import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,realpathSync} from 'node:fs';
import {fixture,hash} from './notification-media-fixture.mjs';
async function setup(t){
 const f=await fixture(t,{managed:true,autonomous:true}),task=await f.create();await f.bind(task);const cwd=realpathSync(f.root)+'/work';mkdirSync(cwd);
 await f.g.call('execution_start',{task_id:task.id,expected_revision:1,cwd,model_policy:{provider:'fixture',model:'fixture'},development:{delivery:'workspace',checks:[],no_checks_reason:'合成文档只验收发送链',artifacts:['report.docx'],notification:{target_key:'cloud:media',binding_revision:1}}});
 const claim=f.g.execution.claim('cloud',{development_contract:1,autonomy_contract:1,instance_id:'fixture'}).item,own={task_id:task.id,claim:claim.claim,instance_id:claim.instance},r=f.g.execution.begin('cloud',own).item;
 const bytes=Buffer.alloc(3*1024*1024,42);let artifact;for(let offset=0;offset<bytes.length;offset+=49152){const v=await f.g.call('execution_artifact',{...own,path:'report.docx',stage:'candidate',size:bytes.length,sha256:hash(bytes),offset,content:bytes.subarray(offset,offset+49152).toString('base64')});if(v.complete)artifact=v.artifact;}
 const completion={input_cursor:0,control_version:0,round:r.runs},deliver=()=>f.g.call('execution_deliver',{...own,artifact_id:artifact.id,current_sha256:artifact.sha256,completion});
 return {...f,task,r,own,completion,artifact,deliver};
}
test('O12/O18 new no-approval task uses original Outbox, 3MiB bytes and duplicate receipt retained',async t=>{
 const f=await setup(t),n=await f.deliver();assert.equal(n.state,'media_queued');assert.equal((await f.deliver()).id,n.id);await f.g.notifications.tick();assert.equal(f.row(n.id).state,'accepted');assert.equal(f.posts().length,3);assert.equal((await f.posts()[0].args.body.get('file').arrayBuffer()).byteLength,3*1024*1024);assert.equal((await f.deliver()).id,n.id);await f.g.notifications.tick();assert.equal(f.posts().length,3);assert.equal(f.g.store.db.prepare('SELECT count(*) n FROM approval_requests').get().n,0);
});
test('O12 new task unknown original upload is not silently sent again',async t=>{
 const f=await setup(t),n=await f.deliver();f.hook(u=>{if(u.endsWith('/files'))throw Error('synthetic lost ACK');});await f.g.notifications.tick();assert.equal(f.row(n.id).state,'needs_review');assert.equal((await f.deliver()).id,n.id);await f.g.notifications.tick();assert.equal(f.posts().length,1);
});
test('O10 new input before external delivery rejects stale completion without an IM permission change',async t=>{
 const f=await setup(t);f.g.continuity.receive('cloud',{task_ids:[f.task.id],expected_revisions:{[f.task.id]:1},source:f.source('补充一条新的要求')[0]});await assert.rejects(f.deliver(),/COMPLETION_STALE/);assert.equal(f.posts().length,0);
});
test('O10 task stop cancels queued upload without changing configured IM grants',async t=>{
 const f=await setup(t),n=await f.deliver();f.g.continuity.control('cloud',{task_id:f.task.id,action:'stop',expected_version:0,source:f.source('停止任务')[0]});await f.g.notifications.tick();assert.equal(f.row(n.id).state,'cancelled');assert.equal(f.posts().length,0);assert.equal(f.g.notifications.status(f.task.id).binding.state,'enabled');
});
