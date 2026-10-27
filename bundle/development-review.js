import {canonical,digest} from './approval-ledger.js';

// Operator-only, offline recovery. Not registered as a model tool or remote RPC.
// The caller must hold the scheduler's exclusive lock with the Host stopped.
// Across the two databases, the task remains fenced until the final transaction.
export function recoverZeroWriteDevelopment({gate,jobs,assertExclusive},a){
 if(typeof assertExclusive!=='function'||!a||typeof a.event_id!=='string'||!a.event_id||a.event_id.length>128||
    typeof a.operator_note!=='string'||!a.operator_note.trim()||a.operator_note.length>2000||
    !Number.isInteger(a.expected_epoch)||a.expected_epoch<1||
    !/^[a-f0-9]{64}$/.test(a.authority_hash??'')||!/^[a-f0-9]{64}$/.test(a.evidence_sha256??''))throw Error('DEVELOPMENT_REVIEW_INVALID');
 assertExclusive();if(gate.inflight.size)throw Error('DEVELOPMENT_NOT_DRAINED');
 const db=gate.db,fp=digest(a);
 db.exec(`CREATE TABLE IF NOT EXISTS development_operator_reviews(
  event_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,run_id TEXT UNIQUE NOT NULL,request_id TEXT NOT NULL,
  job_id TEXT NOT NULL,state TEXT NOT NULL,record TEXT NOT NULL,result TEXT,created INTEGER NOT NULL);`);
 let review=db.prepare('SELECT * FROM development_operator_reviews WHERE event_id=?').get(a.event_id);
 if(review&&review.fingerprint!==fp)throw Error('DEVELOPMENT_REVIEW_CONFLICT');
 if(review?.state==='applied')return {...JSON.parse(review.result),replayed:true};
 if(!review&&db.prepare('SELECT 1 FROM development_operator_reviews WHERE run_id=?').get(a.failed_run_id))throw Error('DEVELOPMENT_REVIEW_CONFLICT');
 const binding=db.prepare('SELECT request_id FROM development_jobs WHERE job_id=?').get(a.job_id);
 if(!binding)throw Error('DEVELOPMENT_JOB_UNBOUND');
 const check=()=>{
  assertExclusive();if(gate.inflight.size)throw Error('DEVELOPMENT_NOT_DRAINED');
  const r=gate.row(binding.request_id),t=gate.store.task(r.task_id),job=jobs.get(a.job_id);
  const run=jobs.db.prepare('SELECT * FROM runs WHERE id=?').get(a.failed_run_id);
  if(r.state!=='needs_review'||r.node!=='cloud'||r.epoch!==a.expected_epoch||
     t.epoch!==a.expected_epoch||t.owner!=='cloud'||!t.busy||!t.blocked||
     r.expected_hash!==null||r.test_result!==null||job.task_id!==r.task_id||job.kind!=='development'||job.version!=='0.21.0'||
     job.approved_by!==r.approval_id||canonical(JSON.parse(job.policy))!==canonical(JSON.parse(r.policy))||
     !run||run.job_id!==job.id||run.status!=='failed'||!run.finished||job.claim!==null||
     jobs.db.prepare("SELECT 1 FROM runs WHERE status='running'").get())throw Error('DEVELOPMENT_REVIEW_STATE');
  const latest=jobs.db.prepare('SELECT id FROM runs WHERE job_id=? ORDER BY started DESC,rowid DESC LIMIT 1').get(job.id);
  if(latest?.id!==run.id||job.attempts!==jobs.db.prepare('SELECT count(*) n FROM runs WHERE job_id=?').get(job.id).n)throw Error('DEVELOPMENT_REVIEW_STATE');
  if(db.prepare('SELECT 1 FROM development_writes w JOIN development_requests r ON r.id=w.request_id WHERE r.approval_id=?').get(r.approval_id)||
     db.prepare("SELECT 1 FROM intents WHERE task_id=? AND status IN ('granted','writing')").get(r.task_id))throw Error('DEVELOPMENT_REVIEW_EFFECTS_PRESENT');
  if(gate.unresolved(r.id))throw Error('DEVELOPMENT_CHILD_DRAIN_UNKNOWN');
  if(r.authority_hash!==a.authority_hash)throw Error('DEVELOPMENT_APPROVAL_CHANGED');
  // Only this transaction may temporarily remove this exact review fence. Every
  // other validity check still runs, and any exception rolls the removal back.
  db.prepare('UPDATE tasks SET blocked=0 WHERE id=?').run(r.task_id);
  const auth=gate.authority(r.task_id,r.approval_id,JSON.parse(r.policy));
  if(auth.hash!==a.authority_hash)throw Error('DEVELOPMENT_APPROVAL_CHANGED');
  gate.assertWorkspace(r,auth.workspace);
  auth.workspace.check(null);
  db.prepare('UPDATE tasks SET blocked=1 WHERE id=?').run(r.task_id);
  return {r,t,job};
 };
 gate.store.tx(()=>{
  const {r,job}=check();
  if(!review){
   if(job.status!=='needs_review'||job.attempts!==job.max_runs||job.max_runs>=10)throw Error('DEVELOPMENT_REVIEW_STATE');
   const record={...a,attempts:job.attempts,old_max_runs:job.max_runs,old_job_error:job.error,old_gate_error:r.error};
   db.prepare("INSERT INTO development_operator_reviews VALUES (?,?,?,?,?,'prepared',?,NULL,?)").run(a.event_id,fp,a.failed_run_id,r.id,job.id,canonical(record),gate.now());
   gate.event(r.id,'operator_review_prepared',record);
  }
 });
 review=db.prepare('SELECT * FROM development_operator_reviews WHERE event_id=?').get(a.event_id);
 const record=JSON.parse(review.record);
 jobs.tx(()=>{
  assertExclusive();const j=jobs.get(a.job_id);
  const event=jobs.db.prepare("SELECT data FROM job_events WHERE job_id=? AND type='operator_zero_write_retry' ORDER BY seq DESC LIMIT 1").get(j.id);
  if(event&&JSON.parse(event.data).event_id===a.event_id){
   if(j.status!=='paused'||j.attempts!==record.attempts||j.max_runs!==record.old_max_runs+1)throw Error('DEVELOPMENT_REVIEW_STATE');
   return;
  }
  if(j.status!=='needs_review'||j.attempts!==record.attempts||j.max_runs!==record.old_max_runs||j.claim!==null)throw Error('DEVELOPMENT_REVIEW_STATE');
  jobs.db.prepare("UPDATE jobs SET status='paused',max_runs=max_runs+1,due=?,error=NULL WHERE id=?").run(jobs.now(),j.id);
  jobs.event(j.id,'operator_zero_write_retry',{event_id:a.event_id,failed_run_id:a.failed_run_id,evidence_sha256:a.evidence_sha256,old_max_runs:record.old_max_runs,new_max_runs:record.old_max_runs+1});
 });
 return gate.store.tx(()=>{
  const {r,t,job}=check();
  if(job.status!=='paused'||job.attempts!==record.attempts||job.max_runs!==record.old_max_runs+1)throw Error('DEVELOPMENT_REVIEW_STATE');
  const result={job_id:job.id,request_id:r.id,recovery_event:a.event_id,prior_failed_run:a.failed_run_id,
   state:'paused',attemptsRetained:job.attempts,max_runs:job.max_runs,new_epoch:t.epoch+1,appliedWrites:0};
  db.prepare("UPDATE development_requests SET state='queued',epoch=NULL,error=NULL WHERE id=?").run(r.id);
  db.prepare("UPDATE tasks SET blocked=0,busy=0,epoch=epoch+1,checkpoint='Operator reviewed zero effects; one additional bounded run authorized' WHERE id=?").run(r.task_id);
  gate.event(r.id,'operator_review_applied',result);
  db.prepare("UPDATE development_operator_reviews SET state='applied',result=? WHERE event_id=?").run(canonical(result),a.event_id);
  return result;
 });
}
