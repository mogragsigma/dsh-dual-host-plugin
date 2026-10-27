import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createOnboardingCloudTaskRuntime} from '../bundle/onboarding-cloud-task-runtime.js';
import {createOnboardingTaskRuntime} from '../bundle/onboarding-task-runtime.js';
import {cloudTaskRuntimeStatus} from '../bundle/onboarding-task-runtime-contract.js';
const confirm=p=>({id:p.id,fingerprint:p.fingerprint,confirm:true});
function credentials(){const records=new Map();let writes=0;return {records,readRecord:async k=>structuredClone(records.get(k)),modifyRecord:async(k,fn)=>{const v=fn(structuredClone(records.get(k)));if(v!==undefined){records.set(k,structuredClone(v));writes++;}},writes:()=>writes};}
function fixture(t){
 const local=credentials(),cloud=credentials(),state={available:()=>true},calls=[];let mode='normal',time=1700000000000,savedApply,mutation=null;
 const target={operationId:randomUUID(),installationId:randomUUID(),runtimeId:randomUUID(),manifestHash:'a'.repeat(64),root:'/root/.local/share/dsh-dual-host/instances/host-'+randomUUID(),role:'cloud',hostVersion:'0.2.1-rc.2'};target.root='/root/.local/share/dsh-dual-host/instances/host-'+target.installationId;
 const adapter={async open(p){let active=true;return {id:p.id,instanceId:randomUUID(),workerEnabled:p.workerEnabled===true,hold(){},port:12345,active:()=>active,quiescent:async()=>{},close:async()=>{active=false;}};}};
 const managerDeps={state,credentials:()=>cloud,config:{onboarding:{role:'cloud'}},adapter,platform:'linux',now:()=>time};let manager=createOnboardingTaskRuntime(managerDeps);t.after(()=>manager.close());
 const remote=async(method,args)=>{
  calls.push(method);if(mode==='offline')throw Error('OFFLINE');const action=method.slice(13);assert(method.startsWith('task_runtime_'));const {targetHash,...input}=args;
  if(action==='apply'){savedApply=input;if(mode==='unsent')throw Error('DISCONNECTED');}
  if(action==='fence'&&mode==='late'){await manager.apply(savedApply);}
  const value=await manager[action](input);if(action==='apply'&&mode==='lost')throw Error('LOST');const r={target,value};return mutation?mutation(r):r;
 };
 const deps={state,credentials:()=>local,remote,enabled:()=>true,now:()=>time},client=createOnboardingCloudTaskRuntime(deps);
 return {local,cloud,client,deps,calls,target,setMode:v=>mode=v,setMutation:v=>mutation=v,advance:n=>time+=n,manager:()=>manager,restart:async()=>{await manager.close();manager=createOnboardingTaskRuntime(managerDeps);await manager.start();},lateApply:()=>manager.apply(savedApply)};
}
test('mount reads only local ledger; preview is nonmutating and explicit apply enables only intake',async t=>{
 const f=fixture(t);assert.equal((await f.client.status({refresh:false})).operation.state,'not_started');assert.equal(f.calls.length,0);const p=await f.client.preview({enabled:true});assert.equal(f.local.writes()+f.cloud.writes(),0);assert.equal(p.target.platform,'linux');const r=await f.client.apply(confirm(p));assert.equal(r.operation.state,'applied');assert(r.runtime.configured);assert(!r.runtime.workerEnabled&&!r.runtime.peerEnabled&&!r.runtime.writeAuthorized);assert.equal(f.cloud.writes(),1);assert(!JSON.stringify([...f.local.records.values()]).includes('Token'));
});
test('lost reply across both restarts reconciles original grant, never resends',async t=>{
 const f=fixture(t),p=await f.client.preview({enabled:true});f.setMode('lost');assert.equal((await f.client.apply(confirm(p))).operation.state,'needs_review');await f.restart();f.setMode('normal');const m=createOnboardingCloudTaskRuntime(f.deps),n=f.calls.length;assert.equal((await m.status({refresh:false})).operation.state,'needs_review');assert.equal(f.calls.length,n);const r=await m.status({refresh:true});assert.equal(r.operation.state,'applied');assert(r.runtime.configured);assert((await m.apply(confirm(p))).notResent);assert.equal(f.calls.filter(x=>x==='task_runtime_apply').length,1);assert.equal(f.cloud.writes(),1);
});
test('unknown unreceived enable is fenced without starting runtime; delayed apply rejected',async t=>{
 const f=fixture(t),p=await f.client.preview({enabled:true});f.setMode('unsent');await f.client.apply(confirm(p));await assert.rejects(f.client.preview({enabled:false}),/RECOVERY_REQUIRED/);f.setMode('normal');const q=await f.client.recoveryPreview({});assert(q.preservesAuthorization);const r=await f.client.recoveryApply(confirm(q));assert.equal(r.operation.state,'closed');assert(!r.runtime.desiredEnabled&&!r.runtime.configured);await assert.rejects(f.lateApply(),/CONFLICT/);assert((await f.client.recoveryApply(confirm(q))).notResent);assert.equal(f.cloud.writes(),1);
});
test('fence preserves an enabled runtime and does not silently treat closure as disable',async t=>{
 const f=fixture(t);let p=await f.client.preview({enabled:true});const first=await f.client.apply(confirm(p));p=await f.client.preview({enabled:false});f.setMode('unsent');await f.client.apply(confirm(p));f.setMode('normal');const q=await f.client.recoveryPreview({}),r=await f.client.recoveryApply(confirm(q));assert.equal(r.operation.state,'closed');assert(r.runtime.configured&&r.runtime.desiredEnabled);assert.equal(r.runtime.instanceId,first.runtime.instanceId);await assert.rejects(f.lateApply(),/CONFLICT/);
});
test('original apply winning fence CAS is reported applied rather than revoked',async t=>{
 const f=fixture(t),p=await f.client.preview({enabled:true});f.setMode('unsent');await f.client.apply(confirm(p));f.setMode('normal');const q=await f.client.recoveryPreview({});f.setMode('late');const r=await f.client.recoveryApply(confirm(q));assert.equal(r.operation.state,'applied');assert(r.runtime.configured);assert.equal(f.cloud.writes(),1);
});
test('old plan after receiver restart requires review and can be safely closed',async t=>{
 const f=fixture(t),p=await f.client.preview({enabled:true});await f.restart();assert.equal((await f.client.apply(confirm(p))).operation.state,'needs_review');const q=await f.client.recoveryPreview({});assert.equal((await f.client.recoveryApply(confirm(q))).operation.state,'closed');
});
test('offline reads do not use historical approval as live readiness',async t=>{
 const f=fixture(t),p=await f.client.preview({enabled:true});await f.client.apply(confirm(p));f.setMode('offline');const r=await f.client.status({refresh:true});assert.equal(r.operation.state,'applied');assert.equal(r.runtime,null);assert.equal(r.freshness,'check_failed');
});
test('receiver replacement cannot be adopted by old confirmation',async t=>{
 const f=fixture(t),p=await f.client.preview({enabled:true});f.setMutation(r=>({...r,target:{...r.target,runtimeId:randomUUID()}}));const r=await f.client.apply(confirm(p));assert.equal(r.operation.state,'needs_review');assert.equal((await f.client.status({refresh:true})).runtime,null);f.setMutation(null);assert.equal((await f.client.status({refresh:true})).operation.state,'applied');
});
test('expired confirmation and competing tab ledger CAS cannot send repeated grants',async t=>{
 const f=fixture(t),p=await f.client.preview({enabled:true});f.advance(300001);await assert.rejects(f.client.apply(confirm(p)),/PLAN_EXPIRED/);assert.equal(f.cloud.writes(),0);const m=createOnboardingCloudTaskRuntime(f.deps),q=await f.client.preview({enabled:true}),r=await m.preview({enabled:false});await f.client.apply(confirm(q));await assert.rejects(m.apply(confirm(r)),/LEDGER_CONFLICT/);assert.equal(f.calls.filter(x=>x==='task_runtime_apply').length,1);
});
test('foreign ledger is preserved and causes no network activity',async t=>{
 const f=fixture(t),key='dsh-task-gateway/onboarding-cloud-task-runtime-v1';f.local.records.set(key,{kind:'api-key',value:'KEEP'});await assert.rejects(f.client.preview({enabled:true}),/LEDGER_REVIEW/);assert.equal(f.local.records.get(key).value,'KEEP');assert.equal(f.calls.length,0);
});
test('overclaiming or secret-bearing responses never become authoritative UI state',async t=>{
 const f=fixture(t);for(const extra of [{workerEnabled:true},{peerEnabled:true},{writeAuthorized:true},{secret:'NO'}, {contract:1},{target:{role:'local'}}]){f.setMutation(r=>({...r,value:{...r.value,...extra}}));await assert.rejects(f.client.preview({enabled:true}),/RESPONSE_REVIEW/);}f.setMutation(null);const v=await f.manager().status();assert.equal(cloudTaskRuntimeStatus(v).state,'not_configured');assert.throws(()=>cloudTaskRuntimeStatus({...v,secret:'NO'}),/RESPONSE_REVIEW/);
});
test('activation failure records grant but never claims a live process',async t=>{
 const f=fixture(t);f.setMutation(r=>({...r,value:r.value.state?{...r.value,configured:false,repositoryRuntime:false,instanceId:null,port:null,listen:null,state:'needs_review',error:'ONBOARDING_TASK_RUNTIME_START_REVIEW'}:r.value}));const p=await f.client.preview({enabled:true}),r=await f.client.apply(confirm(p));assert.equal(r.operation.state,'applied');assert(!r.runtime.configured);assert.equal(r.runtime.state,'needs_review');
});
test('UI mounts cached state, separates consent/readiness and uses existing accessible actions',async()=>{
 const s=await readFile(new URL('../ui-source/onboarding/task-runtime.jsx',import.meta.url),'utf8');assert(s.includes("cloud?{refresh:false}:{}"));assert(!/setInterval|setTimeout/.test(s));for(const word of ['connection-panel','connection-actions','CheckRow','保留当前状态','不执行任务','手动刷新'])assert(s.includes(word));assert(s.includes('setUnknown(true)'));assert(s.includes('runtime:null'));assert(s.includes('cloud_task_runtime_'));
});

