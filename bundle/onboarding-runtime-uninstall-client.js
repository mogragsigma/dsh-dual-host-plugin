// Operator-only durable intent. Reopening reads local history, never retries SSH.
import {createHash} from 'node:crypto';
import {credentialKey} from '@deepseek-ai/dsh-credentials';
import {runtimeProgram,runtimeCommand} from './onboarding-runtime-program.js';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fail=c=>{throw Error('ONBOARDING_CLOUD_UNINSTALL_'+c);};
const exact=(v,k)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===k.slice().sort().join();
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x),version=x=>typeof x==='string'&&/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(x)&&x.length<100;
const terminal=s=>['committed','rolled_back','refused'].includes(s),scope='owned_plugin_rules_skills_only';
const lastRequests=d=>[...new Map((d?.requests??[]).filter(r=>r.receipt?.state!=='refused').map(r=>[r.targetId,r])).values()];
export const uninstallRecordKey=id=>credentialKey('dsh-task-gateway','onboarding-runtime-uninstall-v1-'+id);
export const uninstallPending=d=>lastRequests(d).some(r=>r.state==='requested'||!terminal(r.receipt?.state));
export const uninstallBlocked=d=>uninstallPending(d)||lastRequests(d).some(r=>r.receipt?.state==='committed');
const common=(operationId,runtimeId)=>({contract:1,operationId,runtimeId,scope,hostStarted:false,activationVerified:false,initialization:false,dependenciesRemoved:false,userDataPreserved:true,backupsRetained:true});
const receiptFields=['contract','operationId','runtimeId','scope','hostStarted','activationVerified','initialization','dependenciesRemoved','userDataPreserved','backupsRetained','id','version','state','recoveryRequired','pluginInstalled','managedRestartBlocked'];
function checkReceipt(v,d,id,ver){
 const base=common(d.operationId,d.runtimeId);
 if(!v||Object.entries(base).some(([k,x])=>v[k]!==x)||v.id!==id||v.version!==ver||!['intent','rules_removed','capturing','committed','rolled_back','refused'].includes(v.state)||v.recoveryRequired!==!terminal(v.state)||v.pluginInstalled!==(v.state==='committed'?false:null)||v.managedRestartBlocked!==!['rolled_back','refused'].includes(v.state))fail('RESPONSE_REVIEW');
}
export function parseUninstallRequest(record,operationId){
 if(!record)return null;const d=record.payload;
 if(record.kind!=='grant'||!exact(d,['schema','operationId','runtimeId','binding','revision','plans','requests'])||d.schema!==1||d.operationId!==operationId||!uuid(d.runtimeId)||!hex(d.binding)||!Number.isSafeInteger(d.revision)||d.revision<1||!Array.isArray(d.plans)||d.plans.length>128||!Array.isArray(d.requests)||d.requests.length>128||Buffer.byteLength(JSON.stringify(d))>262144)fail('LOCAL_LEDGER_REVIEW');
 const ids=new Set();for(const p of d.plans){if(!exact(p,['id','kind','targetId','fingerprint','expiresAt','version'])||!uuid(p.id)||ids.has(p.id)||!['apply','recover'].includes(p.kind)||!uuid(p.targetId)||!hex(p.fingerprint)||!Number.isSafeInteger(p.expiresAt)||!version(p.version))fail('LOCAL_LEDGER_REVIEW');ids.add(p.id);}
 for(const p of d.plans)if(p.kind==='apply'?p.id!==p.targetId:!d.plans.some(x=>x.kind==='apply'&&x.id===p.targetId&&x.version===p.version))fail('LOCAL_LEDGER_REVIEW');
 const seen=new Set();for(const r of d.requests){
  const p=d.plans.find(p=>p.id===r?.planId&&p.kind===r?.action);
  if(!exact(r,['key','action','planId','targetId','fingerprint','state','receipt'])||!p||r.key!==r.action+':'+r.planId||seen.has(r.key)||r.targetId!==p.targetId||r.fingerprint!==p.fingerprint||!['requested','observed'].includes(r.state)||r.state==='requested'&&r.receipt!==null)fail('LOCAL_LEDGER_REVIEW');seen.add(r.key);
  if(r.state==='observed'){if(!exact(r.receipt,receiptFields))fail('LOCAL_LEDGER_REVIEW');try{checkReceipt(r.receipt,d,p.targetId,p.version);}catch{fail('LOCAL_LEDGER_REVIEW');}}
 }return d;
}
export async function runtimeUninstallClient({args,p,a,b,runtimeId,credentials,ssh,now=Date.now}){
 const action=args?.action,fields={uninstall_record:[],uninstall_preview:[],uninstall_apply:['id','fingerprint','confirm'],uninstall_status:['id'],uninstall_recover_preview:['id'],uninstall_recover:['id','fingerprint','confirm']};
 const mutation=['uninstall_apply','uninstall_recover'].includes(action),kind=action?.slice(10);
 if(!Object.hasOwn(fields,action)||!exact(args,['action','operationId',...fields[action]])||args.operationId!==p.id||Object.hasOwn(args,'id')&&!uuid(args.id)||mutation&&(args.confirm!==true||!hex(args.fingerprint)))fail('CONFIRMATION_REQUIRED');
 const key=uninstallRecordKey(p.id),c=credentials(),binding=hash({operationId:p.id,archiveHash:p.archiveHash,bindingFingerprint:p.bindingFingerprint});
 let ledger=parseUninstallRequest(await c.readRecord(key),p.id);
 if(ledger&&(ledger.binding!==binding||runtimeId&&ledger.runtimeId!==runtimeId))fail('BINDING_CHANGED');
 const decode=n=>{const f=a.files.find(x=>x.path==='plugin/'+n);if(!f)fail('ARCHIVE_REVIEW');return Buffer.from(f.data,'base64').toString();};
 const compat=JSON.parse(decode('compatibility.json')),supported=['onboardingPluginVersion','onboardingPluginVersionRequests','onboardingPluginVersionLifecycle','onboardingPluginVersionArtifacts','onboardingPluginUninstall','onboardingPluginUninstallRequests'].every(k=>compat[k]===1);
 const cached=r=>({...r.receipt??{...common(p.id,runtimeId),id:r.targetId,state:'uninstall_outcome_unknown',recoveryRequired:true,managedRestartBlocked:true,pluginInstalled:null},cached:true,historical:true,notResent:true,requestState:r.state});
 if(action==='uninstall_record')return {supported,operationId:p.id,runtimeId:ledger?.runtimeId??runtimeId??null,cached:true,historical:true,pending:uninstallPending(ledger),blocked:uninstallBlocked(ledger),plans:ledger?.plans??[],requests:ledger?.requests.map(r=>({...r,receipt:r.receipt?{...r.receipt,cached:true,historical:true}:null}))??[],initialization:false,hostStarted:false};
 if(!supported)fail('UNSUPPORTED');if(!uuid(runtimeId))fail('RUNTIME_RECORD_REQUIRED');
 const empty={schema:1,operationId:p.id,runtimeId,binding,revision:0,plans:[],requests:[]},current=()=>ledger??empty;
 async function save(next){const old=ledger,value={...next,revision:(ledger?.revision??0)+1};parseUninstallRequest({kind:'grant',payload:value},p.id);await c.modifyRecord(key,r=>{if(JSON.stringify(parseUninstallRequest(r,p.id))!==JSON.stringify(old))fail('LOCAL_CONFLICT');return {kind:'grant',payload:value};});ledger=value;}
 const previous=mutation?current().requests.find(r=>r.key===kind+':'+args.id):null;
 if(previous){if(previous.fingerprint!==args.fingerprint)fail('PLAN_DRIFT');return cached(previous);}
 const last=id=>current().requests.filter(r=>r.targetId===id&&r.receipt?.state!=='refused').at(-1);
 if(uninstallBlocked(ledger)&&!['uninstall_status','uninstall_recover_preview','uninstall_recover'].includes(action))fail('RECOVERY_REQUIRED');
 if(['uninstall_recover_preview','uninstall_recover'].includes(action)&&current().requests.some(r=>r.state==='requested'))fail('OUTCOME_UNKNOWN');
 let target=args.id,plan,remoteArgs={};
 if(mutation){
  plan=current().plans.find(x=>x.id===args.id&&x.kind===kind);
  if(!plan||plan.fingerprint!==args.fingerprint||plan.expiresAt<=now())fail('PLAN_EXPIRED');target=plan.targetId;
  if(kind==='recover'&&last(target)?.receipt?.recoveryRequired!==true)fail('RECOVERY_REQUIRED');
  remoteArgs={id:plan.id,fingerprint:plan.fingerprint,confirm:true};
 }else if(action!=='uninstall_preview'){
  if(!current().plans.some(x=>x.kind==='apply'&&x.id===args.id))fail('TRANSACTION_UNKNOWN');remoteArgs={id:args.id};
  if(action==='uninstall_recover_preview'&&last(args.id)?.receipt?.recoveryRequired!==true)fail('RECOVERY_REQUIRED');
 }
 const input=JSON.stringify({action:'runtime_version',root:p.root,operationId:p.id,installationId:p.installationId,proof:p.proof,planHash:p.planHash,versionAction:action==='uninstall_recover_preview'?'uninstall_recoveryPreview':action,args:remoteArgs});
 const command=runtimeCommand(a.baseline.node.path,runtimeProgram(decode('onboarding-remote-control.js'),decode('onboarding-runtime-extension.js')),'runtimeVersionCLI');
 let request;if(mutation){if(current().requests.length>=128)fail('HISTORY_FULL');request={key:kind+':'+args.id,action:kind,planId:args.id,targetId:target,fingerprint:args.fingerprint,state:'requested',receipt:null};await save({...current(),requests:[...current().requests,request]});}
 let result;try{result=JSON.parse(await ssh.execute(b,command,input,{timeoutMs:120000}));}catch{fail('OUTCOME_UNKNOWN');}
 if(result?.ok!==true){
  if(request&&['ONBOARDING_CLOUD_RUNTIME_VERSION_PREFLIGHT_REFUSED','ONBOARDING_CLOUD_RUNTIME_UNINSTALL_PLAN_DRIFT','ONBOARDING_CLOUD_RUNTIME_UNINSTALL_CONFIRMATION_REQUIRED'].includes(result?.error)){
   const receipt={...common(p.id,runtimeId),id:target,version:plan.version,state:'refused',recoveryRequired:false,pluginInstalled:null,managedRestartBlocked:false};
   await save({...current(),requests:current().requests.map(r=>r.key===request.key?{...r,state:'observed',receipt}:r)});
  }
  throw Error(typeof result?.error==='string'&&/^ONBOARDING_CLOUD_[A-Z_]{1,120}$/.test(result.error)?result.error:'ONBOARDING_CLOUD_UNINSTALL_RESPONSE_REVIEW');
 }
 const v=result.value;if(!v||Object.entries(common(p.id,runtimeId)).some(([k,x])=>v[k]!==x))fail('RESPONSE_REVIEW');
 if(['uninstall_preview','uninstall_recover_preview'].includes(action)){
  const recover=action==='uninstall_recover_preview',ver=recover?current().plans.find(x=>x.kind==='apply'&&x.id===args.id)?.version:v.version;
  if(!recover&&(typeof v.canApply!=='boolean'||!Array.isArray(v.conflicts)||!Array.isArray(v.changes)||!Array.isArray(v.retained)||v.conflicts.length>256||v.changes.length>66||v.retained.length>256))fail('RESPONSE_REVIEW');
  if(!recover&&!v.canApply){if(v.id!==null||v.fingerprint!==null||v.expiresAt!==null)fail('RESPONSE_REVIEW');return {...v,cached:false};}
  if(!uuid(v.id)||!hex(v.fingerprint)||!Number.isSafeInteger(v.expiresAt)||v.expiresAt<=now()||v.expiresAt>now()+301000||!version(ver)||recover&&(v.transactionId!==args.id||v.confirmRequired!==true||!['finalize_receipt','rollback_incomplete_changes','finish_recorded_uninstall','cancel_proven_unstarted_uninstall'].includes(v.action))||!recover&&v.conflicts.length)fail('RESPONSE_REVIEW');
  if(current().plans.length>=128||current().plans.some(p=>p.id===v.id))fail('HISTORY_FULL');
  const next={id:v.id,kind:recover?'recover':'apply',targetId:recover?args.id:v.id,fingerprint:v.fingerprint,expiresAt:v.expiresAt,version:ver};await save({...current(),plans:[...current().plans,next]});return {...v,cached:false};
 }
 const base=current().plans.find(p=>p.kind==='apply'&&p.id===target);checkReceipt(v,current(),target,base?.version);
 const receipt=Object.fromEntries(receiptFields.map(k=>[k,v[k]])),relevant=request??last(target);
 if(relevant){
  if(relevant.state==='requested'&&relevant.action==='recover'&&!terminal(receipt.state)&&request!==relevant)return {...cached(relevant),observedState:receipt.state};
  await save({...current(),requests:current().requests.map(r=>r.key===relevant.key?{...r,state:'observed',receipt}:r)});
 }
 return {...receipt,cached:false,historical:action==='uninstall_status'};
}
