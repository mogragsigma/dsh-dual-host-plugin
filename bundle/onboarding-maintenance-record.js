// Durable own-component maintenance receipts. A receipt never recreates a lease.
// The official credential provider owns storage/locking; no secrets are read here.
import {randomUUID,createHash} from 'node:crypto';
import {credentialKey} from '@deepseek-ai/dsh-credentials';
import {createMaintenanceProcessIdentity,validMaintenanceProcess} from './maintenance-process-identity.js';
const KEY=credentialKey('dsh-task-gateway','onboarding-maintenance-record-v1');
const OWNER='dsh-dual-host-maintenance',LIMIT=128;
const fail=c=>{throw Error('ONBOARDING_MAINTENANCE_RECORD_'+c);};
const exact=(v,k)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===k.slice().sort().join();
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const terminal=s=>['released','not_held','retired'].includes(s);
const identity=e=>({id:e.id,instanceId:e.instanceId,coordinatorInstanceId:e.coordinatorInstanceId,planHash:e.planHash,coordinatorPlanHash:e.coordinatorPlanHash,createdAt:e.createdAt,ownerProcess:e.ownerProcess??null});
const exitReasons=['absent','pid_reused','boot_changed','terminal'];
const retirementValid=r=>exact(r,['byInstanceId','reason','observedAt','observer','currentStart'])&&uuid(r.byInstanceId)&&exitReasons.includes(r.reason)&&integer(r.observedAt)&&validMaintenanceProcess(r.observer)&&(r.currentStart===null||typeof r.currentStart==='string'&&/^[A-Za-z0-9 :]{1,64}$/.test(r.currentStart));
const retirementMatches=(owner,r)=>validMaintenanceProcess(owner)&&retirementValid(r)&&r.observer.platform===owner.platform&&r.observer.host===owner.host&&(r.reason==='boot_changed'?r.observer.boot!==owner.boot:r.observer.boot===owner.boot&&r.observer.namespace===owner.namespace&&(r.reason==='absent'?r.currentStart===null:r.reason==='pid_reused'?r.currentStart!==null&&r.currentStart!==owner.start:r.currentStart===owner.start));
const proofKey=p=>({state:p.state,reason:p.reason,observer:p.observer,currentStart:p.currentStart});
const initialAdmission=()=>({state:'open',operationId:null,decision:null});
const legacyAdmission=p=>{const e=p.entries.at(-1);return {state:e&&(!terminal(e.state)||e.state==='retired')?'fenced':'open',operationId:e?.id??null,decision:null};};
function admissionValid(a,entries){
 if(!exact(a,['state','operationId','decision'])||!['open','fenced'].includes(a.state)||(a.operationId!==null&&!uuid(a.operationId)))return false;
 const e=entries.at(-1);if((e?.id??null)!==a.operationId||e&&!terminal(e.state)&&a.state!=='fenced')return false;
 const d=a.decision;if(e?.state==='retired'&&a.state==='open'&&d?.kind!=='resume')return false;return d===null||a.state==='open'&&exact(d,['id','instanceId','kind','at'])&&uuid(d.id)&&uuid(d.instanceId)&&['release','resume'].includes(d.kind)&&integer(d.at);
}
function decode(record){
 if(record==null)return {owner:OWNER,schema:3,revision:0,entries:[],admission:initialAdmission()};
 const p=record.payload;
 if(record.kind!=='grant'||!exact(p,['owner','schema','revision','entries',...(p?.schema===3?['admission']:[])])||p.owner!==OWNER||![1,2,3].includes(p.schema)||!integer(p.revision)||p.revision<1||!Array.isArray(p.entries)||p.entries.length>LIMIT)fail('LEDGER_REVIEW');
 const ids=new Set();
 for(const [i,e] of p.entries.entries()){
  if(!exact(e,['id','instanceId','coordinatorInstanceId','planHash','coordinatorPlanHash','createdAt','updatedAt','state',...(p.schema>=2?['ownerProcess','retirement']:[])])||![e.id,e.instanceId,e.coordinatorInstanceId].every(uuid)||![e.planHash,e.coordinatorPlanHash].every(digest)||!integer(e.createdAt)||!integer(e.updatedAt)||e.updatedAt<e.createdAt||!['acquire_intent','held','release_intent','needs_review','released','not_held',...(p.schema>=2?['retired']:[])].includes(e.state)||ids.has(e.id)||i<p.entries.length-1&&!terminal(e.state))fail('LEDGER_REVIEW');
  if(p.schema>=2&&(e.ownerProcess!==null&&!validMaintenanceProcess(e.ownerProcess)||(e.state==='retired'?!retirementMatches(e.ownerProcess,e.retirement):e.retirement!==null)))fail('LEDGER_REVIEW');
  ids.add(e.id);
 }
 if(p.schema===3&&!admissionValid(p.admission,p.entries))fail('LEDGER_REVIEW');
 return {...structuredClone(p),admission:p.schema===3?structuredClone(p.admission):legacyAdmission(p)};
}
export function createOnboardingMaintenanceRecord({coordinated,activity,credentials,enabled=()=>true,now=Date.now,processIdentity=createMaintenanceProcessIdentity()}){
 const instanceId=randomUUID();let busy=false,closed=false,plan=null,tracked=null,generation=0,mustResume=false;
 if(typeof activity?.setAdmission!=='function')fail('ADMISSION_REQUIRED');
 const fence=()=>{mustResume=true;generation++;activity.setAdmission('fenced');};
 function suspendAdmission(){generation++;if(!closed)activity.setAdmission('checking');}
 async function initializeAdmission(){
  const ownGeneration=++generation;if(closed)fail('CLOSED');activity.setAdmission('checking');
  try{
   const c=provider(),p=await read(c);if(closed||ownGeneration!==generation)fail('PROVIDER_CHANGED');
   if(p.admission.state==='fenced')mustResume=true;
   activity.setAdmission(mustResume?'fenced':'open');return result(p);
  }catch(e){if(!closed&&ownGeneration===generation)activity.setAdmission('unavailable');throw e;}
 }
 const admissionBlocked=()=>activity.status({}).admission!=='open';
 const assertResumed=p=>{if(p.admission.state==='fenced'||mustResume||admissionBlocked())fail('RESUME_REQUIRED');};
 const opened=(p,id,kind)=>({state:'open',operationId:p.entries.at(-1)?.id??null,decision:{id,instanceId,kind,at:now()}});
 function resumeAdmission(){mustResume=false;generation++;activity.setAdmission('open');}
 const available=()=>{try{const c=credentials();return enabled()&&!!c&&['readRecord','modifyRecord'].every(k=>typeof c[k]==='function');}catch{return false;}};
 const provider=()=>{if(closed)fail('CLOSED');if(!available())fail('UNAVAILABLE');return credentials();};
 const checkProvider=c=>{if(closed||credentials()!==c)fail('PROVIDER_CHANGED');};
 async function read(c){
  const p=decode(await c.readRecord(KEY));checkProvider(c);
  if(tracked){const e=p.entries.find(e=>e.id===tracked.id);if(!e||hash(identity(e))!==hash(tracked))fail('LEDGER_CHANGED');}return p;
 }
 async function write(c,expected,transform,admission=null){
  checkProvider(c);let result;
  await c.modifyRecord(KEY,record=>{
   const p=decode(record);if(p.revision!==expected)fail('REVISION_CHANGED');if(p.revision>=Number.MAX_SAFE_INTEGER-1)fail('LEDGER_REVIEW');
   const normalized=p.entries.map(e=>({...e,ownerProcess:e.ownerProcess??null,retirement:e.retirement??null}));
   const next={...p,schema:3,revision:p.revision+1,entries:transform(normalized),admission:admission??p.admission};decode({kind:'grant',payload:next});result=next;return {kind:'grant',payload:next};
  });checkProvider(c);if(!result)fail('LEDGER_REVIEW');return result;
 }
 const latest=p=>p.entries.at(-1)??null;
 const pending=p=>{const e=latest(p);return e&&!terminal(e.state)?e:null;};
 function own(e){return e.instanceId===instanceId&&e.coordinatorInstanceId===coordinated.status({}).instanceId;}
 function observation(){const s=coordinated.status({});return {instanceId:s.instanceId,operationId:s.operationId,state:s.state,components:s.components,originalComponents:s.originalComponents??{},thirdPartyIm:s.thirdPartyIm};}
 function result(p){
  const receipt=latest(p),live=observation(),current=receipt&&own(receipt),unresolved=receipt&&!terminal(receipt.state);
  return {contract:2,instanceId,scope:'coordinated_components_only',persisted:true,revision:p.revision,receipt,historyCount:p.entries.length,historyLimit:LIMIT,operationInFlight:busy,ownerProofAvailable:!!receipt?.ownerProcess,
   state:!unresolved?'open':!current?'interrupted':receipt.state==='held'&&live.state==='held'&&live.operationId===receipt.id?'held':'needs_review',
   live,admission:{contract:1,scope:'own_execution_startup_only',durable:p.admission,local:activity.status({}).admission,blocked:admissionBlocked(),nativeExecutionUnverified:true},leaseRestored:false,executionMayHaveResumed:!!unresolved&&!current,hostStopAuthorized:false,pluginSwitchAuthorized:false,observedAt:now()};
 }
 async function serial(fn){if(closed)fail('CLOSED');if(busy)fail('BUSY');busy=true;try{const value=await fn();if(value&&Object.hasOwn(value,'operationInFlight'))value.operationInFlight=false;return value;}finally{busy=false;}}
 const argsEmpty=a=>{if(!exact(a,[]))fail('ARGUMENTS');};
 function checked(a,action){
  if(!exact(a,['id','fingerprint','confirm'])||a.confirm!==true)fail('CONFIRMATION_REQUIRED');
  const p=plan;if(!p||p.body.action!==action||p.body.id!==a.id||p.body.fingerprint!==a.fingerprint||p.body.expiresAt<=now())fail('PLAN_EXPIRED');return p;
 }
 function savePlan(body,extra={}){plan={body:{...body,fingerprint:hash(body)},...extra};return structuredClone(plan.body);}
 async function status(a={}){
  if(!exact(a,[])&&(!exact(a,['operationId'])||!uuid(a.operationId)))fail('ARGUMENTS');
  const c=provider(),p=await read(c),current=result(p);
  return a.operationId?{...current,requestedOperationId:a.operationId,requestedReceipt:p.entries.find(e=>e.id===a.operationId)??null}:current;
 }
 async function preview(a={}){argsEmpty(a);return serial(async()=>{
  const c=provider(),p=await read(c);if(pending(p))fail('RECOVERY_REQUIRED');assertResumed(p);if(p.entries.length>=LIMIT)fail('HISTORY_FULL');
  const ownerProcess=await processIdentity.capture();if(ownerProcess!==null&&!validMaintenanceProcess(ownerProcess))fail('PROCESS_REVIEW');
  const child=coordinated.preview({});return savePlan({action:'acquire',id:child.id,instanceId,coordinatorInstanceId:child.instanceId,ownerProcess,ownerProofAvailable:ownerProcess!==null,revision:p.revision,expiresAt:child.expiresAt,scope:'coordinated_components_only',canApply:child.canApply,components:child.components,reasons:child.reasons,hostStopAuthorized:false,pluginSwitchAuthorized:false},{child});
 });}
 async function update(c,p,id,state,admission=null){return write(c,p.revision,entries=>{if(!entries.some(e=>e.id===id))fail('LEDGER_CHANGED');return entries.map(e=>e.id===id?{...e,state,updatedAt:now()}:e);},admission);}
 function observedState(e){
  if(!own(e))return null;const live=observation();
  if(live.state==='held'&&live.operationId===e.id)return 'held';
  if(live.operationId===e.id)return 'needs_review';
  if(live.state==='open'&&live.operationId===null){const last=coordinated.status({}).last;return last?.id===e.id&&last.state==='released'?'released':'not_held';}
  return null;
 }
 async function apply(a){return serial(async()=>{
  if(!exact(a,['id','fingerprint','confirm'])||a.confirm!==true)fail('CONFIRMATION_REQUIRED');const c=provider();let p=await read(c);
  const old=p.entries.find(e=>e.id===a.id);if(old){if(old.planHash!==a.fingerprint)fail('OPERATION_CHANGED');return {...result(p),requestedReceipt:old,notResent:true};}
  if(pending(p))fail('RECOVERY_REQUIRED');const saved=checked(a,'acquire');assertResumed(p);if(saved.body.revision!==p.revision)fail('REVISION_CHANGED');if(!saved.body.canApply)fail('BUSY');
  const ownerProcess=await processIdentity.capture();if(hash(ownerProcess)!==hash(saved.body.ownerProcess))fail('PROCESS_CHANGED');
  const entry={id:saved.body.id,instanceId,coordinatorInstanceId:saved.child.instanceId,planHash:saved.body.fingerprint,coordinatorPlanHash:saved.child.fingerprint,createdAt:now(),updatedAt:now(),state:'acquire_intent',ownerProcess,retirement:null};plan=null;
  fence();
  p=await write(c,p.revision,entries=>{if(entries.length>=LIMIT)fail('HISTORY_FULL');return [...entries,entry];},{state:'fenced',operationId:entry.id,decision:null});tracked=identity(entry);
  let failed=false;try{coordinated.apply({id:entry.id,fingerprint:entry.coordinatorPlanHash,confirm:true});}catch{failed=true;}
  const state=observedState(entry)??'needs_review';p=await update(c,p,entry.id,state);return {...result(p),acquisitionFailed:failed};
 });}
 async function releasePreview(a={}){argsEmpty(a);return serial(async()=>{
  const c=provider(),p=await read(c),e=pending(p);if(!e)fail('NOT_PENDING');if(!own(e))fail('INSTANCE_CHANGED');
  const live=observation();if(live.operationId!==e.id)fail('RECONCILE_FIRST');
  return savePlan({action:'release',id:randomUUID(),operationId:e.id,instanceId,revision:p.revision,observationHash:hash(live),expiresAt:now()+300000,scope:'coordinated_components_only',canApply:true,hostStopAuthorized:false,pluginSwitchAuthorized:false});
 });}
 async function releaseApply(a){return serial(async()=>{
  const saved=checked(a,'release'),c=provider();let p=await read(c);const e=pending(p);
  if(!e||e.id!==saved.body.operationId||!own(e)||p.revision!==saved.body.revision||hash(observation())!==saved.body.observationHash)fail('OBSERVATION_CHANGED');plan=null;
  p=await update(c,p,e.id,'release_intent');
  let failed=false;try{coordinated.release({instanceId:e.coordinatorInstanceId,operationId:e.id,confirm:true});}catch{failed=true;}
  const state=observedState(e)??'needs_review',canResume=!failed&&state==='released';
  p=await update(c,p,e.id,state,canResume?opened(p,saved.body.id,'release'):null);if(canResume)resumeAdmission();return {...result(p),releaseFailed:failed};
 });}
 async function recoveryPreview(a={}){argsEmpty(a);return serial(async()=>{
  const c=provider(),p=await read(c),e=pending(p);if(!e)fail('NOT_PENDING');const state=observedState(e),live=observation();
  return savePlan({action:'record_observation',id:randomUUID(),operationId:e.id,instanceId,revision:p.revision,observationHash:hash(live),observedState:state,canApply:state!==null,reason:state===null?'previous_instance_unverified':null,expiresAt:now()+300000,scope:'ledger_only',componentActions:0,hostStopAuthorized:false,pluginSwitchAuthorized:false});
 });}
 async function recover(a){return serial(async()=>{
  const saved=checked(a,'record_observation'),c=provider();let p=await read(c);const e=pending(p),state=e&&observedState(e);
  if(!e||!saved.body.canApply||e.id!==saved.body.operationId||!own(e)||p.revision!==saved.body.revision||hash(observation())!==saved.body.observationHash||state!==saved.body.observedState)fail('OBSERVATION_CHANGED');plan=null;
  p=await update(c,p,e.id,state);return {...result(p),componentActions:0};
 });}
 async function retirementPreview(a={}){argsEmpty(a);return serial(async()=>{
  const c=provider(),p=await read(c),e=pending(p);if(!e)fail('NOT_PENDING');
  const proof=await processIdentity.observe(e.ownerProcess??null),canApply=!own(e)&&proof.state==='exited'&&retirementMatches(e.ownerProcess,{byInstanceId:instanceId,reason:proof.reason,observedAt:proof.observedAt,observer:proof.observer,currentStart:proof.currentStart});
  return savePlan({action:'retire_previous_instance',id:randomUUID(),operationId:e.id,ownerIdentityHash:hash(identity(e)),instanceId,revision:p.revision,proofHash:hash(proofKey(proof)),canApply,reason:own(e)?'current_instance':proof.reason,expiresAt:now()+300000,scope:'ledger_only',componentActions:0,signals:0,hostStopAuthorized:false,pluginSwitchAuthorized:false});
 });}
 async function retirementApply(a){return serial(async()=>{
  const saved=checked(a,'retire_previous_instance'),c=provider();let p=await read(c);const e=pending(p);
  if(!e||!saved.body.canApply||e.id!==saved.body.operationId||own(e)||p.revision!==saved.body.revision||hash(identity(e))!==saved.body.ownerIdentityHash)fail('OBSERVATION_CHANGED');
  const proof=await processIdentity.observe(e.ownerProcess??null),retirement={byInstanceId:instanceId,reason:proof.reason,observedAt:proof.observedAt,observer:proof.observer,currentStart:proof.currentStart};
  if(proof.state!=='exited'||!retirementMatches(e.ownerProcess,retirement)||hash(proofKey(proof))!==saved.body.proofHash)fail('OBSERVATION_CHANGED');plan=null;
  p=await write(c,p.revision,entries=>entries.map(row=>row.id===e.id?{...row,state:'retired',updatedAt:now(),retirement}:row));return {...result(p),componentActions:0,signals:0};
 });}
 async function resumePreview(a={}){argsEmpty(a);return serial(async()=>{
  const c=provider(),p=await read(c),live=observation(),active=activity.status({});
  const canApply=!pending(p)&&live.state==='open'&&live.operationId===null&&!active.busy&&active.operationId===null&&(admissionBlocked()||p.admission.state==='fenced');
  return savePlan({action:'resume_admission',id:randomUUID(),operationId:latest(p)?.id??null,instanceId,revision:p.revision,observationHash:hash(live),admissionHash:hash(p.admission),canApply,expiresAt:now()+300000,scope:'own_execution_startup_only',hostStopAuthorized:false,pluginSwitchAuthorized:false});
 });}
 async function resumeApply(a){return serial(async()=>{
  const saved=checked(a,'resume_admission'),c=provider();let p=await read(c);const live=observation(),active=activity.status({});
  if(!saved.body.canApply||pending(p)||p.revision!==saved.body.revision||hash(p.admission)!==saved.body.admissionHash||hash(live)!==saved.body.observationHash||live.state!=='open'||live.operationId!==null||active.busy||active.operationId!==null)fail('OBSERVATION_CHANGED');
  plan=null;p=await write(c,p.revision,entries=>entries,opened(p,saved.body.id,'resume'));resumeAdmission();return result(p);
 });}
 async function componentMutation(fn){return serial(async()=>{
  if(available()){const p=await read(provider());if(pending(p))fail('SESSION_ACTIVE');assertResumed(p);}
  else if(tracked||admissionBlocked())fail('UNAVAILABLE');return fn();
 });}
 async function withHeld(fn){return serial(async()=>{const p=await read(provider()),e=latest(p);if(!e||e.state!=='held'||!own(e)||observedState(e)!=='held'||p.admission.state!=='fenced'||!admissionBlocked())fail('HELD_SESSION_REQUIRED');return fn(result(p));});}
 function dispose(){closed=true;generation++;plan=null;/* Keep durable incomplete intent; never write an unproven release receipt. */}
 return {available,status,preview,apply,releasePreview,releaseApply,recoveryPreview,recover,retirementPreview,retirementApply,resumePreview,resumeApply,initializeAdmission,suspendAdmission,componentMutation,withHeld,dispose};
}
