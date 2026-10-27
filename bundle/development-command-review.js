import {canonical,digest} from './approval-ledger.js';
import {workspacePlan} from './development-plan.js';
import {DevelopmentFiles} from './development-files.js';

// Internal operator API only. The exclusive Host owns its original scheduler
// socket; this does not imply the old Docker workload stopped. Never a model tool.
export class DevelopmentCommandReview {
 constructor(gate,{assertExclusive}={}){
  if(typeof assertExclusive!=='function')throw Error('DEVELOPMENT_REVIEW_EXCLUSIVE_REQUIRED');
  this.gate=gate;this.db=gate.db;this.assertExclusive=assertExclusive;this.active=new Set();
  this.db.exec(`CREATE TABLE IF NOT EXISTS development_command_reviews(
   event_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,operation_id TEXT UNIQUE NOT NULL,
   request_id TEXT NOT NULL,state TEXT NOT NULL,record TEXT NOT NULL,result TEXT,created INTEGER NOT NULL);`);
 }
 context(id,operation){
  const g=this.gate,r=g.row(id),t=g.store.task(r.task_id);this.assertExclusive(r.task_id);
  if(!g.enabled||g.inflight.has(id)||g.busy(r.task_id)||r.state!=='needs_review'||
     t.owner!==r.node||t.epoch!==r.epoch||!t.busy||!t.blocked)throw Error('DEVELOPMENT_REVIEW_STATE');
  const c=this.db.prepare('SELECT * FROM development_commands WHERE request_id=? AND operation_id=?').all(id,operation);
  const o=this.db.prepare('SELECT * FROM development_operations WHERE id=? AND request_id=?').get(operation,id);
  if(c.length!==1||!['running','needs_review'].includes(c[0].state)||c[0].result!==null||
     !o||o.kind!=='command'||o.epoch!==r.epoch||o.state==='closed')throw Error('DEVELOPMENT_REVIEW_STATE');
  const events=type=>this.db.prepare('SELECT data FROM development_events WHERE request_id=? AND type=? ORDER BY seq').all(id,type).map(x=>JSON.parse(x.data)).filter(x=>x.operation===operation);
  const intents=events('command_intent'),containers=events('command_container');
  if(intents.length!==1||containers.length!==1||events('command_drained').length)throw Error('DEVELOPMENT_REVIEW_EVIDENCE_REQUIRED');
  const intent=intents[0],container=containers[0],v=g.ledger.view(r.approval_id),spec=workspacePlan(v.proposal.development);
  const hash=digest({approval:v.id,proposal_hash:v.proposal_hash,spec}),binding=g.bindings[r.task_id];
  if(v.task_id!==r.task_id||v.proposal.scopes.length!==1||v.proposal.scopes[0]!=='develop'||!v.proposal.repository||
     canonical(v.proposal.model_policy)!==canonical(JSON.parse(r.policy))||hash!==r.authority_hash||binding?.approval_hash!==hash)
   throw Error('DEVELOPMENT_APPROVAL_CHANGED');
  const command=spec.commands.find(x=>x.id===c[0].command_id);
  if(!command||intent.command_id!==command.id||intent.epoch!==o.epoch||intent.file_hash!==r.expected_hash||
     c[0].fingerprint!==digest({epoch:o.epoch,command_id:command.id,file_hash:intent.file_hash})||
     !/^[a-f0-9]{64}$/.test(container.id??'')||container.name!==g.commands?.name(operation))throw Error('DEVELOPMENT_REVIEW_EVIDENCE_REQUIRED');
  const workspace=new DevelopmentFiles(binding,spec,v.proposal.repository);g.assertWorkspace(r,workspace);workspace.check(r.expected_hash);
  // Current approval validity is deliberately NOT an execution grant here:
  // a revoked/expired task may still have its exact orphaned container stopped.
  const evidence={schema:1,request_id:id,operation_id:operation,command_record:c[0],operation:o,
   authority_hash:hash,epoch:r.epoch,expected_hash:r.expected_hash,workspace_identity:r.workspace_identity,
   container_id:container.id,command_hash:digest(command),grants_execution:false};
  return {evidence,context_hash:digest(evidence),target:{operation,container_id:container.id,command},r};
 }
 async evidence(id,operation){
  const before=this.context(id,operation),observed=await this.gate.commands.observeForReview(before.target),after=this.context(id,operation);
  if(before.context_hash!==after.context_hash)throw Error('DEVELOPMENT_REVIEW_STALE_EVIDENCE');
  const evidence={...before.evidence,observed};return {evidence,proof_hash:digest(evidence)};
 }
 async review(a){
  if(!a||Object.keys(a).some(k=>!['request_id','operation_id','event_id','proof_hash','note','stop_running'].includes(k))||
     typeof a.event_id!=='string'||!a.event_id||a.event_id.length>256||typeof a.note!=='string'||!a.note.trim()||a.note.length>2000||
     !/^[a-f0-9]{64}$/.test(a.proof_hash??'')||typeof a.stop_running!=='boolean')throw Error('DEVELOPMENT_REVIEW_INVALID');
  const fp=digest(a),prior=this.db.prepare('SELECT * FROM development_command_reviews WHERE event_id=?').get(a.event_id);
  if(prior&&prior.fingerprint!==fp)throw Error('DEVELOPMENT_REVIEW_CONFLICT');
  if(prior?.state==='applied')return {...JSON.parse(prior.result),replayed:true};
  if(this.active.has(a.operation_id))throw Error('DEVELOPMENT_REVIEW_IN_FLIGHT');
  this.active.add(a.operation_id);
  try{
   if(!prior){
    const snapshot=await this.evidence(a.request_id,a.operation_id);
    if(snapshot.proof_hash!==a.proof_hash)throw Error('DEVELOPMENT_REVIEW_STALE_EVIDENCE');
    if(snapshot.evidence.observed.status==='running'&&!a.stop_running)throw Error('DEVELOPMENT_CONTAINER_STOP_CONFIRMATION_REQUIRED');
    const ctx=this.context(a.request_id,a.operation_id);
    const {observed:ignored,...base}=snapshot.evidence;
    if(ctx.context_hash!==digest(base))throw Error('DEVELOPMENT_REVIEW_STALE_EVIDENCE');
    this.gate.store.tx(()=>{
     if(this.db.prepare('SELECT 1 FROM development_command_reviews WHERE operation_id=?').get(a.operation_id))throw Error('DEVELOPMENT_REVIEW_CONFLICT');
     const record={context_hash:ctx.context_hash,started_at:snapshot.evidence.observed.started_at,proof_hash:a.proof_hash,note:a.note};
     this.db.prepare("INSERT INTO development_command_reviews VALUES (?,?,?,?,'prepared',?,NULL,?)").run(a.event_id,fp,a.operation_id,a.request_id,canonical(record),this.gate.now());
     this.gate.event(a.request_id,'command_review_prepared',{event_id:a.event_id,operation:a.operation_id,proof_hash:a.proof_hash});
    });
   }
   const row=this.db.prepare('SELECT * FROM development_command_reviews WHERE event_id=?').get(a.event_id),record=JSON.parse(row.record);
   let ctx=this.context(a.request_id,a.operation_id);
   if(ctx.context_hash!==record.context_hash)throw Error('DEVELOPMENT_REVIEW_STALE_EVIDENCE');
   const observed=await this.gate.commands.stopForReview(ctx.target,{stop_running:a.stop_running,started_at:record.started_at});
   // The adapter may have stopped the workload while the Host failed. Retrying
   // this same prepared event re-inspects the same ID, never starts a new command.
   ctx=this.context(a.request_id,a.operation_id);
   if(ctx.context_hash!==record.context_hash)throw Error('DEVELOPMENT_REVIEW_STALE_EVIDENCE');
   if(observed.status!=='exited'||observed.container_id!==ctx.target.container_id||observed.operation!==a.operation_id||
      observed.command_hash!==digest(ctx.target.command)||observed.image!==ctx.target.command.image||observed.started_at!==record.started_at)
    throw Error('DEVELOPMENT_CONTAINER_DRAIN_UNKNOWN');
   return this.gate.store.tx(()=>{
    if(this.context(a.request_id,a.operation_id).context_hash!==record.context_hash)throw Error('DEVELOPMENT_REVIEW_STALE_EVIDENCE');
    const receipt={command_id:ctx.target.command.id,command_hash:observed.command_hash,image:observed.image,file_hash:ctx.r.expected_hash,
     passed:false,drained:true,started:true,exit_code:observed.exit_code,code:'DEVELOPMENT_COMMAND_INTERRUPTED_REVIEWED',
     output:'',stderr:'',container_id:observed.container_id,review_event:a.event_id};
    this.db.prepare("UPDATE development_operations SET state='closed',closed=?,exit_code=?,signal='OPERATOR_REVIEW' WHERE id=?").run(this.gate.now(),observed.exit_code,a.operation_id);
    this.db.prepare("UPDATE development_commands SET state='completed',result=? WHERE operation_id=?").run(canonical(receipt),a.operation_id);
    this.db.prepare('UPDATE development_requests SET test_result=NULL WHERE id=?').run(a.request_id);
    this.gate.event(a.request_id,'command_drained',{operation:a.operation_id,container_id:observed.container_id,code:observed.exit_code,signal:'OPERATOR_REVIEW',observed});
    const result={request_id:a.request_id,operation_id:a.operation_id,event_id:a.event_id,drained:true,test_passed:false,
     request_state:'needs_review',grants_execution:false,budget_reset:false,starts_worker:false,receipt};
    this.db.prepare("UPDATE development_command_reviews SET state='applied',result=? WHERE event_id=?").run(canonical(result),a.event_id);
    this.gate.event(a.request_id,'command_review_applied',result);return result;
   });
  }finally{this.active.delete(a.operation_id);}
 }
 async cleanup(event_id){
  const row=this.db.prepare("SELECT * FROM development_command_reviews WHERE event_id=? AND state='applied'").get(event_id);
  if(!row)throw Error('DEVELOPMENT_REVIEW_STATE');
  const r=this.gate.row(row.request_id);this.assertExclusive(r.task_id);
  const result=JSON.parse(row.result),record=JSON.parse(row.record),spec=workspacePlan(this.gate.ledger.view(r.approval_id).proposal.development);
  const command=spec.commands.find(x=>digest(x)===result.receipt.command_hash);
  if(!command)throw Error('DEVELOPMENT_APPROVAL_CHANGED');
  await this.gate.commands.cleanupReviewed({operation:row.operation_id,container_id:result.receipt.container_id,command},record.started_at);
  this.gate.event(r.id,'command_review_cleanup',{event_id,operation:row.operation_id});
  return {cleaned:true,grants_execution:false};
 }
}
