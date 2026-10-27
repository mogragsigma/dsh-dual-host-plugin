import {canonical} from './approval-ledger.js';
import {randomUUID} from 'node:crypto';

const plain=m=>{try{return JSON.parse(m.body.content).text;}catch{return null;}};
const original=m=>m?.msg_type==='text'&&m.deleted===false&&m.updated===false&&/^\d{13}$/.test(m.create_time??'')&&m.update_time===m.create_time;
// Navigation only. Never calls the interpreter, creates proof or changes an approval.
export class ApprovalGuidance {
 constructor(chat){
  this.chat=chat;this.db=chat.db;this.source=chat.source;this.closed=false;
  this.db.exec(`CREATE TABLE IF NOT EXISTS approval_guidance_epoch(binding_hash TEXT PRIMARY KEY,created INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS approval_guidance(binding_hash TEXT NOT NULL,reply_id TEXT NOT NULL,request_id TEXT NOT NULL,target_id TEXT NOT NULL,uuid TEXT NOT NULL,state TEXT NOT NULL,created INTEGER NOT NULL,text TEXT,message_id TEXT,attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,last_error TEXT,PRIMARY KEY(binding_hash,reply_id));`);
  this.db.prepare('INSERT OR IGNORE INTO approval_guidance_epoch VALUES (?,?)').run(chat.bindingHash,chat.now());
  this.since=this.db.prepare('SELECT created FROM approval_guidance_epoch WHERE binding_hash=?').get(chat.bindingHash).created;
  this.db.prepare("UPDATE approval_guidance SET state=CASE WHEN message_id IS NULL THEN 'needs_review' ELSE 'verifying' END,last_error='CHAT_GUIDANCE_INTERRUPTED' WHERE state='sending'").run();
 }
 status(id){return this.db.prepare('SELECT state,last_error FROM approval_guidance WHERE request_id=? AND binding_hash=? ORDER BY created DESC LIMIT 5').all(id,this.chat.bindingHash);}
 enabled(){return !this.closed&&this.db.prepare('SELECT disabled FROM approval_chat_bindings WHERE id=?').get(this.chat.bindingHash)?.disabled===0;}
 async observe(history){
  let count=0;
  for(const m of history){
   if(!this.enabled()||count>=5)return;
   if(Number(m.create_time)<=this.since||!m.parent_id)continue;
   if(this.db.prepare('SELECT 1 FROM approval_guidance WHERE binding_hash=? AND reply_id=?').get(this.chat.bindingHash,m.message_id))continue;
   const r=this.db.prepare("SELECT * FROM approval_receipts WHERE message_id=? AND binding_hash=? AND state='sent'").get(m.parent_id,this.chat.bindingHash);
   if(!r)continue;
   const b=this.chat.binding,reply=await this.source.get(m.message_id),parent=await this.source.get(r.message_id);
   if(reply?.message_id!==m.message_id||!original(reply)||reply.sender?.sender_type!=='user'||reply.sender?.id_type!=='open_id'||reply.sender?.id!==b.approverOpenId||reply.chat_id!==b.chatId||(reply.chat_type!==undefined&&reply.chat_type!=='p2p')||reply.parent_id!==r.message_id||Number(reply.create_time)<=this.since||Number(reply.create_time)>this.chat.now()+30000||Number(reply.create_time)<=Number(parent?.update_time))continue;
   if(parent?.message_id!==r.message_id||parent.chat_id!==b.chatId||parent.msg_type!=='text'||parent.deleted!==false||parent.sender?.sender_type!=='app'||parent.sender?.id_type!=='app_id'||parent.sender?.id!==b.appId||plain(parent)!==r.text)continue;
   const d=this.db.prepare('SELECT * FROM approval_chat_deliveries WHERE request_id=? AND binding_hash=?').get(r.request_id,this.chat.bindingHash);
   if(!d?.message_id)continue;
   const prompt=await this.source.get(d.message_id);
   if(!this.chat.validPrompt(prompt,d,d.message_id)||d.prompt_version!==canonical({update_time:prompt.update_time,updated:prompt.updated}))continue;
   if(!this.enabled())return;
   this.db.prepare("INSERT OR IGNORE INTO approval_guidance(binding_hash,reply_id,request_id,target_id,uuid,state,created) VALUES (?,?,?,?,?,'queued',?)").run(this.chat.bindingHash,reply.message_id,r.request_id,d.message_id,randomUUID(),this.chat.now());count++;
  }
 }
 async cycle(){
  if(!this.enabled())return;
  const rows=this.db.prepare("SELECT * FROM approval_guidance WHERE binding_hash=? AND state IN ('queued','verifying') AND next_attempt<=? ORDER BY created LIMIT 5").all(this.chat.bindingHash,this.chat.now());
  for(const r of rows){
   if(!this.enabled())return;
   try{
    await this.source.verifyBot();if(!this.enabled())return;
    if(r.state==='queued'){
     const delivery=this.db.prepare('SELECT * FROM approval_chat_deliveries WHERE request_id=? AND binding_hash=?').get(r.request_id,r.binding_hash);
     const prompt=await this.source.get(r.target_id);
     if(!delivery||delivery.message_id!==r.target_id||!this.chat.validPrompt(prompt,delivery,r.target_id)||delivery.prompt_version!==canonical({update_time:prompt.update_time,updated:prompt.updated})){this.db.prepare("UPDATE approval_guidance SET state='needs_review',last_error='CHAT_PROPOSAL_CHANGED' WHERE binding_hash=? AND reply_id=?").run(r.binding_hash,r.reply_id);continue;}
     if(!this.enabled())return;
     const v=this.chat.l.view(r.request_id),active=['pending','approved','held','clarification_required'].includes(v.state);
     const text=['【DSH 操作提示 · 不是审批回执】','你回复的是“结果通知”，这条回复没有形成新的审批决定。',`任务：${v.title}（第 ${v.spec_revision} 版）`,active?'如要改变决定：点击本条上方引用，定位原方案；对原方案点“回复”，再用自己的话表达意见。':'原方案已失效或待核对，请先查询当前方案；不要重复批准旧方案。','不要回复这条提示；无需输入任务编号。本提示不批准、不启动、不恢复任何任务。'].join('\n');
     this.db.prepare("UPDATE approval_guidance SET state='sending',text=? WHERE binding_hash=? AND reply_id=?").run(text,r.binding_hash,r.reply_id);
     let id;
     try{id=await this.source.reply(r.target_id,text,r.uuid);}catch{this.db.prepare("UPDATE approval_guidance SET state='needs_review',last_error='CHAT_GUIDANCE_SEND_UNKNOWN' WHERE binding_hash=? AND reply_id=?").run(r.binding_hash,r.reply_id);continue;}
     this.db.prepare("UPDATE approval_guidance SET state='verifying',message_id=? WHERE binding_hash=? AND reply_id=?").run(id,r.binding_hash,r.reply_id);
     r.message_id=id;r.text=text;
    }
    if(!this.enabled())return;
    const m=await this.source.get(r.message_id),b=this.chat.binding;
    const valid=m?.message_id===r.message_id&&m.parent_id===r.target_id&&m.chat_id===b.chatId&&m.msg_type==='text'&&m.deleted===false&&m.sender?.sender_type==='app'&&m.sender?.id_type==='app_id'&&m.sender?.id===b.appId&&plain(m)===r.text;
    this.db.prepare('UPDATE approval_guidance SET state=?,last_error=? WHERE binding_hash=? AND reply_id=?').run(valid?'sent':'needs_review',valid?null:'CHAT_GUIDANCE_CONTENT_MISMATCH',r.binding_hash,r.reply_id);
   }catch{
    const n=r.attempts+1;
    this.db.prepare("UPDATE approval_guidance SET attempts=?,next_attempt=?,state=CASE WHEN ?>=8 THEN 'needs_review' ELSE state END,last_error='CHAT_GUIDANCE_PROVIDER_UNAVAILABLE' WHERE binding_hash=? AND reply_id=?").run(n,this.chat.now()+Math.min(300000,1000*2**n),n,r.binding_hash,r.reply_id);
   }
  }
 }
 close(){this.closed=true;}
}
