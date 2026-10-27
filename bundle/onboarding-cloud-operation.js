import {runtimeVersionActivationClient} from './onboarding-version-activation-client.js';
import {runtimeReclaimClient,parseReclaimRequest,reclaimRecordKey,reclaimBlocked} from './onboarding-runtime-reclaim-client.js';
import {runtimeUninstallClient,parseUninstallRequest,uninstallRecordKey,uninstallBlocked} from './onboarding-runtime-uninstall-client.js';
import {runtimeArtifactsClient,parseArtifactsRequest,artifactsRecordKey,artifactsPending} from './onboarding-runtime-artifacts-client.js';
import {validateCloudWebAccess} from './onboarding-cloud-web.js';
import {runtimeRepairClient,parseRepairRequest,repairRecordKey,repairPending} from './onboarding-runtime-repair-client.js';
import {runtimeVersionClient,parseVersionRequest,versionRecordKey,versionPending} from './onboarding-runtime-version-client.js';
import {credentialKey} from '@deepseek-ai/dsh-credentials';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,randomBytes,createHmac,timingSafeEqual} from 'node:crypto';
import {digest,fail,shellQuote} from './onboarding-ssh.js';
import {retirementProgram} from './onboarding-cloud-retirement.js';
import {runtimeProgram,runtimeAbsenceProgram,runtimeCommand} from './onboarding-runtime-program.js';
import {cloudPackage} from './onboarding-cloud-package.js';
import {ancestors,snapshot,bytes} from './onboarding-install-fs.js';
const KEY=credentialKey('dsh-task-gateway','onboarding-cloud-operation-v1'),historyKey=id=>credentialKey('dsh-task-gateway','onboarding-cloud-operation-v1-'+id),OWNER='dsh-dual-host-onboarding';
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join()===keys.sort().join();
const fields=['owner','schema','id','revision','planId','planHash','installationId','root','proof','bindingFingerprint','bindingRevision','manifestHash','archiveHash','createdAt','updatedAt','phase','error','remote'];
function parse(record){
 if(!record)return null;const p=record.payload;
 if(record.kind!=='grant'||!exact(p,fields)||p.owner!==OWNER||p.schema!==1||!uuid(p.id)||!uuid(p.planId)||!uuid(p.installationId)||![p.planHash,p.proof,p.bindingFingerprint,p.manifestHash,p.archiveHash].every(hash)||!['preparing','prepared','needs_review','rolling_back','rolled_back','retiring','retired'].includes(p.phase)||!Number.isSafeInteger(p.revision)||p.revision<1||typeof p.root!=='string')fail('CLOUD_OPERATION_REVIEW');
 return p;
}
function view(p){return p?{operationId:p.id,planId:p.planId,revision:p.revision,state:p.phase,root:p.root,manifestHash:p.manifestHash,error:p.error,remote:p.remote,observedAt:p.updatedAt,initialization:false,hostStarted:false,notAuthorization:true}:{state:'not_started',initialization:false,hostStarted:false};}
// One durable operation at a time. Recovery uses the archived original program, not newer source.
export function createCloudOperations({credentials,readBinding,readPlan,inspect,ssh,localState,source,now=Date.now,enabled,runtimeEnabled=()=>false}){
 let busy=false,frameTail=Promise.resolve();const frames=new Set();
 const read=async()=>parse(await credentials().readRecord(KEY));
 async function gate(){if(!enabled())fail('CLOUD_PREPARATION_DISABLED');if(busy)fail('CLOUD_OPERATION_BUSY');busy=true;await Promise.all([...frames]);}
 async function frameGate(){
  if(!enabled())fail('CLOUD_PREPARATION_DISABLED');if(busy||frames.size>=3)fail('CLOUD_OPERATION_BUSY');
  // The original remote archive has an exclusive lifecycle lock. Respect it:
  // one in-flight frame plus at most two waiters, rather than concurrent SSHs.
  let release;const prior=frameTail,done=new Promise(resolve=>{release=resolve;});frames.add(done);frameTail=done;await prior;
  return ()=>{frames.delete(done);release();};
 }
 async function update(p,change){let result;await credentials().modifyRecord(KEY,old=>{const current=parse(old);if(current?.id!==p.id||current.revision!==p.revision)fail('CLOUD_OPERATION_CONFLICT');result={...current,...change,revision:current.revision+1,updatedAt:now()};return {kind:'grant',payload:result};});return result;}
 async function archive(p){const file=path.join(localState,'cloud',p.id,'package.json');await ancestors(path.dirname(file));const s=await snapshot(file,12582912);if(s.missing||s.sha256!==p.archiveHash)fail('CLOUD_ARCHIVE_REVIEW');let a;try{a=JSON.parse(bytes(s));}catch{fail('CLOUD_ARCHIVE_REVIEW');}if(a.manifestHash!==p.manifestHash)fail('CLOUD_ARCHIVE_REVIEW');return a;}
 async function bindingFor(p){
  const b=await readBinding();if(b&&digest(b)===p.bindingFingerprint&&b.revision===p.bindingRevision)return b;
  const saved=await credentials().readRecord(historyKey(p.id)),body=saved?.payload;
  if(saved?.kind!=='grant'||body?.owner!==OWNER||body?.schema!==1||!body.operation||body.operation.id!==p.id||body.operation.proof!==p.proof||!body.binding||digest(body.binding)!==p.bindingFingerprint)fail('SSH_BINDING_CONFLICT');return body.binding;
 }
 async function archiveTerminal(){
  const p=await read();if(!p||!['retired','rolled_back'].includes(p.phase))fail('CLOUD_RECOVERY_REQUIRED');const binding=await bindingFor(p);
  await credentials().modifyRecord(historyKey(p.id),old=>{if(old&&(old.kind!=='grant'||old.payload?.owner!==OWNER||old.payload?.operation?.id!==p.id||old.payload.operation.proof!==p.proof||old.payload.operation.revision>p.revision))fail('CLOUD_HISTORY_REVIEW');return {kind:'grant',payload:{owner:OWNER,schema:1,operation:p,binding}};});return view(p);
 }
 async function invoke(p,action){
  const b=await bindingFor(p);
  const a=await archive(p),f=a.files.find(x=>x.path==='plugin/onboarding-remote-control.js');if(!f)fail('CLOUD_ARCHIVE_REVIEW');
  const program=Buffer.from(f.data,'base64').toString('utf8'),q={action,root:p.root,operationId:p.id,installationId:p.installationId,proof:p.proof,planHash:p.planHash};
  if(action==='prepare')Object.assign(q,{files:a.files,manifestHash:a.manifestHash,baseline:a.baseline});
  const result=await ssh.execute(b,shellQuote(a.baseline.node.path)+' --input-type=module -e '+shellQuote(program+'\nawait remoteControlCLI();'),JSON.stringify(q),{timeoutMs:action==='prepare'?120000:30000});
  let r;try{r=JSON.parse(result);}catch{fail('CLOUD_REMOTE_RESPONSE_REVIEW');}
  if(!r.ok){if(/^ONBOARDING_CLOUD_[A-Z_]+$/.test(r.error))throw Error(r.error);fail('CLOUD_REMOTE_RESPONSE_REVIEW');}
  const v=r.value;
  if(!v||!['absent','preparing','prepared','needs_review','rolled_back'].includes(v.state)||v.initialization!==false||v.hostStarted!==false||v.operationId&&v.operationId!==p.id||v.manifestHash&&v.manifestHash!==p.manifestHash)fail('CLOUD_REMOTE_RESPONSE_REVIEW');
  return v;
 }
 async function retirement(p,action,baseline){
  const b=await bindingFor(p),a=await archive(p),f=a.files.find(x=>x.path==='plugin/onboarding-remote-control.js');if(!f)fail('CLOUD_ARCHIVE_REVIEW');
  const program=retirementProgram(Buffer.from(f.data,'base64').toString('utf8')),q={action,root:p.root,operationId:p.id,installationId:p.installationId,proof:p.proof,planHash:p.planHash};if(action==='retire')q.baseline=baseline;
  const raw=await ssh.execute(b,shellQuote(a.baseline.node.path)+' --input-type=module -e '+shellQuote(program+'\nawait retirementCLI();'),JSON.stringify(q));let r;try{r=JSON.parse(raw);}catch{fail('CLOUD_REMOTE_RESPONSE_REVIEW');}
  if(!r.ok&&r.error==='ONBOARDING_CLOUD_FENCE_SOURCE_PRESENT')throw Error(r.error);
  if(!r.ok||!r.value||!['absent','retired'].includes(r.value.state)||r.value.operationId!==p.id||r.value.initialization!==false||r.value.hostStarted!==false)fail('CLOUD_RETIREMENT_REVIEW');
  if(r.value.state==='retired'&&(r.value.root!==p.root||r.value.barrier!=='regular-file-no-replace'||r.value.originalRequestIsolated!==true||r.value.originalProcessTerminated!==false))fail('CLOUD_RETIREMENT_REVIEW');return r.value;
 }
 async function retire(args){
  if(!exact(args,['operationId','expectedRevision','confirm'])||!uuid(args.operationId)||!Number.isSafeInteger(args.expectedRevision)||args.confirm!==true)fail('CLOUD_CONFIRMATION_REQUIRED');await gate();
  try{let p=await read();if(!p||p.id!==args.operationId||p.revision!==args.expectedRevision)fail('CLOUD_OPERATION_CONFLICT');if(!['needs_review','retiring','retired'].includes(p.phase))fail('CLOUD_RETIREMENT_NOT_ALLOWED');
   p=await update(p,{phase:'retiring',error:null});
   try{let remote=await retirement(p,'retirement_status');if(remote.state==='absent'){const b=await bindingFor(p),baseline=await inspect(b);if(baseline.state!=='observed'||baseline.root!==p.root||baseline.rootExists)fail('CLOUD_BASELINE_DRIFT');remote=await retirement(p,'retire',baseline);}else remote=await retirement(p,'retire',null);
    return view(await update(p,{phase:'retired',remote,error:null}));
   }catch(e){return view(await update(p,{phase:e.message==='ONBOARDING_CLOUD_FENCE_SOURCE_PRESENT'?'needs_review':'retiring',remote:null,error:/^ONBOARDING_[A-Z_]+$/.test(e.message)?e.message:'ONBOARDING_CLOUD_RETIREMENT_UNKNOWN'}));}
  }finally{busy=false;}
 }
 async function outcome(p,action){
  try{const remote=await invoke(p,action),phase=remote.state==='absent'?'needs_review':remote.state;return await update(p,{phase,remote,error:remote.state==='absent'?'REMOTE_ABSENCE_REQUIRES_REVIEW':null});}
  catch(e){return await update(p,{phase:'needs_review',remote:null,error:/^ONBOARDING_[A-Z_]+$/.test(e.message)?e.message:'ONBOARDING_CLOUD_OUTCOME_UNKNOWN'});}
 }
 async function stage(args){
  if(!exact(args,['id','fingerprint','confirm'])||!uuid(args.id)||!hash(args.fingerprint)||args.confirm!==true)fail('CLOUD_CONFIRMATION_REQUIRED');
  await gate();
  try{
   const existing=await read();if(existing?.planId===args.id&&existing.planHash===args.fingerprint)return view(existing);
   if(existing&&!['rolled_back','retired'].includes(existing.phase))fail('CLOUD_OPERATION_BUSY');
   const plan=await readPlan();if(!plan||plan.id!==args.id||plan.fingerprint!==args.fingerprint||now()>plan.expiresAt||plan.canStage!==true||plan.conflicts.length)fail('CLOUD_PLAN_EXPIRED');
   const binding=await readBinding();if(!binding||digest(binding)!==plan.bindingFingerprint)fail('SSH_BINDING_CONFLICT');if(existing?.phase==='retired'&&binding.installationId===existing.installationId)fail('CLOUD_REPLACEMENT_REQUIRED');if(existing)await archiveTerminal();
   const pkg=await cloudPackage(source);if(pkg.manifestHash!==plan.sourceManifestHash)fail('CLOUD_SOURCE_CHANGED');
   const current=await inspect(binding);if(current.state!=='observed'||current.baselineHash!==plan.snapshot.baselineHash||!current.writable||current.rootExists||current.freeBytes<2147483648)fail('CLOUD_BASELINE_DRIFT');
   const id=randomUUID(),a={...pkg,baseline:current},data=JSON.stringify(a),dir=path.join(localState,'cloud',id);
   await ancestors(dir);await fs.mkdir(dir,{recursive:true,mode:0o700});await ancestors(dir);
   const h=await fs.open(path.join(dir,'package.json'),'wx',0o600);try{await h.writeFile(data);await h.sync();}finally{await h.close();}
   const p={owner:OWNER,schema:1,id,revision:1,planId:plan.id,planHash:plan.fingerprint,installationId:binding.installationId,root:current.root,proof:randomBytes(32).toString('hex'),bindingFingerprint:digest(binding),bindingRevision:binding.revision,manifestHash:pkg.manifestHash,archiveHash:digest(data),createdAt:now(),updatedAt:now(),phase:'preparing',error:null,remote:null};
   await credentials().modifyRecord(KEY,old=>{const other=parse(old);if((other?.id??null)!==(existing?.id??null)||(other?.revision??0)!==(existing?.revision??0))fail('CLOUD_OPERATION_CONFLICT');return {kind:'grant',payload:p};});
   return view(await outcome(p,'prepare'));
  }finally{busy=false;}
 }
 async function status(args){
  if(!exact(args,['refresh'])||typeof args.refresh!=='boolean')fail('INVALID_ARGUMENTS');
  const p=await read();if(!p||!args.refresh||p.phase==='rolled_back')return view(p);
  await gate();try{if(['retiring','retired'].includes(p.phase)){try{const remote=await retirement(p,'retirement_status');return view(await update(p,{phase:remote.state==='retired'?'retired':'retiring',remote,error:remote.state==='absent'?'RETIREMENT_NOT_PROVEN':null}));}catch(e){return view(await update(p,{phase:e.message==='ONBOARDING_CLOUD_FENCE_SOURCE_PRESENT'?'needs_review':'retiring',remote:null,error:/^ONBOARDING_[A-Z_]+$/.test(e.message)?e.message:'ONBOARDING_CLOUD_RETIREMENT_UNKNOWN'}));}}return view(await outcome(p,'status'));}finally{busy=false;}
 }
 async function rollback(args){
  if(!exact(args,['operationId','expectedRevision','confirm'])||!uuid(args.operationId)||!Number.isSafeInteger(args.expectedRevision)||args.confirm!==true)fail('CLOUD_CONFIRMATION_REQUIRED');
  await gate();try{let p=await read();if(!p||p.id!==args.operationId||p.revision!==args.expectedRevision)fail('CLOUD_OPERATION_CONFLICT');if(p.phase==='rolled_back')return view(p);if(['retiring','retired'].includes(p.phase))fail('CLOUD_FENCE_RETAINED');const runtime=await credentials().readRecord(credentialKey('dsh-task-gateway','onboarding-runtime-v1-'+p.id));if(runtime&&(runtime.kind!=='grant'||runtime.payload?.owner!==OWNER||runtime.payload?.operationId!==p.id||runtime.payload?.remote?.state!=='rolled_back'))fail('CLOUD_RUNTIME_REMOVAL_REQUIRED');p=await update(p,{phase:'rolling_back',error:null});return view(await outcome(p,'rollback'));}finally{busy=false;}
 }
 async function runtimeAction(args){
  if(!runtimeEnabled())fail('CLOUD_RUNTIME_DISABLED');
  if(typeof args?.action==='string'&&args.action.startsWith('runtime_repair_')){
   if(!uuid(args.operationId))fail('CLOUD_CONFIRMATION_REQUIRED');await gate();
   try{const p=await read();if(!p||p.id!==args.operationId||p.phase!=='prepared')fail('CLOUD_RUNTIME_SOURCE_NOT_READY');if(args.action!=='runtime_repair_status'&&await reclamationHold(p.id))fail('CLOUD_RECLAIM_RECOVERY_REQUIRED');if(args.action!=='runtime_repair_status'&&await uninstallHold(p.id))fail('CLOUD_UNINSTALL_RECOVERY_REQUIRED');if(args.action!=='runtime_repair_status'&&(versionPending(parseVersionRequest(await credentials().readRecord(versionRecordKey(p.id)),p.id))||await artifactHold(p.id)))fail('CLOUD_VERSION_RECOVERY_REQUIRED');return await runtimeRepairClient({args,p,a:await archive(p),b:await bindingFor(p),credentials,ssh});}finally{busy=false;}
  }
  if(args?.action==='runtime_restart'&&args.acknowledgeNativeResume!==true)fail('CLOUD_RUNTIME_RESTART_CONSENT_REQUIRED');
  const names=['runtime_record','runtime_preview','runtime_start','runtime_status','runtime_stop_preview','runtime_stop','runtime_stop_reconcile','runtime_rollback','runtime_reconcile_rollback','runtime_restart_preview','runtime_restart','runtime_reconcile_restart','runtime_rollback_resume'],mutating=!['runtime_record','runtime_preview','runtime_stop_preview','runtime_restart_preview','runtime_status'].includes(args?.action);
  const optionalIm=Object.hasOwn(args??{},'im');if(optionalIm&&(!['runtime_preview','runtime_start'].includes(args.action)||typeof args.im!=='boolean'))fail('CLOUD_CONFIRMATION_REQUIRED');
  if(!names.includes(args?.action)||!uuid(args.operationId)||!exact(args,['action','operationId',...(optionalIm?['im']:[]),...(args.action==='runtime_restart'?['acknowledgeNativeResume']:[]),...(mutating?['confirm']:[]),...(['runtime_start','runtime_restart','runtime_rollback_resume'].includes(args.action)?['fingerprint']:[]),...(['runtime_stop','runtime_stop_reconcile'].includes(args.action)?['stopPlan']:[]),...(args.action==='runtime_stop'&&args.stopPlan?.schema===2?['acknowledgeNativeInterruption']:[])])||mutating&&args.confirm!==true||['runtime_start','runtime_restart','runtime_rollback_resume'].includes(args.action)&&!hash(args.fingerprint))fail('CLOUD_CONFIRMATION_REQUIRED');
  await gate();
  try{
   const p=await read();if(!p||p.id!==args.operationId||p.phase!=='prepared')fail('CLOUD_RUNTIME_SOURCE_NOT_READY');
   if((mutating||['runtime_restart_preview','runtime_preview'].includes(args.action))&&await reclamationHold(p.id))fail('CLOUD_RECLAIM_RECOVERY_REQUIRED');
   if((mutating||['runtime_restart_preview','runtime_preview'].includes(args.action))&&await uninstallHold(p.id))fail('CLOUD_UNINSTALL_RECOVERY_REQUIRED');
   if(mutating&&repairPending(parseRepairRequest(await credentials().readRecord(repairRecordKey(p.id)),p.id)))fail('CLOUD_RUNTIME_REPAIR_RECOVERY_REQUIRED');
   if((mutating||['runtime_restart_preview','runtime_preview'].includes(args.action))&&(versionPending(parseVersionRequest(await credentials().readRecord(versionRecordKey(p.id)),p.id))||await artifactHold(p.id)))fail('CLOUD_VERSION_RECOVERY_REQUIRED');
   const key=credentialKey('dsh-task-gateway','onboarding-runtime-v1-'+p.id);
   let record=await credentials().readRecord(key);
   if(record&&(record.kind!=='grant'||record.payload?.owner!==OWNER||record.payload?.operationId!==p.id||record.payload?.schema!==1))fail('CLOUD_RUNTIME_RECORD_REVIEW');
   // Opening a wizard reads only the local ledger, never SSH, never resumes work.
   if(args.action==='runtime_record'){
    const a=await archive(p),f=a.files.find(x=>x.path==='plugin/compatibility.json'),compat=f?JSON.parse(Buffer.from(f.data,'base64')):{};
    const repair=parseRepairRequest(await credentials().readRecord(repairRecordKey(p.id)),p.id),receipt=repair?.receipt??null;
    return {operationId:p.id,recorded:!!record,cached:true,observedAt:record?.payload.updatedAt??null,requestState:record?.payload.state??null,receipt:record?.payload.remote??null,error:record?.payload.error??null,initialization:false,
     pluginRepair:{supported:compat.onboardingPluginRepair===1,activationSupported:compat.onboardingPluginRepairActivation===1,pending:repairPending(repair),id:repair?.id??null,requestState:repair?.state??null,receipt:receipt?{...receipt,...(receipt.activation?{activation:{...receipt.activation,activationVerified:false,cached:true}}:{})}:null}};
   }
   if(args.action==='runtime_start'&&record){if(record.payload.fingerprint!==args.fingerprint)fail('CLOUD_RUNTIME_PLAN_DRIFT');return {...record.payload.remote,state:record.payload.remote?.state??'outcome_unknown',operationId:p.id,notResent:true,error:record.payload.error??null,initialization:false,hostStarted:record.payload.remote?.hostStarted===true};}
   if(args.action==='runtime_restart'&&record?.payload.restartFingerprint===args.fingerprint)return {...record.payload.remote,state:record.payload.state==='restart_requested'?'restart_outcome_unknown':record.payload.remote?.state??'outcome_unknown',operationId:p.id,notResent:true,initialization:false,hostStarted:record.payload.remote?.hostStarted===true};
   if(args.action==='runtime_restart'&&record?.payload.state==='restart_requested')fail('CLOUD_RUNTIME_RESTART_REVIEW');
   if((args.action==='runtime_stop_preview'||mutating&&args.action!=='runtime_stop_reconcile')&&record?.payload.state==='stop_requested')fail('CLOUD_RUNTIME_STOP_RECONCILE_REQUIRED');
   if(mutating&&args.action!=='runtime_start'&&!record)fail('CLOUD_RUNTIME_RECORD_REVIEW');
   if(['runtime_stop','runtime_stop_reconcile'].includes(args.action)){
    const plan=args.stopPlan,host=plan?.schema===2;
    if(!exact(plan,['schema','id','operationId','runtimeId','revision','scope','createdAt','expiresAt','members','host','canApply','reason','signature',...(host?['risk','observation']:[])])||!hash(plan.signature)||plan.operationId!==p.id)fail('CLOUD_RUNTIME_STOP_PLAN_REVIEW');
    const {signature,...body}=plan,mac=createHmac('sha256',p.proof).update(JSON.stringify(body)).digest();
    if(!timingSafeEqual(Buffer.from(signature,'hex'),mac))fail('CLOUD_RUNTIME_STOP_PLAN_REVIEW');
    if(args.action==='runtime_stop'){
     if(host&&(args.acknowledgeNativeInterruption!==true||plan.scope!=='owned_host_with_loss_risk'||plan.risk?.contract!==1||plan.risk.requiresExplicitAcknowledgement!==true))fail('CLOUD_RUNTIME_HOST_STOP_CONSENT_REQUIRED');
     if(plan.canApply!==true||plan.reason!=='ready'||!host&&plan.host!==null)fail(plan.reason==='host_drain_required'?'CLOUD_RUNTIME_HOST_DRAIN_REQUIRED':'CLOUD_RUNTIME_STOP_NOT_READY');
     if(!Number.isSafeInteger(plan.createdAt)||plan.expiresAt!==plan.createdAt+300000||plan.expiresAt<=now()||plan.createdAt>now()+1000)fail('CLOUD_RUNTIME_STOP_PLAN_EXPIRED');
    }
   }
   const a=await archive(p),b=await bindingFor(p),controller=a.files.find(x=>x.path==='plugin/onboarding-remote-control.js'),extension=a.files.find(x=>x.path==='plugin/onboarding-runtime-extension.js');
   if(!controller||!extension)fail('CLOUD_RUNTIME_SOURCE_NOT_READY');
   if(args.action.startsWith('runtime_stop')){const c=a.files.find(x=>x.path==='plugin/compatibility.json');if(!c||JSON.parse(Buffer.from(c.data,'base64')).onboardingRuntimeStopPlan!==1)fail('CLOUD_RUNTIME_STOP_UNSUPPORTED');}
   if(args.action==='runtime_stop'&&args.stopPlan.schema===2){const c=a.files.find(x=>x.path==='plugin/compatibility.json');if(!c||JSON.parse(Buffer.from(c.data,'base64')).onboardingHostStopConsent!==1)fail('CLOUD_RUNTIME_HOST_STOP_UNSUPPORTED');}
   if(optionalIm){const c=a.files.find(x=>x.path==='plugin/compatibility.json');if(!c||JSON.parse(Buffer.from(c.data,'base64')).onboardingOptionalIm!==1)fail('CLOUD_RUNTIME_OPTIONAL_IM_UNSUPPORTED');}
   if(args.action.startsWith('runtime_restart')||args.action==='runtime_reconcile_restart'){const c=a.files.find(x=>x.path==='plugin/compatibility.json'),compat=c?JSON.parse(Buffer.from(c.data,'base64')):null;if(compat?.onboardingHostRestart!==1)fail('CLOUD_RUNTIME_RESTART_UNSUPPORTED');if(args.action!=='runtime_reconcile_restart'&&compat.onboardingHostRestartConsent!==1)fail('CLOUD_RUNTIME_RESTART_CONSENT_UNSUPPORTED');}
   if(args.action==='runtime_rollback_resume'){const c=a.files.find(x=>x.path==='plugin/compatibility.json');if(!c||JSON.parse(Buffer.from(c.data,'base64')).onboardingRuntimeCleanup!==1)fail('CLOUD_RUNTIME_CLEANUP_UNSUPPORTED');if(record?.payload.remote?.state!=='cleanup_pending'||record.payload.remote.cleanupFingerprint!==args.fingerprint)fail('CLOUD_RUNTIME_CLEANUP_PLAN_DRIFT');}
   const program=runtimeProgram(Buffer.from(controller.data,'base64').toString('utf8'),Buffer.from(extension.data,'base64').toString('utf8'));
   const q={action:args.action,root:p.root,operationId:p.id,installationId:p.installationId,proof:p.proof,planHash:p.planHash};if(['runtime_start','runtime_restart','runtime_rollback_resume'].includes(args.action))q.fingerprint=args.fingerprint;if(optionalIm)q.im=args.im;if(args.action==='runtime_restart')q.acknowledgeNativeResume=true;if(['runtime_stop','runtime_stop_reconcile'].includes(args.action))q.stopPlan=args.stopPlan;if(args.action==='runtime_stop'&&args.stopPlan.schema===2)q.acknowledgeNativeInterruption=true;
   if(args.action==='runtime_reconcile_restart'){if(!record?.payload.restartFingerprint||record.payload.remote?.restartFingerprint!==record.payload.restartFingerprint)fail('CLOUD_RUNTIME_RESTART_REVIEW');q.fingerprint=record.payload.restartFingerprint;}
   if(args.action==='runtime_start'){
    record={kind:'grant',payload:{owner:OWNER,schema:1,operationId:p.id,fingerprint:args.fingerprint,state:'start_requested',remote:null,error:null,updatedAt:now()}};
    await credentials().modifyRecord(key,old=>{if(old)fail('CLOUD_RUNTIME_ALREADY_REQUESTED');return record;});
   }
   const beforeStop=record;
   if(args.action==='runtime_stop'){
    // Persist the requested target before SSH. A lost response is reconciled,
    // never inferred from a displayed idle state or resent automatically.
    await credentials().modifyRecord(key,old=>{if(!old||old.kind!=='grant'||old.payload?.operationId!==p.id)fail('CLOUD_RUNTIME_RECORD_REVIEW');record={kind:'grant',payload:{...old.payload,state:'stop_requested',stopPlan:args.stopPlan,updatedAt:now()}};return record;});
   }
   const beforeRestart=record;
   if(args.action==='runtime_restart'){await credentials().modifyRecord(key,old=>{if(!old||old.kind!=='grant'||old.payload?.operationId!==p.id||old.payload?.state==='restart_requested')fail('CLOUD_RUNTIME_RECORD_REVIEW');record={kind:'grant',payload:{...old.payload,state:'restart_requested',restartFingerprint:args.fingerprint,nativeResumeAcknowledged:true,restartConsentContract:1,updatedAt:now()}};return record;});}
   const beforeRollback=record;
   if(['runtime_rollback','runtime_reconcile_rollback','runtime_rollback_resume'].includes(args.action)){
    await credentials().modifyRecord(key,old=>{if(!old||old.kind!=='grant'||old.payload?.operationId!==p.id)fail('CLOUD_RUNTIME_RECORD_REVIEW');record={kind:'grant',payload:{...old.payload,state:'rollback_requested',rollbackPrior:old.payload.rollbackPrior??old.payload.remote,updatedAt:now()}};return record;});
   }
   async function reconcileAbsence(){
    const check={root:p.root,operationId:p.id,installationId:p.installationId,proof:p.proof,planHash:p.planHash,prior:record?.payload.rollbackPrior};
    const code=runtimeAbsenceProgram(Buffer.from(controller.data,'base64').toString('utf8'));
    const result=JSON.parse(await ssh.execute(b,runtimeCommand(a.baseline.node.path,code,'runtimeAbsenceCLI'),JSON.stringify(check)));
    if(!result.ok||result.value?.state!=='rolled_back'||result.value.operationId!==p.id||result.value.runtimeId!==check.prior?.runtimeId||result.value.installerProcessesEnded!==true)fail('CLOUD_RUNTIME_ABSENCE_REVIEW');return result.value;
   }
   try{
    let v;
    if(args.action==='runtime_reconcile_rollback')v=await reconcileAbsence();
    else{
     const raw=await ssh.execute(b,runtimeCommand(a.baseline.node.path,program,'runtimeCLI'),JSON.stringify(q),{timeoutMs:['runtime_rollback','runtime_rollback_resume','runtime_restart','runtime_restart_preview','runtime_stop','runtime_stop_preview'].includes(args.action)?120000:30000});
     let r;try{r=JSON.parse(raw);}catch{fail('CLOUD_REMOTE_RESPONSE_REVIEW');}
     if(!r.ok){if(/^ONBOARDING_CLOUD_[A-Z_]+$/.test(r.error))throw Error(r.error);fail('CLOUD_REMOTE_RESPONSE_REVIEW');}
     v=r.value;if(!v||v.operationId!==p.id||typeof v.hostStarted!=='boolean'||args.action!=='runtime_preview'&&v.initialization!==false)fail('CLOUD_REMOTE_RESPONSE_REVIEW');
     if(args.action==='runtime_status'&&v.state==='not_started'&&(record?.payload.state==='rollback_requested'||record?.payload.remote?.state==='rolled_back'))v=await reconcileAbsence();
    }
    if(['runtime_restart_preview','runtime_stop_preview'].includes(args.action))return v;
    const stopWaiting=record?.payload.state==='stop_requested'&&v.stop?.id!==record.payload.stopPlan?.id;
    if(stopWaiting)v={...v,state:'stop_outcome_unknown',priorRuntimeState:v.state};
    const restartWaiting=record?.payload.state==='restart_requested'&&v.restartFingerprint!==record.payload.restartFingerprint;
    if(restartWaiting)v={...v,state:'restart_outcome_unknown',nativeHostReady:false,priorRuntimeState:v.state};
    const waiting=record?.payload.state==='rollback_requested'&&v.state!=='rolled_back';
    if(waiting&&!['cleanup_pending','cleanup_running'].includes(v.state))v={...v,state:'rollback_outcome_unknown',runtimeInstalled:false,priorRuntimeState:v.state};
    if(record)await credentials().modifyRecord(key,old=>{if(!old||old.kind!=='grant'||old.payload?.operationId!==p.id||old.payload?.fingerprint!==record.payload.fingerprint)fail('CLOUD_RUNTIME_RECORD_REVIEW');return {kind:'grant',payload:{...old.payload,state:waiting?'rollback_requested':restartWaiting?'restart_requested':stopWaiting?'stop_requested':'observed',remote:v,error:null,updatedAt:now()}};});
    return v;
   }catch(e){
    if(record)await credentials().modifyRecord(key,old=>{if(!old||old.kind!=='grant'||old.payload?.operationId!==p.id||old.payload?.fingerprint!==record.payload.fingerprint)fail('CLOUD_RUNTIME_RECORD_REVIEW');if(args.action==='runtime_stop'&&e.message==='ONBOARDING_CLOUD_RUNTIME_HOST_STOP_PREFLIGHT_REFUSED')return {kind:'grant',payload:{...beforeStop.payload,error:e.message,updatedAt:now()}};const restartRefusal=args.action==='runtime_restart'&&['ONBOARDING_CLOUD_RUNTIME_PROCESS_ACTIVE','ONBOARDING_CLOUD_RUNTIME_RESTART_NOT_READY','ONBOARDING_CLOUD_RUNTIME_PLAN_DRIFT','ONBOARDING_CLOUD_RUNTIME_RESTART_IMMUTABLE_DRIFT','ONBOARDING_CLOUD_RUNTIME_RESTART_PROFILE_REVIEW','ONBOARDING_CLOUD_RUNTIME_RESTART_WORKER_REVIEW','ONBOARDING_CLOUD_RUNTIME_RESTART_HISTORY_LIMIT','ONBOARDING_CLOUD_RUNTIME_RESTART_REVIEW','ONBOARDING_CLOUD_RUNTIME_SOURCE_CHANGED'].includes(e.message);if(restartRefusal)return {kind:'grant',payload:{...beforeRestart.payload,error:e.message,updatedAt:now()}};const knownRefusal=args.action==='runtime_rollback'&&e.message==='ONBOARDING_CLOUD_RUNTIME_PROCESS_ACTIVE'&&beforeRollback?.payload.state!=='rollback_requested';const payload={...old.payload,error:/^ONBOARDING_[A-Z_]+$/.test(e.message)?e.message:'ONBOARDING_CLOUD_RUNTIME_UNKNOWN',updatedAt:now()};if(knownRefusal){payload.state=beforeRollback.payload.state;if(beforeRollback.payload.rollbackPrior===undefined)delete payload.rollbackPrior;else payload.rollbackPrior=beforeRollback.payload.rollbackPrior;}return {kind:'grant',payload};});
    throw e;
   }
  }finally{busy=false;}
 }
 async function hostRequest(action,args,expectedTarget){
  if(!runtimeEnabled())fail('CLOUD_RUNTIME_DISABLED');
  if(!['notification_defaults_discover','notification_defaults_candidate','file_transfer_queueList','file_transfer_queueReviewPreview','file_transfer_queueReviewApply','file_transfer_queueReviewStatus','file_transfer_queueReviewClose','file_transfer_migrationPreview','file_transfer_migrationRecover','file_transfer_status','file_transfer_preview','file_transfer_apply','file_transfer_fence','task_pair_status','task_pair_preview','task_pair_apply','task_pair_fence','task_pair_forward','task_runtime_status','task_runtime_preview','task_runtime_apply','task_runtime_fence','repository_registry_status','repository_registry_preview','repository_registry_apply','repository_registry_fence','repository_inspect','gitee_inspect','gitee_receipt','gitee_put','gitee_fence','web_access','im_inventory','inspect','receipt','put','fence','model_status','model_preview','model_apply','model_resolve','model_probe_status','model_probe_preview','model_probe_start','token_model_probe_status','token_model_probe_preview','token_model_probe_start','token_inspect','token_receipt','token_put','token_fence','token_model_status','token_model_preview','token_model_apply','token_model_resolve'].includes(action))fail('CLOUD_HANDOFF_ARGUMENTS');
  if(action==='web_access'&&!exact(args,[]))fail('CLOUD_WEB_ARGUMENTS');
  // Controls stop new frames and drain the bounded transport FIFO first.
  // Control mutations are never silently queued or replayed.
  const release=action==='task_pair_forward'?await frameGate():(await gate(),()=>{busy=false;});try{
   const p=await read();if(!p||p.phase!=='prepared')fail('CLOUD_RUNTIME_SOURCE_NOT_READY');
   if(expectedTarget&&(expectedTarget.operationId!==p.id||expectedTarget.installationId!==p.installationId||expectedTarget.root!==p.root||expectedTarget.manifestHash!==p.manifestHash))fail('CLOUD_HANDOFF_TARGET_CHANGED');
   const a=await archive(p),b=await bindingFor(p),file=name=>a.files.find(x=>x.path==='plugin/'+name);
   const capability=file('compatibility.json'),controller=file('onboarding-remote-control.js'),extension=file('onboarding-runtime-extension.js'),bridge=file('onboarding-handoff-remote.js');
   if(!capability||!controller||!extension||!bridge||![1,2].includes(JSON.parse(Buffer.from(capability.data,'base64')).onboardingCloudHandoff))fail('CLOUD_HANDOFF_UNSUPPORTED');
   if(/^(?:token_)?model_(?:resolve|probe_preview)$/.test(action)&&args.clarification!==undefined&&JSON.parse(Buffer.from(capability.data,'base64')).onboardingModelClarification!==1)fail('CLOUD_MODEL_CLARIFICATION_UNSUPPORTED');
   if(/^(?:token_)?model_probe_/.test(action)&&JSON.parse(Buffer.from(capability.data,'base64')).onboardingCloudModelProbe!==2)fail('CLOUD_MODEL_PROBE_UNSUPPORTED');
   if(action.startsWith('file_transfer_')&&JSON.parse(Buffer.from(capability.data,'base64')).onboardingCloudFiles!==1)fail('CLOUD_FILES_UNSUPPORTED');
   if(action.startsWith('file_transfer_queue')&&JSON.parse(Buffer.from(capability.data,'base64')).onboardingCloudFileQueueReview!==1)fail('CLOUD_FILES_QUEUE_UNSUPPORTED');
   if(action.startsWith('file_transfer_migration')&&JSON.parse(Buffer.from(capability.data,'base64')).onboardingCloudFileMigration!==1)fail('CLOUD_FILES_MIGRATION_UNSUPPORTED');
   if(action.startsWith('task_pair_')&&JSON.parse(Buffer.from(capability.data,'base64')).onboardingPeerBinding!==1)fail('CLOUD_PAIR_UNSUPPORTED');
   if(action.startsWith('task_runtime_')&&JSON.parse(Buffer.from(capability.data,'base64')).onboardingCloudTaskRuntime!==1)fail('CLOUD_TASK_RUNTIME_UNSUPPORTED');
   if(action.startsWith('repository_registry_')&&JSON.parse(Buffer.from(capability.data,'base64')).onboardingCloudRepositoryRegistry!==1)fail('CLOUD_REPOSITORY_UNSUPPORTED');
   if((action==='repository_inspect'||action.startsWith('gitee_'))&&JSON.parse(Buffer.from(capability.data,'base64')).onboardingCloudRepository!==1)fail('CLOUD_REPOSITORY_UNSUPPORTED');
   if(action==='web_access'&&JSON.parse(Buffer.from(capability.data,'base64')).onboardingCloudWeb!==1)fail('CLOUD_WEB_UNSUPPORTED');
   if(action.startsWith('notification_defaults_')&&JSON.parse(Buffer.from(capability.data,'base64')).onboardingNotificationDefaults!==1)fail('CLOUD_NOTIFICATION_UNSUPPORTED');
   if(action==='im_inventory'&&JSON.parse(Buffer.from(capability.data,'base64')).onboardingCloudIm!==1)fail('CLOUD_IM_UNSUPPORTED');
   if(action.startsWith('token_')&&JSON.parse(Buffer.from(capability.data,'base64')).onboardingCloudTokenPlan!==1)fail('CLOUD_TOKEN_UNSUPPORTED');
   if(action==='fence'&&JSON.parse(Buffer.from(capability.data,'base64')).onboardingCloudHandoff!==2)fail('CLOUD_HANDOFF_FENCE_UNSUPPORTED');
   if(action.startsWith('model_')&&JSON.parse(Buffer.from(capability.data,'base64')).onboardingCloudModels!==1)fail('CLOUD_MODEL_UNSUPPORTED');
   const decode=x=>Buffer.from(x.data,'base64').toString('utf8'),program=runtimeProgram(decode(controller),decode(extension))+'\n'+decode(bridge);
   const q={action:'handoff',root:p.root,operationId:p.id,installationId:p.installationId,proof:p.proof,planHash:p.planHash,handoff:{...args,action}};
   const raw=await ssh.execute(b,runtimeCommand(a.baseline.node.path,program,'handoffCLI'),JSON.stringify(q),{timeoutMs:action==='task_pair_forward'?30000:120000});
   let result;try{result=JSON.parse(raw);}catch{fail('CLOUD_HANDOFF_RESPONSE_REVIEW');}
   if(result?.ok!==true){
    // Expose only fixed safe categories, never remote messages or payloads.
    const safe=['ONBOARDING_CLOUD_HANDOFF_FILES_QUEUE_UNSUPPORTED','ONBOARDING_CLOUD_HANDOFF_FILES_MIGRATION_UNSUPPORTED','ONBOARDING_CLOUD_HANDOFF_FILES_UNSUPPORTED','ONBOARDING_CLOUD_HANDOFF_MODEL_CLARIFICATION_UNSUPPORTED','ONBOARDING_CLOUD_HANDOFF_MODEL_PROBE_UNSUPPORTED','ONBOARDING_CLOUD_HANDOFF_PAIR_UNSUPPORTED','ONBOARDING_CLOUD_HANDOFF_TASK_RUNTIME_UNSUPPORTED','ONBOARDING_CLOUD_HANDOFF_REPOSITORY_UNSUPPORTED','ONBOARDING_CLOUD_HANDOFF_IM_UNSUPPORTED','ONBOARDING_CLOUD_HANDOFF_HOST_NOT_READY','ONBOARDING_CLOUD_HANDOFF_TARGET_CHANGED','ONBOARDING_CLOUD_HANDOFF_IDENTITY_REVIEW','ONBOARDING_CLOUD_HANDOFF_RUNTIME_SOURCE_CHANGED','ONBOARDING_CLOUD_HANDOFF_AUTH_FAILED','ONBOARDING_CLOUD_HANDOFF_TOKEN_UNSUPPORTED','ONBOARDING_CLOUD_HANDOFF_MODEL_UNAVAILABLE','ONBOARDING_CLOUD_HANDOFF_FENCE_UNSUPPORTED'];
    if(safe.includes(result?.error)||action.startsWith('file_transfer_')&&/^ONBOARDING_FILES_[A-Z_]+$/.test(result?.error)||(action.startsWith('task_pair_')||action.startsWith('task_runtime_'))&&/^ONBOARDING_TASK_RUNTIME_[A-Z_]+$/.test(result?.error)||action.startsWith('repository_')&&/^ONBOARDING_REPOSITORY_[A-Z_]+$/.test(result?.error)||/^(?:token_)?model_/.test(action)&&/^ONBOARDING_MODEL_[A-Z_]+$/.test(result?.error))throw Error(result.error);
    fail('CLOUD_HANDOFF_REMOTE_REVIEW');
   }
   if(action==='web_access'){
    const access=validateCloudWebAccess(result.value);
    if(access.target.operationId!==p.id||access.target.installationId!==p.installationId||access.target.root!==p.root||access.target.manifestHash!==p.manifestHash)fail('CLOUD_WEB_TARGET_REVIEW');
    if(typeof ssh.forward!=='function')fail('CLOUD_WEB_TRANSPORT_UNAVAILABLE');
    return {...access,tunnel:await ssh.forward(b,access.value.port)};
   }
   if(action.startsWith('notification_defaults_')||action.startsWith('file_transfer_')||/^(?:token_)?model_probe_/.test(action)||action.startsWith('repository_')||action.startsWith('gitee_')||action.startsWith('task_pair_')||action.startsWith('task_runtime_')){const t=result.value?.target;if(!t||t.operationId!==p.id||t.installationId!==p.installationId||t.root!==p.root||t.manifestHash!==p.manifestHash)fail('CLOUD_HANDOFF_TARGET_CHANGED');}
   return result.value;
  }finally{release();}
 }
 async function reclamationHold(id){return reclaimBlocked(parseReclaimRequest(await credentials().readRecord(reclaimRecordKey(id)),id));}
 async function uninstallHold(id){return uninstallBlocked(parseUninstallRequest(await credentials().readRecord(uninstallRecordKey(id)),id));}
 async function artifactHold(id){return artifactsPending(parseArtifactsRequest(await credentials().readRecord(artifactsRecordKey(id)),id));}
 async function versionAction(args){
  if(!runtimeEnabled())fail('CLOUD_RUNTIME_DISABLED');if(!uuid(args?.operationId))fail('CLOUD_CONFIRMATION_REQUIRED');await gate();
  try{
   const p=await read();if(!p||p.id!==args.operationId||p.phase!=='prepared')fail('CLOUD_RUNTIME_SOURCE_NOT_READY');
   const query=['record','candidate_status','status','rules_record','rules_status','uninstall_record','uninstall_status','reclaim_record','reclaim_status','activation_record','activation_status'].includes(args.action),r=await credentials().readRecord(credentialKey('dsh-task-gateway','onboarding-runtime-v1-'+p.id));
   if(r&&(r.kind!=='grant'||r.payload?.owner!==OWNER||r.payload?.operationId!==p.id||r.payload?.schema!==1))fail('CLOUD_RUNTIME_RECORD_REVIEW');
   if(!query&&(!r||r.payload.state!=='observed'||repairPending(parseRepairRequest(await credentials().readRecord(repairRecordKey(p.id)),p.id))))fail('CLOUD_RUNTIME_RECONCILE_REQUIRED');
   const activation=typeof args.action==='string'&&args.action.startsWith('activation_'),rules=typeof args.action==='string'&&args.action.startsWith('rules_'),uninstall=typeof args.action==='string'&&args.action.startsWith('uninstall_'),reclaim=typeof args.action==='string'&&args.action.startsWith('reclaim_');
   if(!query&&!reclaim&&await reclamationHold(p.id))fail('CLOUD_RECLAIM_RECOVERY_REQUIRED');
   if(!query&&!uninstall&&!reclaim&&await uninstallHold(p.id))fail('CLOUD_UNINSTALL_RECOVERY_REQUIRED');
   if(!query&&((rules||uninstall||reclaim||activation)&&versionPending(parseVersionRequest(await credentials().readRecord(versionRecordKey(p.id)),p.id))||(!rules||uninstall||reclaim)&&await artifactHold(p.id)))fail('CLOUD_VERSION_RECOVERY_REQUIRED');
   return await (activation?runtimeVersionActivationClient:reclaim?runtimeReclaimClient:uninstall?runtimeUninstallClient:rules?runtimeArtifactsClient:runtimeVersionClient)({args,p,a:await archive(p),b:['record','rules_record','uninstall_record','reclaim_record','activation_record','candidate_preview'].includes(args.action)?null:await bindingFor(p),runtimeId:r?.payload.remote?.runtimeId,credentials,ssh,localState,source,now});
  }finally{busy=false;}
 }
 return {stage,status,rollback,retire,runtimeAction,versionAction,hostRequest,archiveTerminal,preserveTerminalIfAny:async()=>{if(await read())await archiveTerminal();},hasUnfinished:async()=>{const p=await read();return !!p&&!['rolled_back','retired'].includes(p.phase);}};
}
