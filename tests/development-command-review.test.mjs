import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {setup,start,command,plan} from './workspace-fixture.mjs';
import {DevelopmentCommandReview} from '../bundle/development-command-review.js';
import {DevelopmentContainer} from '../bundle/development-container.js';
import {digest} from '../bundle/approval-ledger.js';
const started='2026-10-19T00:00:00.000000000Z',finished='2026-10-19T00:00:10.000000000Z';
async function orphan(t,{running=true}={}){
 const adapter=Object.create(DevelopmentContainer.prototype),calls=[];let container,exclusive=true,lostKill=false;
 adapter.cli=async args=>{
  calls.push(args);if(args[0]==='inspect'){if(!container)throw Error('daemon unavailable or missing');return JSON.stringify([container]);}
  if(args[0]==='kill'){container.State={...container.State,Status:'exited',Running:false,Pid:0,ExitCode:137,FinishedAt:finished};if(lostKill){lostKill=false;throw Error('lost kill acknowledgement');}return '';}
  if(args[0]==='wait')return '137';if(args[0]==='rm'){container=null;return '';}
  throw Error('unexpected CLI');
 };
 adapter.run=async(w,h,id,o)=>{
  container={Id:'c'.repeat(64),Name:'/'+adapter.name(o.operation),Image:w.spec.commands[0].image,RestartCount:0,
   Config:{Labels:{'dsh.operation':o.operation,'dsh.command':digest(w.spec.commands.find(c=>c.id===id))}},
   HostConfig:{RestartPolicy:{Name:'no'},AutoRemove:false},
   State:{Status:running?'running':'exited',Running:running,Pid:running?4321:0,Dead:false,Paused:false,Restarting:false,StartedAt:started,FinishedAt:running?'0001-01-01T00:00:00Z':finished,ExitCode:0}};
  o.onCreated({id:container.Id,name:adapter.name(o.operation)});throw Object.assign(Error('DEVELOPMENT_CONTAINER_DRAIN_UNKNOWN'),{drained:false});
 };
 const spec=plan();spec.executors=['cloud','local'];const f=await setup(t,{commands:adapter,selectedSpec:spec});adapter.directory=f.dir;
 const q=start(f),competitor=f.enqueue('local','competitor');await assert.rejects(command(f,q,'build'),/DRAIN_UNKNOWN/);
 const op=f.store.db.prepare('SELECT * FROM development_operations WHERE request_id=?').get(q.id);
 const assertExclusive=()=>{if(!exclusive)throw Error('DEVELOPMENT_REVIEW_EXCLUSIVE_REQUIRED');};
 const review=new DevelopmentCommandReview(f.gate,{assertExclusive});
 const args=async(extra={})=>({request_id:q.id,operation_id:op.id,event_id:'review-one',proof_hash:(await review.evidence(q.id,op.id)).proof_hash,note:'Operator-only synthetic review; no execution grant',stop_running:true,...extra});
 return {...f,q,op,review,adapter,calls,args,assertExclusive,competitor,get container(){return container;},missing:()=>container=null,exclusive:v=>exclusive=v,loseKill:()=>lostKill=true};
}
test('evidence is read-only; stop requires explicit operator choice and never unblocks',async t=>{
 const f=await orphan(t);const a=await f.args({stop_running:false}),before=f.gate.view(f.q.id);
 assert.equal(f.container.State.Running,true);assert(!f.calls.some(x=>x[0]==='kill'));
 await assert.rejects(f.review.review(a),/STOP_CONFIRMATION_REQUIRED/);assert.deepEqual(f.gate.view(f.q.id),before);
 const result=await f.review.review({...a,stop_running:true});assert(result.drained);assert.equal(result.test_passed,false);assert.equal(result.grants_execution,false);
 assert.equal(result.budget_reset,false);assert.equal(result.starts_worker,false);assert.equal(result.receipt.output,'');
 assert.equal(f.gate.view(f.q.id).state,'needs_review');assert.equal(f.gate.view(f.q.id).test_result,null);assert(f.store.task(f.task.id).blocked);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM development_commands').get().n,1);assert.equal(f.gate.unresolved(f.q.id),false);
 await assert.rejects(command(f,f.q,'test'),/STALE_FENCE/);assert.throws(()=>f.gate.acquire(f.competitor.id),/TASK_BLOCKED/);
 assert.deepEqual(await f.review.review({...a,stop_running:true}),{...result,replayed:true});
 await assert.rejects(f.review.review({...a,stop_running:true,note:'changed'}),/REVIEW_CONFLICT/);
 assert.equal(f.calls.filter(x=>x[0]==='kill').length,1);await f.review.cleanup(a.event_id);assert.equal(f.container,null);
});
test('already stopped command with lost result is drained but never retroactively passed',async t=>{
 const f=await orphan(t,{running:false}),r=await f.review.review(await f.args({stop_running:false}));
 assert.equal(r.receipt.exit_code,0);assert.equal(r.receipt.passed,false);assert.equal(r.receipt.code,'DEVELOPMENT_COMMAND_INTERRUPTED_REVIEWED');assert(!f.calls.some(x=>x[0]==='kill'));
});
test('lost stop acknowledgement survives reviewer reconstruction, re-inspects same ID without a second kill',async t=>{
 const f=await orphan(t),a=await f.args();f.loseKill();await assert.rejects(f.review.review(a),/lost kill/);
 assert.equal(f.gate.unresolved(f.q.id),true);assert.equal(f.container.State.Running,false);
 assert.equal(f.store.db.prepare('SELECT state FROM development_command_reviews').get().state,'prepared');
 const recovered=new DevelopmentCommandReview(f.gate,{assertExclusive:f.assertExclusive});
 const r=await recovered.review(a);assert(r.drained);assert.equal(f.calls.filter(x=>x[0]==='kill').length,1);assert.equal(f.store.db.prepare('SELECT count(*) n FROM development_commands').get().n,1);
});
test('missing container or failed inspect is not evidence of drain and preserves the gate',async t=>{
 const f=await orphan(t),a=await f.args();f.missing();await assert.rejects(f.review.review(a));assert(f.gate.unresolved(f.q.id));assert.equal(f.gate.view(f.q.id).state,'needs_review');assert(!f.calls.some(x=>x[0]==='kill'));
});
test('reject changed container identity, mutable lifecycle and ambiguous states',async t=>{
 const f=await orphan(t),original=structuredClone(f.container);
 const mutations=[c=>c.Id='d'.repeat(64),c=>c.Name='/other',c=>c.Image='sha256:'+'b'.repeat(64),c=>c.Config.Labels['dsh.command']='changed',
  c=>c.HostConfig.RestartPolicy.Name='always',c=>c.HostConfig.AutoRemove=true,c=>c.RestartCount=1,
  c=>c.State.StartedAt='0001-01-01T00:00:00Z',c=>c.State.Status='created',c=>c.State.Dead=true,c=>c.State.Paused=true,c=>c.State.Restarting=true,
  c=>c.State.Pid=0,c=>c.State.Running=false];
 for(const mutate of mutations){Object.assign(f.container,structuredClone(original));mutate(f.container);await assert.rejects(f.review.evidence(f.q.id,f.op.id));}
 assert(!f.calls.some(x=>x[0]==='kill'));assert(f.gate.unresolved(f.q.id));
});
test('reject mismatched durable command fingerprint, intent, container and fence',async t=>{
 for(const variant of ['fingerprint','intent','container','epoch','task'])await t.test(variant,async t=>{
  const f=await orphan(t),db=f.store.db;
  if(variant==='fingerprint')db.prepare("UPDATE development_commands SET fingerprint='wrong'").run();
  if(variant==='intent')db.prepare("DELETE FROM development_events WHERE type='command_intent'").run();
  if(variant==='container')db.prepare("DELETE FROM development_events WHERE type='command_container'").run();
  if(variant==='epoch')db.prepare('UPDATE development_operations SET epoch=epoch+1').run();
  if(variant==='task')db.prepare('UPDATE tasks SET epoch=epoch+1 WHERE id=?').run(f.task.id);
  await assert.rejects(f.review.evidence(f.q.id,f.op.id));assert(!f.calls.some(x=>x[0]==='kill'));
 });
});
test('original approval expiry permits drain-only cleanup but cannot grant execution',async t=>{
 const f=await orphan(t);f.time(25*3600*1000);assert.notEqual(f.ledger.view(f.req.id).state,'approved');
 const r=await f.review.review(await f.args());assert(r.drained);assert.equal(r.grants_execution,false);assert(f.store.task(f.task.id).blocked);
});
test('cannot review while task has live agent, inflight I/O, no owner lock, or changed workspace',async t=>{
 const f=await orphan(t);f.exclusive(false);await assert.rejects(f.review.evidence(f.q.id,f.op.id),/EXCLUSIVE/);f.exclusive(true);
 f.gate.inflight.add(f.q.id);await assert.rejects(f.review.evidence(f.q.id,f.op.id),/REVIEW_STATE/);f.gate.inflight.clear();
 f.gate.busy=()=>true;await assert.rejects(f.review.evidence(f.q.id,f.op.id),/REVIEW_STATE/);f.gate.busy=()=>false;
 writeFileSync(join(f.root,'README.md'),'external change');await assert.rejects(f.review.evidence(f.q.id,f.op.id));assert(!f.calls.some(x=>x[0]==='kill'));
});
test('stale proof and daemon restart between prepared stop and retry cannot settle',async t=>{
 const f=await orphan(t),a=await f.args();await assert.rejects(f.review.review({...a,proof_hash:'0'.repeat(64)}),/STALE_EVIDENCE/);
 f.loseKill();await assert.rejects(f.review.review(a));f.container.State.StartedAt='2026-10-19T01:00:00Z';
 await assert.rejects(f.review.review(a),/IDENTITY_CHANGED/);assert(f.gate.unresolved(f.q.id));assert.equal(f.calls.filter(x=>x[0]==='kill').length,1);
});
test('concurrent same-operation review cannot race stop; no blanket process kill or force removal',async t=>{
 const f=await orphan(t),a=await f.args(),raw=f.adapter.stopForReview.bind(f.adapter);let unblock;const wait=new Promise(r=>unblock=r);
 f.adapter.stopForReview=async(...args)=>{await wait;return raw(...args);};
 const first=f.review.review(a);await new Promise(r=>setImmediate(r));await assert.rejects(f.review.review(a),/IN_FLIGHT/);unblock();await first;
 await f.review.cleanup(a.event_id);assert.deepEqual(f.calls.filter(x=>x[0]==='kill'),[['kill','--signal','KILL','c'.repeat(64)]]);
 assert.deepEqual(f.calls.filter(x=>x[0]==='rm'),[['rm','c'.repeat(64)]]);
});
