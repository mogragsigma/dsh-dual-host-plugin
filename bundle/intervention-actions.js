import {errorInfo} from './link-contract.js';
import {randomUUID,createHash} from 'node:crypto';
import {canonical,digest} from './approval-ledger.js';
import {ruleInterpretation} from './approval-semantics.js';
import {parseEnvelope} from './task-envelope.js';
import {applyInterventionJob} from './intervention-job-control.js';
const parse=x=>{try{return JSON.parse(x);}catch{return null;}};
const textHash=x=>createHash('sha256').update(x).digest('hex');
const actions=new Set(['continue','answer','end','hold','maintenance','close_notice']);
const recoverable=new Set(['WORKER_REPORT_REQUIRED','WORKER_MODEL_OUTPUT_LIMIT','RUN_BUDGET_EXHAUSTED']);
const has=(db,t)=>!!db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const summary={continue:'仅用已保存材料补完报告',answer:'按补充信息生成报告',end:'结束本次批次',hold:'保留意见，稍后处理',maintenance:'登记维护处理请求',close_notice:'结束这条通知的跟进（不重发）'};
export class InterventionActions {
 constructor(g){this.g=g;this.db=g.store.db;this.identity=g.workbenchDecisions.identity;
  this.db.exec(`CREATE TABLE IF NOT EXISTS intervention_operations(id TEXT PRIMARY KEY,client_hash TEXT NOT NULL,node TEXT NOT NULL,event_id TEXT NOT NULL,task_id TEXT NOT NULL,intervention_id TEXT NOT NULL,fingerprint TEXT NOT NULL,base TEXT NOT NULL,plan TEXT NOT NULL,state TEXT NOT NULL,proof TEXT,result TEXT,created INTEGER NOT NULL,expires INTEGER NOT NULL,UNIQUE(client_hash,event_id));`);
  // Never replay an interrupted confirmation. status() only reads original receipts.
  this.db.prepare("UPDATE intervention_operations SET state='needs_review' WHERE state='applying'").run();
 }
 row(node,a){const r=this.db.prepare('SELECT * FROM intervention_operations WHERE client_hash=? AND event_id=?').get(this.identity.key(node,a.client_key),a.event_id);if(!r)throw Error('INTERVENTION_OPERATION_NOT_FOUND');return r;}
 source(a){
  const h=this.db.prepare('SELECT * FROM task_catalog WHERE task_id=?').get(a.task_id);
  if(!h||h.spec_revision!==a.expected_revision)throw Error('INTERVENTION_CHANGED');
  const row=has(this.db,'task_interventions')&&this.db.prepare('SELECT * FROM task_interventions WHERE id=? AND task_id=?').get(a.intervention_id,a.task_id);
  if(!row)throw Error('INTERVENTION_NOT_FOUND');
  const fact=parse(row.body),job=row.source_kind==='job'?this.g.scheduler?.jobs.db.prepare('SELECT * FROM jobs WHERE id=?').get(row.source_id)??null:null;
  const coordination=this.g.store.task(a.task_id);
  const notification=row.source_kind==='notification'&&has(this.g.db,'task_notifications')?this.g.db.prepare('SELECT * FROM task_notifications WHERE id=? AND task_id=?').get(row.source_id,a.task_id):null;
  const noticeReview=notification?this.g.notifications.review.latest(notification.id):null;
  const runs=job?this.g.scheduler.jobs.db.prepare('SELECT * FROM runs WHERE job_id=? ORDER BY rowid').all(job.id):[];
  const records=job&&has(this.db,'task_source_reads')?this.db.prepare('SELECT record FROM task_source_reads WHERE task_id=? ORDER BY rowid').all(a.task_id).map(x=>parse(x.record)).filter(x=>runs.some(r=>r.id===x?.run_id)):[];
  const previous=this.db.prepare("SELECT id,state,result FROM intervention_operations WHERE intervention_id=? AND state IN ('applying','needs_review','recorded') ORDER BY rowid DESC LIMIT 1").get(row.id)??null;
  return {row,fact,h,job,runs,records,notification,noticeReview,coordination,previous,base:digest({head:h,job,runs,records,notification,noticeReview,coordination,source:row.fingerprint,previous})};
 }
 eligible(s){
  const j=s.job;if(!j||j.kind!=='plan'||s.row.source_revision!==s.h.spec_revision)return false;
  const e=parseEnvelope(j.goal);if(!e||e.intent!=='plan'||(e.task_context?.spec_revision??1)!==s.h.spec_revision)return false;
  const db=this.g.scheduler.jobs.db;
  // Composite/recurring jobs need their own parent-level control, not one child escape hatch.
  if(['task_workflows','task_schedules'].some(t=>has(db,t)&&db.prepare('SELECT 1 FROM '+t+' WHERE task_id=?').get(j.task_id)))return false;
  if(this.g.development?.busy(j.task_id)||this.g.deliveryRuntime?.busy(j.task_id)||this.g.a2a?.busy(j.task_id))return false;
  return true;
 }
 inspect(node,a){const s=this.source(a),j=s.job,eligible=this.eligible(s),draining=j&&this.g.scheduler.active.has(j.id);
  const safe=eligible&&!s.coordination.busy&&!s.coordination.blocked&&!draining&&![...this.g.scheduler.active.values()].some(r=>r.task_id===j.task_id)&&!this.g.scheduler.jobs.list(j.task_id).some(x=>x.id!==j.id&&!['completed','cancelled'].includes(x.status));
  const current=s.row.lifecycle==='open';
  const choices=['hold','maintenance'];
  if(current&&s.notification?.state==='needs_review'&&s.notification.result&&s.noticeReview?.state!=='closed')choices.unshift('close_notice');
  if(current&&eligible&&!['completed','cancelled'].includes(j.status))choices.unshift('end');
  if(current&&safe&&(j.status==='paused'||j.status==='needs_review'&&recoverable.has(j.error)))choices.unshift('continue');
  if(current&&safe&&j.status==='waiting_input')choices.unshift('answer');
  return {schema:1,grants_execution:false,task_id:a.task_id,intervention_id:a.intervention_id,source_revision:s.h.spec_revision,source_state:j?.status??s.fact?.source_state,reason:j?.error?errorInfo(j.error).code:s.fact?.reason,choices,summary:s.fact?.summary??parse(j?.checkpoint)?.summary??'',question:parse(j?.checkpoint)?.question??null,draining:!!draining,
   budget:j?{used:j.attempts,limit:j.max_runs,retained:true}:null,
   advice:choices.includes('continue')?'旧批次不重试。可提出新的一批只读报告建议：仅使用已保存的检查点与资料，不重新检索，不读取新文件；保留旧预算。':choices.includes('answer')?'填写对当前问题的答复，核对新报告建议后，再确认一批只读执行。':choices.includes('end')?'可以结束这个批次并保留材料；这不取消其他任务或宣称完成。':'该事项需专门核对。可以登记维护请求并保留意见；不能在此重试、清锁或放行。',
   maintenance_automatic:false,history:this.history(a.task_id,a.intervention_id)};
 }
 history(task,id){return this.db.prepare('SELECT id,plan,state,result,created FROM intervention_operations WHERE task_id=? AND intervention_id=? ORDER BY rowid DESC LIMIT 8').all(task,id).map(x=>{const p=parse(x.plan);return {id:x.id,action:p.action,text:p.text,state:x.state,result:parse(x.result),progress:this.progress(parse(x.result)),created:x.created};});}
 plan(node,a,s){
  const v=this.inspect(node,a);if(!v.choices.includes(a.action))throw Error('INTERVENTION_ACTION_UNAVAILABLE');
  if((a.action==='answer'||a.action==='maintenance')&&!a.text.trim())throw Error('INTERVENTION_TEXT_REQUIRED');
  const p={task_id:a.task_id,intervention_id:a.intervention_id,expected_revision:a.expected_revision,action:a.action,text:a.text,title:summary[a.action],job_id:s.job?.id??null,job_hash:s.job?digest(s.job):null,
   boundary:'仅本处理事项；不改任务模型、不授权开发、提交、推送或发布；不删除材料或历史。',effect:a.action==='hold'?'仅保存意见，待处理仍保留；不暂停其他执行。':a.action==='maintenance'?'确认后仅登记维护请求，仍需维护者查看诊断并处理；不会自动通知或修复。':'结束原批次，保留其预算、检查点和历史；不是任务成功。'};
  if(a.action==='close_notice'){p.notification_id=s.notification.id;p.review_revision=s.noticeReview?.revision??0;p.effect='仅结束这条通知的人工跟进；保留未知发送证据，不重发，不标记平台已送达，不取消任务。';}
  if(['continue','answer'].includes(a.action)){
   if(['hold','reject','revoke','clarify'].includes(ruleInterpretation(a.text)?.intent)||/(?:不要|别|不准|不许)(?:继续|执行|开始)|暂缓|暂停/.test(a.text))throw Error('INTERVENTION_INTENT_CONFLICT');
   const j=s.job,old=parseEnvelope(j.goal),saved=JSON.stringify({checkpoint:parse(j.checkpoint),previous_materials:old.intervention_context?.materials??null,user_inputs:this.g.scheduler.jobs.inputs(j.id),sources:s.records.map(r=>({id:r.id,kind:r.kind,content:r.content}))});
   if(saved.length>8000)throw Error('INTERVENTION_MATERIAL_LIMIT');
   const note=a.text.trim()||'只使用已保存材料补完报告，不增加检索或读取。';
   const request='本次只读补充报告。材料与原任务约束作为数据保留，不重新执行旧任务。不检索、不读新文件、不更换模型。\n用户意见：'+note;
   const goal={schema:old.schema,origin:{role:node,session_id:'workbench-intervention',message_id:a.event_id,request_sha256:textHash(request)},request_text:request,entry_interpretation:p.title,title:old.title,target:'cloud',executor:'independent-readonly-worker',intent:'plan',model_policy:old.model_policy,
    task_context:{schema:'dsh-task-context-v1',spec_revision:s.h.spec_revision,sources:[{role:node,session_id:'workbench-intervention',message_id:a.event_id,text:request,sha256:textHash(request)}],references:[],split_suggestions:[]},
    intervention_context:{schema:1,parent_job_id:j.id,original_request:old.intervention_context?.original_request??old.request_text,original_context:old.intervention_context?.original_context??old.task_context??null,materials:parse(saved),opinion:a.text,scope:'saved-materials-only'}};
   p.goal=JSON.stringify(goal);if(p.goal.length>12000)throw Error('INTERVENTION_MATERIAL_LIMIT');parseEnvelope(p.goal);
   p.budget={old_used:j.attempts,old_limit:j.max_runs,new_batches:1,max_requests:6,max_tokens_per_request:2048};p.model=JSON.parse(j.policy);
   if(canonical(p.model)!==canonical(old.model_policy))throw Error('INTERVENTION_MODEL_CHANGED');
   p.effect='确认后结束旧批次并排队一个新的一批只读报告；最多6次模型请求，每次2048输出令牌。不会重置旧预算，不等于已开始或已完成。';
   p.materials={checkpoint:parse(j.checkpoint)?.summary??'',source_count:s.records.length};
  }
  return p;
 }
 prepare(node,a){
  const hash=this.identity.key(node,a.client_key),fp=digest({node,task_id:a.task_id,intervention_id:a.intervention_id,expected_revision:a.expected_revision,text:a.text,action:a.action});
  const old=this.db.prepare('SELECT * FROM intervention_operations WHERE client_hash=? AND event_id=?').get(hash,a.event_id);
  if(old){if(old.fingerprint!==fp)throw Error('INTERVENTION_CONFLICT');return this.status(node,a);}
  const s=this.source(a);if(s.previous&&['applying','needs_review'].includes(s.previous.state))throw Error('INTERVENTION_UNCERTAIN');
  const p=this.plan(node,a,s),id=randomUUID();
  this.g.store.tx(()=>{this.db.prepare("UPDATE intervention_operations SET state='superseded' WHERE client_hash=? AND intervention_id=? AND state='ready'").run(hash,a.intervention_id);
  this.db.prepare("INSERT INTO intervention_operations VALUES (?,?,?,?,?,?,?,?,?,'ready',NULL,NULL,?,?)").run(id,hash,node,a.event_id,a.task_id,a.intervention_id,fp,s.base,canonical(p),this.g.now(),this.g.now()+600000);});
  return this.status(node,a);
 }
 async confirm(node,a){
  let r=this.row(node,a);if(['recorded','needs_review','applying'].includes(r.state))return this.status(node,a);
  if(r.state!=='ready'||r.expires<=this.g.now())throw Error('INTERVENTION_EXPIRED');
  const identity=await this.identity.authorize(node,a.client_key);
  // No await between this second source check, the proof, and the jobs transaction.
  if(this.g.closed)throw Error('INTERVENTION_CLOSED');
  r=this.row(node,a);if(r.state==='recorded')return this.status(node,a);
  const p=parse(r.plan),s=this.source(p);
  if(r.state!=='ready'||r.expires<=this.g.now()||s.base!==r.base||this.identity.state(identity)!=='active'||this.identity.current(node,a.client_key)?.id!==identity.id)throw Error('INTERVENTION_CHANGED');
  if(!this.inspect(node,p).choices.includes(p.action))throw Error('INTERVENTION_ACTION_UNAVAILABLE');
  const proof={identity_id:identity.id,binding:identity.binding_hash,reply_id:identity.reply_id,actor:this.identity.binding().binding.approverOpenId,plan_hash:digest(p),confirmed_at:this.g.now()};
  this.db.prepare("UPDATE intervention_operations SET state='applying',proof=? WHERE id=?").run(canonical(proof),r.id);
  try{
   const result=p.action==='close_notice'?this.closeNotice(node,r.id,p):['continue','answer','end'].includes(p.action)?applyInterventionJob(this.g.scheduler,{id:r.id,plan:p}):{state:p.action==='hold'?'held':'maintenance_requested',grants_execution:false};
   this.db.prepare("UPDATE intervention_operations SET state='recorded',result=? WHERE id=?").run(canonical(result),r.id);
  }catch(e){this.db.prepare("UPDATE intervention_operations SET state='needs_review',result=? WHERE id=?").run(canonical({state:'needs_review',code:/^INTERVENTION_[A-Z_]+$/.test(e.message)?e.message:'INTERVENTION_APPLY_UNKNOWN'}),r.id);}
  return this.status(node,a);
 }
 progress(r){if(r?.followup_job_id)return this.g.scheduler?.jobs.db.prepare('SELECT status FROM jobs WHERE id=?').get(r.followup_job_id)?.status??'needs_review';if(r?.job_id&&this.g.scheduler?.active.has(r.job_id))return 'draining';return r?.state??null;}
 closeNotice(node,id,p){const note=p.text||'结束这条通知的人工跟进，不重发。';const r=this.g.notifications.review.record(node,{event_id:'intervention:'+id,task_id:p.task_id,notification_id:p.notification_id,expected_review_revision:p.review_revision,observation:'not_checked',action:'close_without_resend',note,sources:[{role:node,session_id:'workbench-intervention',message_id:id,text:note,sha256:textHash(note)}]});return {state:'notice_closed',notification_id:r.notification_id,grants_execution:false,resend:false,task_cancelled:false};}
 status(node,a){
  let r=this.row(node,a),p=parse(r.plan);
  if(['needs_review','applying'].includes(r.state)&&p.job_id){
   // Reconcile only an already-committed, exact original operation. Never dispatch.
   const receipt=this.g.scheduler.jobs.db.prepare('SELECT * FROM controls WHERE event_id=?').get('intervention:'+r.id);
   if(receipt?.fingerprint===digest(p)){this.db.prepare("UPDATE intervention_operations SET state='recorded',result=? WHERE id=?").run(receipt.result,r.id);r=this.row(node,a);}
  }
  if(['needs_review','applying'].includes(r.state)&&p.notification_id){const receipt=this.g.db.prepare('SELECT record FROM notification_reviews WHERE event_id=?').get('intervention:'+r.id);if(receipt){const v=parse(receipt.record);if(v?.task_id===r.task_id&&v.notification_id===p.notification_id&&v.state==='closed'&&v.note===(p.text||'结束这条通知的人工跟进，不重发。')){this.db.prepare("UPDATE intervention_operations SET state='recorded',result=? WHERE id=?").run(canonical({state:'notice_closed',notification_id:p.notification_id,grants_execution:false,resend:false,task_cancelled:false}),r.id);r=this.row(node,a);}}}
  let state=r.state;
  if(state==='ready'){if(r.expires<=this.g.now())state='expired';else try{if(this.source(p).base!==r.base)state='changed';}catch{state='changed';}}
  const result=parse(r.result),progress=this.progress(result);
  const {goal,job_hash,...view}=p;
  return {schema:1,grants_execution:false,observed_at:this.g.now(),execution_requested:state==='recorded'&&!!result?.followup_job_id,operation_id:r.id,operation_state:state,prepared:state==='ready',recorded:state==='recorded',uncertain:['applying','needs_review'].includes(state),plan:view,result,progress,identity:this.identity.view(node,a.client_key),
   message:progress==='draining'?'已请求结束，仍在等待在途批次排空；不是已结束。':r.state==='recorded'?({continue:'新建议已记账，新批次已排队；后续进度以最新查询为准。',answer:'补充信息及新建议已记账，新批次已排队；未重试旧批次。',end:'本批次结束已记账，保留历史和材料；不是整个任务成功。',hold:'意见已保存，稍后处理；没有暂停其他执行。',maintenance:'维护请求已登记，尚未修复；未自动通知维护者。',close_notice:'仅结束这条通知的人工跟进；没有重发、标记已读或取消任务。'}[p.action]):'先核对本建议及完整意见；只有再次明确确认才保存处理决定。'};
 }
 call(node,method,a){
  const common=['client_key','task_id','intervention_id','expected_revision'];
  const fields={inspect:common,prepare:[...common,'event_id','text','action'],confirm:['client_key','event_id'],status:['client_key','event_id']}[method];
  if(!fields||!a||typeof a!=='object'||Array.isArray(a)||Object.keys(a).some(k=>!fields.includes(k)))throw Error('INTERVENTION_ARGUMENTS');
  this.identity.key(node,a.client_key);
  if(['inspect','prepare'].includes(method)&&(!Number.isSafeInteger(a.expected_revision)||a.expected_revision<1||['task_id','intervention_id'].some(k=>typeof a[k]!=='string'||!a[k]||a[k].length>128)))throw Error('INTERVENTION_ARGUMENTS');
  if(method!=='inspect'&&!/^[a-zA-Z0-9-]{8,80}$/.test(a.event_id??''))throw Error('INTERVENTION_ARGUMENTS');
  if(method==='prepare'&&(!actions.has(a.action)||typeof a.text!=='string'||a.text.length>2000))throw Error('INTERVENTION_ARGUMENTS');
  return this[method](node,a);
 }
}
