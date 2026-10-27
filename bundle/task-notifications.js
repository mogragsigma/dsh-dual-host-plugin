import {NotificationDefaults} from './notification-defaults.js';
import {NotificationArtifacts} from './notification-artifacts.js';
import {parseEnvelope} from './task-envelope.js';
import {randomUUID} from 'node:crypto';
import {targets,policy,digest,json,text,outcome} from './notification-contract.js';
import {NotificationReview} from './notification-review.js';
import {NotificationDiscovery} from './notification-discovery.js';
import {NotificationTargets} from './notification-targets.js';
import {NotificationEndpoint} from './notification-endpoint.js';
import {validSources} from './task-context.js';
import {tx} from './recovery.js';
const terminal=new Set(['accepted','needs_review','cancelled']);
const current=(db,id)=>db.prepare('SELECT * FROM notification_bindings WHERE task_id=?').get(id);
const humanEvent=(type,data)=>type==='failed'?['attention','本批次失败／待核对']:type==='checkpoint'?(data.status==='completed'?['result','本批次完成']:['waiting_approval','waiting_input','needs_review'].includes(data.status)?['attention','需要你处理']:['progress','批次检查点已保存']):({enqueued:['progress','执行已排队'],started:['progress','本批次开始'],pause:['progress','已请求暂停（不代表排空）'],resume:['progress','已请求恢复'],cancel:['result','已请求取消（不代表排空）']})[type];
export class TaskNotifications {
 constructor(g,config=[]){
  this.g=g;this.db=g.db;this.config=new Map(targets(config).map(t=>[t.key,t]));this.endpoint=new NotificationEndpoint(g,config);this.lastError=null;
  this.discovery=new NotificationDiscovery(g,()=>this.endpoint.service());this.registry=new NotificationTargets(this);this.defaults=new NotificationDefaults(this);
  if(!g.store)return;this.review=new NotificationReview(g);
  this.db.exec(`CREATE TABLE IF NOT EXISTS notification_tasks(task_id TEXT PRIMARY KEY,start_seq INTEGER NOT NULL,created INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS notification_bindings(task_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,task_revision INTEGER NOT NULL,target_key TEXT,route_hash TEXT,policy TEXT,state TEXT NOT NULL,source TEXT NOT NULL,created INTEGER NOT NULL,start_seq INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS notification_binding_events(event_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS task_notification_events(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,category TEXT NOT NULL,at INTEGER NOT NULL,disposition TEXT NOT NULL,delivery_id TEXT);
   CREATE TABLE IF NOT EXISTS task_notifications(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,binding_revision INTEGER NOT NULL,target_key TEXT NOT NULL,host TEXT NOT NULL,route_hash TEXT NOT NULL,category TEXT NOT NULL,text TEXT NOT NULL,state TEXT NOT NULL,due INTEGER NOT NULL,created INTEGER NOT NULL,lease TEXT,payload TEXT,result TEXT,message_id TEXT,error TEXT);
   CREATE TABLE IF NOT EXISTS notification_meta(singleton INTEGER PRIMARY KEY,cursor INTEGER NOT NULL);`);
  if(!this.db.prepare('PRAGMA table_info(task_notifications)').all().some(c=>c.name==='dispatched_at'))this.db.exec('ALTER TABLE task_notifications ADD COLUMN dispatched_at INTEGER');
  this.media=new NotificationArtifacts(this);
  this.db.prepare('INSERT OR IGNORE INTO notification_meta VALUES (1,?)').run(g.scheduler?.jobs.db.prepare('SELECT coalesce(max(seq),0) n FROM job_events').get().n??0);
 }
 track(task){if(!this.g.store)return;const inserted=this.db.prepare('INSERT OR IGNORE INTO notification_tasks VALUES (?,?,?)').run(task,this.g.scheduler?.jobs.db.prepare('SELECT coalesce(max(seq),0) n FROM job_events').get().n??0,this.g.now());if(inserted.changes)this.defaults.capture(task);}
 ownsLegacyNotice(id){
  if(!this.g.scheduler)return false;const run=/^job-(?:result|failed):(.+)$/.exec(id)?.[1];if(!run)return false;
  const j=this.g.scheduler.jobs.db.prepare('SELECT j.task_id FROM runs r JOIN jobs j ON j.id=r.job_id WHERE r.id=?').get(run);
  const track=j&&this.db.prepare('SELECT * FROM notification_tasks WHERE task_id=?').get(j.task_id);
  return !!track&&!!this.g.scheduler.jobs.db.prepare("SELECT 1 FROM job_events WHERE seq>? AND json_extract(data,'$.run_id')=? AND type IN ('checkpoint','failed')").get(track.start_seq,run);
 }
 inventory(){return {items:[...this.config.values()].map(t=>({key:t.key,label:t.label,host:t.host,route_hash:t.route_hash,configured:true,publication:this.registry.publication(t.key),receipt_mode:t.route.receipt_mode,capability:t.host===this.g.c.role?this.endpoint.capabilities(t):{text_checked:'requires_peer_validation',files:false,images:false},consent:false})),historical_delivery:'unchanged unless explicitly adopted',no_default_recipient:!this.defaults.current()?.enabled,default_policy:this.defaults.view()};}
 valid(b){
  const t=b&&this.config.get(b.target_key);return !!b&&b.state==='enabled'&&this.defaults.valid(b)&&t?.route_hash===b.route_hash&&this.g.catalog.head(b.task_id).spec_revision===b.task_revision;
 }
 bind(node,a){
  if(!a||!['local','cloud'].includes(node)||!text(a.event_id)||!text(a.task_id)||!Number.isInteger(a.expected_revision)||!Number.isInteger(a.expected_binding_revision)||a.expected_binding_revision<0||!['set','disable'].includes(a.action))throw Error('NOTIFICATION_BINDING_INVALID');
  const sources=validSources(a.sources);if(!sources.length||sources.some(s=>s.role!==node)||!text(a.authorization_quote,2000)||!sources.some(s=>s.text.includes(a.authorization_quote)))throw Error('NOTIFICATION_DIRECT_USER_REQUIRED');
  const target=a.action==='set'?this.config.get(a.target_key):null;if(a.action==='set'&&(!target||!a.authorization_quote.includes(target.label)))throw Error('NOTIFICATION_TARGET_NOT_AUTHORIZED');
  const p=a.action==='set'?policy(a.policy):null,fp=digest({node,...a,sources,policy:p});
  return tx(this.db,()=>{
   const old=this.db.prepare('SELECT * FROM notification_binding_events WHERE event_id=?').get(a.event_id);if(old){if(old.fingerprint!==fp)throw Error('NOTIFICATION_EVENT_CONFLICT');return JSON.parse(old.result);}
   const h=this.g.catalog.head(a.task_id),b=current(this.db,a.task_id);if(parseEnvelope(h.goal)?.notification_contract!==1)throw Error('NOTIFICATION_TASK_UPGRADE_REQUIRED');if(h.legacy||h.spec_revision!==a.expected_revision||(b?.revision??0)!==a.expected_binding_revision)throw Error('NOTIFICATION_REVISION_CONFLICT');
   // A new task can explicitly opt out before its scheduled default is inherited.
   this.track(a.task_id);const revision=(b?.revision??0)+1;
   this.db.prepare('INSERT OR REPLACE INTO notification_bindings VALUES (?,?,?,?,?,?,?,?,?,?)').run(a.task_id,revision,h.spec_revision,target?.key??null,target?.route_hash??null,p?json(p):null,a.action==='set'?'enabled':'disabled',json({node,sources,authorization_quote:a.authorization_quote}),this.g.now(),this.g.scheduler?.jobs.db.prepare('SELECT coalesce(max(seq),0) n FROM job_events').get().n??0);
   this.db.prepare("UPDATE task_notifications SET state='cancelled',error='NOTIFICATION_AUTHORIZATION_ENDED' WHERE task_id=? AND state IN ('queued','leased')").run(a.task_id);
   const result={task_id:a.task_id,binding_revision:revision,state:a.action==='set'?'enabled':'disabled',target:target?{key:target.key,label:target.label,host:target.host,receipt_mode:target.route.receipt_mode}:null,policy:p,applies_to:'future events only',inflight_cannot_be_recalled:true};
   this.db.prepare('INSERT INTO notification_binding_events VALUES (?,?,?)').run(a.event_id,fp,json(result));return result;
  });
 }
 render(job,event,label){
  const h=this.g.catalog.head(job.task_id),data=JSON.parse(event.data),p=JSON.parse(job.policy),artifacts=this.g.artifacts?.list(job.task_id).items.filter(a=>a.run_id===(data.run_id??null)).slice(0,3)??[];
  return ['【DSH 任务通知 · 状态快照】','任务：'+JSON.stringify(h.title),label,'记录时间：'+new Date(event.at).toISOString(),`任务指定模型：${p.provider??'未指定'} / ${p.model??'未指定'}${p.reasoningEffort?' / '+p.reasoningEffort:''}`,data.summary?'结果摘要：'+JSON.stringify(data.summary.slice(0,1200)):null,data.question?(event.type==='failed'?'需要你的决定：':'待补充：')+JSON.stringify(data.question.slice(0,700)):null,data.code?'错误：'+(/^[A-Z_]{1,90}$/.test(data.code)?data.code:'WORKER_FAILED'):null,data.code==='WORKER_MODEL_OUTPUT_LIMIT'?'原因：本次模型输出额度已耗尽（含思考）；本批次未完成，已停止且未自动重试、增加预算或更换模型。':null,...artifacts.map(a=>'成果介绍：'+JSON.stringify({name:a.name,introduction:a.description??'暂无介绍',state:a.state})),artifacts.length?'成果入口：在本项目工作台按任务名称查看 Gitee 页面或执行会话；本条暂未提供手机可访问链接。':null,'这是批次／任务状态通知，不是审批凭据，不表示整个长期目标已完成；平台接受也不代表你已阅读。'].filter(Boolean).join('\n').slice(0,8000);
 }
 collect(){
  if(!this.g.scheduler)return;const jobs=this.g.scheduler.jobs.db,cursor=this.db.prepare('SELECT cursor FROM notification_meta WHERE singleton=1').get().cursor;
  for(const e of jobs.prepare('SELECT * FROM job_events WHERE seq>? ORDER BY seq LIMIT 100').all(cursor)){
   const job=this.g.scheduler.jobs.get(e.job_id),track=this.db.prepare('SELECT * FROM notification_tasks WHERE task_id=?').get(job.task_id),parts=humanEvent(e.type,JSON.parse(e.data));
   tx(this.db,()=>{
    if(track&&e.seq>track.start_seq&&parts){
     const [category,label]=parts,b=current(this.db,job.task_id),id='notification-event-'+e.seq;let disposition='no_authorized_target',deliveryId=null;
     if(this.valid(b)&&e.seq>b.start_seq&&JSON.parse(b.policy).events.includes(category)){
      const n=this.db.prepare("SELECT count(*) n FROM task_notifications n WHERE task_id=? AND (state IN ('queued','leased','dispatching') OR state='needs_review' AND coalesce((SELECT json_extract(record,'$.state') FROM notification_reviews WHERE notification_id=n.id ORDER BY revision DESC LIMIT 1),'open')<>'closed')").get(job.task_id).n;
      if(n>=200)disposition='queue_limit';else{
       this.db.prepare("UPDATE task_notifications SET state='cancelled',error='NOTIFICATION_SUPERSEDED_SNAPSHOT' WHERE task_id=? AND binding_revision=? AND category='progress' AND state IN ('queued','leased')").run(job.task_id,b.revision);
       let due=this.g.now();if(category==='progress'){const last=this.db.prepare("SELECT max(dispatched_at) n FROM task_notifications WHERE task_id=? AND binding_revision=? AND category='progress' AND state IN ('accepted','dispatching')").get(job.task_id,b.revision).n;if(last!=null)due=Math.max(due,last+JSON.parse(b.policy).progress_interval_seconds*1000);}
       deliveryId='notification-'+randomUUID();const target=this.config.get(b.target_key);
       this.db.prepare("INSERT INTO task_notifications(id,task_id,binding_revision,target_key,host,route_hash,category,text,state,due,created) VALUES (?,?,?,?,?,?,?,?,'queued',?,?)").run(deliveryId,job.task_id,b.revision,b.target_key,target.host,b.route_hash,category,this.render(job,e,label),due,this.g.now());disposition='queued';
      }
     }else if(b)disposition=this.valid(b)?(e.seq<=b.start_seq?'before_authorization':'event_not_selected'):'authorization_stale_or_disabled';
     this.db.prepare('INSERT OR IGNORE INTO task_notification_events VALUES (?,?,?,?,?,?)').run(id,job.task_id,category,e.at,disposition,deliveryId);
    }
    this.db.prepare('UPDATE notification_meta SET cursor=? WHERE singleton=1').run(e.seq);
   });
  }
 }
 lease(node){
  if(!['local','cloud'].includes(node))throw Error('NOTIFICATION_ROLE_DENIED');
  return tx(this.db,()=>{
   const items=[];for(const r of this.db.prepare("SELECT * FROM task_notifications WHERE host=? AND state IN ('queued','leased','dispatching') AND due<=? ORDER BY rowid LIMIT 10").all(node,this.g.now())){
    const b=current(this.db,r.task_id);if(r.state!=='dispatching'&&(!this.valid(b)||b.revision!==r.binding_revision)){this.db.prepare("UPDATE task_notifications SET state='cancelled',error='NOTIFICATION_AUTHORIZATION_ENDED' WHERE id=?").run(r.id);continue;}
    if(r.category==='progress'&&r.state!=='dispatching'){
     const last=this.db.prepare("SELECT max(dispatched_at) n FROM task_notifications WHERE task_id=? AND binding_revision=? AND category='progress' AND state IN ('accepted','dispatching') AND id<>?").get(r.task_id,r.binding_revision,r.id).n;
     if(last!=null){const due=Math.max(r.due,last+JSON.parse(b.policy).progress_interval_seconds*1000);if(due>this.g.now()){this.db.prepare('UPDATE task_notifications SET due=? WHERE id=?').run(due,r.id);continue;}}
    }
    let payload=r.payload?JSON.parse(r.payload):null;if(!payload){payload={id:r.id,lease:randomUUID(),task_id:r.task_id,binding_revision:r.binding_revision,target_key:r.target_key,route_hash:r.route_hash,text:r.text,created:r.created};this.db.prepare("UPDATE task_notifications SET state='leased',lease=?,payload=? WHERE id=?").run(payload.lease,json(payload),r.id);}
    items.push(payload);
   }return {items};
  });
 }
 row(node,a){const r=this.db.prepare('SELECT * FROM task_notifications WHERE id=?').get(a.id);if(!r||r.host!==node||r.lease!==a.lease||!r.lease)throw Error('NOTIFICATION_LEASE_MISMATCH');return r;}
 authorize(node,a){
  return tx(this.db,()=>{const r=this.row(node,a),b=current(this.db,r.task_id);if(!['leased','dispatching'].includes(r.state)||!this.valid(b)||b.revision!==r.binding_revision)return {allowed:false};this.db.prepare("UPDATE task_notifications SET state='dispatching',dispatched_at=coalesce(dispatched_at,?) WHERE id=?").run(this.g.now(),r.id);return {allowed:true,meaning:'dispatch boundary; later revocation cannot recall an external send'};});
 }
 waiting(node,a,media=false){
  if(!/^NOTIFICATION_[A-Z_]{1,80}$/.test(a.reason??'')||!Number.isSafeInteger(a.retry_after_ms)||a.retry_after_ms<1000||a.retry_after_ms>300000||typeof a.safe_before_send!=='boolean')throw Error('NOTIFICATION_RECEIPT_INVALID');
  const r=this.row(node,a);if((r.category==='artifact')!==media)throw Error('NOTIFICATION_RECEIPT_INVALID');if(r.result||terminal.has(r.state))return {recorded:false};
  this.db.prepare('UPDATE task_notifications SET state=?,error=?,due=?,dispatched_at=? WHERE id=?').run(a.safe_before_send?'leased':r.state,a.reason,this.g.now()+a.retry_after_ms,a.safe_before_send?null:r.dispatched_at,r.id);return {recorded:true};
 }
 ack(node,a){
  const value=outcome(a.result);return tx(this.db,()=>{const r=this.row(node,a);if(r.result){if(r.result!==json(value))throw Error('NOTIFICATION_RECEIPT_CONFLICT');return {recorded:true};}
   if(value.state==='accepted'&&!['dispatching','media_dispatching'].includes(r.state))throw Error('NOTIFICATION_DISPATCH_REQUIRED');
   this.db.prepare('UPDATE task_notifications SET state=?,result=?,message_id=?,error=? WHERE id=?').run(value.state,json(value),value.message_id??null,value.error??null,r.id);return {recorded:true};});
 }
 status(task){
  this.g.store.task(task);const b=current(this.db,task);return {task_id:task,managed:!!this.db.prepare('SELECT 1 FROM notification_tasks WHERE task_id=?').get(task),binding:b?{source:JSON.parse(b.source).kind==='onboarding_default'?'onboarding_default':'explicit_task',revision:b.revision,task_revision:b.task_revision,state:b.state,effective:this.valid(b),target:this.config.get(b.target_key)?{key:b.target_key,label:this.config.get(b.target_key).label,host:this.config.get(b.target_key).host}:null,policy:b.policy?JSON.parse(b.policy):null}:null,deliveries:this.db.prepare('SELECT id,category,state,host,created,due,message_id,error,result FROM task_notifications WHERE task_id=? ORDER BY rowid DESC LIMIT 20').all(task).map(({result,...r})=>({...r,...(r.category==='artifact'?{artifact_delivery:this.media.dto(r.id)}:{}),review:this.review.summary(r.id),proof:result?JSON.parse(result).proof??null:null,waiting_reason:r.error??(['queued','media_queued'].includes(r.state)?(r.host==='local'?'NOTIFICATION_AWAITING_LOCAL_ENDPOINT':'NOTIFICATION_AWAITING_CLOUD_ENDPOINT'):['leased','media_leased'].includes(r.state)?'NOTIFICATION_ENDPOINT_PROCESSING':['dispatching','media_dispatching'].includes(r.state)?'NOTIFICATION_WAITING_FOR_RECEIPT':null)})),events:this.db.prepare('SELECT category,at,disposition FROM task_notification_events WHERE task_id=? ORDER BY rowid DESC LIMIT 10').all(task),meaning:'platform acceptance is not read receipt or execution approval'};
 }
 call(method,a,node){if(method==='notification_default_peer_discover'||method==='notification_default_peer_candidate')return this.defaults.inspectPeer(node,a,method==='notification_default_peer_candidate');if(method==='notification_default_publish')return this.defaults.publish(node,a);if(method==='notification_default_status')return this.defaults.view();if(method==='notification_media_wait'){if(a.safe_before_send!==false)throw Error('NOTIFICATION_RECEIPT_INVALID');return this.waiting(node,a,true);}if(method.startsWith('notification_media_')||method.startsWith('notification_artifact_'))return this.media.call(method,a,node);if(method==='notification_reconcile')return this.review.record(node,a);if(method==='notification_discover'){if(!a||Object.keys(a).some(k=>k!=='host')||a.host!==this.g.c.role)throw Error('NOTIFICATION_DISCOVERY_WRONG_HOST');return this.discovery.inspect();}if(method==='notification_target_add')return this.registry.add(node,a);if(method==='notification_target_publish')return this.registry.receive(node,a);if(method==='notification_targets')return this.inventory();if(method==='notification_bind')return this.bind(node,a);if(method==='notification_status')return this.status(a.task_id);if(method==='notification_pull')return this.lease(node);if(method==='notification_validate')return this.authorize(node,a);if(method==='notification_ack')return this.ack(node,a);if(method==='notification_wait')return this.waiting(node,a);throw Error('METHOD_DENIED');}
 async artifactAccess(a){return this.g.maintenance?this.g.maintenance.run('notification_access',()=>this.artifactAccessCore(a)):this.artifactAccessCore(a);}
 async artifactAccessCore(a){const r=await this.g.call('notification_artifact_access',a);return r.message_state==='needs_sender_host_check'&&r.sender_host===this.g.c.role?{...r,...await this.endpoint.media.access(a.notification_id,a.task_id)}:r;}
 async tick(){
  if(this.g.closed||this.g.maintenance?.blocked)return;
  try{
   await this.defaultSource?.();
   await this.registry.sync();
   if(this.g.store)this.collect();
   // Avoid unrelated RPC traffic unless this endpoint is explicitly configured for notification delivery.
   if(!this.endpoint.targets.size)return;
   const batch=await this.g.call('notification_pull',{});
   for(const e of batch.items){if(this.g.closed)break;const result=await this.endpoint.execute(e,a=>this.g.call('notification_validate',a));if(terminal.has(result.state))await this.g.call('notification_ack',{id:e.id,lease:e.lease,result});else if(result.state==='waiting')await this.g.call('notification_wait',{id:e.id,lease:e.lease,reason:result.reason,retry_after_ms:Math.max(1000,Math.min(300000,(result.next_at??this.g.now()+10000)-this.g.now())),safe_before_send:result.reason!=='NOTIFICATION_IN_FLIGHT'});}
   await this.endpoint.media.tick();
   this.lastError=this.endpoint.media.lastError;
  }catch(e){this.lastError=/^(NOTIFICATION_|CAPABILITY_|PROTOCOL_|COORDINATOR_)[A-Z_]+$/.test(e.message)?e.message:'NOTIFICATION_TRANSPORT_UNAVAILABLE';}
 }
 async close(){await this.endpoint.close();}
}
