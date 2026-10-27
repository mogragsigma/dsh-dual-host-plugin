// Manual metadata checks only. No clone, key generation, task binding or Git writes.
import {GiteeReadOnly,repositoryURL,repositoryBranch} from './repository-gitee.js';
import {onboardingIdentity} from './onboarding-identity.js';
import {handoffTarget} from './onboarding-handoff.js';
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===keys.sort().join();
const fail=code=>{throw Error('ONBOARDING_REPOSITORY_'+code);};
export function repositoryCheckArgs(a){
 if(!exact(a,['url','branch','authentication'])||!['anonymous','managed'].includes(a.authentication)||typeof a.branch!=='string')fail('ARGUMENTS');
 try{return {url:repositoryURL(a.url).url,branch:a.branch?repositoryBranch(a.branch):'',authentication:a.authentication};}catch{fail('ARGUMENTS');}
}
export function repositoryCheckResult(v,a){
 if(!exact(v,['contract','scope','target','observedAt','repository','authentication','credentialRevision','taskBound','writeAuthorized'])||v.contract!==1||v.scope!=='current_host'||!Number.isSafeInteger(v.observedAt)||v.observedAt<0||v.authentication!==a.authentication||!Number.isSafeInteger(v.credentialRevision)||v.credentialRevision<0||a.authentication==='managed'&&v.credentialRevision<1||a.authentication==='anonymous'&&v.credentialRevision!==0||v.taskBound!==false||v.writeAuthorized!==false)fail('RESPONSE_REVIEW');
 const t=v.target,r=v.repository;
 if(!exact(t,['role','name','source','platform'])||!['local','cloud','unassigned'].includes(t.role)||!['darwin','linux','win32'].includes(t.platform)||typeof t.name!=='string'||t.name.length>80||!['setup_configuration','gateway_configuration','unassigned'].includes(t.source))fail('RESPONSE_REVIEW');
 if(!exact(r,['provider','repository_id','url','branch','base_sha','private','workspace'])||r.provider!=='gitee'||!Number.isSafeInteger(r.repository_id)||r.repository_id<1||typeof r.private!=='boolean'||r.workspace!==null||typeof r.base_sha!=='string'||!/^[a-f0-9]{40}$/.test(r.base_sha))fail('RESPONSE_REVIEW');
 try{if(repositoryURL(r.url).url!==r.url||r.url.toLowerCase()!==a.url.toLowerCase()||repositoryBranch(r.branch)!==r.branch||a.branch&&r.branch!==a.branch)fail('RESPONSE_REVIEW');}catch{fail('RESPONSE_REVIEW');}
 return structuredClone(v);
}
const providerErrors=new Set(['REPOSITORY_DEFAULT_BRANCH_REQUIRED','REPOSITORY_NOT_FOUND_OR_PRIVATE','REPOSITORY_ACCESS_DENIED','REPOSITORY_RATE_LIMIT','REPOSITORY_PROVIDER_UNAVAILABLE','REPOSITORY_RESPONSE_TOO_LARGE','REPOSITORY_RESPONSE_INVALID','REPOSITORY_IDENTITY_MISMATCH','REPOSITORY_BRANCH_RESPONSE_INVALID']);
export function createOnboardingRepository({state,config={},runtime={},now=Date.now}){
 let busy=false;
 async function inspect(raw){
  const a=repositoryCheckArgs(raw);if(busy)fail('BUSY');busy=true;
  try{
   const credential=a.authentication==='managed'?await state.readManagedSecret('gitee'):null;
   if(credential&&!credential.value)fail('CREDENTIAL_REQUIRED');
   let provider;
   try{provider=new GiteeReadOnly({}, {fetch:runtime.repositoryFetch,...(credential?{token:credential.value}:{})});}catch{fail('CREDENTIAL_INVALID');}
   const repository=await provider.inspect(a.url,a.branch||undefined);
   if(credential&&(await state.readManagedSecret('gitee')).revision!==credential.revision)fail('CREDENTIAL_CHANGED');
   return repositoryCheckResult({contract:1,scope:'current_host',target:{...onboardingIdentity(config),platform:runtime.platform??process.platform},observedAt:now(),repository,authentication:a.authentication,credentialRevision:credential?.revision??0,taskBound:false,writeAuthorized:false},a);
  }catch(e){if(providerErrors.has(e.message))throw Error('ONBOARDING_'+e.message);if(/^ONBOARDING_(REPOSITORY|PERSISTENCE|STATE)_/.test(e.message))throw e;fail('RESPONSE_REVIEW');}
  finally{busy=false;}
 }
 return {inspect};
}
export function createOnboardingCloudRepository({remote,enabled,now=Date.now}){
 let busy=false;
 async function inspect(raw){
  const a=repositoryCheckArgs(raw);if(!enabled())fail('CLOUD_DISABLED');if(busy)fail('BUSY');busy=true;
  try{
   const r=await remote('repository_inspect',a);if(!exact(r,['target','value']))fail('RESPONSE_REVIEW');
   const remoteTarget=handoffTarget(r.target),v=repositoryCheckResult(r.value,a);
   if(v.target.role!=='cloud'||v.target.platform!=='linux'||v.target.name!=='云端大肥鱼')fail('IDENTITY_REVIEW');
   return {...v,scope:'managed_cloud_only',remoteTarget,checkedAt:now()};
  }finally{busy=false;}
 }
 return {available:()=>enabled(),inspect};
}
