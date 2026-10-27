import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOnboardingHandoff} from '../bundle/onboarding-handoff.js';
import {createOnboardingState} from '../bundle/onboarding-state.js';
import {createOnboardingService} from '../bundle/onboarding-host.js';
const secret='sk-SYNTHETIC_HANDOFF_ONLY_NOT_REAL',KEY='dsh-task-gateway/onboarding-cloud-handoff-v1';
function store(){const records=new Map();let n=0,tail=Promise.resolve();return {records,writes:()=>n,readRecord:async k=>structuredClone(records.get(k)),describeRecord:async()=>({writable:true}),modifyRecord(k,fn){const p=tail.then(()=>{const v=fn(structuredClone(records.get(k)));if(v!==undefined){records.set(k,structuredClone(v));n++;}});tail=p.catch(()=>{});return p;}};}
async function fixture({fencingSupported=true}={}){
 const c=store(),d=store(),runtime={credentials:c,home:'/isolated',env:{}},state=createOnboardingState({}, {},runtime),destination=createOnboardingState({}, {},{...runtime,credentials:d});let time=0,calls=[],lose=false,drop=false,drift=false;
 const target={operationId:randomUUID(),installationId:randomUUID(),runtimeId:randomUUID(),manifestHash:'a'.repeat(64),root:'/owned/isolated-runtime',role:'cloud',hostVersion:'0.2.1-rc.2'};
 const remote=async(action,a)=>{calls.push(action);const t=drift?{...target,runtimeId:randomUUID()}:target;if(action==='inspect'){const s=(await destination.secrets()).slots.find(s=>s.slot==='deepseek-local');return {target:t,slot:s.slot,revision:s.revision,configured:s.configured,...(fencingSupported?{fencingSupported:true}:{})};}if(drop)throw Error(secret);if(action==='fence'){await destination.fence({slot:'deepseek-local',operation:a.operation,expectedRevision:a.expectedRevision,confirm:true});if(lose)throw Error(secret);}if(action==='put'){await destination.put({slot:'deepseek-local',operation:a.operation,expectedRevision:a.expectedRevision,secret:a.secret,confirm:true});if(lose)throw Error(secret);}const s=await destination.secretReceipt({slot:'deepseek-local',operation:a.operation,expectedRevision:a.expectedRevision});return {target:t,slot:s.slot,revision:s.revision,configured:s.configured,operationMatched:s.operationMatched,...(fencingSupported?{fencingSupported:true}:{})};};
 const deps={state,credentials:()=>c,remote,enabled:()=>true,now:()=>time},handoff=createOnboardingHandoff(deps);
 return {c,d,state,destination,runtime,target,handoff,deps,calls,put:async(rev=0)=>state.put({slot:'deepseek-cloud',expectedRevision:rev,operation:randomUUID(),secret,confirm:true}),lose:()=>{lose=true;},online:()=>{drop=false;},drop:()=>{drop=true;},drift:()=>{drift=true;},advance:()=>{time+=300001;}};
}
const confirmation=p=>({id:p.id,fingerprint:p.fingerprint,confirm:true});
test('handoff initial status is cached metadata only; missing staged cloud key cannot preview',async()=>{const f=await fixture();assert.equal((await f.handoff.status({refresh:false})).state,'not_started');assert.equal(f.calls.length,0);await assert.rejects(f.handoff.preview({}),/SOURCE_REQUIRED/);assert.equal(f.c.writes(),0);});
test('handoff preview exposes no key or key hash, apply changes only target own slot',async()=>{const f=await fixture();await f.put();const n=f.c.writes(),p=await f.handoff.preview({});assert.equal(f.c.writes(),n);assert.equal(f.d.writes(),0);assert(!JSON.stringify(p).includes(secret));const r=await f.handoff.apply(confirmation(p));assert.equal(r.state,'delivered');assert.equal(r.enablesModel,false);assert.equal(r.verifiesModel,false);assert.equal((await f.destination.readManagedSecret('deepseek-local')).value,secret);assert.equal((await f.state.readManagedSecret('deepseek-local')).value,null);assert.equal(f.d.writes(),1);assert(!JSON.stringify([...f.c.records.entries()].filter(([k])=>k===KEY)).includes(secret));});
test('old confirmation replay never sends again, including after a process restart',async()=>{const f=await fixture();await f.put();const p=await f.handoff.preview({});await f.handoff.apply(confirmation(p));const resumed=createOnboardingHandoff(f.deps);const n=f.calls.length;assert((await resumed.apply(confirmation(p))).notResent);assert.equal(f.calls.length,n);assert.equal(f.d.writes(),1);});
test('lost success receipt is recovered after restart by query only, even when source key removed',async()=>{const f=await fixture();await f.put();const p=await f.handoff.preview({});f.lose();const r=await f.handoff.apply(confirmation(p));assert.equal(r.state,'needs_review');assert(!JSON.stringify(r).includes(secret));await f.state.remove({slot:'deepseek-cloud',expectedRevision:1,operation:randomUUID(),confirm:true});const resumed=createOnboardingHandoff(f.deps);assert.equal((await resumed.status({refresh:false})).state,'needs_review');assert.equal((await resumed.status({refresh:true})).state,'delivered');assert.equal(f.calls.filter(x=>x==='put').length,1);assert.equal(f.d.writes(),1);});
test('unknown non-delivery is not retried by status, preview or repeated confirmation',async()=>{const f=await fixture();await f.put();const p=await f.handoff.preview({});f.drop();await f.handoff.apply(confirmation(p));const r=await f.handoff.status({refresh:true});assert.equal(r.state,'needs_review');await assert.rejects(f.handoff.preview({}),/RECOVERY_REQUIRED/);await f.handoff.apply(confirmation(p));assert.equal(f.calls.filter(x=>x==='put').length,1);assert.equal(f.d.writes(),0);});
test('source rotation, expiry, missing confirmation and caller-supplied URL rejected',async()=>{const f=await fixture();await f.put();let p=await f.handoff.preview({});await assert.rejects(f.handoff.apply({...confirmation(p),confirm:false}),/CONFIRMATION_REQUIRED/);await f.put(1);await assert.rejects(f.handoff.apply(confirmation(p)),/SOURCE_CHANGED/);p=await f.handoff.preview({});f.advance();await assert.rejects(f.handoff.apply(confirmation(p)),/PLAN_EXPIRED/);await assert.rejects(f.handoff.preview({url:'https://exfil.example'}),/ARGUMENTS/);assert.equal(f.d.writes(),0);});
test('remote destination CAS rejects a concurrent credential change rather than overwrite',async()=>{const f=await fixture();await f.put();const p=await f.handoff.preview({});await f.destination.put({slot:'deepseek-local',expectedRevision:0,operation:randomUUID(),secret:'sk-SYNTHETIC_OTHER_WRITER',confirm:true});assert.equal((await f.handoff.apply(confirmation(p))).state,'needs_review');assert.equal((await f.destination.readManagedSecret('deepseek-local')).value,'sk-SYNTHETIC_OTHER_WRITER');assert.equal(f.d.writes(),1);});
test('different target receipt cannot claim delivery',async()=>{const f=await fixture();await f.put();const p=await f.handoff.preview({});f.drift();assert.equal((await f.handoff.apply(confirmation(p))).state,'needs_review');});
test('two panels cannot replace the first durable in-flight intent',async()=>{const f=await fixture();await f.put();const other=createOnboardingHandoff(f.deps),a=await f.handoff.preview({}),b=await other.preview({});await f.handoff.apply(confirmation(a));await assert.rejects(other.apply(confirmation(b)),/LEDGER_CONFLICT/);assert.equal(f.calls.filter(x=>x==='put').length,1);});
test('unowned or malformed handoff ledger remains untouched',async()=>{const f=await fixture();f.c.records.set(KEY,{kind:'api-key',key:'KEEP'});await assert.rejects(f.handoff.status({refresh:false}),/LEDGER_REVIEW/);assert.equal(f.c.records.get(KEY).key,'KEEP');});
test('secret receipt verifies exact operation and revision without disclosing value',async()=>{const f=await fixture(),id=randomUUID();await f.destination.put({slot:'deepseek-local',expectedRevision:0,operation:id,secret,confirm:true});const args={slot:'deepseek-local',operation:id,expectedRevision:0};const r=await f.destination.secretReceipt(args);assert(r.operationMatched&&!JSON.stringify(r).includes(secret));assert(!(await f.destination.secretReceipt({...args,expectedRevision:1})).operationMatched);assert(!(await f.destination.secretReceipt({...args,operation:randomUUID()})).operationMatched);await assert.rejects(f.destination.secretReceipt({...args,secret:true}),/INVALID_SECRET_REQUEST/);});
test('public onboarding RPC permits only constrained metadata receipt, not secret reads or raw host calls',async()=>{const f=await fixture(),rpc=createOnboardingService({}, {},f.runtime);assert((await rpc.call('describe',{})).capabilities.cloudCredentialReceipt);assert.equal((await rpc.call('handoff_status',{refresh:false})).state,'not_started');await assert.rejects(rpc.call('hostRequest',{}),/METHOD_DENIED/);await assert.rejects(rpc.call('readManagedSecret',{slot:'deepseek-cloud'}),/INVALID_ARGUMENTS|METHOD_DENIED/);});

