import {randomUUID} from 'node:crypto';
import {canonical} from './approval-ledger.js';
import {developmentSpec} from './development-contract.js';

// Internal dispatch accounting, never an execution/approval authority or model tool.
// Reservations survive all errors and restarts. No automatic refunds or new-request reset.
export class DevelopmentModelBudget {
 constructor(gate,jobs){
  this.gate=gate;this.jobs=jobs;this.db=gate.db;
  this.db.exec(`CREATE TABLE IF NOT EXISTS development_model_requests(
   id TEXT PRIMARY KEY,request_id TEXT NOT NULL,approval_id TEXT NOT NULL,job_id TEXT NOT NULL,
   run_id TEXT NOT NULL,claim TEXT NOT NULL,epoch INTEGER NOT NULL,policy TEXT NOT NULL,
   max_tokens INTEGER NOT NULL,state TEXT NOT NULL,code TEXT,created INTEGER NOT NULL,finished INTEGER);`);
 }
 view(id){
  const r=this.gate.row(id),spec=developmentSpec(this.gate.ledger.view(r.approval_id).proposal.development);
  const rows=this.db.prepare('SELECT state,count(*) n FROM development_model_requests WHERE approval_id=? GROUP BY state').all(r.approval_id);
  return {used:rows.reduce((n,r)=>n+r.n,0),limit:spec.max_model_requests??null,states:Object.fromEntries(rows.map(r=>[r.state,r.n])),
   meaning:'dispatch reservations, not provider billing or task completion'};
 }
 reserve(id,job,request){
  if(!request||request.purpose!=='worker'||request.maxTokens!==2048)throw Error('DEVELOPMENT_MODEL_RESERVATION_INVALID');
  const current=this.jobs.assertClaim(job.id,job.claim);
  if(current.kind!=='development'||current.version!=='0.22.0'||!this.jobs.db.prepare("SELECT 1 FROM runs WHERE id=? AND job_id=? AND claim=? AND status='running'").get(job.run_id,job.id,job.claim))throw Error('DEVELOPMENT_MODEL_RUN_MISMATCH');
  return this.gate.store.tx(()=>{
   const row=this.gate.row(id),{r,spec}=this.gate.assert(id,'cloud',row.epoch);
   if(spec.kind!=='workspace-v1'||r.task_id!==current.task_id||r.approval_id!==current.approved_by||r.policy!==canonical(JSON.parse(current.policy)))throw Error('DEVELOPMENT_MODEL_RUN_MISMATCH');
   const policy=JSON.parse(current.policy);
   if(request.provider!==policy.provider||request.model!==policy.model||request.reasoningEffort!==policy.reasoningEffort)throw Error('DEVELOPMENT_MODEL_MISMATCH');
   const used=this.db.prepare('SELECT count(*) n FROM development_model_requests WHERE approval_id=?').get(r.approval_id).n;
   if(used>=spec.max_model_requests)throw Error('DEVELOPMENT_MODEL_BUDGET');
   const reservation='development-model-'+randomUUID();
   this.db.prepare("INSERT INTO development_model_requests VALUES (?,?,?,?,?,?,?,?,?,'reserved',NULL,?,NULL)")
    .run(reservation,id,r.approval_id,job.id,job.run_id,job.claim,r.epoch,r.policy,request.maxTokens,this.gate.now());
   this.gate.event(id,'model_reserved',{reservation,job_id:job.id,run_id:job.run_id,epoch:r.epoch,used:used+1,limit:spec.max_model_requests,model_policy:policy});
   return {id:reservation,used:used+1,limit:spec.max_model_requests};
  });
 }
 settle(id,state,code=null){
  if(!['succeeded','failed','unknown'].includes(state)||code!==null&&!/^[A-Z_]{1,80}$/.test(code))throw Error('DEVELOPMENT_MODEL_RECEIPT_INVALID');
  this.gate.store.tx(()=>{
   const row=this.db.prepare('SELECT * FROM development_model_requests WHERE id=?').get(id);if(!row)throw Error('DEVELOPMENT_MODEL_RESERVATION_MISSING');
   if(row.state!=='reserved')throw Error('DEVELOPMENT_MODEL_ALREADY_SETTLED');
   this.db.prepare('UPDATE development_model_requests SET state=?,code=?,finished=? WHERE id=?').run(state,code,this.gate.now(),id);
   this.gate.event(row.request_id,'model_observed',{reservation:id,state,code});
  });
 }
}
