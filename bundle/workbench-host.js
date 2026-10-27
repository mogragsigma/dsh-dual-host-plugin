import {developmentConfiguration} from './task-board-development.js';
import {ownedA2ASession,a2aSession,a2aRecentRuns} from './task-board-a2a.js';
import {WorkbenchProxy} from './workbench-proxy.js';
import {SshConnector} from './ssh-connector.js';
import {readFile} from 'node:fs/promises';
const endpoint='task-workbench/control';
const object=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
import {officialDesktopCarrier,authenticatedOwnerOrigin as workbenchInteractionOrigin} from './native-owner-origin.js';
export {officialDesktopCarrier,workbenchInteractionOrigin};
export const workbenchBrowserHost=request=>/^localhost(?::[0-9]+)?$/i.test(request.headers.get('host')??'')?'localhost':'127.0.0.1';
let appearance;
export function workbenchAppearance(args={}){
 if(!object(args)||Object.keys(args).length)throw Error('INVALID_WORKBENCH_APPEARANCE');
 // Fixed, packaged illustration only. No caller-controlled paths or URL fetches.
 return appearance??=(readFile(new URL('./workbench-assets/whale-ui-states.png',import.meta.url))
  .then(bytes=>({mascot:'data:image/png;base64,'+bytes.toString('base64')}))
  .catch(e=>{appearance=null;throw e;}));
}
export function workbenchSnapshot(g){
 const db=g.scheduler?.jobs.db;
 const runs=db?db.prepare(`SELECT r.id,r.session_id,r.status,r.started,r.finished,r.error,j.id AS job_id,j.task_id,j.policy,j.checkpoint FROM runs r JOIN jobs j ON j.id=r.job_id ORDER BY r.started DESC LIMIT 50`).all().map(r=>{
  // Display must not lazily migrate a legacy catalog row.
  let title;try{title=g.board?.head(r.task_id)?.title??'历史任务';}catch{title='历史任务';}
  // A requested policy is not proof of dispatch. Native Web holds actual model
  // records; never relabel a scheduled model as an observed model here.
  return {...r,title,requested_model:JSON.parse(r.policy),policy:undefined,checkpoint:JSON.parse(r.checkpoint),actual_model:null,actual_model_source:'native-session',read_only_link:true};
 }):[];
 return {role:g.c.role,plugin_version:g.hello().plugin_version,instance_id:g.instanceId,observed_at:g.now(),freshness:'live_response',runs,a2a:a2aRecentRuns(g),development_enabled:!!g.development?.gate?.enabled,development:developmentConfiguration(g),grants_execution:false,publish_enabled:false,authority:'cloud'};
}
export class Workbench {
 constructor(ctx,g,c){this.ctx=ctx;this.g=g;this.c=c;this.closed=false;}
 async call(method,args){
  if(!object(args))throw Error('INVALID_ARGUMENTS');
  if(this.g.c.role==='local'){
   if(method!=='workbench_status')throw Error('METHOD_DENIED');
   return (await this.g.link.call(method,args)).result;
  }
  if(method==='workbench_status')return workbenchSnapshot(this.g);
  if(method!=='workbench_bootstrap'||Object.keys(args).some(k=>!['session_id','a2a'].includes(k)))throw Error('METHOD_DENIED');
  if(args.session_id!==undefined){
   if(typeof args.session_id!=='string'||!(this.g.scheduler?.jobs.db.prepare('SELECT 1 FROM runs WHERE session_id=?').get(args.session_id)||ownedA2ASession(this.g,args.session_id)))throw Error('WORKBENCH_SESSION_NOT_FOUND');
  }
  if(args.a2a!==undefined||args.session_id?.startsWith('a2a-'))await a2aSession(this.ctx,this.g,{...args.a2a,session_id:args.session_id});
  const server=this.ctx.get('webServer'),connection=this.ctx.get('connection');
  if(!server||!connection?.authenticatedUrl||server.host!=='127.0.0.1'||server.protocol!=='http:')throw Error('WORKBENCH_CLOUD_UNAVAILABLE');
  return {url:connection.authenticatedUrl(server.getOrigin()),instance_id:this.g.instanceId,session_id:args.session_id??null};
 }
 async ensureCarrier(){
  if(this.proxy)return;
  if(this.starting)return this.starting;
  this.starting=(async()=>{
   if(!this.g.c.ssh||!Number.isInteger(this.c.remotePort)||this.c.remotePort<1||this.c.remotePort>65535||!Number.isInteger(this.c.tunnelPort)||this.c.tunnelPort<1||this.c.tunnelPort>65535||!Number.isInteger(this.c.port)||this.c.port<1||this.c.port>65535||this.c.port===this.c.tunnelPort)throw Error('INVALID_WORKBENCH_CONFIG');
   const proxy=new WorkbenchProxy({port:this.c.port,upstreamPort:this.c.tunnelPort,admit:label=>this.g.maintenance.enter(label)});
   try{await proxy.start();if(this.closed)throw Error('WORKBENCH_CLOSED');
    this.proxy=proxy;this.connector=new SshConnector({...this.g.c.ssh,forward:`127.0.0.1:${this.c.tunnelPort}:127.0.0.1:${this.c.remotePort}`},()=>{});this.connector.start();
   }catch(e){await proxy.close();throw e;}
  })().finally(()=>{this.starting=null;});return this.starting;
 }
 async open(args,browserHost='127.0.0.1'){
  if(!['127.0.0.1','localhost'].includes(browserHost))throw Error('INVALID_WORKBENCH_HOST');
  if(this.closed)throw Error('WORKBENCH_CLOSED');
  if(!object(args)||Object.keys(args).some(k=>!['session_id','a2a'].includes(k)))throw Error('INVALID_ARGUMENTS');
  if(this.g.c.role==='cloud')return {role:'cloud',session_id:args.session_id??null};
  // Managed onboarding owns the verified SSH carrier. Do not require legacy
  // hand-written ports or fall back to another cloud endpoint.
  if(typeof this.c.managedOpen==='function'){
   const proof=await this.g.link.call('workbench_bootstrap',args);
   if(proof.result?.instance_id!==proof.observation?.instance_id||!proof.result?.instance_id||proof.result.session_id!==(args.session_id??null))throw Error('INVALID_WORKBENCH_BOOTSTRAP');
   return this.c.managedOpen(args,proof,browserHost);
  }
  await this.ensureCarrier();
  const {result,observation}=await this.g.link.call('workbench_bootstrap',args),u=new URL(result.url);
  if(u.origin!==`http://127.0.0.1:${this.c.remotePort}`||u.pathname!=='/'||u.hash||[...u.searchParams.keys()].join()!=='token'||result.instance_id!==observation.instance_id)throw Error('INVALID_WORKBENCH_BOOTSTRAP');
  // Bound retry only checks public static entry reachability; no authenticated
  // operation is replayed. Tunnel process existence never counts as a login.
  let ready=false;
  for(let n=0;n<20&&!this.closed;n++){
   try{const r=await fetch(`http://127.0.0.1:${this.c.tunnelPort}/`,{redirect:'error',signal:AbortSignal.timeout(500)});await r.body?.cancel();if(r.status===401){ready=true;break;}}catch{}
   await new Promise(r=>setTimeout(r,150));
  }
  if(!ready)throw Error('WORKBENCH_TUNNEL_UNAVAILABLE');
  return {role:'local',url:this.proxy.issue(u.searchParams.get('token'),args.session_id),expires_in_seconds:15,instance_id:result.instance_id,authenticated:false,receipt:'browser_open_requested_not_logged_in'};
 }
 async close(){this.closed=true;await this.starting?.catch(()=>{});await Promise.allSettled([this.connector?.close(),this.proxy?.close()]);}
}
export function installWorkbench(ctx,g,config){
 if(config?.enabled!==true)return;
 ctx.inject(['connection'],sub=>{
  const wb=new Workbench(sub,g,config);g.workbench=wb;
  sub.effect(()=>()=>{if(g.workbench===wb)delete g.workbench;return wb.close();});
  sub.connection.fetch.register({path:'/api/'+endpoint,methods:['POST'],requestBody:'buffered',async fetch(request){
   const respond=(id,result)=>Response.json({type:'server-response',rpcId:id,result},{headers:{'Cache-Control':'no-store'}});
   let b;try{b=await request.json();}catch{return new Response('bad request',{status:400});}
   if(!object(b)||b.type!=='client-request'||typeof b.rpcId!=='string'||b.rpcId.length>128||b.method!==endpoint||!object(b.payload))return new Response('bad request',{status:400});
   let leave;try{
    leave=g.maintenance?.enter('workbench_ui');
    let value;if(b.payload.method==='appearance')value=await workbenchAppearance(b.payload.args??{});
    else if(b.payload.method?.startsWith('approval-interaction-')||b.payload.method?.startsWith('intervention-action-')){
     if(!workbenchInteractionOrigin(request,{desktop:officialDesktopCarrier(),serverOrigin:sub.get?.('webServer')?.getOrigin?.()}))throw Error('APPROVAL_BROWSER_ORIGIN_REQUIRED');
     const intervention=b.payload.method.startsWith('intervention-action-');
     value=await g.call((intervention?'intervention_action_':'approval_interaction_')+b.payload.method.slice(intervention?'intervention-action-'.length:'approval-interaction-'.length),b.payload.args??{});
    }
    else if(['approval-describe','approval-prepare','approval-begin','approval-finish','approval-status'].includes(b.payload.method))value=await g.call('approval_workbench_'+b.payload.method.slice(9),b.payload.args??{});
    else if(b.payload.method==='a2a-session')value=await a2aSession(sub,g,b.payload.args);
    else if(b.payload.method==='status')value={...await wb.call('workbench_status',{}),viewer_role:g.c.role};
    else if(b.payload.method==='open'){
     // Preserve the authenticated local Web hostname. Do not rewrite Origin or
     // Fetch Metadata; native DSH must still reject cross-site API requests.
     // Official DSH wraps Request.url with dsh.internal; the verified Host
     // header retains the browser authority, not that internal routing origin.
     const browserHost=workbenchBrowserHost(request);
     value=await wb.open(b.payload.args??{},browserHost);
    }
    else if(b.payload.method==='session'&&g.c.role==='cloud'){
     const id=b.payload.args?.session_id;if(typeof id!=='string'||!(g.scheduler?.jobs.db.prepare('SELECT 1 FROM runs WHERE session_id=?').get(id)||ownedA2ASession(g,id)))throw Error('WORKBENCH_SESSION_NOT_FOUND');
     value={session_id:id};
    }else throw Error('METHOD_DENIED');
    return respond(b.rpcId,{ok:true,value});
   }catch(e){return respond(b.rpcId,{ok:false,error:{code:/^(CHAT_|APPROVAL_|PASSKEY_|APPROVER_|WORKBENCH_|INVALID_WORKBENCH_|CAPABILITY_|PROTOCOL_|COORDINATOR_|METHOD_)[A-Z_]+$/.test(e.message)?e.message:'WORKBENCH_UNAVAILABLE',message:'工作台暂不可用；原生聊天未被接管。',details:{}}});}finally{leave?.();}
  }});
 });
}
