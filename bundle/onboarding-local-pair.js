// Local durable consent is separate from the cloud binding and its live health.
import {credentialKey} from '@deepseek-ai/dsh-credentials';
import {randomUUID,randomBytes} from 'node:crypto';
import {digest} from './onboarding-ssh.js';
import {handoffTarget} from './onboarding-handoff.js';
import {peerBindingPlan,peerBindingStatus} from './onboarding-peer-contract.js';
const KEY=credentialKey('dsh-task-gateway','onboarding-local-pair-v1'),OWNER='dsh-dual-host-local-pair';
const exact=(v,k)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===k.slice().sort().join();
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const rev=v=>Number.isSafeInteger(v)&&v>=0&&v<Number.MAX_SAFE_INTEGER-1;
const fail=c=>{throw Error('ONBOARDING_LOCAL_PAIR_'+c);};
const terminal=o=>!o||['applied','closed'].includes(o.phase);
const match=(o,s)=>s.revision===o.remotePlan.revision+1&&s.appliedOperation===o.remotePlan.id&&s.appliedPlanHash===o.remotePlan.fingerprint&&s.id===o.remotePlan.pairId&&s.localId===o.remotePlan.localId&&s.runtimeId===o.remotePlan.runtimeId&&s.enabled===o.remotePlan.enabled;
export const localPairKey=p=>p?.binding?digest({localId:p.localId,binding:p.binding}):null;
function parse(record){
 if(!record)return null;const p=record.payload;
 if(record.kind!=='grant'||!exact(p,['owner','schema','revision','localId','localToken','binding','operation'])||p.owner!==OWNER||p.schema!==1||!rev(p.revision)||!p.revision||!uuid(p.localId)||!hex(p.localToken))fail('LEDGER_REVIEW');
 const b=p.binding,o=p.operation;
 if(b){if(!exact(b,['target','id','runtimeId','namespace','revision','enabled'])||![b.id,b.runtimeId].every(uuid)||b.namespace!=='managed-'+b.runtimeId||!rev(b.revision)||!b.revision||typeof b.enabled!=='boolean')fail('LEDGER_REVIEW');handoffTarget(b.target);}
 if(!o||!exact(o,['id','planHash','remoteTarget','remotePlan','phase','createdAt','updatedAt','error','recovery'])||!uuid(o.id)||!hex(o.planHash)||!['sending','applied','needs_review','recovering','closed'].includes(o.phase)||![o.createdAt,o.updatedAt].every(Number.isSafeInteger)||o.error!==null&&!/^ONBOARDING_[A-Z_]+$/.test(o.error))fail('LEDGER_REVIEW');
 handoffTarget(o.remoteTarget);peerBindingPlan(o.remotePlan);if(o.remotePlan.localId!==p.localId)fail('LEDGER_REVIEW');
 if(o.recovery!==null&&(!exact(o.recovery,['id','fingerprint'])||!uuid(o.recovery.id)||!hex(o.recovery.fingerprint)))fail('LEDGER_REVIEW');
 if(o.phase==='recovering'&&!o.recovery||b?.enabled&&(o.phase!=='applied'||!o.remotePlan.enabled||digest(b.target)!==digest(o.remoteTarget)||b.id!==o.remotePlan.pairId||b.runtimeId!==o.remotePlan.runtimeId||b.revision!==o.remotePlan.revision+1))fail('LEDGER_REVIEW');return p;
}
export function createOnboardingLocalPair({state,credentials,remote,enabled,adapter,now=Date.now}){
 let pending=null,recovery=null,busy=false,handle=null,closed=false,error=null;
 const available=()=>!closed&&enabled()&&state.available()&&!!credentials()&&!!adapter;
 const ready=()=>{if(!available())fail('UNAVAILABLE');};
 const read=async()=>{ready();return parse(await credentials().readRecord(KEY));};
 async function run(fn){ready();if(busy)fail('BUSY');busy=true;try{await handle?.quiescent();return await fn();}finally{busy=false;}}
 async function save(prior,fn){let value;await credentials().modifyRecord(KEY,raw=>{const p=parse(raw);if((p?.revision??0)!==(prior?.revision??0)||(p?.localId??null)!==(prior?.localId??null))fail('LEDGER_CONFLICT');value=fn(p);value.revision=(p?.revision??0)+1;return {kind:'grant',payload:value};});return value;}
 async function request(action,args,target){const r=await remote('task_pair_'+action,args,target);if(!exact(r,['target','value']))fail('RESPONSE_REVIEW');handoffTarget(r.target);if(target&&digest(target)!==digest(r.target))fail('TARGET_CHANGED');return r;}
 async function query(p){const target=p?.operation.remoteTarget,r=await request('status',target?{targetHash:digest(target)}:{},target);return {...r,value:peerBindingStatus(r.value)};}
 function view(p,s=null,freshness='cached'){
  const o=p?.operation,mounted=!!p?.binding?.enabled&&handle?.active()===true&&handle.bindingKey===localPairKey(p);
  return {contract:1,scope:'local_controller_to_managed_cloud',localId:p?.localId??null,revision:p?.revision??0,localEnabled:p?.binding?.enabled??false,mounted,activationError:error,remote:s,freshness,checkedAt:freshness==='cached'?null:now(),operation:o?{id:o.id,state:o.phase,enabled:o.remotePlan.enabled,target:o.remoteTarget,updatedAt:o.updatedAt,error:o.error}:{state:'not_started'},workerEnabled:false,writeAuthorized:false,publishEnabled:false};
 }
 async function authorize(key){const p=await read();if(!p?.binding?.enabled||localPairKey(p)!==key)fail('DISABLED');return p;}
 async function forward(key,method,args,contract){
  if(busy)fail('BUSY');
  const p=await authorize(key),b=p.binding,r=await request('forward',{id:b.id,localId:p.localId,revision:b.revision,frame:{method,args,...(contract?{contract}:{})},targetHash:digest(b.target)},b.target);
  await authorize(key);if(!exact(r.value,r.value?.ok===true?['ok','value']:['ok','error']))fail('RESPONSE_REVIEW');
  if(r.value.ok!==true){if(typeof r.value.error!=='string'||!/^[A-Z_]{1,100}$/.test(r.value.error))fail('RESPONSE_REVIEW');throw Error(r.value.error);}return r.value.value;
 }
 async function sync(p){
  if(!p?.binding?.enabled){await handle?.close();handle=null;error=null;return;}
  const key=localPairKey(p);if(handle?.active()&&handle.bindingKey===key)return;
  await handle?.close();handle=null;
  try{const h=await adapter.open(p,()=>authorize(key),(m,a,c)=>forward(key,m,a,c));if(closed){await h.close();return;}handle=h;error=null;}catch{error='ONBOARDING_LOCAL_PAIR_ACTIVATION_REVIEW';}
 }
 async function start(){if(!available())return;try{await run(async()=>sync(await read()));}catch{error='ONBOARDING_LOCAL_PAIR_LEDGER_REVIEW';}}
 async function settle(p,s){
  const o=p.operation,applied=match(o,s);if(s.localId!==null&&s.localId!==p.localId||s.runtimeId!==o.remotePlan.runtimeId)fail('TARGET_CHANGED');
  const phase=applied?'applied':s.revision>o.remotePlan.revision?'closed':'needs_review';
  const b=applied?{target:o.remoteTarget,id:s.id,runtimeId:s.runtimeId,namespace:s.namespace,revision:s.revision,enabled:s.enabled}:p.binding?{...p.binding,enabled:false}:null;
  const next=await save(p,()=>({...p,binding:b,operation:{...o,phase,error:phase==='needs_review'?'ONBOARDING_LOCAL_PAIR_OUTCOME_UNKNOWN':null,updatedAt:now()}}));await sync(next);return view(next,s,'remote_checked');
 }
 async function unknown(p){const next=await save(p,()=>({...p,binding:terminal(p.operation)?p.binding:p.binding?{...p.binding,enabled:false}:null,operation:{...p.operation,phase:terminal(p.operation)?p.operation.phase:'needs_review',error:'ONBOARDING_LOCAL_PAIR_STATUS_UNKNOWN',updatedAt:now()}}));await sync(next);return view(next,null,'check_failed');}
 async function reconcile(p){try{const r=await query(p);return await settle(p,r.value);}catch(e){if(e.message==='ONBOARDING_LOCAL_PAIR_LEDGER_CONFLICT')throw e;return unknown(p);}}
 async function status(a){if(!exact(a,['refresh'])||typeof a.refresh!=='boolean')fail('ARGUMENTS');ready();if(!a.refresh)return view(await read());return run(async()=>{const p=await read();if(p)return reconcile(p);const r=await query(null);return view(null,r.value,'remote_checked');});}
 async function preview(a){return run(async()=>{
  pending=null;if(!exact(a,['enabled'])||typeof a.enabled!=='boolean')fail('ARGUMENTS');const p=await read();if(!terminal(p?.operation))fail('RECOVERY_REQUIRED');await handle?.quiescent();
  const first=await query(p),localId=p?.localId??randomUUID();if(first.value.localId!==null&&first.value.localId!==localId)fail('OTHER_CONTROLLER');
  const r=await request('preview',{enabled:a.enabled,localId,targetHash:digest(first.target)},first.target),rp=peerBindingPlan(r.value);
  if(rp.localId!==localId||rp.enabled!==a.enabled||rp.expiresAt<=now())fail('RESPONSE_REVIEW');
  const body={id:randomUUID(),localId,remoteTarget:r.target,remotePlan:rp,priorRevision:p?.revision??0,expiresAt:Math.min(now()+300000,rp.expiresAt)};pending={...body,fingerprint:digest(body)};
  return {id:pending.id,fingerprint:pending.fingerprint,localId,enabled:a.enabled,target:r.target,expiresAt:pending.expiresAt,scope:'transport_and_task_intake_only',workerEnabled:false,writeAuthorized:false,publishEnabled:false};
 });}
 async function apply(a){return run(async()=>{
  if(!exact(a,['id','fingerprint','confirm'])||!uuid(a.id)||!hex(a.fingerprint)||a.confirm!==true)fail('CONFIRMATION_REQUIRED');const old=await read();
  if(old?.operation.id===a.id&&old.operation.planHash===a.fingerprint)return {...view(old),notResent:true};
  const p=pending;if(!p||p.id!==a.id||p.fingerprint!==a.fingerprint||p.expiresAt<=now())fail('PLAN_EXPIRED');pending=null;
  if((old?.revision??0)!==p.priorRevision||!terminal(old?.operation))fail('LEDGER_CONFLICT');await handle?.quiescent();
  const o={id:p.id,planHash:p.fingerprint,remoteTarget:p.remoteTarget,remotePlan:p.remotePlan,phase:'sending',createdAt:now(),updatedAt:now(),error:null,recovery:null};
  // Persist local denial before sending either mutation. Unknown outcomes cannot
  // keep an old sender active, and cloud replies cannot grant a different peer.
  const saved=await save(old,()=>({owner:OWNER,schema:1,revision:0,localId:p.localId,localToken:old?.localToken??randomBytes(32).toString('hex'),binding:old?.binding?{...old.binding,enabled:false}:null,operation:o}));await sync(saved);
  try{const r=await request('apply',{id:p.remotePlan.id,fingerprint:p.remotePlan.fingerprint,confirm:true,targetHash:digest(p.remoteTarget)},p.remoteTarget);return await settle(saved,peerBindingStatus(r.value));}
  catch(e){if(e.message==='ONBOARDING_LOCAL_PAIR_LEDGER_CONFLICT')throw e;return unknown(saved);}
 });}
 async function recoveryPreview(a){return run(async()=>{
  recovery=null;if(!exact(a,[]))fail('ARGUMENTS');const p=await read();if(!p||terminal(p.operation))fail('RECOVERY_NOT_READY');const r=await query(p),s=r.value,o=p.operation;if(match(o,s))fail('ALREADY_APPLIED');
  if(s.localId!==null&&s.localId!==p.localId||s.runtimeId!==o.remotePlan.runtimeId)fail('TARGET_CHANGED');
  const body={id:randomUUID(),ledgerRevision:p.revision,operationId:o.id,target:o.remoteTarget,expectedRevision:s.revision,pairId:s.id??o.remotePlan.pairId,runtimeId:s.runtimeId,localId:p.localId,mode:s.revision>o.remotePlan.revision?'already_advanced':'fence',authorizationHash:digest(s),expiresAt:now()+300000};recovery={...body,fingerprint:digest(body)};
  return {...recovery,preservesCloudAuthorization:true,localStaysDisabled:true,workerEnabled:false,writeAuthorized:false,publishEnabled:false};
 });}
 async function recoveryApply(a){return run(async()=>{
  if(!exact(a,['id','fingerprint','confirm'])||!uuid(a.id)||!hex(a.fingerprint)||a.confirm!==true)fail('CONFIRMATION_REQUIRED');const old=await read();if(old?.operation.recovery?.id===a.id&&old.operation.recovery.fingerprint===a.fingerprint)return {...view(old),notResent:true};
  const p=recovery;if(!p||p.id!==a.id||p.fingerprint!==a.fingerprint||p.expiresAt<=now())fail('PLAN_EXPIRED');recovery=null;
  if(!old||old.revision!==p.ledgerRevision||old.operation.id!==p.operationId||terminal(old.operation))fail('LEDGER_CONFLICT');await handle?.quiescent();const r=await query(old);if(match(old.operation,r.value))fail('ALREADY_APPLIED');if(digest(r.value)!==p.authorizationHash)fail('RECOVERY_CHANGED');
  const saved=await save(old,()=>({...old,operation:{...old.operation,phase:'recovering',updatedAt:now(),recovery:{id:p.id,fingerprint:p.fingerprint}}}));
  if(p.mode==='fence')try{await request('fence',{operation:p.id,expectedRevision:p.expectedRevision,id:p.pairId,localId:p.localId,runtimeId:p.runtimeId,confirm:true,targetHash:digest(p.target)},p.target);}catch{/* Query the same target; never resend. */}
  return reconcile(saved);
 });}
 async function suspend(){await handle?.close();handle=null;}
 async function close(){closed=true;pending=null;recovery=null;await suspend();}
 return {available,start,status,preview,apply,recoveryPreview,recoveryApply,suspend,close,get files(){return handle?.files;},get configured(){return handle?.active()===true;}};
}
