// Real journal, receipt file checks and reconciliation; remote readback is synthetic.
import test from 'node:test';import assert from 'node:assert/strict';
import {fixture} from './delivery-receipt-fixture.mjs';
import {DeliveryPushRecovery} from '../bundle/delivery-push-recovery.js';
async function setup(t){
 const f=await fixture(t);f.ready();let proof;const control={idle:true,match:true,reads:0,hold:null};
 const executor={async readback(i){control.reads++;if(control.hold)await control.hold();const p=i.plan;
  if(!control.match)throw Error('synthetic remote mismatch');proof={kind:'push-readback-v1',intent_fingerprint:i.fingerprint,workspace_identity:i.workspace_identity,repository_id:p.repository_id,url:p.url,ref:p.ref,ref_oid:p.commit_oid,drained:true,observed_at:f.j.now()};}};
 f.j.observe=()=>proof;const recovery=new DeliveryPushRecovery({journal:f.j,receipts:f.receipts,executor,quiescent:()=>control.idle,enabled:true});
 const close=()=>{const evidence=recovery.inspect(f.a.id,f.a.epoch).operations[0].evidence;return recovery.closeOperation(f.a.id,f.a.epoch,f.op,evidence.fingerprint);};
 return {...f,control,recovery,close};
}
test('operator reconciliation closes proven process then needs independent remote readback to release task',async t=>{
 const f=await setup(t);await assert.rejects(f.recovery.settle(f.a.id,f.a.epoch),/DRAIN_REQUIRED/);f.close();assert.equal(f.store.task(f.task.id).busy,1);
 const r=await f.recovery.settle(f.a.id,f.a.epoch);assert.equal(r.state,'completed');assert.equal(f.control.reads,1);assert.equal(r.result.remote_acceptance,'ref_observed');assert.equal(r.result.runtime_adoption,'not_observed');assert.equal(r.retry_authorized,false);assert.equal(f.store.task(f.task.id).busy,0);
});
test('unchanged or unreadable remote never proves no effect, never releases and never resends',async t=>{
 const f=await setup(t);f.close();f.control.match=false;const r=await f.recovery.settle(f.a.id,f.a.epoch);
 assert.equal(r.state,'needs_review');assert.equal(r.error,'REMOTE_READBACK_UNVERIFIED');assert.equal(f.j.db.prepare("SELECT count(*) n FROM delivery_events WHERE action_id=? AND type='remote_readback_failed'").get(f.a.id).n,1);assert.equal(f.store.task(f.task.id).busy,1);assert.equal(f.j.db.prepare("SELECT count(*) n FROM delivery_operations WHERE action_id=? AND kind='push'").get(f.a.id).n,1);
});
test('missing or live process evidence stays unknown; inspection is read-only and exposes no private path or nonce',async t=>{
 const f=await setup(t);f.control.idle=false;assert.throws(()=>f.recovery.inspect(f.a.id,f.a.epoch),/NOT_QUIESCENT/);f.control.idle=true;f.control.live=true;
 f.receipts.live=()=>true;const before=f.j.db.prepare('SELECT total_changes() n').get().n,s=f.recovery.inspect(f.a.id,f.a.epoch);
 assert.equal(f.j.db.prepare('SELECT total_changes() n').get().n,before);assert.equal(s.operations[0].evidence.state,'supervisor_live');assert(!JSON.stringify(s).includes(f.binding.nonce));assert(!JSON.stringify(s).includes(f.directory));
 assert.throws(()=>f.close(),/EVIDENCE_CHANGED/);
});
test('scope, disabled reconciler, foreign operation and stale epoch cannot be adopted',async t=>{
 const f=await setup(t);assert.throws(()=>new DeliveryPushRecovery({journal:f.j}).inspect(f.a.id,f.a.epoch),/DISABLED/);
 assert.throws(()=>f.recovery.closeOperation(f.a.id,f.a.epoch,'missing','a'.repeat(64)));assert.throws(()=>f.recovery.inspect(f.a.id,f.a.epoch+1),/STALE_FENCE/);
 assert.equal(f.j.unfinished(f.a.id),true);
});
test('ownership loss while awaiting remote observation cannot release a new generation',async t=>{
 const f=await setup(t);f.close();let release;f.control.hold=()=>new Promise(r=>release=r);
 const result=f.recovery.settle(f.a.id,f.a.epoch);assert(release);f.j.db.prepare('UPDATE tasks SET epoch=epoch+1 WHERE id=?').run(f.task.id);release();await assert.rejects(result);
 assert.equal(f.store.task(f.task.id).busy,1);assert.equal(f.j.row(f.a.id).state,'needs_review');
});
