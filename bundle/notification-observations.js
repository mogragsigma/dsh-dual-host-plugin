// F17: stable event IDs and existing recipient grants/receipts, not a new sender.
import {createHash} from 'node:crypto';
import {tx} from './recovery.js';
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function observeNotices(n,events){
 if(!events.length)return;
 n.db.exec('CREATE TABLE IF NOT EXISTS notification_observation_members(notification_id TEXT NOT NULL,task_id TEXT NOT NULL,binding_revision INTEGER NOT NULL,PRIMARY KEY(notification_id,task_id));');n.observationGroups=true;
 const groups=new Map();
 for(const e of events){
  if(n.db.prepare('SELECT 1 FROM task_notification_events WHERE id=?').get(e.id))continue;
  const b=n.db.prepare('SELECT * FROM notification_bindings WHERE task_id=?').get(e.task_id);
  if(!n.valid(b)||!JSON.parse(b.policy).events.includes(e.category)){
   n.db.prepare('INSERT OR IGNORE INTO task_notification_events VALUES (?,?,?,?,?,NULL)').run(e.id,e.task_id,e.category,n.g.now(),'no_current_notification_grant');continue;
  }
  // Only proved provider-level common cause, identical destination + category.
  const key=JSON.stringify([e.common??e.id,b.target_key,b.route_hash,e.category]);
  const group=groups.get(key)??[];group.push({...e,b});groups.set(key,group);
 }
 for(const group of groups.values())for(let i=0;i<group.length;i+=10){const members=group.slice(i,i+10),first=members[0],id='observation-notice-'+digest(members.map(e=>e.id).sort());
  tx(n.db,()=>{
   if(n.db.prepare('SELECT 1 FROM task_notification_events WHERE id=?').get(first.id))return;
   const count=n.db.prepare("SELECT count(*) n FROM task_notifications WHERE task_id=? AND state IN ('queued','leased','dispatching','needs_review')").get(first.task_id).n;
   if(count>=200){for(const e of members)n.db.prepare('INSERT OR IGNORE INTO task_notification_events VALUES (?,?,?,?,?,NULL)').run(e.id,e.task_id,e.category,n.g.now(),'queue_limit');return;}
   const names=members.map(e=>n.g.catalog.head(e.task_id).title.slice(0,120)),text=(members.length>1?'本次核对曾记录同一服务问题（最新状态以任务页为准）：'+names.join('、')+'。':'任务「'+names[0]+'」核对记录：')+first.text+'\n可在任务中查看依据、成果或追加指示。';
   const target=n.config.get(first.b.target_key);
   n.db.prepare("INSERT INTO task_notifications(id,task_id,binding_revision,target_key,host,route_hash,category,text,state,due,created) VALUES (?,?,?,?,?,?,?,?,'queued',?,?)").run(id,first.task_id,first.b.revision,target.key,target.host,target.route_hash,first.category,text.slice(0,8000),n.g.now(),n.g.now());
   for(const e of members){n.db.prepare('INSERT OR IGNORE INTO notification_observation_members VALUES (?,?,?)').run(id,e.task_id,e.b.revision);n.db.prepare('INSERT INTO task_notification_events VALUES (?,?,?,?,?,?)').run(e.id,e.task_id,e.category,n.g.now(),'queued',id);}
  });
 }
}
export function observationGrant(n,id){
 if(!n.observationGroups)return true;
 const members=n.db.prepare('SELECT * FROM notification_observation_members WHERE notification_id=?').all(id);
 if(!members.length)return true;
 let relevant=false;
 for(const m of members){
  const b=n.db.prepare('SELECT * FROM notification_bindings WHERE task_id=?').get(m.task_id);
  if(!n.valid(b)||b.revision!==m.binding_revision)return false;
  const e=n.db.prepare('SELECT id,category FROM task_notification_events WHERE delivery_id=? AND task_id=?').get(id,m.task_id);
  if(e?.category!=='attention'||n.g.observer?.noticeCurrent(m.task_id,e.id)===true)relevant=true;
 }
 // Group text is explicitly a historical snapshot. One still-current issue
 // warrants the batch; all recovered/paused issues suppress it. Never resend.
 return relevant;
}
