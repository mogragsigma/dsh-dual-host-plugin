// Shared own-bundle lifecycle transaction. Targets are fixed by code, never RPC input.
// Official manager alone owns package/profile changes; user data is not deleted here.
import {randomUUID,createHash} from 'node:crypto';
import {credentialKey} from '@deepseek-ai/dsh-credentials';
import {createMaintenanceProcessIdentity,validMaintenanceProcess} from './maintenance-process-identity.js';
export function createOnboardingSelfLifecycle(operation,options){
 if(!['disable','remove'].includes(operation))throw Error('ONBOARDING_SELF_LIFECYCLE_OPERATION');
 const removing=operation==='remove',NAME='@mogragsigma/dsh-dual-host-plugin';
 const KEY=credentialKey('dsh-task-gateway','self-'+operation+'-v1'),OWNER='dsh-own-bundle-'+operation;
 const PEER_KEY=credentialKey('dsh-task-gateway','self-'+(removing?'disable':'remove')+'-v1'),PEER_OWNER='dsh-own-bundle-'+(removing?'disable':'remove');
 const ACTION=removing?'remove_own_bundle':'disable_own_bundle',SCOPE=removing?'current_host_own_bundle_dependency_only':'current_host_own_bundle_selection_only';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,k)=>object(v)&&Object.keys(v).sort().join()===k.slice().sort().join();
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const fail=c=>{throw Error('ONBOARDING_SELF_'+operation.toUpperCase()+'_'+c);};
const states=['intent','unknown','not_dispatched','saved_restart_required','manager_applied','manager_rejected','reconciled'];
const applications=['applied','restart-required','overridden','failed','cancelled'];
const reasons=['no-hmr','package-moved','host-module','unmanaged-plugin','module-comparison'];
function receipt(r){
 if(!object(r)||r.target!==NAME||r.stage!==(removing?'remove':'enable')||(!removing&&r.enabled!==false)||typeof r.changed!=='boolean'||!applications.includes(r.application))return null;
 if(r.restartReason!==undefined&&!reasons.includes(r.restartReason))return null;
 return {changed:r.changed,application:r.application,restartReason:r.restartReason??null,hasError:!!r.error};
}
function decode(r,expectedOwner=OWNER){
 if(r==null)return {owner:expectedOwner,schema:1,revision:0,entries:[]};const p=r.payload;
 if(r.kind!=='grant'||!exact(p,['owner','schema','revision','entries'])||p.owner!==expectedOwner||p.schema!==1||!integer(p.revision)||p.revision<1||!Array.isArray(p.entries)||p.entries.length>32)fail('LEDGER_REVIEW');
 const ids=new Set();for(const e of p.entries){
  if(!exact(e,['id','instanceId','fingerprint','identityDigest','version','maintenanceId','ownerProcess','createdAt','updatedAt','state','result','review'])||![e.id,e.instanceId,e.maintenanceId].every(uuid)||![e.fingerprint,e.identityDigest].every(digest)||!validMaintenanceProcess(e.ownerProcess)||!integer(e.createdAt)||!integer(e.updatedAt)||e.updatedAt<e.createdAt||!states.includes(e.state)||typeof e.version!=='string'||e.version.length>128||ids.has(e.id))fail('LEDGER_REVIEW');
  if(e.result!==null&&(!exact(e.result,['changed','application','restartReason','hasError'])||typeof e.result.changed!=='boolean'||!applications.includes(e.result.application)||e.result.restartReason!==null&&!reasons.includes(e.result.restartReason)||typeof e.result.hasError!=='boolean'))fail('LEDGER_REVIEW');
  if(e.review!==null&&(!exact(e.review,['at','observerInstanceId','bundleEnabled','originalOutcomeProven'])||!integer(e.review.at)||!uuid(e.review.observerInstanceId)||typeof e.review.bundleEnabled!=='boolean'||e.review.originalOutcomeProven!==false))fail('LEDGER_REVIEW');
  if(['intent','unknown','not_dispatched','reconciled'].includes(e.state)&&e.result!==null||['saved_restart_required','manager_applied','manager_rejected'].includes(e.state)&&e.result===null)fail('LEDGER_REVIEW');
  if(e.state==='saved_restart_required'&&(e.result.application!=='restart-required'||e.result.hasError)||e.state==='manager_applied'&&(e.result.application!=='applied'||e.result.hasError)||e.state==='manager_rejected'&&!e.result.hasError&&!['failed','overridden','cancelled'].includes(e.result.application))fail('LEDGER_REVIEW');
  if(e.state==='reconciled'&&e.review===null||e.state!=='reconciled'&&e.review!==null)fail('LEDGER_REVIEW');ids.add(e.id);
 }
 if(p.entries.slice(0,-1).some(e=>['intent','unknown'].includes(e.state)))fail('LEDGER_REVIEW');return structuredClone(p);
}
const pending=e=>e&&['intent','unknown'].includes(e.state);
function create({inspection,manager,credentials,maintenance,enabled=()=>true,processIdentity=createMaintenanceProcessIdentity(),now=Date.now}){
 const instanceId=randomUUID();let busy=false,closed=false,plan=null;const observed=new Map();
 const identity=e=>({id:e.id,instanceId:e.instanceId,fingerprint:e.fingerprint,identityDigest:e.identityDigest,version:e.version,maintenanceId:e.maintenanceId,ownerProcess:e.ownerProcess,createdAt:e.createdAt});
 const available=()=>{try{return enabled()&&!!credentials()&&typeof credentials().modifyRecord==='function'&&typeof credentials().readRecord==='function'&&typeof manager()?.[removing?'removeBundle':'setBundleEnabled']==='function';}catch{return false;}};
 const provider=()=>{if(closed)fail('CLOSED');if(!available())fail('UNAVAILABLE');return credentials();};
 const check=c=>{if(closed||credentials()!==c)fail('PROVIDER_CHANGED');};
 async function read(c,key=KEY,owner=OWNER){const p=decode(await c.readRecord(key),owner);check(c);const seen=observed.get(key)??{revision:0,ids:new Map()};if(p.revision<seen.revision||[...seen.ids].some(([id,h])=>!p.entries.some(e=>e.id===id&&hash(identity(e))===h)))fail('LEDGER_CHANGED');for(const e of p.entries)seen.ids.set(e.id,hash(identity(e)));seen.revision=p.revision;observed.set(key,seen);return p;}
 async function peer(c){const p=await read(c,PEER_KEY,PEER_OWNER);if(p.entries.some(pending))fail('OTHER_LIFECYCLE_RECOVERY_REQUIRED');return hash(p);}
 async function write(c,p,fn){let result;check(c);await c.modifyRecord(KEY,old=>{const v=decode(old);if(v.revision!==p.revision||hash(v)!==hash(p))fail('REVISION_CHANGED');if(v.revision>=Number.MAX_SAFE_INTEGER-1)fail('LEDGER_REVIEW');result={...v,revision:v.revision+1,entries:fn(v.entries)};decode({kind:'grant',payload:result});return {kind:'grant',payload:result};});check(c);if(!result)fail('LEDGER_REVIEW');return result;}
 const row=e=>e?{id:e.id,state:e.state,version:e.version,createdAt:e.createdAt,updatedAt:e.updatedAt,result:e.result,review:e.review}:null;
 const view=p=>({contract:1,queryContract:1,scope:SCOPE,instanceId,revision:p.revision,operationInFlight:busy,receipt:row(p.entries.at(-1)),historyCount:p.entries.length,pending:!!pending(p.entries.at(-1)),hostStopped:false,packageRemoved:false,packageRemovalProven:false,packageRemovalRequested:removing&&p.entries.length>0,rulesOrSkillsRemoved:false,executionAuthorized:false,automaticRestart:false,externalRecovery:removing?'official_reinstall_verified_source':'official_plugin_manager',observedAt:now()});
 async function serial(fn){if(closed)fail('CLOSED');if(busy)fail('BUSY');busy=true;try{const v=await fn();if(v&&Object.hasOwn(v,'operationInFlight'))v.operationInFlight=false;return v;}finally{busy=false;}}
 const empty=a=>{if(!exact(a,[]))fail('ARGUMENTS');};
 async function own(){const s=await inspection.status({});if(s.state!=='profile_bundle_observed'||s.bundle.version===null||s.bundle.enabled!==true||s.entry.phase!=='active'||(removing&&s.packageRemovalListed!==true))fail('OWNERSHIP_REVIEW');return {identityDigest:s.identityDigest,version:s.bundle.version,entry:s.entry,bundle:s.bundle};}
 function held(s){
  if(s.state!=='held'||s.operationInFlight||s.admission?.local!=='fenced'||s.admission?.durable?.state!=='fenced'||s.live?.state!=='held'||!uuid(s.receipt?.id)||s.live.operationId!==s.receipt.id)fail('MAINTENANCE_REQUIRED');
  const c=s.live.components;if(!c||c.onboarding?.state!=='held'||c.agents?.state!=='held'||!['held','not_configured'].includes(c.gateway?.state))fail('MAINTENANCE_REQUIRED');
  for(const name of ['onboarding','gateway'])if(c[name].counts&&Object.values(c[name].counts).some(n=>!integer(n)||n!==0))fail('BUSY');
  const a=c.agents;if(a.inboxState!=='empty'||!a.counts||['running','unsupported','pendingNextTurn','pendingNextStep','inboxUnknown'].some(k=>!integer(a.counts[k])||a.counts[k]!==0))fail('BUSY');
  return {id:s.receipt.id,coordinator:s.live.instanceId,components:Object.fromEntries(Object.entries(c).map(([k,v])=>[k,{state:v.state,instanceId:v.instanceId??null,operationId:v.operationId??null}]))};
 }
 const save=(body,extra)=>{plan={body:{...body,fingerprint:hash(body)},...extra};return structuredClone(plan.body);};
 function checked(a,action){if(!exact(a,['id','fingerprint','confirm','acceptRisk'])||a.confirm!==true||a.acceptRisk!==true)fail('CONFIRMATION_REQUIRED');if(!plan||plan.body.action!==action||plan.body.id!==a.id||plan.body.fingerprint!==a.fingerprint||plan.body.expiresAt<=now())fail('PLAN_EXPIRED');return plan;}
 async function status(a={}){if(!exact(a,[])&&!(exact(a,['operationId'])&&uuid(a.operationId)))fail('ARGUMENTS');const p=await read(provider());return {...view(p),...(a.operationId?{requestedOperationId:a.operationId,requestedReceipt:row(p.entries.find(e=>e.id===a.operationId))}:{})};}
 async function preview(a={}){empty(a);return serial(async()=>{
  const c=provider(),p=await read(c);if(pending(p.entries.at(-1)))fail('RECOVERY_REQUIRED');if(p.entries.length>=32)fail('HISTORY_FULL');
  const peerHash=await peer(c),owner=manager(),identity=await own(),hold=held(await maintenance.status({})),process=await processIdentity.capture();if(!validMaintenanceProcess(process))fail('PROCESS_REVIEW');check(c);if(manager()!==owner)fail('PROVIDER_CHANGED');
  return save({contract:1,instanceId,revision:p.revision,action:ACTION,id:randomUUID(),scope:SCOPE,version:identity.version,canApply:true,expiresAt:now()+300000,risks:['own_ui_and_rpc_may_disappear','late_native_or_im_input_may_abort','restart_may_be_required',...(removing?['official_package_manager_may_prune_unused_profile_dependencies','verified_source_required_to_reinstall']:[])],retained:[...(!removing?['package']:[]),'global_rules','skills','credentials','sessions','tasks','artifacts','other_declared_plugins'],dataDeletionAuthorized:false,hostStopAuthorized:false,automaticRestart:false},{revision:p.revision,peerHash,owner,identity,hold,process});
 });}
 async function apply(a){return serial(async()=>{
  if(!exact(a,['id','fingerprint','confirm','acceptRisk'])||a.confirm!==true||a.acceptRisk!==true)fail('CONFIRMATION_REQUIRED');const c=provider();let p=await read(c);const old=p.entries.find(e=>e.id===a.id);if(old){if(old.fingerprint!==a.fingerprint)fail('OPERATION_CHANGED');return {...view(p),notResent:true};}
  const s=checked(a,ACTION);if(p.revision!==s.revision||pending(p.entries.at(-1)))fail('REVISION_CHANGED');
  return maintenance.withHeld(async holdStatus=>{
   const hold=held({...holdStatus,operationInFlight:false});if(await peer(c)!==s.peerHash||hash(hold)!==hash(s.hold)||manager()!==s.owner||hash(await own())!==hash(s.identity)||hash(await processIdentity.capture())!==hash(s.process))fail('OBSERVATION_CHANGED');
   const e={id:a.id,instanceId,fingerprint:a.fingerprint,identityDigest:s.identity.identityDigest,version:s.identity.version,maintenanceId:hold.id,ownerProcess:s.process,createdAt:now(),updatedAt:now(),state:'intent',result:null,review:null};plan=null;
   p=await write(c,p,rows=>{if(rows.length>=32)fail('HISTORY_FULL');return [...rows,e];});
   // Recheck after durable intent; never dispatch on drift, acknowledgement loss,
   // component release or provider replacement. The maintenance mutex stays held.
   let out=null,dispatched=false;
   try{check(c);if(await peer(c)!==s.peerHash||manager()!==s.owner||hash(await own())!==hash(s.identity)||hash(held({...await maintenance.status({}),operationInFlight:false}))!==hash(hold))fail('OBSERVATION_CHANGED');dispatched=true;out=receipt(await (removing?s.owner.removeBundle(NAME):s.owner.setBundleEnabled(NAME,false)));}catch{}
   const state=!dispatched?'not_dispatched':!out?'unknown':out.hasError||['failed','overridden','cancelled'].includes(out.application)?'manager_rejected':out.application==='restart-required'?'saved_restart_required':'manager_applied';
   p=await write(c,p,rows=>rows.map(x=>x.id===e.id?{...x,state,result:out,updatedAt:now()}:x));return view(p);
  });
 });}
 async function reconciliation(c,p){
  const e=p.entries.at(-1);if(!pending(e))fail('NO_UNKNOWN_RESULT');const observation=await processIdentity.observe(e.ownerProcess);if(observation.state!=='exited')fail('ORIGINAL_PROCESS_UNRESOLVED');
  const identity=await own();check(c);return {entry:e,identity,proof:{reason:observation.reason,observer:observation.observer,currentStart:observation.currentStart}};
 }
 async function reconcilePreview(a={}){empty(a);return serial(async()=>{const c=provider(),p=await read(c),r=await reconciliation(c,p);return save({contract:1,instanceId,revision:p.revision,operationId:r.entry.id,action:'record_observation_only',id:randomUUID(),scope:'ledger_only',canApply:true,expiresAt:now()+300000,originalOutcomeProven:false,hostStopAuthorized:false,automaticRestart:false},{revision:p.revision,reconciliation:r});});}
 async function reconcileApply(a){return serial(async()=>{const s=checked(a,'record_observation_only'),c=provider();let p=await read(c);if(p.revision!==s.revision)fail('REVISION_CHANGED');const r=await reconciliation(c,p);if(hash(r)!==hash(s.reconciliation))fail('OBSERVATION_CHANGED');plan=null;p=await write(c,p,rows=>rows.map(e=>e.id===r.entry.id?{...e,state:'reconciled',updatedAt:now(),review:{at:now(),observerInstanceId:instanceId,bundleEnabled:true,originalOutcomeProven:false}}:e));return {...view(p),managerActions:0};});}
 return {available,status,preview,apply,reconcilePreview,reconcileApply,dispose(){closed=true;plan=null;}};
}

return create(options);
}
