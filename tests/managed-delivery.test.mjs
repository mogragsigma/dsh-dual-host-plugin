import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,realpathSync} from 'node:fs';
import {fixture,hash} from './notification-media-fixture.mjs';
async function setup(t,{stage='candidate',size=32}={}){
 const f=await fixture(t,{managed:true}),task=await f.create();await f.bind(task);const cwd=realpathSync(f.root)+'/work';mkdirSync(cwd);
 const p=await f.g.call('execution_prepare',{task_id:task.id,expected_revision:1,role:'cloud',cwd,scope:'生成报告并按任务约定发送到媒体验收私聊',model_policy:{provider:'fixture',model:'fixture'},development:{delivery:'workspace',checks:[],no_checks_reason:'核对生成内容',artifacts:['report.docx'],notification:{target_key:'cloud:media',binding_revision:1}},event_id:'plan'});
 f.g.continuity.decide('cloud',{request_id:p.id,expected_revision:1,proposal_hash:p.proposal_hash,expected_decision_id:null,action:'approve',source:f.source('同意')[0]});await f.g.call('execution_enqueue',{task_id:task.id,approval_id:p.id});const r=f.g.execution.claim('cloud',{development_contract:1,instance_id:'fixture'}).item,own={task_id:task.id,claim:r.claim,instance_id:r.instance};f.g.execution.begin('cloud',own);
 const bytes=Buffer.alloc(size,42);let artifact;for(let offset=0;offset<size;offset+=49152){const result=await f.g.call('execution_artifact',{...own,path:'report.docx',stage,size,sha256:hash(bytes),offset,content:bytes.subarray(offset,offset+49152).toString('base64')});if(result.complete)artifact=result.artifact;}
 const deliver=()=>f.g.call('execution_deliver',{...own,artifact_id:artifact.id,current_sha256:artifact.sha256});const revoke=()=>f.g.continuity.decide('cloud',{request_id:p.id,expected_revision:1,proposal_hash:p.proposal_hash,expected_decision_id:f.g.approvals.view(p.id).decision_id,action:'revoke',source:f.source('撤销')[0]});return {...f,task,p,artifact,deliver,revoke};
}
test('task agreement replaces per-filename approval; >2MiB reuses chunked existing media sender',async t=>{
 const f=await setup(t,{size:2*1024*1024+1}),n=await f.deliver();assert.equal(n.state,'media_queued');assert.equal((await f.deliver()).id,n.id);await f.g.notifications.tick();assert.equal(f.row(n.id).state,'accepted');assert.equal(f.posts().length,3);assert.equal((await f.posts()[0].args.body.get('file').arrayBuffer()).byteLength,2*1024*1024+1);assert.equal(f.g.notifications.media.dto(n.id).uploaded_or_sent,true);assert.equal(f.g.store.db.prepare('SELECT count(*) n FROM approval_credentials').get().n,0);
});
test('draft is visible but not automatically externally deliverable',async t=>{const f=await setup(t,{stage:'draft'});await assert.rejects(f.deliver(),/AUTHORIZATION_ENDED/);assert.equal(f.posts().length,0);});
test('task revocation while IM remains configured stops pending delivery',async t=>{const f=await setup(t),n=await f.deliver();f.revoke();await f.g.notifications.tick();assert.equal(f.row(n.id).state,'cancelled');assert.equal(f.posts().length,0);assert.equal(f.g.notifications.status(f.task.id).binding.state,'enabled');});
test('revocation during upload blocks later introduction/send without claiming recall',async t=>{
 const f=await setup(t),n=await f.deliver();f.hook(u=>{if(u.endsWith('/files'))f.revoke();});await f.g.notifications.tick();assert.equal(f.posts().length,1);assert.equal(f.row(n.id).state,'cancelled');
});
test('unknown send and repeated task delivery preserve original id and never duplicate upload',async t=>{
 const f=await setup(t),n=await f.deliver();f.hook(u=>{if(u.endsWith('/files'))throw Error('fixture unknown');});await f.g.notifications.tick();assert.equal(f.row(n.id).state,'needs_review');assert.equal((await f.deliver()).id,n.id);await f.g.notifications.tick();assert.equal(f.posts().length,1);
});
