import {randomUUID} from 'node:crypto';
import {text,digest,json} from './notification-contract.js';
import {validSources} from './task-context.js';
import {tx} from './recovery.js';
import {artifactSnapshot} from './artifact-media.js';
const metadata=x=>{const {bytes,...rest}=x;return rest;};
const pending=['media_queued','media_leased','media_dispatching'];
export class NotificationArtifacts {
 constructor(owner){
  this.owner=owner;this.g=owner.g;this.db=owner.db;this.reads=0;
  this.db.exec(`CREATE TABLE IF NOT EXISTS notification_artifact_requests(notification_id TEXT PRIMARY KEY,event_id TEXT UNIQUE NOT NULL,fingerprint TEXT NOT NULL,dedupe TEXT UNIQUE NOT NULL,record TEXT NOT NULL);`);
 }
 load(id){const r=this.db.prepare('SELECT record FROM notification_artifact_requests WHERE notification_id=?').get(id);if(!r)throw Error('NOTIFICATION_ARTIFACT_REQUEST_NOT_FOUND');return JSON.parse(r.record);}
 binding(task){return this.db.prepare('SELECT * FROM notification_bindings WHERE task_id=?').get(task);}
 check(r){const b=this.binding(r.task_id);if(!this.owner.valid(b)||b.revision!==r.binding_revision||b.target_key!==r.target_key||b.route_hash!==r.route_hash)throw Error('NOTIFICATION_AUTHORIZATION_ENDED');return b;}
 async snapshot(task,id,mode){
  if(this.reads>=4)throw Error('NOTIFICATION_MATERIALIZATION_BUSY');this.reads++;
  try{return await artifactSnapshot(this.g,task,id,mode);}finally{this.reads--;}
 }
 async enqueue(node,a){
  if(!a||Object.keys(a).some(k=>!['task_id','artifact_id','mode','expected_revision','expected_binding_revision','authorization_quote','sources','event_id'].includes(k))||!['local','cloud'].includes(node)||!text(a.event_id)||!text(a.task_id)||!text(a.artifact_id)||!['page','file','image'].includes(a.mode)||!Number.isInteger(a.expected_revision)||!Number.isInteger(a.expected_binding_revision)||!text(a.authorization_quote,2000))throw Error('NOTIFICATION_ARTIFACT_INVALID');
  const sources=validSources(a.sources);if(!sources.length||sources.some(s=>s.role!==node)||!sources.some(s=>s.text.includes(a.authorization_quote)))throw Error('NOTIFICATION_DIRECT_USER_REQUIRED');
  const fp=digest({node,...a,sources}),old=this.db.prepare('SELECT * FROM notification_artifact_requests WHERE event_id=?').get(a.event_id);
  if(old){if(old.fingerprint!==fp)throw Error('NOTIFICATION_EVENT_CONFLICT');return this.dto(old.notification_id);}
  const b=this.binding(a.task_id),target=b&&this.owner.config.get(b.target_key),artifact=this.g.artifacts.load(a.task_id,a.artifact_id);
  if(!this.owner.valid(b)||b.revision!==a.expected_binding_revision||b.task_revision!==a.expected_revision)throw Error('NOTIFICATION_REVISION_CONFLICT');
  if(target.route.transport!=='feishu-openapi')throw Error('NOTIFICATION_MEDIA_CAPABILITY_UNAVAILABLE');
  if(!a.authorization_quote.includes(target.label)||!a.authorization_quote.includes(artifact.name))throw Error('NOTIFICATION_ARTIFACT_NOT_AUTHORIZED');
  const r={task_id:a.task_id,binding_revision:b.revision,target_key:b.target_key,route_hash:b.route_hash,host:target.host};
  const snapshot=await this.snapshot(a.task_id,a.artifact_id,a.mode);this.check(r);
  const dedupe=digest({...r,artifact_id:a.artifact_id,mode:a.mode,sha256:snapshot.sha256});
  return tx(this.db,()=>{
   const concurrent=this.db.prepare('SELECT * FROM notification_artifact_requests WHERE event_id=?').get(a.event_id);if(concurrent){if(concurrent.fingerprint!==fp)throw Error('NOTIFICATION_EVENT_CONFLICT');return this.dto(concurrent.notification_id);}
   const duplicate=this.db.prepare('SELECT notification_id FROM notification_artifact_requests WHERE dedupe=?').get(dedupe);if(duplicate)return {...this.dto(duplicate.notification_id),already_requested:true};
   if(this.db.prepare("SELECT id,state FROM task_notifications WHERE task_id=? AND category='artifact' AND state IN ('media_queued','media_leased','media_dispatching','needs_review')").all(a.task_id).filter(r=>r.state!=='needs_review'||this.owner.review.latest(r.id)?.state!=='closed').length>=50)throw Error('NOTIFICATION_MEDIA_QUEUE_LIMIT');
   const id='notification-'+randomUUID(),created=this.g.now(),record={...r,artifact:metadata(snapshot),sources,authorization_quote:a.authorization_quote,created};
   const intro=['【DSH 成果交付 · 非审批】','任务：'+JSON.stringify(this.g.catalog.head(a.task_id).title),'成果：'+JSON.stringify(snapshot.name),'介绍：'+snapshot.description,snapshot.mode==='page'?'在 Gitee 查看（需你自己的仓库权限）：'+snapshot.url:'你已单独授权把这份成果上传到本会话。手机可点图片查看或点文件下载/打开；不需要连接 Mac。','这是成果快照，不授予开发或发布权限。'].join('\n');
   // Old consumers intentionally do not recognize media_* queue states, so rollback cannot emit a text substitute.
   this.db.prepare("INSERT INTO task_notifications(id,task_id,binding_revision,target_key,host,route_hash,category,text,state,due,created) VALUES (?,?,?,?,?,?,'artifact',?,'media_queued',?,?)").run(id,a.task_id,b.revision,b.target_key,target.host,b.route_hash,intro,created,created);
   this.db.prepare('INSERT INTO notification_artifact_requests VALUES (?,?,?,?,?)').run(id,a.event_id,fp,dedupe,json(record));return this.dto(id);
  });
 }
 dto(id){const r=this.load(id),d=this.db.prepare('SELECT id,state,message_id,error,created FROM task_notifications WHERE id=?').get(id);return {...d,task_id:r.task_id,artifact:r.artifact,target:this.owner.config.get(r.target_key)?.label??null,uploaded_or_sent:d.state==='accepted',no_automatic_resend:true};}
 pull(node){
  if(!['local','cloud'].includes(node))throw Error('NOTIFICATION_ROLE_DENIED');
  return tx(this.db,()=>{const items=[];for(const r of this.db.prepare("SELECT * FROM task_notifications WHERE host=? AND state IN ('media_queued','media_leased','media_dispatching') AND due<=? ORDER BY rowid LIMIT 2").all(node,this.g.now())){
   if(r.state!=='media_dispatching')try{this.check(r);}catch{this.db.prepare("UPDATE task_notifications SET state='cancelled',error='NOTIFICATION_AUTHORIZATION_ENDED' WHERE id=?").run(r.id);continue;}
   let payload=r.payload?JSON.parse(r.payload):null;if(!payload){payload={id:r.id,lease:randomUUID(),task_id:r.task_id,binding_revision:r.binding_revision,target_key:r.target_key,route_hash:r.route_hash,text:r.text,created:r.created,artifact:this.load(r.id).artifact};this.db.prepare("UPDATE task_notifications SET state='media_leased',lease=?,payload=? WHERE id=?").run(payload.lease,json(payload),r.id);}items.push(payload);
  }return {items};});
 }
 async materialize(node,a,validateOnly=false){
  const r=this.owner.row(node,a);if(!validateOnly&&typeof a.new_delivery!=='boolean')throw Error('NOTIFICATION_MEDIA_PAYLOAD_INVALID');if(!validateOnly&&a.new_delivery&&r.state==='media_dispatching')throw Error('NOTIFICATION_ENDPOINT_STATE_LOST');if(!pending.includes(r.state))throw Error('NOTIFICATION_MEDIA_NOT_PENDING');this.check(r);const request=this.load(r.id),original=request.artifact;
  const snapshot=await this.snapshot(r.task_id,original.artifact_id,original.mode);this.check(r);
  const fresh=this.owner.row(node,a);if(!pending.includes(fresh.state)||digest(metadata(snapshot))!==digest(original))throw Error('NOTIFICATION_ARTIFACT_CHANGED');
  this.db.prepare("UPDATE task_notifications SET state='media_dispatching',dispatched_at=coalesce(dispatched_at,?) WHERE id=?").run(this.g.now(),r.id);
  return validateOnly?{allowed:true}:{...metadata(snapshot),...(snapshot.bytes?{base64:snapshot.bytes.toString('base64')}:{})};
 }
 async access(a){
  if(!a||Object.keys(a).some(k=>!['task_id','notification_id'].includes(k)))throw Error('NOTIFICATION_ARTIFACT_INVALID');
  const request=this.load(a.notification_id),r=this.db.prepare('SELECT * FROM task_notifications WHERE id=? AND task_id=?').get(a.notification_id,a.task_id);
  if(!r||request.task_id!==a.task_id||r.state!=='accepted')throw Error('NOTIFICATION_ARTIFACT_NOT_ACCEPTED');
  // Access is read-only. Revoking future notifications does not retract an already uploaded snapshot.
  const snapshot=await this.snapshot(r.task_id,request.artifact.artifact_id,request.artifact.mode);if(digest(metadata(snapshot))!==digest(request.artifact))throw Error('NOTIFICATION_ARTIFACT_CHANGED');
  if(snapshot.mode==='page')return {kind:'gitee',url:snapshot.url,checked_at:this.g.now(),browser_login:'independent'};
  const entry=request.host===this.g.c.role?await this.owner.endpoint.media.access(r.id,r.task_id):{message_state:'needs_sender_host_check',sender_host:request.host};
  if(digest(metadata(await this.snapshot(r.task_id,request.artifact.artifact_id,request.artifact.mode)))!==digest(request.artifact))throw Error('NOTIFICATION_ARTIFACT_CHANGED');
  return {...entry,kind:'feishu_attachment',target:this.owner.config.get(r.target_key)?.label??'原授权会话',name:snapshot.name,message_id:r.message_id,checked_at:this.g.now(),access:'在飞书原授权会话点击此图片/文件；手机端由飞书账户与会话权限控制。',cannot_recall_uploaded_copy:true};
 }
 call(method,a,node){if(method==='notification_artifact_send')return this.enqueue(node,a);if(method==='notification_media_pull')return this.pull(node);if(method==='notification_media_materialize')return this.materialize(node,a);if(method==='notification_media_validate')return this.materialize(node,a,true);if(method==='notification_artifact_access')return this.access(a);throw Error('METHOD_DENIED');}
}
