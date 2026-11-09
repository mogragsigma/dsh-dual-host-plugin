import {tx} from './recovery.js';
import {randomUUID} from 'node:crypto';
import {ScheduleLedger} from './schedule-ledger.js';
import {validateTiming,firstDue,coalesceDue} from './task-trigger-time.js';
import {digest} from './task-jobs.js';
import {parseEnvelope} from './task-envelope.js';
import {TASK_CONTEXT_MAX} from './managed-cloud-policy.js';
const json=JSON.stringify,fail=s=>{throw Error('SCHEDULER_'+s);};
// Same schedule/signal ledger and time rules as 1.0, in the coordinator transaction.
// An occurrence activates the existing native execution; it never creates a legacy job.
export class ManagedTriggers extends ScheduleLedger {
 constructor(execution){super(execution.db,execution.now);this.execution=execution;this.g=execution.g;this.sourceLimit=TASK_CONTEXT_MAX;}
 has(id){return !!this.db.prepare('SELECT 1 FROM task_schedules WHERE id=?').get(id);}
 current(task){return this.db.prepare('SELECT * FROM task_schedules WHERE task_id=? ORDER BY created DESC,rowid DESC LIMIT 1').get(task);}
 view(s){return {id:s.id,task_id:s.task_id,spec_revision:s.revision,status:s.status,next_due:s.next_due,emitted:s.emitted,skipped:s.skipped,waiting_reason:s.reason,timing:JSON.parse(s.timing),dependencies:JSON.parse(s.dependencies),execution:'native-cloud',occurrences:this.db.prepare('SELECT id,due,status,event_id FROM schedule_occurrences WHERE schedule_id=? ORDER BY rowid').all(s.id)};}
 prepare(task,spec,old){
  if(old&&(JSON.parse(old.spec).schedule||spec.schedule)&&old.revision===this.g.catalog.head(task).spec_revision)fail('REVISION_REQUIRED');
  if(!spec.schedule)return null;
  const s=spec.schedule;if(!s||typeof s!=='object'||Array.isArray(s)||Object.keys(s).some(k=>!['rule','max_occurrences','dependencies'].includes(k)))fail('RULE_INVALID');
  const timing=validateTiming({rule:s.rule,...(s.max_occurrences!==undefined?{max_occurrences:s.max_occurrences}:{}),...(spec.end_at!==undefined?{end_at:spec.end_at}:{})},this.now(),{native:true});
  const ids=s.dependencies??[];
  if(!Array.isArray(ids)||ids.length>8||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!id||id===task))fail('DEPENDENCIES_INVALID');
  const dependencies=ids.map(id=>{const r=this.execution.get(id);if(!r?.authority)fail('DEPENDENCY_NATIVE_TASK_REQUIRED');return {task_id:id,revision:this.g.catalog.head(id).spec_revision};});
  const visited=new Set(),visit=id=>{if(id===task)fail('DEPENDENCY_CYCLE');if(visited.has(id))return;visited.add(id);const r=this.current(id);if(r&&!['closed','cancelled'].includes(r.status))for(const d of JSON.parse(r.dependencies))visit(d.task_id);};ids.forEach(visit);
  return {timing,dependencies};
 }
 bind(task,spec,plan){
  const old=this.current(task);if(old){if(this.pending(old))fail('OCCURRENCE_UNSETTLED');if(this.db.prepare("SELECT 1 FROM schedule_signals WHERE schedule_id=? AND status='pending'").get(old.id))fail('SIGNALS_UNSETTLED');this.db.prepare("UPDATE task_schedules SET status='cancelled',reason='explicit_contract_revision' WHERE id=?").run(old.id);this.db.prepare("UPDATE schedule_signals SET status='cancelled' WHERE schedule_id=? AND status='pending'").run(old.id);}
  if(!plan)return;
  const r=this.execution.get(task),goal=this.g.catalog.head(task).goal,source=parseEnvelope(goal).task_context?.sources??[],id='schedule-native-'+randomUUID(),fp=digest({task,revision:r.revision,spec});
  this.db.prepare('INSERT INTO task_schedules(id,event_id,fingerprint,task_id,revision,goal,policy,timing,dependencies,source,status,next_due,created) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,'native:'+fp,fp,task,r.revision,goal,json(JSON.parse(r.authority).model_policy),json(plan.timing),json(plan.dependencies),json(source),'active',firstDue(plan.timing.rule),this.now());this.audit(id,'created',{execution:'native-cloud'});
 }
 pending(s){return this.db.prepare("SELECT * FROM schedule_occurrences WHERE schedule_id=? AND status='active' ORDER BY rowid LIMIT 1").get(s.id);}
 dependenciesReady(s){
  for(const d of JSON.parse(s.dependencies)){
   const r=this.execution.get(d.task_id),h=this.g.catalog.head(d.task_id),report=r?.report?JSON.parse(r.report):null;
   if(!r||r.revision!==d.revision||h.spec_revision!==d.revision){this.reason(s.id,'dependency_revision_changed');return false;}
   if(r.claim||!['idle','waiting','scheduled'].includes(r.state)||report?.outcome!=='ready'||report.late||report.spec_revision!==d.revision){this.reason(s.id,'dependency_not_ready');return false;}
  }return true;
 }
 signal(a){if(!this.db.isTransaction)return tx(this.db,()=>this.signal(a));return super.signal(a);}
 signalAllowed(s,t){return super.signalAllowed(s,t)&&this.g.continuity.canRun(s.task_id)&&this.g.catalog.head(s.task_id).spec_revision===s.revision;}
 followAllowed(r){const s=this.current(r.task_id);return !!r.occurrence_id||s?.status==='closed'&&s.reason==='plan_complete';}
 canClaim(r){
  if(!JSON.parse(r.spec).schedule)return true;
  const s=this.current(r.task_id),o=s&&this.pending(s);
  if(!r.occurrence_id&&r.human&&s?.status==='closed'&&s.reason==='plan_complete')return true;
  return !!s&&s.status==='active'&&o?.id===r.occurrence_id&&this.dependenciesReady(s);
 }
 tick(){
  if(!this.db.isTransaction)return tx(this.db,()=>this.tick());
  for(const s of this.db.prepare("SELECT * FROM task_schedules WHERE status='active' ORDER BY created,id").all()){
   const t=JSON.parse(s.timing),r=this.execution.get(s.task_id);
   if(!this.g.continuity.canRun(s.task_id))continue;
   if(t.end_at!==null&&this.now()>=t.end_at){this.close(s,'deadline_reached');continue;}
   if(!r||r.revision!==s.revision||this.g.catalog.head(s.task_id).spec_revision!==s.revision){this.db.prepare("UPDATE task_schedules SET status='review',reason='task_revision_changed' WHERE id=?").run(s.id);continue;}
   if(this.pending(s)){this.reason(s.id,'occurrence:'+r.state);continue;}
   if(t.max_occurrences!==null&&s.emitted>=t.max_occurrences||s.next_due===null&&t.rule.kind!=='event'){this.close(s,'plan_complete');continue;}
   if(r.state!=='scheduled'||r.claim||this.execution.busy(s.task_id))continue;
   if(!this.dependenciesReady(s))continue;
   const signal=t.rule.kind==='event'?this.db.prepare("SELECT * FROM schedule_signals WHERE schedule_id=? AND status='pending' ORDER BY at,rowid LIMIT 1").get(s.id):null;
   const slot=t.rule.kind==='event'?(signal?{due:signal.at,next_due:null,skipped:0,slot:'event:'+signal.event_id}:null):coalesceDue(t.rule,s.next_due,this.now(),t.end_at);
   if(!slot){this.reason(s.id,t.rule.kind==='event'?'waiting_event':'waiting_time');continue;}
   const id='occurrence-native-'+randomUUID();
   this.db.prepare("INSERT INTO schedule_occurrences(id,schedule_id,slot,due,status,event_id) VALUES (?,?,?,?,'active',?)").run(id,s.id,slot.slot??'time:'+slot.due,slot.due,signal?.event_id??null);
   this.db.prepare('UPDATE task_schedules SET emitted=emitted+1,skipped=skipped+?,next_due=?,reason=NULL WHERE id=?').run(slot.skipped,slot.next_due,s.id);
   if(signal)this.db.prepare("UPDATE schedule_signals SET status='consumed' WHERE event_id=?").run(signal.event_id);
   this.db.prepare("UPDATE managed_executions SET state='queued',due=?,human=0,occurrence_id=? WHERE task_id=?").run(this.now(),id,s.task_id);this.audit(s.id,'activated',{occurrence_id:id,skipped:slot.skipped});
  }
 }
 complete(r){if(!r.occurrence_id)return;this.db.prepare("UPDATE schedule_occurrences SET status='completed' WHERE id=? AND status='active'").run(r.occurrence_id);this.db.prepare('UPDATE managed_executions SET occurrence_id=NULL WHERE task_id=?').run(r.task_id);}
 close(s,reason){this.db.prepare("UPDATE task_schedules SET status='closed',reason=? WHERE id=?").run(reason,s.id);this.db.prepare("UPDATE schedule_signals SET status='expired' WHERE schedule_id=? AND status='pending'").run(s.id);if(reason==='plan_complete')this.db.prepare("UPDATE managed_executions SET state='idle' WHERE task_id=? AND state='scheduled' AND claim IS NULL").run(s.task_id);this.audit(s.id,'closed',{reason});}
 control(task,action){const s=this.current(task);if(!s||['closed','cancelled'].includes(s.status))return;
  if(action==='pause')this.db.prepare("UPDATE task_schedules SET status='paused',reason='user_pause' WHERE id=?").run(s.id);
  if(action==='resume')this.db.prepare("UPDATE task_schedules SET status='active',reason=NULL WHERE id=? AND status='paused'").run(s.id);
  if(action==='stop'){this.db.prepare("UPDATE task_schedules SET status='cancelled',reason='user_stop' WHERE id=?").run(s.id);this.db.prepare("UPDATE schedule_signals SET status='cancelled' WHERE schedule_id=? AND status='pending'").run(s.id);}
 }
 context(id){if(!id)return null;const o=this.db.prepare('SELECT * FROM schedule_occurrences WHERE id=?').get(id);if(!o)return null;const s=this.get(o.schedule_id),signal=o.event_id?this.db.prepare('SELECT source FROM schedule_signals WHERE event_id=?').get(o.event_id):null;return {schedule_id:s.id,occurrence_id:id,due:o.due,skipped:s.skipped,rule:JSON.parse(s.timing).rule,dependencies:JSON.parse(s.dependencies),event_id:o.event_id,event_source:signal?JSON.parse(signal.source):null,notice:'This is the current occurrence, not a historical observation. Resume unfinished work before later occurrences; external effects are not replayed.'};}
}
export const managedScheduleSchema={type:'object',properties:{rule:{oneOf:[
 {type:'object',properties:{kind:{const:'once'},at:{type:['integer','string']}},required:['kind','at'],additionalProperties:false},
 {type:'object',properties:{kind:{const:'interval'},start_at:{type:['integer','string']},every_seconds:{type:'integer',minimum:60,maximum:31622400}},required:['kind','start_at','every_seconds'],additionalProperties:false},
 {type:'object',properties:{kind:{const:'weekly'},start_at:{type:['integer','string']},weekday:{type:'integer',minimum:1,maximum:7},hour:{type:'integer',minimum:0,maximum:23},minute:{type:'integer',minimum:0,maximum:59},timezone:{type:'string'}},required:['kind','start_at','weekday','hour','minute','timezone'],additionalProperties:false},
 {type:'object',properties:{kind:{const:'event'},name:{type:'string',minLength:1,maxLength:100}},required:['kind','name'],additionalProperties:false}
]},max_occurrences:{type:'integer',minimum:1},dependencies:{type:'array',items:{type:'string'},maxItems:8,uniqueItems:true}},required:['rule'],additionalProperties:false,description:'Optional explicit business plan: once, interval, weekly wall time, or named user signal. Dependencies are existing native task IDs; time/signal AND all dependencies must be ready. max_occurrences is optional business rounds, NOT model requests. Omit unrequested count/deadline. Use task_trigger_signal for named signals and task_lifecycle for pause/resume/stop.'};
