// Actual journal + push orchestration, synthetic filesystem/SSH/provider/approval.
// The separate Linux supervisor tests exercise real child processes, not Gitee writes.
import test from 'node:test';import assert from 'node:assert/strict';
import {fixture as commitFixture} from './delivery-commit-fixture.mjs';
import {DeliveryPush} from '../bundle/delivery-push.js';
import {compilePush} from '../bundle/delivery-push-plan.js';
async function fixture(t){
 const f=commitFixture(t);await f.run();const source=f.j.row(f.action.id),result=JSON.parse(source.result);
 const control={now:100000,remote:f.intent.plan.parent,read:0,push:0,effects:0,drained:true,ancestor:true,providerId:101,mode:'normal',readerCalls:0};
 const plan=compilePush({source_action_id:source.id,commit_intent:f.intent,commit_result:result,repository_id:101,expected_remote_oid:control.remote});
 f.j.pushEnabled=true;f.j.now=()=>control.now;f.j.authorize=({approval_id,intent})=>f.state.authorized?{kind:'delivery-execution-v1',scope:'push',execution:true,approval_id,task_id:intent.task_id,task_revision:intent.task_revision,intent_fingerprint:intent.fingerprint,authority_hash:'c'.repeat(64)}:null;
 const ssh={async read(p){control.read++;if(control.mode==='read-failed')throw Error('provider secret');if(control.mode==='stale-read')control.now+=6000;return control.remote;},async push(p,o){
  control.push++;if(control.mode==='revoked-before-spawn')f.state.authorized=false;
  o.beforeSpawn();o.onSpawn({pid:54321});if(control.mode==='unknown-process')throw Error('unknown');
  if(!['rejected','unchanged'].includes(control.mode)){control.effects++;control.remote=p.commit_oid;}
  o.onDrained({code:control.mode==='lost-ack'?1:0,signal:null,reaped:2});
  if(control.mode==='lost-ack')throw Error('ack unavailable');
  return {acknowledged:true,drained:true};
 }};
 const provider={async identity(url){return {provider:'gitee',repository_id:control.providerId,url,private:true};}};
 const reader={...f.reader,ancestor:()=>control.ancestor,capture:i=>{control.readerCalls++;if(control.mode==='slow-local')control.now+=6000;return f.reader.capture(i);}};
 const push=new DeliveryPush({journal:f.j,binding:f.binding,provider,enabled:true,externalDrained:()=>control.drained,now:()=>control.now},{reader,ssh});
 f.j.preflight=i=>push.cachedPreflight(i);f.j.observe=i=>push.cachedReadback(i);
 const q=f.j.enqueue({task_id:f.action.task_id,resource:f.intent.resource,workspace_identity:f.intent.workspace_identity,plan,event_id:'push',approval_id:'synthetic-push'}),intent=f.j.intent(f.j.row(q.id));
 const acquire=async()=>{await push.preflight(intent);const a=f.j.acquire(q.id);assert.equal(a.acquired,true);return a;};
 return {...f,control,plan,push,ssh,reader,provider,q,intent,acquire};
}
test('actual push adapter composes durable dispatch, one network operation and independent remote readback',async t=>{
 const f=await fixture(t),a=await f.acquire(),r=await f.push.execute(a.id,a.epoch);
 assert.equal(r.state,'completed');assert.equal(r.result.remote_acceptance,'ref_observed');assert.equal(f.control.effects,1);assert.equal(f.control.push,1);assert.equal(f.store.task(a.task_id).busy,0);
 const ops=f.store.db.prepare('SELECT * FROM delivery_operations WHERE action_id=?').all(a.id);assert.equal(ops.length,1);assert.equal(ops[0].state,'closed');assert.equal(ops[0].pid,54321);
 await assert.rejects(f.push.execute(a.id,a.epoch),/STALE_FENCE/);assert.equal(f.control.push,1);
});
test('lost push acknowledgement may be settled by fresh readback but is never retransmitted',async t=>{
 const f=await fixture(t),a=await f.acquire();f.control.mode='lost-ack';const r=await f.push.execute(a.id,a.epoch);
 assert.equal(r.state,'completed');assert.equal(f.control.push,1);assert.equal(r.result.runtime_adoption,'not_observed');
});
for(const mode of ['unknown-process','rejected','unchanged','revoked-before-spawn'])test('holds '+mode+' without retry or releasing task',async t=>{
 const f=await fixture(t),a=await f.acquire();f.control.mode=mode;const r=await f.push.execute(a.id,a.epoch);
 assert.equal(r.state,'needs_review');assert.equal(f.store.task(a.task_id).busy,1);assert.equal(f.control.push,1);
 if(mode==='unknown-process')assert.equal(f.j.unfinished(a.id),true);
 if(mode==='revoked-before-spawn')assert.equal(f.control.effects,0);
});
for(const fault of ['wrong-repository','remote-changed','non-fast-forward','not-drained','read-failed','slow-local'])test('preflight rejects '+fault+' before acquiring or transmitting',async t=>{
 const f=await fixture(t);if(fault==='wrong-repository')f.control.providerId=102;if(fault==='remote-changed')f.control.remote='4'.repeat(40);if(fault==='non-fast-forward')f.control.ancestor=false;if(fault==='not-drained')f.control.drained=false;if(fault==='read-failed')f.control.mode='read-failed';if(fault==='slow-local')f.control.mode='slow-local';
 await assert.rejects(f.acquire());assert.equal(f.j.view(f.q.id).state,'queued');assert.equal(f.control.push,0);assert.equal(f.store.task(f.q.task_id).busy,0);
});
test('cached observation cannot be borrowed by another intent or renewed by querying',async t=>{
 const f=await fixture(t);await f.push.preflight(f.intent);assert.throws(()=>f.push.cachedPreflight({...f.intent,fingerprint:'0'.repeat(64)}),/PREFLIGHT_REQUIRED/);
 f.control.now+=5001;assert.throws(()=>f.push.cachedPreflight(f.intent),/PREFLIGHT_REQUIRED/);assert.equal(f.control.push,0);
});
test('disabled adapter and pre-cancelled execution never call SSH',async t=>{
 const f=await fixture(t),a=await f.acquire();f.push.enabled=false;await assert.rejects(f.push.execute(a.id,a.epoch),/DISABLED/);
 f.push.enabled=true;const c=new AbortController();c.abort();await assert.rejects(f.push.execute(a.id,a.epoch,{signal:c.signal}),/ABORTED/);assert.equal(f.control.push,0);
});
test('workspace change between last preflight and spawn rejects actual sending',async t=>{
 const f=await fixture(t),a=await f.acquire(),original=f.ssh.push;
 f.ssh.push=async(p,o)=>{f.state.metadata.index_sha256='e'.repeat(64);return original(p,o);};
 const r=await f.push.execute(a.id,a.epoch);assert.equal(r.state,'needs_review');assert.equal(f.control.effects,0);
});
