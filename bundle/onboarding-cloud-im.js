// Cloud IM observations use the exact managed runtime and its archived contract.
// No local fallback, native credential reads, bot activation or consumer acquisition.
import {handoffTarget} from './onboarding-handoff.js';
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join()===keys.sort().join();
const count=x=>Number.isSafeInteger(x)&&x>=0&&x<=512;
const fail=code=>{throw Error('ONBOARDING_CLOUD_IM_'+code);};
export function validateCloudImInventory(v){
 const success=['listed','no_bots'].includes(v?.state);
 const fields=['contract','target','state','observedAt','notAuthorization','consumerAcquired','platformIdentityVerified','messagesSent',...(success?['botsConfigured','channels']:[])];
 if(!exact(v,fields)||v.contract!==1||!['listed','no_bots','missing_dependency','unsupported_contract','provider_changed','needs_review'].includes(v.state)||!Number.isSafeInteger(v.observedAt)||v.observedAt<0||v.notAuthorization!==true||v.consumerAcquired!==false||v.platformIdentityVerified!==false||v.messagesSent!==0)fail('RESPONSE_REVIEW');
 const t=v.target;
 if(!exact(t,['role','name','source','platform'])||t.role!=='cloud'||t.platform!=='linux'||t.name!=='云端大肥鱼'||!['setup_configuration','gateway_configuration'].includes(t.source))fail('IDENTITY_REVIEW');
 if(success){
  if(!count(v.botsConfigured)||!Array.isArray(v.channels)||v.channels.length>512||(v.state==='no_bots')!==(v.botsConfigured===0))fail('RESPONSE_REVIEW');
  const seen=new Set();let total=0;
  for(const row of v.channels){if(!exact(row,['channel','count'])||typeof row.channel!=='string'||!/^[a-z][a-z0-9-]{0,31}$/.test(row.channel)||seen.has(row.channel)||!count(row.count)||!row.count)fail('RESPONSE_REVIEW');seen.add(row.channel);total+=row.count;}
  if(total!==v.botsConfigured)fail('RESPONSE_REVIEW');
 }
 return structuredClone(v);
}
export function createOnboardingCloudIm({remote,enabled,now=Date.now}){
 let busy=false;
 const available=()=>enabled();
 async function inventory(args){
  if(!exact(args,[]))fail('ARGUMENTS');if(!available())fail('DISABLED');if(busy)fail('BUSY');busy=true;
  try{
   const result=await remote('im_inventory',{});
   if(!exact(result,['target','value']))fail('RESPONSE_REVIEW');
   const target=handoffTarget(result.target),value=validateCloudImInventory(result.value);
   return {...value,remoteTarget:target,checkedAt:now(),freshness:'remote_checked',scope:'managed_cloud_only',initializationComplete:false};
  }finally{busy=false;}
 }
 return {available,inventory};
}
