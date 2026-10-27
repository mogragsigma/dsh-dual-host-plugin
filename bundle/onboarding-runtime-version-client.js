// Operator-only version RPC. Package bytes come from our installed distribution,
// never from RPC paths/URLs. Durable intents precede SSH and survive re-creation.
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {credentialKey} from '@deepseek-ai/dsh-credentials';
import {cloudPackage} from './onboarding-cloud-package.js';
import {validateVersionCandidatePackage} from './onboarding-version-candidate.js';
import {fs,hash,ancestors,snapshot,bytes,syncWrite} from './onboarding-install-fs.js';
import {syncDirectory} from './onboarding-maintenance-fs.js';
import {runtimeProgram,runtimeCommand} from './onboarding-runtime-program.js';
const fail=c=>{throw Error('ONBOARDING_CLOUD_VERSION_'+c);},digest=x=>hash(JSON.stringify(x));
const exact=(v,k)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===k.slice().sort().join();
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x),ver=x=>typeof x==='string'&&x.length<100&&/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(x);
export const versionRecordKey=id=>credentialKey('dsh-task-gateway','onboarding-runtime-version-v1-'+id);
const mutations=['receive','apply','recover','rollback'];
const resource=r=>(r.action==='receive'?'candidate:':'version:')+r.targetId;
export function versionPending(p){
 const last=new Map((p?.requests??[]).filter(r=>r.receipt?.state!=='refused').map(r=>[resource(r),r]));
 return [...last.values()].some(r=>r.state==='requested'||r.receipt?.recoveryRequired===true&&!(r.action==='receive'&&r.receipt.state==='needs_review'));
}
export function parseVersionRequest(record,operationId){
 if(!record)return null;const p=record.payload;
 if(record.kind!=='grant'||!exact(p,['schema','operationId','runtimeId','binding','revision','candidates','plans','requests'])||p.schema!==1||p.operationId!==operationId||!uuid(p.runtimeId)||!hex(p.binding)||!Number.isSafeInteger(p.revision)||p.revision<1||!Array.isArray(p.candidates)||p.candidates.length>16||!Array.isArray(p.plans)||p.plans.length>128||!Array.isArray(p.requests)||p.requests.length>128||Buffer.byteLength(JSON.stringify(p))>262144)fail('LOCAL_LEDGER_REVIEW');
 const seen=new Set();for(const c of p.candidates){if(!exact(c,['id','fingerprint','manifestHash','archiveHash','version','bytes','files','expiresAt'])||!uuid(c.id)||seen.has(c.id)||![c.fingerprint,c.manifestHash,c.archiveHash].every(hex)||!ver(c.version)||!Number.isSafeInteger(c.bytes)||c.bytes<0||c.bytes>8388608||!Number.isSafeInteger(c.files)||c.files<1||c.files>512||!Number.isSafeInteger(c.expiresAt))fail('LOCAL_LEDGER_REVIEW');seen.add(c.id);}
 const plans=new Set();for(const v of p.plans){if(!exact(v,['id','kind','targetId','candidateId','fingerprint','expiresAt','fromVersion','toVersion'])||!uuid(v.id)||plans.has(v.id)||!['apply','rollback','recover'].includes(v.kind)||!uuid(v.targetId)||v.candidateId!==null&&!seen.has(v.candidateId)||!hex(v.fingerprint)||!Number.isSafeInteger(v.expiresAt)||![v.fromVersion,v.toVersion].every(ver))fail('LOCAL_LEDGER_REVIEW');plans.add(v.id);}
 const ids=new Set();for(const r of p.requests){if(!exact(r,['key','action','planId','targetId','fingerprint','state','receipt'])||!mutations.includes(r.action)||!uuid(r.planId)||!uuid(r.targetId)||r.key!==r.action+':'+r.planId||ids.has(r.key)||!hex(r.fingerprint)||!['requested','observed'].includes(r.state)||r.state==='requested'&&r.receipt!==null||r.state==='observed'&&(!r.receipt||r.receipt.id!==r.targetId||r.receipt.operationId!==p.operationId||r.receipt.runtimeId!==p.runtimeId||typeof r.receipt.recoveryRequired!=='boolean'||typeof r.receipt.state!=='string'))fail('LOCAL_LEDGER_REVIEW');ids.add(r.key);}
 for(const v of p.plans)if(v.kind==='apply'?(v.id!==v.targetId||!seen.has(v.candidateId)):(v.candidateId!==null||!p.plans.some(x=>x.kind==='apply'&&x.targetId===v.targetId)))fail('LOCAL_LEDGER_REVIEW');
 for(const r of p.requests){
  const v=r.action==='receive'?p.candidates.find(x=>x.id===r.planId):p.plans.find(x=>x.id===r.planId&&x.kind===r.action);
  if(!v||v.fingerprint!==r.fingerprint||(r.action==='receive'?v.id:v.targetId)!==r.targetId)fail('LOCAL_LEDGER_REVIEW');
  const receipt=r.receipt;if(!receipt)continue;
  if(receipt.hostStarted!==false||receipt.activationVerified!==false)fail('LOCAL_LEDGER_REVIEW');
  if(receipt.state==='refused'){if(receipt.recoveryRequired!==false)fail('LOCAL_LEDGER_REVIEW');continue;}
  const states=r.action==='receive'?['receiving','ready','needs_review']:['preparing','applying','committed','rolling_back','rolled_back','needs_review'];
  if(receipt.contract!==1||!states.includes(receipt.state)||receipt.recoveryRequired!==!(r.action==='receive'?['ready']:['committed','rolled_back']).includes(receipt.state))fail('LOCAL_LEDGER_REVIEW');
 }
 return p;
}
export async function runtimeVersionClient({args,p,a,b,runtimeId,credentials,ssh,localState,source,now=Date.now}){
 const fields={record:[],candidate_preview:[],receive:['id','fingerprint','confirm'],candidate_status:['id'],preview:['candidateId'],apply:['id','fingerprint','confirm'],status:['id'],recover_preview:['id'],recover:['id','fingerprint','confirm'],rollback_preview:['id'],rollback:['id','fingerprint','confirm']};
 const action=args?.action;
 if(!Object.hasOwn(fields,action)||!exact(args,['action','operationId',...fields[action]])||args.operationId!==p.id||['id','candidateId'].some(k=>Object.hasOwn(args,k)&&!uuid(args[k]))||mutations.includes(action)&&(args.confirm!==true||!hex(args.fingerprint)))fail('CONFIRMATION_REQUIRED');
 const key=versionRecordKey(p.id),c=credentials(),binding=digest({operationId:p.id,archiveHash:p.archiveHash,bindingFingerprint:p.bindingFingerprint});
 let ledger=parseVersionRequest(await c.readRecord(key),p.id);
 if(ledger&&(ledger.binding!==binding||runtimeId&&ledger.runtimeId!==runtimeId))fail('BINDING_CHANGED');
 const decode=n=>{const f=a.files.find(f=>f.path==='plugin/'+n);if(!f)fail('ARCHIVE_REVIEW');return Buffer.from(f.data,'base64');};
 const compat=JSON.parse(decode('compatibility.json')),supported=compat.onboardingPluginVersion===1&&compat.onboardingPluginVersionRequests===1;
 if(action==='record')return {operationId:p.id,supported,cached:true,historical:true,pending:versionPending(ledger),runtimeId:ledger?.runtimeId??runtimeId??null,candidates:ledger?.candidates??[],plans:ledger?.plans??[],requests:ledger?.requests.map(r=>({...r,receipt:r.receipt?{...r.receipt,cached:true,historical:true}:null}))??[],initialization:false,hostStarted:false,activationVerified:false};
 if(!supported)fail('UNSUPPORTED');if(!uuid(runtimeId))fail('RUNTIME_RECORD_REQUIRED');
 const empty={schema:1,operationId:p.id,runtimeId,binding,revision:0,candidates:[],plans:[],requests:[]};
 const current=()=>ledger??empty;
 async function save(next){
  const old=ledger,value={...next,revision:(ledger?.revision??0)+1};parseVersionRequest({kind:'grant',payload:value},p.id);
  await c.modifyRecord(key,record=>{if(JSON.stringify(parseVersionRequest(record,p.id))!==JSON.stringify(old))fail('LOCAL_CONFLICT');return {kind:'grant',payload:value};});ledger=value;
 }
 const cached=r=>({operationId:p.id,runtimeId,initialization:false,hostStarted:false,activationVerified:false,...(r.receipt??{id:r.targetId,state:'version_outcome_unknown',recoveryRequired:true}),requestState:r.state,notResent:true,cached:true,historical:true});
 const prior=mutations.includes(action)?current().requests.find(r=>r.key===action+':'+args.id):null;
 if(prior){if(prior.fingerprint!==args.fingerprint)fail('PLAN_DRIFT');return cached(prior);}
 const pending=versionPending(ledger),last=id=>current().requests.filter(r=>r.targetId===id&&r.action!=='receive'&&r.receipt?.state!=='refused').at(-1);
 if(pending&&!['candidate_status','status','recover_preview','recover'].includes(action))fail('RECOVERY_REQUIRED');
 if(['recover_preview','recover'].includes(action)&&current().requests.some(r=>r.state==='requested'))fail('OUTCOME_UNKNOWN');
 const original={package:JSON.parse(decode('package.json')),compatibility:compat,lock:JSON.parse(decode('package-lock.json')),files:new Map(a.files.map(f=>[f.path,f]))};
 const candidateFile=id=>path.join(localState,'cloud',p.id,'version-candidates',id,'package.json');
 if(action==='candidate_preview'){
  if(current().candidates.length>=16)fail('HISTORY_FULL');
  const pkg=await cloudPackage(source),checked=validateVersionCandidatePackage(pkg.files,pkg.manifestHash,original),data=JSON.stringify({files:pkg.files,manifestHash:pkg.manifestHash}),id=randomUUID(),file=candidateFile(id);
  await ancestors(path.dirname(file));await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});await ancestors(path.dirname(file));await syncWrite(file,data);await syncDirectory(path.dirname(file));
  const plan={id,manifestHash:pkg.manifestHash,archiveHash:hash(data),version:checked.version,bytes:checked.total,files:checked.manifest.length,expiresAt:now()+300000};plan.fingerprint=digest({binding,runtimeId,...plan});
  await save({...current(),candidates:[...current().candidates,plan]});
  return {...plan,operationId:p.id,runtimeId,scope:'candidate_files_only',requiresConfirmation:true,remoteContacted:false,runtimeChanged:false,hostStarted:false,initialization:false,activationVerified:false};
 }
 const candidate=current().candidates.find(x=>x.id===(args.candidateId??args.id));
 const plan=current().plans.find(x=>x.id===args.id&&x.kind===action);
 let remoteAction=action,remoteArgs,targetId=args.id,request;
 if(action==='receive'){
  if(!candidate||candidate.fingerprint!==args.fingerprint||candidate.expiresAt<=now())fail('PLAN_EXPIRED');
  const s=await snapshot(candidateFile(candidate.id),12582912);if(s.missing||s.sha256!==candidate.archiveHash)fail('CANDIDATE_DRIFT');const pkg=JSON.parse(bytes(s));validateVersionCandidatePackage(pkg.files,pkg.manifestHash,original);
  if(pkg.manifestHash!==candidate.manifestHash)fail('CANDIDATE_DRIFT');remoteArgs={id:candidate.id,manifestHash:pkg.manifestHash,files:pkg.files,confirm:true};
 }else if(action==='candidate_status'){
  if(!candidate)fail('CANDIDATE_UNKNOWN');remoteArgs={id:args.id};
 }else if(action==='preview'){
  const received=current().requests.find(r=>r.action==='receive'&&r.targetId===args.candidateId);if(!candidate||received?.state!=='observed'||received.receipt?.state!=='ready')fail('CANDIDATE_NOT_READY');targetId=args.candidateId;remoteArgs={id:targetId};
 }else if(['apply','rollback','recover'].includes(action)){
  if(!plan||plan.fingerprint!==args.fingerprint||plan.expiresAt<=now())fail('PLAN_EXPIRED');targetId=plan.targetId;
  if(action==='recover'&&(!last(targetId)||last(targetId).receipt?.recoveryRequired!==true))fail('RECOVERY_REQUIRED');
  remoteArgs=action==='rollback'?{id:targetId,planId:plan.id,fingerprint:plan.fingerprint,confirm:true}:action==='recover'?{id:targetId,confirm:true}:{id:plan.id,fingerprint:plan.fingerprint,confirm:true};
 }else{
  if(!current().plans.some(v=>v.kind==='apply'&&v.targetId===args.id))fail('TRANSACTION_UNKNOWN');
  remoteAction=action==='rollback_preview'?'previewRollback':'status';remoteArgs={id:args.id};
 }
 const program=runtimeProgram(decode('onboarding-remote-control.js').toString(),decode('onboarding-runtime-extension.js').toString()),command=runtimeCommand(a.baseline.node.path,program,'runtimeVersionCLI');
 const q={action:'runtime_version',root:p.root,operationId:p.id,installationId:p.installationId,proof:p.proof,planHash:p.planHash,versionAction:remoteAction,args:remoteArgs},input=JSON.stringify(q);if(Buffer.byteLength(input)>12582912)fail('PACKAGE_LIMIT');
 if(mutations.includes(action)){
  if(current().requests.length>=128)fail('HISTORY_FULL');request={key:action+':'+args.id,action,planId:args.id,targetId,fingerprint:args.fingerprint,state:'requested',receipt:null};
  await save({...current(),requests:[...current().requests,request]});
 }
 let result;try{result=JSON.parse(await ssh.execute(b,command,input,{timeoutMs:120000}));}catch{fail('OUTCOME_UNKNOWN');}
 if(result?.ok!==true){
  // These validations precede any image operation in the archived controller.
  if(request&&['ONBOARDING_CLOUD_RUNTIME_VERSION_PREFLIGHT_REFUSED','ONBOARDING_CLOUD_RUNTIME_VERSION_PLAN_DRIFT','ONBOARDING_CLOUD_RUNTIME_VERSION_CONFIRMATION_REQUIRED'].includes(result?.error)){
   const receipt={operationId:p.id,runtimeId,id:targetId,state:'refused',recoveryRequired:false,scope:action==='receive'?'candidate_files_only':'stopped_owned_plugin_image_only',hostStarted:false,activationVerified:false};
   await save({...current(),requests:current().requests.map(r=>r.key===request.key?{...r,state:'observed',receipt}:r)});
  }
  throw Error(typeof result?.error==='string'&&/^ONBOARDING_CLOUD_[A-Z_]{1,100}$/.test(result.error)?result.error:'ONBOARDING_CLOUD_VERSION_RESPONSE_REVIEW');
 }
 const v=result.value;
 if(!v||v.operationId!==p.id||v.runtimeId!==runtimeId||v.initialization!==false||v.hostStarted!==false||v.activationVerified!==false)fail('RESPONSE_REVIEW');
 if(['preview','rollback_preview'].includes(action)){
  if(!uuid(v.id)||!hex(v.fingerprint)||!Number.isSafeInteger(v.expiresAt)||v.expiresAt<=now()||v.expiresAt>now()+301000||![v.fromVersion,v.toVersion].every(ver)||v.scope!=='stopped_owned_plugin_image_only'||action==='preview'&&v.toVersion!==candidate.version||action==='rollback_preview'&&v.transactionId!==args.id)fail('RESPONSE_REVIEW');
  if(action==='preview'&&(!Array.isArray(v.changes)||v.changes.length>1024||v.changes.some(x=>!exact(x,['path','action'])||typeof x.path!=='string'||x.path.length>240||!['add','remove','replace'].includes(x.action))))fail('RESPONSE_REVIEW');
  if(current().plans.length>=128||current().plans.some(x=>x.id===v.id))fail('HISTORY_FULL');
  const next={id:v.id,kind:action==='preview'?'apply':'rollback',targetId:action==='preview'?v.id:args.id,candidateId:action==='preview'?args.candidateId:null,fingerprint:v.fingerprint,expiresAt:v.expiresAt,fromVersion:v.fromVersion,toVersion:v.toVersion};
  await save({...current(),plans:[...current().plans,next]});return {...v,cached:false};
 }
 let receipt;
 if(['receive','candidate_status'].includes(action)){
  if(v.contract!==1||v.id!==candidate.id||v.manifestHash!==candidate.manifestHash||v.version!==candidate.version||v.files!==candidate.files||v.bytes!==candidate.bytes||v.scope!=='candidate_files_only'||v.runtimeChanged!==false||!['receiving','ready','needs_review'].includes(v.state)||v.recoveryRequired!==(v.state!=='ready'))fail('RESPONSE_REVIEW');
  receipt={operationId:p.id,runtimeId,contract:1,id:v.id,state:v.state,manifestHash:v.manifestHash,version:v.version,files:v.files,bytes:v.bytes,scope:v.scope,runtimeChanged:false,recoveryRequired:v.recoveryRequired,hostStarted:false,initialization:false,activationVerified:false};
 }else{
  const base=current().plans.find(x=>x.kind==='apply'&&x.targetId===targetId);
  if(!base||v.contract!==1||v.id!==targetId||!['preparing','applying','committed','rolling_back','rolled_back','needs_review'].includes(v.state)||v.fromVersion!==base.fromVersion||v.toVersion!==base.toVersion||v.scope!=='stopped_owned_plugin_image_only'||v.recoveryRequired!==!['committed','rolled_back'].includes(v.state))fail('RESPONSE_REVIEW');
  receipt={operationId:p.id,runtimeId,contract:1,id:v.id,state:v.state,fromVersion:v.fromVersion,toVersion:v.toVersion,scope:v.scope,recoveryRequired:v.recoveryRequired,hostStarted:false,initialization:false,activationVerified:false,threeArtifactMaintenancePending:true};
 }
 if(action==='recover_preview'){
  if(!receipt.recoveryRequired||!last(args.id))fail('RECOVERY_REQUIRED');if(current().plans.length>=128)fail('HISTORY_FULL');
  const next={id:randomUUID(),kind:'recover',targetId:args.id,candidateId:null,expiresAt:now()+300000,fromVersion:receipt.toVersion,toVersion:receipt.fromVersion};next.fingerprint=digest({binding,runtimeId,...next});
  await save({...current(),plans:[...current().plans,next]});return {...next,operationId:p.id,runtimeId,scope:'stopped_owned_plugin_image_only',initialization:false,hostStarted:false,activationVerified:false,requiresConfirmation:true};
 }
 const relevant=request??(action==='candidate_status'?current().requests.find(r=>r.action==='receive'&&r.targetId===targetId):last(targetId));
 if(relevant){
  // Old committed state cannot settle an unknown rollback/recovery request.
  const matches=relevant.state==='observed'||relevant.action==='receive'&&['ready','needs_review'].includes(receipt.state)||relevant.action==='apply'||['recover','rollback'].includes(relevant.action)&&receipt.state==='rolled_back'||request===relevant;
  if(matches)await save({...current(),requests:current().requests.map(r=>r.key===relevant.key?{...r,state:'observed',receipt}:r)});
  else return {...receipt,state:'version_outcome_unknown',observedState:receipt.state,requestState:'requested',notResent:true,historical:true};
 }
 return {...receipt,cached:false,historical:action.endsWith('status')};
}
