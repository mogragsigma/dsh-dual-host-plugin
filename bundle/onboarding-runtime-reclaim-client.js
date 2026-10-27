// Operator-only persistent reclamation requests; never retry an uncertain send.
import {createHash,randomUUID} from 'node:crypto';
import {credentialKey} from '@deepseek-ai/dsh-credentials';
import {runtimeProgram,runtimeCommand} from './onboarding-runtime-program.js';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fail=c=>{throw Error('ONBOARDING_CLOUD_RECLAIM_'+c);};
const exact=(v,k)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===k.slice().sort().join();
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x),integer=x=>Number.isSafeInteger(x)&&x>=0;
const scope='stopped_owned_runtime_keep_user_data';
export const reclaimRecordKey=id=>credentialKey('dsh-task-gateway','onboarding-runtime-reclaim-v1-'+id);
const active=d=>d?.requests?.filter(r=>r.receipt?.state!=='refused')??[];
export const reclaimBlocked=d=>active(d).length>0;
export const reclaimPending=d=>active(d).some(r=>r.state!=='observed'||r.receipt?.state!=='committed');
const common=(operationId,runtimeId)=>({contract:1,operationId,runtimeId,scope,hostStarted:false,initialization:false,automaticRetry:false,userDataPreserved:true,backupsRetained:true,userDataDeleted:false,irreversible:true});
const fields=['contract','operationId','runtimeId','scope','hostStarted','initialization','automaticRetry','userDataPreserved','backupsRetained','userDataDeleted','irreversible','id','state','completed','total','recoveryRequired','managedRestartBlocked','runtimeFilesRemoved'];
const receiptFields=v=>[...fields,...(Object.hasOwn(v??{},'backgroundSupported')?['backgroundSupported','workerActive','executionState']:[])];
function check(v,d,id,{absent=false,allowRefused=false}={}){
 if(!v||Object.entries(common(d.operationId,d.runtimeId)).some(([k,x])=>v[k]!==x))fail('RESPONSE_REVIEW');
 const background=Object.hasOwn(v,'backgroundSupported');
 if(background&&(v.backgroundSupported!==true||typeof v.workerActive!=='boolean'||v.executionState!==(v.state==='not_requested'?'not_requested':v.state==='committed'?'completed':v.state==='deleting'?(v.workerActive?'running':'interrupted'):null)||v.state==='not_requested'&&v.workerActive))fail('RESPONSE_REVIEW');
 if(allowRefused&&v.state==='refused'){if(v.id!==id||v.completed!==0||v.total!==0||v.recoveryRequired!==false||v.managedRestartBlocked!==false||v.runtimeFilesRemoved!==false)fail('RESPONSE_REVIEW');return;}
 if(absent&&v.state==='not_requested'){
  if(v.id!==null||v.completed!==0||v.total!==0||v.recoveryRequired!==false||v.managedRestartBlocked!==false||v.runtimeFilesRemoved!==false)fail('RESPONSE_REVIEW');return;
 }
 if(v.id!==id||!['deleting','committed'].includes(v.state)||!integer(v.completed)||!integer(v.total)||v.total<1||v.total>150000||v.completed>v.total||v.state==='committed'&&v.completed!==v.total||v.recoveryRequired!==(v.state==='deleting'&&!(background&&v.workerActive))||v.managedRestartBlocked!==true||v.runtimeFilesRemoved!==(v.state==='committed'))fail('RESPONSE_REVIEW');
}
export function parseReclaimRequest(record,operationId){
 if(!record)return null;const d=record.payload;
 if(record.kind!=='grant'||!exact(d,['schema','operationId','runtimeId','binding','revision','plans','requests'])||d.schema!==1||d.operationId!==operationId||!uuid(d.runtimeId)||!hex(d.binding)||!integer(d.revision)||d.revision<1||!Array.isArray(d.plans)||d.plans.length>128||!Array.isArray(d.requests)||d.requests.length>128||Buffer.byteLength(JSON.stringify(d))>262144)fail('LOCAL_LEDGER_REVIEW');
 const ids=new Set();for(const p of d.plans){if(!exact(p,['id','kind','targetId','fingerprint','expiresAt'])||!uuid(p.id)||ids.has(p.id)||!['apply','recover'].includes(p.kind)||!uuid(p.targetId)||!hex(p.fingerprint)||!integer(p.expiresAt))fail('LOCAL_LEDGER_REVIEW');ids.add(p.id);}
 for(const p of d.plans)if(p.kind==='apply'?p.id!==p.targetId:!d.plans.some(x=>x.kind==='apply'&&x.id===p.targetId))fail('LOCAL_LEDGER_REVIEW');
 const keys=new Set();for(const r of d.requests){const p=d.plans.find(x=>x.id===r?.planId&&x.kind===r?.action);
  if(!exact(r,['key','action','planId','targetId','fingerprint','state','receipt','observedAbsent'])||!p||r.key!==r.action+':'+r.planId||keys.has(r.key)||r.targetId!==p.targetId||r.fingerprint!==p.fingerprint||!['requested','observed'].includes(r.state)||typeof r.observedAbsent!=='boolean'||r.state==='requested'&&r.receipt!==null||r.state==='observed'&&r.observedAbsent)fail('LOCAL_LEDGER_REVIEW');keys.add(r.key);
  if(r.state==='observed'){if(!exact(r.receipt,receiptFields(r.receipt)))fail('LOCAL_LEDGER_REVIEW');try{check(r.receipt,d,r.targetId,{allowRefused:true});}catch{fail('LOCAL_LEDGER_REVIEW');}}
 }if(new Set(active(d).map(r=>r.targetId)).size>1)fail('LOCAL_LEDGER_REVIEW');return d;
}
export async function runtimeReclaimClient({args,p,a,b,runtimeId,credentials,ssh,now=Date.now}){
 const actions={reclaim_record:[],reclaim_preview:[],reclaim_apply:['id','fingerprint','confirm'],reclaim_status:['id'],reclaim_recover_preview:['id'],reclaim_recover:['id','fingerprint','confirm']},action=args?.action,kind=action?.slice(8),mutation=['reclaim_apply','reclaim_recover'].includes(action);
 if(!Object.hasOwn(actions,action)||!exact(args,['action','operationId',...actions[action]])||args.operationId!==p.id||Object.hasOwn(args,'id')&&!uuid(args.id)||mutation&&(args.confirm!==true||!hex(args.fingerprint)))fail('CONFIRMATION_REQUIRED');
 const c=credentials(),key=reclaimRecordKey(p.id),binding=hash({operationId:p.id,archiveHash:p.archiveHash,bindingFingerprint:p.bindingFingerprint});let ledger=parseReclaimRequest(await c.readRecord(key),p.id);
 if(ledger&&(ledger.binding!==binding||runtimeId&&ledger.runtimeId!==runtimeId))fail('BINDING_CHANGED');
 const decode=n=>{const f=a.files.find(x=>x.path==='plugin/'+n);if(!f)fail('ARCHIVE_REVIEW');return Buffer.from(f.data,'base64').toString();},compat=JSON.parse(decode('compatibility.json'));
 const workerSupported=compat.onboardingRuntimeReclamationWorker===1;
 const supported=['onboardingPluginVersion','onboardingPluginVersionLifecycle','onboardingPluginVersionArtifacts','onboardingPluginUninstall','onboardingRuntimeReclamation','onboardingRuntimeReclamationRequests'].every(k=>compat[k]===1);
 if(action==='reclaim_record')return {operationId:p.id,runtimeId:ledger?.runtimeId??runtimeId??null,supported,workerSupported,pending:reclaimPending(ledger),blocked:reclaimBlocked(ledger),plans:ledger?.plans??[],requests:ledger?.requests??[],cached:true,historical:true,hostStarted:false,initialization:false};
 if(!supported)fail('UNSUPPORTED');if(!uuid(runtimeId))fail('RUNTIME_RECORD_REQUIRED');
 const empty={schema:1,operationId:p.id,runtimeId,binding,revision:0,plans:[],requests:[]},current=()=>ledger??empty;
 async function save(next){const old=ledger,value={...next,revision:(ledger?.revision??0)+1};parseReclaimRequest({kind:'grant',payload:value},p.id);await c.modifyRecord(key,r=>{if(JSON.stringify(parseReclaimRequest(r,p.id))!==JSON.stringify(old))fail('LOCAL_CONFLICT');return {kind:'grant',payload:value};});ledger=value;}
 const prior=mutation?current().requests.find(r=>r.key===kind+':'+args.id):null;
 if(prior){if(prior.fingerprint!==args.fingerprint)fail('PLAN_DRIFT');return {...prior.receipt??common(p.id,runtimeId),id:prior.targetId,state:prior.receipt?.state??'reclamation_outcome_unknown',cached:true,historical:true,notResent:true,requestState:prior.state};}
 if(['reclaim_preview','reclaim_apply'].includes(action)&&reclaimBlocked(ledger))fail('RECOVERY_REQUIRED');
 let plan,target=args.id,remoteArgs={};
 if(mutation){plan=current().plans.find(x=>x.id===args.id&&x.kind===kind);if(!plan||plan.fingerprint!==args.fingerprint||plan.expiresAt<=now())fail('PLAN_EXPIRED');target=plan.targetId;remoteArgs={id:target,fingerprint:plan.fingerprint,confirm:true};}
 else if(action!=='reclaim_preview'&&!current().plans.some(x=>x.kind==='apply'&&x.id===args.id))fail('TRANSACTION_UNKNOWN');
 const last=id=>current().requests.filter(r=>r.targetId===id).at(-1);
 if(kind==='recover'||kind==='recover_preview'){
  const r=last(target);if(!r||r.state==='requested'&&!r.observedAbsent||r.receipt?.state==='committed'||r.receipt?.workerActive===true)fail('OUTCOME_UNKNOWN');
 }
 const input=JSON.stringify({action:'runtime_version',root:p.root,operationId:p.id,installationId:p.installationId,proof:p.proof,planHash:p.planHash,versionAction:action==='reclaim_recover_preview'?'reclaim_recoveryPreview':action,args:remoteArgs});
 const command=runtimeCommand(a.baseline.node.path,runtimeProgram(decode('onboarding-remote-control.js'),decode('onboarding-runtime-extension.js')),'runtimeVersionCLI');
 if(mutation){if(current().requests.length>=128)fail('HISTORY_FULL');await save({...current(),requests:[...current().requests,{key:kind+':'+args.id,action:kind,planId:args.id,targetId:target,fingerprint:plan.fingerprint,state:'requested',receipt:null,observedAbsent:false}]});}
 let result;try{result=JSON.parse(await ssh.execute(b,command,input,{timeoutMs:120000}));}catch{fail('OUTCOME_UNKNOWN');}
 if(result?.ok!==true){
  // This exact target error is emitted only before creating any deletion intent.
  // Other errors can happen after partial deletion and must remain unknown.
  if(action==='reclaim_apply'&&result?.error==='ONBOARDING_CLOUD_RUNTIME_RECLAIM_PLAN_EXPIRED'){
   const receipt={...common(p.id,runtimeId),id:target,state:'refused',completed:0,total:0,recoveryRequired:false,managedRestartBlocked:false,runtimeFilesRemoved:false};
   await save({...current(),requests:current().requests.map(r=>r.key===kind+':'+args.id?{...r,state:'observed',receipt,observedAbsent:false}:r)});
  }
  throw Error(typeof result?.error==='string'&&/^ONBOARDING_CLOUD_[A-Z_]{1,120}$/.test(result.error)?result.error:'ONBOARDING_CLOUD_RECLAIM_RESPONSE_REVIEW');
 }
 const v=result.value,base=common(p.id,runtimeId);if(!v||Object.entries(base).some(([k,x])=>v[k]!==x))fail('RESPONSE_REVIEW');
 if(['reclaim_preview','reclaim_recover_preview'].includes(action)){
  const recovery=kind==='recover_preview';if(!uuid(v.id)||!hex(v.fingerprint)||!recovery&&(!integer(v.expiresAt)||v.expiresAt<=now()||v.expiresAt>now()+301000||v.canApply!==true||!integer(v.entries)||v.entries<1||v.entries>150000||!integer(v.files)||v.files>v.entries||!integer(v.bytes)||!Array.isArray(v.removeRoots)||v.removeRoots.length>256||!Array.isArray(v.retainedPaths)||v.retainedPaths.length>16)||v.requiresExplicitConfirmation!==true)fail('RESPONSE_REVIEW');
  if(recovery){
   if(v.id!==target||!['continue_original_manifest_only','start_original_manifest_if_still_unobserved'].includes(v.action)||v.recoveryRequired!==true)fail('RESPONSE_REVIEW');
   if(v.action==='continue_original_manifest_only')check(v,current(),target);
   else if(v.state!=='unobserved'||v.completed!==0||!integer(v.total)||v.total<1||v.total>150000||v.managedRestartBlocked!==true||v.runtimeFilesRemoved!==false)fail('RESPONSE_REVIEW');
  }
  if(!recovery&&(!v.removeRoots.length||v.removeRoots.some(x=>typeof x!=='string'||!/^runtime\/[^/]+$/.test(x)||['runtime/plugin','runtime/native-home','runtime/native-tmp','runtime/workspace','runtime/.','runtime/..'].includes(x))||hash(v.retainedPaths.slice().sort())!==hash(['runtime/native-home','runtime/native-tmp','runtime/workspace','runtime','.control','plugin'].sort())))fail('RESPONSE_REVIEW');
  if(!recovery&&[...v.removeRoots,...v.retainedPaths].some(x=>typeof x!=='string'||x.length>300||/[\x00-\x1f\x7f]/.test(x)))fail('RESPONSE_REVIEW');
  if(current().plans.length>=128)fail('HISTORY_FULL');const id=recovery?randomUUID():v.id;if(current().plans.some(x=>x.id===id))fail('PLAN_DRIFT');const expiresAt=recovery?now()+300000:v.expiresAt;
  await save({...current(),plans:[...current().plans,{id,kind:recovery?'recover':'apply',targetId:v.id,fingerprint:v.fingerprint,expiresAt}]});return {...v,id,transactionId:v.id,expiresAt,cached:false};
 }
 if(workerSupported&&v.backgroundSupported!==true)fail('RESPONSE_REVIEW');
 check(v,current(),target,{absent:action==='reclaim_status'});
 if(v.state==='not_requested'){
  if(last(target))await save({...current(),requests:current().requests.map(r=>r.targetId===target&&r.state==='requested'?{...r,observedAbsent:true}:r)});
  return {...v,id:target,state:'reclamation_outcome_unknown',observedState:'not_requested',outcomeUnknown:true,historical:true,cached:false};
 }
 const receipt=Object.fromEntries(receiptFields(v).map(k=>[k,v[k]]));if(last(target))await save({...current(),requests:current().requests.map(r=>r.targetId===target?{...r,state:'observed',receipt,observedAbsent:false}:r)});
 return {...receipt,cached:false,historical:action==='reclaim_status'};
}
