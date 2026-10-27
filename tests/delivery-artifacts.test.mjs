// Real SQLite, journal, verifier and artifact code; only provider/Git proof are
// synthetic. No Git processes, business approvals, IM or model calls.
import test from 'node:test';import assert from 'node:assert/strict';
import {setup as fixture} from './delivery-push-approval-fixture.mjs';
import {TaskArtifacts} from '../bundle/task-artifacts.js';
import {deliveryArtifact,deliveryArtifactList} from '../bundle/delivery-artifacts.js';
import {GiteeReadOnly} from '../bundle/repository-gitee.js';
import {artifactSnapshot} from '../bundle/artifact-media.js';
import {DatabaseSync} from 'node:sqlite';
import {NotificationMediaEndpoint} from '../bundle/notification-media-endpoint.js';
import {digest as notificationDigest} from '../bundle/notification-contract.js';
async function setup(t,{complete=true,mixedFiles=false}={}){
 const f=await fixture(t,{mixedFiles}),p=await f.prompt();await f.decide(p.prompt);
 const q=f.j.enqueue({...f.input,event_id:'artifact-push',approval_id:p.r.id}),a=f.j.acquire(q.id);f.j.markDispatched(q.id,a.epoch);
 f.j.observe=i=>({kind:'push-readback-v1',intent_fingerprint:i.fingerprint,drained:true,repository_id:i.plan.repository_id,url:i.plan.url,ref:i.plan.ref,ref_oid:i.plan.commit_oid,workspace_identity:i.workspace_identity,observed_at:f.ledger.now()});
 if(complete)f.j.finish(q.id,a.epoch);
 let mode='valid',hook=null,calls=[];
 const plan=f.input.plan;
 const provider=new GiteeReadOnly({},{fetch:async(url,options)=>{calls.push({url,options});await hook?.();
  if(mode==='denied')return new Response('',{status:403});if(mode==='missing')return new Response('',{status:404});if(mode==='offline')throw Error('secret-no-leak');
  return Response.json(url.includes('/commits/')?{sha:mode==='oid'?'2'.repeat(40):plan.commit_oid,commit:{tree:{sha:mode==='tree'?'2'.repeat(40):plan.tree_oid}},parents:[{sha:mode==='parent'?'2'.repeat(40):plan.parent_oid}],html_url:'javascript:ignored'}:{id:mode==='identity'?999:101,full_name:'test-fixture/example',private:true});
 }});
 const g={store:f.store,catalog:f.catalog,c:{stateDir:f.dir},now:f.ledger.now,closed:false,repositories:{provider,matches:()=>f.control.repository}};
 const registry=new TaskArtifacts(g);g.artifacts=registry;t.after(()=>registry.close());
 const id='artifact-'+q.id,access=(action='gitee')=>registry.call('artifact_access',{task_id:f.task.id,artifact_id:id,action},'cloud');
 return {...f,g,registry,q,p,id,access,calls,mode:v=>mode=v,hook:v=>hook=v};
}
test('completed push becomes one durable-derived artifact without registry inserts or binding changes',async t=>{
 const f=await setup(t),db=f.store.db,before=db.prepare('SELECT total_changes() n').get().n;
 const a=f.registry.list(f.task.id),b=f.registry.list(f.task.id);assert.deepEqual(a,b);assert.equal(a.items.length,1);const item=a.items[0];
 assert.equal(item.kind,'gitee_delivery');assert.equal(item.source,'verified_delivery_journal');assert.equal(item.description_source,'delivery_ledger');assert.equal(item.verified_at_registration,null);
 assert.equal(item.repository.commit,f.input.plan.commit_oid);assert.equal(item.repository.branch,'dsh-task/approval');assert(item.description.includes('新增 1'));
 assert.equal(f.calls.length,0);assert.equal(db.prepare('SELECT total_changes() n').get().n,before);assert.equal(db.prepare('SELECT count(*) n FROM task_artifacts').get().n,0);
 assert(!JSON.stringify(item).includes(f.identity.root));assert(!JSON.stringify(item).includes('credential_id'));
 const got=await f.access();assert.equal(got.artifact.state,'verified');assert.equal(got.url,'https://gitee.com/test-fixture/example/commit/'+f.input.plan.commit_oid);
 assert(f.calls.every(x=>x.options.method==='GET'&&x.options.redirect==='error'));assert.equal(db.prepare('SELECT total_changes() n').get().n,before);
});
test('disabled executor and restart reuse original journal; no runtime or Git callback needed',async t=>{
 const f=await setup(t),expected=f.registry.list(f.task.id),path=f.store.db.prepare('PRAGMA database_list').all().find(x=>x.name==='main').file;
 const db=new DatabaseSync(path,{readOnly:true});try{const g={...f.g,store:{db},deliveryRuntime:undefined};assert.deepEqual(deliveryArtifactList(g,f.task.id).items.map(r=>r.id),[f.id]);assert.equal(deliveryArtifact(g,f.task.id,f.id).sha256,expected.items[0].sha256);}finally{db.close();}
});
test('active/unknown push or commit alone does not become a remotely delivered artifact',async t=>{
 const f=await setup(t,{complete:false});assert.equal(f.registry.list(f.task.id).items.length,0);f.j.markUnknown(f.q.id,f.j.row(f.q.id).epoch);assert.equal(f.registry.list(f.task.id).items.length,0);
 await assert.rejects(f.access(),/DELIVERY_EVIDENCE_INVALID/);assert.equal(f.calls.length,0);
});
for(const corruption of ['push-result','push-event','commit-event','commit-result','approval','authority','decision','open-operation'])test('refuses incomplete historical chain: '+corruption,async t=>{
 const f=await setup(t),db=f.store.db;
 if(corruption==='push-result')db.prepare("UPDATE delivery_actions SET result='{}' WHERE id=?").run(f.q.id);
 if(corruption==='commit-result')db.prepare("UPDATE delivery_actions SET result='{}' WHERE id=?").run(f.source.id);
 if(corruption.endsWith('-event'))db.prepare("DELETE FROM delivery_events WHERE action_id=? AND type='readback_completed'").run(corruption==='push-event'?f.q.id:f.source.id);
 if(corruption==='approval')db.prepare("UPDATE approval_requests SET proposal_hash='invalid' WHERE id=?").run(f.p.r.id);
 if(corruption==='authority')db.prepare("UPDATE delivery_actions SET authority_hash='invalid' WHERE id=?").run(f.q.id);
 if(corruption==='decision')db.prepare('DELETE FROM approval_decisions WHERE request_id=?').run(f.p.r.id);
 if(corruption==='open-operation')db.prepare("INSERT INTO delivery_operations(id,action_id,epoch,kind,detail,state,started) VALUES ('bad',?,?, 'push','{}','running',1)").run(f.q.id,f.j.row(f.q.id).epoch);
 assert.equal(deliveryArtifact(f.g,f.task.id,f.id),null);assert.equal(f.registry.list(f.task.id).state,'evidence_unavailable');assert.equal(f.registry.list(f.task.id).delivery_unavailable,1);await assert.rejects(f.access(),/DELIVERY_EVIDENCE_INVALID/);
});
test('later approval expiry/revocation preserves already-observed historical delivery, never new authority',async t=>{
 const f=await setup(t),before=f.registry.list(f.task.id);f.time(90000000);f.store.db.prepare("UPDATE approval_requests SET state='revoked' WHERE id=?").run(f.p.r.id);
 assert.deepEqual(f.registry.list(f.task.id),before);assert.equal((await f.access()).artifact.state,'verified');
});
for(const mode of ['denied','missing','offline','oid','tree','parent','identity'])test('live Gitee access fails closed on '+mode,async t=>{
 const f=await setup(t);f.mode(mode);const r=await f.access();assert.equal(r.artifact.state,'unavailable');assert.equal(r.url,undefined);assert(!JSON.stringify(r).includes('secret-no-leak'));
});
test('foreign task, rebind and revision checks hold before and after network await',async t=>{
 const f=await setup(t);assert.equal(deliveryArtifact(f.g,'other-task',f.id),null);f.control.repository=false;assert.equal((await f.access()).artifact.state,'repository_changed');assert.equal(f.calls.length,0);
 f.control.repository=true;f.hook(()=>{f.control.repository=false;});assert.equal((await f.access()).artifact.state,'repository_changed');f.hook(null);f.control.repository=true;
 f.hook(()=>f.store.db.prepare('UPDATE task_catalog SET spec_revision=spec_revision+1 WHERE task_id=?').run(f.task.id));const r=await f.access();assert.equal(r.artifact.state,'stale_revision');assert.equal(r.url,undefined);
});
test('journal drift during provider request cannot yield URL from earlier evidence',async t=>{
 const f=await setup(t);f.hook(()=>f.store.db.prepare("UPDATE delivery_actions SET result='{}' WHERE id=?").run(f.q.id));const r=await f.access();assert.equal(r.artifact.state,'delivery_evidence_invalid');assert.equal(r.url,undefined);
});
test('delivery is page-only for explicit IM handoff, never fabricated bytes or worker session',async t=>{
 const f=await setup(t);assert.equal((await f.access('session')).error,'ARTIFACT_ACTION_UNAVAILABLE');assert.equal(f.calls.length,0);
 const snapshot=await artifactSnapshot(f.g,f.task.id,f.id,'page');assert.equal(snapshot.mode,'page');assert.equal(snapshot.size,0);assert.equal(snapshot.bytes,undefined);assert(snapshot.url.includes('/commit/'));
 for(const mode of ['image','file'])await assert.rejects(artifactSnapshot(f.g,f.task.id,f.id,mode),/PAGE_ONLY/);
});
test('close during provider observation rejects the late URL',async t=>{
 const f=await setup(t);let release,started;const ready=new Promise(r=>started=r);f.hook(()=>{started();return new Promise(r=>release=r);});const promise=f.access();await ready;const close=f.registry.close();f.hook(null);release();await assert.rejects(promise,/ARTIFACT_CLOSED/);await close;
});
test('multi-file additions/modifications/deletions use one complete commit page, not a nonexistent deleted file',async t=>{
 const f=await setup(t,{mixedFiles:true}),r=f.registry.list(f.task.id).items[0];assert.deepEqual(r.delivery.changes,{create:1,modify:1,delete:1});assert(r.description.includes('3 项文件变更'));assert.equal(r.repository.path,null);
 const access=await f.access();assert.equal(access.artifact.state,'verified');assert(access.url.includes('/commit/'));assert(f.calls.every(x=>!x.url.includes('/contents/')));
});
test('media endpoint admits derived page identity but refuses file/image downgrade before any effect',async t=>{
 const f=await setup(t),snapshot=await artifactSnapshot(f.g,f.task.id,f.id,'page');
 const input={id:'notification-11111111-1111-1111-1111-111111111111',lease:'11111111-1111-1111-1111-111111111111',task_id:f.task.id,binding_revision:1,target_key:'cloud:fixture',route_hash:'a'.repeat(64),text:'fixture',created:1,artifact:snapshot};
 const endpoint=Object.assign(Object.create(NotificationMediaEndpoint.prototype),{closed:false,g:{closed:false},row:()=>({fingerprint:notificationDigest(input),result:JSON.stringify({state:'accepted'})})});
 assert.equal((await endpoint.execute(input)).state,'accepted');for(const mode of ['file','image'])assert.throws(()=>endpoint.execute({...input,artifact:{...snapshot,mode}}),/MEDIA_PAYLOAD_INVALID/);
});
