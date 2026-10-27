// Optional public IM inventory. Never owns credentials, consumers or bot activation.
import {onboardingIdentity} from './onboarding-identity.js';
const record=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
export function createOnboardingIm(config={},runtime={}){
 const service=()=>runtime.im,target={...onboardingIdentity(config),platform:runtime.platform??process.platform};
 const now=runtime.now??Date.now;
 function capability(){
  const s=service();
  return !s?'missing_dependency':s.contractVersion!==1||typeof s.listBots!=='function'?'unsupported_contract':'available';
 }
 async function inventory(args){
  if(!record(args)||Object.keys(args).length)throw Error('ONBOARDING_INVALID_ARGUMENTS');
  const state=capability(),base={contract:1,target,state,observedAt:now(),notAuthorization:true,consumerAcquired:false,platformIdentityVerified:false,messagesSent:0};
  if(state!=='available')return base;
  const s=service();let timer;
  try{
   const rows=await Promise.race([Promise.resolve().then(()=>s.listBots()),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),runtime.timeoutMs??10000);})]);
   if(service()!==s)return {...base,state:'provider_changed'};
   if(!Array.isArray(rows)||rows.length>512)throw Error('invalid_inventory');
   const ids=new Set(),channels=new Map();
   for(const row of rows){
    if(!record(row)||typeof row.botId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(row.botId)||typeof row.channel!=='string'||!/^[a-z][a-z0-9-]{0,31}$/.test(row.channel)||ids.has(row.botId))throw Error('invalid_inventory');
    ids.add(row.botId);channels.set(row.channel,(channels.get(row.channel)??0)+1);
   }
   // Inventory is not connected-account evidence. Do not return IDs, routes or arbitrary provider fields.
   return {...base,state:rows.length?'listed':'no_bots',observedAt:now(),botsConfigured:rows.length,channels:[...channels].sort(([a],[b])=>a.localeCompare(b)).map(([channel,count])=>({channel,count}))};
  }catch{return {...base,state:service()===s?'needs_review':'provider_changed'};}
  finally{clearTimeout(timer);}
 }
 return {capability,inventory};
}
