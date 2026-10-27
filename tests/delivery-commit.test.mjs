import test from 'node:test';import assert from 'node:assert/strict';
import {fixture} from './delivery-commit-fixture.mjs';
import {DeliveryCommit,commitCommand} from '../bundle/delivery-commit.js';
import {execFileDrained} from '../bundle/drained-process.js';
test('disabled adapter never touches Git or filesystem locks',async t=>{const x=fixture(t,{enabled:false});await assert.rejects(x.run(),/DISABLED/);assert.equal(x.state.leaseCalls+x.state.gitCalls,0);assert.equal(x.j.view(x.action.id).dispatched,false);});
test('one bounded success follows durable intent -> locks -> objects -> CAS -> index -> unlock -> readback',async t=>{
 const x=fixture(t),r=await x.run();assert.equal(r.state,'completed');assert.deepEqual(x.state.events,['lock',...x.compiled.objects.map(()=>'object'),'reference','index','unlock']);assert.equal(x.state.locked,false);assert.equal(x.store.task(x.action.task_id).busy,0);
 const ops=x.store.db.prepare('SELECT kind,state,pid FROM delivery_operations ORDER BY rowid').all();assert(ops.every(o=>o.state==='closed'));assert.equal(ops.filter(o=>o.pid!==null).length,x.state.gitCalls);assert.equal(r.result.remote_acceptance,'not_observed');
});
test('duplicate execute never repeats a previous dispatch',async t=>{
 const x=fixture(t);await x.run();const n=x.state.gitCalls;await assert.rejects(x.run(),/STALE_FENCE/);assert.equal(x.state.gitCalls,n);
});
test('changed object bytes or binding fail before dispatch and effects',async t=>{
 const x=fixture(t),copy=x.compiled.objects.map(o=>({...o,data:Buffer.from(o.data)}));copy[0].data[0]^=1;await assert.rejects(x.commit.execute(x.action.id,x.action.epoch,copy),/PLAN_CHANGED/);assert.equal(x.state.gitCalls+x.state.leaseCalls,0);
 x.commit.binding.branch='main';await assert.rejects(x.run(),/BINDING_CHANGED/);assert.equal(x.j.view(x.action.id).dispatched,false);
});
for(const at of ['lock','object-before','object-after','object-bad-result','reference-before','reference-after','index-before','index-after','unlock','object-bad-close'])test('failure '+at+' holds managed resource, never retries or rolls back',async t=>{
 const x=fixture(t);x.state.failAt=at;const r=await x.run();assert.equal(r.state,'needs_review');assert.equal(r.review_required,true);assert.equal(x.store.task(x.action.task_id).busy,1);assert(x.state.events.filter(x=>x==='reference').length<=1);assert(x.state.events.filter(x=>x==='index').length<=1);
 const n=x.state.gitCalls;await assert.rejects(x.run(),/STALE_FENCE/);assert.equal(x.state.gitCalls,n);if(at==='reference-after'||at==='index-before')assert.equal(x.state.head,x.compiled.plan.computed_commit_oid);
});
for(const at of ['object-unknown','object-no-close'])test('undrained '+at+' retains physical locks and blocks both success/no-effect closure',async t=>{
 const x=fixture(t);x.state.failAt=at;const r=await x.run();assert.equal(r.state,'needs_review');assert.equal(x.state.locked,true);assert.equal(x.state.releaseCalls,0);assert(x.j.unfinished(x.action.id));
 assert.equal(x.j.finish(x.action.id,x.action.epoch).error,'DRAIN_REQUIRED');assert.equal(x.j.settleUnapplied(x.action.id,x.action.epoch).error,'DRAIN_REQUIRED');
});
test('revocation during object phase stops next write but permits owned-lock cleanup',async t=>{
 const x=fixture(t,{onEffect:({state})=>{state.authorized=false;}}),r=await x.run();assert.equal(r.state,'needs_review');assert.equal(x.state.gitCalls,1);assert.equal(x.state.releaseCalls,1);assert.equal(x.state.locked,false);assert.equal(x.store.task(x.action.task_id).busy,1);
});
test('task fence replacement cannot cause cleanup to steal ownership or mark success',async t=>{
 const x=fixture(t,{onEffect:({state,j,action})=>{j.db.prepare("UPDATE tasks SET owner='local',epoch=epoch+1 WHERE id=?").run(action.task_id);}});const r=await x.run();assert.equal(r.state,'needs_review');assert.equal(x.state.releaseCalls,0);assert.equal(x.store.task(x.action.task_id).owner,'local');assert.equal(x.state.locked,true);
});
test('configuration drift after objects prevents CAS and index mutation',async t=>{
 const x=fixture(t,{onEffect:({state})=>{state.metadata.config_sha256='9'.repeat(64);}});const r=await x.run();assert.equal(r.state,'needs_review');assert(!x.state.events.includes('reference'));assert(!x.state.events.includes('index'));
});
test('pre-aborted execution leaves dispatch untouched',async t=>{const x=fixture(t),ac=new AbortController();ac.abort();await assert.rejects(x.run(ac.signal),/CANCELLED/);assert.equal(x.j.view(x.action.id).dispatched,false);assert.equal(x.state.leaseCalls,0);});
test('real non-Git child abort records PID and actual close before lock cleanup',async t=>{
 const ac=new AbortController(),x=fixture(t,{runGit:(_args,_input,signal,observer)=>execFileDrained(process.execPath,['-e','setTimeout(()=>{},10000)'],{env:{PATH:'/usr/bin:/bin'},signal,killSignal:'SIGKILL',timeout:5000},undefined,observer)});
 const timer=setTimeout(()=>ac.abort(),60);try{const r=await x.run(ac.signal);assert.equal(r.state,'needs_review');assert.equal(x.j.unfinished(x.action.id),false);assert.equal(x.state.locked,false);
  const op=x.store.db.prepare("SELECT * FROM delivery_operations WHERE kind='object'").get();assert(op.pid>0);assert.equal(op.state,'closed');assert.throws(()=>process.kill(op.pid,0),{code:'ESRCH'});
 }finally{clearTimeout(timer);}
});
test('async filesystem replacement is not falsely marked drained',async t=>{
 const x=fixture(t);x.lease.open=()=>Promise.resolve();const r=await x.run();assert.equal(r.state,'needs_review');assert(x.j.unfinished(x.action.id));assert.equal(x.state.releaseCalls,0);
});
test('whitelisted write commands require exact scoped branch and old/new object ids',t=>{
 const x=fixture(t),p=x.compiled.plan,o=x.compiled.objects[0];assert.deepEqual(commitCommand('object',p,o),['hash-object','-w','-t',o.type,'--stdin','--no-filters']);
 const a=commitCommand('reference',p);assert.equal(a.at(-1),p.parent);assert.equal(a.at(-2),p.computed_commit_oid);assert(a.includes('--no-deref'));
 for(const kind of ['push','checkout','reset','delete','shell'])assert.throws(()=>commitCommand(kind,p),/COMMAND_DENIED/);assert.throws(()=>commitCommand('reference',{...p,branch:'main'}),/COMMAND_DENIED/);
});
test('foreign inode replacement is never removed by cleanup',async t=>{
 const x=fixture(t,{onEffect:({state})=>{state.failAt='lock-changed';}}),r=await x.run();assert.equal(r.state,'needs_review');assert.equal(x.state.locked,true);assert.equal(x.state.gitCalls,1);
});
test('revocation after CAS does not silently finish index or reset committed reference',async t=>{
 const x=fixture(t,{onEffect:({kind,state})=>{if(kind==='reference')state.authorized=false;}}),r=await x.run();assert.equal(r.state,'needs_review');assert.equal(x.state.head,x.compiled.plan.computed_commit_oid);assert(!x.state.events.includes('index'));assert.equal(x.state.locked,false);
});
test('concurrent calls on one adapter cannot interleave effects',async t=>{
 const x=fixture(t),old=x.commit.runGit;let unblock;const barrier=new Promise(r=>unblock=r);x.commit.runGit=async(...args)=>{await barrier;return old(...args);};
 const pending=x.run();await assert.rejects(x.run(),/IN_FLIGHT/);unblock();assert.equal((await pending).state,'completed');assert.equal(x.state.leaseCalls,1);
});
