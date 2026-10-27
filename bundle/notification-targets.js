// Own durable registry; never writes upstream IM configuration or grants task notification consent.
import {targets,digest,json,text} from './notification-contract.js';
import {validSources} from './task-context.js';
import {tx} from './recovery.js';
export class NotificationTargets {
 constructor(owner){
  this.owner=owner;this.g=owner.g;this.db=owner.db;
  this.db.exec(`CREATE TABLE IF NOT EXISTS notification_registered_targets(key TEXT PRIMARY KEY,definition TEXT NOT NULL,created INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS notification_target_events(event_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS notification_target_publications(event_id TEXT PRIMARY KEY,payload TEXT NOT NULL,state TEXT NOT NULL,error TEXT,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0);`);
  for(const row of this.db.prepare('SELECT definition FROM notification_registered_targets').all())this.merge(JSON.parse(row.definition));
 }
 validate(node,a){
  const source=validSources(a.sources);if(!text(a.event_id)||!source.length||source.some(s=>s.role!==node)||!text(a.authorization_quote,2000)||!text(a.label,80)||!a.authorization_quote.includes(a.label)||!source.some(s=>s.text.includes(a.authorization_quote)))throw Error('NOTIFICATION_DIRECT_USER_REQUIRED');return source;
 }
 merge(d){
  const t=targets([d])[0],old=this.owner.config.get(t.key);
  if(old&&(old.route_hash!==t.route_hash||old.label!==t.label))throw Error('NOTIFICATION_TARGET_CONFLICT');
  if([...this.owner.config.values()].some(x=>x.key!==t.key&&x.host===t.host&&x.label===t.label))throw Error('NOTIFICATION_TARGET_AMBIGUOUS');
  if(!old&&this.owner.config.size>=20)throw Error('NOTIFICATION_TARGET_LIMIT');
  this.owner.config.set(t.key,t);if(t.host===this.g.c.role)this.owner.endpoint.targets.set(t.key,t);return t;
 }
 record(d,a,fp,publish){
  // Validate against a copy so a rolled-back DB transaction cannot mutate the live target registry.
  const oldConfig=this.owner.config,oldTargets=this.owner.endpoint.targets;this.owner.config=new Map(oldConfig);this.owner.endpoint.targets=new Map(oldTargets);
  let target;try{target=this.merge(d);}finally{this.owner.config=oldConfig;this.owner.endpoint.targets=oldTargets;}
  const result={key:target.key,label:target.label,host:target.host,route_hash:target.route_hash,configured:true,delivery_consent:false,publication:publish?'pending':'cloud_saved'};
  tx(this.db,()=>{this.db.prepare('INSERT OR IGNORE INTO notification_registered_targets VALUES (?,?,?)').run(target.key,json(d),this.g.now());this.db.prepare('INSERT INTO notification_target_events VALUES (?,?,?)').run(a.event_id,fp,json(result));if(publish)this.db.prepare("INSERT INTO notification_target_publications(event_id,payload,state) VALUES (?,?,'pending')").run(a.event_id,json({definition:d,label:a.label,authorization_quote:a.authorization_quote,sources:a.sources,event_id:a.event_id}));});
  this.merge(d);return result;
 }
 async add(node,a){
  if(!a||Object.keys(a).some(k=>!['host','candidate_id','label','authorization_quote','sources','event_id'].includes(k))||a.host!==this.g.c.role||!text(a.candidate_id,128))throw Error('NOTIFICATION_TARGET_ARGUMENT_INVALID');
  this.validate(node,a);const fp=digest({node,...a}),old=this.db.prepare('SELECT * FROM notification_target_events WHERE event_id=?').get(a.event_id);
  if(old){if(old.fingerprint!==fp)throw Error('NOTIFICATION_EVENT_CONFLICT');return JSON.parse(old.result);}
  const definition=await this.owner.discovery.resolve(a.candidate_id,a.label);if(this.g.closed)throw Error('NOTIFICATION_CLOSED');
  // Multiple requests may finish the same provider recheck concurrently.
  const replay=this.db.prepare('SELECT * FROM notification_target_events WHERE event_id=?').get(a.event_id);if(replay){if(replay.fingerprint!==fp)throw Error('NOTIFICATION_EVENT_CONFLICT');return JSON.parse(replay.result);}
  return this.record(definition,a,fp,this.g.c.role==='local');
 }
 receive(node,a){
  if(this.g.c.role!=='cloud'||node!=='local'||!a||Object.keys(a).some(k=>!['definition','label','authorization_quote','sources','event_id'].includes(k)))throw Error('NOTIFICATION_ROLE_DENIED');
  this.validate(node,a);const t=targets([a.definition])[0];if(t.host!==node||t.label!==a.label||!t.alias.startsWith('discovered-'))throw Error('NOTIFICATION_ROLE_DENIED');
  const fp=digest({node,...a}),old=this.db.prepare('SELECT * FROM notification_target_events WHERE event_id=?').get(a.event_id);if(old){if(old.fingerprint!==fp)throw Error('NOTIFICATION_EVENT_CONFLICT');return JSON.parse(old.result);}
  return this.record(a.definition,a,fp,false);
 }
 async sync(){
  if(this.g.c.role!=='local'||this.g.closed)return;
  for(const row of this.db.prepare("SELECT * FROM notification_target_publications WHERE state='pending' AND next_at<=? ORDER BY rowid LIMIT 5").all(this.g.now())){
   try{const r=await this.g.call('notification_target_publish',JSON.parse(row.payload));if(r.publication!=='cloud_saved')throw Error('NOTIFICATION_PUBLICATION_UNCONFIRMED');this.db.prepare("UPDATE notification_target_publications SET state='published',error=NULL WHERE event_id=?").run(row.event_id);}
   catch(e){const safe=/^(NOTIFICATION|CAPABILITY|PROTOCOL|COORDINATOR)_[A-Z_]+$/.test(e.message)?e.message:'NOTIFICATION_PUBLICATION_UNAVAILABLE',hold=/CONFLICT|AMBIGUOUS|LIMIT|INVALID|DENIED|DIRECT_USER/.test(safe);this.db.prepare('UPDATE notification_target_publications SET state=?,error=?,attempts=attempts+1,next_at=? WHERE event_id=?').run(hold?'needs_review':'pending',safe,this.g.now()+Math.min(300000,2000*2**Math.min(row.attempts,8)),row.event_id);}
  }
 }
 publication(key){const rows=this.db.prepare('SELECT payload,state,error FROM notification_target_publications ORDER BY rowid DESC').all();const row=rows.find(r=>{const d=JSON.parse(r.payload).definition;return d.host+':'+d.alias===key;});return row?{state:row.state,error:row.error}:null;}
}
