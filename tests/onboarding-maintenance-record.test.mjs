import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOnboardingMaintenanceRecord} from '../bundle/onboarding-maintenance-record.js';
import {createOnboardingCoordinatedHold} from '../bundle/onboarding-coordinated-hold.js';
import {createOnboardingActivity} from '../bundle/onboarding-activity.js';
import {createOnboardingAgentHold} from '../bundle/onboarding-agent-hold.js';
import {createGatewayMaintenance} from '../bundle/gateway-maintenance.js';
import {createOnboardingService} from '../bundle/onboarding-host.js';
const KEY='dsh-task-gateway/onboarding-maintenance-record-v1';
const confirm=p=>({id:p.id,fingerprint:p.fingerprint,confirm:true});
function storage(){
 const records=new Map(),readKeys=[];let writes=0,tail=Promise.resolve(),before=null,after=null;
 const credentials={async readRecord(k){readKeys.push(k);return structuredClone(records.get(k));},async describeRecord(){return {writable:true};},modifyRecord(k,fn){const p=tail.then(async()=>{const next=await fn(structuredClone(records.get(k)));if(next!==undefined){await before?.(next);records.set(k,structuredClone(next));writes++;await after?.(next);}});tail=p.catch(()=>{});return p;}};
 return {credentials,records,readKeys,writes:()=>writes,setBefore:f=>{before=f;},setAfter:f=>{after=f;}};
}
function fixture(store=storage(),proof={}){
 let time=1000;
 const g={instanceId:randomUUID(),deliveries:new Map()},activity=createOnboardingActivity(),gateway=createGatewayMaintenance(g),agentHold=createOnboardingAgentHold({agents:{list:()=>[]},on:()=>()=>{}});
 const coordinated=createOnboardingCoordinatedHold({components:()=>({onboarding:activity,gateway,agents:agentHold,gatewayExpected:true,imPresent:true}),now:()=>time});
 let provider=store.credentials,acquires=0,releases=0;const apply=coordinated.apply,release=coordinated.release;
 coordinated.apply=a=>{acquires++;assert.equal(store.records.get(KEY)?.payload.entries.at(-1).state,'acquire_intent');return apply(a);};
 coordinated.release=a=>{releases++;assert.equal(store.records.get(KEY)?.payload.entries.at(-1).state,'release_intent');return release(a);};
 const processIdentity={capture:async()=>null,observe:async()=>({state:'unknown',reason:'identity_missing',observer:null,currentStart:null,observedAt:time}),...proof};
 const own=createOnboardingMaintenanceRecord({coordinated,activity,credentials:()=>provider,now:()=>time,processIdentity});
 return {...store,store,g,activity,gateway,agentHold,coordinated,own,advance:n=>{time+=n;},switchProvider:c=>{provider=c;},calls:()=>({acquires,releases})};
}
const hold=async f=>f.own.apply(confirm(await f.own.preview()));
const unlock=async f=>f.own.releaseApply(confirm(await f.own.releasePreview()));
const onceState=(state,error)=>{let once=true;return record=>{if(once&&record.payload.entries.at(-1).state===state){once=false;throw Error(error);}};};
test('durable intent precedes every component action; history retained; all approvals remain component scoped',async()=>{
 const f=fixture();assert.equal((await f.own.status()).state,'open');assert.equal(f.writes(),0);const h=await hold(f);assert.equal(h.state,'held');assert.equal(h.receipt.state,'held');assert(!h.hostStopAuthorized&&!h.pluginSwitchAuthorized&&!h.leaseRestored&&!h.operationInFlight);assert.equal(h.scope,'coordinated_components_only');assert.equal(h.historyCount,1);
 const r=await unlock(f);assert.equal(r.receipt.state,'released');assert.equal(r.state,'open');assert.deepEqual(f.calls(),{acquires:1,releases:1});const second=await hold(f);assert.equal(second.historyCount,2);assert.equal(f.records.get(KEY).payload.entries[0].state,'released');await unlock(f);assert(f.readKeys.every(k=>k===KEY));
});
test('first intent write rejection cannot dispatch acquisition and does not automatically retry',async()=>{
 const f=fixture(),p=await f.own.preview();f.setBefore(onceState('acquire_intent','IO_BEFORE'));await assert.rejects(f.own.apply(confirm(p)),/IO_BEFORE/);assert.equal(f.calls().acquires,0);assert.equal((await f.own.status()).state,'open');await assert.rejects(f.own.apply(confirm(p)),/PLAN_EXPIRED/);assert.equal(f.calls().acquires,0);
});
test('lost first write acknowledgement retains intent, duplicate never dispatches; explicit observation can record not held',async()=>{
 const f=fixture(),p=await f.own.preview();f.setAfter(onceState('acquire_intent','IO_AFTER'));await assert.rejects(f.own.apply(confirm(p)),/IO_AFTER/);assert.equal(f.calls().acquires,0);assert.equal((await f.own.status()).receipt.state,'acquire_intent');assert((await f.own.apply(confirm(p))).notResent);assert.equal(f.calls().acquires,0);
 const q=await f.own.recoveryPreview();assert.equal(q.observedState,'not_held');const r=await f.own.recover(confirm(q));assert.equal(r.componentActions,0);assert.equal(r.receipt.state,'not_held');assert.equal(f.calls().acquires,0);
});
test('acquired lease with failed final record stays blocked until explicit zero-action reconciliation',async()=>{
 const f=fixture();f.setBefore(onceState('held','IO_FINAL'));await assert.rejects(hold(f),/IO_FINAL/);assert.equal(f.coordinated.status().state,'held');assert.equal((await f.own.status()).state,'needs_review');await assert.rejects(f.own.preview(),/RECOVERY_REQUIRED/);await assert.rejects(f.own.componentMutation(()=>{throw Error('MUST_NOT_RUN');}),/SESSION_ACTIVE/);
 const q=await f.own.recoveryPreview();assert.equal(q.observedState,'held');const r=await f.own.recover(confirm(q));assert.equal(r.state,'held');assert.equal(f.calls().acquires,1);await unlock(f);
});
test('durable final write with lost acknowledgement is observed without another component acquisition',async()=>{
 const f=fixture(),p=await f.own.preview();f.setAfter(onceState('held','ACK_LOST'));await assert.rejects(f.own.apply(confirm(p)),/ACK_LOST/);const status=await f.own.status();assert.equal(status.state,'held');const w=f.writes();assert((await f.own.apply(confirm(p))).notResent);assert.equal(f.writes(),w);assert.equal(f.calls().acquires,1);await unlock(f);
});
test('release intent acknowledgement loss does not release; record observation and fresh release require separate confirmations',async()=>{
 const f=fixture();await hold(f);const p=await f.own.releasePreview();f.setAfter(onceState('release_intent','RELEASE_ACK'));await assert.rejects(f.own.releaseApply(confirm(p)),/RELEASE_ACK/);assert.equal(f.calls().releases,0);assert.equal((await f.own.status()).receipt.state,'release_intent');await assert.rejects(f.own.releaseApply(confirm(p)),/PLAN_EXPIRED/);
 const q=await f.own.recoveryPreview();assert.equal(q.observedState,'held');await f.own.recover(confirm(q));assert.equal(f.calls().releases,0);await unlock(f);assert.equal(f.calls().releases,1);
});
test('released components with missing final receipt reconcile only the ledger, not another release',async()=>{
 const f=fixture();await hold(f);f.setBefore(onceState('released','FINAL_RELEASE'));await assert.rejects(unlock(f),/FINAL_RELEASE/);assert.equal(f.coordinated.status().state,'open');assert.equal((await f.own.status()).receipt.state,'release_intent');const q=await f.own.recoveryPreview();assert.equal(q.observedState,'released');await f.own.recover(confirm(q));assert.equal(f.calls().releases,1);
});
test('new instance shows interrupted record, does not restore lease or clear old owner',async()=>{
 const f=fixture(),p=await f.own.preview();await f.own.apply(confirm(p));const g=fixture(f.store),status=await g.own.status();assert.equal(status.state,'interrupted');assert(status.executionMayHaveResumed);assert(!status.leaseRestored&&!status.hostStopAuthorized);assert.equal(g.coordinated.status().state,'open');const q=await g.own.recoveryPreview();assert(!q.canApply);const w=f.writes();await assert.rejects(g.own.recover(confirm(q)),/OBSERVATION_CHANGED/);await assert.rejects(g.own.releasePreview(),/INSTANCE_CHANGED/);await assert.rejects(g.own.preview(),/RECOVERY_REQUIRED/);assert((await g.own.apply(confirm(p))).notResent);assert.equal(f.writes(),w);assert.deepEqual(g.calls(),{acquires:0,releases:0});await unlock(f);
});
test('unresolved prior instance also prevents raw component mutation, but never pauses tasks just on status reads',async()=>{
 const f=fixture();await hold(f);const g=fixture(f.store);await assert.rejects(g.own.componentMutation(()=>g.coordinated.preview()),/SESSION_ACTIVE/);const before=f.writes();await g.own.status();await g.own.status();assert.equal(f.writes(),before);assert.equal(g.coordinated.status().state,'open');await unlock(f);
});
test('concurrent controllers use CAS; only one intent can acquire, no overwrite of first ownership',async()=>{
 const f=fixture(),g=fixture(f.store),p=await f.own.preview(),q=await g.own.preview();const results=await Promise.allSettled([f.own.apply(confirm(p)),g.own.apply(confirm(q))]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(f.calls().acquires+g.calls().acquires,1);assert.equal(f.records.get(KEY).payload.entries.length,1);await unlock(f.calls().acquires?f:g);
});
test('busy serial operation prevents a legacy mutation sneaking between ledger check and acquisition',async()=>{
 const f=fixture(),p=await f.own.preview();let entered,unblock;const waiting=new Promise(r=>entered=r),resume=new Promise(r=>unblock=r);f.setBefore(async record=>{if(record.payload.entries.at(-1).state==='acquire_intent'){entered();await resume;}});const work=f.own.apply(confirm(p));await waiting;await assert.rejects(f.own.componentMutation(()=>{throw Error('MUST_NOT_RUN');}),/BUSY/);unblock();await work;await unlock(f);
});
test('foreign or malformed ledger is preserved without echoing its contents',async()=>{
 const f=fixture();f.records.set(KEY,{kind:'api-key',key:'SECRET_MUST_NOT_LEAK'});const before=structuredClone(f.records.get(KEY));await assert.rejects(f.own.status(),e=>e.message==='ONBOARDING_MAINTENANCE_RECORD_LEDGER_REVIEW');await assert.rejects(f.own.preview(),/LEDGER_REVIEW/);assert.deepEqual(f.records.get(KEY),before);assert.equal(f.writes(),0);assert.equal(f.calls().acquires,0);
});
test('provider replacement cannot hide a held original record or authorize raw release',async()=>{
 const f=fixture();await hold(f);f.switchProvider(storage().credentials);await assert.rejects(f.own.status(),/LEDGER_CHANGED/);await assert.rejects(f.own.componentMutation(()=>f.coordinated.release({})),/LEDGER_CHANGED/);assert.equal(f.calls().releases,0);f.switchProvider(f.credentials);await unlock(f);
});
test('changed, expired or invalid confirmation plans do not modify ledger or components',async()=>{
 const f=fixture(),p=await f.own.preview();await assert.rejects(f.own.apply({...confirm(p),confirm:false}),/CONFIRMATION/);await assert.rejects(f.own.apply({...confirm(p),fingerprint:'bad'}),/PLAN_EXPIRED/);f.advance(400000);await assert.rejects(f.own.apply(confirm(p)),/PLAN_EXPIRED/);assert.equal(f.writes(),0);assert.equal(f.calls().acquires,0);
});
test('bounded history never silently deletes receipts when full',async()=>{
 const f=fixture();await hold(f);await unlock(f);const root=f.records.get(KEY),row=root.payload.entries[0];root.payload.entries=[row,...Array.from({length:127},()=>({...row,id:randomUUID()}))];root.payload.revision=256;root.payload.admission.operationId=root.payload.entries.at(-1).id;const before=structuredClone(root);f.records.set(KEY,root);await assert.rejects(f.own.preview(),/HISTORY_FULL/);assert.deepEqual(f.records.get(KEY),before);
});
test('real onboarding RPC exposes durable flow and prevents legacy bypass without affecting ordinary detection',async()=>{
 const s=storage(),activity=createOnboardingActivity(),agents=createOnboardingAgentHold({agents:{list:()=>[]},on:()=>()=>{}}),svc=createOnboardingService({}, {},{activity,agentHold:agents,credentials:s.credentials,home:'/isolated-empty-fixture',env:{PATH:''}});
 assert.equal((await svc.call('describe',{})).capabilities.maintenanceRecordContract,2);assert.equal((await svc.call('detect',{})).checks.writes,0);
 const p=await svc.call('maintenance_record_preview',{}),h=await svc.call('maintenance_record_apply',confirm(p));assert.equal(h.state,'held');await assert.rejects(svc.call('coordinated_hold_release',{}),/SESSION_ACTIVE/);await assert.rejects(svc.call('agent_hold_release',{}),/SESSION_ACTIVE/);await assert.rejects(svc.call('detect',{}),/HELD/);
 const q=await svc.call('maintenance_record_releasePreview',{});assert.equal((await svc.call('maintenance_record_releaseApply',confirm(q))).receipt.state,'released');assert.equal((await svc.call('detect',{})).checks.writes,0);await svc.dispose();
});
test('component acquisition failure is recorded as not held without cancelling existing work',async()=>{
 const f=fixture(),p=await f.own.preview(),done=f.gateway.enter('existing');const result=await f.own.apply(confirm(p));assert(result.acquisitionFailed);assert.equal(result.receipt.state,'not_held');assert.equal(f.gateway.status().counts.requests,1);done();
});
test('in-memory live ownership rejects a changed immutable plan identity even with the same operation id',async()=>{
 const f=fixture();await hold(f);const original=structuredClone(f.records.get(KEY)),altered=structuredClone(original);altered.payload.entries[0].planHash='f'.repeat(64);f.records.set(KEY,altered);await assert.rejects(f.own.releasePreview(),/LEDGER_CHANGED/);assert.equal(f.calls().releases,0);f.records.set(KEY,original);await unlock(f);
});
test('closure evidence changes invalidate an earlier release preview without rewriting the original record',async()=>{
 const f=fixture();await hold(f);f.g.closed=true;const p=await f.own.releasePreview(),before=await f.own.status();
 f.gateway.completeClosure(()=>{},true);const verified=await f.own.status();assert.equal(verified.live.originalComponents.gateway.state,'closed');
 await assert.rejects(f.own.releaseApply(confirm(p)),/OBSERVATION_CHANGED/);assert.equal((await f.own.status()).revision,before.revision);assert.equal(f.calls().releases,0);assert.equal(f.activity.status().state,'held');
 const result=await unlock(f);assert.equal(result.receipt.state,'released');assert.equal(result.state,'open');assert.equal(f.calls().releases,1);
});
const ownerAt=pid=>({platform:'linux',host:'a'.repeat(64),namespace:'pid:[321]',boot:'11111111-1111-1111-1111-111111111111',pid,start:String(pid*100)});
function ownerProof(pid){let state='alive',reason='same_process',start=null,observer=ownerAt(pid);return {capture:async()=>ownerAt(pid),observe:async old=>old?{state,reason,observer,currentStart:start,observedAt:1000}:{state:'unknown',reason:'identity_missing',observer:null,currentStart:null,observedAt:1000},set:(s,r,c=null,o=ownerAt(pid))=>{state=s;reason=r;start=c;observer=o;}};}
test('proven old process exit permits ledger-only retirement, then a new separately approved maintenance operation',async()=>{
 const oldProof=ownerProof(17),f=fixture(storage(),oldProof);await hold(f);const original=structuredClone(f.records.get(KEY).payload.entries[0]);f.coordinated.dispose();const proof=ownerProof(22);proof.set('exited','absent');const g=fixture(f.store,proof),p=await g.own.retirementPreview();assert(p.canApply);const r=await g.own.retirementApply(confirm(p));assert.equal(r.receipt.state,'retired');assert.equal(r.componentActions,0);assert.equal(r.signals,0);assert.equal(r.receipt.ownerProcess.pid,17);assert.equal(r.receipt.retirement.observer.pid,22);assert.equal(r.receipt.planHash,original.planHash);assert.deepEqual(g.calls(),{acquires:0,releases:0});await g.own.resumeApply(confirm(await g.own.resumePreview()));await hold(g);assert.equal((await g.own.status()).historyCount,2);await unlock(g);
});
test('live owner, unknown proof, different machine and current instance cannot be retired',async()=>{
 const f=fixture(storage(),ownerProof(17));await hold(f);const proof=ownerProof(22),g=fixture(f.store,proof);for(const [s,r,c,o] of [['alive','same_process','1700'],['unknown','process_unavailable',null],['exited','absent',null,{...ownerAt(22),host:'b'.repeat(64)}]]){proof.set(s,r,c,o);const p=await g.own.retirementPreview();assert(!p.canApply);await assert.rejects(g.own.retirementApply(confirm(p)),/OBSERVATION_CHANGED/);}
 const own=await f.own.retirementPreview();assert(!own.canApply);assert.equal(own.reason,'current_instance');await unlock(f);
});
test('retirement rechecks process evidence and revision immediately before the write',async()=>{
 const f=fixture(storage(),ownerProof(17));await hold(f);const proof=ownerProof(22);proof.set('exited','absent');const g=fixture(f.store,proof),p=await g.own.retirementPreview(),w=f.writes();proof.set('alive','same_process','1700');await assert.rejects(g.own.retirementApply(confirm(p)),/OBSERVATION_CHANGED/);assert.equal(f.writes(),w);assert.equal(f.records.get(KEY).payload.entries[0].state,'held');await unlock(f);
});
test('terminal records retain retirement proof; corrupted proof is rejected rather than reused as an approval',async()=>{
 const f=fixture(storage(),ownerProof(17));await hold(f);f.coordinated.dispose();const proof=ownerProof(22);proof.set('exited','pid_reused','9000');const g=fixture(f.store,proof);await g.own.retirementApply(confirm(await g.own.retirementPreview()));const p=f.records.get(KEY);p.payload.entries[0].retirement.observer.host='b'.repeat(64);f.records.set(KEY,p);await assert.rejects(g.own.status(),/LEDGER_REVIEW/);
});
test('legacy schema 1 pending record has no inferred process identity; terminal legacy metadata migrates without rewriting history',async()=>{
 const f=fixture();await hold(f);const record=f.records.get(KEY);record.payload.schema=1;delete record.payload.admission;for(const e of record.payload.entries){delete e.ownerProcess;delete e.retirement;}f.records.set(KEY,record);const g=fixture(f.store,ownerProof(22));const p=await g.own.retirementPreview();assert(!p.canApply);assert.equal(p.reason,'identity_missing');const before=structuredClone(f.records.get(KEY));await assert.rejects(g.own.retirementApply(confirm(p)),/OBSERVATION_CHANGED/);assert.deepEqual(f.records.get(KEY),before);
 // A separately supplied historical terminal fixture tests append migration, not a product repair of the unresolved row.
 const terminalStore=storage(),terminalRecord=structuredClone(before);terminalRecord.payload.entries[0].state='released';terminalStore.records.set(KEY,terminalRecord);const h=fixture(terminalStore,ownerProof(33));await hold(h);const stored=terminalStore.records.get(KEY);assert.equal(stored.payload.schema,3);assert.deepEqual(stored.payload.entries[0],{...terminalRecord.payload.entries[0],ownerProcess:null,retirement:null});await unlock(h);
});
test('retirement acknowledgement loss is observed without new process actions or repeated retirement writes',async()=>{
 const f=fixture(storage(),ownerProof(17));await hold(f);f.coordinated.dispose();const proof=ownerProof(22);proof.set('exited','absent');const g=fixture(f.store,proof),p=await g.own.retirementPreview();g.setAfter(onceState('retired','ACK_AFTER_RETIRE'));await assert.rejects(g.own.retirementApply(confirm(p)),/ACK_AFTER_RETIRE/);const w=g.writes();assert.equal((await g.own.status()).receipt.state,'retired');await assert.rejects(g.own.retirementApply(confirm(p)),/PLAN_EXPIRED/);assert.equal(g.writes(),w);assert.deepEqual(g.calls(),{acquires:0,releases:0});
});
test('retirement plan binds immutable prior-owner identity, not only revision and operation id',async()=>{
 const f=fixture(storage(),ownerProof(17));await hold(f);const proof=ownerProof(22);proof.set('exited','absent');const g=fixture(f.store,proof),p=await g.own.retirementPreview(),original=structuredClone(f.records.get(KEY));const changed=structuredClone(original);changed.payload.entries[0].ownerProcess.pid=999;f.records.set(KEY,changed);await assert.rejects(g.own.retirementApply(confirm(p)),/OBSERVATION_CHANGED/);f.records.set(KEY,original);await unlock(f);
});
test('read-only query finds an older operation without replacing the current record or writing history',async()=>{
 const f=fixture(),first=await hold(f);await unlock(f);const second=await hold(f),writes=f.writes(),calls=f.calls();
 const s=await f.own.status({operationId:first.receipt.id});assert.equal(s.requestedOperationId,first.receipt.id);assert.equal(s.requestedReceipt.state,'released');assert.equal(s.receipt.id,second.receipt.id);assert.equal(s.state,'held');assert.equal(f.writes(),writes);assert.deepEqual(f.calls(),calls);
 assert.equal((await f.own.status({operationId:randomUUID()})).requestedReceipt,null);
 for(const args of [{operationId:'arbitrary-path'},{operationId:first.receipt.id,confirm:true},{id:first.receipt.id}])await assert.rejects(f.own.status(args),/ARGUMENTS/);
 await unlock(f);
});
