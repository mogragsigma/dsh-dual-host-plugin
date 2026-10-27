import {verifyNotice,signedNotice} from './protocol.js';
import {hash} from './store.js';
import {outboxInsert,bounded} from './recovery.js';
import {randomUUID} from 'node:crypto';
// Optional migration adapter; no third-party imports or edits. Disabled unless explicitly configured.
export class LegacyFeishuAdapter {
 constructor(g){this.g=g;}
 status(){try{return this.g.ctx.get?.('im')?.getChannel?.('feishu')?.status??null;}catch{return {connected:false,error:'CHANNEL_UNAVAILABLE'};}}
 notice(task,id){return signedNotice(this.g.c,this.g.secrets.a2aKey,task,id,this.g.now());}
 receipt(row,status){
  const payload=JSON.parse(row.payload);if(!payload.source.startsWith('feishu-')||!row.id.startsWith('feishu:'))return;
  const mid=row.id.slice(7);
  const texts={accepted:`DSH 任务已登记：${row.task_id}（待执行调度，未开始开发）`,queued:`DSH 本端已排队：${mid}（尚未获得云端回执）`,needs_review:`DSH 消息待人工核对：${mid}（未确认受理，不会开始执行）`};
  // Preserve v0.3 successful receipts; only queue a final receipt if absent.
  const legacy=this.g.db.prepare('SELECT text FROM receipts WHERE id=?').get(mid);
  if(status==='accepted'&&legacy?.text.includes(row.task_id))return;
  if(status==='accepted')this.g.db.prepare("UPDATE receipts SET status='superseded' WHERE id=? AND status='queued'").run(mid+':queued');
  outboxInsert(this.g.db,'receipts',mid+':'+status,texts[status],this.g.now());
 }
 async receive(msg){
  if(this.g.closed)throw Error('GATEWAY_CLOSED');
  if(msg.platform!=='feishu'||msg.chatId!==this.g.c.chatId)throw Error('CHAT_DENIED');
  if(msg.senderType==='bot'){
   const b=verifyNotice(this.g.c,this.g.secrets.a2aKey,msg);const fp=hash(msg.text);
   const old=this.g.db.prepare('SELECT * FROM a2a WHERE id=?').get(b.id);
   if(old&&old.fingerprint!==fp)throw Error('A2A_ID_CONFLICT');
   if(!old){this.g.db.prepare('INSERT INTO a2a VALUES (?,?)').run(b.id,fp);this.g.trace('a2a-received',{event_id:b.id,task_id:b.task_id});}
   return {status:old?'duplicate':'notice-recorded'};
  }
  if(msg.senderType!=='user'||msg.userId!==this.g.c.ownerOpenId)throw Error('OWNER_DENIED');
  const text=msg.text.replace(/@_user_\d+/g,'').trim();
  // Only an authenticated human reaches control parsing; A2A returns above.
  if(/^\/(run|status|pause|resume|cancel|approve)(?:\s|$)/.test(text))return this.g.receiveControl(msg,text);
  const command=/^\/task\s+([a-z0-9-]{1,64})\s+([\s\S]+)$/.exec(text);
  if(!command||!command[2].trim()||command[2].length>12000){
   outboxInsert(this.g.db,'receipts',msg.msgId+':invalid-command','DSH 未登记：命令缺少或含有不合法参数。请 @ 本机器人后发送 /task <小写任务键> <任务内容>；例如 /task my-task 请在这里填写实际需求。',this.g.now());
   throw Error('INVALID_COMMAND');
  }
  const result=await this.g.submit({task_key:command[1],goal:command[2],source:'feishu-'+this.g.c.role,ingress_id:'feishu:'+msg.msgId});
  this.g.trace('feishu-intake',{message_id:msg.msgId,...result});
  return result;
 }
 async receiveControl(msg,text){
  const a=text.split(/\s+/),cmd=a.shift();let result;
  try{
   if(cmd==='/run'&&[3,4,5].includes(a.length)&&/^[a-z0-9-]{1,64}$/.test(a[0]))result=await this.g.call('schedule',{task_key:a[0],policy:{provider:a[1],model:a[2],...(a.length===5?{reasoningEffort:a[4]}:{})},delay_seconds:a.length>=4?Number(a[3]):0,trigger_id:'feishu:'+msg.msgId+':run'});
   else if(cmd==='/status'&&a.length===1)result=await this.g.call('inspect',{task_key:a[0]});
   else if(['/pause','/resume','/cancel'].includes(cmd)&&a.length===1)result=await this.g.call('job_control',{job_id:a[0],action:cmd.slice(1),event_id:'feishu:'+msg.msgId});
   else if(cmd==='/approve'&&a.length===2&&/^[a-f0-9]{64}$/.test(a[1])){
    if(this.g.c.role!=='cloud')throw Error('APPROVAL_CLOUD_ONLY');
    if(!this.g.scheduler)throw Error('SCHEDULER_UNAVAILABLE');
    result=this.g.scheduler.control({id:a[0],action:'approve',proposal_hash:a[1],event_id:'feishu:'+msg.msgId,actor:msg.userId});
   }else throw Error('INVALID_COMMAND');
  }catch(e){
   const codes=new Set(['APPROVAL_CLOUD_ONLY','APPROVAL_SCOPE_MISMATCH','INVALID_COMMAND','INVALID_JOB','INVALID_MODEL_POLICY','TASK_NOT_FOUND','JOB_NOT_FOUND','MODEL_POLICY_REQUIRED','CONTROL_NOT_ALLOWED','RESUME_NOT_ALLOWED','TRIGGER_CONFLICT','CONTROL_CONFLICT','NEEDS_REVIEW']);
   if(!codes.has(e.message))throw e;
   outboxInsert(this.g.db,'receipts',msg.msgId+':control-error','DSH 操作未生效：'+e.message+'。批准请 @云端机器人发送 /approve <job_id> <完整方案哈希>；运行规划用 /run <任务键> <provider> <model> [延迟秒数] [reasoningEffort]。',this.g.now());throw Error('INVALID_COMMAND');
  }
  outboxInsert(this.g.db,'receipts',msg.msgId+':control','DSH 持久任务状态：'+JSON.stringify(result).slice(0,14000),this.g.now());return result;
 }
 async sendPending(){const g=this.g;
  for(const table of ['receipts',...(g.c.sendNotices?['notices']:[])]){
   // A previous process may have died during an external send. Do not auto-resend.
   g.db.prepare(`UPDATE ${table} SET status='needs_review',last_error='SEND_OUTCOME_UNKNOWN',lease_until=NULL WHERE status='sending' AND lease_until<=?`).run(g.now());
   for(const row of g.db.prepare(`SELECT * FROM ${table} WHERE status='queued' AND next_attempt_at<=? ORDER BY next_attempt_at LIMIT 4`).all(g.now())){
    if(g.closed)return;
    if(table==='notices'&&g.now()-row.created>=300000){g.db.prepare("UPDATE notices SET status='expired' WHERE id=? AND status='queued'").run(row.id);continue;}
    let im,channel;try{im=g.ctx.get('im');channel=im?.getChannel?.('feishu');}catch{}
    if(!im?.push||!channel?.status?.connected){
     const attempts=row.attempts+1;
     g.db.prepare(`UPDATE ${table} SET attempts=?,next_attempt_at=?,last_error='CHANNEL_UNAVAILABLE',status=? WHERE id=? AND status='queued'`).run(attempts,g.now()+g.backoff(attempts),attempts>=g.retry.maxAttempts?'needs_review':'queued',row.id);continue;
    }
    const uuid=row.send_uuid??randomUUID();
    const claimed=g.db.prepare(`UPDATE ${table} SET status='sending',send_uuid=?,attempts=attempts+1,lease_until=? WHERE id=? AND status='queued'`).run(uuid,g.now()+g.retry.sendTimeoutMs+30000,row.id);
    if(claimed.changes!==1)continue;
    try{
     const result=await bounded(Promise.resolve().then(()=>im.push('feishu',g.c.chatId,{text:row.text,uuid})),g.retry.sendTimeoutMs,'SEND_TIMEOUT');
     if(typeof result?.messageId!=='string'||!result.messageId)throw Error('SEND_UNCONFIRMED');
     g.db.prepare(`UPDATE ${table} SET status='sent',message_id=?,last_error=NULL,lease_until=NULL WHERE id=? AND status='sending' AND send_uuid=?`).run(result.messageId,row.id,uuid);
     g.trace('outbox-sent',{kind:table,id:row.id,message_id:result.messageId});
    }catch{
     // An API timeout/error can occur after delivery. Quarantine, don't spam.
     g.db.prepare(`UPDATE ${table} SET status='needs_review',last_error='SEND_OUTCOME_UNKNOWN',lease_until=NULL WHERE id=? AND status='sending' AND send_uuid=?`).run(row.id,uuid);
     g.trace('outbox-needs-review',{kind:table,id:row.id});
    }
   }
  }
 }
}
