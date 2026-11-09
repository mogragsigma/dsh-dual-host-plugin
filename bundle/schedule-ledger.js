import {digest} from './task-jobs.js';
import {activeSchedule} from './search-contract.js';
const json=JSON.stringify;
const text=(v,max=256)=>typeof v==='string'&&!!v.trim()&&v.length<=max;
// Shared durable schedule/signal records; no executor or model dispatch here.
export class ScheduleLedger {
 constructor(db,now,io={}){
  this.db=db;this.now=now;this.io=io;
  this.db.exec(`
   CREATE TABLE IF NOT EXISTS task_schedules(id TEXT PRIMARY KEY,event_id TEXT UNIQUE,fingerprint TEXT,task_id TEXT,revision INTEGER,goal TEXT,policy TEXT,timing TEXT,dependencies TEXT,source TEXT,status TEXT,next_due INTEGER,emitted INTEGER DEFAULT 0,skipped INTEGER DEFAULT 0,reason TEXT,created INTEGER);
   CREATE TABLE IF NOT EXISTS schedule_occurrences(id TEXT PRIMARY KEY,schedule_id TEXT,slot TEXT,due INTEGER,status TEXT,job_id TEXT,event_id TEXT,UNIQUE(schedule_id,slot));
   CREATE TABLE IF NOT EXISTS schedule_signals(event_id TEXT PRIMARY KEY,schedule_id TEXT,fingerprint TEXT,source TEXT,at INTEGER,status TEXT);
   CREATE TABLE IF NOT EXISTS schedule_controls(event_id TEXT PRIMARY KEY,fingerprint TEXT,result TEXT);
   CREATE INDEX IF NOT EXISTS schedule_controls_pending ON schedule_controls(json_extract(result,'$.phase'));
   CREATE TABLE IF NOT EXISTS schedule_audit(seq INTEGER PRIMARY KEY AUTOINCREMENT,schedule_id TEXT,type TEXT,data TEXT,at INTEGER);
  `);
 }
 audit(id,type,data={}){this.db.prepare('INSERT INTO schedule_audit(schedule_id,type,data,at) VALUES (?,?,?,?)').run(id,type,json(data),this.now());}
 get(id){const s=this.db.prepare('SELECT * FROM task_schedules WHERE id=?').get(id);if(!s)throw Error('SCHEDULER_NOT_FOUND');return s;}
 list(task_id){return this.db.prepare('SELECT * FROM task_schedules WHERE task_id=? ORDER BY created,id').all(task_id).map(s=>this.view(s));}
 signal({id,name,event_id,source}){
  if(!text(event_id)||!Array.isArray(source)||!source.length||json(source).length>(this.sourceLimit??16000))throw Error('SCHEDULER_SIGNAL_INVALID');
  const fp=digest({id,name,source}),old=this.db.prepare('SELECT * FROM schedule_signals WHERE event_id=?').get(event_id);
  if(old){if(old.fingerprint!==fp)throw Error('SCHEDULER_EVENT_CONFLICT');return {event_id,status:old.status};}
  const s=this.get(id),t=JSON.parse(s.timing);
  if(t.rule.kind!=='event'||t.rule.name!==name||!this.signalAllowed(s,t))throw Error('SCHEDULER_SIGNAL_NOT_ACCEPTED');
  const pending=this.db.prepare("SELECT count(*) AS n FROM schedule_signals WHERE schedule_id=? AND status='pending'").get(id).n;
  if(pending>=100)throw Error('SCHEDULER_SIGNAL_QUEUE_FULL');
  if(t.max_occurrences!==null&&s.emitted+pending>=t.max_occurrences)throw Error('SCHEDULER_SIGNAL_NOT_ACCEPTED');
  this.db.prepare("INSERT INTO schedule_signals VALUES (?,?,?,?,?, 'pending')").run(event_id,id,fp,json(source),this.now());this.audit(id,'signal',{event_id});
  return {event_id,status:'pending'};
 }
 reason(id,reason){this.db.prepare('UPDATE task_schedules SET reason=? WHERE id=?').run(reason,id);}
 signalAllowed(s,t){return activeSchedule(s.status)&&(t.end_at===null||this.now()<t.end_at)&&(t.max_occurrences===null||s.emitted<t.max_occurrences);}
}