test('cloud worker grant survives lost reply/restart without repeated apply or loss of scope',async t=>{
 const f=fixture(t),p=await f.client.preview({enabled:true,workerEnabled:true});assert(p.workerEnabled);f.setMode('lost');const lost=await f.client.apply(confirm(p));assert.equal(lost.operation.state,'needs_review');await f.restart();f.setMode('normal');const s=await f.client.status({refresh:true});assert.equal(s.operation.state,'applied');assert(s.runtime.workerEnabled&&s.runtime.workerDesiredEnabled&&s.workerEnabled);assert(!s.writeAuthorized&&!s.publishEnabled);assert.equal(f.calls.filter(x=>x==='task_runtime_apply').length,1);
});
test('closing an unknown worker revoke preserves current grant and never silently disables it',async t=>{
 const f=fixture(t);await f.client.apply(confirm(await f.client.preview({enabled:true,workerEnabled:true})));const p=await f.client.preview({enabled:true,workerEnabled:false});f.setMode('unsent');await f.client.apply(confirm(p));f.setMode('normal');const recovery=await f.client.recoveryPreview({});assert(recovery.workerEnabled);const result=await f.client.recoveryApply(confirm(recovery));assert.equal(result.operation.state,'closed');assert(result.runtime.workerEnabled&&result.runtime.workerDesiredEnabled);await assert.rejects(f.lateApply(),/CONFLICT/);
});
test('old remote plan cannot satisfy a worker request even if it falsely echoes true',async t=>{
 const f=fixture(t);f.setMutation(r=>({...r,value:{...r.value,contract:3,workerEnabled:false}}));await assert.rejects(f.client.preview({enabled:true,workerEnabled:true}),/RESPONSE_REVIEW/);
});
test('worker live flag without matching durable grant is rejected',async t=>{
 const f=fixture(t);await f.client.apply(confirm(await f.client.preview({enabled:true})));const s=await f.manager().status();assert.throws(()=>cloudTaskRuntimeStatus({...s,workerEnabled:true}),/RESPONSE_REVIEW/);
});
