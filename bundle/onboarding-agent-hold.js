// Process-local native agent lease. NOT a Host shutdown or plugin-switch authorization.
import {randomUUID,createHash} from 'node:crypto';
const fail=c=>{throw Error('ONBOARDING_AGENT_HOLD_'+c);};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===keys.slice().sort().join();
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function createOnboardingAgentHold(ctx,{now=Date.now}={}){
 const instanceId=randomUUID();let plan=null,lease=null,last=null,closed=false;
 const ready=()=>{if(closed||typeof ctx.agents?.list!=='function'||typeof ctx.on!=='function')fail('UNAVAILABLE');};
 const list=()=>{const a=ctx.agents.list();if(!Array.isArray(a)||a.length>10000||new Set(a).size!==a.length)fail('REGISTRY_REVIEW');return a;};
 function observation(){
  const agents=list();let running=0,unsupported=0,held=0,pendingNextTurn=0,pendingNextStep=0,inboxUnknown=0;
  for(const a of agents){
   if(!['idle','running'].includes(a.status)||typeof a.runMaintenance!=='function')unsupported++;if(a.status==='running')running++;if(lease?.members.get(a)?.held)held++;
   // The public inbox is observed by length only. Holding execution does not
   // stop input from arriving or prove that pending work survived a restart.
   try{const inbox=a.inbox,nextTurn=inbox?.nextTurn,nextStep=inbox?.nextStep;if(!Array.isArray(nextTurn)||!Array.isArray(nextStep))inboxUnknown++;else{pendingNextTurn+=nextTurn.length;pendingNextStep+=nextStep.length;}}
   catch{inboxUnknown++;}
  }
  return {agents:agents.length,running,unsupported,held,pendingNextTurn,pendingNextStep,inboxUnknown};
 }
 function status(a={}){
  if(!exact(a,[]))fail('ARGUMENTS');ready();const counts=observation();
  return {contract:1,instanceId,scope:'native_agents_only',state:lease?(lease.broken||counts.running||counts.unsupported||counts.held!==counts.agents?'needs_review':'held'):'open',operationId:lease?.id??null,counts,inboxState:counts.inboxUnknown?'unknown':counts.pendingNextTurn||counts.pendingNextStep?'pending':'empty',last: last?{...last}:null,hostStopAuthorized:false,pluginSwitchAuthorized:false,persisted:false,observedAt:now()};
 }
 function releaseMembers(l){
  for(const off of l.listeners.splice(0))if(typeof off==='function')off();
  for(const row of l.members.values())row.release?.();
  l.members.clear();
 }
 function hold(l,agent){
  if(l.members.has(agent))return;
  if(agent.status!=='idle'||typeof agent.runMaintenance!=='function')fail('BUSY');
  const row={held:false,release:null,abandoned:false};l.members.set(agent,row);let began=false;
  try{
   // The public contract claims the idle phase synchronously. Pending input is
   // retained by the official inbox, not copied, canceled, or re-submitted here.
   const settled=agent.runMaintenance(signal=>{
    began=true;if(row.abandoned||lease!==l)return Promise.resolve();row.held=true;
    return new Promise(resolve=>{
     let finished=false;
     const finish=aborted=>{if(finished)return;finished=true;row.held=false;if(aborted)l.broken=true;signal.removeEventListener('abort',abort);resolve();};
     const abort=()=>finish(true);row.release=()=>finish(false);
     signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    });
   });
   if(!settled||typeof settled.then!=='function')fail('CONTRACT_REVIEW');
   Promise.resolve(settled).catch(()=>{row.held=false;l.broken=true;});
   if(!began)fail('CONTRACT_REVIEW');
   if(!row.held)fail('INTERRUPTED');
  }catch(e){row.abandoned=true;row.release?.();l.members.delete(agent);throw e;}
 }
 function preview(a){
  if(!exact(a,[]))fail('ARGUMENTS');ready();plan=null;if(lease)fail('ALREADY_HELD');const s=observation();
  const p={id:randomUUID(),instanceId,createdAt:now(),expiresAt:now()+300000,scope:'native_agents_only',counts:s,canApply:s.running===0&&s.unsupported===0,hostStopAuthorized:false,pluginSwitchAuthorized:false};
  plan={...p,fingerprint:digest(p)};return structuredClone(plan);
 }
 function apply(a){
  if(!exact(a,['id','fingerprint','confirm'])||a.confirm!==true)fail('CONFIRMATION_REQUIRED');ready();
  if(lease?.id===a.id&&lease.fingerprint===a.fingerprint)return {...status(),notResent:true};
  if(last?.id===a.id)fail('RELEASED');
  const p=plan;if(!p||p.id!==a.id||p.fingerprint!==a.fingerprint||p.instanceId!==instanceId||p.expiresAt<=now())fail('PLAN_EXPIRED');plan=null;
  if(lease)fail('ALREADY_HELD');const s=observation();if(!p.canApply||s.running||s.unsupported)fail('BUSY');
  const l={id:p.id,fingerprint:p.fingerprint,members:new Map(),listeners:[],broken:false};lease=l;
  try{
   // Registration precedes acquisition. JS execution is synchronous until all
   // existing idle agents are held; newly created loops await this listener.
   l.listeners.push(ctx.on('agent/created',({agent,signal})=>{
    if(lease!==l)return;
    // Creation already owns the official maintenance phase. Keep its awaited
    // announcement pending; a nested runMaintenance would reject creation.
    const row={held:true,release:null};l.members.set(agent,row);
    return new Promise((resolve,reject)=>{
     let ended=false;
     const finish=aborted=>{if(ended)return;ended=true;row.held=false;signal?.removeEventListener('abort',abort);if(aborted){l.broken=true;reject(Error('ONBOARDING_AGENT_HOLD_CREATION_INTERRUPTED'));}else resolve();};
     const abort=()=>finish(true);row.release=()=>finish(false);
     signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    });
   }));
   l.listeners.push(ctx.on('agent/disposed',({agent})=>{const row=l.members.get(agent);row?.release?.();l.members.delete(agent);}));
   if(l.listeners.some(x=>typeof x!=='function'))fail('CONTRACT_REVIEW');
   for(const agent of list())hold(l,agent);
   const result=status();if(result.state!=='held')fail('INTERRUPTED');return result;
  }catch(e){releaseMembers(l);lease=null;throw e;}
 }
 function release(a){
  if(!exact(a,['operationId','instanceId','confirm'])||a.confirm!==true)fail('CONFIRMATION_REQUIRED');ready();
  if(a.instanceId!==instanceId)fail('INSTANCE_CHANGED');
  if(!lease){if(last?.id===a.operationId)return {...status(),notResent:true};fail('NOT_HELD');}
  if(lease.id!==a.operationId)fail('OPERATION_CHANGED');
  const l=lease;last={id:l.id,state:'released',at:now()};lease=null;plan=null;releaseMembers(l);return status();
 }
 function dispose(){if(closed)return;closed=true;plan=null;const l=lease;lease=null;if(l)releaseMembers(l);}
 return {status,preview,apply,release,dispose};
}
