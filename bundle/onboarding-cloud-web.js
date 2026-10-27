// Own setup Web carrier: no gateway, fixed verified target, no launch token in UI.
import {randomUUID} from 'node:crypto';
import {WorkbenchProxy} from './workbench-proxy.js';
import {handoffTarget} from './onboarding-handoff.js';
import {digest} from './onboarding-ssh.js';
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===keys.sort().join();
const fail=x=>{throw Error('ONBOARDING_CLOUD_WEB_'+x);};
export function validateCloudWebAccess(result){
 if(!exact(result,['target','value']))fail('RESPONSE_REVIEW');
 const target=handoffTarget(result.target),v=result.value;
 if(!exact(v,['port','token','nativeNonce'])||!Number.isInteger(v.port)||v.port<1||v.port>65535||typeof v.token!=='string'||v.token.length<1||v.token.length>2048||!/^[\x21-\x7e]+$/.test(v.token)||typeof v.nativeNonce!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v.nativeNonce))fail('RESPONSE_REVIEW');
 return {target:structuredClone(target),value:{...v}};
}
export function createOnboardingCloudWeb({remote,enabled,now=Date.now,admit,createProxy=options=>new WorkbenchProxy(options)}){
 let active=null,last=null,pending=null,disposed=false;
 const available=()=>!disposed&&enabled();
 const entryArgs=args=>{if(!exact(args,['entryId'])||typeof args.entryId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(args.entryId))fail('ARGUMENTS');};
 async function releaseCarrier(c,cause='requested'){
  if(c.released)return;if(c.closing)return c.closing;
  c.closeCause??=cause;
  c.off?.();c.off=null;
  c.closing=(async()=>{
   // Both resources must be attempted even if one close fails. Keep the exact
   // handle on failure so an explicit close can finish cleanup, not open anew.
   const results=await Promise.allSettled([Promise.resolve().then(()=>c.proxy?.close()),Promise.resolve().then(()=>c.tunnel?.close())]);
   if(results.some(r=>r.status==='rejected')){c.closeError=true;fail('CLOSE_REVIEW');}
   c.closeError=false;c.released=true;c.closedAt=now();last=c;if(active===c)active=null;
  })();try{await c.closing;}finally{c.closing=null;}
 }
 async function release(cause){if(active)await releaseCarrier(active,cause);}
 async function openEntry(args,managed=null){
  if(!exact(args,[]))fail('ARGUMENTS');if(!available())fail('DISABLED');if(pending)fail('BUSY');
  const work=(async()=>{
   await release('replaced');const carrier={entryId:randomUUID(),proxy:null,tunnel:null,off:null,closing:null,released:false};
   try{
    const received=await remote('web_access',{},managed?.target);carrier.tunnel=received?.tunnel;
    const {target,value}=validateCloudWebAccess({target:received?.target,value:received?.value});
    if(managed){
     if(digest(target)!==digest(managed.target))fail('TARGET_CHANGED');
     // Bootstrap came through the authenticated task pair after cloud-side
     // session ownership validation. The native token/port must be the SAME
     // Host observed by the installer, not an arbitrary URL or another install.
     const {result,observation}=managed.proof;let u;
     try{u=new URL(result.url);}catch{fail('BOOTSTRAP_REVIEW');}
     if(result.instance_id!==observation.instance_id||!result.instance_id||result.session_id!==(managed.args.session_id??null)||u.origin!==`http://127.0.0.1:${value.port}`||u.pathname!=='/'||u.hash||[...u.searchParams.keys()].join()!=='token'||u.searchParams.get('token')!==value.token)fail('BOOTSTRAP_REVIEW');
    }
    const tunnel=carrier.tunnel;
    if(!tunnel||typeof tunnel.alive!=='function'||typeof tunnel.close!=='function'||typeof tunnel.onClose!=='function'||!Number.isInteger(tunnel.port)||tunnel.port<1||tunnel.port>65535)fail('TRANSPORT_REVIEW');
    if(disposed||!tunnel.alive())fail('CLOSED');
    const proxy=carrier.proxy=createProxy({port:0,upstreamPort:tunnel.port,now,admit,browserHost:managed?.browserHost??'127.0.0.1'});await proxy.start();
    if(disposed||!tunnel.alive())fail('CLOSED');
    const url=managed?proxy.issue(value.token,managed.args.session_id):proxy.issue(value.token)+'#dsh-setup-im';active=carrier;
    carrier.off=tunnel.onClose(()=>{void releaseCarrier(carrier,'forward_exit').catch(()=>{});});
    if(!tunnel.alive()||disposed)fail('CLOSED');
    return {contract:1,state:'entry_created',entryId:carrier.entryId,target,url,issuedAt:now(),ticketTtlMs:15000,scope:'managed_cloud_native_web',botChangesAuthorized:false,nativePermissionsRetained:true,initializationComplete:false};
   }catch(e){
    if(carrier.proxy||carrier.tunnel){active=carrier;await releaseCarrier(carrier,'open_failed');}
    throw e;
   }
  })();pending=work;try{return await work;}finally{if(pending===work)pending=null;}
 }
 async function close(args){
  entryArgs(args);
  if(pending)fail('BUSY');
  if(!active||active.entryId!==args.entryId)return {state:'already_closed',remoteHostStopped:false,botChanges:false};
  await release();return {state:'closed',remoteHostStopped:false,botChanges:false};
 }
 function status(args){
  entryArgs(args);
  const c=active?.entryId===args.entryId?active:last?.entryId===args.entryId?last:null;
  // Observe only this controller's owned handle; no SSH, HTTP probe or reconnect.
  const state=!c?'not_found':c.closing?'closing':c.closeError?'cleanup_required':c.released?'closed':c.tunnel.alive()?'open':'closing';
  const d=c?.tunnel.diagnostic?.();
  const transport=d?{reason:['CLOSE_REQUESTED','PROCESS_EXIT','FORWARD_FAILED','FORWARD_RESPONSE','RESPONSE_LIMIT','TIMEOUT'].includes(d.reason)?d.reason:null,exitCode:Number.isInteger(d.exitCode)&&d.exitCode>=0&&d.exitCode<=255?d.exitCode:null,signal:['SIGTERM','SIGKILL','SIGHUP','SIGINT','SIGPIPE'].includes(d.signal)?d.signal:null,stderrCategory:['HOSTKEY_REJECTED','AUTH_REJECTED','KEEPALIVE_TIMEOUT','CONNECT_TIMEOUT','FORWARD_BIND_FAILED','CONNECTION_REFUSED','NETWORK_RESET','REMOTE_CLOSED','UNCLASSIFIED'].includes(d.stderrCategory)?d.stderrCategory:null}:null;
  return {contract:1,entryId:args.entryId,state,observedAt:now(),closedAt:c?.closedAt??null,closeCause:c?.closeCause??null,transport,scope:'local_owned_carrier_only',remoteHostVerified:false,botConnectionVerified:false,automaticRetry:false};
 }
 async function dispose(){disposed=true;if(pending)await pending.catch(()=>{});await release('dispose');}
 async function openWorkbench(managed){
  if(!(exact(managed,['target','args','proof'])||exact(managed,['target','args','proof','browserHost']))||managed.browserHost!==undefined&&!['127.0.0.1','localhost'].includes(managed.browserHost)||!managed.proof?.result||!managed.proof?.observation||!managed.args||Object.keys(managed.args).some(k=>!['session_id','a2a'].includes(k)))fail('ARGUMENTS');
  handoffTarget(managed.target);
  const r=await openEntry({},managed);
  return {role:'local',url:r.url,entryId:r.entryId,expires_in_seconds:15,instance_id:managed.proof.result.instance_id,authenticated:false,receipt:'browser_open_requested_not_logged_in'};
 }
 return {available,open:args=>openEntry(args),openWorkbench,close,status,dispose};
}
