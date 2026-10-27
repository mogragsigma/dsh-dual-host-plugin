import {deliveryLabel,commitExecution,pushExecution,deliveryExecution} from './delivery-contract.js';
import {repositoryLabel} from './repository-gitee.js';
// Ledger-driven outbox. No model text, remote approval method or IM consumer dependency.
const states={delivery_changed:'交付预览证据变化或缺失，原批准不放行',held:'已暂缓，原批准不再放行',changes_requested:'已收取修改意见，旧方案禁止执行，须修订重审',clarification_required:'待澄清，未批准执行',confirmation_review:'语义核验或故障核对中，禁止执行',repository_changed:'仓库绑定或基线已变化，旧批准无效',approved:'已批准（仅记账）',rejected:'已拒绝',revoked:'已撤销',expired:'已过期',superseded:'已被新方案替代',stale_revision:'任务已修改，旧批准无效',task_blocked:'任务已阻塞',identity_revoked:'审批身份已失效',pending:'待确认'};
const actions={hold:'暂缓',amend:'提出修改意见',clarify:'请求澄清',approve:'批准',reject:'拒绝',revoke:'撤销'};
const safeError=e=>/^(CHAT_|APPROVAL_)[A-Z0-9_]+$/.test(e?.message)?e.message:'CHAT_RECEIPT_PROVIDER_UNAVAILABLE';
export function renderReceipt(v,d,at,anchored=false,hasProposal=true){
 const p=v.proposal;
 return ['【DSH 审批账本回执 · 非模型回复】','✓ 结果通知 · 无需回复本条（不是待审批方案）',`任务：${JSON.stringify(v.title)}（第 ${v.spec_revision} 版）`,`账本事件：${actions[d.action]}，已持久保存（${new Date(d.created).toISOString()}）`, `截至 ${new Date(at).toISOString()} 的有效状态：${pushExecution(p)&&v.state==='approved'?'已批准限定推送范围（不等于已发送或远端已接受）':commitExecution(p)&&v.state==='approved'?'已批准限定提交范围（不等于已执行）':p.development&&v.state==='approved'?'已批准限定开发范围（不等于已执行）':states[v.state]??v.state}`,`请求范围：${p.scopes.join('、')}；各范围独立`,`任务模型：${p.model_policy.provider} / ${p.model_policy.model}${p.model_policy.reasoningEffort?' / '+p.model_policy.reasoningEffort:''}`,(p.development||deliveryExecution(p))?repositoryLabel(p.repository).replace('仅远端元数据，未检出工作区','远端审批基线；检出和实际写入须另查运行记录'):repositoryLabel(p.repository),...(p.delivery?[deliveryLabel(p.delivery)]:[]),...(v.feedback?[`最新回复意见：${JSON.stringify(v.feedback.user_text.slice(0,2000))}`,`语义核验：${JSON.stringify(v.feedback.reason)}`,v.feedback.requires_new_proposal?'后续：请按修改意见形成新方案，再由本人确认；旧方案不会执行。':'后续：以本账本有效状态为准，批准不等于执行。']:[]),pushExecution(p)?'执行状态：本回执只证明独立推送审批账本；是否已排队、发送或远端引用已匹配须查看交付操作与独立回读。没有开发修改、再次提交、发布或部署权限。':commitExecution(p)?'执行状态：本回执只证明审批账本；是否已排队、提交或部分生效必须查看交付操作及回读记录。未因此获得推送、发布或部署权限。':p.development?'执行状态：本回执只证明审批账本，不证明执行是否开始或结束；以当前批次及写入审计为准。提交、推送、发布、部署不在授权内。':'执行状态：未开放。未启动开发、未写仓库、未提交、未推送、未发布、未部署。',`方案有效期至：${new Date(v.expires).toISOString()}`,'这是账本状态快照，不表示任务已执行或消息已被阅读；后续撤销、修订、过期以最新账本查询为准。','普通聊天回复不能代替本回执；可直接询问这项任务的审批状态，不用输入编号。',!hasProposal?'如要改变决定：回到大肥鱼bot工作台的同一任务，查看当前方案后输入意见；不要回复这条结果通知。':anchored?'如要改变决定：点击本条上方引用回到【DSH 方案确认】原文，再对原方案点“回复”。':'如要改变决定：找到同任务的【DSH 方案确认】原文，对原方案点“回复”；不要回复这条结果通知。',`回执记录：${d.id}`].join('\n');
}
export class ApprovalReceipts {
 constructor(ledger,bindingHash,source,binding){
  this.binding=binding;this.l=ledger;this.db=ledger.db;this.bindingHash=bindingHash;this.source=source;this.now=ledger.now;this.closed=false;
  if(!this.db.prepare('PRAGMA table_info(approval_receipts)').all().some(c=>c.name==='target_id'))this.db.exec('ALTER TABLE approval_receipts ADD COLUMN target_id TEXT');
  ledger.store.tx(()=>{
   // A known provider ID can be read again; an unknown submission must never be resent.
   this.db.prepare("UPDATE approval_receipts SET state=CASE WHEN message_id IS NULL THEN 'needs_review' ELSE 'verifying' END,last_error='CHAT_RECEIPT_SEND_INTERRUPTED' WHERE state='sending'").run();
   for(const d of this.db.prepare('SELECT id FROM approval_decisions WHERE id NOT IN (SELECT decision_id FROM approval_receipts)').all())ledger.enqueueReceipt(d.id);
  });
 }
 enabled(){return this.db.prepare('SELECT disabled FROM approval_chat_bindings WHERE id=?').get(this.bindingHash)?.disabled===0;}
 status(request_id){return this.db.prepare('SELECT decision_id,state,binding_hash,snapshot_state,snapshot_at,message_id,last_error FROM approval_receipts WHERE request_id=? ORDER BY created,decision_id').all(request_id).map(({binding_hash,...r})=>({...r,state:binding_hash===this.bindingHash?r.state:'needs_review',last_error:binding_hash===this.bindingHash?r.last_error:'CHAT_ROUTE_REVIEW_REQUIRED',transport:r.state==='sent'?'provider_verified_not_read':'not_verified',kind:'approval_ledger_receipt',authoritative_source:'approval_ledger',current_state:this.l.view(request_id).state,execution:this.l.view(request_id).execution}));}
 retry(r,e){if(e?.message==='CHAT_LOCAL_IM_OFFLINE'){this.db.prepare('UPDATE approval_receipts SET last_error=? WHERE decision_id=?').run(e.message,r.decision_id);return;}const n=r.attempts+1;this.db.prepare('UPDATE approval_receipts SET state=?,attempts=?,next_attempt=?,last_error=? WHERE decision_id=?').run(n>=8?'needs_review':r.state,n,this.now()+Math.min(300000,1000*2**n),safeError(e),r.decision_id);}
 async verify(r){
  try{
   const m=await this.source.get(r.message_id);if(this.closed)return;
   let text;try{text=JSON.parse(m?.body?.content).text;}catch{}
   const b=this.binding;
   if(!b||m?.message_id!==r.message_id||(r.target_id&&m.parent_id!==r.target_id)||m.chat_id!==b.chatId||m.sender?.sender_type!=='app'||m.sender.id_type!=='app_id'||m.sender.id!==b.appId||m.msg_type!=='text'||m.deleted!==false||text!==r.text){
    this.db.prepare("UPDATE approval_receipts SET state='needs_review',last_error='CHAT_RECEIPT_CONTENT_MISMATCH' WHERE decision_id=?").run(r.decision_id);return;
   }
   this.db.prepare("UPDATE approval_receipts SET state='sent',last_error=NULL WHERE decision_id=?").run(r.decision_id);
  }catch(e){this.retry(r,e);}
 }
 async cycle(){
  if(this.closed||!this.enabled())return;
  const rows=this.db.prepare("SELECT * FROM approval_receipts WHERE binding_hash=? AND state IN ('queued','verifying') AND next_attempt<=? ORDER BY created,decision_id LIMIT 10").all(this.bindingHash,this.now());
  if(!rows.length)return;
  try{await this.source.verifyBot();}catch(e){
   if(['CHAT_BOT_CHANGED','CHAT_PRIVATE_ROUTE_REQUIRED'].includes(e.message))this.db.prepare('UPDATE approval_chat_bindings SET disabled=1 WHERE id=?').run(this.bindingHash);
   for(const r of rows)this.retry(r,e);return;
  }
  for(const r of rows){
   if(this.closed||!this.enabled())return;
   if(r.state==='verifying'){await this.verify(r);continue;}
   const d=this.db.prepare('SELECT * FROM approval_decisions WHERE id=?').get(r.decision_id),v=this.l.view(r.request_id),at=this.now();
   const target=this.db.prepare('SELECT message_id FROM approval_chat_deliveries WHERE request_id=?').get(r.request_id)?.message_id;
   const anchored=!!target&&typeof this.source.reply==='function';
   const text=renderReceipt(v,d,at,anchored,!!target);
   // Snapshot is computed AFTER network preflight, immediately before durable send intent.
   const changed=this.db.prepare("UPDATE approval_receipts SET state='sending',text=?,snapshot_state=?,snapshot_at=?,target_id=?,attempts=attempts+1 WHERE decision_id=? AND state='queued'").run(text,v.state,at,anchored?target:null,r.decision_id).changes;
   if(!changed)continue;
   let id;try{id=anchored?await this.source.reply(target,text,r.uuid):await this.source.send(text,r.uuid);}catch{
    this.db.prepare("UPDATE approval_receipts SET state='needs_review',last_error='CHAT_RECEIPT_SEND_RESULT_UNKNOWN' WHERE decision_id=?").run(r.decision_id);continue;
   }
   this.db.prepare("UPDATE approval_receipts SET state='verifying',message_id=?,attempts=0,next_attempt=0,last_error=NULL WHERE decision_id=?").run(id,r.decision_id);
   if(this.closed)return;
   await this.verify({...r,state:'verifying',message_id:id,text,target_id:anchored?target:null,attempts:0});
  }
 }
 close(){this.closed=true;}
}
