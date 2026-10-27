import {digest,json,text} from './notification-contract.js';
import {validSources} from './task-context.js';
import {tx} from './recovery.js';

// Operator/user observation is deliberately separate from immutable transport evidence.
export class NotificationReview {
 constructor(g){
  this.g=g;this.db=g.db;
  this.db.exec(`CREATE TABLE IF NOT EXISTS notification_reviews(event_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,notification_id TEXT NOT NULL,revision INTEGER NOT NULL,record TEXT NOT NULL,UNIQUE(notification_id,revision));`);
 }
 latest(id){const r=this.db.prepare('SELECT record FROM notification_reviews WHERE notification_id=? ORDER BY revision DESC LIMIT 1').get(id);return r?JSON.parse(r.record):null;}
 record(node,a){
  if(!a||Object.keys(a).some(k=>!['event_id','task_id','notification_id','expected_review_revision','observation','action','note','sources'].includes(k))||!['local','cloud'].includes(node)||!text(a.event_id)||!text(a.task_id)||!text(a.notification_id)||!Number.isInteger(a.expected_review_revision)||a.expected_review_revision<0||!['seen','not_seen','not_checked'].includes(a.observation)||!['keep_open','close_without_resend'].includes(a.action)||!text(a.note,2000))throw Error('NOTIFICATION_REVIEW_INVALID');
  const sources=validSources(a.sources);if(!sources.length||sources.some(s=>s.role!==node)||!sources.some(s=>s.text.includes(a.note)))throw Error('NOTIFICATION_DIRECT_USER_REQUIRED');
  const fp=digest({node,...a,sources});
  return tx(this.db,()=>{
   const old=this.db.prepare('SELECT * FROM notification_reviews WHERE event_id=?').get(a.event_id);if(old){if(old.fingerprint!==fp)throw Error('NOTIFICATION_EVENT_CONFLICT');return JSON.parse(old.record);}
   this.g.store.task(a.task_id);
   const d=this.db.prepare('SELECT * FROM task_notifications WHERE id=? AND task_id=?').get(a.notification_id,a.task_id);
   if(!d||d.state!=='needs_review'||!d.result)throw Error('NOTIFICATION_REVIEW_NOT_ELIGIBLE');
   const prior=this.latest(d.id);if((prior?.revision??0)!==a.expected_review_revision)throw Error('NOTIFICATION_REVIEW_REVISION_CONFLICT');
   const record={notification_id:d.id,task_id:a.task_id,revision:a.expected_review_revision+1,at:this.g.now(),node,observation:a.observation,state:a.action==='close_without_resend'?'closed':'open',note:a.note,sources,proof:'direct_user_observation',original_result:JSON.parse(d.result),resend:false};
   this.db.prepare('INSERT INTO notification_reviews VALUES (?,?,?,?,?)').run(a.event_id,fp,d.id,record.revision,json(record));return record;
  });
 }
 summary(id){const r=this.latest(id);if(!r)return null;const {sources,original_result,...dto}=r;return {...dto,original_evidence_preserved:true};}
}
