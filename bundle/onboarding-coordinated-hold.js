// Joint acquisition of supported public component leases, not a Host stop grant.
// A dependency replacement invalidates the observation; never adopt a new lease.
import {randomUUID,createHash} from 'node:crypto';
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===keys.slice().sort().join();
const fail=c=>{throw Error('ONBOARDING_COORDINATED_HOLD_'+c);};
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const keys=['onboarding','gateway','agents'];
const confirm=p=>({id:p.id,fingerprint:p.fingerprint,confirm:true});
export function createOnboardingCoordinatedHold({components,now=Date.now}){
 const instanceId=randomUUID();let plan=null,lease=null,last=null,closed=false;
 const ready=()=>{if(closed)fail('CLOSED');};
 function originalMember(key,row){
  try{const s=row.part.status({});return {state:s.state,instanceId:s.instanceId,operationId:s.operationId,counts:s.counts};}catch{}
  if(key==='gateway')try{
   const s=row.part.closureStatus({});
   if(s.contract===1&&s.scope==='own_gateway_only'&&s.instanceId===row.instanceId&&s.operationId===row.id&&s.state==='closed'&&s.hostStopAuthorized===false&&s.pluginSwitchAuthorized===false&&s.counts&&Object.keys(s.counts).length&&Object.values(s.counts).every(n=>Number.isSafeInteger(n)&&n===0))return {state:'closed',instanceId:s.instanceId,operationId:s.operationId,counts:s.counts};
  }catch{}
  return {state:'unavailable'};
 }
 function observe(){
  const current=components(),rows={};
  for(const key of keys){const part=current[key];
   if(!part){rows[key]={state:key==='gateway'&&!current.gatewayExpected?'not_configured':'unavailable'};continue;}
   try{const s=part.status({});rows[key]={state:s.state,instanceId:s.instanceId,operationId:s.operationId,counts:s.counts,inboxState:s.inboxState??null};}
   catch{rows[key]={state:'unavailable'};}
  }
  return {current,rows};
 }
 function view(){
  const {current,rows}=observe();let changed=!!(current.gatewayExpected&&!current.gateway);
  if(lease)for(const key of keys){
   const row=lease.members[key];
   if(row){const s=rows[key];if(current[key]!==row.part||s.instanceId!==row.instanceId||s.operationId!==row.id||s.state!=='held')changed=true;}
   else if(current[key])changed=true;
  }
  const originalComponents=Object.fromEntries(Object.entries(lease?.members??{}).map(([key,row])=>[key,originalMember(key,row)]));
  return {contract:1,instanceId,scope:'coordinated_components_only',state:closed?'closed':lease?(changed||lease.failed?'needs_review':'held'):'open',operationId:lease?.id??null,components:rows,originalComponents,thirdPartyIm:current.imPresent?'unverified':'not_observed',persisted:false,hostStopAuthorized:false,pluginSwitchAuthorized:false,last:last?{...last}:null,observedAt:now()};
 }
 function status(a={}){if(!exact(a,[]))fail('ARGUMENTS');return view();}
 function preview(a={}){
  if(!exact(a,[]))fail('ARGUMENTS');ready();if(lease)fail('ALREADY_HELD');plan=null;
  const {current,rows}=observe(),refs={},parts={},reasons=[];
  for(const key of keys){
   const part=current[key];refs[key]=part??null;
   if(!part){if(rows[key].state!=='not_configured')reasons.push(key+'_unavailable');continue;}
   try{const p=part.preview({});parts[key]=p;if(p.canApply!==true)reasons.push(key+'_busy');}
   catch{reasons.push(key+'_unavailable');}
  }
  const body={id:randomUUID(),instanceId,scope:'coordinated_components_only',components:rows,canApply:reasons.length===0,reasons,expiresAt:now()+300000,persisted:false,hostStopAuthorized:false,pluginSwitchAuthorized:false};
  const publicPlan={...body,fingerprint:digest(body)};plan={publicPlan,refs,parts};return structuredClone(publicPlan);
 }
 function releaseMembers(l){
  // Re-open the Gateway and native agents before resuming deferred onboarding.
  // Only exact captured members are released, even after dependency replacement.
  for(const key of ['gateway','agents','onboarding']){
   const row=l.members[key];if(!row)continue;
   try{const before=originalMember(key,row);if(before.instanceId!==row.instanceId)throw Error();
    if(before.state==='closed'){delete l.members[key];continue;}
    if(before.state!=='open'||before.operationId!==null){const s=row.part.release({instanceId:row.instanceId,operationId:row.id,confirm:true});if(s.state!=='open'||s.operationId!==null)throw Error();}
    delete l.members[key];
   }catch{return false;}
  }
  return true;
 }
 function apply(a){
  if(!exact(a,['id','fingerprint','confirm'])||a.confirm!==true)fail('CONFIRMATION_REQUIRED');ready();
  if(lease?.id===a.id&&lease.fingerprint===a.fingerprint)return {...view(),notResent:true};if(last?.id===a.id)fail('RELEASED');
  const p=plan,b=p?.publicPlan;if(!p||b.id!==a.id||b.fingerprint!==a.fingerprint||b.expiresAt<=now())fail('PLAN_EXPIRED');plan=null;
  if(!b.canApply)fail('BUSY');const current=components();
  for(const key of keys)if((current[key]??null)!==p.refs[key])fail('DEPENDENCY_CHANGED');
  if(current.gatewayExpected&&!current.gateway)fail('DEPENDENCY_CHANGED');
  const l={id:b.id,fingerprint:b.fingerprint,members:{},failed:false};lease=l;
  try{
   // All three component acquisitions are synchronous; no partial awaited gap.
   for(const key of keys){const part=p.refs[key];if(!part)continue;const child=p.parts[key];
    l.members[key]={part,id:child.id,instanceId:child.instanceId};const s=part.apply(confirm(child));
    if(s.state!=='held'||s.operationId!==child.id||s.instanceId!==child.instanceId)fail('MEMBER_REVIEW');
   }
   const s=view();if(s.state!=='held')fail('MEMBER_REVIEW');return s;
  }catch{
   l.failed=true;if(releaseMembers(l)){last={id:l.id,state:'acquire_failed_released',at:now()};lease=null;}
   fail(lease?'RELEASE_REVIEW':'ACQUIRE_FAILED');
  }
 }
 function release(a){
  if(!exact(a,['instanceId','operationId','confirm'])||a.confirm!==true)fail('CONFIRMATION_REQUIRED');ready();if(a.instanceId!==instanceId)fail('INSTANCE_CHANGED');
  if(!lease){if(last?.id===a.operationId)return {...view(),notResent:true};fail('NOT_HELD');}if(lease.id!==a.operationId)fail('OPERATION_CHANGED');
  const l=lease;l.failed=true;plan=null;
  if(!releaseMembers(l))fail('RELEASE_REVIEW');last={id:l.id,state:'released',at:now()};lease=null;return view();
 }
 function assertIndividualOpen(){if(lease)fail('SESSION_ACTIVE');}
 function dispose(){closed=true;plan=null;if(lease)releaseMembers(lease);/* Release only captured own leases, never stop the Host. */}
 return {status,preview,apply,release,assertIndividualOpen,dispose,get active(){return !!lease;}};
}
