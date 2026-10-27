// Target Host owns model bindings. This facade never reads or forwards Keys,
// stores a second binding or chooses a default. Probe calls have separate consent.
import {createOnboardingCloudModelProbe} from './onboarding-cloud-model-probe.js';
import {randomUUID} from 'node:crypto';
import {digest} from './onboarding-ssh.js';
import {TOKEN_PLAN_PROVIDER,TOKEN_PLAN_NAME,TOKEN_PLAN_ENDPOINT} from './onboarding-token-plan.js';
import {handoffTarget} from './onboarding-handoff.js';
const exact=(v,ks)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===ks.sort().join();
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const rev=x=>Number.isSafeInteger(x)&&x>=0;
const text=(x,n=512)=>typeof x==='string'&&x.length<=n&&!/[\x00-\x1f\x7f]/.test(x);
const fail=c=>{throw Error('ONBOARDING_CLOUD_MODEL_'+c);};
const PROVIDER='dsh-onboarding-deepseek',ENDPOINT='https://api.deepseek.com/anthropic';
function identity(t){if(!exact(t,['role','name','source','platform'])||t.role!=='cloud'||t.platform!=='linux'||t.name!=='云端大肥鱼'||!['setup_configuration','gateway_configuration'].includes(t.source))fail('IDENTITY_REVIEW');return t;}
function envelope(r){if(!exact(r,['target','value']))fail('RESPONSE_REVIEW');handoffTarget(r.target);return r;}
function statusValue(v,provider=PROVIDER,providerName='DeepSeek（双端配置）',endpoint=ENDPOINT){
 if(!v||v.available!==true)fail('UNAVAILABLE');identity(v.target);
 const fields=['available','target','state','bindingRevision','appliedOperation','appliedPlanHash','credentialRevision','credentialPresent','registered','provider','providerName','endpoint','reasoningEffort','verificationRecorded','defaultModelChanged','cloudTransferred','error'];
 if(!exact(v,fields)||!['not_configured','configured_unverified','disabled','credential_changed','registration_pending','needs_review'].includes(v.state)||![v.bindingRevision,v.credentialRevision].every(rev)||!['credentialPresent','registered'].every(k=>typeof v[k]==='boolean')||v.provider!==provider||v.providerName!==providerName||v.endpoint!==endpoint||v.reasoningEffort!=='high'||['verificationRecorded','defaultModelChanged','cloudTransferred'].some(k=>v[k]!==false)||v.error!==null&&!/^ONBOARDING_MODEL_[A-Z_]+$/.test(v.error)||v.appliedOperation!==null&&!uuid(v.appliedOperation)||v.appliedPlanHash!==null&&!hex(v.appliedPlanHash))fail('RESPONSE_REVIEW');
 return v;
}
function modelRow(v){if(!exact(v,['provider','provider_name','model','model_name'])||Object.values(v).some(x=>!text(x,200)||!x))fail('RESPONSE_REVIEW');return v;}
function resolution(v){
 if(!v||v.schema!==1||v.host!=='current'||!['resolved','catalog','ambiguous','not_found','catalog_changed','catalog_incomplete','route_unavailable'].includes(v.status)||v.execution_authorized!==false||v.provider_io_verified!==false||v.defaultModelChanged!==false||!hex(v.catalog_fingerprint)||!Number.isSafeInteger(v.observed_at)||!text(v.instruction,1500))fail('RESPONSE_REVIEW');
 const result={schema:1,host:'cloud',status:v.status,execution_authorized:false,provider_io_verified:false,defaultModelChanged:false,catalog_fingerprint:v.catalog_fingerprint,observed_at:v.observed_at,instruction:v.instruction};
 if(v.status==='resolved'){
  result.selection=modelRow(v.selection);
  if(!exact(v.model_policy,['provider','model','reasoningEffort'])||v.model_policy.provider!==v.selection.provider||v.model_policy.model!==v.selection.model||v.model_policy.reasoningEffort!=='high')fail('RESPONSE_REVIEW');result.model_policy=v.model_policy;
 }else{
  if(v.candidates!==undefined){if(!Array.isArray(v.candidates)||v.candidates.length>30)fail('RESPONSE_REVIEW');result.candidates=v.candidates.map(modelRow);}
  if(v.suggestions!==undefined){if(!Array.isArray(v.suggestions)||v.suggestions.length>5)fail('RESPONSE_REVIEW');result.suggestions=v.suggestions.map(modelRow);}
 }
 return result;
}
export function createOnboardingCloudModels({remote:transport,enabled,now=Date.now,service='deepseek'}){
 if(!['deepseek','token-plan'].includes(service))fail('SERVICE_REVIEW');
 const token=service==='token-plan',provider=token?TOKEN_PLAN_PROVIDER:PROVIDER,providerName=token?TOKEN_PLAN_NAME:'DeepSeek（双端配置）',endpoint=token?TOKEN_PLAN_ENDPOINT:ENDPOINT,slot=token?'token-plan':'deepseek-local';
 const remote=(method,args)=>transport((token?'token_':'')+method,args),checkedStatus=v=>statusValue(v,provider,providerName,endpoint);
 let plan=null,busy=false;
 const available=()=>enabled();
 async function run(fn){if(!available())fail('DISABLED');if(busy)fail('BUSY');busy=true;try{return await fn();}finally{busy=false;}}
 async function status(a){if(!exact(a,[]))fail('ARGUMENTS');return run(async()=>{const r=envelope(await remote('model_status',{}));return {...checkedStatus(r.value),remoteTarget:r.target,freshness:'remote_checked',checkedAt:now(),scope:'managed_cloud_only'};});}
 async function preview(a){
  if(!exact(a,['enabled'])||typeof a.enabled!=='boolean')fail('ARGUMENTS');
  return run(async()=>{
   plan=null;const r=envelope(await remote('model_preview',a)),v=r.value;
   if(!exact(v,['id','enabled','bindingRevision','credentialRevision','expiresAt','target','provider','endpoint','fingerprint','scope','credentialSlot','modelRequests','defaultModelChanged','cloudTransferred'])||!uuid(v.id)||!hex(v.fingerprint)||v.enabled!==a.enabled||![v.bindingRevision,v.credentialRevision].every(rev)||!Number.isSafeInteger(v.expiresAt)||v.expiresAt<=now()||v.provider!==provider||v.endpoint!==endpoint||v.scope!=='current_host_only'||v.credentialSlot!==slot||v.modelRequests!==0||v.defaultModelChanged!==false||v.cloudTransferred!==false)fail('RESPONSE_REVIEW');identity(v.target);
   const body={id:randomUUID(),enabled:a.enabled,remoteTarget:r.target,target:v.target,endpoint:v.endpoint,expiresAt:Math.min(v.expiresAt,now()+300000),bindingRevision:v.bindingRevision,credentialRevision:v.credentialRevision,scope:'managed_cloud_only'};
   plan={...body,fingerprint:digest({...body,remotePlanId:v.id,remotePlanHash:v.fingerprint}),remotePlanId:v.id,remotePlanHash:v.fingerprint};
   return {...body,fingerprint:plan.fingerprint,modelRequests:0,defaultModelChanged:false,cloudTransferred:false};
  });
 }
 async function apply(a){
  if(!exact(a,['id','fingerprint','confirm'])||!uuid(a.id)||!hex(a.fingerprint)||a.confirm!==true)fail('CONFIRMATION_REQUIRED');
  return run(async()=>{
   const p=plan;if(!p||p.id!==a.id||p.fingerprint!==a.fingerprint||p.expiresAt<=now())fail('PLAN_EXPIRED');
   // Consume before sending. Unknown delivery is reconciled by model_status,
   // whose appliedOperation/planHash comes from the target's durable ledger.
   plan=null;const r=envelope(await remote('model_apply',{id:p.remotePlanId,fingerprint:p.remotePlanHash,confirm:true,targetHash:digest(p.remoteTarget)}));
   if(digest(r.target)!==digest(p.remoteTarget))fail('IDENTITY_REVIEW');const v=checkedStatus(r.value);
   if(v.appliedOperation!==p.remotePlanId||v.appliedPlanHash!==p.remotePlanHash)fail('OUTCOME_UNKNOWN');
   return {...v,remoteTarget:r.target,freshness:'remote_checked',checkedAt:now(),scope:'managed_cloud_only'};
  });
 }
 async function resolve(a){if(!exact(a,['query',...(a?.clarification!==undefined?['clarification']:[])])||!text(a.query,200)||a.clarification!==undefined&&(!text(a.clarification,200)||!a.clarification.trim()))fail('ARGUMENTS');return run(async()=>{const r=envelope(await remote('model_resolve',a));return {...resolution(r.value),remoteTarget:r.target};});}
 return {available,status,preview,apply,resolve,probe:createOnboardingCloudModelProbe({remote,provider,now})};
}
