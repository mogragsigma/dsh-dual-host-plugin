// Process-local admission for own setup surfaces, including fresh Hosts with no Gateway.
// It is not a native Host shutdown lease and never persists or cancels user work.
import {randomUUID,createHash} from 'node:crypto';
const exact=(v,k)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===k.slice().sort().join();
const fail=c=>{throw Error('ONBOARDING_ACTIVITY_'+c);};
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const labels=['rpc','startup','model_attempt','workbench_http','workbench_websocket','notification_defaults_sync'];
const startupKeys=['models','token_models','local_pair','cloud_runtime','configured_gateway'];
export function createOnboardingActivity({now=Date.now,initialAdmission='open'}={}){
 if(!['open','checking'].includes(initialAdmission))fail('ADMISSION_REVIEW');
 let admission=initialAdmission;
 const instanceId=randomUUID(),active=new Map(labels.map(k=>[k,0]));let closed=false,plan=null,lease=null,last=null;
 const startups=new Map(),runningStartups=new Map();
 function begin(row){
  if(closed||lease||admission!=='open'||row.cancelled||row.state!=='waiting'||runningStartups.has(row.key))return;
  row.state='running';runningStartups.set(row.key,row);
  // Keep an in-flight startup counted even if its dependency scope is disposed.
  const finish=state=>{row.state=state;runningStartups.delete(row.key);const next=startups.get(row.key);if(next&&next!==row)begin(next);};
  let work;try{work=run('startup',row.fn);}catch{finish('needs_review');return;}
  Promise.resolve(work).then(()=>finish('settled'),()=>finish('needs_review'));
 }
 function deferStartup(key,fn){
  if(!startupKeys.includes(key)||typeof fn!=='function')fail('STARTUP_REVIEW');if(closed)fail('CLOSED');
  if(startups.has(key))fail('STARTUP_DUPLICATE');
  const row={key,state:'waiting',fn,cancelled:false};startups.set(key,row);begin(row);
  return ()=>{row.cancelled=true;if(startups.get(key)===row)startups.delete(key);};
 }
 function enter(label){
  if(!active.has(label))fail('LABEL_REVIEW');if(closed)fail('CLOSED');if(lease)fail('HELD');if(admission!=='open')fail('ADMISSION_BLOCKED');
  active.set(label,active.get(label)+1);let done=false;
  return ()=>{if(done)return;done=true;active.set(label,active.get(label)-1);};
 }
 function run(label,fn){const leave=enter(label);try{const result=fn();if(result&&typeof result.then==='function')return Promise.resolve(result).finally(leave);leave();return result;}catch(e){leave();throw e;}}
 function status(a={}){
  if(!exact(a,[]))fail('ARGUMENTS');const counts=Object.fromEntries(active),busy=[...active.values()].some(n=>n!==0);
  return {contract:1,instanceId,scope:'own_onboarding_only',state:closed?'closed':lease?(busy?'needs_review':'held'):'open',operationId:lease?.id??null,admission,counts,startups:Object.fromEntries([...startups].map(([key,row])=>[key,row.state])),busy,canHold:!closed&&!lease&&!busy,persisted:false,hostStopAuthorized:false,pluginSwitchAuthorized:false,observedAt:now(),last:last?{...last}:null};
 }
 function preview(a={}){
  if(!exact(a,[]))fail('ARGUMENTS');if(closed)fail('CLOSED');if(lease)fail('ALREADY_HELD');plan=null;
  const s=status(),p={id:randomUUID(),instanceId,scope:s.scope,counts:s.counts,canApply:s.canHold,expiresAt:now()+300000,hostStopAuthorized:false,pluginSwitchAuthorized:false};
  plan={...p,fingerprint:digest(p)};return structuredClone(plan);
 }
 function apply(a){
  if(!exact(a,['id','fingerprint','confirm'])||a.confirm!==true)fail('CONFIRMATION_REQUIRED');if(closed)fail('CLOSED');
  if(lease?.id===a.id&&lease.fingerprint===a.fingerprint)return {...status(),notResent:true};if(last?.id===a.id)fail('RELEASED');
  const p=plan;if(!p||p.id!==a.id||p.fingerprint!==a.fingerprint||p.expiresAt<=now())fail('PLAN_EXPIRED');plan=null;
  // No asynchronous gap between the final observation and closure of admission.
  if(!p.canApply||!status().canHold)fail('BUSY');lease={id:p.id,fingerprint:p.fingerprint};return status();
 }
 function release(a){
  if(!exact(a,['operationId','instanceId','confirm'])||a.confirm!==true)fail('CONFIRMATION_REQUIRED');if(closed)fail('CLOSED');if(a.instanceId!==instanceId)fail('INSTANCE_CHANGED');
  if(!lease){if(last?.id===a.operationId)return {...status(),notResent:true};fail('NOT_HELD');}if(a.operationId!==lease.id)fail('OPERATION_CHANGED');
  last={id:lease.id,state:'released',at:now()};lease=null;plan=null;
  // An explicit release resumes only live deferred dependency initialization,
  // not failed operations, model requests, or callbacks from disposed scopes.
  for(const row of startups.values())begin(row);return status();
 }
 // Do not reset counts or abort accepted operations during service disposal.
 function close(){closed=true;plan=null;for(const row of startups.values())row.cancelled=true;startups.clear();}
 // Internal startup/ledger seam, never exposed as an unconfirmed public unlock.
 function setAdmission(state){
  if(!['open','checking','fenced','unavailable'].includes(state))fail('ADMISSION_REVIEW');if(closed)fail('CLOSED');
  admission=state;if(state==='open')for(const row of startups.values())begin(row);
 }
 return {enter,run,status,preview,apply,release,deferStartup,setAdmission,close,get blocked(){return closed||!!lease||admission!=='open';}};
}
