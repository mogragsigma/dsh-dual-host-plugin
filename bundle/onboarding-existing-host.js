// Inspect an already configured pair without adopting its Host, credentials or
// lifecycle. This is evidence for onboarding, never an installation receipt.
import {createHash} from 'node:crypto';
import {validateHello} from './link-contract.js';
const object=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
const empty=x=>object(x)&&Object.keys(x).length===0;
const exact=(x,keys)=>object(x)&&Object.keys(x).sort().join()===keys.slice().sort().join();
const text=(x,n=4096)=>typeof x==='string'&&x.length>0&&x.length<=n&&!/[\x00-\x1f\x7f]/.test(x);
const count=x=>Number.isSafeInteger(x)&&x>=0&&x<=65536;
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fail=c=>{throw Error('ONBOARDING_EXISTING_'+c);};
const states=['unavailable','not_installed','committed','inspected','uninstalled','removed','rolled_back','needs_review','applying','rolling_back'];
export function existingHostView(v){
 if(!exact(v,['contract','host','platform','nodeVersion','paths','rules','models','im','runtime','observedAt','scope'])||v.contract!==1||v.scope!=='existing_host_read_only'||!Number.isSafeInteger(v.observedAt))fail('RESPONSE_INVALID');
 const h=validateHello(v.host);
 if(!['darwin','linux','win32','freebsd','openbsd','sunos','aix','android'].includes(v.platform)||!text(v.nodeVersion,64))fail('RESPONSE_INVALID');
 if(!exact(v.paths,['dsh','agents','source','loadingVerified'])||!text(v.paths.dsh)||!text(v.paths.agents)||(v.paths.source!=='target_host_resolution'||v.paths.loadingVerified!==false))fail('RESPONSE_INVALID');
 if(!exact(v.rules,['state','files','activationVerified'])||!states.includes(v.rules.state)||!count(v.rules.files)||v.rules.activationVerified!==false)fail('RESPONSE_INVALID');
 if(!exact(v.models,['state','providers','models','catalogFingerprint','inferenceVerified'])||!['listed','catalog_incomplete','unavailable'].includes(v.models.state)||!count(v.models.providers)||!count(v.models.models)||v.models.inferenceVerified!==false||!(v.models.catalogFingerprint===null||/^[a-f0-9]{64}$/.test(v.models.catalogFingerprint)))fail('RESPONSE_INVALID');
 if(!exact(v.im,['state','botsConfigured','connectionVerified'])||!['listed','no_bots','missing_dependency','unsupported_contract','provider_changed','needs_review'].includes(v.im.state)||!count(v.im.botsConfigured)||v.im.connectionVerified!==false)fail('RESPONSE_INVALID');
 if(!exact(v.runtime,['scheduler','activeRuns','repositoryAdapter','repositoryAccessVerified','development','publish'])||!count(v.runtime.activeRuns)||['scheduler','repositoryAdapter','development','publish'].some(k=>typeof v.runtime[k]!=='boolean')||v.runtime.repositoryAccessVerified!==false)fail('RESPONSE_INVALID');
 // Reconstruct the view; no provider extras, credential paths, bot IDs, tokens,
 // tasks, session text or arbitrary upstream fields cross this interface.
 return {contract:1,host:{role:h.role,instance_id:h.instance_id,plugin_version:h.plugin_version},platform:v.platform,nodeVersion:v.nodeVersion,paths:{...v.paths},rules:{...v.rules},models:{...v.models},im:{...v.im},runtime:{...v.runtime},observedAt:v.observedAt,scope:v.scope};
}
export function createExistingHostInspection({gateway,detect,installer,im,now=Date.now}){
 let pending=null,closed=false;
 function current(){const g=gateway();if(closed||!g||g.closed)fail('UNAVAILABLE');return g;}
 function unchanged(g,id){if(current()!==g||g.instanceId!==id)fail('HOST_CHANGED');}
 async function inspectHost(a){
  if(!empty(a))fail('ARGUMENTS');
  const g=current(),id=g.instanceId,h=g.hello(),env=await detect();
  validateHello(h);if(env.role!==h.role||h.instance_id!==id)fail('IDENTITY_CONFLICT');
  let rules={state:'unavailable',files:0,activationVerified:false};
  if(installer.available())try{const r=await installer.status();rules={state:states.includes(r.state)?r.state:'needs_review',files:Array.isArray(r.files)?r.files.length:0,activationVerified:false};}catch{rules.state='needs_review';}
  let models={state:'unavailable',providers:0,models:0,catalogFingerprint:null,inferenceVerified:false};
  if(g.modelSelection?.available())try{
   const r=await g.modelSelection.catalog();
   if(!Array.isArray(r.items)||!Array.isArray(r.errors)||r.items.length>4096||r.errors.length>64)throw Error('invalid_catalog');
   const rows=r.items.map(x=>{if(!text(x.provider,200)||!text(x.model,200))throw Error('invalid_catalog');return {provider:x.provider,model:x.model};}).sort((a,b)=>a.provider.localeCompare(b.provider)||a.model.localeCompare(b.model));
   models={state:r.errors.length?'catalog_incomplete':'listed',providers:new Set(rows.map(x=>x.provider)).size,models:rows.length,catalogFingerprint:digest(rows),inferenceVerified:false};
  }catch{}
  let inventory={state:'needs_review',botsConfigured:0};try{inventory=await im.inventory({});}catch{}
  unchanged(g,id);
  const result={contract:1,host:h,platform:env.platform,nodeVersion:env.nodeVersion,paths:{dsh:env.paths.dsh.path,agents:env.paths.agents.path,source:'target_host_resolution',loadingVerified:false},rules,models,im:{state:inventory.state,botsConfigured:inventory.botsConfigured??0,connectionVerified:false},runtime:{scheduler:g.scheduler?.started===true&&!g.scheduler.closed,activeRuns:g.scheduler?.active.size??0,repositoryAdapter:!!g.repositories?.provider,repositoryAccessVerified:false,development:!!g.development?.gate?.enabled,publish:false},observedAt:now(),scope:'existing_host_read_only'};
  existingHostView(result);return result;
 }
 async function inspectPair(a){
  if(!empty(a))fail('ARGUMENTS');
  if(pending)return pending;
  pending=(async()=>{
   const g=current(),id=g.instanceId;if(g.c.role!=='local'||!g.link)fail('LOCAL_ENTRY_REQUIRED');
   const local=await inspectHost({});unchanged(g,id);
   // A fresh authenticated protocol operation, not diagnostics' cached fallback.
   const proof=await g.link.call('onboarding_existing_inspect',{});unchanged(g,id);
   const remote=proof.result,observation=proof.observation;
   if(observation?.freshness!=='live_response'||observation.authority!=='cloud'||observation.instance_id!==remote?.host?.instance_id||remote?.host?.role!=='cloud'||remote.host.namespace!==local.host.namespace)fail('PEER_CHANGED');
   const value={contract:1,local:existingHostView(local),cloud:existingHostView(remote),observedAt:now(),expiresAt:now()+60000,scope:'existing_pair_review_only',configurationChanged:false,installationOwned:false,executionAuthorized:false,endToEndVerified:false};
   return value;
  })();try{return await pending;}finally{pending=null;}
 }
 return {available:()=>{const g=gateway();return !closed&&!!g&&!g.closed&&g.c.role==='local'&&!!g.link;},inspectHost,inspectPair,dispose(){closed=true;}};
}