test('matched operation without configured value remains unconfirmed with an explicit error',async()=>{const f=await fixture();await f.put();const p=await f.handoff.preview({});await f.handoff.apply(confirmation(p));const resumed=createOnboardingHandoff({...f.deps,remote:async()=>({target:f.target,slot:'deepseek-local',revision:1,configured:false,operationMatched:true})});const r=await resumed.status({refresh:true});assert.equal(r.state,'needs_review');assert.equal(r.error,'ONBOARDING_HANDOFF_NOT_CONFIRMED');});

async function pending(f){await f.put();const p=await f.handoff.preview({});f.drop();await f.handoff.apply(confirmation(p));f.online();return p;}
test('explicit closure fences an undelivered send without a Key, then permits a fresh preview',async()=>{
 const f=await fixture(),old=await pending(f),n=f.d.writes(),p=await f.handoff.recoveryPreview({});
 assert.equal(p.mode,'fence');assert.equal(f.d.writes(),n);assert(!JSON.stringify(p).includes(secret));
 const r=await f.handoff.recoveryApply(confirmation(p));assert.equal(r.state,'closed');assert.equal(r.freshness,'remote_checked');
 assert.deepEqual(await f.destination.readManagedSecret('deepseek-local'),{revision:1,value:null});
 await assert.rejects(f.destination.put({slot:'deepseek-local',expectedRevision:0,operation:old.id,secret,confirm:true}),/SECRET_CONFLICT/);
 assert((await f.handoff.apply(confirmation(old))).notResent);assert((await f.handoff.recoveryApply(confirmation(p))).notResent);
 const count=f.calls.length;assert.equal((await f.handoff.status({refresh:true})).state,'closed');assert.equal(f.calls.length,count);
 const fresh=await f.handoff.preview({});assert.equal(fresh.destinationRevision,1);assert.notEqual(fresh.id,old.id);
 assert.equal(f.calls.filter(x=>x==='put').length,1);
});
test('barrier preserves an existing value, works on an empty slot, and uses bounded idempotent CAS',async()=>{
 const f=await fixture();let a={slot:'deepseek-local',operation:randomUUID(),expectedRevision:0,confirm:true};await f.destination.fence(a);await f.destination.fence(a);assert.equal(f.d.writes(),1);
 await f.destination.put({...a,operation:randomUUID(),expectedRevision:1,secret});a={...a,operation:randomUUID(),expectedRevision:2};await f.destination.fence(a);await f.destination.fence(a);
 assert.deepEqual(await f.destination.readManagedSecret('deepseek-local'),{revision:3,value:secret});
 for(const x of [{...a,slot:'token-plan-cloud'},{...a,secret},{...a,confirm:false},{...a,expectedRevision:Number.MAX_SAFE_INTEGER}])await assert.rejects(f.destination.fence(x),/INVALID_SECRET_REQUEST/);
 await assert.rejects(f.destination.fence({...a,operation:randomUUID()}),/SECRET_CONFLICT/);
});
test('legacy capability1 may close after destination revision advanced; never invokes a legacy fence',async()=>{
 const f=await fixture({fencingSupported:false});await pending(f);
 await f.destination.put({slot:'deepseek-local',expectedRevision:0,operation:randomUUID(),secret:'sk-KEEP_NEW_OWNER_VALUE',confirm:true});
 const p=await f.handoff.recoveryPreview({});assert.equal(p.mode,'already_advanced');assert.equal((await f.handoff.recoveryApply(confirmation(p))).state,'closed');
 assert(!f.calls.includes('fence'));assert.equal((await f.destination.readManagedSecret('deepseek-local')).value,'sk-KEEP_NEW_OWNER_VALUE');
});
test('legacy target with unchanged revision stays pending; no controller or destination write',async()=>{const f=await fixture({fencingSupported:false});await pending(f);await assert.rejects(f.handoff.recoveryPreview({}),/FENCE_UNSUPPORTED/);assert.equal(f.d.writes(),0);assert.equal((await f.handoff.status({refresh:false})).state,'needs_review');});
test('offline, changed target, reversed revision and invalid capability cannot authorize recovery',async()=>{
 for(const kind of ['offline','target','rollback','capability']){
  const f=await fixture();if(kind==='rollback')await f.destination.fence({slot:'deepseek-local',operation:randomUUID(),expectedRevision:0,confirm:true});await pending(f);
  const base=f.deps.remote,g=createOnboardingHandoff({...f.deps,remote:async(a,p)=>{if(kind==='offline')throw Error('offline');const r=await base(a,p);return kind==='target'?{...r,target:{...r.target,root:'/different'}}:kind==='rollback'?{...r,revision:0}:{...r,fencingSupported:'true'};}});
  await assert.rejects(g.recoveryPreview({}),/offline|RECEIPT_REVIEW/);assert(!f.calls.includes('fence'));
 }
});
test('expired, changed or competing recovery plans cannot consume confirmation',async()=>{
 const f=await fixture();await pending(f);let p=await f.handoff.recoveryPreview({});await assert.rejects(f.handoff.recoveryApply({...confirmation(p),confirm:false}),/CONFIRMATION_REQUIRED/);
 f.advance();await assert.rejects(f.handoff.recoveryApply(confirmation(p)),/PLAN_EXPIRED/);p=await f.handoff.recoveryPreview({});
 await f.destination.fence({slot:'deepseek-local',operation:randomUUID(),expectedRevision:0,confirm:true});await assert.rejects(f.handoff.recoveryApply(confirmation(p)),/RECOVERY_CHANGED/);
 const other=createOnboardingHandoff(f.deps),q=await other.recoveryPreview({});p=await f.handoff.recoveryPreview({});await other.recoveryApply(confirmation(q));await assert.rejects(f.handoff.recoveryApply(confirmation(p)),/LEDGER_CONFLICT/);
});
test('lost fence receipt followed by restart recovers from read-only revision evidence; never fences again',async()=>{
 const f=await fixture();await pending(f);let failed=false;
 const deps={...f.deps,remote:async(a,p)=>{if(failed)throw Error('offline');const r=await f.deps.remote(a,p);if(a==='fence'){failed=true;throw Error('lost');}return r;}};
 const g=createOnboardingHandoff(deps),p=await g.recoveryPreview({});assert.equal((await g.recoveryApply(confirmation(p))).state,'needs_review');assert.equal(f.d.writes(),1);
 const restarted=createOnboardingHandoff(f.deps);assert((await restarted.recoveryApply(confirmation(p))).notResent);assert.equal((await restarted.status({refresh:true})).state,'closed');assert.equal(f.calls.filter(x=>x==='fence').length,1);
});
test('if original send wins the race before fence, reconcile reports delivery rather than false closure',async()=>{
 const f=await fixture(),old=await pending(f);const g=createOnboardingHandoff({...f.deps,remote:async(a,p)=>{
  if(a==='fence')await f.destination.put({slot:'deepseek-local',expectedRevision:0,operation:old.id,secret,confirm:true});return f.deps.remote(a,p);
 }}),p=await g.recoveryPreview({});const r=await g.recoveryApply(confirmation(p));assert.equal(r.state,'delivered');assert.equal((await f.destination.readManagedSecret('deepseek-local')).value,secret);assert.equal(f.d.writes(),1);
});
test('late original success between recovery preview and confirmation requires a status query, not a fence',async()=>{
 const f=await fixture(),old=await pending(f),p=await f.handoff.recoveryPreview({});await f.destination.put({slot:'deepseek-local',expectedRevision:0,operation:old.id,secret,confirm:true});
 await assert.rejects(f.handoff.recoveryApply(confirmation(p)),/ALREADY_DELIVERED/);assert(!f.calls.includes('fence'));assert.equal((await f.handoff.status({refresh:true})).state,'delivered');
});
test('recovery after credentials were explicitly removed closes historical send, not the new slot',async()=>{
 const f=await fixture();await f.put();const p=await f.handoff.preview({});await f.handoff.apply(confirmation(p));await f.destination.remove({slot:'deepseek-local',expectedRevision:1,operation:randomUUID(),confirm:true});
 assert.equal((await f.handoff.status({refresh:true})).state,'needs_review');const q=await f.handoff.recoveryPreview({});assert.equal(q.mode,'already_advanced');assert.equal((await f.handoff.recoveryApply(confirmation(q))).state,'closed');assert.equal(f.d.writes(),2);
 assert.equal((await f.state.secrets()).slots[0].transferState,'see_handoff_ledger');
});
test('forged closed ledger without explicit recovery metadata is rejected',async()=>{const f=await fixture();await pending(f);const r=f.c.records.get(KEY);r.payload.phase='closed';f.c.records.set(KEY,r);await assert.rejects(f.handoff.status({refresh:false}),/LEDGER_REVIEW/);});
