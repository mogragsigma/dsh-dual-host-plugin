// Confirmed repository configuration, not a task association or write grant.
// Only the official credential store owns persistence/locking. Drafts never activate it.
import {credentialKey} from '@deepseek-ai/dsh-credentials';
import {randomUUID} from 'node:crypto';
import {digest} from './onboarding-ssh.js';
import {repositoryURL} from './repository-gitee.js';
import {onboardingIdentity} from './onboarding-identity.js';
const KEY=credentialKey('dsh-task-gateway','onboarding-repositories-v1'),OWNER='dsh-dual-host-onboarding';
const exact=(x,ks)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join()===ks.slice().sort().join();
const revision=x=>Number.isSafeInteger(x)&&x>=0&&x<Number.MAX_SAFE_INTEGER-1;
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const fail=c=>{throw Error('ONBOARDING_REPOSITORY_'+c);};
export const repositoryAlias=x=>typeof x==='string'?x.normalize('NFKC').trim().toLowerCase():'';
export function repositoryRegistrationInput(a){
 if(!exact(a,['url','alias','authentication','enabled'])||typeof a.alias!=='string'||!repositoryAlias(a.alias)||a.alias.length>120||/[\x00-\x1f\x7f]/.test(a.alias)||/^(?:https:|git@)/i.test(a.alias.normalize('NFKC').trim())||!['anonymous','managed'].includes(a.authentication)||typeof a.enabled!=='boolean')fail('REGISTRY_ARGUMENTS');
 let url;try{url=repositoryURL(a.url).url;}catch{fail('REGISTRY_ARGUMENTS');}
 return {url,alias:a.alias.trim(),authentication:a.authentication,enabled:a.enabled};
}
function entry(a){
 if(!exact(a,['url','alias','authentication','enabled','repositoryId','verifiedAt'])||!Number.isSafeInteger(a.repositoryId)||a.repositoryId<1||!Number.isSafeInteger(a.verifiedAt)||a.verifiedAt<0)fail('REGISTRY_REVIEW');
 const v=repositoryRegistrationInput({url:a.url,alias:a.alias,authentication:a.authentication,enabled:a.enabled});if(v.url!==a.url||v.alias!==a.alias)fail('REGISTRY_REVIEW');return a;
}
function identity(t){
 if(!exact(t,['role','name','source','platform'])||!['local','cloud','unassigned'].includes(t.role)||!['darwin','linux','win32'].includes(t.platform)||!['setup_configuration','gateway_configuration','unassigned'].includes(t.source)||typeof t.name!=='string'||t.name.length>80)fail('REGISTRY_REVIEW');return t;
}
export function repositoryRegistryStatus(v){
 if(!exact(v,['contract','scope','target','revision','appliedOperation','appliedPlanHash','updatedAt','entries','runtimeConfigured','taskBound','writeAuthorized'])||v.contract!==2||v.scope!=='current_host_only'||!revision(v.revision)||typeof v.runtimeConfigured!=='boolean'||v.taskBound!==false||v.writeAuthorized!==false)fail('REGISTRY_REVIEW');
 identity(v.target);
 if(v.revision===0){if(v.appliedOperation!==null||v.appliedPlanHash!==null||v.updatedAt!==null||!Array.isArray(v.entries)||v.entries.length)fail('REGISTRY_REVIEW');}
 else record({kind:'grant',payload:{owner:OWNER,schema:1,revision:v.revision,operation:v.appliedOperation,planHash:v.appliedPlanHash,updatedAt:v.updatedAt,entries:v.entries}});
 return structuredClone(v);
}
export function repositoryRegistryPlan(v){
 if(!exact(v,['id','target','entry','registryRevision','credentialRevision','expiresAt','fingerprint','scope','taskBound','writeAuthorized'])||!uuid(v.id)||!hex(v.fingerprint)||!revision(v.registryRevision)||!revision(v.credentialRevision)||!Number.isSafeInteger(v.expiresAt)||v.expiresAt<0||v.scope!=='current_host_only'||v.taskBound!==false||v.writeAuthorized!==false)fail('REGISTRY_REVIEW');
 identity(v.target);entry(v.entry);const {scope,taskBound,writeAuthorized,fingerprint,...body}=v;if(digest(body)!==fingerprint)fail('REGISTRY_REVIEW');
 if(v.entry.enabled&&v.entry.authentication==='managed'?!v.credentialRevision:v.credentialRevision!==0)fail('REGISTRY_REVIEW');return structuredClone(v);
}
function record(r){
 if(!r)return null;const p=r.payload;
 if(r.kind!=='grant'||!exact(p,['owner','schema','revision','operation','planHash','updatedAt','entries'])||p.owner!==OWNER||p.schema!==1||!revision(p.revision)||!p.revision||!uuid(p.operation)||!hex(p.planHash)||!Number.isSafeInteger(p.updatedAt)||!Array.isArray(p.entries)||p.entries.length>100)fail('REGISTRY_REVIEW');
 p.entries.forEach(entry);
 if(new Set(p.entries.map(e=>e.url.toLowerCase())).size!==p.entries.length||new Set(p.entries.filter(e=>e.enabled).map(e=>repositoryAlias(e.alias))).size!==p.entries.filter(e=>e.enabled).length)fail('REGISTRY_REVIEW');
 return p;
}
export function createOnboardingRepositories({state,credentials,repository,config={},runtime={},now=Date.now}){
 let pending=null,busy=false;
 const target={...onboardingIdentity(config),platform:runtime.platform??process.platform};
 const available=()=>state.available()&&!!credentials();
 const ready=()=>{if(!available())fail('REGISTRY_UNAVAILABLE');return credentials();};
 async function read(){return record(await ready().readRecord(KEY));}
 function view(p){return {contract:2,scope:'current_host_only',target,revision:p?.revision??0,appliedOperation:p?.operation??null,appliedPlanHash:p?.planHash??null,updatedAt:p?.updatedAt??null,entries:structuredClone(p?.entries??[]),runtimeConfigured:runtime.repositoryRuntime===true||config.role==='cloud'&&config.repositoryAccess?.managedOnboarding===true,taskBound:false,writeAuthorized:false};}
 async function run(fn){if(busy)fail('BUSY');busy=true;try{return await fn();}finally{busy=false;}}
 async function status(a){if(!exact(a,[]))fail('REGISTRY_ARGUMENTS');return view(await read());}
 async function preview(raw){return run(async()=>{
  pending=null;const a=repositoryRegistrationInput(raw),old=await read(),entries=old?.entries??[],previous=entries.find(e=>e.url.toLowerCase()===a.url.toLowerCase());
  if(a.enabled&&entries.some(e=>e.enabled&&e!==previous&&repositoryAlias(e.alias)===repositoryAlias(a.alias)))fail('ALIAS_CONFLICT');
  if(!previous&&entries.length>=100)fail('REGISTRY_LIMIT');
  let e,credentialRevision=0;
  if(a.enabled){const check=await repository.inspect({url:a.url,branch:'',authentication:a.authentication});credentialRevision=check.credentialRevision;e={...a,url:check.repository.url,repositoryId:check.repository.repository_id,verifiedAt:check.observedAt};}
  else {if(!previous||previous.alias!==a.alias||previous.authentication!==a.authentication)fail('REGISTRATION_NOT_FOUND');e={...previous,enabled:false};}
  if((await read())?.revision!==old?.revision)fail('REGISTRY_CONFLICT');
  const body={id:randomUUID(),target,entry:e,registryRevision:old?.revision??0,credentialRevision,expiresAt:now()+300000};
  pending={...body,fingerprint:digest(body)};
  return {...pending,scope:'current_host_only',taskBound:false,writeAuthorized:false};
 });}
 async function apply(a){return run(async()=>{
  if(!exact(a,['id','fingerprint','confirm'])||!uuid(a.id)||!hex(a.fingerprint)||a.confirm!==true)fail('CONFIRMATION_REQUIRED');
  const p=pending;if(!p||p.id!==a.id||p.fingerprint!==a.fingerprint||p.expiresAt<=now())fail('PLAN_EXPIRED');
  // Consume before the write; after an unknown result use status, never replay.
  pending=null;
  if(p.entry.enabled&&p.entry.authentication==='managed'){const s=await state.readManagedSecret('gitee');if(!s.value||s.revision!==p.credentialRevision)fail('CREDENTIAL_CHANGED');}
  await ready().modifyRecord(KEY,old=>{
   const r=record(old);if((r?.revision??0)!==p.registryRevision)fail('REGISTRY_CONFLICT');
   const entries=[...(r?.entries??[])],i=entries.findIndex(e=>e.url.toLowerCase()===p.entry.url.toLowerCase());
   if(i<0)entries.push(p.entry);else entries[i]=p.entry;
   return {kind:'grant',payload:{owner:OWNER,schema:1,revision:p.registryRevision+1,operation:p.id,planHash:p.fingerprint,updatedAt:now(),entries}};
  });return status({});
 });}
 async function fence(a){return run(async()=>{
  if(!exact(a,['operation','expectedRevision','confirm'])||!uuid(a.operation)||!revision(a.expectedRevision)||a.confirm!==true)fail('CONFIRMATION_REQUIRED');
  // Preserve entries while advancing the CAS generation. A delayed old apply
  // can no longer win; never clear configuration to resolve an unknown outcome.
  await ready().modifyRecord(KEY,old=>{const p=record(old);if((p?.revision??0)!==a.expectedRevision)fail('REGISTRY_CONFLICT');return {kind:'grant',payload:{owner:OWNER,schema:1,revision:a.expectedRevision+1,operation:a.operation,planHash:digest(a),updatedAt:now(),entries:p?.entries??[]}};});
  return status({});
 });}
 return {available,status,preview,apply,fence};
}
