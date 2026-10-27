import {errorInfo} from './link-contract.js';

export const RECEIPTS=Object.freeze({
 model_selection:'目标端当前模型配置解析，不是任务执行、身份审批或接口调用成功证明',
 delivery_preview:'交付只读预览；工作区测试不等于提交，远端接收不等于运行环境采用，不授权任何写入',
 intake_local:'本端持久入队，尚非云端受理',intake_cloud:'云端任务已登记，不表示执行',
 peer_transport:'消息入队／中继保存／对端持久收件，不表示模型已读或已执行',
 file_transfer:'文件快照排队／中继保存／对端校验落盘；不表示模型已读，不授权执行或仓库写入',
 workflow:'真实子任务图已保存／受控变更；共享预算，不表示全部执行成功',
 trigger:'持久触发登记／控制／事件入队，不等于已经触发或执行',
 schedule:'执行批次调度或控制，不表示已完成；暂停不证明排空',
 approval_reference:'只读引用定位与账本快照；不核验当前回复，不证明失败、批准或执行',
 proposal_delivery:'方案待确认及投递状态，不是批准决定',approval_ledger:'权威审批决定和独立投递回执，批准不等于执行',
 notification:'通知投递，不能反推任务或批准状态',repository_preflight:'只读元数据或门禁预检，不授权写入',
 task_snapshot:'任务状态快照，不保证未来状态',diagnostic_snapshot:'诊断快照，不是审批、写锁或执行许可',
});
export function receiptClassification(name,r){
 let kind;
 if(name==='task_model_resolve')kind='model_selection';
 else if(name.startsWith('task_notification_'))kind='notification';
 else if(name==='task_submit')kind=r.status==='accepted'?'intake_cloud':'intake_local';
 else if(name.startsWith('task_peer_'))kind='peer_transport';
 else if(name==='task_file_scope')kind='diagnostic_snapshot';
 else if(name.startsWith('task_file_'))kind='file_transfer';
 else if(name.startsWith('task_workflow_'))kind=name==='task_workflow_list'?'task_snapshot':'workflow';
 else if(name.startsWith('task_trigger_'))kind=name==='task_trigger_list'?'task_snapshot':'trigger';
 else if(name==='task_input')kind='schedule';
 else if(['task_schedule','task_control'].includes(name))kind='schedule';
 else if(name==='task_approval_request')kind='proposal_delivery';
 else if(name==='task_approval_reference')kind='approval_reference';
 else if(name==='task_approval_status')kind='approval_ledger';
 else if(name.startsWith('task_delivery_'))kind='delivery_preview';
 else if(name.startsWith('task_repository_'))kind='repository_preflight';
 else if(['task_catalog','task_status','task_results','task_artifact_list','task_artifact_access'].includes(name))kind='task_snapshot';
 else if(name==='task_diagnostics')kind='diagnostic_snapshot';
 if(!kind)return r;
 return {...r,receipt_classification:{kind,meaning:RECEIPTS[kind],grants_execution:false,proves_user_read:false}};
}
const exists=(db,t)=>!!db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
function queue(db,table,stateColumn,waiting,dueColumn,createdColumn,now){
 if(!exists(db,table))return {available:false};
 const columns=new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(x=>x.name));
 const groups=db.prepare(`SELECT ${stateColumn} state,COUNT(*) count FROM ${table} GROUP BY ${stateColumn}`).all();
 const predicate=`${stateColumn} IN (${waiting.map(()=>'?').join(',')})`;
 const oldest=createdColumn&&columns.has(createdColumn)?db.prepare(`SELECT MIN(${createdColumn}) oldest FROM ${table} WHERE ${predicate}`).get(...waiting).oldest:null;
 const due=dueColumn&&columns.has(dueColumn)?db.prepare(`SELECT MIN(${dueColumn}) due FROM ${table} WHERE ${predicate}`).get(...waiting).due:null;
 const error=columns.has('last_error')?'last_error':columns.has('error')?'error':null;
 const errors=error?db.prepare(`SELECT ${error} code,COUNT(*) count FROM ${table} WHERE ${error} IS NOT NULL AND ${stateColumn} NOT IN ('sent','accepted','peer_saved','completed','cancelled') GROUP BY ${error} LIMIT 20`).all().map(r=>({...errorInfo(r.code),count:r.count})):[];
 return {available:true,counts:groups,pending:groups.filter(r=>waiting.includes(r.state)).reduce((n,r)=>n+r.count,0),needs_review:groups.find(r=>r.state==='needs_review')?.count??0,oldest_pending_at:oldest??null,oldest_age_ms:oldest==null?null:Math.max(0,now-oldest),age_unknown:oldest==null,next_due_at:due??null,errors,automatic_repair:false};
}
export function queueDiagnostics(g){
 const now=g.now();return {
  submissions:queue(g.db,'submissions','status',['queued'],'next_attempt_at','created_at',now),
  peer_outbox:queue(g.db,'peer_outbox','status',['queued','broker_saved'],'next_at','created_at',now),
  file_outbox:queue(g.db,'peer_file_out','state',['preparing','queued','broker_saved'],'next_at',null,now),
  file_inbox:queue(g.db,'peer_file_in','state',['receiving','publishing'],null,null,now),
  notification_targets:queue(g.db,'notification_target_publications','state',['pending'],'next_at',null,now),
  task_notifications:queue(g.db,'task_notifications','state',['queued','leased','dispatching'],'due','created',now),
  notification_endpoint:queue(g.db,'notification_inbox','state',['pending','sending'],'next_at','created',now),
  notifications:queue(g.db,'receipts','status',['queued','sending'],'next_attempt_at','created_at',now),
  legacy_notices:{...queue(g.db,'notices','status',['queued','sending'],'next_attempt_at','created',now),consumer_enabled:!!g.legacy},
  approval_proposals:queue(g.store?.db,'approval_chat_deliveries','state',['queued','sending'],null,'created',now),
  approval_receipts:queue(g.store?.db,'approval_receipts','state',['queued','sending','verifying'],'next_attempt','created',now),
  schedules:queue(g.scheduler?.jobs.db,'task_schedules','status',['active','active-search','active-notify','paused','review'],'next_due','created',now),
  workflows:queue(g.scheduler?.jobs.db,'task_workflows','status',['active','active-search','active-notify','paused'],null,'created',now),
  development_peer:queue(g.db,'development_peer_requests','state',['pending','cloud_queued','claiming','active','finishing','reviewing'],null,'updated',now),
  development_requests:queue(g.store?.db,'development_requests','state',['queued','active'],null,'created',now),
  development_operations:queue(g.store?.db,'development_operations','state',['intent','spawned'],null,'started',now),
  jobs:queue(g.scheduler?.jobs.db,'jobs','status',['queued','running','paused','waiting_capability','waiting_input'],null,'created',now),
 };
}
export function recoveryGuidance(queues){
 const hints=[];for(const [queue,s] of Object.entries(queues)){
  if(s.needs_review)hints.push({queue,reason:'needs_review',action:'核对既有记录与平台结果；不得盲目重发、清库或换编号'});
  for(const e of s.errors??[])hints.push({queue,reason:e.code,category:e.category,action:e.category==='maintenance'?'等待对端维护锁显式释放；保留原队列，不消耗发送重试预算，也不表示任务失败':e.category==='compatibility'?'修复双端版本／能力／配置后由原幂等记录恢复；不视为空闲':e.category==='uncertain_delivery'?'确认是否已送达；结果未知不自动重发':e.category==='authentication'?'核对既有认证配置；不修改凭据或绕过认证':'查看失败类别及下次重试时间；不虚报成功'});
 }
 return hints.slice(0,40);
}
