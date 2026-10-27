import {observeRuntimeHost} from './onboarding-host-stop-observation.js';
// Fixed archived stop controller. Native Host shutdown needs an independent
// risk-confirmed schema-2 plan; an idle snapshot is never a lossless drain.
export function createRuntimeStop(api){
 const {fs,path,randomUUID,runtimeDir,regular,verified,signed,exact,uuid,hash,fail,runtimeAlive,runtimeRecord,runtimeView,atomicJSON}=api;
// Stop authorization is separate from the worker journal, which the installer
// may update concurrently. Legacy installer plans never authorize a Host signal.
const observeHost=(q,j)=>observeRuntimeHost(api,q,j);
const hostScope='owned_host_with_loss_risk';
const risk={contract:1,lateNativeInputMayAbort:true,imInFlightMayAbort:true,ownQueuesRetained:true,ingressFrozen:false,automaticStop:false,requiresExplicitAcknowledgement:true};
const stopPath=q=>path.join(runtimeDir(q),'stop.json');
async function runtimeStopLedger(q,j,terminalOnly=false){
 const r=await regular(stopPath(q),262144);if(!r)return {schema:1,operationId:q.operationId,runtimeId:j.id,records:[]};
 if(r.identity.mode!==0o600||r.identity.uid!==process.getuid())fail('RUNTIME_STOP_LEDGER_REVIEW');
 const d=verified(JSON.parse(r.data),q.proof);
 if(!exact(d,['schema','operationId','runtimeId','records'])||d.schema!==1||d.operationId!==q.operationId||d.runtimeId!==j.id||!Array.isArray(d.records)||d.records.length>32)fail('RUNTIME_STOP_LEDGER_REVIEW');
 const ids=new Set();for(const row of d.records){
  if(!exact(row,['plan','phase','updatedAt','error'])||!['requested','signalled','needs_review','ended'].includes(row.phase)||!Number.isSafeInteger(row.updatedAt)||row.error!==null&&!/^ONBOARDING_CLOUD_[A-Z_]+$/.test(row.error))fail('RUNTIME_STOP_LEDGER_REVIEW');
  const p=runtimeStopPlan(q,j,row.plan);if(ids.has(p.id))fail('RUNTIME_STOP_LEDGER_REVIEW');ids.add(p.id);
  if(terminalOnly&&row.phase!=='ended')fail('RUNTIME_STOP_RECONCILE_REQUIRED');
 }
 return d;
}
function runtimeStopPlan(q,j,value){
 const p=verified(value,q.proof);
 const host=p.schema===2;
 if(!exact(p,['schema','id','operationId','runtimeId','revision','scope','createdAt','expiresAt','members','host','canApply','reason',...(host?['risk','observation']:[])])||![1,2].includes(p.schema)||!uuid(p.id)||p.operationId!==q.operationId||p.runtimeId!==j.id||!Number.isSafeInteger(p.revision)||p.revision<1||p.scope!==(host?hostScope:'installer_processes_only')||!Number.isSafeInteger(p.createdAt)||p.expiresAt!==p.createdAt+300000||!exact(p.members,['worker','child','launcher'])||typeof p.canApply!=='boolean'||!['ready','no_active_installer','host_drain_required','prior_stop_unresolved','host_busy','host_observation_required','installer_active'].includes(p.reason))fail('RUNTIME_STOP_PLAN_REVIEW');
 for(const m of [...Object.values(p.members),p.host])if(m!==null&&(!exact(m,['platform','pid','boot','start'])||m.platform!=='linux'||!Number.isSafeInteger(m.pid)||m.pid<2||typeof m.boot!=='string'||typeof m.start!=='string'))fail('RUNTIME_STOP_PLAN_REVIEW');
 if(host&&(p.host===null||hash(p.risk)!==hash(risk)||p.observation!==null&&(!exact(p.observation,['contract','nativeNonce','instances','idle','reasons','observedAt','ingressFrozen','imInFlightVerified'])||p.observation.contract!==1||!uuid(p.observation.nativeNonce)||!exact(p.observation.instances,['onboarding','agents','gateway','im'])||Object.values(p.observation.instances).some(x=>x!==null&&!uuid(x))||typeof p.observation.idle!=='boolean'||!Array.isArray(p.observation.reasons)||p.observation.reasons.some(x=>!['component_unavailable','own_work_active','native_work_active_or_unknown','im_maintenance_pending'].includes(x))||!Number.isSafeInteger(p.observation.observedAt)||p.observation.ingressFrozen!==false||p.observation.imInFlightVerified!==false)))fail('RUNTIME_STOP_PLAN_REVIEW');
 return p;
}
async function runtimeStopSnapshot(j){
 const members={worker:null,child:null,launcher:null};for(const [key,m] of [['worker',j.worker],['child',j.child],['launcher',j.restart?.launcher]])if(await runtimeAlive(m))members[key]=m;
 return {members,host:await runtimeAlive(j.host)?j.host:null};
}
async function runtimeStopView(q,j){
 const d=await runtimeStopLedger(q,j),row=d.records.at(-1);if(!row)return null;
 const p=runtimeStopPlan(q,j,row.plan);let active=0;for(const m of Object.values(p.members))if(await runtimeAlive(m))active++;
 return {id:p.id,phase:row.phase,scope:p.scope,activeInstallerMembers:active,reconcileRequired:row.phase!=='ended',stopPlan:row.plan,error:row.error,hostActive:p.schema===2&&await runtimeAlive(p.host),hostStopAuthorized:p.schema===2,nativeInputMayAbort:p.schema===2,automaticRetry:false};
}
async function runtimeStopPreview(q,j){
 if(process.platform!=='linux')fail('RUNTIME_PLATFORM_UNSUPPORTED');
 const d=await runtimeStopLedger(q,j),s=await runtimeStopSnapshot(j),now=Date.now();
 let observation=null;if(s.host&&typeof observeHost==='function')try{observation=await observeHost(q,j);}catch{}
 const active=Object.values(s.members).some(Boolean),reason=d.records.some(x=>x.phase!=='ended')?'prior_stop_unresolved':s.host?(active?'installer_active':!observation?'host_observation_required':!observation.idle?'host_busy':'ready'):active?'ready':'no_active_installer';
 const host=!!s.host,p={schema:host?2:1,id:randomUUID(),operationId:q.operationId,runtimeId:j.id,revision:j.revision,scope:host?hostScope:'installer_processes_only',createdAt:now,expiresAt:now+300000,...s,canApply:reason==='ready',reason,...(host?{risk,observation}:{})};
 return {operationId:q.operationId,runtimeId:j.id,initialization:false,hostStarted:host,scope:p.scope,canApply:p.canApply,reason,expiresAt:p.expiresAt,stopPlan:signed(p,q.proof),hostStopAuthorized:false,...(host?{risk,observation}:{})};
}
async function runtimeStop(q,j,io={}){
 if(process.platform!=='linux')fail('RUNTIME_PLATFORM_UNSUPPORTED');
 const p=runtimeStopPlan(q,j,q.stopPlan),d=await runtimeStopLedger(q,j),old=d.records.find(x=>x.plan.id===p.id);
 if(old){if(hash(old.plan)!==hash(q.stopPlan))fail('RUNTIME_STOP_PLAN_REVIEW');
  if(q.action==='runtime_stop_reconcile'){
   for(const m of [...Object.values(p.members),...(p.schema===2?[p.host]:[])])if(await runtimeAlive(m))fail('RUNTIME_STOP_STILL_ACTIVE');
   if(old.phase!=='ended'){old.phase='ended';old.updatedAt=Date.now();await atomicJSON(stopPath(q),signed(d,q.proof));}
  }
  return {...await runtimeView(q,j),stopRequested:true,notResent:true};
 }
 if(q.action==='runtime_stop_reconcile')fail('RUNTIME_STOP_NOT_REQUESTED');
 const host=p.schema===2;if(host&&q.acknowledgeNativeInterruption!==true)fail('RUNTIME_HOST_STOP_CONSENT_REQUIRED');
 if(!p.canApply||p.reason!=='ready')fail(p.reason==='host_drain_required'?'RUNTIME_HOST_DRAIN_REQUIRED':'RUNTIME_STOP_NOT_READY');
 if(p.expiresAt<=Date.now()||p.createdAt>Date.now()+1000)fail('RUNTIME_STOP_PLAN_EXPIRED');
 if(d.records.some(x=>x.phase!=='ended'))fail('RUNTIME_STOP_RECONCILE_REQUIRED');if(d.records.length>=32)fail('RUNTIME_STOP_HISTORY_LIMIT');
 const fresh=await runtimeRecord(q),s=await runtimeStopSnapshot(fresh);
 if(!host&&s.host)fail('RUNTIME_HOST_DRAIN_REQUIRED');if(fresh.revision!==p.revision||hash(s.members)!==hash(p.members)||host&&hash(s.host)!==hash(p.host))fail('RUNTIME_STOP_PLAN_DRIFT');
 const checkHost=async current=>{const o=await observeHost(q,current);if(!o.idle)fail('RUNTIME_HOST_BUSY');if(hash(o.instances)!==hash(p.observation?.instances)||o.nativeNonce!==p.observation?.nativeNonce)fail('RUNTIME_STOP_PLAN_DRIFT');};
 if(host)try{await checkHost(fresh);}catch{fail('RUNTIME_HOST_STOP_PREFLIGHT_REFUSED');}
 const row={plan:q.stopPlan,phase:'requested',updatedAt:Date.now(),error:null};d.records.push(row);await atomicJSON(stopPath(q),signed(d,q.proof));
 try{
  await io.afterStopIntent?.();
  const latest=await runtimeRecord(q);if(!host&&await runtimeAlive(latest.host))fail('RUNTIME_HOST_DRAIN_REQUIRED');
  if(latest.id!==j.id||latest.revision!==p.revision)fail('RUNTIME_STOP_PLAN_DRIFT');
  if(host){
   if(hash(latest.host)!==hash(p.host)||Object.values((await runtimeStopSnapshot(latest)).members).some(Boolean))fail('RUNTIME_STOP_PLAN_DRIFT');
   await checkHost(latest);if(!await runtimeAlive(p.host))fail('RUNTIME_STOP_PLAN_DRIFT');
   process.kill(p.host.pid,'SIGTERM');
  }else{
  // A native Host is detached into another process group. Only recorded installer
  // members are signalled; birth identities are checked immediately before use.
  if(await runtimeAlive(p.members.launcher))process.kill(p.members.launcher.pid,'SIGTERM');
  const member=await runtimeAlive(p.members.worker)?p.members.worker:await runtimeAlive(p.members.child)?p.members.child:null;
  if(member){const raw=await fs.readFile('/proc/'+member.pid+'/stat','utf8'),parts=raw.slice(raw.lastIndexOf(')')+2).split(' ');if(Number(parts[2])!==j.worker?.pid)fail('RUNTIME_PROCESS_REVIEW');process.kill(-j.worker.pid,'SIGTERM');}
  }
  row.phase='signalled';row.updatedAt=Date.now();await atomicJSON(stopPath(q),signed(d,q.proof));
 }catch(e){row.phase='needs_review';row.error=/^ONBOARDING_CLOUD_[A-Z_]+$/.test(e.message)?e.message:'ONBOARDING_CLOUD_RUNTIME_STOP_UNKNOWN';row.updatedAt=Date.now();await atomicJSON(stopPath(q),signed(d,q.proof));throw e;}
 return {...await runtimeView(q,await runtimeRecord(q)),stopRequested:true};
}

 return {ledger:runtimeStopLedger,view:runtimeStopView,preview:runtimeStopPreview,apply:runtimeStop};
}
