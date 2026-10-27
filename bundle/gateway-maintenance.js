// Own Gateway admission barrier. Never authorizes stopping the entire DSH Host.
import {randomUUID,createHash} from 'node:crypto';
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===keys.slice().sort().join();
const fail=c=>{throw Error('ONBOARDING_GATEWAY_HOLD_'+c);};
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function createGatewayMaintenance(g,{now=Date.now}={}){
 const instanceId=randomUUID(),active=new Map();let plan=null,lease=null,last=null,closure=null,closureAttempted=false;
 const ready=()=>{if(g.closed)fail('CLOSED');};
 function assertOpen(){ready();if(lease)throw Error('PROTOCOL_MAINTENANCE_ACTIVE');}
 function enter(label){assertOpen();active.set(label,(active.get(label)??0)+1);let ended=false;return ()=>{if(ended)return;ended=true;const n=active.get(label)-1;if(n)active.set(label,n);else active.delete(label);};}
 function run(label,fn){const done=enter(label);try{const value=fn();if(value&&typeof value.then==='function')return Promise.resolve(value).finally(done);done();return value;}catch(e){done();throw e;}}
 function counts(){
  return {requests:[...active.values()].reduce((a,b)=>a+b,0),proxyHttp:active.get('workbench_http')??0,proxyWebsocket:active.get('workbench_websocket')??0,gatewayTick:+!!g.tickPending,
   submissions:g.deliveries?.size??0,schedulerRuns:g.scheduler?.active.size??0,
   taskOwnership:g.store?.db.prepare('SELECT count(*) n FROM tasks WHERE busy<>0').get().n??0,
   files:+!!g.files?.pending,delivery:+!!g.deliveryRuntime?.pending,
   deliveryPreparation:g.deliveryRuntime?.preparations.size??0,
   development:g.development?.gate.inflight.size??0,developmentPeer:g.developmentPeer?.pending.size??0,
   a2a:+!!g.a2aEndpoint?.pending+ +!!g.a2aEndpoint?.active+ +!!g.a2aEndpoint?.undrained,
   approvals:+!!g.chatApproval?.running,artifacts:g.artifacts?.pending.size??0};
 }
 function status(a={}){if(!exact(a,[]))fail('ARGUMENTS');ready();const c=counts(),busy=Object.values(c).some(n=>n!==0);
  return {contract:1,instanceId,gatewayInstanceId:g.instanceId,scope:'own_gateway_only',state:lease?(busy?'needs_review':'held'):'open',operationId:lease?.id??null,counts:c,canHold:!lease&&!busy,last:last?{...last}:null,persisted:false,hostStopAuthorized:false,pluginSwitchAuthorized:false,observedAt:now()};
 }
 function preview(a={}){if(!exact(a,[]))fail('ARGUMENTS');plan=null;const s=status();if(lease)fail('ALREADY_HELD');
  const p={id:randomUUID(),instanceId,gatewayInstanceId:g.instanceId,scope:s.scope,counts:s.counts,canApply:s.canHold,expiresAt:now()+300000,hostStopAuthorized:false,pluginSwitchAuthorized:false};plan={...p,fingerprint:digest(p)};return structuredClone(plan);
 }
 function apply(a){if(!exact(a,['id','fingerprint','confirm'])||a.confirm!==true)fail('CONFIRMATION_REQUIRED');ready();
  if(lease?.id===a.id&&lease.fingerprint===a.fingerprint)return {...status(),notResent:true};if(last?.id===a.id)fail('RELEASED');
  const p=plan;if(!p||p.id!==a.id||p.fingerprint!==a.fingerprint||p.expiresAt<=now())fail('PLAN_EXPIRED');
  // No await between the final idle check and closing admission. Busy work is
  // neither aborted nor rewritten; retry requires a new explicit preview.
  plan=null;if(!p.canApply||!status().canHold)fail('BUSY');lease={id:p.id,fingerprint:p.fingerprint};return status();
 }
 function release(a){if(!exact(a,['operationId','instanceId','confirm'])||a.confirm!==true)fail('CONFIRMATION_REQUIRED');ready();
  if(a.instanceId!==instanceId)fail('INSTANCE_CHANGED');if(!lease){if(last?.id===a.operationId)return {...status(),notResent:true};fail('NOT_HELD');}
  if(a.operationId!==lease.id)fail('OPERATION_CHANGED');last={id:lease.id,state:'released',at:now()};lease=null;plan=null;return status();
 }
 // Only Gateway.close invokes this internal seam, after its original promises
 // settle. Capture counters before DB closure, publish proof only after storage
 // closes successfully. A closed flag or missing service is not this proof.
 function completeClosure(closeStorage,settledClean){
  if(closureAttempted)fail('CLOSURE_ALREADY_RECORDED');closureAttempted=true;let c,verified=false;
  try{c=counts();verified=settledClean===true&&g.closed===true&&g.server?.listening!==true&&Object.values(c).every(n=>Number.isSafeInteger(n)&&n===0);}catch{}
  const result=closeStorage();if(result&&typeof result.then==='function')fail('CLOSURE_ASYNC_STORAGE');
  if(verified)closure={counts:c,closedAt:now(),operationId:lease?.id??null};
 }
 function closureStatus(a={}){
  if(!exact(a,[]))fail('ARGUMENTS');
  return {contract:1,scope:'own_gateway_only',instanceId,gatewayInstanceId:g.instanceId,
   state:closure?'closed':g.closed||closureAttempted?'unverified':'not_closed',operationId:closure?.operationId??lease?.id??null,
   counts:closure?{...closure.counts}:null,closedAt:closure?.closedAt??null,hostStopAuthorized:false,pluginSwitchAuthorized:false};
 }
 return {run,enter,assertOpen,status,preview,apply,release,completeClosure,closureStatus,get blocked(){return !!lease||!!g.closed;}};
}
