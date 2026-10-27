// Point-in-time diagnostics only. Never changes file receipts or grants restart authority.
import {createHash} from 'node:crypto';
import {credentialKey} from '@deepseek-ai/dsh-credentials';
import {parseVersionRequest,versionPending,versionRecordKey} from './onboarding-runtime-version-client.js';
import {runtimeProgram,runtimeCommand} from './onboarding-runtime-program.js';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fail=c=>{throw Error('ONBOARDING_CLOUD_VERSION_ACTIVATION_'+c);};
const exact=(v,k)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===k.slice().sort().join();
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const version=v=>typeof v==='string'&&v.length<100&&/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(v);
const scope='maintained_plugin_version_observed';
const fields=['contract','scope','activationVerified','cached','liveStateVerified','observedAt','restartId','sameRecordedHost','automaticRestart','versionMaintenance','transactionState','pluginVersion','versionTransactionId','sameRecordedRelease','operationId','runtimeId','initialization','requestedTransactionId'];
export const versionActivationKey=id=>credentialKey('dsh-task-gateway','onboarding-version-activation-v1-'+id);
function check(v,p,runtimeId){
 if(!exact(v,fields)||v.operationId!==p.id||v.runtimeId!==runtimeId||!uuid(runtimeId)||!uuid(v.requestedTransactionId)||v.contract!==1||v.scope!==scope||v.versionMaintenance!==true||v.initialization!==false||v.automaticRestart!==false||v.liveStateVerified!==false||!['activationVerified','cached','sameRecordedHost','sameRecordedRelease'].every(k=>typeof v[k]==='boolean')||v.cached===v.activationVerified)fail('RESPONSE_REVIEW');
 if(v.observedAt===null){if(v.activationVerified||v.restartId!==null||v.transactionState!==null||v.pluginVersion!==null||v.versionTransactionId!==null||v.sameRecordedHost||v.sameRecordedRelease)fail('RESPONSE_REVIEW');}
 else if(!Number.isSafeInteger(v.observedAt)||v.observedAt<=0||!uuid(v.restartId)||!uuid(v.versionTransactionId)||!version(v.pluginVersion)||!['committed','rolled_back'].includes(v.transactionState)||v.activationVerified&&(!v.sameRecordedHost||!v.sameRecordedRelease||v.versionTransactionId!==v.requestedTransactionId))fail('RESPONSE_REVIEW');
 return v;
}
export async function runtimeVersionActivationClient({args,p,a,b,runtimeId,credentials,ssh}){
 const action=args?.action,local=action==='activation_record';
 if(!['activation_record','activation_status','activation_verify'].includes(action)||!exact(args,['action','operationId',...(local?[]:['id'])])||args.operationId!==p.id||!local&&!uuid(args.id))fail('ARGUMENTS');
 const c=credentials(),key=versionActivationKey(p.id),binding=hash({operationId:p.id,archiveHash:p.archiveHash,bindingFingerprint:p.bindingFingerprint});
 const parse=record=>{if(!record)return null;const d=record.payload;
  if(record.kind!=='grant'||!exact(d,['schema','operationId','runtimeId','binding','records'])||d.schema!==1||d.operationId!==p.id||!uuid(d.runtimeId)||runtimeId&&d.runtimeId!==runtimeId||d.binding!==binding||!Array.isArray(d.records)||d.records.length>128)fail('LOCAL_LEDGER_REVIEW');
  for(const r of d.records)check(r,p,d.runtimeId);return d;
 };
 let ledger=parse(await c.readRecord(key));
 const decode=n=>{const f=a.files.find(f=>f.path==='plugin/'+n);if(!f)fail('ARCHIVE_REVIEW');return Buffer.from(f.data,'base64').toString();};
 const compat=JSON.parse(decode('compatibility.json')),supported=['onboardingPluginVersion','onboardingPluginVersionRequests','onboardingPluginVersionArtifacts','onboardingVersionActivation'].every(k=>compat[k]===1);
 const historical=r=>({...r,activationVerified:false,cached:true,historical:true});
 if(local)return {operationId:p.id,runtimeId:ledger?.runtimeId??runtimeId??null,supported,cached:true,historical:true,activationVerified:false,records:(ledger?.records??[]).map(historical)};
 if(!supported)fail('UNSUPPORTED');if(!uuid(runtimeId))fail('RUNTIME_RECORD_REQUIRED');
 const versions=parseVersionRequest(await c.readRecord(versionRecordKey(p.id)),p.id);
 if(!versions||versions.binding!==binding||versions.runtimeId!==runtimeId||!versions.plans.some(v=>v.kind==='apply'&&v.id===args.id))fail('TRANSACTION_UNKNOWN');
 if(action==='activation_verify'&&versionPending(versions))fail('RECOVERY_REQUIRED');
 const program=runtimeProgram(decode('onboarding-remote-control.js'),decode('onboarding-runtime-extension.js')),command=runtimeCommand(a.baseline.node.path,program,'runtimeVersionCLI');
 const q={action:'runtime_version',root:p.root,operationId:p.id,installationId:p.installationId,proof:p.proof,planHash:p.planHash,versionAction:action,args:{id:args.id}};
 let result;try{result=JSON.parse(await ssh.execute(b,command,JSON.stringify(q),{timeoutMs:120000}));}catch{fail('OBSERVATION_UNAVAILABLE');}
 if(result?.ok!==true)throw Error(typeof result?.error==='string'&&/^ONBOARDING_CLOUD_[A-Z_]{1,100}$/.test(result.error)?result.error:'ONBOARDING_CLOUD_VERSION_ACTIVATION_RESPONSE_REVIEW');
 const v=check(result.value,p,runtimeId);
 if(v.requestedTransactionId!==args.id||v.activationVerified!==(action==='activation_verify'))fail('RESPONSE_REVIEW');
 const records=[...(ledger?.records??[])],last=records.at(-1),same=last&&['requestedTransactionId','versionTransactionId','restartId','pluginVersion','transactionState'].every(k=>last[k]===v[k]);
 if(same)records[records.length-1]=v;else{if(records.length>=128)fail('HISTORY_FULL');records.push(v);}
 const next={schema:1,operationId:p.id,runtimeId,binding,records};parse({kind:'grant',payload:next});
 await c.modifyRecord(key,old=>{if(JSON.stringify(parse(old))!==JSON.stringify(ledger))fail('LOCAL_CONFLICT');return {kind:'grant',payload:next};});
 return {...v,historical:action==='activation_status'};
}
