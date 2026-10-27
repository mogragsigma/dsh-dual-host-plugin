// Actual runtime, push adapter, journal, ledger and chat verifier; fake provider,
// SSH process, filesystem and scheduler owner. No real Git effects or approvals.
import test from 'node:test';import assert from 'node:assert/strict';
import {setup as approvalFixture,commitReadback} from './delivery-push-approval-fixture.mjs';
import {DeliveryRuntime} from '../bundle/delivery-runtime.js';
import {DeliveryPush} from '../bundle/delivery-push.js';
import {deliveryActions} from '../bundle/delivery-state.js';
async function setup(t,{execute=true}={}){
 const f=await approvalFixture(t),control={sends:0,reads:0,remote:null,failRead:false,close:true,ack:true,hold:null,holdPush:null};let rt;
 const binding={root:f.identity.root,url:f.identity.url,branch:f.identity.branch,base_sha:f.identity.base_sha};
 const scheduler={started:true,closed:false,lock:{listening:true},active:new Map()};
 const g={c:{role:'cloud'},closed:false,store:f.store,catalog:f.catalog,approvals:f.ledger,delivery:f.preview,now:f.ledger.now,scheduler,
  development:{gate:{bindings:{[f.task.id]:binding},inflight:new Set()}},repositories:{provider:{identity:async()=>f.repository}}};
 const reader={observe:commitReadback,capture:()=>({fingerprint:'a'.repeat(64)}),ancestor:()=>true};
 const ssh={read:async(_p,{signal}={})=>{control.reads++;if(control.hold)await control.hold(signal);if(control.failRead||signal?.aborted)throw Error('synthetic read error');return control.remote;},
  push:async(p,o)=>{o.beforeSpawn();o.onSpawn({pid:12345});control.sends++;control.remote=p.commit_oid;
   if(control.holdPush)await control.holdPush(o.signal);
   if(control.close)o.onDrained({code:control.ack?0:1,signal:null});if(!control.ack)throw Error('synthetic lost acknowledgement');}};
 const io={reader:()=>reader,push:()=>new DeliveryPush({journal:rt.journal,binding,provider:g.repositories.provider,enabled:true,now:g.now,externalDrained:()=>rt.drained(f.task.id)},{reader,ssh})};
 const config={enabled:true,execute:false,author:f.compiled.plan.author,committer:f.compiled.plan.committer,push:{enabled:true,execute,keyFile:'/synthetic-key-not-read',knownHostsFile:'/synthetic-hosts-not-read'}};
 rt=new DeliveryRuntime(g,config,io);g.deliveryRuntime=rt;rt.start();
 const args={task_id:f.task.id,commit_action_id:f.source.id,event_id:'prepare-runtime'};
 const prepare=()=>rt.stagePush('local',args);
 const approved=async()=>{const s=await prepare(),p=await f.prompt(f.request(s.reference));await f.decide(p.prompt);return p;};
 const schedule=id=>rt.schedulePush('local',{task_id:f.task.id,approval_id:id,event_id:'schedule-runtime'});
 t.after(()=>rt.close());return {...f,rt,g,config,io,args,prepare,approved,schedule,control,getRuntime:()=>rt,restart:async()=>{await rt.close();rt=new DeliveryRuntime(g,config,io);g.deliveryRuntime=rt;rt.start();return rt;}};
}
test('public preparation reads exact remote and returns opaque replay without repeating reads',async t=>{
 const f=await setup(t),s=await f.prepare();assert.equal(s.reference.kind,'push-execution-reference-v1');assert.equal(s.remote_checked_now,true);assert.equal(f.control.reads,2);
 const replay=await f.prepare();assert.equal(replay.replayed,true);assert.equal(replay.remote_checked_now,false);assert.equal(f.control.reads,2);assert.equal(f.control.sends,0);
 for(const k of ['url','ref','expected_remote_oid','approved','keyFile'])assert.throws(()=>f.rt.stagePush('cloud',{...f.args,[k]:'injected'}),/INVALID_PUSH_STAGE/);
});
test('push switch is separate from commit switch; approval never enqueues automatically',async t=>{
 const f=await setup(t),p=await f.approved();f.rt.tick();assert.equal(f.control.sends,0);assert.equal(f.rt.executionEnabled,false);
 const q=f.schedule(p.r.id);assert.equal(q.action.state,'queued');assert.equal(f.control.sends,0);
 f.rt.tick();assert(f.rt.pending);await f.rt.pending;assert.equal(f.rt.journal.row(q.action.id).state,'completed');assert.equal(f.control.sends,1);
 f.rt.tick();assert.equal(f.schedule(p.r.id).action.state,'completed');assert.equal(f.control.sends,1);
 const s=deliveryActions(f.g,f.task.id);assert.equal(s.push_execution_enabled,true);assert.equal(s.execution_enabled,false);
 const item=s.items.find(x=>x.id===q.action.id);assert.equal(item.remote_acceptance,'ref_observed');assert.equal(item.runtime_adoption,'not_observed');
});
test('staging only does not advertise or permit transmission, even with an approved plan',async t=>{
 const f=await setup(t,{execute:false}),p=await f.approved();assert.throws(()=>f.schedule(p.r.id),/PUSH_EXECUTION_DISABLED/);f.rt.tick();assert.equal(f.control.sends,0);
 assert.equal(f.rt.status().push_enabled,false);assert.equal(f.rt.status().push_staging_enabled,true);
});
test('busy task queues with no remote reads and executes only after idle',async t=>{
 const f=await setup(t),p=await f.approved();f.g.store.db.prepare('UPDATE tasks SET busy=1 WHERE id=?').run(f.task.id);const count=f.control.reads,q=f.schedule(p.r.id);
 f.rt.tick();assert.equal(f.control.reads,count);assert.equal(f.rt.journal.waiting(q.action.id),'task_busy');assert.equal(f.control.sends,0);
 f.g.store.db.prepare('UPDATE tasks SET busy=0 WHERE id=?').run(f.task.id);f.rt.tick();await f.rt.pending;assert.equal(f.control.sends,1);
});
test('changed remote cancels undispatched queue with explicit preflight failure, never silently rebases',async t=>{
 const f=await setup(t),p=await f.approved(),q=f.schedule(p.r.id);f.control.remote='2'.repeat(40);f.rt.tick();await f.rt.pending;
 const r=f.rt.journal.row(q.action.id);assert.equal(r.state,'cancelled');assert.equal(r.error,'preflight_failed');assert.equal(r.dispatched,0);assert.equal(f.control.sends,0);
 f.rt.tick();assert.equal(f.control.sends,0);
});
test('lost send acknowledgement is settled by separate readback, not by repeating push',async t=>{
 const f=await setup(t),p=await f.approved(),q=f.schedule(p.r.id);f.control.ack=false;f.rt.tick();await f.rt.pending;
 assert.equal(f.rt.journal.row(q.action.id).state,'completed');assert.equal(f.control.sends,1);assert(f.control.reads>=5);
});
test('unknown child drain holds task across runtime restart without resend',async t=>{
 const f=await setup(t),p=await f.approved(),q=f.schedule(p.r.id);f.control.close=false;f.rt.tick();await f.rt.pending;
 assert.equal(f.rt.journal.row(q.action.id).state,'needs_review');assert.equal(f.g.store.task(f.task.id).busy,1);
 const next=await f.restart();next.tick();assert.equal(f.control.sends,1);assert.equal(next.journal.unfinished(q.action.id),true);
});
test('queued approved push survives runtime recreation and runs once with new preflight',async t=>{
 const f=await setup(t),p=await f.approved(),q=f.schedule(p.r.id);const next=await f.restart();assert.equal(next.journal.row(q.action.id).state,'queued');
 next.tick();await next.pending;assert.equal(f.control.sends,1);assert.equal(next.journal.row(q.action.id).state,'completed');
});
test('revocation between async preflight and acquisition prevents send',async t=>{
 const f=await setup(t),p=await f.approved(),q=f.schedule(p.r.id);let release;f.control.hold=()=>new Promise(r=>release=r);
 f.rt.tick();await new Promise(r=>setImmediate(r));assert(release);await f.decide(p.prompt,'撤销此方案');f.control.hold=null;release();await f.rt.pending;
 assert.equal(f.control.sends,0);assert.equal(f.rt.journal.row(q.action.id).state,'cancelled');
});
test('shutdown aborts and awaits read-only preparation, without saving a half plan',async t=>{
 const f=await setup(t);let started=false;f.control.hold=signal=>new Promise(resolve=>{started=true;signal.addEventListener('abort',resolve,{once:true});});
 const promise=f.prepare(),checked=assert.rejects(promise);await new Promise(r=>setImmediate(r));assert(started);await f.rt.close();await checked;
 assert.equal(f.g.store.db.prepare('SELECT count(*) n FROM delivery_push_plans').get().n,0);assert.equal(f.control.sends,0);
});
test('shutdown before acquisition leaves queued action durable, no unproven cancellation or send',async t=>{
 const f=await setup(t),p=await f.approved(),q=f.schedule(p.r.id);let started=false;
 f.control.hold=signal=>new Promise(resolve=>{started=true;signal.addEventListener('abort',resolve,{once:true});});f.rt.tick();await new Promise(r=>setImmediate(r));assert(started);await f.rt.close();
 assert.equal(f.rt.journal.row(q.action.id).state,'queued');assert.equal(f.control.sends,0);
});
