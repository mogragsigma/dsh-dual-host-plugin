// Local operator ledger. Reopening reads history only; only explicit actions use SSH.
import {createHash} from 'node:crypto';
import {credentialKey} from '@deepseek-ai/dsh-credentials';
import {runtimeProgram,runtimeCommand} from './onboarding-runtime-program.js';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fail=c=>{throw Error('ONBOARDING_CLOUD_ARTIFACTS_'+c);};
const exact=(v,k)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===k.slice().sort().join();
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x),version=x=>typeof x==='string'&&/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(x)&&x.length<100;
const terminal=s=>['committed','rolled_back','refused'].includes(s),scope='stopped_owned_rules_and_skills_only';
export const artifactsRecordKey=id=>credentialKey('dsh-task-gateway','onboarding-runtime-artifacts-v1-'+id);
export function artifactsPending(d){const last=new Map((d?.requests??[]).filter(r=>r.receipt?.state!=='refused').map(r=>[r.targetId,r]));return [...last.values()].some(r=>r.state==='requested'||!terminal(r.receipt?.state));}
export function parseArtifactsRequest(record,operationId){
 if(!record)return null;const d=record.payload;
 if(record.kind!=='grant'||!exact(d,['schema','operationId','runtimeId','binding','revision','plans','requests'])||d.schema!==1||d.operationId!==operationId||!uuid(d.runtimeId)||!hex(d.binding)||!Number.isSafeInteger(d.revision)||d.revision<1||!Array.isArray(d.plans)||d.plans.length>128||!Array.isArray(d.requests)||d.requests.length>128||Buffer.byteLength(JSON.stringify(d))>262144)fail('LOCAL_LEDGER_REVIEW');
 const ids=new Set();for(const p of d.plans){if(!exact(p,['id','kind','targetId','fingerprint','expiresAt','version'])||!uuid(p.id)||ids.has(p.id)||!['apply','recover'].includes(p.kind)||!uuid(p.targetId)||!hex(p.fingerprint)||!Number.isSafeInteger(p.expiresAt)||!version(p.version))fail('LOCAL_LEDGER_REVIEW');ids.add(p.id);}
 for(const p of d.plans)if(p.kind==='apply'?p.id!==p.targetId:!d.plans.some(x=>x.kind==='apply'&&x.id===p.targetId&&x.version===p.version))fail('LOCAL_LEDGER_REVIEW');
 const requests=new Set();for(const r of d.requests){
  const p=d.plans.find(p=>p.id===r?.planId&&p.kind===r?.action);
  if(!exact(r,['key','action','planId','targetId','fingerprint','state','receipt'])||!p||r.key!==r.action+':'+r.planId||requests.has(r.key)||r.targetId!==p.targetId||r.fingerprint!==p.fingerprint||!['requested','observed'].includes(r.state)||r.state==='requested'&&r.receipt!==null)fail('LOCAL_LEDGER_REVIEW');requests.add(r.key);
  if(r.state==='observed'){if(!exact(r.receipt,['contract','operationId','runtimeId','id','version','state','recoveryRequired','scope','hostStarted','activationVerified','initialization','pluginBinaryChanged','credentialsChanged']))fail('LOCAL_LEDGER_REVIEW');try{checkReceipt(r.receipt,d,p.targetId,p.version);}catch{fail('LOCAL_LEDGER_REVIEW');}}
 }return d;
}
function checkReceipt(v,d,id,ver){
 if(!v||v.operationId!==d.operationId||v.runtimeId!==d.runtimeId||v.contract!==1||v.id!==id||v.version!==ver||v.scope!==scope||!['requested','needs_review','committed','rolled_back','refused'].includes(v.state)||v.recoveryRequired!==!terminal(v.state)||v.hostStarted!==false||v.activationVerified!==false||v.initialization!==false||v.pluginBinaryChanged!==false||v.credentialsChanged!==false)fail('RESPONSE_REVIEW');
}
export async function runtimeArtifactsClient({args,p,a,b,runtimeId,credentials,ssh,now=Date.now}){
 const action=args?.action,fields={rules_record:[],rules_preview:[],rules_apply:['id','fingerprint','confirm'],rules_status:['id'],rules_recover_preview:['id'],rules_recover:['id','fingerprint','confirm']};
 const mutation=['rules_apply','rules_recover'].includes(action),kind=action?.slice(6);
 if(!Object.hasOwn(fields,action)||!exact(args,['action','operationId',...fields[action]])||args.operationId!==p.id||Object.hasOwn(args,'id')&&!uuid(args.id)||mutation&&(args.confirm!==true||!hex(args.fingerprint)))fail('CONFIRMATION_REQUIRED');
 const key=artifactsRecordKey(p.id),c=credentials(),binding=hash({operationId:p.id,archiveHash:p.archiveHash,bindingFingerprint:p.bindingFingerprint});
 let ledger=parseArtifactsRequest(await c.readRecord(key),p.id);
 if(ledger&&(ledger.binding!==binding||runtimeId&&ledger.runtimeId!==runtimeId))fail('BINDING_CHANGED');
 const decode=n=>{const f=a.files.find(x=>x.path==='plugin/'+n);if(!f)fail('ARCHIVE_REVIEW');return Buffer.from(f.data,'base64').toString();};
 const compat=JSON.parse(decode('compatibility.json')),supported=compat.onboardingPluginVersion===1&&compat.onboardingPluginVersionRequests===1&&compat.onboardingPluginVersionArtifacts===1;
 const cached=r=>({...r.receipt??{contract:1,id:r.targetId,state:'artifacts_outcome_unknown',recoveryRequired:true,scope,operationId:p.id,runtimeId},cached:true,historical:true,notResent:true,requestState:r.state,activationVerified:false,hostStarted:false,initialization:false});
 if(action==='rules_record')return {supported,operationId:p.id,runtimeId:ledger?.runtimeId??runtimeId??null,cached:true,historical:true,pending:artifactsPending(ledger),plans:ledger?.plans??[],requests:ledger?.requests.map(r=>({...r,receipt:r.receipt?{...r.receipt,cached:true,historical:true}:null}))??[],initialization:false,hostStarted:false,activationVerified:false};
 if(!supported)fail('UNSUPPORTED');if(!uuid(runtimeId))fail('RUNTIME_RECORD_REQUIRED');
 const empty={schema:1,operationId:p.id,runtimeId,binding,revision:0,plans:[],requests:[]},current=()=>ledger??empty;
 async function save(next){const old=ledger,value={...next,revision:(ledger?.revision??0)+1};parseArtifactsRequest({kind:'grant',payload:value},p.id);await c.modifyRecord(key,r=>{if(JSON.stringify(parseArtifactsRequest(r,p.id))!==JSON.stringify(old))fail('LOCAL_CONFLICT');return {kind:'grant',payload:value};});ledger=value;}
 const previous=mutation?current().requests.find(r=>r.key===kind+':'+args.id):null;
 if(previous){if(previous.fingerprint!==args.fingerprint)fail('PLAN_DRIFT');return cached(previous);}
 const last=id=>current().requests.filter(r=>r.targetId===id&&r.receipt?.state!=='refused').at(-1);
 if(artifactsPending(ledger)&&!['rules_status','rules_recover_preview','rules_recover'].includes(action))fail('RECOVERY_REQUIRED');
 if(['rules_recover_preview','rules_recover'].includes(action)&&current().requests.some(r=>r.state==='requested'))fail('OUTCOME_UNKNOWN');
 let target=args.id,plan,remoteArgs={};
 if(mutation){
  plan=current().plans.find(x=>x.id===args.id&&x.kind===kind);
  if(!plan||plan.fingerprint!==args.fingerprint||plan.expiresAt<=now())fail('PLAN_EXPIRED');target=plan.targetId;
  if(kind==='recover'&&last(target)?.receipt?.recoveryRequired!==true)fail('RECOVERY_REQUIRED');
  remoteArgs={id:plan.id,fingerprint:plan.fingerprint,confirm:true};
 }else if(action!=='rules_preview'){
  if(!current().plans.some(x=>x.kind==='apply'&&x.id===args.id))fail('TRANSACTION_UNKNOWN');remoteArgs={id:args.id};
  if(action==='rules_recover_preview'&&last(args.id)?.receipt?.recoveryRequired!==true)fail('RECOVERY_REQUIRED');
 }
 const input=JSON.stringify({action:'runtime_version',root:p.root,operationId:p.id,installationId:p.installationId,proof:p.proof,planHash:p.planHash,versionAction:action==='rules_recover_preview'?'rules_recoveryPreview':action,args:remoteArgs});
 const command=runtimeCommand(a.baseline.node.path,runtimeProgram(decode('onboarding-remote-control.js'),decode('onboarding-runtime-extension.js')),'runtimeVersionCLI');
 let request;if(mutation){if(current().requests.length>=128)fail('HISTORY_FULL');request={key:kind+':'+args.id,action:kind,planId:args.id,targetId:target,fingerprint:args.fingerprint,state:'requested',receipt:null};await save({...current(),requests:[...current().requests,request]});}
 let result;try{result=JSON.parse(await ssh.execute(b,command,input,{timeoutMs:120000}));}catch{fail('OUTCOME_UNKNOWN');}
 if(result?.ok!==true){
  if(request&&['ONBOARDING_CLOUD_RUNTIME_VERSION_PREFLIGHT_REFUSED','ONBOARDING_CLOUD_RUNTIME_ARTIFACTS_PLAN_DRIFT','ONBOARDING_CLOUD_RUNTIME_ARTIFACTS_CONFIRMATION_REQUIRED'].includes(result?.error)){
   const receipt={contract:1,operationId:p.id,runtimeId,id:target,version:plan.version,state:'refused',recoveryRequired:false,scope,hostStarted:false,activationVerified:false,initialization:false,pluginBinaryChanged:false,credentialsChanged:false};
   await save({...current(),requests:current().requests.map(r=>r.key===request.key?{...r,state:'observed',receipt}:r)});
  }
  throw Error(typeof result?.error==='string'&&/^ONBOARDING_CLOUD_[A-Z_]{1,120}$/.test(result.error)?result.error:'ONBOARDING_CLOUD_ARTIFACTS_RESPONSE_REVIEW');
 }
 const v=result.value;
 if(!v||v.operationId!==p.id||v.runtimeId!==runtimeId||v.scope!==scope||v.contract!==1||v.initialization!==false||v.hostStarted!==false||v.activationVerified!==false||v.pluginBinaryChanged!==false||v.credentialsChanged!==false)fail('RESPONSE_REVIEW');
 if(['rules_preview','rules_recover_preview'].includes(action)){
  const recover=action==='rules_recover_preview',ver=recover?current().plans.find(x=>x.kind==='apply'&&x.id===args.id)?.version:v.targetVersion;
  if(!recover&&(typeof v.canApply!=='boolean'||typeof v.planReady!=='boolean'||!Array.isArray(v.conflicts)||!Array.isArray(v.changes)||v.conflicts.length>256||v.changes.length>65))fail('RESPONSE_REVIEW');
  if(!recover&&!v.canApply){if(v.id!==null||v.fingerprint!==null||v.expiresAt!==null)fail('RESPONSE_REVIEW');return {...v,cached:false};}
  if(!uuid(v.id)||!hex(v.fingerprint)||!Number.isSafeInteger(v.expiresAt)||v.expiresAt<=now()||v.expiresAt>now()+301000||!version(ver)||recover&&(v.transactionId!==args.id||!['finalize_receipt','rollback_incomplete_changes'].includes(v.action))||!recover&&(v.planReady!==true||v.conflicts.length))fail('RESPONSE_REVIEW');
  if(current().plans.length>=128||current().plans.some(p=>p.id===v.id))fail('HISTORY_FULL');
  const next={id:v.id,kind:recover?'recover':'apply',targetId:recover?args.id:v.id,fingerprint:v.fingerprint,expiresAt:v.expiresAt,version:ver};await save({...current(),plans:[...current().plans,next]});return {...v,cached:false};
 }
 const base=current().plans.find(p=>p.kind==='apply'&&p.id===target);checkReceipt(v,current(),target,base?.version);
 // Whitelist persisted receipt fields: no target-supplied free text, user bytes or credentials.
 const receipt={contract:1,operationId:p.id,runtimeId,id:target,version:v.version,state:v.state,recoveryRequired:v.recoveryRequired,scope,hostStarted:false,activationVerified:false,initialization:false,pluginBinaryChanged:false,credentialsChanged:false};
 const relevant=request??last(target);
 if(relevant){
  // An in-progress observation cannot settle whether our recovery was delivered.
  if(relevant.state==='requested'&&relevant.action==='recover'&&!terminal(receipt.state)&&request!==relevant)return {...cached(relevant),observedState:receipt.state};
  await save({...current(),requests:current().requests.map(r=>r.key===relevant.key?{...r,state:'observed',receipt}:r)});
 }
 return {...receipt,cached:false,historical:action==='rules_status'};
}
