import {TaskInterventions} from './task-interventions.js';
import {deliverySnapshot} from './delivery-preview.js';
import {deliveryActions,deliveryDisplayState} from './delivery-state.js';
import {developmentConfiguration,developmentSnapshot,developmentDisplayState,developmentPeerSnapshot} from './task-board-development.js';
import {a2aSnapshot,a2aDisplayState} from './task-board-a2a.js';
import {jobLineage,planningGate,planningSnapshot,taskDisplayState} from './task-board-planning.js';
import {parseEnvelope} from './task-envelope.js';
import {errorInfo} from './link-contract.js';
import {queueDiagnostics} from './diagnostics.js';
const object=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
const envelope=x=>{try{return parseEnvelope(x);}catch{return null;}};
const parse=x=>{try{return JSON.parse(x);}catch{return null;}};
const text=(x,n=4000)=>typeof x==='string'?x.slice(0,n):null;
const policy=p=>object(p)?{provider:text(p.provider,128),model:text(p.model,128),reasoningEffort:text(p.reasoningEffort,128)}:null;
const has=(db,t)=>!!db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const jobCodes=new Set(['HOST_RESTARTED','VERSION_MISMATCH','RUN_BUDGET_EXHAUSTED','DEVELOPMENT_ADAPTER_NOT_ENABLED','STALE_JOB_CLAIM','WORKER_MODEL_ROUTE_MISMATCH','WORKER_REQUEST_BUDGET','WORKER_TOKEN_BUDGET','WORKER_MODEL_OUTPUT_LIMIT','WORKER_REPORT_REQUIRED','WORKER_CANCELLED','WORKER_FAILED']);
const code=x=>!x?null:jobCodes.has(x)||/^WORKER_MODEL_(INVALID_REQUEST|UNKNOWN_MODEL|NO_ADAPTER|MISSING_CREDENTIAL|INVALID_CREDENTIAL|UNSUPPORTED_REASONING_EFFORT|QUOTA|RATE_LIMIT|ABORTED|FAILED)$/.test(x)?x:errorInfo(x).code;
export function boardHost(g){
 const hello=g.hello(),link=g.link?.snapshot()??g.inboundSnapshot();
 return {role:g.c.role,plugin_version:hello.plugin_version,instance_id:hello.instance_id,observed_at:g.now(),connection:{state:link.state,age_ms:link.age_ms,peer_version:link.peer?.plugin_version??null,peer_role:link.peer?.role??null,capabilities:link.negotiated?.capabilities??{},error:link.last_error?.code??null,remote_idle:'unknown'},queues:queueDiagnostics(g),scheduler_enabled:!!g.scheduler,active_runs:g.scheduler?.active.size??0,a2a:g.a2aEndpoint?.snapshot()??{enabled:false,active_runs:0,undrained:false,queues:[]}};
}
export function queueReason(j,g,task){
 if(g.scheduler?.active.has(j.id)&&j.status!=='running')return 'draining';
 if(j.status==='running')return 'running';
 if(['completed','cancelled','paused','needs_review','waiting_approval','waiting_capability','waiting_input'].includes(j.status))return j.status;
 if(task.blocked)return 'task_blocked';
 if(task.busy)return 'task_busy';
 if(j.kind==='development'){
  if(!g.development)return 'development_disabled';
  if(!['0.21.0','0.22.0'].includes(j.version))return 'development_version_review';
  try{const request=g.development.requestFor(j),waiting=g.development.gate.waiting(request.id);if(waiting)return waiting;}catch{return 'development_review';}
 }
 const gate=planningGate(g,j);if(gate)return gate;
 if(j.due>g.now())return 'scheduled_time';
 if([...g.scheduler?.active.values()??[]].some(r=>r.task_id&&r.task_id===j.task_id))return 'same_task_busy';
 if(g.scheduler?.active.size>=(g.scheduler?.maxConcurrent??1))return 'worker_busy';
 return 'awaiting_scheduler';
}
export class TaskBoard {
 constructor(ctx,g){this.ctx=ctx;this.g=g;this.cache=new Map();this.reads=0;this.interventions=g.c.role==='cloud'&&g.store?.db?new TaskInterventions(g.store,g.now):null;}
 head(id){
  // Catalog.head/find lazily migrate legacy rows. A display must not do that.
  const db=this.g.store.db,t=this.g.store.task(id),c=db.prepare('SELECT * FROM task_catalog WHERE task_id=?').get(id);
  const r=c?db.prepare('SELECT goal,created FROM task_revisions WHERE task_id=? AND revision=?').get(id,c.spec_revision):null;
  const first=db.prepare('SELECT goal,source,node FROM ingress WHERE task_id=? ORDER BY rowid LIMIT 1').get(id);
  const e=envelope(r?.goal??first?.goal??'');
  return {task_id:id,title:text(c?.title??e?.title??first?.goal??'未命名历史任务',120),spec_revision:c?.spec_revision??null,legacy:!c||!!c.legacy,intent:e?.intent??'legacy',requested_model:policy(e?.model_policy),created:r?.created??null,origin:first?.node??null,coordination:{busy:!!t.busy,blocked:!!t.blocked,owner:t.owner,write_queue:db.prepare("SELECT node,status,COUNT(*) count FROM intents WHERE task_id=? AND status NOT IN ('applied','cancelled') GROUP BY node,status").all(id)},envelope:e};
 }
 jobs(id){
  const g=this.g,task=g.store.task(id),db=g.scheduler?.jobs.db;
  return db?db.prepare("SELECT * FROM jobs WHERE task_id=? ORDER BY CASE WHEN status='running' THEN 0 WHEN status NOT IN ('completed','cancelled') THEN 1 ELSE 2 END,created DESC,id DESC LIMIT 50").all(id).map(j=>({id:j.id,spec_revision:envelope(j.goal)?.task_context?.spec_revision??(envelope(j.goal)?1:null),lineage:jobLineage(g,j),status:j.status,kind:j.kind,created:j.created,due:j.due,reason:queueReason(j,g,task),error:code(j.error),requested_model:policy(parse(j.policy)),checkpoint:text(parse(j.checkpoint)?.summary),input_question:text(parse(j.checkpoint)?.question,2000),attempts:j.attempts,max_runs:j.max_runs})):[];
 }
 repository(id){
  const r=this.g.repositories.status(id),p=r.repository;
  return {state:r.state,revision:r.binding_revision,url:p?.url??null,branch:p?.branch??null,base_sha:p?.base_sha??null,verified_at:r.verified_at,verification_fresh:r.verification_fresh,error:code(r.last_error),workspace:has(this.g.store.db,'development_requests')&&this.g.store.db.prepare('SELECT 1 FROM development_requests WHERE task_id=?').get(id)?'managed_binding_recorded':'not_checked_out',write_enabled:false,write_permission_source:'separate_development_gate'};
 }
 approvals(id,limit=5){
  const g=this.g,db=g.store.db;
  if(!db.prepare('SELECT 1 FROM task_catalog WHERE task_id=?').get(id))return [];
  return db.prepare('SELECT id,decision_id FROM approval_requests WHERE task_id=? ORDER BY created DESC,id DESC LIMIT ?').all(id,limit).map(row=>{
   const a=g.approvals.view(row.id),d=db.prepare('SELECT state FROM approval_chat_deliveries WHERE request_id=?').get(a.id),r=row.decision_id?db.prepare('SELECT state,snapshot_state,snapshot_at,created FROM approval_receipts WHERE decision_id=?').get(row.decision_id):null;
   return {id:a.id,state:a.state,recorded_state:a.recorded_state,spec_revision:a.spec_revision,created:a.created,expires:a.expires,summary:text(a.proposal.summary,1000),feedback:a.feedback?{intent:a.feedback.intent,user_text:text(a.feedback.user_text,2000),reason:text(a.feedback.reason,500),requires_new_proposal:a.feedback.requires_new_proposal}:null,scopes:a.proposal.scopes,delivery:a.proposal.delivery??null,requested_model:policy(a.proposal.model_policy),repository_revision:a.repository_revision,decision:a.decision?{action:a.decision.action,created:a.decision.created}:null,proposal_delivery:d?.state??'not_queued',receipt:r?{state:r.state,snapshot_state:r.snapshot_state,snapshot_at:r.snapshot_at}:null,execution_enabled:false,execution_boundary:(a.proposal.development&&g.development?.gate?.enabled)||(a.proposal.delivery?.kind==='commit-execution-v1'&&g.deliveryRuntime?.executionEnabled)||(a.proposal.delivery?.kind==='push-execution-v1'&&g.deliveryRuntime?.pushExecutionEnabled)?'requires_runtime_gate':'disabled'};
  });
 }
 summary(id){
  const {envelope,...h}=this.head(id),jobs=this.jobs(id),planning=planningSnapshot(this.g,id,id=>this.head(id).title);
  const a2a=a2aSnapshot(this.g,id,h.spec_revision,false),development=developmentSnapshot(this.g,id,h.spec_revision,false);
  const counts={};for(const j of jobs)counts[j.status]=(counts[j.status]??0)+1;
  const execution=deliveryActions(this.g,id),display_state=deliveryDisplayState(developmentDisplayState(a2aDisplayState(taskDisplayState(h,jobs,planning),a2a),development),execution);
  return {...h,display_state,delivery_summary:{available:execution.available,total:execution.total,visible:execution.items.length,error:execution.error??null,grants_execution:false},development_summary:development,a2a_summary:a2a,planning_summary:{available:planning.available,schedules_total:planning.schedules_total,workflows_total:planning.workflows_total},jobs:jobs.map(({checkpoint,...j})=>j),jobs_total:this.g.scheduler?.jobs.db.prepare('SELECT COUNT(*) n FROM jobs WHERE task_id=?').get(id).n??0,visible_job_counts:counts,approval:this.approvals(id,1)[0]??null,repository:this.repository(id),actual_model_source:'open_detail_for_native_session_evidence'};
 }
 async models(run){
  const q=this.ctx.get('sessionQuery');if(!q?.readSession)return {state:'unavailable',items:[]};
  const key=run.id+':'+run.finished,old=this.cache.get(key),now=performance.now();
  if(old&&now-old.at<30000)return old.value;
  // Bound whole-log reads. A slow/corrupt log must not occupy all RPC handlers.
  if(this.reads>=2)return {state:'deferred',items:[]};
  this.reads++;let timer;
  const read=Promise.resolve().then(()=>q.readSession(run.session_id)).then(s=>{
   const events=s?.events??[],inherited=s?.inheritedEventCount??0;
   const items=events.slice(inherited).filter(e=>e.type==='request/context'&&typeof e.data?.model==='string').slice(-20).map(e=>({provider:text(e.data.provider,128),model:text(e.data.model,128),seq:e.seq,at:e.time??null}));
   return {state:items.length?'observed':'not_observed',items,source:'native-session-request/context',durability:'not_attested',proves_dispatch:false,proves_completion:false};
  }).catch(()=>({state:'unavailable',items:[]})).finally(()=>{this.reads--;});
  const value=await Promise.race([read,new Promise(r=>{timer=setTimeout(()=>r({state:'unavailable',items:[]}),2000);})]);clearTimeout(timer);
  if(this.cache.size>=50)this.cache.delete(this.cache.keys().next().value);
  this.cache.set(key,{at:performance.now(),value});return value;
 }
 async call(method,args){
  if(!object(args))throw Error('INVALID_TASK_BOARD_ARGUMENT');
  const g=this.g;if(g.c.role!=='cloud')return (await g.link.call(method,args)).result;
  if(method==='board_list'){
   const {query='',after=0,limit=20}=args;
   if(Object.keys(args).some(k=>!['query','after','limit'].includes(k))||typeof query!=='string'||query.length>120||!Number.isInteger(after)||after<0||!Number.isInteger(limit)||limit<1||limit>50)throw Error('INVALID_TASK_BOARD_ARGUMENT');
   const q=query.normalize('NFKC').toLocaleLowerCase().trim();
   const heads=g.store.db.prepare('SELECT id FROM tasks ORDER BY rowid DESC').all().map(r=>this.head(r.id)).filter(h=>h.title.normalize('NFKC').toLocaleLowerCase().includes(q)).sort((a,b)=>(b.created??0)-(a.created??0));
   return {schema:1,authority:'cloud',observed_at:g.now(),instance_id:g.instanceId,host:boardHost(g),items:heads.slice(after,after+limit).map(h=>this.summary(h.task_id)),total:heads.length,next_cursor:after+limit<heads.length?after+limit:null,development_enabled:!!g.development?.gate?.enabled,development:developmentConfiguration(g),grants_execution:false,publish_enabled:false};
  }
  if(!['board_detail','board_interventions'].includes(method)||Object.keys(args).some(k=>k!=='task_id')||typeof args.task_id!=='string'||args.task_id.length>128)throw Error('INVALID_TASK_BOARD_ARGUMENT');
  const observed_at=g.now(),id=args.task_id,item=this.summary(id),jobs=this.jobs(id),approvals=this.approvals(id),db=g.scheduler?.jobs.db;
  const runs=db?db.prepare('SELECT r.id,r.session_id,r.status,r.started,r.finished,r.job_id FROM runs r JOIN jobs j ON j.id=r.job_id WHERE j.task_id=? ORDER BY r.started DESC,r.id DESC LIMIT 10').all(id):[];
  // Only this task's persisted run sessions are admissible, never an arbitrary path/id.
  for(const [i,r] of runs.entries()){r.lineage=jobLineage(g,db.prepare('SELECT id,task_id,version FROM jobs WHERE id=?').get(r.job_id));r.actual_models=i<3?await this.models(r):{state:'not_read',items:[]};}
  const response={schema:1,authority:'cloud',observed_at,instance_id:g.instanceId,item:{...item,delivery:deliverySnapshot(g,id,item.spec_revision),development:developmentSnapshot(g,id,item.spec_revision),a2a:a2aSnapshot(g,id,item.spec_revision),notifications:g.notifications?.status(id)??null,planning:planningSnapshot(g,id,id=>this.head(id).title),jobs,approvals,runs,runs_total:db?.prepare('SELECT COUNT(*) n FROM runs r JOIN jobs j ON j.id=r.job_id WHERE j.task_id=?').get(id).n??0,artifacts:g.artifacts?.list(id)??{state:'not_registered',downloadable:[]}}};
  if(this.interventions)response.item.interventions=method==='board_interventions'?this.interventions.observe(response.item,observed_at):this.interventions.view(id);
  if(g.interventionActions&&response.item.interventions)for(const row of response.item.interventions.items)row.handling=g.interventionActions.history(id,row.id);
  return response;
 }
}
export function boardPending(g){
 if(!has(g.db,'submissions'))return [];
 return g.db.prepare("SELECT id,payload,status,attempts,next_attempt_at,last_error FROM submissions WHERE status<>'accepted' ORDER BY rowid DESC LIMIT 20").all().map(r=>({id:r.id,title:text(envelope(parse(r.payload)?.goal??'')?.title??parse(r.payload)?.goal??'历史入口记录',120),status:r.status,attempts:r.attempts,next_attempt_at:r.next_attempt_at,error:code(r.last_error),authority:'entry_only_not_cloud_task'}));
}
export function installTaskBoard(ctx,g){
 ctx.inject(['connection'],sub=>{
  const board=new TaskBoard(sub,g);g.board=board;
  sub.effect(()=>()=>{if(g.board===board)delete g.board;board.cache.clear();});
  sub.connection.fetch.register({path:'/api/task-board/control',methods:['POST'],requestBody:'buffered',async fetch(request){
   let b;try{b=await request.json();}catch{return new Response('bad request',{status:400});}
   if(!object(b)||b.type!=='client-request'||typeof b.rpcId!=='string'||b.rpcId.length>128||b.method!=='task-board/control'||!object(b.payload))return new Response('bad request',{status:400});
   const respond=result=>Response.json({type:'server-response',rpcId:b.rpcId,result},{headers:{'Cache-Control':'no-store'}});
   let leave;try{
    leave=g.maintenance?.enter('board_ui');
    if(b.payload.method==='delivery-file-page')return respond({ok:true,value:await g.observedCall('delivery_file_page',b.payload.args??{})});
    if(b.payload.method==='notification-artifact-access')return respond({ok:true,value:await g.notifications.artifactAccess(b.payload.args??{})});
    if(b.payload.method==='notification-discover'){const value=await g.call('notification_discover',b.payload.args??{});return respond({ok:true,value:{...value,viewer_role:g.c.role}});}
    const method={list:'board_list',detail:'board_detail',interventions:'board_interventions'}[b.payload.method];if(!method)throw Error('METHOD_DENIED');
    const value=await board.call(method,b.payload.args??{});
    return respond({ok:true,value:{...value,viewer_role:g.c.role,viewer:boardHost(g),development_peer:developmentPeerSnapshot(g,method!=='board_list'?b.payload.args?.task_id:null),pending:method==='board_list'?boardPending(g):undefined}});
   }catch(e){return respond({ok:false,error:{code:errorInfo(e).code,message:'任务状态暂不可用；不表示对端空闲。',details:{viewer:boardHost(g),pending:boardPending(g),development_peer:developmentPeerSnapshot(g)}}});}finally{leave?.();}
  }});
 });
}
