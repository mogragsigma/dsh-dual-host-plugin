// Request this Host's public appExit only. Never signal a caller-selected PID,
// invoke private shutdown controllers, or claim a returned request proves exit.
import {randomUUID,createHash} from 'node:crypto';
import {credentialKey} from '@deepseek-ai/dsh-credentials';
import {createMaintenanceProcessIdentity,validMaintenanceProcess} from './maintenance-process-identity.js';
const KEY=credentialKey('dsh-task-gateway','self-stop-v1'),OWNER='dsh-own-host-stop';
const SCOPE='current_host_public_app_exit_with_loss_risk';
const exact=(v,k)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===k.slice().sort().join();
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fail=c=>{throw Error('ONBOARDING_SELF_STOP_'+c);};
const unresolved=e=>e?.state==='intent';
function decode(record){
 if(record==null)return {owner:OWNER,schema:1,revision:0,entries:[]};const p=record.payload;
 if(record.kind!=='grant'||!exact(p,['owner','schema','revision','entries'])||p.owner!==OWNER||p.schema!==1||!integer(p.revision)||p.revision<1||!Array.isArray(p.entries)||p.entries.length>32)fail('LEDGER_REVIEW');
 const ids=new Set();for(const [i,e] of p.entries.entries()){
  if(!exact(e,['id','instanceId','fingerprint','identityDigest','version','maintenanceId','ownerProcess','createdAt','updatedAt','state','review'])||![e.id,e.instanceId,e.maintenanceId].every(uuid)||![e.fingerprint,e.identityDigest].every(digest)||!validMaintenanceProcess(e.ownerProcess)||typeof e.version!=='string'||!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(e.version)||e.version.length>128||!integer(e.createdAt)||!integer(e.updatedAt)||e.updatedAt<e.createdAt||!['intent','not_dispatched','reconciled'].includes(e.state)||ids.has(e.id)||i<p.entries.length-1&&unresolved(e))fail('LEDGER_REVIEW');
  if(e.state==='reconciled'){
   const v=e.review;if(!exact(v,['at','observerInstanceId','ownerProcessExited','requestOutcomeProven','reason'])||!integer(v.at)||v.at<e.createdAt||!uuid(v.observerInstanceId)||v.ownerProcessExited!==true||v.requestOutcomeProven!==false||!['absent','pid_reused','boot_changed','terminal'].includes(v.reason))fail('LEDGER_REVIEW');
  }else if(e.review!==null)fail('LEDGER_REVIEW');ids.add(e.id);
 }return structuredClone(p);
}
const entryIdentity=e=>({id:e.id,instanceId:e.instanceId,fingerprint:e.fingerprint,identityDigest:e.identityDigest,version:e.version,maintenanceId:e.maintenanceId,ownerProcess:e.ownerProcess,createdAt:e.createdAt});
function held(s){
 if(s.state!=='held'||s.operationInFlight||s.admission?.local!=='fenced'||s.admission?.durable?.state!=='fenced'||s.live?.state!=='held'||!uuid(s.receipt?.id)||s.live.operationId!==s.receipt.id)fail('MAINTENANCE_REQUIRED');
 const c=s.live.components;if(c?.onboarding?.state!=='held'||c.agents?.state!=='held'||!['held','not_configured'].includes(c.gateway?.state))fail('MAINTENANCE_REQUIRED');
 for(const name of ['onboarding','gateway'])if(c[name].counts&&Object.values(c[name].counts).some(n=>!integer(n)||n!==0))fail('BUSY');
 const a=c.agents;if(a.inboxState!=='empty'||!a.counts||['running','unsupported','pendingNextTurn','pendingNextStep','inboxUnknown'].some(k=>!integer(a.counts[k])||a.counts[k]!==0))fail('BUSY');
 return {id:s.receipt.id,coordinator:s.live.instanceId,components:Object.fromEntries(Object.entries(c).map(([k,v])=>[k,{state:v.state,instanceId:v.instanceId??null,operationId:v.operationId??null}]))};
}
export function createOnboardingSelfStop({credentials,maintenance,inspection,appExit,peers,enabled=()=>true,processIdentity=createMaintenanceProcessIdentity(),now=Date.now}){
 const instanceId=randomUUID();let closed=false,busy=false,plan=null,seenRevision=0;const seen=new Map();
 const provider=()=>{const c=credentials();if(closed||!enabled()||!c||typeof c.readRecord!=='function'||typeof c.modifyRecord!=='function')fail('UNAVAILABLE');return c;};
 const available=()=>{try{provider();return typeof appExit()==='function';}catch{return false;}};
 const check=c=>{if(closed||credentials()!==c)fail('PROVIDER_CHANGED');};
 async function read(c){const p=decode(await c.readRecord(KEY));check(c);if(p.revision<seenRevision||[...seen].some(([id,h])=>!p.entries.some(e=>e.id===id&&hash(entryIdentity(e))===h)))fail('LEDGER_CHANGED');for(const e of p.entries)seen.set(e.id,hash(entryIdentity(e)));seenRevision=p.revision;return p;}
 async function write(c,p,fn){let result;check(c);await c.modifyRecord(KEY,old=>{const v=decode(old);if(v.revision!==p.revision||hash(v)!==hash(p))fail('REVISION_CHANGED');if(v.revision>=Number.MAX_SAFE_INTEGER-1)fail('LEDGER_REVIEW');result={...v,revision:v.revision+1,entries:fn(v.entries)};decode({kind:'grant',payload:result});return {kind:'grant',payload:result};});check(c);if(!result)fail('LEDGER_REVIEW');return result;}
 const row=e=>e?{id:e.id,state:e.state,version:e.version,createdAt:e.createdAt,updatedAt:e.updatedAt,review:e.review}:null;
 const view=p=>({contract:1,queryContract:1,scope:SCOPE,instanceId,revision:p.revision,operationInFlight:busy,receipt:row(p.entries.at(-1)),historyCount:p.entries.length,pending:unresolved(p.entries.at(-1)),stopCapabilityAvailable:available(),hostStopped:false,currentHostRunning:true,automaticStop:false,automaticRestart:false,ingressFrozen:false,externalSupervisorControlled:false,executionAuthorized:false,dataDeletionAuthorized:false,observedAt:now()});
 async function serial(fn){if(closed)fail('CLOSED');if(busy)fail('BUSY');busy=true;try{const v=await fn();if(v&&Object.hasOwn(v,'operationInFlight'))v.operationInFlight=false;return v;}finally{busy=false;}}
 const empty=a=>{if(!exact(a,[]))fail('ARGUMENTS');};
 async function own(){const v=await inspection.status({});if(v.state!=='profile_bundle_observed'||v.bundle?.enabled!==true||v.entry?.phase!=='active'||!v.bundle.version)fail('OWNERSHIP_REVIEW');return {identityDigest:v.identityDigest,version:v.bundle.version,entry:v.entry,bundle:v.bundle};}
 async function peerState(){const rows=await peers();if(!Array.isArray(rows)||rows.length!==3||rows.some(v=>!v||typeof v.pending!=='boolean'||typeof v.operationInFlight!=='boolean'||!integer(v.revision)||!uuid(v.instanceId)))fail('PEER_REVIEW');if(rows.some(v=>v.pending||v.operationInFlight))fail('OTHER_LIFECYCLE_RECOVERY_REQUIRED');return rows.map(v=>({instanceId:v.instanceId,revision:v.revision}));}
 const save=(body,extra)=>{plan={body:{...body,fingerprint:hash(body)},...extra};return structuredClone(plan.body);};
 const confirmed=a=>{if(!exact(a,['id','fingerprint','confirm','acceptRisk'])||a.confirm!==true||a.acceptRisk!==true)fail('CONFIRMATION_REQUIRED');};
 function checked(a,action){confirmed(a);if(!plan||plan.body.id!==a.id||plan.body.fingerprint!==a.fingerprint||plan.body.action!==action||plan.body.expiresAt<=now())fail('PLAN_EXPIRED');return plan;}
 async function status(a={}){if(!exact(a,[])&&!(exact(a,['operationId'])&&uuid(a.operationId)))fail('ARGUMENTS');const p=await read(provider());return {...view(p),...(a.operationId?{requestedOperationId:a.operationId,requestedReceipt:row(p.entries.find(e=>e.id===a.operationId))}:{})};}
 // Called by sibling mutation entry points; absent appExit must not hide an old intent.
 async function assertNoPending(){if(busy)fail('BUSY');const p=await read(provider());if(unresolved(p.entries.at(-1)))fail('RECOVERY_REQUIRED');}
 async function preview(a={}){empty(a);return serial(async()=>{
  const c=provider(),p=await read(c);if(unresolved(p.entries.at(-1)))fail('RECOVERY_REQUIRED');if(p.entries.length>=32)fail('HISTORY_FULL');
  const exit=appExit();if(typeof exit!=='function')fail('EXIT_UNAVAILABLE');
  const identity=await own(),hold=held(await maintenance.status({})),peer=await peerState(),process=await processIdentity.capture();if(!validMaintenanceProcess(process))fail('PROCESS_REVIEW');check(c);if(appExit()!==exit)fail('PROVIDER_CHANGED');
  return save({contract:1,instanceId,revision:p.revision,id:randomUUID(),action:'request_current_host_exit',scope:SCOPE,version:identity.version,canApply:true,expiresAt:now()+300000,risks:['late_native_or_im_input_may_abort','own_ui_and_rpc_may_disappear','external_supervisor_may_restart','native_inputs_not_persistently_fenced','official_shutdown_may_force_exit'],retained:['package','global_rules','skills','credentials','sessions','tasks','artifacts','backups'],hostStopAuthorized:true,automaticStop:false,automaticRestart:false,dataDeletionAuthorized:false},{exit,identity,hold,peer,process});
 });}
 async function apply(a){return serial(async()=>{
  confirmed(a);const c=provider();let p=await read(c);const old=p.entries.find(e=>e.id===a.id);if(old){if(old.fingerprint!==a.fingerprint)fail('OPERATION_CHANGED');return {...view(p),notResent:true};}
  const s=checked(a,'request_current_host_exit');if(p.revision!==s.body.revision||unresolved(p.entries.at(-1)))fail('REVISION_CHANGED');
  return maintenance.withHeld(async holdStatus=>{
   const h=held({...holdStatus,operationInFlight:false});
   const unchanged=async()=>{if(appExit()!==s.exit||hash(await own())!==hash(s.identity)||hash(await peerState())!==hash(s.peer)||hash(await processIdentity.capture())!==hash(s.process)||hash(held({...await maintenance.status({}),operationInFlight:false}))!==hash(h))fail('OBSERVATION_CHANGED');check(c);if(appExit()!==s.exit)fail('PROVIDER_CHANGED');};
   if(hash(h)!==hash(s.hold))fail('OBSERVATION_CHANGED');await unchanged();
   const e={id:a.id,instanceId,fingerprint:a.fingerprint,identityDigest:s.identity.identityDigest,version:s.identity.version,maintenanceId:h.id,ownerProcess:s.process,createdAt:now(),updatedAt:now(),state:'intent',review:null};plan=null;
   p=await write(c,p,rows=>{if(rows.length>=32)fail('HISTORY_FULL');return [...rows,e];});
   try{await unchanged();}catch{
    p=await write(c,p,rows=>rows.map(x=>x.id===e.id?{...x,state:'not_dispatched',updatedAt:now()}:x));return {...view(p),exitRequested:false};
   }
   // No timer, forced signal, retry or post-disposal ledger write. appExit may
   // remove this service and its HTTP response before the callback returns.
   let returned=false;try{s.exit(0);returned=true;}catch{/* Intent remains unknown, never automatically repeat. */}
   return {...view(p),exitRequested:true,exitRequestReturned:returned};
  });
 });}
 async function reconciliation(c,p){
  const e=p.entries.at(-1);if(!unresolved(e))fail('NO_UNKNOWN_RESULT');const proof=await processIdentity.observe(e.ownerProcess),o=proof.observer;
  if(proof.state!=='exited'||!validMaintenanceProcess(o)||o.host!==e.ownerProcess.host||o.platform!==e.ownerProcess.platform||!['absent','pid_reused','boot_changed','terminal'].includes(proof.reason))fail('ORIGINAL_PROCESS_UNRESOLVED');
  if(proof.reason==='boot_changed'?o.boot===e.ownerProcess.boot:o.boot!==e.ownerProcess.boot||o.namespace!==e.ownerProcess.namespace||(proof.reason==='absent'?proof.currentStart!==null:proof.reason==='pid_reused'?typeof proof.currentStart!=='string'||proof.currentStart===e.ownerProcess.start:proof.currentStart!==e.ownerProcess.start))fail('ORIGINAL_PROCESS_UNRESOLVED');
  check(c);return {entry:e,proof:{reason:proof.reason,observer:o,currentStart:proof.currentStart}};
 }
 async function reconcilePreview(a={}){empty(a);return serial(async()=>{const c=provider(),p=await read(c),r=await reconciliation(c,p);return save({contract:1,instanceId,revision:p.revision,operationId:r.entry.id,id:randomUUID(),action:'record_exit_observation_only',scope:'ledger_only',canApply:true,expiresAt:now()+300000,ownerProcessExited:true,currentHostRunning:true,requestOutcomeProven:false,automaticRestart:false},{reconciliation:r});});}
 async function reconcileApply(a){return serial(async()=>{const s=checked(a,'record_exit_observation_only'),c=provider();let p=await read(c);if(p.revision!==s.body.revision)fail('REVISION_CHANGED');const r=await reconciliation(c,p);if(hash(r)!==hash(s.reconciliation))fail('OBSERVATION_CHANGED');plan=null;p=await write(c,p,rows=>rows.map(e=>e.id===r.entry.id?{...e,state:'reconciled',updatedAt:now(),review:{at:now(),observerInstanceId:instanceId,ownerProcessExited:true,requestOutcomeProven:false,reason:r.proof.reason}}:e));return {...view(p),exitRequests:0};});}
 return {available,status,preview,apply,reconcilePreview,reconcileApply,assertNoPending,dispose(){closed=true;plan=null;}};
}
