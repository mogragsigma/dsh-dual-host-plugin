import {searchActive,activeSchedule} from './search-contract.js';
import {randomUUID} from 'node:crypto';
import {isWorkflowJobVersion} from './job-version.js';
import {digest} from './task-jobs.js';
import {validPolicy,validSources} from './task-context.js';
import {assertScheduleEnvelope,schedulePolicy,parseEnvelope} from './task-envelope.js';
const json=JSON.stringify,text=(v,n=256)=>typeof v==='string'&&!!v.trim()&&v.length<=n;
const terminal=new Set(['completed','cancelled']);
const pausable=new Set(['queued','waiting','running','waiting_input']);
const sourceKey=s=>{const x=s.at(-1);return digest({role:x.role,session_id:x.session_id,message_id:x.message_id,sha256:x.sha256});};
export function workflowGraph(nodes){
 if(!Array.isArray(nodes)||nodes.length<1||nodes.length>6)throw Error('WORKFLOW_GRAPH_INVALID');
 const result=nodes.map(n=>{
  if(!n||typeof n!=='object'||Object.keys(n).some(k=>!['key','title','instruction','depends_on','max_runs'].includes(k))||!/^[a-z][a-z0-9_-]{0,31}$/.test(n.key??'')||!text(n.title,120)||!text(n.instruction,2000)||!Number.isInteger(n.max_runs)||n.max_runs<1||n.max_runs>10||!Array.isArray(n.depends_on)||n.depends_on.length>5||new Set(n.depends_on).size!==n.depends_on.length)throw Error('WORKFLOW_GRAPH_INVALID');
  return {key:n.key,title:n.title,instruction:n.instruction,depends_on:n.depends_on,max_runs:n.max_runs};
 });
 const keys=new Map(result.map(n=>[n.key,n]));if(keys.size!==result.length)throw Error('WORKFLOW_GRAPH_INVALID');
 const visiting=new Set(),done=new Set();
 const visit=key=>{if(done.has(key))return;if(visiting.has(key)||!keys.has(key))throw Error('WORKFLOW_GRAPH_INVALID');visiting.add(key);for(const d of keys.get(key).depends_on)visit(d);visiting.delete(key);done.add(key);};
 for(const n of result)visit(n.key);
 return result;
}
// One bounded DAG per task revision. Children are real independent job sessions, not new user authority.
// Same-parent children serialize under TaskJobs' task fence; unrelated tasks may use other resource slots.
export class TaskWorkflows {
 constructor(jobs,io={}){
  this.jobs=jobs;this.db=jobs.db;this.now=jobs.now;this.io=io;
  this.db.exec(`CREATE TABLE IF NOT EXISTS task_workflows(id TEXT PRIMARY KEY,event_id TEXT UNIQUE,fingerprint TEXT,task_id TEXT,revision INTEGER,goal TEXT,policy TEXT,source TEXT,status TEXT,max_runs INTEGER,end_at INTEGER,reason TEXT,created INTEGER,UNIQUE(task_id,revision));
   CREATE TABLE IF NOT EXISTS workflow_nodes(id TEXT PRIMARY KEY,workflow_id TEXT,key TEXT,title TEXT,instruction TEXT,dependencies TEXT,max_runs INTEGER,job_id TEXT UNIQUE,phase TEXT,UNIQUE(workflow_id,key));
   CREATE TABLE IF NOT EXISTS workflow_controls(event_id TEXT PRIMARY KEY,fingerprint TEXT,result TEXT);
   CREATE INDEX IF NOT EXISTS workflow_controls_pending ON workflow_controls(json_extract(result,'$.phase'));
   CREATE TABLE IF NOT EXISTS workflow_audit(seq INTEGER PRIMARY KEY AUTOINCREMENT,workflow_id TEXT,type TEXT,data TEXT,at INTEGER);`);
 }
 get(id){const w=this.db.prepare('SELECT * FROM task_workflows WHERE id=?').get(id);if(!w)throw Error('WORKFLOW_NOT_FOUND');return w;}
 nodes(id){return this.db.prepare('SELECT * FROM workflow_nodes WHERE workflow_id=? ORDER BY rowid').all(id);}
 audit(id,type,data={}){this.db.prepare('INSERT INTO workflow_audit(workflow_id,type,data,at) VALUES (?,?,?,?)').run(id,type,json(data),this.now());}
 used(id){return this.db.prepare('SELECT coalesce(sum(j.attempts),0) n FROM workflow_nodes n JOIN jobs j ON j.id=n.job_id WHERE n.workflow_id=?').get(id).n;}
 pending(id){return !!this.db.prepare("SELECT 1 FROM workflow_controls WHERE json_extract(result,'$.phase')='prepared' AND json_extract(result,'$.id')=?").get(id);}
 list(task){return this.db.prepare('SELECT * FROM task_workflows WHERE task_id=? ORDER BY created,id').all(task).map(w=>this.view(w));}
 view(w){return {id:w.id,task_id:w.task_id,spec_revision:w.revision,status:w.status,waiting_reason:w.reason,model_policy:JSON.parse(w.policy),budget:{used_runs:this.used(w.id),max_runs:w.max_runs,end_at:w.end_at},nodes:this.nodes(w.id).map(n=>{const j=n.job_id?this.jobs.get(n.job_id):null;return {id:n.id,key:n.key,title:n.title,depends_on:JSON.parse(n.dependencies),job_id:n.job_id,status:j?.status??n.phase,attempts:j?.attempts??0,max_runs:n.max_runs,checkpoint:j?JSON.parse(j.checkpoint):null};}),execution:'readonly',development:false};}
 create(a){
  const {task_id,revision,goal,event_id}=a,source=validSources(a.source);
  const policy=schedulePolicy(goal,a.policy);
  if(!text(task_id)||!text(event_id)||!text(goal,12000)||!Number.isInteger(revision)||revision<1||!source.length||json(source).length>16000)throw Error('WORKFLOW_REQUEST_INVALID');
  if(!parseEnvelope(goal))throw Error('WORKFLOW_NATIVE_TASK_REQUIRED');assertScheduleEnvelope(goal,policy);validPolicy(policy);
  const graph=workflowGraph(a.nodes),fp=digest({task_id,revision,goal,policy,source,graph,max_total_runs:a.max_total_runs,end_at:a.end_at});
  const old=this.db.prepare('SELECT * FROM task_workflows WHERE event_id=?').get(event_id);
  if(old){if(old.fingerprint!==fp)throw Error('WORKFLOW_EVENT_CONFLICT');return this.view(old);}
  if(!Number.isInteger(a.max_total_runs)||a.max_total_runs<graph.length||a.max_total_runs>20||!Number.isSafeInteger(a.end_at)||a.end_at<=this.now()||a.end_at>this.now()+366*86400000)throw Error('WORKFLOW_BUDGET_INVALID');
  if(this.jobs.list(task_id).some(j=>!terminal.has(j.status)))throw Error('WORKFLOW_TASK_BUSY');
  const id=this.jobs.tx(()=>{
   if(this.db.prepare('SELECT 1 FROM task_workflows WHERE task_id=? AND revision=?').get(task_id,revision))throw Error('WORKFLOW_REVISION_ALREADY_USED');
   if(this.db.prepare('SELECT source FROM task_workflows WHERE task_id=?').all(task_id).some(w=>sourceKey(JSON.parse(w.source))===sourceKey(source)))throw Error('WORKFLOW_SOURCE_ALREADY_USED');
   const id='workflow-'+randomUUID();
   this.db.prepare('INSERT INTO task_workflows VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,event_id,fp,task_id,revision,goal,json(policy),json(source),searchActive(goal),a.max_total_runs,a.end_at,null,this.now());
   for(const n of graph)this.db.prepare("INSERT INTO workflow_nodes VALUES (?,?,?,?,?,?,?,NULL,?)").run('child-'+randomUUID(),id,n.key,n.title,n.instruction,json(n.depends_on),n.max_runs,searchActive(goal)==='active-search'?'prepared-search':'prepared');
   this.audit(id,'prepared',{event_id});return id;
  });
  this.io.afterPrepared?.(this.get(id));return this.view(this.get(id));
 }
 materialize(n){
  const w=this.get(n.workflow_id),j=this.jobs.enqueue({task_id:w.task_id,trigger_id:n.id,goal:w.goal,policy:JSON.parse(w.policy),due:w.created,max_runs:n.max_runs,version:'0.17.1'});
  this.io.afterEnqueued?.(n,j);
  this.jobs.tx(()=>{this.db.prepare("UPDATE workflow_nodes SET job_id=?,phase='linked' WHERE id=? AND phase IN ('prepared','prepared-search')").run(j.id,n.id);this.audit(w.id,'linked',{child_id:n.id,job_id:j.id});});
 }
 owner(job){return this.db.prepare('SELECT * FROM workflow_nodes WHERE job_id=?').get(job);}
 dependencies(n){return JSON.parse(n.dependencies).map(key=>{const dep=this.db.prepare('SELECT * FROM workflow_nodes WHERE workflow_id=? AND key=?').get(n.workflow_id,key);return {node:dep,job:dep?.job_id?this.jobs.get(dep.job_id):null};});}
 blockedChild(w){return this.nodes(w.id).some(n=>n.job_id&&['needs_review','waiting_approval','waiting_capability','cancelled'].includes(this.jobs.get(n.job_id).status));}
 canClaim(j){
  const n=this.owner(j.id);if(!n)return !isWorkflowJobVersion(j.version); // No legacy consumer/partial record may bypass lineage.
  const w=this.get(n.workflow_id);
  if(!activeSchedule(w.status)||this.pending(w.id)||this.now()>=w.end_at||this.used(w.id)>=w.max_runs||this.blockedChild(w))return false;
  return this.dependencies(n).every(d=>d.job?.status==='completed');
 }
 assertRunning(j){const n=this.owner(j.id);if(!n){if(isWorkflowJobVersion(j.version))throw Error('WORKFLOW_LINEAGE_INVALID');return;}
  const w=this.get(n.workflow_id);if(!activeSchedule(w.status)||this.pending(w.id)||this.now()>=w.end_at||this.used(w.id)>w.max_runs||this.blockedChild(w)||!this.dependencies(n).every(d=>d.job?.status==='completed'))throw Error('WORKFLOW_EXECUTION_NOT_ALLOWED');
 }
 context(job){const n=this.owner(job);if(!n)return null;const w=this.get(n.workflow_id);return {workflow_id:w.id,parent_task_id:w.task_id,spec_revision:w.revision,child_id:n.id,key:n.key,title:n.title,instruction:n.instruction,activation_source:JSON.parse(w.source),dependencies:this.dependencies(n).map(d=>({key:d.node.key,title:d.node.title,job_id:d.job?.id,status:d.job?.status,checkpoint:d.job?JSON.parse(d.job.checkpoint):null})),shared_budget:{used_runs:this.used(w.id),max_runs:w.max_runs,end_at:w.end_at},recursive_spawn:false,development:false};}
 hold(w,action,event){for(const n of this.nodes(w.id)){
  if(!n.job_id)continue;const j=this.jobs.get(n.job_id);
  if(terminal.has(j.status)||action==='pause'&&!pausable.has(j.status))continue;
  (this.io.control??(a=>this.jobs.control(a)))({id:j.id,action,event_id:event+':'+j.id,actor:'workflow-controller'});
 }}
 tick(){
  for(const c of this.db.prepare("SELECT * FROM workflow_controls WHERE json_extract(result,'$.phase')='prepared'").all())this.settle(c);
  for(const n of this.db.prepare("SELECT * FROM workflow_nodes WHERE phase IN ('prepared','prepared-search') ORDER BY rowid").all())this.materialize(n);
  for(const w of this.db.prepare('SELECT * FROM task_workflows').all()){
   if(!activeSchedule(w.status)){if(w.status!=='completed')this.hold(w,w.status==='cancelled'?'cancel':'pause','workflow-reconcile:'+w.id);continue;}
   const children=this.nodes(w.id).map(n=>this.jobs.get(n.job_id));
   if(children.every(j=>j.status==='completed')){this.db.prepare("UPDATE task_workflows SET status='completed',reason=NULL WHERE id=?").run(w.id);this.audit(w.id,'completed');continue;}
   let reason=null;try{this.io.validate?.(w);}catch{reason='task_revision_or_authority_changed';}
   reason??=this.now()>=w.end_at?'deadline_reached':this.blockedChild(w)?'child_needs_review':this.used(w.id)>=w.max_runs&&!children.some(j=>j.status==='running')?'shared_budget_exhausted':null;
   if(reason){this.db.prepare("UPDATE task_workflows SET status='needs_review',reason=? WHERE id=?").run(reason,w.id);this.audit(w.id,'held',{reason});this.hold(w,'pause','workflow-held:'+w.id);continue;}
   const wait=children.find(j=>j.status==='waiting_input')??children.find(j=>j.status==='paused')??children.find(j=>j.status==='waiting');
   this.db.prepare('UPDATE task_workflows SET reason=? WHERE id=?').run(wait?'child:'+wait.status:null,w.id);
  }
 }
 control({id,action,event_id,actor}){
  if(!['pause','resume','cancel'].includes(action)||!text(event_id,140)||!text(actor,128))throw Error('WORKFLOW_CONTROL_INVALID');
  const fp=digest({id,action,actor}),old=this.db.prepare('SELECT * FROM workflow_controls WHERE event_id=?').get(event_id);
  if(old){if(old.fingerprint!==fp)throw Error('WORKFLOW_EVENT_CONFLICT');return JSON.parse(old.result).phase==='prepared'?this.settle(old):JSON.parse(old.result);}
  if(this.pending(id))throw Error('WORKFLOW_CONTROL_PENDING');
  const w=this.get(id);if(terminal.has(w.status)||action==='resume'&&w.status!=='paused'||action==='pause'&&!['active','active-search','paused'].includes(w.status))throw Error('WORKFLOW_CONTROL_NOT_ALLOWED');
  if(action==='resume'){if(this.now()>=w.end_at)throw Error('WORKFLOW_DEADLINE_REACHED');this.io.validate?.(w);}
  this.jobs.tx(()=>{this.db.prepare('UPDATE task_workflows SET status=?,reason=? WHERE id=?').run(action==='resume'?searchActive(w.goal):action==='pause'?'paused':'cancelled',action==='resume'?null:'user_'+action,id);this.db.prepare('INSERT INTO workflow_controls VALUES (?,?,?)').run(event_id,fp,json({id,action,actor,phase:'prepared'}));});
  return this.settle(this.db.prepare('SELECT * FROM workflow_controls WHERE event_id=?').get(event_id));
 }
 settle(record){
  const {id,action,actor}=JSON.parse(record.result),w=this.get(id),event=record.event_id;
  if(action!=='resume')this.hold(w,action,event);
  else for(const n of this.nodes(id)){
   if(!n.job_id)continue;const j=this.jobs.get(n.job_id),last=this.db.prepare("SELECT type,data FROM job_events WHERE job_id=? AND type IN ('pause','resume','cancel') ORDER BY seq DESC LIMIT 1").get(j.id);
   if(j.status==='paused'&&last?.type==='pause'&&JSON.parse(last.data).actor==='workflow-controller')this.jobs.control({id:j.id,action:'resume',actor:'workflow-controller',event_id:event+':'+j.id});
  }
  const result={id,status:w.status};this.jobs.tx(()=>{this.db.prepare('UPDATE workflow_controls SET result=? WHERE event_id=?').run(json(result),event);this.audit(id,action,{actor,event_id:event});});return result;
 }
}
