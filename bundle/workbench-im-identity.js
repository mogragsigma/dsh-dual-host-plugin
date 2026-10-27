import {randomUUID,randomBytes} from 'node:crypto';
import {canonical,digest} from './approval-ledger.js';
import {ruleInterpretation,approvalVeto} from './approval-semantics.js';
const plain=m=>{try{return JSON.parse(m.body.content).text;}catch{return null;}};
const version=m=>canonical({updated:m.updated,update_time:m.update_time});
// A ten-minute browser capability reuses the configured IM person. It is not a
// new account, a task approval, a DSH session, or an execution grant.
export class WorkbenchIMIdentity {
 constructor(ledger,getChat,{hold=()=>()=>{}}={}){this.l=ledger;this.db=ledger.db;this.chat=getChat;this.hold=hold;this.pending=new Map();this.closed=false;
  this.db.exec(`CREATE TABLE IF NOT EXISTS workbench_im_sessions(id TEXT PRIMARY KEY,client_hash TEXT NOT NULL,node TEXT NOT NULL,event_id TEXT NOT NULL,binding_hash TEXT NOT NULL,state TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL,text TEXT NOT NULL,message_id TEXT,prompt_version TEXT,reply_id TEXT,reply_json TEXT,verified_until INTEGER,UNIQUE(client_hash,event_id));`);
  this.db.prepare("UPDATE workbench_im_sessions SET state='needs_review' WHERE state='sending'").run();
 }
 key(node,key){if(!['local','cloud'].includes(node)||!(/^[a-f0-9]{64}$/).test(key??''))throw Error('APPROVAL_BROWSER_KEY_REQUIRED');return digest([node,key]);}
 binding(){const c=this.chat(),b=c&&this.db.prepare('SELECT * FROM approval_chat_bindings WHERE id=?').get(c.bindingHash);if(!c||c.closed||!b||b.disabled||b.binding!==canonical(c.binding)||digest(c.binding)!==c.bindingHash)throw Error('APPROVAL_IM_BINDING_REQUIRED');return c;}
 current(node,key){return this.db.prepare('SELECT * FROM workbench_im_sessions WHERE client_hash=? ORDER BY rowid DESC LIMIT 1').get(this.key(node,key));}
 state(r){if(!r)return 'identity_required';if(r.state==='active'&&r.verified_until<=this.l.now())return 'expired';if(['sent','sending'].includes(r.state)&&r.expires<=this.l.now())return 'expired';try{if(this.binding().bindingHash!==r.binding_hash)return 'binding_changed';}catch{return 'binding_changed';}return r.state;}
 view(node,key){const r=this.current(node,key),state=this.state(r);return {state,verified:state==='active',valid_until:state==='active'?r.verified_until:null,confirmation_code:r?.text.match(/窗口校验：([^\n]+)/)?.[1]??null,registration_required:false,scope:'this_browser_window_10_minutes',target:'existing_bound_im_private_chat',host_role:this.chat()?.hostRole??'cloud',message:state==='active'?'此窗口身份已核验；每份方案仍需你单独确认。':state==='needs_review'?'发送结果未知；仅核对原请求，不重新发送。':'使用已有 IM 私聊确认此窗口身份；不是批准任务。'};}
 async send(node,a){
  const c=this.binding();c.source.assertAvailable?.();const hash=this.key(node,a.client_key);if(!/^[a-zA-Z0-9-]{8,80}$/.test(a.event_id??''))throw Error('APPROVAL_EVENT_REQUIRED');
  const old=this.current(node,a.client_key);if(old&&['active','sent','sending','needs_review'].includes(this.state(old)))return this.view(node,a.client_key);
  if(this.db.prepare('SELECT 1 FROM workbench_im_sessions WHERE client_hash=? AND event_id=?').get(hash,a.event_id))return this.view(node,a.client_key);
  if(this.pending.size>=4)throw Error('APPROVAL_IDENTITY_BUSY');
  const id=randomUUID(),created=this.l.now(),text=['【DSH 工作台身份确认 · 不是任务批准】','仅在你刚从工作台发起、且窗口校验与工作台一致时确认；否则请拒绝。','窗口校验：'+randomBytes(3).toString('hex').toUpperCase(),`访问端：${node==='local'?'本地工作台':'云端工作台'}`,'回复本条“确认”或“同意”，允许这个工作台窗口在10分钟内使用你的既有身份记录你逐项确认的方案决定。','这不批准任何任务，也不开启开发、提交、推送、发布或部署。无需新账号或通行密钥。','窗口关闭／刷新后需重新核验；可在工作台结束本次身份使用。请勿回复结果通知。'].join('\n');
  const leave=this.hold();try{this.db.prepare("INSERT INTO workbench_im_sessions(id,client_hash,node,event_id,binding_hash,state,created,expires,text) VALUES (?,?,?,?,?,'sending',?,?,?)").run(id,hash,node,a.event_id,c.bindingHash,created,created+600000,text);}catch(e){leave();throw e;}
  const run=(async()=>{try{await c.source.verifyBot();if(this.closed)throw Error('CLOSED');const message=await c.source.send(text,id);this.db.prepare('UPDATE workbench_im_sessions SET message_id=? WHERE id=?').run(message,id);const p=await c.source.get(message),r=this.current(node,a.client_key);if(this.closed||r.id!==id||r.state!=='sending'||this.binding().bindingHash!==c.bindingHash||!c.validPrompt(p,{created,text},message))throw Error('SOURCE_CHANGED');this.db.prepare("UPDATE workbench_im_sessions SET state='sent',prompt_version=? WHERE id=? AND state='sending'").run(version(p),id);}catch{this.db.prepare("UPDATE workbench_im_sessions SET state='needs_review' WHERE id=? AND state='sending'").run(id);}finally{leave();}})();this.pending.set(id,run);run.finally(()=>this.pending.delete(id));return this.view(node,a.client_key);
 }
 validReply(r,m,p,c){return c.validPrompt(p,r,r.message_id)&&version(p)===r.prompt_version&&m?.chat_id===c.binding.chatId&&(m.chat_type===undefined||m.chat_type==='p2p')&&m.parent_id===r.message_id&&m.msg_type==='text'&&m.deleted===false&&m.updated===false&&/^\d{13}$/.test(m.create_time??'')&&m.update_time===m.create_time&&Number(m.create_time)>Number(p.update_time)&&Number(m.create_time)<=Math.min(this.l.now()+30000,r.expires)&&m.sender?.sender_type==='user'&&m.sender.id_type==='open_id'&&m.sender.id===c.binding.approverOpenId;}
 async check(node,key){const r=this.current(node,key),state=this.state(r);if(!r||!['sent','active','needs_review'].includes(state)||!r.message_id)return this.view(node,key);const c=this.binding();await c.source.verifyBot();
  const p=await c.source.get(r.message_id);if(!c.validPrompt(p,r,r.message_id)||version(p)!==r.prompt_version){this.db.prepare("UPDATE workbench_im_sessions SET state='needs_review' WHERE id=?").run(r.id);return this.view(node,key);}
  if(state==='active'){
   const m=await c.source.get(r.reply_id);let revoke=!this.validReply(r,m,p,c)||canonical(m)!==r.reply_json;
   const history=await c.source.list(Number(m?.create_time??r.created));
   for(const candidate of history)if(candidate.parent_id===r.message_id&&candidate.message_id!==r.reply_id&&Number(candidate.create_time)>=Number(m?.create_time??0)){
    const fresh=await c.source.get(candidate.message_id);if(this.validReply(r,fresh,p,c))revoke=true; // Any later statement requires a fresh identity confirmation, never silently renew.
   }
   if(revoke)this.db.prepare("UPDATE workbench_im_sessions SET state='revoked' WHERE id=?").run(r.id);return this.view(node,key);
  }
  // An uncertain send lacking its verified prompt version cannot be repaired by a guessed reply.
  if(state!=='sent')return this.view(node,key);
  const history=await c.source.list(r.created-30000),candidates=[];
  for(const m of history)if(m.parent_id===r.message_id){const actual=await c.source.get(m.message_id);if(this.validReply(r,actual,p,c))candidates.push(actual);}
  candidates.sort((a,b)=>Number(b.create_time)-Number(a.create_time));if(!candidates.length)return this.view(node,key);
  const m=candidates[0],i=ruleInterpretation(plain(m));const yes=i?.intent==='approve'&&!approvalVeto(plain(m))&&candidates.filter(x=>x.create_time===m.create_time).length===1;
  const fresh=await c.source.get(m.message_id),prompt=await c.source.get(r.message_id);
  if(this.closed||canonical(fresh)!==canonical(m)||!this.validReply(r,fresh,prompt,c)||this.binding().bindingHash!==r.binding_hash)throw Error('APPROVAL_IDENTITY_SOURCE_CHANGED');
  this.db.prepare("UPDATE workbench_im_sessions SET state=?,reply_id=?,reply_json=?,verified_until=? WHERE id=? AND state='sent'").run(yes?'active':'declined',m.message_id,canonical(m),yes?this.l.now()+600000:null,r.id);return this.view(node,key);
 }
 async authorize(node,key){await this.check(node,key);const r=this.current(node,key);if(this.state(r)!=='active')throw Error('APPROVAL_IDENTITY_REQUIRED');return r;}
 end(node,key){this.db.prepare("UPDATE workbench_im_sessions SET state='closed' WHERE client_hash=? AND state NOT IN ('closed','revoked','declined')").run(this.key(node,key));return this.view(node,key);}
 async close(){this.closed=true;await Promise.allSettled([...this.pending.values()]);}
}
