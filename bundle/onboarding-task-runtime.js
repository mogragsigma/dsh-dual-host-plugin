// Intake and read-only worker are separate explicit choices. Neither grants development consent.
import {createOnboardingPeerBinding,peerBindingKey} from './onboarding-peer-binding.js';
import {credentialKey} from '@deepseek-ai/dsh-credentials';
import {randomUUID,randomBytes} from 'node:crypto';
import {digest} from './onboarding-ssh.js';
import {onboardingIdentity} from './onboarding-identity.js';
const KEY=credentialKey('dsh-task-gateway','onboarding-task-runtime-v1'),OWNER='dsh-dual-host-task-runtime';
const exact=(v,ks)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===ks.slice().sort().join();
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const fail=c=>{throw Error('ONBOARDING_TASK_RUNTIME_'+c);};
function record(r){
 if(!r)return null;const p=r.payload;
 if(r.kind!=='grant'||!exact(p,['owner','schema','id','revision','operation','planHash','enabled','updatedAt','localToken','cloudToken',...(p?.schema===2?['workerEnabled']:[])])||p.owner!==OWNER||![1,2].includes(p.schema)||p.schema===2&&(typeof p.workerEnabled!=='boolean'||p.workerEnabled&&!p.enabled)||!uuid(p.id)||!uuid(p.operation)||!hex(p.planHash)||!Number.isSafeInteger(p.revision)||p.revision<1||p.revision>=Number.MAX_SAFE_INTEGER-1||!Number.isSafeInteger(p.updatedAt)||typeof p.enabled!=='boolean'||!hex(p.localToken)||!hex(p.cloudToken)||p.localToken===p.cloudToken)fail('RECORD_REVIEW');return {...p,workerEnabled:p.schema===2&&p.workerEnabled};
}
export function createOnboardingTaskRuntime({state,credentials,config={},adapter,now=Date.now,platform=process.platform}){
 const identity={...onboardingIdentity(config),platform};let pending=null,handle=null,busy=false,closed=false,lastError=null;
 const available=()=>!closed&&identity.role==='cloud'&&!config.role&&!config.stateDir&&!config.tokenFile&&state.available()&&!!credentials()&&!!adapter;
 const ready=()=>{if(!available())fail('UNAVAILABLE');return credentials();};
 const read=async()=>record(await ready().readRecord(KEY));
 const pairing=createOnboardingPeerBinding({credentials,available,runtime:read,handle:()=>handle,run,refresh:async()=>sync(await read()),now});
 async function run(fn){if(busy)fail('BUSY');busy=true;try{return await fn();}finally{busy=false;}}
 async function authorized(id){const p=await read();if(!p?.enabled||p.id!==id)fail('DISABLED');}
 async function sync(p){
  if(!p?.enabled){await handle?.close();handle=null;lastError=null;return;}
  const binding=await pairing.binding(p.id);
  if(handle?.id===p.id&&handle.active()&&(handle.pairingKey??null)===peerBindingKey(binding)&&!!handle.workerEnabled===p.workerEnabled)return;
  await handle?.close();handle=null;
  try{const candidate=await adapter.open({...p,pairing:binding},()=>authorized(p.id));if(closed){await candidate.close();fail('CLOSED');}if(!!candidate.workerEnabled!==p.workerEnabled){await candidate.close();fail('WORKER_START_REVIEW');}handle=candidate;lastError=null;}
  catch(e){lastError=/^ONBOARDING_TASK_RUNTIME_[A-Z_]+$/.test(e.message)?e.message:'ONBOARDING_TASK_RUNTIME_START_REVIEW';}
 }
 async function start(){if(!available())return;return run(async()=>{try{await sync(await read());}catch{lastError='ONBOARDING_TASK_RUNTIME_RECORD_REVIEW';}});}
 async function status(a={}){
  if(!exact(a,[]))fail('ARGUMENTS');
  if(!available())return {contract:4,available:false,owned:false,configured:false,writeAuthorized:false};
  const p=await read(),peer=await pairing.status({}),active=!!p?.enabled&&handle?.id===p.id&&handle.active()===true;
  return {contract:4,available:true,scope:'current_host_only',owned:true,role:'cloud',target:identity,id:p?.id??null,revision:p?.revision??0,appliedOperation:p?.operation??null,appliedPlanHash:p?.planHash??null,desiredEnabled:p?.enabled??false,configured:active,state:active?'active':lastError?'needs_review':p?.enabled?'activation_pending':p?'disabled':'not_configured',instanceId:active?handle.instanceId:null,listen:active?'127.0.0.1':null,port:active?handle.port:null,repositoryRuntime:active,workerDesiredEnabled:p?.workerEnabled??false,workerEnabled:active&&handle.workerEnabled===true,peerEnabled:peer.mounted,pairing:peer,writeAuthorized:false,publishEnabled:false,error:lastError};
 }
 async function preview(a){return run(async()=>{
  pending=null;if(!exact(a,['enabled',...(a.workerEnabled!==undefined?['workerEnabled']:[])])||typeof a.enabled!=='boolean'||a.workerEnabled!==undefined&&typeof a.workerEnabled!=='boolean'||a.workerEnabled&&!a.enabled)fail('ARGUMENTS');
  const p=await read();if(!a.enabled){if((await pairing.status({})).enabled)fail('PAIR_REVOKE_REQUIRED');await pairing.quiescent();}
  const body={id:randomUUID(),enabled:a.enabled,workerEnabled:a.workerEnabled??false,revision:p?.revision??0,target:identity,expiresAt:now()+300000};pending={...body,fingerprint:digest(body)};
  return {...pending,contract:4,scope:'current_host_only',peerEnabled:false,writeAuthorized:false,publishEnabled:false};
 });}
 async function apply(a){return run(async()=>{
  if(!exact(a,['id','fingerprint','confirm'])||!uuid(a.id)||!hex(a.fingerprint)||a.confirm!==true)fail('CONFIRMATION_REQUIRED');
  const p=pending;if(!p||p.id!==a.id||p.fingerprint!==a.fingerprint||p.expiresAt<=now())fail('PLAN_EXPIRED');pending=null;
  if(!p.enabled){if((await pairing.status({})).enabled)fail('PAIR_REVOKE_REQUIRED');await pairing.quiescent();}
  // Close admission synchronously while idle, before the async credential CAS.
  // A lost write result leaves the runtime closed, not executing under uncertain consent.
  await pairing.quiescent();
  if(handle){if(typeof handle.hold!=='function')fail('HOLD_UNAVAILABLE');handle.hold();}
  try{
   await ready().modifyRecord(KEY,old=>{const prior=record(old);if((prior?.revision??0)!==p.revision)fail('CONFLICT');return {kind:'grant',payload:{owner:OWNER,schema:2,id:prior?.id??randomUUID(),revision:p.revision+1,operation:p.id,planHash:p.fingerprint,enabled:p.enabled,workerEnabled:p.workerEnabled,updatedAt:now(),localToken:prior?.localToken??randomBytes(32).toString('hex'),cloudToken:prior?.cloudToken??randomBytes(32).toString('hex')}};});
   await handle?.close();handle=null;await sync(await read());return status({});
  }catch(e){try{await handle?.close();}finally{handle=null;lastError='ONBOARDING_TASK_RUNTIME_AUTHORIZATION_REVIEW';}throw e;}
 });}
 async function fence(a){return run(async()=>{
  if(!exact(a,['operation','expectedRevision','confirm'])||!uuid(a.operation)||!Number.isSafeInteger(a.expectedRevision)||a.expectedRevision<0||a.expectedRevision>=Number.MAX_SAFE_INTEGER-1||a.confirm!==true)fail('CONFIRMATION_REQUIRED');
  // Fencing preserves existing authorization and data; it never activates or stops a runtime.
  await ready().modifyRecord(KEY,old=>{const p=record(old);if((p?.revision??0)!==a.expectedRevision)fail('CONFLICT');return {kind:'grant',payload:{owner:OWNER,schema:2,id:p?.id??randomUUID(),revision:a.expectedRevision+1,operation:a.operation,planHash:digest(a),enabled:p?.enabled??false,workerEnabled:p?.workerEnabled??false,updatedAt:now(),localToken:p?.localToken??randomBytes(32).toString('hex'),cloudToken:p?.cloudToken??randomBytes(32).toString('hex')}};});
  return status({});
 });}
 async function close(){closed=true;pending=null;await handle?.close();handle=null;}
 return {available,start,status,preview,apply,fence,close,pairing,get files(){return handle?.files;},get configured(){return !closed&&handle?.active()===true;}};
}
