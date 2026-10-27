// Cloud connection checks start in the live target Host, never in the SSH
// controller. Reading a receipt cannot enqueue or repeat an inference request.
import {randomUUID} from 'node:crypto';
import {digest} from './onboarding-ssh.js';
import {handoffTarget} from './onboarding-handoff.js';
import {MODEL_PROBE_LIMITS} from './onboarding-model-probe.js';
const exact=(v,ks)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===ks.slice().sort().join();
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const rev=x=>Number.isSafeInteger(x)&&x>=0;
const text=x=>typeof x==='string'&&x.length>0&&x.length<=200&&!/[\x00-\x1f\x7f]/.test(x);
const errors=new Set(['AUTH','INVALID_CREDENTIAL','MISSING_CREDENTIAL','RATE_LIMIT','QUOTA','ACCOUNT_QUOTA','NO_ADAPTER','CONTEXT_WINDOW_EXCEEDED','ROUTE_CHANGED','BINDING_CHANGED','OUTPUT_LIMIT','INCOMPLETE','TOOL_DENIED','DEADLINE','EMPTY_RESPONSE','PROVIDER_ERROR']);
const fail=c=>{throw Error('ONBOARDING_CLOUD_MODEL_PROBE_'+c);};
function identity(t){if(!exact(t,['role','name','source','platform'])||t.role!=='cloud'||t.platform!=='linux'||t.name!=='云端大肥鱼'||!['setup_configuration','gateway_configuration'].includes(t.source))fail('IDENTITY_REVIEW');}
function limits(v){if(!exact(v,Object.keys(MODEL_PROBE_LIMITS))||Object.keys(MODEL_PROBE_LIMITS).some(k=>v[k]!==MODEL_PROBE_LIMITS[k]))fail('RESPONSE_REVIEW');}
function selection(v,provider){if(!exact(v,['provider','provider_name','model','model_name'])||!Object.values(v).every(text)||v.provider!==provider)fail('RESPONSE_REVIEW');}
function envelope(r){if(!exact(r,['target','value']))fail('RESPONSE_REVIEW');handoffTarget(r.target);return r;}
function checkedStatus(v,provider){
 if(!exact(v,['contract','available','target','receipt','limits','automaticRetry','defaultModelChanged','taskStarted'])||v.contract!==2||v.available!==true||v.automaticRetry!==false||v.defaultModelChanged!==false||v.taskStarted!==false)fail('RESPONSE_REVIEW');identity(v.target);limits(v.limits);
 const p=v.receipt;
 if(p!==null){
  if(!exact(p,['id','state','selection','startedAt','deadlineAt','completedAt','error','verifiedForCurrentBinding'])||!uuid(p.id)||!['running','succeeded','failed','unknown'].includes(p.state)||!rev(p.startedAt)||p.deadlineAt!==p.startedAt+MODEL_PROBE_LIMITS.timeoutMs||p.completedAt!==null&&!rev(p.completedAt)||p.error!==null&&!errors.has(p.error)||typeof p.verifiedForCurrentBinding!=='boolean'||p.verifiedForCurrentBinding&&p.state!=='succeeded')fail('RESPONSE_REVIEW');
  if(p.state==='running'&&(p.completedAt!==null||p.error!==null)||p.state==='succeeded'&&(p.completedAt===null||p.error!==null)||p.state==='failed'&&(p.completedAt===null||p.error===null)||p.state==='unknown'&&((p.completedAt===null)!==(p.error===null)))fail('RESPONSE_REVIEW');selection(p.selection,provider);
 }
 return v;
}
export function createOnboardingCloudModelProbe({remote,provider,now=Date.now}){
 let plan=null,busy=false;
 async function run(fn){if(busy)fail('BUSY');busy=true;try{return await fn();}finally{busy=false;}}
 const value=r=>({...checkedStatus(r.value,provider),remoteTarget:r.target,freshness:'remote_checked',checkedAt:now(),scope:'managed_cloud_only'});
 async function status(a){if(!exact(a,[]))fail('ARGUMENTS');return run(async()=>value(envelope(await remote('model_probe_status',{}))));}
 async function preview(a){
  if(!exact(a,['query','acknowledgeUnknown',...(a?.clarification!==undefined?['clarification']:[])])||!text(a.query)||a.clarification!==undefined&&(!text(a.clarification)||!a.clarification.trim())||a.acknowledgeUnknown!==null&&!uuid(a.acknowledgeUnknown))fail('ARGUMENTS');
  return run(async()=>{
   plan=null;const r=envelope(await remote('model_probe_preview',a)),p=r.value;
   if(!exact(p,['id','selection','bindingRevision','credentialRevision','receiptRevision','previousUnknown','target','expiresAt','reasoningEffort','limits','fingerprint','modelRequests','authorization'])||!uuid(p.id)||!hex(p.fingerprint)||![p.bindingRevision,p.credentialRevision,p.receiptRevision,p.expiresAt].every(rev)||p.expiresAt<=now()||p.reasoningEffort!=='high'||p.modelRequests!==0||p.authorization!=='one_explicit_probe_only'||p.previousUnknown!==a.acknowledgeUnknown)fail('RESPONSE_REVIEW');identity(p.target);limits(p.limits);selection(p.selection,provider);
   const body={...p,id:randomUUID(),operationId:p.id,remoteTarget:r.target,scope:'managed_cloud_only',expiresAt:Math.min(p.expiresAt,now()+300000)};
   plan={public:{...body,fingerprint:digest(body)},remoteId:p.id,remoteHash:p.fingerprint};return plan.public;
  });
 }
 async function start(a){
  if(!exact(a,['id','fingerprint','confirm'])||!uuid(a.id)||!hex(a.fingerprint)||a.confirm!==true)fail('CONFIRMATION_REQUIRED');
  return run(async()=>{
   const p=plan;if(!p||a.id!==p.public.id||a.fingerprint!==p.public.fingerprint||p.public.expiresAt<=now())fail('PLAN_EXPIRED');plan=null;
   // Consume before sending. An interrupted response may conceal a real start;
   // reconnect via status, never retry this command or fall back to local.
   const r=envelope(await remote('model_probe_start',{id:p.remoteId,fingerprint:p.remoteHash,confirm:true,targetHash:digest(p.public.remoteTarget)}));
   if(digest(r.target)!==digest(p.public.remoteTarget))fail('IDENTITY_REVIEW');const v=value(r);
   if(v.receipt?.id!==p.remoteId||digest(v.receipt.selection)!==digest(p.public.selection))fail('OUTCOME_UNKNOWN');return v;
  });
 }
 return {status,preview,start};
}
