import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOnboardingActivity} from '../bundle/onboarding-activity.js';
import {createOnboardingCoordinatedHold} from '../bundle/onboarding-coordinated-hold.js';
import {createOnboardingAgentHold} from '../bundle/onboarding-agent-hold.js';
import {createOnboardingMaintenanceRecord} from '../bundle/onboarding-maintenance-record.js';
const KEY='dsh-task-gateway/onboarding-maintenance-record-v1';
const confirm=p=>({id:p.id,fingerprint:p.fingerprint,confirm:true});
const tick=()=>new Promise(setImmediate);
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function storage(){
 let record=null,writes=0,before=null,after=null,onRead=null;
 const credentials={async readRecord(k){assert.equal(k,KEY);await onRead?.();return structuredClone(record);},async modifyRecord(k,fn){assert.equal(k,KEY);const next=fn(structuredClone(record));await before?.(next);record=structuredClone(next);writes++;await after?.(next);}};
 return {credentials,get:()=>structuredClone(record),set:r=>{record=structuredClone(r);},writes:()=>writes,before:f=>before=f,after:f=>after=f,onRead:f=>onRead=f};
}
const owner=pid=>({platform:'linux',host:'a'.repeat(64),namespace:'pid:[321]',boot:'11111111-1111-1111-1111-111111111111',pid,start:String(pid*100)});
function fixture(store=storage(),pid=17){
 const activity=createOnboardingActivity({initialAdmission:'checking'}),agents=createOnboardingAgentHold({agents:{list:()=>[]},on:()=>()=>{}});
 const coordinated=createOnboardingCoordinatedHold({components:()=>({onboarding:activity,agents,gatewayExpected:false})});
 let provider=store.credentials,exited=false;
 const processIdentity={capture:async()=>owner(pid),observe:async old=>({state:exited?'exited':'alive',reason:exited?'absent':'same_process',currentStart:exited?null:old.start,observer:owner(pid),observedAt:1000})};
 const own=createOnboardingMaintenanceRecord({coordinated,activity,credentials:()=>provider,processIdentity});
 let starts=0;activity.deferStartup('models',()=>starts++);
 return {store,activity,coordinated,own,starts:()=>starts,boot:()=>own.initializeAdmission(),exitProof:()=>exited=true,replace:c=>provider=c,close:()=>{activity.close();own.dispose();coordinated.dispose();}};
}
const hold=async f=>f.own.apply(confirm(await f.own.preview()));
const release=async f=>f.own.releaseApply(confirm(await f.own.releasePreview()));
const resume=async f=>f.own.resumeApply(confirm(await f.own.resumePreview()));

