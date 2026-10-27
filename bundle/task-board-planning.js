import {isWorkflowJobVersion} from './job-version.js';
// Read-only projections: never invoke scheduler ticks, migrations, control or canClaim (which may record reasons).
const parse=(s,fallback=null)=>{try{return JSON.parse(s);}catch{return fallback;}};
const has=(db,t)=>!!db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const job=(db,id)=>id?db.prepare('SELECT * FROM jobs WHERE id=?').get(id):null;
const array=s=>{const v=parse(s,[]);return Array.isArray(v)?v:[];};
const safeText=(x,n=120)=>typeof x==='string'?x.slice(0,n):null;
const safePolicy=s=>{const p=parse(s,{});return p?{provider:safeText(p.provider,128),model:safeText(p.model,128),reasoningEffort:safeText(p.reasoningEffort,128)}:null;};
const childHold=status=>['needs_review','waiting_approval','waiting_capability','cancelled'].includes(status);
function workflowRows(db,w){return db.prepare('SELECT * FROM workflow_nodes WHERE workflow_id=? ORDER BY rowid LIMIT 6').all(w.id).map(n=>{const j=job(db,n.job_id);return {...n,job:j?.task_id===w.task_id?j:null};});}
function workflowState(db,w,nodes,now){
 if(!nodes.length)return 'lineage_unavailable';
 if(w.status==='completed')return 'workflow_completed';if(w.status==='cancelled')return 'workflow_cancelled';
 if(w.status==='needs_review')return w.reason==='shared_budget_exhausted'?'shared_budget_exhausted':w.reason==='deadline_reached'?'deadline_reached':'workflow_needs_review';
 if(w.status==='paused')return 'workflow_paused';if(!['active','active-search','active-notify'].includes(w.status))return 'planning_unknown';
 if(nodes.some(n=>n.job_id&&!n.job))return 'lineage_unavailable';
 if(has(db,'workflow_controls')&&db.prepare("SELECT 1 FROM workflow_controls WHERE json_extract(result,'$.phase')='prepared' AND json_extract(result,'$.id')=?").get(w.id))return 'workflow_control_pending';
 if(now>=w.end_at)return 'deadline_reached';
 if(nodes.some(n=>childHold(n.job?.status)))return 'workflow_needs_review';
 if(nodes.some(n=>n.job?.status==='running'))return 'running';
 if(nodes.every(n=>n.job?.status==='completed'))return 'workflow_finishing';
 if(nodes.reduce((sum,n)=>sum+(n.job?.attempts??0),0)>=w.max_runs)return 'shared_budget_exhausted';
 if(nodes.some(n=>n.job?.status==='waiting_input'))return 'waiting_input';
 if(nodes.some(n=>n.job?.status==='paused'))return 'child_paused';
 if(nodes.some(n=>!n.job))return 'workflow_preparing';
 if(nodes.some(n=>n.job?.status==='waiting'))return 'scheduled_time';
 return 'awaiting_scheduler';
}
function scheduleState(db,s,now){
 if(s.status==='closed')return 'schedule_closed';if(s.status==='cancelled')return 'schedule_cancelled';if(s.status==='paused')return 'schedule_paused';if(s.status==='review')return 'schedule_needs_review';if(!['active','active-search','active-notify'].includes(s.status))return 'planning_unknown';
 const timing=parse(s.timing,{});if(now>=timing.end_at)return 'deadline_reached';
 const pending=db.prepare("SELECT j.status,o.status AS phase FROM schedule_occurrences o LEFT JOIN jobs j ON j.id=o.job_id WHERE o.schedule_id=? AND (o.status IN ('prepared','prepared-search','prepared-notify') OR j.status IS NULL OR j.status<>'completed') ORDER BY o.due,o.id LIMIT 1").get(s.id);
 if(pending)return ['prepared','prepared-search','prepared-notify'].includes(pending.phase)?'workflow_preparing':pending.status??'lineage_unavailable';
 if(s.emitted>=timing.max_occurrences)return 'schedule_finishing';
 if(array(s.dependencies).some(id=>job(db,id)?.status!=='completed'))return 'waiting_dependency';
 if(timing.rule?.kind==='event')return 'waiting_event';
 return s.next_due>now?'waiting_time':'awaiting_scheduler';
}
export function jobLineage(g,j){
 const db=g.scheduler?.jobs.db;if(!db)return null;
 if(has(db,'workflow_nodes')&&has(db,'task_workflows')){
  const n=db.prepare('SELECT n.*,w.task_id,w.revision FROM workflow_nodes n JOIN task_workflows w ON w.id=n.workflow_id WHERE n.job_id=?').get(j.id);
  if(n?.task_id===j.task_id)return {kind:'child',workflow_id:n.workflow_id,child_id:n.id,key:n.key,title:safeText(n.title),spec_revision:n.revision};
 }
 if(has(db,'schedule_occurrences')&&has(db,'task_schedules')){
  const o=db.prepare('SELECT o.id,o.due,o.schedule_id,s.task_id,s.revision FROM schedule_occurrences o JOIN task_schedules s ON s.id=o.schedule_id WHERE o.job_id=?').get(j.id);
  if(o?.task_id===j.task_id)return {kind:'occurrence',schedule_id:o.schedule_id,occurrence_id:o.id,due:o.due,spec_revision:o.revision};
 }
 return isWorkflowJobVersion(j.version)?{kind:'unavailable'}:null;
}
export function planningGate(g,j){
 const db=g.scheduler?.jobs.db,n=jobLineage(g,j);if(!n)return null;if(n.kind==='unavailable')return 'lineage_unavailable';
 if(n.kind==='child'){
  const w=db.prepare('SELECT * FROM task_workflows WHERE id=?').get(n.workflow_id),rows=workflowRows(db,w),state=workflowState(db,w,rows,g.now());
  if(['workflow_paused','workflow_cancelled','workflow_completed','workflow_needs_review','workflow_control_pending','deadline_reached','shared_budget_exhausted','planning_unknown','lineage_unavailable'].includes(state))return state;
  const node=rows.find(x=>x.id===n.child_id);if(!node)return 'lineage_unavailable';
  if(array(node.dependencies).some(key=>rows.find(x=>x.key===key)?.job?.status!=='completed'))return 'waiting_dependency';
 }else{
  const s=db.prepare('SELECT * FROM task_schedules WHERE id=?').get(n.schedule_id),state=scheduleState(db,s,g.now());
  if(['schedule_paused','schedule_cancelled','schedule_closed','schedule_needs_review','deadline_reached','planning_unknown'].includes(state))return state;
  if(array(s.dependencies).some(id=>job(db,id)?.status!=='completed'))return 'waiting_dependency';
 }
 return null;
}
export function planningSnapshot(g,id,titleFor=()=>null){
 const db=g.scheduler?.jobs.db,available={schedules:has(db,'task_schedules')&&has(db,'schedule_occurrences'),workflows:has(db,'task_workflows')&&has(db,'workflow_nodes')};
 const deps=ids=>ids.slice(0,8).map(id=>{const j=job(db,id);let title;try{title=j?titleFor(j.task_id):null;}catch{}return {job_id:id,title:safeText(title)??'历史依赖任务',status:j?.status??'unavailable'};});
 const schedules=available.schedules?db.prepare("SELECT * FROM task_schedules WHERE task_id=? ORDER BY CASE WHEN status IN ('closed','cancelled') THEN 1 ELSE 0 END,created DESC,id DESC LIMIT 20").all(id).map(s=>{
  const timing=parse(s.timing,{}),r=timing.rule??{};
  return {id:s.id,spec_revision:s.revision,status:s.status,created:s.created,state:scheduleState(db,s,g.now()),next_due:s.next_due,skipped:s.skipped,model_policy:safePolicy(s.policy),rule:{kind:safeText(r.kind),at:r.at??null,start_at:r.start_at??null,every_seconds:r.every_seconds??null,weekday:r.weekday??null,hour:r.hour??null,minute:r.minute??null,timezone:safeText(r.timezone),name:safeText(r.name,120)},budget:{emitted:s.emitted,max_occurrences:timing.max_occurrences??null,max_runs:timing.max_runs??null,end_at:timing.end_at??null},dependencies:deps(array(s.dependencies)),occurrences_total:db.prepare('SELECT count(*) n FROM schedule_occurrences WHERE schedule_id=?').get(s.id).n};
 }):[];
 const workflows=available.workflows?db.prepare("SELECT * FROM task_workflows WHERE task_id=? ORDER BY CASE WHEN status IN ('completed','cancelled') THEN 1 ELSE 0 END,created DESC,id DESC LIMIT 20").all(id).map(w=>{
  const rows=workflowRows(db,w);return {id:w.id,spec_revision:w.revision,status:w.status,created:w.created,state:workflowState(db,w,rows,g.now()),model_policy:safePolicy(w.policy),budget:{used_runs:rows.reduce((n,x)=>n+(x.job?.attempts??0),0),max_runs:w.max_runs,end_at:w.end_at},nodes:rows.map(n=>({id:n.id,key:n.key,title:safeText(n.title),job_id:n.job_id,status:n.job?.status??(n.job_id?'unavailable':'prepared'),state:n.job&&['queued','waiting'].includes(n.job.status)&&array(n.dependencies).some(key=>rows.find(d=>d.key===key)?.job?.status!=='completed')?'waiting_dependency':n.job?.status??(n.job_id?'unavailable':'prepared'),max_runs:n.max_runs,attempts:n.job?.attempts??0,question:safeText(parse(n.job?.checkpoint)?.question,2000),dependencies:array(n.dependencies).slice(0,5).map(key=>{const d=rows.find(n=>n.key===key);return {title:safeText(d?.title)??'未知前置节点',status:d?.job?.status??'unavailable'};})}))};
 }):[];
 return {available,schedules,workflows,schedules_total:available.schedules?db.prepare('SELECT count(*) n FROM task_schedules WHERE task_id=?').get(id).n:0,workflows_total:available.workflows?db.prepare('SELECT count(*) n FROM task_workflows WHERE task_id=?').get(id).n:0,display_limit:20,read_only:true};
}
export function taskDisplayState(head,jobs,planning){
 if(head.coordination.blocked)return 'task_blocked';if(head.coordination.busy)return 'task_busy';
 const active=jobs.find(j=>['running','draining'].includes(j.reason));if(active)return active.reason;
 const current=j=>head.spec_revision===null||j.spec_revision===head.spec_revision;
 const workflow=planning.workflows.find(current);if(workflow)return workflow.state;
 const schedule=planning.schedules.find(current);if(schedule)return schedule.state;
 return jobs.find(j=>j.spec_revision==null?head.legacy:current(j))?.reason??'registered';
}
