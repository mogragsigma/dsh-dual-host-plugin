import {searchActive,activeSchedule} from './search-contract.js';
import {randomUUID} from 'node:crypto';
import {digest} from './task-jobs.js';
import {validateTiming,firstDue,coalesceDue} from './task-trigger-time.js';
import {validPolicy,validSources} from './task-context.js';
import {assertScheduleEnvelope,schedulePolicy,parseEnvelope} from './task-envelope.js';
const json=JSON.stringify;
const sourceKey=s=>{const x=s.at(-1);return digest({role:x?.role,session_id:x?.session_id,message_id:x?.message_id,sha256:x?.sha256});};
const text=(v,max=256)=>typeof v==='string'&&!!v.trim()&&v.length<=max;
// Cloud-only persistent read-only schedules. Not a repository write grant, webhook or model polling loop.
export class TaskTriggers {
 constructor(jobs,io={}){
  this.jobs=jobs;this.db=jobs.db;this.now=jobs.now;this.io=io;
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
 view(s){return {id:s.id,task_id:s.task_id,spec_revision:s.revision,status:s.status,next_due:s.next_due,emitted:s.emitted,skipped:s.skipped,waiting_reason:s.reason,timing:JSON.parse(s.timing),model_policy:JSON.parse(s.policy),dependencies:JSON.parse(s.dependencies),occurrences:this.db.prepare('SELECT id,due,status,job_id FROM schedule_occurrences WHERE schedule_id=? ORDER BY due,id').all(s.id),execution:'readonly',development:false};}
 create(a){
  const {task_id,revision,goal,event_id,source}=a,dependencies=a.dependencies??[];
  const policy=schedulePolicy(goal,a.policy);
  if(!text(task_id)||!text(event_id)||!text(goal,12000)||!Number.isInteger(revision)||revision<1||!Array.isArray(source)||source.length<1||json(source).length>16000)throw Error('SCHEDULER_REQUEST_INVALID');
  const e=parseEnvelope(goal);if(!e)throw Error('SCHEDULER_NATIVE_TASK_REQUIRED');assertScheduleEnvelope(goal,policy);validPolicy(policy);validSources(source);
  const fp=digest({task_id,revision,goal,policy,timing:a.timing,dependencies,source});
  const old=this.db.prepare('SELECT * FROM task_schedules WHERE event_id=?').get(event_id);
  if(old){if(old.fingerprint!==fp)throw Error('SCHEDULER_EVENT_CONFLICT');return this.view(old);}
  const timing=validateTiming(a.timing,this.now());
  if(this.jobs.list(task_id).some(j=>!['completed','cancelled'].includes(j.status)))throw Error('SCHEDULER_TASK_BUSY');
  if(!Array.isArray(dependencies)||dependencies.length>8||new Set(dependencies).size!==dependencies.length||dependencies.some(id=>!text(id)))throw Error('SCHEDULER_DEPENDENCIES_INVALID');
  for(const id of dependencies){const j=this.jobs.get(id);if(j.task_id===task_id||j.kind!=='plan')throw Error('SCHEDULER_DEPENDENCIES_INVALID');}
  return this.jobs.tx(()=>{
   if(this.db.prepare("SELECT 1 FROM task_schedules WHERE task_id=? AND status NOT IN ('closed','cancelled')").get(task_id))throw Error('SCHEDULER_ALREADY_EXISTS');
   if(this.db.prepare('SELECT source FROM task_schedules WHERE task_id=?').all(task_id).some(s=>sourceKey(JSON.parse(s.source))===sourceKey(source)))throw Error('SCHEDULER_SOURCE_ALREADY_USED');
   const id='schedule-'+randomUUID();
   this.db.prepare('INSERT INTO task_schedules(id,event_id,fingerprint,task_id,revision,goal,policy,timing,dependencies,source,status,next_due,created) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,event_id,fp,task_id,revision,goal,json(policy),json(timing),json(dependencies),json(source),searchActive(goal),firstDue(timing.rule),this.now());
   this.audit(id,'created',{event_id});return this.view(this.get(id));
  });
 }
 signal({id,name,event_id,source}){
  if(!text(event_id)||!Array.isArray(source)||!source.length||json(source).length>16000)throw Error('SCHEDULER_SIGNAL_INVALID');
  const fp=digest({id,name,source}),old=this.db.prepare('SELECT * FROM schedule_signals WHERE event_id=?').get(event_id);
  if(old){if(old.fingerprint!==fp)throw Error('SCHEDULER_EVENT_CONFLICT');return {event_id,status:old.status};}
  const s=this.get(id),t=JSON.parse(s.timing);
  if(t.rule.kind!=='event'||t.rule.name!==name||!activeSchedule(s.status)||this.now()>=t.end_at||s.emitted>=t.max_occurrences)throw Error('SCHEDULER_SIGNAL_NOT_ACCEPTED');
  const pending=this.db.prepare("SELECT count(*) AS n FROM schedule_signals WHERE schedule_id=? AND status='pending'").get(id).n;
  if(pending>=100)throw Error('SCHEDULER_SIGNAL_QUEUE_FULL');
  if(s.emitted+pending>=t.max_occurrences)throw Error('SCHEDULER_SIGNAL_NOT_ACCEPTED');
  this.db.prepare("INSERT INTO schedule_signals VALUES (?,?,?,?,?, 'pending')").run(event_id,id,fp,json(source),this.now());this.audit(id,'signal',{event_id});
  return {event_id,status:'pending'};
 }
 reason(id,reason){this.db.prepare('UPDATE task_schedules SET reason=? WHERE id=?').run(reason,id);}
 dependenciesReady(s){
  for(const id of JSON.parse(s.dependencies)){
   const j=this.jobs.get(id);
   if(j.status!=='completed'){this.reason(s.id,'dependency:'+j.status);return false;}
  }return true;
 }
 pending(s){return this.db.prepare("SELECT o.*,j.status AS job_status FROM schedule_occurrences o LEFT JOIN jobs j ON j.id=o.job_id WHERE o.schedule_id=? AND (o.status IN ('prepared','prepared-search') OR j.status<>'completed') ORDER BY o.due,o.id LIMIT 1").get(s.id);}
 materialize(o){
  const s=this.get(o.schedule_id),timing=JSON.parse(s.timing);
  const job=this.jobs.enqueue({task_id:s.task_id,trigger_id:o.id,kind:'plan',goal:s.goal,policy:JSON.parse(s.policy),due:o.due,max_runs:timing.max_runs,version:'0.17.0'});
  this.io.afterEnqueued?.(o,job);
  this.jobs.tx(()=>{
   this.db.prepare("UPDATE schedule_occurrences SET status='linked',job_id=? WHERE id=? AND status IN ('prepared','prepared-search')").run(job.id,o.id);
   if(o.event_id)this.db.prepare("UPDATE schedule_signals SET status='consumed' WHERE event_id=?").run(o.event_id);
   this.audit(s.id,'linked',{occurrence_id:o.id,job_id:job.id});
  });
  // A crash may occur between preparation and a later pause/cancel. Never let the recovered job bypass it.
  if(['paused','cancelled','closed','review'].includes(s.status))this.holdJobs(s,s.status==='cancelled'||s.status==='closed'?'cancel':'pause','reconcile:'+o.id);
 }
 tick(){
  for(const c of this.db.prepare("SELECT * FROM schedule_controls WHERE json_extract(result,'$.phase')='prepared'").all())this.settleControl(c);
  // Commit intent before enqueue, then link with an idempotent trigger. Neither database reset nor budget reset.
  for(const o of this.db.prepare("SELECT * FROM schedule_occurrences WHERE status IN ('prepared','prepared-search') ORDER BY due,id").all())this.materialize(o);
  for(const s of this.db.prepare("SELECT * FROM task_schedules WHERE status IN ('active','active-search') ORDER BY created,id").all()){
   const timing=JSON.parse(s.timing);
   try{this.io.validate?.(s);}catch{this.db.prepare("UPDATE task_schedules SET status='review',reason='task_revision_or_authority_changed' WHERE id=?").run(s.id);continue;}
   if(this.now()>=timing.end_at){
    this.db.prepare("UPDATE task_schedules SET status='closed',reason='deadline_reached' WHERE id=?").run(s.id);
    this.holdJobs(s,'cancel','deadline:'+s.id,true);this.db.prepare("UPDATE schedule_signals SET status='expired' WHERE schedule_id=? AND status='pending'").run(s.id);this.audit(s.id,'deadline');continue;
   }
   const pending=this.pending(s);
   if(pending){this.reason(s.id,'occurrence:'+(pending.job_status??'prepared'));continue;}
   if(s.emitted>=timing.max_occurrences||(s.next_due===null&&timing.rule.kind!=='event')){
    this.db.prepare("UPDATE task_schedules SET status='closed',reason='occurrence_budget_complete' WHERE id=?").run(s.id);
    this.db.prepare("UPDATE schedule_signals SET status='budget_exhausted' WHERE schedule_id=? AND status='pending'").run(s.id);continue;
   }
   if(!this.dependenciesReady(s))continue;
   const signal=timing.rule.kind==='event'?this.db.prepare("SELECT * FROM schedule_signals WHERE schedule_id=? AND status='pending' ORDER BY at,event_id LIMIT 1").get(s.id):null;
   const slot=timing.rule.kind==='event'?(signal?{due:signal.at,next_due:null,skipped:0,slot:'event:'+signal.event_id}:null):coalesceDue(timing.rule,s.next_due,this.now(),timing.end_at);
   if(!slot){this.reason(s.id,timing.rule.kind==='event'?'waiting_event':'waiting_time');continue;}
   const id='occurrence-'+randomUUID();
   this.jobs.tx(()=>{
    this.db.prepare("INSERT INTO schedule_occurrences(id,schedule_id,slot,due,status,event_id) VALUES (?,?,?,?,?,?)").run(id,s.id,slot.slot??'time:'+slot.due,slot.due,searchActive(s.goal)==='active-search'?'prepared-search':'prepared',signal?.event_id??null);
    this.db.prepare('UPDATE task_schedules SET emitted=emitted+1,skipped=skipped+?,next_due=?,reason=NULL WHERE id=?').run(slot.skipped,slot.next_due,s.id);
    this.audit(s.id,'prepared',{occurrence_id:id,skipped:slot.skipped});
   });
   const o=this.db.prepare('SELECT * FROM schedule_occurrences WHERE id=?').get(id);this.io.afterPrepared?.(o);this.materialize(o);
  }
 }
 context(job_id){
  const o=this.db.prepare('SELECT * FROM schedule_occurrences WHERE job_id=?').get(job_id);if(!o)return null;
  const s=this.get(o.schedule_id),signal=o.event_id?this.db.prepare('SELECT source FROM schedule_signals WHERE event_id=?').get(o.event_id):null;
  return {schedule_id:s.id,occurrence_id:o.id,due:o.due,timing:JSON.parse(s.timing),occurrence_number:s.emitted,activation_source:JSON.parse(s.source),event_source:signal?JSON.parse(signal.source):null,development:false};
 }
 canClaim(j){
  const s=this.db.prepare('SELECT s.* FROM task_schedules s JOIN schedule_occurrences o ON o.schedule_id=s.id WHERE o.job_id=?').get(j.id);
  if(!s)return true;
  return activeSchedule(s.status)&&this.now()<JSON.parse(s.timing).end_at&&this.dependenciesReady(s);
 }
 holdJobs(s,action,event_id,automatic=false){
  for(const o of this.db.prepare('SELECT job_id FROM schedule_occurrences WHERE schedule_id=? AND job_id IS NOT NULL').all(s.id)){
   const j=this.jobs.get(o.job_id);
   if(automatic&&['needs_review','waiting_approval','waiting_capability'].includes(j.status))continue;
   if(['completed','cancelled'].includes(j.status)||action==='pause'&&!['queued','waiting','running','waiting_input'].includes(j.status))continue;
   const a={id:j.id,action,event_id:event_id+':'+j.id,actor:'schedule-controller'};
   (this.io.control??(a=>this.jobs.control(a)))(a);
  }
 }
 control({id,action,event_id,actor}){
  if(!['pause','resume','cancel'].includes(action)||!text(event_id,140)||!text(actor,128))throw Error('SCHEDULER_CONTROL_INVALID');
  const fp=digest({id,action,actor}),old=this.db.prepare('SELECT * FROM schedule_controls WHERE event_id=?').get(event_id);
  if(old){if(old.fingerprint!==fp)throw Error('SCHEDULER_EVENT_CONFLICT');return JSON.parse(old.result).phase==='prepared'?this.settleControl(old):JSON.parse(old.result);}
  if(this.db.prepare("SELECT 1 FROM schedule_controls WHERE json_extract(result,'$.phase')='prepared' AND json_extract(result,'$.id')=?").get(id))throw Error('SCHEDULER_CONTROL_PENDING');
  const s=this.get(id),t=JSON.parse(s.timing);
  if(['closed','cancelled'].includes(s.status)||action==='resume'&&s.status!=='paused')throw Error('SCHEDULER_CONTROL_NOT_ALLOWED');
  if(action==='resume'&&this.now()>=t.end_at)throw Error('SCHEDULER_DEADLINE_REACHED');
  if(action==='resume')this.io.validate?.(s);
  // A persisted intent fences claiming before cancellation; restart finishes the same control without extending budgets.
  this.jobs.tx(()=>{
   this.db.prepare('UPDATE task_schedules SET status=?,reason=? WHERE id=?').run(action==='pause'?'paused':action==='cancel'?'cancelled':searchActive(s.goal),action==='resume'?null:'user_'+action,id);
   this.db.prepare('INSERT INTO schedule_controls VALUES (?,?,?)').run(event_id,fp,json({id,action,actor,phase:'prepared'}));
  });
  return this.settleControl(this.db.prepare('SELECT * FROM schedule_controls WHERE event_id=?').get(event_id));
 }
 settleControl(record){
  const {id,action,actor}=JSON.parse(record.result),s=this.get(id),event_id=record.event_id;
  if(action!=='resume')this.holdJobs(s,action,event_id);
  else for(const o of this.db.prepare('SELECT job_id FROM schedule_occurrences WHERE schedule_id=? AND job_id IS NOT NULL').all(id)){
   const j=this.jobs.get(o.job_id);
   // Only resume pauses made by THIS schedule controller, not independently paused jobs.
   const last=this.db.prepare("SELECT type,data FROM job_events WHERE job_id=? AND type IN ('pause','resume','cancel') ORDER BY seq DESC LIMIT 1").get(j.id);
   if(j.status==='paused'&&last?.type==='pause'&&JSON.parse(last.data).actor==='schedule-controller')this.jobs.control({id:j.id,action:'resume',actor:'schedule-controller',event_id:event_id+':'+j.id});
  }
  const result={id,status:s.status};
  this.jobs.tx(()=>{this.db.prepare('UPDATE schedule_controls SET result=? WHERE event_id=?').run(json(result),event_id);this.audit(id,action,{event_id,actor});});
  return result;
 }
}
