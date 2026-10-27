// Durable, target-bound file configuration. Unknown replies never authorize retries.
import {credentialKey} from '@deepseek-ai/dsh-credentials';
import {randomUUID} from 'node:crypto';
import {digest} from './onboarding-ssh.js';
import {handoffTarget} from './onboarding-handoff.js';
import {cloudFilePlan,cloudFileStatus,fileConfigurationInput,fileMigrationInput,bindCloudFiles,fileAuthorizationHash} from './onboarding-file-contract.js';
const KEY=credentialKey('dsh-task-gateway','onboarding-cloud-files-v1'),OWNER='dsh-dual-host-onboarding/files';
const exact=(v,ks)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===ks.slice().sort().join();
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const rev=x=>Number.isSafeInteger(x)&&x>=0&&x<Number.MAX_SAFE_INTEGER-1;
const fail=c=>{throw Error('ONBOARDING_FILES_'+c);};
const terminal=p=>!p||['applied','closed'].includes(p.phase);
function parse(r){
 if(!r)return null;const p=r.payload;
 if(r.kind!=='grant'||!exact(p,['owner','schema','id','revision','planHash','remoteTarget','remotePlan','phase','createdAt','updatedAt','error','recovery'])||p.owner!==OWNER||p.schema!==1||!uuid(p.id)||!rev(p.revision)||!p.revision||!hex(p.planHash)||!['sending','applied','needs_review','recovering','closed'].includes(p.phase)||![p.createdAt,p.updatedAt].every(Number.isSafeInteger)||p.error!==null&&!/^ONBOARDING_[A-Z_]+$/.test(p.error))fail('LEDGER_REVIEW');
 handoffTarget(p.remoteTarget);bindCloudFiles(cloudFilePlan(p.remotePlan),p.remoteTarget);
 if(p.recovery!==null&&(!exact(p.recovery,['id','expectedRevision','fingerprint'])||!uuid(p.recovery.id)||!rev(p.recovery.expectedRevision)||!hex(p.recovery.fingerprint)))fail('LEDGER_REVIEW');
 if(p.phase==='recovering'&&!p.recovery)fail('LEDGER_REVIEW');return p;
}
function operation(p){return p?{id:p.id,state:p.phase,revision:p.revision,enabled:p.remotePlan.enabled,scopeMigration:p.remotePlan.kind==='scope_migration',remoteOperation:p.remotePlan.id,remotePlanHash:p.remotePlan.fingerprint,expectedRevision:p.remotePlan.expectedRevision,target:p.remoteTarget,observedAt:p.updatedAt,error:p.error}:{state:'not_started'};}
export function createOnboardingCloudFiles({state,credentials,remote,enabled,now=Date.now}){
 let plan=null,recoveryPlan=null,busy=false;
 const available=()=>enabled()&&state.available()&&!!credentials();
 const ready=()=>{if(!available())fail('UNAVAILABLE');};
 const read=async()=>parse(await credentials().readRecord(KEY));
 async function run(fn){ready();if(busy)fail('BUSY');busy=true;try{return await fn();}finally{busy=false;}}
 function result(p,files=null,target=p?.remoteTarget??null,freshness='cached'){return {contract:1,scope:'managed_cloud_only',operation:operation(p),files,remoteTarget:target,freshness,checkedAt:freshness==='cached'?null:now(),executionAuthorized:false,repositoryWriteAuthorized:false};}
 async function request(method,args,target){
  const r=await remote('file_transfer_'+method,args);
  if(!exact(r,['target','value']))fail('RESPONSE_REVIEW');handoffTarget(r.target);
  if(target&&digest(target)!==digest(r.target))fail('IDENTITY_REVIEW');return r;
 }
 async function query(p){const r=await request('status',p?{targetHash:digest(p.remoteTarget)}:{},p?.remoteTarget);return {...r,value:bindCloudFiles(cloudFileStatus(r.value),r.target)};}
 async function settle(p,phase,error){
  let current;await credentials().modifyRecord(KEY,r=>{const c=parse(r);if(c?.id!==p.id)fail('LEDGER_CONFLICT');if(c.revision!==p.revision){current=c;return undefined;}current={...c,revision:c.revision+1,phase,error,updatedAt:now()};return {kind:'grant',payload:current};});return current;
 }
 function outcome(p,v){
  const e=p.remotePlan;if(!v.available)fail('RUNTIME_REQUIRED');if(v.runtimeId!==e.scope.runtimeId)fail('IDENTITY_REVIEW');
  if(v.revision===e.expectedRevision+1&&v.appliedOperation===e.id&&v.appliedPlanHash===e.fingerprint){if(v.enabled!==e.enabled||v.scopeHash!==digest(e.scope))fail('RESPONSE_REVIEW');return 'applied';}
  // A larger durable generation also fences a late old apply. It is NOT proof
  // that the original action never ran or that the current authorization matches it.
  return v.revision>e.expectedRevision?'closed':'needs_review';
 }
 async function reconcile(p){
  try{const r=await query(p),phase=outcome(p,r.value);return result(await settle(p,phase,phase==='needs_review'?'ONBOARDING_FILES_OUTCOME_UNKNOWN':null),r.value,r.target,'remote_checked');}
  catch{return result(await settle(p,terminal(p)?p.phase:'needs_review','ONBOARDING_FILES_STATUS_UNKNOWN'),null,p.remoteTarget,'check_failed');}
 }
 async function status(a){
  if(!exact(a,['refresh'])||typeof a.refresh!=='boolean')fail('ARGUMENTS');ready();
  if(!a.refresh)return result(await read());
  return run(async()=>{const p=await read();if(p)return reconcile(p);const r=await query(null);return result(null,r.value,r.target,'remote_checked');});
 }
 async function previewPlan(raw,migration=false){return run(async()=>{
  plan=null;const a=migration?{...fileMigrationInput(raw),enabled:false}:fileConfigurationInput(raw),old=await read();if(!terminal(old))fail('RECOVERY_REQUIRED');
  const r=await request(migration?'migrationPreview':'preview',migration?raw:a),v=bindCloudFiles(cloudFilePlan(r.value),r.target);
  if((v.kind==='scope_migration')!==migration||v.enabled!==a.enabled||v.scope.maxBytes!==a.maxBytes||v.expiresAt<=now()||digest(v.scope.sendRoots.map(x=>x.path).sort())!==digest((a.sendRoots.length?a.sendRoots:[v.scope.root+'/files/outbox']).slice().sort()))fail('RESPONSE_REVIEW');
  const body={id:randomUUID(),remoteTarget:r.target,remotePlan:v,priorId:old?.id??null,priorRevision:old?.revision??0,expiresAt:Math.min(v.expiresAt,now()+300000)};
  plan={...body,fingerprint:digest(body)};
  return {id:plan.id,fingerprint:plan.fingerprint,enabled:v.enabled,scope:v.scope,remoteTarget:r.target,expiresAt:plan.expiresAt,expectedRevision:v.expectedRevision,...(migration?{kind:v.kind,migration:v.migration,preservesFiles:true,holdsPendingTransfers:true,requiresSeparateEnable:true}:{}),executionAuthorized:false,repositoryWriteAuthorized:false};
 });}
 async function apply(a){return run(async()=>{
  if(!exact(a,['id','fingerprint','confirm'])||!uuid(a.id)||!hex(a.fingerprint)||a.confirm!==true)fail('CONFIRMATION_REQUIRED');
  const old=await read();if(old?.id===a.id&&old.planHash===a.fingerprint)return {...result(old),notResent:true};
  const p=plan;if(!p||p.id!==a.id||p.fingerprint!==a.fingerprint||p.expiresAt<=now())fail('PLAN_EXPIRED');plan=null;
  const record={owner:OWNER,schema:1,id:p.id,revision:1,planHash:p.fingerprint,remoteTarget:p.remoteTarget,remotePlan:p.remotePlan,phase:'sending',createdAt:now(),updatedAt:now(),error:null,recovery:null};
  await credentials().modifyRecord(KEY,r=>{const c=parse(r);if((c?.id??null)!==p.priorId||(c?.revision??0)!==p.priorRevision||!terminal(c))fail('LEDGER_CONFLICT');return {kind:'grant',payload:record};});
  try{const r=await request('apply',{id:p.remotePlan.id,fingerprint:p.remotePlan.fingerprint,confirm:true,targetHash:digest(p.remoteTarget)},p.remoteTarget),v=bindCloudFiles(cloudFileStatus(r.value),r.target),phase=outcome(record,v);return result(await settle(record,phase,phase==='needs_review'?'ONBOARDING_FILES_OUTCOME_UNKNOWN':null),v,r.target,'remote_checked');}
  catch{return result(await settle(record,'needs_review','ONBOARDING_FILES_OUTCOME_UNKNOWN'),null,p.remoteTarget,'check_failed');}
 });}
 async function migrationRecover(a){return run(async()=>{
  if(!exact(a,['operation','confirm'])||!uuid(a.operation)||a.confirm!==true)fail('CONFIRMATION_REQUIRED');const p=await read();
  if(!p||p.remotePlan.kind!=='scope_migration'||p.remotePlan.id!==a.operation)fail('MIGRATION_NOT_READY');
  const observed=await query(p),v=observed.value;
  if(outcome(p,v)!=='applied'||v.enabled||v.active)fail('MIGRATION_CHANGED');
  // Continue only the already-authorized migration. The target is independently
  // bound and the native recovery RPC cannot create a new scope or enable files.
  if(v.state==='disabled')return result(await settle(p,'applied',null),v,observed.target,'remote_checked');
  if(v.error!=='ONBOARDING_FILES_MIGRATION_PENDING'&&v.state!=='needs_review')fail('MIGRATION_NOT_READY');
  try{const r=await request('migrationRecover',{...a,targetHash:digest(p.remoteTarget)},p.remoteTarget),next=bindCloudFiles(cloudFileStatus(r.value),r.target);if(outcome(p,next)!=='applied'||next.enabled||next.active)fail('RESPONSE_REVIEW');return result(await settle(p,'applied',null),next,r.target,'remote_checked');}
  catch{return result(await settle(p,'needs_review','ONBOARDING_FILES_OUTCOME_UNKNOWN'),null,p.remoteTarget,'check_failed');}
 });}
 async function recoveryPreview(a){if(!exact(a,[]))fail('ARGUMENTS');return run(async()=>{
  recoveryPlan=null;const p=await read();if(!p||terminal(p))fail('RECOVERY_NOT_READY');const r=await query(p),phase=outcome(p,r.value);if(phase==='applied')fail('ALREADY_APPLIED');
  const body={id:randomUUID(),operationId:p.id,ledgerRevision:p.revision,remoteTarget:p.remoteTarget,expectedRevision:r.value.revision,mode:phase==='closed'?'already_advanced':'fence',authorizationHash:fileAuthorizationHash(r.value),expiresAt:now()+300000};
  recoveryPlan={...body,fingerprint:digest(body)};return {...recoveryPlan,preservesAuthorization:true,executionAuthorized:false,repositoryWriteAuthorized:false};
 });}
 async function recoveryApply(a){return run(async()=>{
  if(!exact(a,['id','fingerprint','confirm'])||!uuid(a.id)||!hex(a.fingerprint)||a.confirm!==true)fail('CONFIRMATION_REQUIRED');
  const old=await read();if(old?.recovery?.id===a.id&&old.recovery.fingerprint===a.fingerprint)return {...result(old),notResent:true};
  const p=recoveryPlan;if(!p||p.id!==a.id||p.fingerprint!==a.fingerprint||p.expiresAt<=now())fail('PLAN_EXPIRED');recoveryPlan=null;
  if(!old||old.id!==p.operationId||old.revision!==p.ledgerRevision||terminal(old))fail('LEDGER_CONFLICT');
  const r=await query(old);if(outcome(old,r.value)==='applied')fail('ALREADY_APPLIED');if(r.value.revision!==p.expectedRevision||fileAuthorizationHash(r.value)!==p.authorizationHash)fail('RECOVERY_CHANGED');
  const next={...old,revision:old.revision+1,phase:'recovering',updatedAt:now(),error:null,recovery:{id:p.id,expectedRevision:p.expectedRevision,fingerprint:p.fingerprint}};
  await credentials().modifyRecord(KEY,r=>{const c=parse(r);if(c?.id!==old.id||c.revision!==old.revision)fail('LEDGER_CONFLICT');return {kind:'grant',payload:next};});
  if(p.mode==='fence')try{await request('fence',{operation:p.id,expectedRevision:p.expectedRevision,confirm:true,targetHash:digest(p.remoteTarget)},p.remoteTarget);}catch{/* Original apply may have won the CAS. Query, do not resend either write. */}
  return reconcile(next);
 });}
 return {available,status,preview:a=>previewPlan(a),migrationPreview:a=>previewPlan(a,true),migrationRecover,apply,recoveryPreview,recoveryApply};
}
