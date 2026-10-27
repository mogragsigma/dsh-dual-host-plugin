import {delivery,digest,json,outcome} from './notification-contract.js';
import {bounded} from './recovery.js';
import {mediaHash,imageType} from './artifact-media.js';
const terminal=new Set(['accepted','needs_review','cancelled']);
const args=e=>({id:e.id,lease:e.lease});
function payload(input){
 const {artifact,...base}=input??{};delivery(base);
 if(!artifact||!['page','file','image'].includes(artifact.mode)||!(/^artifact-[a-f0-9]{40}$/.test(artifact.artifact_id??'')||artifact.mode==='page'&&/^artifact-delivery-[a-f0-9-]{36}$/.test(artifact.artifact_id??''))||!/^[a-f0-9]{64}$/.test(artifact.sha256??'')||!Number.isInteger(artifact.size)||artifact.size<0||artifact.size>1048576)throw Error('NOTIFICATION_MEDIA_PAYLOAD_INVALID');return input;
}
export class NotificationMediaEndpoint {
 constructor(endpoint){
  this.endpoint=endpoint;this.g=endpoint.g;this.db=endpoint.db;this.pending=new Map();this.closed=false;this.lastError=null;this.accesses=new Set();
  this.db.exec(`CREATE TABLE IF NOT EXISTS notification_media_inbox(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,payload TEXT NOT NULL,phase TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,uploaded_key TEXT,intro_message_id TEXT,result TEXT,error TEXT,created INTEGER NOT NULL);`);
  for(const row of this.db.prepare("SELECT id,phase FROM notification_media_inbox WHERE result IS NULL AND phase IN ('uploading','introducing','sending')").all())this.finish(row.id,{state:'needs_review',error:row.phase==='uploading'?'NOTIFICATION_UPLOAD_RESULT_UNKNOWN':'NOTIFICATION_SEND_RESULT_UNKNOWN'});
 }
 row(id){return this.db.prepare('SELECT * FROM notification_media_inbox WHERE id=?').get(id);}
 finish(id,r){outcome(r);const old=this.row(id);if(old?.result){if(old.result!==json(r))throw Error('NOTIFICATION_RECEIPT_CONFLICT');return JSON.parse(old.result);}this.db.prepare('UPDATE notification_media_inbox SET result=?,error=?,phase=CASE WHEN ?=\'accepted\' THEN \'accepted\' ELSE phase END WHERE id=?').run(json(r),r.error??null,r.state,id);return r;}
 execute(input){
  if(this.closed||this.g.closed)throw Error('NOTIFICATION_CLOSED');const e=payload(input),fp=digest(e),old=this.row(e.id);if(old&&old.fingerprint!==fp)throw Error('NOTIFICATION_DELIVERY_CONFLICT');if(old?.result)return Promise.resolve(JSON.parse(old.result));if(this.pending.has(e.id))return this.pending.get(e.id);if(old&&['uploading','introducing','sending','accepted'].includes(old.phase))return Promise.resolve(this.finish(e.id,{state:'needs_review',error:old.phase==='uploading'?'NOTIFICATION_UPLOAD_RESULT_UNKNOWN':'NOTIFICATION_SEND_RESULT_UNKNOWN'}));
  this.db.prepare("INSERT OR IGNORE INTO notification_media_inbox(id,fingerprint,payload,phase,created) VALUES (?,?,?,'prepared',?)").run(e.id,fp,json(e),this.g.now());
  const p=Promise.resolve().then(()=>this.dispatch(e)).finally(()=>this.pending.delete(e.id));this.pending.set(e.id,p);return p;
 }
 async dispatch(e){
  const target=this.endpoint.targets.get(e.target_key);if(!target||target.route_hash!==e.route_hash)return this.finish(e.id,{state:'needs_review',error:'NOTIFICATION_ROUTE_CHANGED'});
  const sender=this.endpoint.service(target);if(target.route.transport!=='feishu-openapi'||!sender?.upload||!sender?.sendMedia)return {state:'waiting',reason:'NOTIFICATION_MEDIA_CAPABILITY_UNAVAILABLE'};
  const controller=new AbortController(),options={expectedFingerprint:target.route.expectedFingerprint,expectedTargetDigest:target.route.expectedTargetDigest,format:'plain',receipt:true,signal:controller.signal};
  const run=fn=>bounded(Promise.resolve().then(fn),this.g.retry.sendTimeoutMs,'NOTIFICATION_TIMEOUT');
  const check=async()=>{if(this.closed||this.g.closed)throw Error('NOTIFICATION_CLOSED');const p=await this.g.call('notification_media_validate',args(e));controller.signal.throwIfAborted();if(p.allowed!==true)throw Error('NOTIFICATION_AUTHORIZATION_ENDED');};
  const newDelivery=this.row(e.id).attempts===0&&this.row(e.id).phase==='prepared';
  this.db.prepare('UPDATE notification_media_inbox SET attempts=attempts+1 WHERE id=?').run(e.id);
  let external=false,stage='preflight';
  try{
   const m=await this.g.call('notification_media_materialize',{...args(e),new_delivery:newDelivery}),{base64,...meta}=m;
   if(digest(meta)!==digest(e.artifact))throw Error('NOTIFICATION_ARTIFACT_CHANGED');
   if(m.mode!=='page'){
    if(typeof base64!=='string'||base64.length>1398104||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64))throw Error('NOTIFICATION_MEDIA_PAYLOAD_INVALID');m.bytes=Buffer.from(base64,'base64');
    if(m.bytes.length!==m.size||mediaHash(m.bytes)!==m.sha256)throw Error('NOTIFICATION_ARTIFACT_CHANGED');if(m.mode==='image'&&imageType(m.bytes)!==m.mime)throw Error('NOTIFICATION_MEDIA_PAYLOAD_INVALID');
   }
   const source=await run(()=>sender.prepare(target.route.botId,target.route.targetId,options));
   let saved=this.row(e.id);
   if(m.mode!=='page'&&!saved.uploaded_key){
    await check();stage='upload';this.db.prepare("UPDATE notification_media_inbox SET phase='uploading' WHERE id=?").run(e.id);external=true;
    const key=await run(()=>sender.upload(source,m));this.db.prepare("UPDATE notification_media_inbox SET phase='uploaded',uploaded_key=? WHERE id=?").run(key,e.id);external=false;
   }
   saved=this.row(e.id);
   if(m.mode==='file'&&!saved.intro_message_id){
    await check();stage='intro';this.db.prepare("UPDATE notification_media_inbox SET phase='introducing' WHERE id=?").run(e.id);external=true;
    const id=await run(()=>source.send(e.text+'\n附件将单独发送；本条介绍不是附件发送成功回执。',digest({id:e.id,lease:e.lease,part:'intro'}).slice(0,48)));
    this.db.prepare("UPDATE notification_media_inbox SET phase='introduced',intro_message_id=? WHERE id=?").run(id,e.id);external=false;
   }
   await check();stage='send';this.db.prepare("UPDATE notification_media_inbox SET phase='sending' WHERE id=?").run(e.id);external=true;
   const id=await run(()=>m.mode==='page'?source.send(e.text,digest({id:e.id,lease:e.lease,part:'page'}).slice(0,48)):sender.sendMedia(source,m,this.row(e.id).uploaded_key,e.text,digest({id:e.id,lease:e.lease,part:'attachment'}).slice(0,48)));
   return this.finish(e.id,{state:'accepted',proof:'provider_message',message_id:id});
  }catch(err){
   controller.abort();
   if(!external&&(err.code==='account-unverified'||/^(COORDINATOR_UNAVAILABLE|NOTIFICATION_MATERIALIZATION_BUSY|PROTOCOL_INSTANCE_CHANGED)$/.test(err.message))&&this.row(e.id).attempts<this.g.retry.maxAttempts)return {state:'waiting',reason:'NOTIFICATION_MEDIA_PREFLIGHT_WAIT'};
   // Never repeat a possibly completed mutation, including an upload or the file introduction.
   const error=external?(stage==='upload'?'NOTIFICATION_UPLOAD_RESULT_UNKNOWN':'NOTIFICATION_SEND_RESULT_UNKNOWN'):err.message==='NOTIFICATION_AUTHORIZATION_ENDED'?'NOTIFICATION_AUTHORIZATION_ENDED':err.code==='account-changed'||err.code==='target-changed'?'NOTIFICATION_ROUTE_CHANGED':/^NOTIFICATION_[A-Z_]+$/.test(err.message)?err.message:'NOTIFICATION_ARTIFACT_OR_PROVIDER_UNAVAILABLE';
   return this.finish(e.id,{state:error==='NOTIFICATION_AUTHORIZATION_ENDED'?'cancelled':'needs_review',error});
  }
 }
 access(id,task){
  if(this.closed||this.g.closed)throw Error('NOTIFICATION_CLOSED');if(this.accesses.size>=4)throw Error('NOTIFICATION_ACCESS_BUSY');
  const p=this.accessInner(id,task).finally(()=>this.accesses.delete(p));this.accesses.add(p);return p;
 }
 async accessInner(id,task){
  const row=this.row(id);if(!row?.result||JSON.parse(row.result).state!=='accepted')throw Error('NOTIFICATION_ARTIFACT_NOT_ACCEPTED');
  const e=JSON.parse(row.payload),r=JSON.parse(row.result),target=this.endpoint.targets.get(e.target_key);
  if(e.task_id!==task||!target||target.route_hash!==e.route_hash)throw Error('NOTIFICATION_ROUTE_CHANGED');
  const sender=this.endpoint.service(target);if(!sender?.prepare)throw Error('NOTIFICATION_MEDIA_CAPABILITY_UNAVAILABLE');
  const source=await sender.prepare(target.route.botId,target.route.targetId,{expectedFingerprint:target.route.expectedFingerprint,expectedTargetDigest:target.route.expectedTargetDigest,receipt:true,format:'plain'});
  const m=await source.get(r.message_id);
  if(m.chat_id!==target.route.conversationId||m.deleted)throw Error('NOTIFICATION_MEDIA_MESSAGE_UNAVAILABLE');
  let content;try{content=JSON.parse(m.body?.content);}catch{throw Error('NOTIFICATION_MEDIA_MESSAGE_UNAVAILABLE');}
  if(e.artifact.mode==='file'){
   if(m.msg_type!=='file'||content.file_name!==e.artifact.name)throw Error('NOTIFICATION_MEDIA_MESSAGE_UNAVAILABLE');
   await sender.verifyFile(source,r.message_id,content.file_key,e.artifact);
  }else{
   // The provider normalizes rich posts and may set updated=true without an external edit.
   const body=content.zh_cn??content,parts=Array.isArray(body.content)?body.content.flat():[],images=parts.filter(x=>x.tag==='img'),texts=parts.filter(x=>x.tag==='text');
   if(m.msg_type!=='post'||body.title!==e.artifact.name||parts.length!==images.length+texts.length||images.length!==1||images[0].image_key!==row.uploaded_key||texts.map(x=>x.text).join('')!==e.text)throw Error('NOTIFICATION_MEDIA_MESSAGE_UNAVAILABLE');
  }
  const chat=target.route.conversationId;if(!/^oc_[A-Za-z0-9_-]{4,128}$/.test(chat))throw Error('NOTIFICATION_ROUTE_CHANGED');
  const url=new URL('https://applink.feishu.cn/client/chat/open');url.searchParams.set('openChatId',chat);
  const pos=m.message_position;if(typeof pos==='number'&&Number.isSafeInteger(pos)&&pos>=0||typeof pos==='string'&&/^[0-9]{1,16}$/.test(pos))url.searchParams.set('position',String(pos));
  if(this.closed||this.g.closed)throw Error('NOTIFICATION_CLOSED');
  return {url:url.href,link_scope:url.searchParams.has('position')?'message_position':'conversation',message_state:'present_at_check',provider_checked_at:this.g.now(),recipient_access:'independent Feishu login and conversation permissions; not attested by bot'};
 }
 async tick(){
  if(this.closed||this.g.closed||![...this.endpoint.targets.values()].some(t=>t.route.transport==='feishu-openapi'))return;
  try{const batch=await this.g.call('notification_media_pull',{});for(const e of batch.items){if(this.closed||this.g.closed)break;const r=await this.execute(e);if(terminal.has(r.state))await this.g.call('notification_ack',{...args(e),result:r});else await this.g.call('notification_media_wait',{...args(e),reason:r.reason,retry_after_ms:30000,safe_before_send:false});}this.lastError=null;}catch(e){this.lastError=/^(NOTIFICATION_|CAPABILITY_|PROTOCOL_|COORDINATOR_)[A-Z_]+$/.test(e.message)?e.message:'NOTIFICATION_TRANSPORT_UNAVAILABLE';}
 }
 async close(){this.closed=true;await Promise.allSettled([...this.pending.values(),...this.accesses]);}
}
