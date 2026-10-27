// Operator-only reconciliation, never invoked by startup, model tools or a timer.
// Sealed process evidence can close an operation, not release a task or prove push.
const fail=c=>{throw Error('DELIVERY_PUSH_RECOVERY_'+c);};
export class DeliveryPushRecovery {
 constructor({journal,receipts,executor,quiescent=()=>false,enabled=false}){Object.assign(this,{j:journal,receipts,executor,quiescent,enabled});}
 guard(id,epoch){
  if(this.enabled!==true)fail('DISABLED');if(this.quiescent()!==true)fail('NOT_QUIESCENT');
  const r=this.j.fence(id,epoch,['needs_review']),i=this.j.intent(r);
  if(i.kind!=='push-execution-intent-v1'||!r.dispatched||this.j.store.task(r.task_id).revision!==i.task_revision)fail('ACTION_INVALID');return i;
 }
 inspect(id,epoch){
  this.guard(id,epoch);
  return {action_id:id,epoch,operations:this.j.db.prepare('SELECT id,state FROM delivery_operations WHERE action_id=? ORDER BY rowid').all(id).map(o=>{
   try{return {...o,evidence:this.receipts.inspect(o.id)};}catch{return {...o,evidence:null,error:'PROCESS_RECEIPT_UNVERIFIED'};}
  }),remote_checked_now:false,task_released:false,retry_authorized:false};
 }
 closeOperation(id,epoch,operation_id,fingerprint){
  this.guard(id,epoch);const o=this.j.operation(operation_id);
  if(o.action_id!==id||o.epoch!==epoch)fail('OPERATION_MISMATCH');
  return this.receipts.reconcile(operation_id,fingerprint);
 }
 async settle(id,epoch,{signal}={}){
  const i=this.guard(id,epoch);if(this.j.unfinished(id))fail('DRAIN_REQUIRED');
  try{
   await this.executor.readback(i,{signal});this.guard(id,epoch);
   return {...this.j.finish(id,epoch),retry_authorized:false};
  }catch{
   // Retain uncertainty without acquiring a new generation or repeating a send.
   this.guard(id,epoch);this.j.event(id,'remote_readback_failed',{epoch,error:'REMOTE_READBACK_UNVERIFIED'});return {action_id:id,state:'needs_review',error:'REMOTE_READBACK_UNVERIFIED',task_released:false,retry_authorized:false};
  }
 }
}
