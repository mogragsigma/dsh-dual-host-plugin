// Local durable intent is separate from the native runtime status receipt.
import {credentialKey} from '@deepseek-ai/dsh-credentials';
import {runtimeProgram,runtimeCommand} from './onboarding-runtime-program.js';
export const repairRecordKey=id=>credentialKey('dsh-task-gateway','onboarding-runtime-repair-v1-'+id);
export const repairPending=p=>!!p&&(p.state==='requested'||p.receipt?.repair?.recoveryRequired===true);
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const exact=(x,k)=>x&&Object.keys(x).sort().join()===k.slice().sort().join();
const fail=c=>{throw Error('ONBOARDING_CLOUD_RUNTIME_REPAIR_'+c);};
export function parseRepairRequest(r,operationId){
 if(!r)return null;const p=r.payload;
 if(r.kind!=='grant'||!exact(p,['schema','operationId','id','action','fingerprint','state','receipt'])||p.schema!==1||p.operationId!==operationId||!uuid(p.id)||!['runtime_repair_apply','runtime_repair_recover'].includes(p.action)||p.fingerprint!==null&&!hex(p.fingerprint)||!['requested','observed'].includes(p.state))fail('LOCAL_LEDGER_REVIEW');if(p.state==='requested'?p.receipt!==null:(!p.receipt||typeof p.receipt.state!=='string'||p.receipt.repair?.id!==p.id||typeof p.receipt.repair?.recoveryRequired!=='boolean'))fail('LOCAL_LEDGER_REVIEW');return p;
}
export async function runtimeRepairClient({args,p,a,b,credentials,ssh}){
 const action=args?.action,verifying=action==='runtime_repair_verify',mutating=['runtime_repair_apply','runtime_repair_recover'].includes(action);
 if(!['runtime_repair_preview','runtime_repair_status','runtime_repair_apply','runtime_repair_recover','runtime_repair_verify'].includes(action)||!exact(args,['action','operationId',...(mutating?['repairId','confirm']:verifying?['repairId']:[]),...(action==='runtime_repair_apply'?['fingerprint']:[])])||args.operationId!==p.id||mutating&&(!uuid(args.repairId)||args.confirm!==true)||verifying&&!uuid(args.repairId)||action==='runtime_repair_apply'&&!hex(args.fingerprint))fail('CONFIRMATION_REQUIRED');
 const compat=a.files.find(f=>f.path==='plugin/compatibility.json');if(!compat||JSON.parse(Buffer.from(compat.data,'base64')).onboardingPluginRepair!==1)fail('UNSUPPORTED');
 if(verifying&&JSON.parse(Buffer.from(compat.data,'base64')).onboardingPluginRepairActivation!==1)fail('ACTIVATION_UNSUPPORTED');
 const controller=a.files.find(f=>f.path==='plugin/onboarding-remote-control.js'),extension=a.files.find(f=>f.path==='plugin/onboarding-runtime-extension.js');if(!controller||!extension)fail('ARCHIVE_REVIEW');
 const key=repairRecordKey(p.id),c=credentials(),old=parseRepairRequest(await c.readRecord(key),p.id);
 if(mutating&&old?.id===args.repairId&&old.action===action&&(action==='runtime_repair_apply'||old.state==='requested')){
  if(old.fingerprint!==(args.fingerprint??null))fail('PLAN_DRIFT');return {operationId:p.id,initialization:false,hostStarted:false,state:old.state==='requested'?'repair_outcome_unknown':old.receipt?.state??'repair_outcome_unknown',repair:old.receipt?.repair??null,notResent:true,cached:true};
 }
 if(repairPending(old)&&(verifying||['runtime_repair_preview','runtime_repair_apply'].includes(action)||action==='runtime_repair_recover'&&old.id!==args.repairId))fail('RECOVERY_REQUIRED');
 const q={action,root:p.root,operationId:p.id,installationId:p.installationId,proof:p.proof,planHash:p.planHash,...(mutating||verifying?{repairId:args.repairId}:{}),...(action==='runtime_repair_apply'?{fingerprint:args.fingerprint}:{})};
 const program=runtimeProgram(Buffer.from(controller.data,'base64').toString(),Buffer.from(extension.data,'base64').toString());
 const command=runtimeCommand(a.baseline.node.path,program,'runtimeCLI');
 let request=old;
 if(mutating){
  request={schema:1,operationId:p.id,id:args.repairId,action,fingerprint:args.fingerprint??null,state:'requested',receipt:null};
  await c.modifyRecord(key,r=>{if(JSON.stringify(parseRepairRequest(r,p.id))!==JSON.stringify(old))fail('LOCAL_CONFLICT');return {kind:'grant',payload:request};});
 }
 let result;try{
  const raw=await ssh.execute(b,command,JSON.stringify(q),{timeoutMs:120000});
  result=JSON.parse(raw);
 }catch{fail('OUTCOME_UNKNOWN');}
 if(!result.ok){
  if(mutating&&result.error==='ONBOARDING_CLOUD_RUNTIME_REPAIR_PREFLIGHT_REFUSED')await c.modifyRecord(key,r=>{const cur=parseRepairRequest(r,p.id);if(JSON.stringify(cur)!==JSON.stringify(request))fail('LOCAL_CONFLICT');return {kind:'grant',payload:{...request,state:'observed',receipt:{state:'repair_refused',repair:{id:request.id,state:'refused',recoveryRequired:false}}}};});
  throw Error(/^ONBOARDING_CLOUD_[A-Z_]+$/.test(result.error)?result.error:'ONBOARDING_CLOUD_RUNTIME_REPAIR_RESPONSE_REVIEW');
 }
 const v=result.value;
 if(!v||v.operationId!==p.id||!uuid(v.runtimeId)||v.initialization!==false||typeof v.hostStarted!=='boolean'||action==='runtime_repair_preview'&&(!uuid(v.id)||!hex(v.fingerprint)||typeof v.canApply!=='boolean')||action!=='runtime_repair_preview'&&(!v.repair||v.repair.contract!==1||typeof v.repair.recoveryRequired!=='boolean'))fail('RESPONSE_REVIEW');
 if(verifying&&(v.repair.id!==args.repairId||v.repair.state!=='committed'||v.activation?.contract!==1||v.activation.activationVerified!==true||v.activation.cached!==false||v.activation.repairId!==args.repairId||!Number.isSafeInteger(v.activation.observedAt)))fail('RESPONSE_REVIEW');
 if(request&&action!=='runtime_repair_preview'){
  const matched=v.repair.id===request.id;
  await c.modifyRecord(key,r=>{if(JSON.stringify(parseRepairRequest(r,p.id))!==JSON.stringify(request))fail('LOCAL_CONFLICT');return {kind:'grant',payload:{...request,state:matched?'observed':request.state,receipt:matched?v:request.receipt}};});
  if(!matched&&request.state==='requested')return {...v,state:'repair_outcome_unknown',originalRepairId:request.id,notResent:true};
 }
 return v;
}
