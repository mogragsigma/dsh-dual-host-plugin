import {join} from 'node:path';
import {DevelopmentAttention} from './development-attention.js';
import {DevelopmentContainer} from './development-container.js';
import {DevelopmentModelBudget} from './development-model-budget.js';
import {DevelopmentCommandReview} from './development-command-review.js';
import {DevelopmentWorkerReview} from './development-worker-review.js';
import {DevelopmentBridge} from './development-bridge.js';
import {DevelopmentGate} from './development-gate.js';
import {NativeDevelopmentWorker} from './development-worker.js';
export class DevelopmentRuntime {
 constructor(g,config){
  if(g.c.role!=='cloud'||!g.scheduler||config.enabled!==true)throw Error('DEVELOPMENT_DISABLED');
  this.g=g;this.workspaceEnabled=config.workspace?.enabled===true;
  const commands=this.workspaceEnabled?new DevelopmentContainer({directory:join(g.c.stateDir,'development-containers')}):null;
  this.gate=new DevelopmentGate({store:g.store,ledger:g.approvals,bindings:config.bindings??{},enabled:true,commands,now:g.now,busy:id=>[...(g.scheduler.active?.values()??[])].some(r=>r.task_id===id)||!!g.a2a?.busy(id)});
  g.store.db.exec('CREATE TABLE IF NOT EXISTS development_jobs(job_id TEXT PRIMARY KEY,request_id TEXT UNIQUE NOT NULL);');
  this.modelBudget=new DevelopmentModelBudget(this.gate,g.scheduler.jobs);
  this.worker=new NativeDevelopmentWorker(g.ctx,this);this.attention=new DevelopmentAttention(this);
  if(this.workspaceEnabled){const owner={assertExclusive:()=>{
   if(!g.scheduler.started||g.scheduler.closed||!g.scheduler.lock?.listening)throw Error('DEVELOPMENT_REVIEW_EXCLUSIVE_REQUIRED');
  }};this.commandReview=new DevelopmentCommandReview(this.gate,owner);this.workerReview=new DevelopmentWorkerReview(this,owner);}
  if(config.bridge===true)this.bridge=new DevelopmentBridge(this);
 }
 busy(id){return !!this.g.store.db.prepare("SELECT 1 FROM development_requests WHERE task_id=? AND state IN ('queued','active','needs_review')").get(id);}
 requestFor(job){const row=this.g.store.db.prepare('SELECT request_id FROM development_jobs WHERE job_id=?').get(job.id);if(!row)throw Error('DEVELOPMENT_JOB_UNBOUND');return this.gate.row(row.request_id);}
 assertVersion(job,r){
  if(!['0.21.0','0.22.0'].includes(job.version))throw Error('DEVELOPMENT_JOB_VERSION_REQUIRED');
  const workspace=this.g.approvals.view(r.approval_id).proposal.development?.kind==='workspace-v1';
  if(job.version!==(workspace?'0.22.0':'0.21.0'))throw Error('DEVELOPMENT_JOB_VERSION_REQUIRED');
  if(workspace&&!this.workspaceEnabled)throw Error('DEVELOPMENT_WORKSPACE_DISABLED');
 }
 assert(job){const r=this.requestFor(job);this.assertVersion(job,r);if(r.task_id!==job.task_id)throw Error('DEVELOPMENT_JOB_UNBOUND');return this.gate.assert(r.id,'cloud',r.epoch);}
 async schedule(a,{workspace=false}={}){
  const version=workspace?'0.22.0':'0.21.0';
  const previous=this.g.scheduler.jobs.db.prepare('SELECT version FROM jobs WHERE trigger_id=?').get('bounded-development:'+a.approval_id);
  if(previous&&previous.version!==version)throw Error('DEVELOPMENT_JOB_VERSION_REQUIRED');
  if((this.g.approvals.view(a.approval_id).proposal.development?.kind==='workspace-v1')!==workspace)throw Error('DEVELOPMENT_CONTRACT_METHOD_MISMATCH');
  if(workspace&&!this.workspaceEnabled)throw Error('DEVELOPMENT_WORKSPACE_DISABLED');
  await this.g.repositories.refresh(a.task_id);
  const r=this.gate.enqueue('cloud',{task_id:a.task_id,approval_id:a.approval_id,policy:a.model_policy,event_id:'development:'+a.approval_id});
  const head=this.g.catalog.head(a.task_id),job=this.g.scheduler.jobs.enqueue({task_id:a.task_id,trigger_id:'bounded-development:'+a.approval_id,kind:'development',goal:head.goal,policy:a.model_policy,max_runs:1,version});
  this.g.store.db.prepare('INSERT OR IGNORE INTO development_jobs VALUES (?,?)').run(job.id,r.id);
  // Only new, ledger-bound jobs transition; old waiting_capability approvals never revive.
  this.g.scheduler.jobs.db.prepare("UPDATE jobs SET status='queued',approved_by=? WHERE id=? AND status='waiting_approval'").run(a.approval_id,job.id);
  return {job_id:job.id,request:this.gate.view(r.id),status:this.g.scheduler.jobs.get(job.id).status};
 }
 canClaim(job){
  if(!['0.21.0','0.22.0'].includes(job.version))throw Error('DEVELOPMENT_JOB_VERSION_REQUIRED');
  const r=this.requestFor(job);this.assertVersion(job,r);try{return this.gate.acquire(r.id).acquired;}catch(e){this.gate.rejectQueued(r.id,/^DEVELOPMENT_[A-Z_]+$/.test(e.message)?e.message:'DEVELOPMENT_ADMISSION_FAILED');throw e;}
 }
 async run(job,signal){
  try{await this.g.repositories.refresh(job.task_id);this.assert(job);return await this.worker.run(job,signal);}
  catch(error){
   if(job.version==='0.22.0')try{const a=this.attention.record(job,error);error.developmentAttention={schema:1,summary:a.summary,question:a.question,run_id:job.run_id,grants_execution:false};}catch{/* Never replace the original failure or clear its fence when diagnostics are unavailable. */}
   throw error;
  }
 }
 finished(job){const r=this.requestFor(job);try{this.gate.finish(r.id,'cloud',r.epoch,{agentDrained:true});}catch(e){this.gate.block(r.id,'DEVELOPMENT_RESULT_REVIEW');throw e;}}
 failed(job){try{this.gate.block(this.requestFor(job).id,'DEVELOPMENT_BATCH_REVIEW');}catch{}}
 recover(){
  // Cross-database uncertainty never grants the file to another requester.
  this.gate.recover();
  for(const b of this.g.store.db.prepare('SELECT * FROM development_jobs').all()){
   const r=this.gate.row(b.request_id),job=this.g.scheduler.jobs.get(b.job_id);
   if(r.state==='needs_review'&&!['needs_review','cancelled'].includes(job.status))this.g.scheduler.jobs.db.prepare("UPDATE jobs SET status='needs_review',error='DEVELOPMENT_RECOVERY_REVIEW' WHERE id=?").run(job.id);
  }
 }
}
