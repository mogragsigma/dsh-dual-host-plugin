import {NotificationMediaEndpoint} from './notification-media-endpoint.js';
// Same public Host service as the optional legacy delivery adapter. Never import an IM implementation.
import {targets,delivery,digest,json,outcome} from './notification-contract.js';
import {FeishuNotificationSender} from './notification-feishu.js';
import {bounded} from './recovery.js';
const known=new Set(['account-unverified','account-changed','target-changed','capability-unavailable','unknown-target','unknown-bot','bad-request']);
const retryable=new Set(['account-unverified','capability-unavailable']);
const safeCode=code=>'NOTIFICATION_'+code.replaceAll('-','_').toUpperCase();
export class NotificationEndpoint {
 constructor(g,config){
  this.g=g;this.db=g.db;this.targets=new Map(targets(config).filter(x=>x.host===g.c.role).map(x=>[x.key,x]));this.pending=new Map();this.closed=false;this.direct=new Map();
  const direct=g.c.notificationFeishu??[];if(!Array.isArray(direct)||direct.length>20)throw Error('NOTIFICATION_DIRECT_CONFIG_INVALID');
  for(const c of direct){if(!/^[-a-zA-Z0-9_]{1,64}$/.test(c.alias??'')||this.direct.has(c.alias))throw Error('NOTIFICATION_DIRECT_CONFIG_INVALID');this.direct.set(c.alias,new FeishuNotificationSender(c,{credentials:g.ctx.get?.('credentials'),...g.io?.notificationFeishu}));}
  this.db.exec(`CREATE TABLE IF NOT EXISTS notification_inbox(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,error TEXT,result TEXT,created INTEGER NOT NULL);`);
  // A persisted SDK intent with no result may have sent. Never replay on restart.
  this.media=new NotificationMediaEndpoint(this);
  this.db.prepare("UPDATE notification_inbox SET state='needs_review',error='NOTIFICATION_SEND_RESULT_UNKNOWN',result=? WHERE state='sending'").run(json({state:'needs_review',error:'NOTIFICATION_SEND_RESULT_UNKNOWN'}));
 }
 service(t){if(t?.route.transport==='feishu-openapi')return this.direct.get(t.alias)??null;try{return this.g.ctx.get('dshIm');}catch{return null;}}
 capabilities(t){const s=this.service(t);return {text_checked:s?.contractVersion===1&&typeof s.sendChecked==='function',files:t?.route.transport==='feishu-openapi'&&typeof s?.upload==='function',images:t?.route.transport==='feishu-openapi'&&typeof s?.upload==='function',read_receipts:false,source:t?.route.transport==='feishu-openapi'?'explicit-own-feishu-openapi':'public-same-host-contract',configured_targets:this.targets.size};}
 execute(input,authorize){
  if(this.closed||this.g.closed)throw Error('NOTIFICATION_CLOSED');const e=delivery(input),fp=digest(e),old=this.db.prepare('SELECT * FROM notification_inbox WHERE id=?').get(e.id);
  if(old&&old.fingerprint!==fp)throw Error('NOTIFICATION_DELIVERY_CONFLICT');
  if(old?.result)return Promise.resolve(JSON.parse(old.result));if(this.pending.has(e.id))return this.pending.get(e.id);
  this.db.prepare("INSERT OR IGNORE INTO notification_inbox(id,fingerprint,payload,state,created) VALUES (?,?,?,'pending',?)").run(e.id,fp,json(e),this.g.now());
  const p=Promise.resolve().then(()=>this.dispatch(e,authorize)).finally(()=>this.pending.delete(e.id));this.pending.set(e.id,p);return p;
 }
 finish(id,value){outcome(value);this.db.prepare('UPDATE notification_inbox SET state=?,error=?,result=? WHERE id=?').run(value.state,value.error??null,json(value),id);return value;}
 async dispatch(e,authorize){
  const row=this.db.prepare('SELECT * FROM notification_inbox WHERE id=?').get(e.id);if(row.result)return JSON.parse(row.result);
  if(row.next_at>this.g.now())return {state:'waiting',reason:'NOTIFICATION_BACKOFF',next_at:row.next_at};
  const t=this.targets.get(e.target_key);if(!t||t.route_hash!==e.route_hash)return this.finish(e.id,{state:'needs_review',error:'NOTIFICATION_ROUTE_CHANGED'});
  if(!this.capabilities(t).text_checked||t.route.receipt_mode==='message'&&this.service(t)?.receiptVersion!==1){this.db.prepare("UPDATE notification_inbox SET error='NOTIFICATION_CAPABILITY_UNAVAILABLE' WHERE id=?").run(e.id);return {state:'waiting',reason:'NOTIFICATION_CAPABILITY_UNAVAILABLE'};}
  // Coordinator acknowledgement may be lost; no SDK attempt has occurred at this point.
  const permit=await authorize({id:e.id,lease:e.lease});if(permit.allowed!==true)return this.finish(e.id,{state:'cancelled',error:'NOTIFICATION_AUTHORIZATION_ENDED'});
  if(this.closed||this.g.closed)return {state:'waiting',reason:'NOTIFICATION_CLOSED'};
  const claim=this.db.prepare("UPDATE notification_inbox SET state='sending',attempts=attempts+1,error=NULL WHERE id=? AND state='pending'").run(e.id);
  if(!claim.changes)return {state:'waiting',reason:'NOTIFICATION_IN_FLIGHT'};
  const controller=new AbortController(),s=this.service(t);let result;
  try{
   result=await bounded(Promise.resolve().then(()=>s.sendChecked(t.route.botId,t.route.targetId,e.text,{expectedFingerprint:t.route.expectedFingerprint,expectedTargetDigest:t.route.expectedTargetDigest,signal:controller.signal,format:'plain',...(t.route.transport==='feishu-openapi'?{idempotencyKey:digest({id:e.id,lease:e.lease}).slice(0,48)}:{}),receipt:t.route.receipt_mode==='message'})),this.g.retry.sendTimeoutMs,'NOTIFICATION_TIMEOUT');
   const r=result?.receipt;if(result?.sent!==true||t.route.receipt_mode==='message'&&(r?.version!==1||typeof r.messageId!=='string'||!r.messageId||r.messageId.length>512||r.conversationId!==t.route.conversationId))throw Error('NOTIFICATION_SEND_RESULT_UNKNOWN');
  }catch(err){
   controller.abort();const code=known.has(err?.code)?safeCode(err.code):'NOTIFICATION_SEND_RESULT_UNKNOWN';
   if(retryable.has(err?.code)&&row.attempts+1<this.g.retry.maxAttempts){
    const next=this.g.now()+Math.min(this.g.retry.maxMs,this.g.retry.baseMs*2**Math.min(row.attempts,15));this.db.prepare("UPDATE notification_inbox SET state='pending',error=?,next_at=? WHERE id=?").run(code,next,e.id);return {state:'waiting',reason:code,next_at:next};
   }
   return this.finish(e.id,{state:'needs_review',error:code});
  }
  // Do not classify a local persistence failure after SDK success as a safe retry.
  return this.finish(e.id,{state:'accepted',...(t.route.receipt_mode==='message'?{proof:'provider_message',message_id:result.receipt.messageId}:{proof:'sdk_accepted'})});
 }
 async close(){this.closed=true;await this.media.close();await Promise.allSettled([...this.pending.values()]);}
}
