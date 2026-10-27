// A default is a separate setup consent, never fabricated chat provenance.
import {targets,digest,json} from './notification-contract.js';
import {tx} from './recovery.js';
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join()===keys.slice().sort().join();
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
export function defaultPolicy(p){
 if(!exact(p,['contract','owner','revision','operation','enabled','definition','approvedAt'])||p.contract!==1||!uuid(p.owner)||!uuid(p.operation)||!Number.isSafeInteger(p.revision)||p.revision<1||typeof p.enabled!=='boolean'||!Number.isSafeInteger(p.approvedAt)||p.approvedAt<0)throw Error('NOTIFICATION_DEFAULT_INVALID');
 if(p.enabled){const t=targets([p.definition])[0];if(!['local','cloud'].includes(t.host)||!t.alias.startsWith('discovered-')||t.route.transport)throw Error('NOTIFICATION_DEFAULT_INVALID');}
 else if(p.definition!==null)throw Error('NOTIFICATION_DEFAULT_INVALID');
 return p;
}
export class NotificationDefaults {
 constructor(owner){
  this.owner=owner;this.g=owner.g;this.db=owner.db;
  this.db.exec(`CREATE TABLE IF NOT EXISTS notification_default_policy(singleton INTEGER PRIMARY KEY,body TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS notification_default_history(owner TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,received INTEGER NOT NULL,PRIMARY KEY(owner,revision));
   CREATE TABLE IF NOT EXISTS notification_default_tasks(task_id TEXT PRIMARY KEY,owner TEXT NOT NULL,revision INTEGER NOT NULL,task_revision INTEGER NOT NULL);`);
 }
 current(){const r=this.db.prepare('SELECT body FROM notification_default_policy WHERE singleton=1').get();return r?defaultPolicy(JSON.parse(r.body)):null;}
 view(){const p=this.current();return {contract:1,revision:p?.revision??0,operation:p?.operation??null,enabled:p?.enabled??false,target:p?.definition?{label:p.definition.label,host:p.definition.host}:null,scope:'new_cloud_scheduled_tasks',events:['result','attention'],historicalBackfill:false,writeAuthorized:false};}
 async inspectPeer(node,a,resolve=false){
  if(this.g.c.role!=='cloud'||node!=='local')throw Error('NOTIFICATION_ROLE_DENIED');
  if(!exact(a,resolve?['host','candidate_id','label','instance_id']:['host'])||a.host!=='cloud')throw Error('NOTIFICATION_DEFAULT_INVALID');
  if(resolve&&a.instance_id!==this.g.instanceId)throw Error('PROTOCOL_INSTANCE_CHANGED');
  const value=resolve?await this.owner.discovery.resolve(a.candidate_id,a.label):await this.owner.discovery.inspect();
  if(this.g.closed)throw Error('NOTIFICATION_DISCOVERY_CHANGED');
  return {instance_id:this.g.instanceId,value};
 }
 publish(node,raw){
  if(this.g.c.role!=='cloud'||node!=='local')throw Error('NOTIFICATION_ROLE_DENIED');
  const p=defaultPolicy(raw),fp=digest(p);
  // Target registration is idempotent and grants no delivery consent. Complete
  // its own transaction first; never nest SQLite BEGIN inside policy commit.
  const before=this.current();
  if(before&&(before.owner!==p.owner||before.revision>p.revision||before.revision===p.revision&&digest(before)!==fp))throw Error('NOTIFICATION_DEFAULT_REVISION_CONFLICT');
  if(p.enabled)this.register(p);
  return tx(this.db,()=>{
   const old=this.current();
   if(old){
    if(old.owner!==p.owner)throw Error('NOTIFICATION_DEFAULT_OWNER_CONFLICT');
    if(old.revision>p.revision)throw Error('NOTIFICATION_DEFAULT_REVISION_CONFLICT');
    if(old.revision===p.revision){if(digest(old)!==fp)throw Error('NOTIFICATION_DEFAULT_REVISION_CONFLICT');return this.view();}
   }
   this.db.prepare('INSERT INTO notification_default_history VALUES (?,?,?,?)').run(p.owner,p.revision,json(p),this.g.now());
   this.db.prepare('INSERT OR REPLACE INTO notification_default_policy VALUES (1,?)').run(json(p));
   // Changing/revoking a default ends only inherited consent; explicit per-task
   // bindings remain intact. Sends already dispatched cannot be recalled.
   this.db.prepare("UPDATE task_notifications SET state='cancelled',error='NOTIFICATION_DEFAULT_CHANGED' WHERE state IN ('queued','leased') AND task_id IN (SELECT task_id FROM notification_bindings WHERE json_extract(source,'$.kind')='onboarding_default')").run();
   this.db.prepare("UPDATE notification_bindings SET state='disabled' WHERE json_extract(source,'$.kind')='onboarding_default'").run();
   return this.view();
  });
 }
 register(p){
  defaultPolicy(p);if(!p.enabled)return;
  const event_id='onboarding-default:'+p.owner+':'+p.revision,fp=digest(p),old=this.db.prepare('SELECT fingerprint FROM notification_target_events WHERE event_id=?').get(event_id);
  if(old){if(old.fingerprint!==fp)throw Error('NOTIFICATION_DEFAULT_REVISION_CONFLICT');return;}
  this.owner.registry.record(p.definition,{event_id},fp,false);
 }
 async sync(p){
  if(this.g.c.role!=='local')throw Error('NOTIFICATION_ROLE_DENIED');
  defaultPolicy(p);this.register(p);
  const result=await this.g.call('notification_default_publish',p);
  if(result.operation!==p.operation||result.revision!==p.revision||result.enabled!==p.enabled)throw Error('NOTIFICATION_DEFAULT_UNCONFIRMED');
  return result;
 }
 capture(task){
  const p=this.current();if(!p?.enabled)return;
  this.db.prepare('INSERT OR IGNORE INTO notification_default_tasks VALUES (?,?,?,?)').run(task,p.owner,p.revision,this.g.catalog.head(task).spec_revision);
 }
 inherit(task){
  const p=this.current(),c=this.db.prepare('SELECT * FROM notification_default_tasks WHERE task_id=?').get(task);
  if(!p?.enabled||!c||c.owner!==p.owner||c.revision!==p.revision||this.db.prepare('SELECT 1 FROM notification_bindings WHERE task_id=?').get(task))return;
  const h=this.g.catalog.head(task),t=this.owner.config.get(p.definition.host+':'+p.definition.alias);if(h.legacy||h.spec_revision!==c.task_revision||!t)return;
  const seq=this.g.scheduler?.jobs.db.prepare('SELECT coalesce(max(seq),0) n FROM job_events').get().n??0;
  this.db.prepare('INSERT INTO notification_bindings VALUES (?,?,?,?,?,?,?,?,?,?)').run(task,1,h.spec_revision,t.key,t.route_hash,json({events:['result','attention']}),'enabled',json({kind:'onboarding_default',owner:p.owner,revision:p.revision,operation:p.operation}),this.g.now(),seq);
 }
 valid(binding){
  const source=JSON.parse(binding.source);if(source.kind!=='onboarding_default')return true;
  const p=this.current();return !!p?.enabled&&p.owner===source.owner&&p.revision===source.revision;
 }
}
