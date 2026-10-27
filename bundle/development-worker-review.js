import {canonical,digest} from './approval-ledger.js';
import {approvedDevelopment} from './development-contract.js';
import {DevelopmentFiles} from './development-files.js';

// Operator-only recovery of the SAME workspace job. Not a model tool/RPC. The
// task stays fenced across the two databases until the job is durably paused.
export class DevelopmentWorkerReview {
 constructor(runtime,{assertExclusive}={}){
  if(typeof assertExclusive!=='function')throw Error('DEVELOPMENT_REVIEW_EXCLUSIVE_REQUIRED');
  this.runtime=runtime;this.gate=runtime.gate;this.jobs=runtime.g.scheduler.jobs;this.db=this.gate.db;this.assertExclusive=assertExclusive;
  this.db.exec(`CREATE TABLE IF NOT EXISTS development_workspace_reviews(
   event_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,run_id TEXT UNIQUE NOT NULL,request_id TEXT NOT NULL,
   job_id TEXT NOT NULL,state TEXT NOT NULL,record TEXT NOT NULL,result TEXT,created INTEGER NOT NULL);`);
 }
 context(job_id){
  const g=this.gate,job=this.jobs.get(job_id),r=this.runtime.requestFor(job),t=g.store.task(r.task_id);this.assertExclusive(r.task_id);
  if(!this.runtime.workspaceEnabled||!g.enabled||g.busy(r.task_id)||g.inflight.has(r.id)||
     [...this.runtime.worker.active.values()].some(b=>b.job.task_id===r.task_id)||r.state!=='needs_review'||r.node!=='cloud'||
     t.owner!=='cloud'||t.epoch!==r.epoch||!t.busy||!t.blocked||!r.expected_hash||job.task_id!==r.task_id||
     job.kind!=='development'||job.version!=='0.22.0'||job.approved_by!==r.approval_id||job.claim!==null||
     canonical(JSON.parse(job.policy))!==r.policy||!['needs_review','paused'].includes(job.status))throw Error('DEVELOPMENT_REVIEW_STATE');
  const run=this.jobs.db.prepare('SELECT * FROM runs WHERE job_id=? ORDER BY started DESC,rowid DESC LIMIT 1').get(job.id);
  if(!run||!['failed','interrupted'].includes(run.status)||!run.finished||
     this.jobs.db.prepare("SELECT 1 FROM jobs WHERE task_id=? AND status='running'").get(r.task_id)||
     this.jobs.db.prepare("SELECT 1 FROM runs WHERE job_id=? AND status='running'").get(job.id)||
     job.attempts!==this.jobs.db.prepare('SELECT count(*) n FROM runs WHERE job_id=?').get(job.id).n)throw Error('DEVELOPMENT_REVIEW_STATE');
  const auth=approvedDevelopment(g.ledger,r.task_id,r.approval_id,JSON.parse(r.policy),{review:true}),binding=g.bindings[r.task_id];
  if(auth.spec.kind!=='workspace-v1'||auth.hash!==r.authority_hash||binding?.approval_hash!==auth.hash||
     !g.ledger.repositories?.status(r.task_id).verification_fresh)throw Error('DEVELOPMENT_APPROVAL_CHANGED');
  const workspace=new DevelopmentFiles(binding,auth.spec,auth.approval.proposal.repository);g.assertWorkspace(r,workspace);workspace.check(r.expected_hash);
  const writes=this.db.prepare('SELECT id,fingerprint,old_hash,new_hash,state FROM development_writes WHERE request_id=? ORDER BY rowid').all(r.id);
  const commands=this.db.prepare('SELECT id,command_id,fingerprint,operation_id,state,result FROM development_commands WHERE request_id=? ORDER BY rowid').all(r.id);
  const operations=this.db.prepare('SELECT * FROM development_operations WHERE request_id=? ORDER BY rowid').all(r.id);
  const intents=this.db.prepare("SELECT data FROM development_events WHERE request_id=? AND type='command_intent'").all(r.id).map(x=>JSON.parse(x.data));
  const calls=this.db.prepare("SELECT data FROM development_events WHERE request_id=? AND type='write_tool_called' ORDER BY seq").all(r.id).map(x=>JSON.parse(x.data));
  if(writes.some(w=>w.state!=='applied')||calls.some(c=>!writes.some(w=>w.id===r.id+':'+c.call_id))||
     operations.some(o=>o.state!=='closed')||commands.some(c=>c.state!=='completed'||!c.result||!JSON.parse(c.result).drained)||
     this.db.prepare("SELECT 1 FROM intents WHERE task_id=? AND status IN ('granted','writing')").get(r.task_id))throw Error('DEVELOPMENT_REVIEW_EFFECTS_UNRESOLVED');
  if(new Set(commands.map(c=>c.operation_id)).size!==commands.length||operations.some(o=>o.kind!=='command'||!o.closed||!commands.some(c=>c.operation_id===o.id))||commands.some(c=>{
   const o=operations.find(o=>o.id===c.operation_id),v=JSON.parse(c.result),cmd=auth.spec.commands.find(x=>x.id===c.command_id),intent=intents.filter(x=>x.operation===c.operation_id);
   return !o||!cmd||o.epoch>r.epoch||v.command_id!==cmd.id||v.command_hash!==digest(cmd)||intent.length!==1||
    intent[0].command_id!==cmd.id||intent[0].epoch!==o.epoch||intent[0].file_hash!==v.file_hash||
    c.fingerprint!==digest({epoch:o.epoch,command_id:cmd.id,file_hash:v.file_hash});
  }))throw Error('DEVELOPMENT_REVIEW_EVIDENCE_REQUIRED');
  const reservations=this.db.prepare('SELECT * FROM development_model_requests WHERE request_id=? ORDER BY rowid').all(r.id);
  if(reservations.some(m=>m.job_id!==job.id||m.approval_id!==r.approval_id||m.policy!==r.policy||
     !this.jobs.db.prepare('SELECT 1 FROM runs WHERE id=? AND job_id=? AND claim=?').get(m.run_id,job.id,m.claim)))throw Error('DEVELOPMENT_MODEL_RUN_MISMATCH');
  const budget=this.runtime.modelBudget.view(r.id);if(budget.used>=budget.limit)throw Error('DEVELOPMENT_MODEL_BUDGET');
  const base={request_id:r.id,authority_hash:r.authority_hash,epoch:r.epoch,expected_hash:r.expected_hash,workspace_identity:r.workspace_identity,
   job:{id:job.id,goal:job.goal,policy:job.policy,approved_by:job.approved_by,attempts:job.attempts,version:job.version},run,writes,commands,operations,reservations,budget};
  return {base,context_hash:digest(base),job,r,run};
 }
 evidence(job_id){const c=this.context(job_id);return {evidence:{...c.base,max_runs:c.job.max_runs,status:c.job.status,grants_execution:false},proof_hash:digest({...c.base,max_runs:c.job.max_runs,status:c.job.status})};}
 review(a){
  if(!a||Object.keys(a).some(k=>!['job_id','run_id','event_id','proof_hash','note'].includes(k))||typeof a.event_id!=='string'||!a.event_id||a.event_id.length>256||
     typeof a.note!=='string'||!a.note.trim()||a.note.length>2000||!/^[a-f0-9]{64}$/.test(a.proof_hash??''))throw Error('DEVELOPMENT_REVIEW_INVALID');
  const fp=digest(a);let prior=this.db.prepare('SELECT * FROM development_workspace_reviews WHERE event_id=?').get(a.event_id);
  if(prior&&prior.fingerprint!==fp)throw Error('DEVELOPMENT_REVIEW_CONFLICT');
  if(prior?.state==='applied')return {...JSON.parse(prior.result),replayed:true};
  this.gate.store.tx(()=>{
   const c=this.context(a.job_id);if(c.run.id!==a.run_id)throw Error('DEVELOPMENT_REVIEW_STALE_EVIDENCE');
   if(!prior){
    if(this.evidence(a.job_id).proof_hash!==a.proof_hash)throw Error('DEVELOPMENT_REVIEW_STALE_EVIDENCE');
    if(c.job.status!=='needs_review'||c.job.max_runs!==c.job.attempts||c.job.max_runs>=10||c.job.max_runs<1)throw Error('DEVELOPMENT_REVIEW_STATE');
    if(this.db.prepare('SELECT 1 FROM development_workspace_reviews WHERE run_id=?').get(a.run_id))throw Error('DEVELOPMENT_REVIEW_CONFLICT');
    const record={context_hash:c.context_hash,max_runs:c.job.max_runs,attempts:c.job.attempts,proof_hash:a.proof_hash,note:a.note};
    this.db.prepare("INSERT INTO development_workspace_reviews VALUES (?,?,?,?,?,'prepared',?,NULL,?)").run(a.event_id,fp,a.run_id,c.r.id,a.job_id,canonical(record),this.gate.now());
    this.gate.event(c.r.id,'workspace_review_prepared',{event_id:a.event_id,run_id:a.run_id,proof_hash:a.proof_hash});
   }
  });
  prior=this.db.prepare('SELECT * FROM development_workspace_reviews WHERE event_id=?').get(a.event_id);const record=JSON.parse(prior.record);
  const check=()=>{const c=this.context(a.job_id);if(c.context_hash!==record.context_hash||c.run.id!==a.run_id)throw Error('DEVELOPMENT_REVIEW_STALE_EVIDENCE');return c;};
  this.jobs.tx(()=>{
   const c=check(),event=this.jobs.db.prepare("SELECT data FROM job_events WHERE job_id=? AND type='workspace_review_paused' ORDER BY seq DESC LIMIT 1").get(a.job_id);
   if(event&&JSON.parse(event.data).event_id===a.event_id){
    if(c.job.max_runs!==record.max_runs+1)throw Error('DEVELOPMENT_REVIEW_STATE');
   }else{
    if(c.job.status!=='needs_review'||c.job.max_runs!==record.max_runs)throw Error('DEVELOPMENT_REVIEW_STATE');
    this.jobs.db.prepare('UPDATE jobs SET max_runs=max_runs+1 WHERE id=?').run(a.job_id);
    this.jobs.event(a.job_id,'workspace_review_paused',{event_id:a.event_id,run_id:a.run_id,old_max_runs:record.max_runs,new_max_runs:record.max_runs+1});
   }
   // Restart may have conservatively returned a half-reviewed paused job to
   // needs_review. Reapply only this same recorded transition, never another run.
   this.jobs.db.prepare("UPDATE jobs SET status='paused',error=NULL,due=? WHERE id=?").run(this.jobs.now(),a.job_id);
  });
  return this.gate.store.tx(()=>{
   const c=check();if(c.job.status!=='paused'||c.job.max_runs!==record.max_runs+1)throw Error('DEVELOPMENT_REVIEW_STATE');
   for(const m of c.base.reservations.filter(x=>x.state==='reserved')){
    this.db.prepare("UPDATE development_model_requests SET state='unknown',code='HOST_INTERRUPTED_UNCONFIRMED',finished=? WHERE id=? AND state='reserved'").run(this.gate.now(),m.id);
    this.gate.event(c.r.id,'model_observed',{reservation:m.id,state:'unknown',code:'HOST_INTERRUPTED_UNCONFIRMED'});
   }
   // Keep request sequence/manifest/approval and all budgets. queued still owns
   // its original FIFO position; only a separate explicit job resume can claim it.
   this.db.prepare("UPDATE development_requests SET state='queued',epoch=NULL,error=NULL WHERE id=?").run(c.r.id);
   this.db.prepare('UPDATE tasks SET busy=0,blocked=0,epoch=epoch+1 WHERE id=?').run(c.r.task_id);
   const result={job_id:a.job_id,request_id:c.r.id,failed_run_id:a.run_id,prior_session_id:c.run.session_id,event_id:a.event_id,
    status:'paused',request_state:'queued',attempts_retained:c.job.attempts,max_runs:c.job.max_runs,prior_epoch:c.r.epoch,
    invalidated_epoch:c.r.epoch+1,expected_hash:c.r.expected_hash,model_budget:this.runtime.modelBudget.view(c.r.id),
    grants_execution:false,budget_reset:false,starts_worker:false};
   this.db.prepare("UPDATE development_workspace_reviews SET state='applied',result=? WHERE event_id=?").run(canonical(result),a.event_id);
   this.gate.event(c.r.id,'workspace_review_applied',result);return result;
  });
 }
 checkpoint(job){
  const r=this.runtime.requestFor(job),row=this.db.prepare("SELECT result FROM development_workspace_reviews WHERE request_id=? AND state='applied' ORDER BY rowid DESC LIMIT 1").get(r.id);
  if(!row)return null;const result=JSON.parse(row.result);
  return {resumed:true,failed_run_id:result.failed_run_id,prior_session_id:result.prior_session_id,attempts_retained:result.attempts_retained,
   current_workspace_sha256:r.expected_hash,...this.gate.progress(r.id),model_budget:this.runtime.modelBudget.view(r.id)};
 }
}
