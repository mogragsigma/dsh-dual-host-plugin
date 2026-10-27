// One explicitly bound controller, over the already verified owned SSH target.
// The peer token never leaves the cloud Host. Frames still use Gateway's native
// negotiation/authentication path; this is transport, not an execution grant.
import {credentialKey} from '@deepseek-ai/dsh-credentials';
import {randomUUID} from 'node:crypto';
import {digest} from './onboarding-ssh.js';
import {METHODS} from './link-contract.js';
const KEY=credentialKey('dsh-task-gateway','onboarding-peer-binding-v1');
const OWNER='dsh-dual-host-peer-binding';
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===keys.slice().sort().join();
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const revision=v=>Number.isSafeInteger(v)&&v>=0&&v<Number.MAX_SAFE_INTEGER-1;
const fail=c=>{throw Error('ONBOARDING_TASK_RUNTIME_PAIR_'+c);};
function record(r){
 if(!r)return null;const p=r.payload;
 if(r.kind!=='grant'||!exact(p,['owner','schema','id','localId','runtimeId','enabled','revision','operation','planHash','updatedAt'])||p.owner!==OWNER||p.schema!==1||![p.id,p.localId,p.runtimeId,p.operation].every(uuid)||typeof p.enabled!=='boolean'||!revision(p.revision)||!p.revision||!hex(p.planHash)||!Number.isSafeInteger(p.updatedAt))fail('RECORD_REVIEW');return p;
}
export const peerBindingKey=p=>p?digest({id:p.id,localId:p.localId,runtimeId:p.runtimeId,enabled:p.enabled}):null;
export function createOnboardingPeerBinding({credentials,available,runtime,handle,run,refresh,now=Date.now}){
 let plan=null,inflight=0;
 const ready=()=>{if(!available())fail('UNAVAILABLE');return credentials();};
 const read=async()=>record(await ready().readRecord(KEY));
 async function binding(runtimeId){const p=await read();if(p&&p.runtimeId!==runtimeId)fail('RUNTIME_CHANGED');return p;}
 async function status(a={}){
  if(!exact(a,[]))fail('ARGUMENTS');const p=await read(),r=await runtime(),h=handle();if(p&&p.runtimeId!==r?.id)fail('RUNTIME_CHANGED');
  return {contract:1,revision:p?.revision??0,id:p?.id??null,localId:p?.localId??null,runtimeId:p?.runtimeId??r?.id??null,enabled:p?.enabled??false,mounted:!!p?.enabled&&!!r?.enabled&&h?.active()===true&&h.pairingKey===peerBindingKey(p),namespace:r?'managed-'+r.id:null,appliedOperation:p?.operation??null,appliedPlanHash:p?.planHash??null,workerEnabled:false,writeAuthorized:false,publishEnabled:false};
 }
 async function quiescent(){if(inflight)fail('BUSY');await handle()?.quiescent();}
 async function preview(a){return run(async()=>{
  plan=null;if(!exact(a,['enabled','localId'])||typeof a.enabled!=='boolean'||!uuid(a.localId))fail('ARGUMENTS');
  const r=await runtime(),p=await read();if(r?.workerEnabled)fail('WORKER_DISABLE_REQUIRED');if(!r?.enabled||a.enabled&&handle()?.active()!==true)fail('RUNTIME_NOT_READY');
  if(p&&(p.localId!==a.localId||p.runtimeId!==r.id))fail('OWNER_MISMATCH');
  await quiescent();const body={id:randomUUID(),pairId:p?.id??randomUUID(),localId:a.localId,runtimeId:r.id,runtimeRevision:r.revision,enabled:a.enabled,revision:p?.revision??0,expiresAt:now()+300000};plan={...body,fingerprint:digest(body)};
  return {...plan,contract:1,namespace:'managed-'+r.id,scope:'single_verified_controller_transport',workerEnabled:false,writeAuthorized:false,publishEnabled:false};
 });}
 async function apply(a){return run(async()=>{
  if(!exact(a,['id','fingerprint','confirm'])||!uuid(a.id)||!hex(a.fingerprint)||a.confirm!==true)fail('CONFIRMATION_REQUIRED');
  const old=await read();if(old?.operation===a.id&&old.planHash===a.fingerprint)return status({});
  const p=plan;if(!p||p.id!==a.id||p.fingerprint!==a.fingerprint||p.expiresAt<=now())fail('PLAN_EXPIRED');plan=null;
  const r=await runtime();if(r?.workerEnabled)fail('WORKER_DISABLE_REQUIRED');if(!r?.enabled||r.id!==p.runtimeId||r.revision!==p.runtimeRevision)fail('RUNTIME_CHANGED');await quiescent();
  await ready().modifyRecord(KEY,prior=>{const v=record(prior);if((v?.revision??0)!==p.revision)fail('CONFLICT');if(v&&(v.localId!==p.localId||v.runtimeId!==p.runtimeId))fail('OWNER_MISMATCH');return {kind:'grant',payload:{owner:OWNER,schema:1,id:p.pairId,localId:p.localId,runtimeId:p.runtimeId,enabled:p.enabled,revision:p.revision+1,operation:p.id,planHash:p.fingerprint,updatedAt:now()}};});
  await refresh();return status({});
 });}
 async function fence(a){return run(async()=>{
  if(!exact(a,['operation','expectedRevision','id','localId','runtimeId','confirm'])||![a.operation,a.id,a.localId,a.runtimeId].every(uuid)||!revision(a.expectedRevision)||a.confirm!==true)fail('CONFIRMATION_REQUIRED');await quiescent();
  const r=await runtime();if(r?.workerEnabled)fail('WORKER_DISABLE_REQUIRED');if(r?.id!==a.runtimeId)fail('RUNTIME_CHANGED');
  await ready().modifyRecord(KEY,old=>{const p=record(old);if((p?.revision??0)!==a.expectedRevision)fail('CONFLICT');if(p&&(p.id!==a.id||p.localId!==a.localId||p.runtimeId!==a.runtimeId))fail('OWNER_MISMATCH');return {kind:'grant',payload:{...(p??{owner:OWNER,schema:1,id:a.id,localId:a.localId,runtimeId:a.runtimeId,enabled:false}),revision:a.expectedRevision+1,operation:a.operation,planHash:digest(a),updatedAt:now()}};});return status({});
 });}
 async function forward(a){
  if(!exact(a,['id','localId','revision','frame'])||!uuid(a.id)||!uuid(a.localId)||!revision(a.revision)||!a.revision)fail('ARGUMENTS');
  const f=a.frame;if(!exact(f,['method','args',...(f?.contract===undefined?[]:['contract'])])||!(f.method==='negotiate'||Object.hasOwn(METHODS,f.method))||!f.args||typeof f.args!=='object'||Array.isArray(f.args)||Buffer.byteLength(JSON.stringify(f))>131072)fail('FRAME_INVALID');
  const admitted=await run(async()=>{const p=await read(),r=await runtime(),h=handle();
  if(!p?.enabled||p.id!==a.id||p.localId!==a.localId||p.revision!==a.revision||!r?.enabled||r.id!==p.runtimeId)fail('AUTH_DENIED');
  if(!h?.active()||h.pairingKey!==peerBindingKey(p)||typeof h.forward!=='function')fail('RUNTIME_NOT_READY');
  // No approval or role rewriting: caller's exact frame reaches Gateway as local.
  inflight++;return {p,h};});
  try{const value=await admitted.h.forward(f);const after=await read();if(after?.revision!==admitted.p.revision||!after.enabled)fail('AUTH_CHANGED');return value;}finally{inflight--;}
 }
 return {binding,status,preview,apply,fence,forward,quiescent};
}
