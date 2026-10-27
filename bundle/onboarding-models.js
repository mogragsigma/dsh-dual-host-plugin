// A separately named native provider. No edits to the official route, settings,
// user credential references or default model. Binding is not a model request.
import {randomUUID,createHash} from 'node:crypto';
import {credentialKey} from '@deepseek-ai/dsh-credentials';
import {LlmError} from '@deepseek-ai/dsh-llm';
import {PUBLIC_BASE_URL,resolveAdapterOptions,catalogModelInfo,registerDeepSeekProvider} from '@deepseek-ai/dsh-llm-deepseek';
import {createOnboardingState} from './onboarding-state.js';
import {ModelSelection} from './model-selection.js';
import {onboardingIdentity} from './onboarding-identity.js';
import {createOnboardingModelProbe} from './onboarding-model-probe.js';
export const ONBOARDING_PROVIDER='dsh-onboarding-deepseek';
const OWNER='dsh-dual-host-onboarding';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join()===keys.sort().join();
const revision=x=>Number.isSafeInteger(x)&&x>=0;
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const fail=c=>{throw Error('ONBOARDING_MODEL_'+c);};
function binding(record){
 if(!record)return null;const p=record.payload;
 if(record.kind!=='grant'||!exact(p,['owner','schema','revision','operation','planHash','enabled','credentialRevision','updatedAt'])||p.owner!==OWNER||p.schema!==1||!revision(p.revision)||p.revision<1||!uuid(p.operation)||!/^[a-f0-9]{64}$/.test(p.planHash)||typeof p.enabled!=='boolean'||!revision(p.credentialRevision)||!Number.isSafeInteger(p.updatedAt))fail('BINDING_REVIEW');
 return p;
}
const deepseek={provider:ONBOARDING_PROVIDER,providerName:'DeepSeek（双端配置）',slot:'deepseek-local',record:'onboarding-model-binding-v1',endpoint:PUBLIC_BASE_URL,
 register(ctx,auth,runtime){
  const options=()=>resolveAdapterOptions({baseURL:PUBLIC_BASE_URL,reasoningEffort:'high',thinking:'enabled'});
  const deps={options,providerName:this.providerName,resolveAuth:async()=>({headers:{'x-api-key':await auth()}}),discoverModels:async provider=>{
   try{await auth();}catch(e){if(e instanceof LlmError&&e.code==='MISSING_CREDENTIAL')return [];throw e;}
   return options().models.map(m=>catalogModelInfo(provider,m));
  }};
  return (runtime.registerProvider??registerDeepSeekProvider)(runtime.modelContext??ctx,this.provider,deps);
 }
};
export function createOnboardingModels(ctx,config={},runtime={}){return createOnboardingModelBinding(ctx,config,runtime,deepseek);}
// Internal seam shared by the two real adapters. RPC callers cannot supply a definition.
export function createOnboardingModelBinding(ctx,config,runtime,definition){
 const {provider,providerName,slot,endpoint}=definition,KEY=credentialKey('dsh-task-gateway',definition.record);
 const state=createOnboardingState(ctx,config,runtime),now=runtime.now??Date.now;
 const target={...onboardingIdentity(config),platform:runtime.platform??process.platform};
 const credentials=()=>runtime.credentials??ctx.credentials,llm=()=>runtime.llm??ctx.llm;
 let registered=false,registering=null,registrationError=null,plan=null;
 const read=async()=>binding(await credentials().readRecord(KEY));
 function available(){return state.available()&&['listProviders','listModels','resolveCallConfig','registerAdapter'].every(k=>typeof llm()?.[k]==='function');}
 function ready(){if(!available())fail('UNAVAILABLE');}
 function collision(){return !registered&&llm().listProviders().some(p=>p.id===provider);}
 async function auth(){
  ready();const b=await read(),s=await state.readManagedSecret(slot);
  if(!b?.enabled||!s.value||b.credentialRevision!==s.revision)throw new LlmError('本项目模型接入未启用或凭据已变化，请在配置导览重新核对。','MISSING_CREDENTIAL');
  return s.value;
 }
 async function register(){
  if(registered)return;
  if(registering)return registering;
  registering=(async()=>{
   if(collision())fail('ROUTE_CONFLICT');
   await definition.register(runtime.modelContext??ctx,auth,runtime);
   registered=true;registrationError=null;
  })();
  try{await registering;}finally{registering=null;}
 }
 async function start(){
  if(!available())return;
  try{if((await read())?.enabled)await register();}catch{registrationError='ONBOARDING_MODEL_REGISTRATION_REVIEW';}
 }
 async function status(){
  if(!available())return {available:false,state:'unavailable',target,verificationRecorded:false};
  const b=await read(),s=await state.readManagedSecret(slot);
  const stale=!!b?.enabled&&(!s.value||b.credentialRevision!==s.revision);
  return {available:true,target,state:registrationError?'needs_review':stale?'credential_changed':b?.enabled&&registered?'configured_unverified':b?.enabled?'registration_pending':b?'disabled':'not_configured',bindingRevision:b?.revision??0,appliedOperation:b?.operation??null,appliedPlanHash:b?.planHash??null,credentialRevision:s.revision,credentialPresent:!!s.value,registered,provider,providerName,endpoint,reasoningEffort:'high',verificationRecorded:false,defaultModelChanged:false,cloudTransferred:false,error:registrationError};
 }
 async function preview(a){
  ready();if(!exact(a,['enabled'])||typeof a.enabled!=='boolean')fail('ARGUMENTS');
  const b=await read(),s=await state.readManagedSecret(slot);
  if(a.enabled&&!s.value)fail('CREDENTIAL_REQUIRED');
  if(a.enabled&&collision())fail('ROUTE_CONFLICT');
  if(a.enabled)await definition.prepare?.();
  const body={id:randomUUID(),enabled:a.enabled,bindingRevision:b?.revision??0,credentialRevision:s.revision,expiresAt:now()+300000,target,provider,endpoint};
  plan={...body,fingerprint:hash(body)};
  return {...plan,scope:'current_host_only',credentialSlot:slot,modelRequests:0,defaultModelChanged:false,cloudTransferred:false};
 }
 async function apply(a){
  ready();if(!exact(a,['id','fingerprint','confirm'])||!uuid(a.id)||typeof a.fingerprint!=='string'||a.confirm!==true)fail('CONFIRMATION_REQUIRED');
  const prior=await read();
  if(prior?.operation===a.id&&prior.planHash===a.fingerprint){if(prior.enabled)await register();return status();}
  const p=plan;if(!p||p.id!==a.id||p.fingerprint!==a.fingerprint||p.expiresAt<=now())fail('PLAN_EXPIRED');
  const s=await state.readManagedSecret(slot);
  if(s.revision!==p.credentialRevision||p.enabled&&!s.value)fail('CREDENTIAL_CHANGED');
  if(p.enabled&&collision())fail('ROUTE_CONFLICT');
  await credentials().modifyRecord(KEY,old=>{
   const b=binding(old);
   if(b?.operation===p.id&&b.planHash===p.fingerprint)return undefined;
   if((b?.revision??0)!==p.bindingRevision)fail('BINDING_CONFLICT');
   return {kind:'grant',payload:{owner:OWNER,schema:1,revision:p.bindingRevision+1,operation:p.id,planHash:p.fingerprint,enabled:p.enabled,credentialRevision:p.credentialRevision,updatedAt:now()}};
  });
  plan=null;
  try{if(p.enabled)await register();}catch{registrationError='ONBOARDING_MODEL_REGISTRATION_REVIEW';}
  return status();
 }
 async function resolve(a){
  ready();if(!exact(a,['query',...(a?.clarification!==undefined?['clarification']:[])])||typeof a.query!=='string'||a.clarification!==undefined&&(typeof a.clarification!=='string'||!a.clarification.trim()||a.clarification.length>200||/[\x00-\x1f\x7f]/.test(a.clarification)))fail('ARGUMENTS');
  // Discovery reads the actual current Host catalog. It does not send inference
  // requests, store a default, dispatch a worker or choose a similar version.
  const selector=new ModelSelection({c:{role:'local',modelSelection:config.modelSelection},ctx:{llm:llm()},now});
  return {...await selector.resolve({host:'local',query:a.query,...(a.clarification!==undefined?{provider_hint:a.clarification}:{}),reasoningEffort:'high'}),host:'current',defaultModelChanged:false};
 }
 const probe=createOnboardingModelProbe({credentials,llm,snapshot:status,resolve,provider,recordName:definition.record,now,admit:runtime.admit});
 return {available,start,status,preview,apply,resolve,probe};
}
