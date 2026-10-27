import {deliveryLabel,approvalTitle,deliveryExecution} from './delivery-contract.js';
function workspaceDevelopmentLabel(s){
 return '方案约束开发：分支 '+s.branch+'；执行端 '+(s.executors??['cloud']).join('、')+'；最多写入 '+s.max_writes+' 次、命令 '+s.max_commands+' 次、模型请求 '+s.max_model_requests+' 次。\n'+
  '文件集合（基线 SHA-256）：\n'+s.files.map(f=>f.action+' '+JSON.stringify(f.path)+' '+(f.base_sha256??'absent')).join('\n')+'\n只读输入：\n'+s.reads.map(f=>JSON.stringify(f.path)+' '+f.sha256).join('\n')+'\n批准命令：\n'+s.commands.map(c=>JSON.stringify(c)).join('\n')+'\n命令仅在无网络、源快照只读的受管容器执行，不授权宿主 shell。提交、推送、发布、部署不在授权内；候选能力仍须运行时版本和运营方绑定。';
}
import {interpretApproval,SEMANTICS_VERSION} from './approval-semantics.js';
import {repositoryLabel} from './repository-gitee.js';
import {ApprovalGuidance} from './approval-guidance.js';
import {ApprovalReceipts} from './approval-receipts.js';
import {randomUUID} from 'node:crypto';
import {digest,canonical} from './approval-ledger.js';
import {chatBinding,FeishuApprovalSource} from './approval-feishu.js';
const COMMANDS=new Map([['确定','approve'],['/yes','approve'],['不批准此方案','reject'],['/no','reject'],['撤销此方案','revoke'],['/revoke','revoke']]);
export const chatAction=text=>typeof text==='string'?COMMANDS.get(text.trim())??null:null;
const plain=m=>{try{const c=JSON.parse(m.body.content);return typeof c.text==='string'?c.text:null;}catch{return null;}};
const promptVersion=m=>canonical({updated:m.updated,update_time:m.update_time});
const original=m=>m?.msg_type==='text'&&m.deleted===false&&m.updated===false&&/^\d{13}$/.test(m.create_time??'')&&m.update_time===m.create_time;
export function renderChatProposal(v,semantic=false){
 const p=v.proposal;
 return [approvalTitle(p),'▼ 待你决定 · 请回复本条方案（不是后续结果通知）',`任务：${v.title}（第 ${v.spec_revision} 版）`,`方案：${p.summary}`,`变更：${p.changes}`,`验收：${p.validation}`,`风险：${p.risks}`,`回滚：${p.rollback}`,`任务模型：${p.model_policy.provider} / ${p.model_policy.model}${p.model_policy.reasoningEffort?' / '+p.model_policy.reasoningEffort:''}`,`请求范围：${p.scopes.join('、')}；范围互不包含`, ((p.development||deliveryExecution(p))?repositoryLabel(p.repository).replace('仅远端元数据，未检出工作区','审批绑定远端基线；独立检出由运行时另行核验'):repositoryLabel(p.repository)),p.delivery?deliveryLabel(p.delivery):p.development?.kind==='workspace-v1'?workspaceDevelopmentLabel(p.development):p.development?`受限开发：执行端 ${(p.development.executors??['cloud']).map(x=>x==='local'?'本地大肥鱼':'云端大肥鱼').join('、')}；仅 ${p.development.branch} 的 ${p.development.file}；最多写入 ${p.development.max_writes} 次；验收器 ${p.development.validator}。确定仅授权此范围；实际执行仍须运行时门禁及运营方匹配绑定。不得提交、推送、发布或部署。`:'开发、提交、推送、发布、部署执行器均关闭',`有效期至：${new Date(v.expires).toISOString()}`,semantic?'请使用飞书“回复”这条方案消息，用自己的话说明决定，例如：确认、可以按这个做、不批准、先等等，或提出修改意见。也可 /yes。无需编号。':'请使用飞书“回复”这条方案消息，再输入“确定”（也可 /yes）。不需要填写编号。',semantic?'有条件同意不执行旧方案；修改意见会冻结旧方案，修订后须重新确认。疑问或不确定先澄清。裸发、转述、历史或编辑后的消息不算批准。':'拒绝：回复“不批准此方案”；撤销：回复“撤销此方案”。裸发、转述、历史或修改后的消息不算批准。','普通 DSH 工具审批另行处理；本消息不授予原生工具权限。'].join('\n');
}
export class ChatApproval {
 constructor(ledger,c,io={}){
  this.l=ledger;this.db=ledger.db;this.hostRole=c.hostRole==='local'?'local':'cloud';this.binding=chatBinding(c);this.bindingHash=digest(this.binding);this.source=io.source??new FeishuApprovalSource(c,io);this.now=ledger.now;this.closed=false;this.running=null;this.lastError=null;this.nextPoll=0;this.semantic=!!c.semantic?.enabled;this.classify=io.classify;this.abort=new AbortController();
  this.interval=c.pollIntervalMs??5000;if(!Number.isInteger(this.interval)||this.interval<1000||this.interval>60000)throw Error('INVALID_CHAT_POLL_INTERVAL');
  ledger.store.tx(()=>{
   if(this.db.prepare('SELECT disabled FROM approval_chat_bindings WHERE id=?').get(this.bindingHash)?.disabled)throw Error('CHAT_BINDING_REACTIVATION_REQUIRES_REVIEW');
   this.db.prepare('UPDATE approval_chat_bindings SET disabled=1 WHERE id<>?').run(this.bindingHash);
   this.db.prepare('INSERT INTO approval_chat_bindings(id,binding,disabled) VALUES (?,?,0) ON CONFLICT(id) DO UPDATE SET disabled=0').run(this.bindingHash,canonical(this.binding));
   // Interrupted interpretation is not permission to retry the model or release a previous approval.
   this.db.prepare("UPDATE approval_chat_evaluations SET state='needs_review',last_error='CHAT_SEMANTIC_INTERRUPTED' WHERE state='processing'").run();
   // Crash during provider submission is uncertain, not permission to send a second proposal.
   this.db.prepare("UPDATE approval_chat_deliveries SET state='needs_review',last_error='CHAT_SEND_RESULT_UNKNOWN' WHERE state='sending'").run();
   this.db.prepare("UPDATE approval_chat_deliveries SET state='needs_review',last_error='CHAT_PROPOSAL_VERSION_MISSING' WHERE state='sent' AND prompt_version IS NULL").run();
  });
  this.receipts=new ApprovalReceipts(ledger,this.bindingHash,this.source,this.binding);this.guidance=new ApprovalGuidance(this);
 }
 queue(request_id){
  const v=this.l.view(request_id);if(v.state!=='pending')return this.delivery(request_id);
  const text=renderChatProposal(v,this.semantic);if(Buffer.byteLength(text)>18000)throw Error('CHAT_PROPOSAL_TOO_LARGE');
  this.db.prepare("INSERT OR IGNORE INTO approval_chat_deliveries(request_id,binding_hash,uuid,text,state,created,semantics_version) VALUES (?,?,?,?,'queued',?,?)").run(request_id,this.bindingHash,randomUUID(),text,this.now(),this.semantic?SEMANTICS_VERSION:0);return this.delivery(request_id);
 }
 interpretationStatus(id){return this.db.prepare('SELECT state,created,last_error,interpretation FROM approval_chat_evaluations WHERE request_id=? ORDER BY created DESC LIMIT 20').all(id).map(({interpretation,...r})=>({...r,intent:interpretation?JSON.parse(interpretation).intent:null}));}
 delivery(id){const r=this.db.prepare('SELECT state,last_error,binding_hash,semantics_version FROM approval_chat_deliveries WHERE request_id=?').get(id);return r?{state:r.binding_hash===this.bindingHash?r.state:'needs_review',last_error:r.binding_hash===this.bindingHash?r.last_error:'CHAT_ROUTE_REVIEW_REQUIRED',receipts:this.receipts.status(id),reply_guidance:this.guidance.status(id),interpretations:this.interpretationStatus(id),provider:'feishu',kind:'proposal_delivery',confirmation_target:{host_role:this.hostRole,display_name:this.hostRole==='local'?'本地 IM 机器人':'云端 IM 机器人',platform:'feishu',conversation:'configured_private_chat'},proposal_title:approvalTitle(this.l.view(id).proposal),instruction:r.semantics_version?'回复标题含【DSH 方案确认】的原方案，不要回复【审批账本回执】；自然语言说明批准、拒绝、暂缓或修改意见（也可 /yes）':'回复具体方案消息：确定（或 /yes）',execution:this.l.view(id).execution}:null;}
 tick(){if(this.closed)return Promise.resolve();if(this.running)return this.running;this.running=(async()=>{await this.cycle();if(!this.closed)await this.receipts.cycle();if(!this.closed)await this.guidance.cycle();})().finally(()=>this.running=null);return this.running;}
 async cycle(){
  if(this.nextPoll>this.now())return;this.nextPoll=this.now()+this.interval;
  try{
   const rows=this.db.prepare("SELECT * FROM approval_chat_deliveries WHERE binding_hash=? AND state IN ('queued','sent') ORDER BY created LIMIT 100").all(this.bindingHash).filter(r=>{if(['pending','approved','held','clarification_required','confirmation_review'].includes(this.l.view(r.request_id).state))return true;this.db.prepare("UPDATE approval_chat_deliveries SET state='inactive' WHERE request_id=?").run(r.request_id);return false;});
   if(!rows.length){this.lastError=null;return;}
   await this.source.verifyBot();if(this.closed)return;
   for(const r of rows.filter(r=>r.state==='queued').slice(0,5)){
    if(this.closed)return;if(this.l.view(r.request_id).state!=='pending')continue;
    this.db.prepare("UPDATE approval_chat_deliveries SET state='sending' WHERE request_id=?").run(r.request_id);
    let messageId,version;try{
     messageId=await this.source.send(r.text,r.uuid);
     this.db.prepare('UPDATE approval_chat_deliveries SET message_id=? WHERE request_id=?').run(messageId,r.request_id);
     const p=await this.source.get(messageId);
     if(!this.validPrompt(p,r,messageId))throw Error('CHAT_PROPOSAL_CHANGED');version=promptVersion(p);
    }catch{this.db.prepare("UPDATE approval_chat_deliveries SET state='needs_review',last_error='CHAT_SEND_RESULT_UNKNOWN' WHERE request_id=?").run(r.request_id);continue;}
    this.db.prepare("UPDATE approval_chat_deliveries SET state='sent',message_id=?,prompt_version=?,last_error=NULL WHERE request_id=?").run(messageId,version,r.request_id);r.state='sent';r.message_id=messageId;r.prompt_version=version;
   }
   const sent=rows.filter(r=>r.state==='sent');if(!sent.length)return;
   const history=await this.source.list(Math.min(...sent.map(r=>r.created))-30000);if(this.closed)return;
   for(const m of history){
    if(this.closed)return;
    if(!chatAction(plain(m)))continue;
    const r=sent.find(r=>r.message_id===m.parent_id&&!r.semantics_version);if(!r)continue;
    if(this.db.prepare('SELECT 1 FROM approval_chat_proofs WHERE message_id=? AND binding_hash=?').get(m.message_id,this.bindingHash))continue;
    // Never trust a model, PeerMailbox or a caller-supplied event. Re-fetch BOTH objects from the provider.
    const reply=await this.source.get(m.message_id),prompt=await this.source.get(r.message_id);
    if(this.closed)return;
    if(!this.validPrompt(prompt,r,r.message_id)||promptVersion(prompt)!==r.prompt_version){this.db.prepare("UPDATE approval_chat_deliveries SET state='needs_review',last_error='CHAT_PROPOSAL_CHANGED' WHERE request_id=?").run(r.request_id);continue;}
    this.verifyAndRecord(r,reply,prompt);
   }
   await this.semanticCycle(sent.filter(r=>r.semantics_version===SEMANTICS_VERSION),history);
   if(!this.closed)await this.guidance.observe(history);
   this.lastError=null;
  }catch(e){if(['CHAT_BOT_CHANGED','CHAT_PRIVATE_ROUTE_REQUIRED'].includes(e.message))this.db.prepare('UPDATE approval_chat_bindings SET disabled=1 WHERE id=?').run(this.bindingHash);this.lastError=/^(CHAT_|APPROVAL_|TASK_|INVALID_PROVIDER_)[A-Z0-9_]+$/.test(e.message)?e.message:'CHAT_VERIFICATION_FAILED';}
 }
 validPrompt(m,r,id){const b=this.binding;return m?.message_id===id&&m.chat_id===b.chatId&&(m.chat_type===undefined||m.chat_type==='p2p')&&m.msg_type==='text'&&m.deleted===false&&typeof m.updated==='boolean'&&/^\d{13}$/.test(m.create_time??'')&&/^\d{13}$/.test(m.update_time??'')&&Number(m.update_time)>=Number(m.create_time)&&Number(m.create_time)>=r.created-30000&&Number(m.update_time)<=this.now()+30000&&m.sender?.sender_type==='app'&&m.sender.id_type==='app_id'&&m.sender.id===b.appId&&plain(m)===r.text;}
 verifiedSource(r,m,prompt){
  const b=this.binding,now=this.now();
  if(!original(m)||!this.validPrompt(prompt,r,r.message_id)||promptVersion(prompt)!==r.prompt_version||m.chat_id!==b.chatId||prompt.chat_id!==b.chatId||(m.chat_type!==undefined&&m.chat_type!=='p2p')||(prompt.chat_type!==undefined&&prompt.chat_type!=='p2p')||m.parent_id!==r.message_id||prompt.message_id!==r.message_id||
   m.sender?.sender_type!=='user'||m.sender.id_type!=='open_id'||m.sender.id!==b.approverOpenId||prompt.sender?.sender_type!=='app'||prompt.sender.id_type!=='app_id'||prompt.sender.id!==b.appId||
   plain(prompt)!==r.text||Number(prompt.create_time)<r.created-30000||Number(m.create_time)<=Number(prompt.update_time)||Number(m.create_time)>now+30000)return false;
  const v=this.l.view(r.request_id);if(Number(m.create_time)>v.expires)return false;
  return true;
 }
 verifyAndRecord(r,m,prompt,interpretation=null){
  const action=interpretation?.intent??chatAction(plain(m)),b=this.binding,now=this.now();
  if(!action||!this.verifiedSource(r,m,prompt))return false;
  const v=this.l.view(r.request_id);
  if(interpretation){if(!['pending','approved','held','clarification_required'].includes(this.l.validity(this.l.row(r.request_id),{ignoreInterpretation:true})))return false;}
  else if(action==='revoke'?v.recorded_state!=='approved':v.state!=='pending')return false;
  const proof={provider:'feishu',binding_hash:this.bindingHash,request_id:r.request_id,proposal_hash:v.proposal_hash,prompt_version:r.prompt_version,message_id:m.message_id,parent_id:m.parent_id,actor:b.approverOpenId,text:plain(m),created:m.create_time,verified:now,...(interpretation?{interpretation}: {})};
  return this.l.store.tx(()=>{
   const binding=this.db.prepare('SELECT disabled FROM approval_chat_bindings WHERE id=?').get(this.bindingHash);
   if(!binding||binding.disabled)throw Error('CHAT_BINDING_DISABLED');
   const d=this.db.prepare('SELECT * FROM approval_chat_deliveries WHERE request_id=?').get(r.request_id);
   if(d?.state!=='sent'||d.binding_hash!==this.bindingHash||d.message_id!==m.parent_id||d.text!==r.text||d.prompt_version!==r.prompt_version)throw Error('CHAT_DELIVERY_CHANGED');
   if(this.db.prepare('SELECT 1 FROM approval_chat_proofs WHERE binding_hash=? AND message_id=?').get(this.bindingHash,m.message_id))return false;
   if(interpretation){
    const e=this.db.prepare('SELECT state FROM approval_chat_evaluations WHERE binding_hash=? AND message_id=?').get(this.bindingHash,m.message_id);
    if(e?.state!=='processing')throw Error('CHAT_SEMANTIC_STATE_CHANGED');
    this.db.prepare("UPDATE approval_chat_evaluations SET state='recorded',interpretation=? WHERE binding_hash=? AND message_id=?").run(canonical(interpretation),this.bindingHash,m.message_id);
    this.db.prepare("UPDATE approval_chat_evaluations SET state='superseded' WHERE request_id=? AND state='needs_review' AND created<?").run(r.request_id,Number(m.create_time));
   }
   const challenge_id='chat-'+randomUUID(),proof_hash=digest(proof);
   this.db.prepare('INSERT INTO approval_chat_proofs VALUES (?,?,?,?,?,?)').run(challenge_id,this.bindingHash,m.message_id,proof_hash,canonical(proof),now);
   return this.l.recordDecision({request_id:r.request_id,action,principal:`feishu:${b.appId}:${b.approverOpenId}`,credential_id:'chat:'+this.bindingHash,proof_hash,challenge_id,chatEvaluation:!!interpretation});
  });
 }
 async semanticCycle(rows,history){
  if(!rows.length)return;
  const batch=[];
  for(const m of [...history].sort((a,b)=>Number(a.create_time)-Number(b.create_time)||a.message_id.localeCompare(b.message_id))){
   if(this.closed)return;
   const r=rows.find(r=>r.message_id===m.parent_id);if(!r||plain(m)===null)continue;
   if(this.db.prepare('SELECT 1 FROM approval_chat_evaluations WHERE binding_hash=? AND message_id=?').get(this.bindingHash,m.message_id))continue;
   const reply=await this.source.get(m.message_id),prompt=await this.source.get(r.message_id);
   if(this.closed||!this.verifiedSource(r,reply,prompt))continue;
   // Late older messages cannot override a later human decision. Same-timestamp ambiguity never grants approval.
   const last=this.db.prepare('SELECT MAX(created) at FROM approval_chat_evaluations WHERE request_id=?').get(r.request_id)?.at;
   if(last&&Number(reply.create_time)<last)continue;
   batch.push({r,reply,prompt,tiedToPrevious:last===Number(reply.create_time)});
  }
  // Persist ALL known replies before interpreting any of them. A later amendment already seen in
  // this batch must block a preceding "yes" even while a model call is in flight.
  this.l.store.tx(()=>{for(const {r,reply} of batch)this.db.prepare("INSERT OR IGNORE INTO approval_chat_evaluations(binding_hash,message_id,request_id,state,created) VALUES (?,?,?,'processing',?)").run(this.bindingHash,reply.message_id,r.request_id,Number(reply.create_time));});
  for(const {r,reply,prompt,tiedToPrevious} of batch){
   if(this.closed)return;
   const set=(state,error=null)=>this.db.prepare('UPDATE approval_chat_evaluations SET state=?,last_error=? WHERE binding_hash=? AND message_id=?').run(state,error,this.bindingHash,reply.message_id);
   const base=this.l.validity(this.l.row(r.request_id),{ignoreInterpretation:true});
   if(!['pending','approved','held','clarification_required'].includes(base)){set('obsolete');continue;}
   try{
    const interpretation=await interpretApproval(plain(reply),this.l.view(r.request_id).proposal,this.classify,this.abort.signal);
    // The user can edit/delete a message while interpretation is awaiting a response.
    const fresh=await this.source.get(reply.message_id),parent=await this.source.get(r.message_id);
    if(this.closed)return;
    if(canonical(fresh)!==canonical(reply)||!this.verifiedSource(r,fresh,parent)||promptVersion(parent)!==promptVersion(prompt)){set('needs_review','CHAT_SEMANTIC_SOURCE_CHANGED');continue;}
    const tied=tiedToPrevious||batch.filter(x=>x.r.request_id===r.request_id&&x.reply.create_time===reply.create_time).length>1;
    if(tied){interpretation.intent='clarify';interpretation.unconditional=false;interpretation.reason='同一时刻存在多条决定，请用一条完整回复说明最终意见。';}
    if(!this.verifyAndRecord(r,fresh,parent,interpretation))set('needs_review','CHAT_SEMANTIC_STATE_CHANGED');
   }catch{set('needs_review','CHAT_SEMANTIC_COMMIT_FAILED');}
  }
 }
 snapshot(){return {bindingEnabled:this.db.prepare('SELECT disabled FROM approval_chat_bindings WHERE id=?').get(this.bindingHash)?.disabled===0,provider:'feishu',mode:'official-api-observer',confirmation:this.semantic?'reply-bound-semantic':'reply-bound',receipts:'ledger-outbox',lastError:this.lastError,execution:'disabled'};}
 async close(){this.closed=true;this.abort.abort();this.receipts.close();this.guidance.close();await this.running;}
}
