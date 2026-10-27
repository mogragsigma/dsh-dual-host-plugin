// Durable metadata only: no Key, Key hash, authenticated URL or SSH proof in this ledger.
import {randomUUID} from 'node:crypto';
import {credentialKey} from '@deepseek-ai/dsh-credentials';
import {digest} from './onboarding-ssh.js';
const OWNER='dsh-dual-host-onboarding';
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===keys.sort().join();
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const rev=x=>Number.isSafeInteger(x)&&x>=0&&x<Number.MAX_SAFE_INTEGER;
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const fail=x=>{throw Error('ONBOARDING_HANDOFF_'+x);};
export function handoffTarget(v){
 if(!exact(v,['operationId','installationId','runtimeId','manifestHash','root','role','hostVersion'])||![v.operationId,v.installationId,v.runtimeId].every(uuid)||!hex(v.manifestHash)||typeof v.root!=='string'||!v.root.startsWith('/')||v.root.length>2048||/[\x00-\x1f\x7f]/.test(v.root)||v.role!=='cloud'||typeof v.hostVersion!=='string'||v.hostVersion.length>64)fail('TARGET_REVIEW');
 return v;
}
function parse(r,owner=OWNER){
 if(!r)return null;const p=r.payload;
 if(r.kind!=='grant'||!exact(p,['owner','schema','id','revision','planHash','sourceRevision','destinationRevision','target','phase','createdAt','updatedAt','error',...(p?.recovery?['recovery']:[])])||p.owner!==owner||p.schema!==1||!uuid(p.id)||!rev(p.revision)||!p.revision||!hex(p.planHash)||!rev(p.sourceRevision)||!p.sourceRevision||!rev(p.destinationRevision)||!['sending','delivered','needs_review','recovering','closed'].includes(p.phase)||!Number.isSafeInteger(p.createdAt)||!Number.isSafeInteger(p.updatedAt)||p.error!==null&&!/^ONBOARDING_[A-Z_]+$/.test(p.error))fail('LEDGER_REVIEW');
 if(p.recovery&&(!exact(p.recovery,['id','planHash','expectedRevision','mode','createdAt'])||!uuid(p.recovery.id)||!hex(p.recovery.planHash)||!rev(p.recovery.expectedRevision)||p.recovery.expectedRevision<p.destinationRevision||!['fence','already_advanced'].includes(p.recovery.mode)||!Number.isSafeInteger(p.recovery.createdAt)))fail('LEDGER_REVIEW');
 if(['recovering','closed'].includes(p.phase)&&!p.recovery)fail('LEDGER_REVIEW');
 handoffTarget(p.target);return p;
}
function remoteShape(v,keys){return exact(v,[...keys,...(v?.fencingSupported!==undefined?['fencingSupported']:[])])&&(v.fencingSupported===undefined||typeof v.fencingSupported==='boolean');}
function receipt(v,target,expected,slot='deepseek-local'){
 if(!remoteShape(v,['target','slot','revision','configured','operationMatched'])||digest(handoffTarget(v.target))!==digest(target)||v.slot!==slot||!rev(v.revision)||v.revision<expected||typeof v.configured!=='boolean'||typeof v.operationMatched!=='boolean'||v.operationMatched&&v.revision!==expected+1)fail('RECEIPT_REVIEW');
 return v.operationMatched&&v.revision===expected+1&&v.configured;
}
function view(p,sourceSlot='deepseek-cloud',destinationSlot='deepseek-local'){return p?{id:p.id,state:p.phase,revision:p.revision,target:p.target,sourceSlot,sourceRevision:p.sourceRevision,destinationSlot,destinationRevision:p.destinationRevision,observedAt:p.updatedAt,freshness:'cached',recovery:p.recovery??null,error:p.error,enablesModel:false,verifiesModel:false,notAuthorization:true}:{state:'not_started',enablesModel:false,verifiesModel:false,notAuthorization:true};}
export function createOnboardingHandoff({state,credentials,remote:transport,enabled,now=Date.now,service='deepseek'}){
 if(!['deepseek','token-plan','gitee'].includes(service))fail('SERVICE_REVIEW');
 const token=service==='token-plan',gitee=service==='gitee',sourceSlot=gitee?'gitee-cloud':token?'token-plan-cloud':'deepseek-cloud',destinationSlot=gitee?'gitee':token?'token-plan':'deepseek-local';
 const KEY=credentialKey('dsh-task-gateway',gitee?'onboarding-gitee-cloud-handoff-v1':token?'onboarding-token-cloud-handoff-v1':'onboarding-cloud-handoff-v1'),owner=gitee?OWNER+'/gitee':token?OWNER+'/token-plan':OWNER;
 const parseRecord=r=>parse(r,owner),snapshot=p=>view(p,sourceSlot,destinationSlot),checkedReceipt=(v,t,e)=>receipt(v,t,e,destinationSlot);
 const remote=(action,args)=>transport((gitee?'gitee_':token?'token_':'')+action,args);
 let plan=null,recoveryPlan=null,busy=false;
 const available=()=>enabled()&&state.available();
 const ready=()=>{if(!available())fail('UNAVAILABLE');};
 const read=async()=>parseRecord(await credentials().readRecord(KEY));
 async function locked(fn){ready();if(busy)fail('BUSY');busy=true;try{return await fn();}finally{busy=false;}}
 async function settle(p,phase,error){
  let value;await credentials().modifyRecord(KEY,old=>{const c=parseRecord(old);if(c?.id!==p.id)fail('LEDGER_CONFLICT');if(c.revision!==p.revision){value=c;return undefined;}value={...c,revision:c.revision+1,phase,error,updatedAt:now()};return {kind:'grant',payload:value};});return snapshot(value);
 }
 async function query(p){
  const r=await remote('receipt',{operation:p.id,expectedRevision:p.destinationRevision,targetHash:digest(p.target)});
  checkedReceipt(r,p.target,p.destinationRevision);return r;
 }
 async function reconcile(p){
  try{
   const r=await query(p),delivered=checkedReceipt(r,p.target,p.destinationRevision);
   const closed=!!p.recovery&&!delivered&&r.revision>p.destinationRevision;
   const value=await settle(p,delivered?'delivered':closed?'closed':'needs_review',delivered||closed?null:'ONBOARDING_HANDOFF_NOT_CONFIRMED');
   return {...value,freshness:'remote_checked',checkedAt:now(),currentDestinationRevision:r.revision};
  }catch{return {...await settle(p,'needs_review','ONBOARDING_HANDOFF_STATUS_UNKNOWN'),freshness:'check_failed',checkedAt:now()};}
 }
 async function status(a){
  if(!exact(a,['refresh'])||typeof a.refresh!=='boolean')fail('ARGUMENTS');ready();
  if(!a.refresh)return snapshot(await read());
  return locked(async()=>{const p=await read();if(!p||p.phase==='closed')return snapshot(p);return reconcile(p);});
 }
 // Closing is a distinct user decision. A trusted revision greater than the
 // old CAS fences a late send. If unchanged, explicitly advance it WITHOUT
 // changing its value. Missing receipts never authorize a resend or deletion.
 async function recoveryPreview(a){
  if(!exact(a,[]))fail('ARGUMENTS');return locked(async()=>{
   recoveryPlan=null;const p=await read();if(!p||!['sending','needs_review'].includes(p.phase))fail('RECOVERY_NOT_READY');
   const r=await query(p);if(checkedReceipt(r,p.target,p.destinationRevision))fail('ALREADY_DELIVERED');
   const mode=r.revision>p.destinationRevision?'already_advanced':'fence';
   if(mode==='fence'&&!r.fencingSupported)fail('FENCE_UNSUPPORTED');
   const body={id:randomUUID(),handoffId:p.id,ledgerRevision:p.revision,target:p.target,expectedRevision:r.revision,mode,preservesConfiguredValue:r.configured,expiresAt:now()+300000};
   recoveryPlan={...body,fingerprint:digest(body)};return {...recoveryPlan,sendsKey:false,removesKey:false,requiresExplicitConfirmation:true};
  });
 }
 async function recoveryApply(a){
  if(!exact(a,['id','fingerprint','confirm'])||!uuid(a.id)||!hex(a.fingerprint)||a.confirm!==true)fail('CONFIRMATION_REQUIRED');
  return locked(async()=>{
   const old=await read();if(old?.recovery?.id===a.id&&old.recovery.planHash===a.fingerprint)return {...snapshot(old),notResent:true};
   const p=recoveryPlan;if(!p||p.id!==a.id||p.fingerprint!==a.fingerprint||p.expiresAt<=now())fail('PLAN_EXPIRED');
   if(!old||old.id!==p.handoffId||old.revision!==p.ledgerRevision||!['sending','needs_review'].includes(old.phase))fail('LEDGER_CONFLICT');
   const r=await query(old);if(checkedReceipt(r,old.target,old.destinationRevision))fail('ALREADY_DELIVERED');
   if(r.revision!==p.expectedRevision||r.configured!==p.preservesConfiguredValue||p.mode==='fence'&&!r.fencingSupported)fail('RECOVERY_CHANGED');
   const record={...old,revision:old.revision+1,phase:'recovering',updatedAt:now(),error:null,recovery:{id:p.id,planHash:p.fingerprint,expectedRevision:p.expectedRevision,mode:p.mode,createdAt:now()}};
   await credentials().modifyRecord(KEY,previous=>{const c=parseRecord(previous);if(c?.id!==old.id||c.revision!==old.revision)fail('LEDGER_CONFLICT');return {kind:'grant',payload:record};});recoveryPlan=null;
   if(p.mode==='fence'){
    try{const f=await remote('fence',{operation:p.id,expectedRevision:p.expectedRevision,targetHash:digest(p.target)});checkedReceipt(f,p.target,p.expectedRevision);}
    catch{/* Query the ORIGINAL send: a racing send may have won; never repeat a fence. */}
   }
   return reconcile(record);
  });
 }
 async function preview(a){
  if(!exact(a,[]))fail('ARGUMENTS');return locked(async()=>{
   plan=null;const p=await read();if(p&&!['delivered','closed'].includes(p.phase))fail('RECOVERY_REQUIRED');
   const secret=await state.readManagedSecret(sourceSlot);if(!secret.value)fail('SOURCE_REQUIRED');
   const r=await remote('inspect',{});handoffTarget(r?.target);
   if(!remoteShape(r,['target','slot','revision','configured'])||r.slot!==destinationSlot||!rev(r.revision)||typeof r.configured!=='boolean')fail('TARGET_REVIEW');
   const body={id:randomUUID(),sourceRevision:secret.revision,destinationRevision:r.revision,target:r.target,replacesOwnCredential:r.configured,priorRevision:p?.revision??0,priorId:p?.id??null,expiresAt:now()+300000};plan={...body,fingerprint:digest(body)};
   return {...plan,sourceSlot,destinationSlot,enablesModel:false,verifiesModel:false,requiresExplicitConfirmation:true};
  });
 }
 async function apply(a){
  if(!exact(a,['id','fingerprint','confirm'])||!uuid(a.id)||!hex(a.fingerprint)||a.confirm!==true)fail('CONFIRMATION_REQUIRED');
  return locked(async()=>{
   const existing=await read();if(existing?.id===a.id&&existing.planHash===a.fingerprint)return {...snapshot(existing),notResent:true};
   const p=plan;if(!p||p.id!==a.id||p.fingerprint!==a.fingerprint||p.expiresAt<=now())fail('PLAN_EXPIRED');
   const secret=await state.readManagedSecret(sourceSlot);if(!secret.value||secret.revision!==p.sourceRevision)fail('SOURCE_CHANGED');
   const record={owner,schema:1,id:p.id,revision:1,planHash:p.fingerprint,sourceRevision:p.sourceRevision,destinationRevision:p.destinationRevision,target:p.target,phase:'sending',createdAt:now(),updatedAt:now(),error:null};
   await credentials().modifyRecord(KEY,old=>{const current=parseRecord(old);if((current?.id??null)!==p.priorId||(current?.revision??0)!==p.priorRevision||current&&!['delivered','closed'].includes(current.phase))fail('LEDGER_CONFLICT');return {kind:'grant',payload:record};});plan=null;
   try{const r=await remote('put',{operation:p.id,expectedRevision:p.destinationRevision,targetHash:digest(p.target),secret:secret.value});const ok=checkedReceipt(r,p.target,p.destinationRevision);return settle(record,ok?'delivered':'needs_review',ok?null:'ONBOARDING_HANDOFF_NOT_CONFIRMED');}
   catch{return settle(record,'needs_review','ONBOARDING_HANDOFF_OUTCOME_UNKNOWN');}
  });
 }
 return {available,status,preview,apply,recoveryPreview,recoveryApply};
}
