import {randomUUID} from 'node:crypto';
import {digest} from './approval-ledger.js';

// One jobs-database transaction: retain the old budget/evidence and create at
// most one explicitly confirmed, one-batch, memory-only continuation.
export function applyInterventionJob(scheduler,operation){
 const jobs=scheduler.jobs,p=operation.plan,token='intervention:'+operation.id;
 const result=jobs.tx(()=>{
  const old=jobs.db.prepare('SELECT * FROM controls WHERE event_id=?').get(token);
  if(old){if(old.fingerprint!==digest(p))throw Error('INTERVENTION_CONFLICT');return JSON.parse(old.result);}
  const j=jobs.get(p.job_id);
  if(digest(j)!==p.job_hash)throw Error('INTERVENTION_CHANGED');
  if(p.action!=='end'&&scheduler.active.has(j.id))throw Error('INTERVENTION_NOT_DRAINED');
  let followup=null;
  if(['continue','answer'].includes(p.action)){
   followup='job-'+randomUUID();
   jobs.db.prepare("INSERT INTO jobs(id,trigger_id,fingerprint,task_id,kind,goal,policy,status,due,checkpoint,max_runs,version,created) VALUES (?,?,?,?, 'plan',?,?, 'queued',?, '{}',1,'0.33.0',?)").run(followup,token,digest(p),j.task_id,p.goal,j.policy,jobs.now(),jobs.now());
   jobs.event(followup,'intervention_authorized',{operation_id:operation.id,parent_job_id:j.id,new_batch_limit:1,original_attempts:j.attempts,original_max_runs:j.max_runs});
  }
  jobs.db.prepare("UPDATE jobs SET status='cancelled',claim=NULL WHERE id=?").run(j.id);
  jobs.db.prepare("UPDATE runs SET status='cancelled',finished=? WHERE job_id=? AND status='running'").run(jobs.now(),j.id);
  jobs.event(j.id,'intervention_closed',{operation_id:operation.id,action:p.action,followup_job_id:followup,history_retained:true});
  const r={job_id:j.id,followup_job_id:followup,state:followup?'queued':'ended',whole_task_completed:false};
  jobs.db.prepare('INSERT INTO controls VALUES (?,?,?)').run(token,digest(p),JSON.stringify(r));return r;
 });
 if(result.state==='ended')scheduler.active.get(p.job_id)?.controller.abort();
 return result;
}