test('boot holds startup and ordinary admission until original durable read completes, without writing',async()=>{
 const f=fixture(),d=deferred();f.store.onRead(()=>d.promise);const work=f.boot();assert.equal(f.starts(),0);assert.throws(()=>f.activity.enter('rpc'),/ADMISSION_BLOCKED/);
 assert.equal(f.activity.status().admission,'checking');d.resolve();await work;await tick();assert.equal(f.starts(),1);assert.equal(f.store.writes(),0);assert.equal(f.activity.status().admission,'open');f.close();
});
test('maintenance survives a new instance; retirement alone never resumes deferred execution',async()=>{
 const f=fixture();await f.boot();await tick();await hold(f);f.close();const before=f.store.get(),g=fixture(f.store,22);await g.boot();assert.deepEqual(g.store.get(),before);assert.equal(g.starts(),0);assert.equal((await g.own.status()).state,'interrupted');assert((await g.own.status()).admission.blocked);
 assert(!(await g.own.resumePreview()).canApply);assert(!(await g.own.retirementPreview()).canApply);g.exitProof();const q=await g.own.retirementPreview();assert(q.canApply);await g.own.retirementApply(confirm(q));assert.equal(g.starts(),0);assert.equal(g.activity.status().admission,'fenced');await g.own.status();assert.equal(g.starts(),0);
 const h=fixture(g.store,23);await h.boot();assert.equal(h.starts(),0);h.close();
 const done=await resume(g);assert.equal(g.starts(),1);assert.equal(done.receipt.state,'retired');assert.equal(done.admission.durable.state,'open');assert.equal(done.admission.durable.decision.kind,'resume');assert(!done.hostStopAuthorized&&!done.pluginSwitchAuthorized);g.close();
});
test('final release persistence precedes all deferred starts, even after component locks have reopened',async()=>{
 const f=fixture();await f.boot();await tick();await hold(f);let afterHold=0;f.activity.deferStartup('token_models',()=>afterHold++);
 const d=deferred(),entered=deferred();f.store.before(async p=>{if(p.payload.entries.at(-1).state==='released'){assert.equal(afterHold,0);assert.equal(f.coordinated.status().state,'open');entered.resolve();await d.promise;}});
 const work=release(f);await entered.promise;assert.equal(afterHold,0);assert.equal(f.activity.status().admission,'fenced');d.resolve();const result=await work;assert.equal(afterHold,1);assert.equal(result.admission.durable.decision.kind,'release');f.close();
});
test('lost release acknowledgement never opens current admission on status or provider rebind',async()=>{
 const f=fixture();await f.boot();await tick();await hold(f);let starts=0;f.activity.deferStartup('token_models',()=>starts++);f.store.after(p=>{if(p.payload.entries.at(-1).state==='released')throw Error('ACK_LOST');});
 await assert.rejects(release(f),/ACK_LOST/);assert.equal(f.store.get().payload.admission.state,'open');assert.equal(starts,0);await f.own.status();f.own.suspendAdmission();await f.boot();assert.equal(starts,0);assert((await f.own.status()).admission.blocked);
 f.store.after(null);await resume(f);assert.equal(starts,1);f.close();
});
test('record-only recovery of release does not authorize restart execution',async()=>{
 const f=fixture();await f.boot();await tick();await hold(f);f.store.before(p=>{if(p.payload.entries.at(-1).state==='released')throw Error('FINAL_WRITE_FAILED');});
 await assert.rejects(release(f),/FINAL_WRITE_FAILED/);assert.equal(f.coordinated.status().state,'open');assert.equal(f.store.get().payload.admission.state,'fenced');f.store.before(null);
 const p=await f.own.recoveryPreview();assert.equal(p.observedState,'released');await f.own.recover(confirm(p));assert.equal(f.store.get().payload.admission.state,'fenced');f.close();
 const g=fixture(f.store,22);await g.boot();assert.equal(g.starts(),0);await resume(g);assert.equal(g.starts(),1);g.close();
});
test('failed first intent retains local quarantine; separately confirmed resume can handle an empty ledger',async()=>{
 const f=fixture();await f.boot();await tick();f.store.before(()=>{throw Error('WRITE_FAILED');});await assert.rejects(hold(f),/WRITE_FAILED/);assert.equal(f.store.get(),null);assert.equal(f.activity.status().admission,'fenced');await assert.rejects(f.own.preview(),/RESUME_REQUIRED/);
 f.store.before(null);const p=await f.own.resumePreview();assert(p.canApply);assert.equal(p.operationId,null);await f.own.resumeApply(confirm(p));assert.equal(f.store.get().payload.entries.length,0);assert.equal(f.activity.status().admission,'open');f.close();
});
test('corrupt or unreadable ledger never starts, overwrites, or leaks raw record text',async()=>{
 for(const mode of ['corrupt','unreadable']){
  const f=fixture();if(mode==='corrupt')f.store.set({kind:'api-key',key:'SENSITIVE_MUST_NOT_LEAK'});else f.store.onRead(()=>{throw Error('IO_FAILURE');});const before=f.store.get();await assert.rejects(f.boot());assert.equal(f.starts(),0);assert.equal(f.activity.status().admission,'unavailable');assert.equal(f.store.writes(),0);assert.deepEqual(f.store.get(),before);assert(!JSON.stringify(f.activity.status()).includes('SENSITIVE'));f.close();
 }
});
test('late old bootstrap cannot open a replacement credential scope or a disposed owner',async()=>{
 const f=fixture(),d=deferred();f.store.onRead(()=>d.promise);const old=f.boot();f.own.suspendAdmission();const replacement=storage();replacement.onRead(()=>{throw Error('UNAVAILABLE');});f.replace(replacement.credentials);await assert.rejects(f.boot());d.resolve();await assert.rejects(old,/PROVIDER_CHANGED/);assert.equal(f.starts(),0);assert.equal(f.activity.status().admission,'unavailable');f.close();
 const g=fixture(),wait=deferred();g.store.onRead(()=>wait.promise);const pending=g.boot();g.close();wait.resolve();await assert.rejects(pending);assert.equal(g.starts(),0);
});
test('resume rechecks current ledger, counts and current instance; stale plans never reopen',async()=>{
 const f=fixture();await f.boot();await tick();await hold(f);f.close();const g=fixture(f.store,22);await g.boot();g.exitProof();await g.own.retirementApply(confirm(await g.own.retirementPreview()));const p=await g.own.resumePreview();
 const record=g.store.get();record.payload.revision++;g.store.set(record);await assert.rejects(g.own.resumeApply(confirm(p)),/OBSERVATION_CHANGED/);assert.equal(g.starts(),0);await resume(g);g.close();
});
test('legacy pending and retired schema2 receipts bootstrap closed without silently migrating storage',async()=>{
 const f=fixture();await f.boot();await tick();await hold(f);f.close();const original=f.store.get();original.payload.schema=2;delete original.payload.admission;
 for(const state of ['held','retired']){
  const r=structuredClone(original);if(state==='retired'){r.payload.entries[0].state='retired';r.payload.entries[0].retirement={byInstanceId:randomUUID(),reason:'absent',observedAt:1000,observer:owner(22),currentStart:null};}
  const store=storage();store.set(r);const g=fixture(store,23);await g.boot();assert.equal(g.starts(),0);assert.equal(g.activity.status().admission,'fenced');assert.equal(store.writes(),0);assert.deepEqual(store.get(),r);g.close();
 }
});
test('invalid durable open marker cannot bypass an unresolved maintenance receipt',async()=>{
 const f=fixture();await f.boot();await tick();await hold(f);f.close();const record=f.store.get();record.payload.admission.state='open';f.store.set(record);const g=fixture(f.store,22);await assert.rejects(g.boot(),/LEDGER_REVIEW/);assert.equal(g.starts(),0);g.close();
});
test('ordinary component controls cannot bypass boot quarantine, and returned data is not a Host shutdown grant',async()=>{
 const f=fixture();await assert.rejects(f.own.componentMutation(()=>{throw Error('BYPASS');}),/RESUME_REQUIRED/);await f.boot();await tick();const s=await f.own.status();assert.equal(s.admission.scope,'own_execution_startup_only');assert(s.admission.nativeExecutionUnverified);assert(!s.hostStopAuthorized&&!s.pluginSwitchAuthorized);f.close();
});
