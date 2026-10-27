import {DevelopmentReconciliation} from './development-reconciliation.js';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {canonical,digest} from './approval-ledger.js';
const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
const id=x=>typeof x==='string'&&x.length>0&&x.length<=256;
const uuid=x=>typeof x==='string'&&/^[a-f0-9-]{36}$/.test(x);
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const fields=(a,n)=>{if(!object(a)||Object.keys(a).some(k=>!n.includes(k)))throw Error('DEVELOPMENT_BRIDGE_INVALID');};
const binding=['id','endpoint_id','ticket','epoch'];
// Explicit opt-in internal protocol for the shared CLOUD checkout. The authenticated
// caller may propose content; it does not receive raw Git/shell access or a local FS lease.
// All actual mutations and child processes stay behind the same DevelopmentGate.
export class DevelopmentBridge {
 constructor(runtime){
  this.runtime=runtime;this.g=runtime.g;this.gate=runtime.gate;this.db=this.gate.db;
  this.db.exec(`CREATE TABLE IF NOT EXISTS development_bridge_claims(
   request_id TEXT PRIMARY KEY,node TEXT NOT NULL,endpoint_id TEXT NOT NULL,ticket TEXT NOT NULL,epoch INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS development_bridge_tests(
   id TEXT PRIMARY KEY,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,state TEXT NOT NULL,result TEXT);`);
  this.db.exec('CREATE TABLE IF NOT EXISTS development_bridge_claim_receipts(request_id TEXT PRIMARY KEY,node TEXT NOT NULL,endpoint_id TEXT NOT NULL,recovery_hash TEXT NOT NULL,epoch INTEGER NOT NULL);');
  this.reconciliation=new DevelopmentReconciliation(this);
 }
 authorization(r,node){
  if(r.node!==node)throw Error('DEVELOPMENT_BRIDGE_ROLE_DENIED');
  const a=this.gate.authority(r.task_id,r.approval_id,JSON.parse(r.policy));
  if(a.spec.kind==='workspace-v1'&&!this.runtime.workspaceEnabled)throw Error('DEVELOPMENT_WORKSPACE_DISABLED');
  // Old cloud-only proposals cannot silently grant a new cross-endpoint capability.
  if(!a.spec.executors?.includes(node))throw Error('DEVELOPMENT_BRIDGE_EXECUTOR_REQUIRED');
  if(a.hash!==r.authority_hash)throw Error('DEVELOPMENT_APPROVAL_CHANGED');
  this.gate.assertWorkspace(r,a.workspace);return a;
 }
 bound(a,node){
  if(!id(a.id)||!uuid(a.endpoint_id)||!uuid(a.ticket)||!Number.isSafeInteger(a.epoch)||a.epoch<1)throw Error('DEVELOPMENT_BRIDGE_INVALID');
  const c=this.db.prepare('SELECT * FROM development_bridge_claims WHERE request_id=?').get(a.id);
  if(!c||c.node!==node||c.endpoint_id!==a.endpoint_id||!same(c.ticket,a.ticket)||c.epoch!==a.epoch)throw Error('DEVELOPMENT_BRIDGE_STALE_FENCE');
  const r=this.gate.row(a.id);if(r.node!==node||r.epoch!==a.epoch)throw Error('DEVELOPMENT_BRIDGE_STALE_FENCE');return r;
 }
 status(r){return {...this.gate.view(r.id),waiting_reason:this.gate.waiting(r.id),storage_host:'cloud',drain_scope:'managed_cloud_io_only',starts_worker:false,grants_execution:false};}
 async call(method,a,node){
  if(!['local','cloud'].includes(node))throw Error('DEVELOPMENT_BRIDGE_ROLE_DENIED');
  // Separate wire method family: old clients cannot mutate or review the new contract.
  const workspace=method.startsWith('workspace_bridge_');
  if(workspace){if(!this.runtime.workspaceEnabled)throw Error('DEVELOPMENT_WORKSPACE_DISABLED');method=method.replace('workspace_bridge_','development_bridge_');if(['development_bridge_acquire','development_bridge_test'].includes(method))throw Error('METHOD_DENIED');}
  if(method!=='development_bridge_enqueue'&&id(a?.id)){
   const r=this.db.prepare('SELECT approval_id FROM development_requests WHERE id=?').get(a.id),spec=r&&this.gate.ledger.view(r.approval_id).proposal.development;
   if(r&&(spec?.kind==='workspace-v1')!==workspace)throw Error('DEVELOPMENT_CONTRACT_METHOD_MISMATCH');
  }
  if(['development_bridge_evidence','development_bridge_review'].includes(method))return this.reconciliation.call(method,a,node);
  if(method==='development_bridge_enqueue'){
   fields(a,['task_id','approval_id','policy','event_id']);
   if(!id(a.task_id)||!id(a.approval_id)||!id(a.event_id)||!object(a.policy))throw Error('DEVELOPMENT_BRIDGE_INVALID');
   await this.g.repositories.refresh(a.task_id);
   const auth=this.gate.authority(a.task_id,a.approval_id,a.policy);
   if((auth.spec.kind==='workspace-v1')!==workspace)throw Error('DEVELOPMENT_CONTRACT_METHOD_MISMATCH');
   if(!auth.spec.executors?.includes(node))throw Error('DEVELOPMENT_BRIDGE_EXECUTOR_REQUIRED');
   const r=this.gate.enqueue(node,{...a,event_id:'bridge:'+node+':'+a.event_id});return this.status(r);
  }
  if(method==='development_bridge_cancel'){
   fields(a,['id']);if(!id(a.id))throw Error('DEVELOPMENT_BRIDGE_INVALID');const r=this.gate.row(a.id);
   if(r.node!==node)throw Error('DEVELOPMENT_BRIDGE_ROLE_DENIED');
   if(r.state==='rejected'&&r.error==='DEVELOPMENT_QUEUE_CANCELLED')return {...this.status(r),replayed:true};
   if(r.state!=='queued')throw Error('DEVELOPMENT_NOT_QUEUED');
   this.gate.rejectQueued(r.id,'DEVELOPMENT_QUEUE_CANCELLED');return this.status(this.gate.row(r.id));
  }
  if(method==='development_bridge_status'){
   fields(a,['id']);if(!id(a.id))throw Error('DEVELOPMENT_BRIDGE_INVALID');const r=this.gate.row(a.id);
   if(r.node!==node)throw Error('DEVELOPMENT_BRIDGE_ROLE_DENIED');return this.status(r);
  }
  if(method==='development_bridge_claim_receipt'){
   fields(a,['id','endpoint_id','recovery_key']);if(!id(a.id)||!uuid(a.endpoint_id)||!uuid(a.recovery_key))throw Error('DEVELOPMENT_BRIDGE_INVALID');
   const receipt=this.db.prepare('SELECT * FROM development_bridge_claim_receipts WHERE request_id=?').get(a.id),c=this.db.prepare('SELECT * FROM development_bridge_claims WHERE request_id=?').get(a.id);
   if(!receipt||!c||receipt.node!==node||c.node!==node||receipt.endpoint_id!==a.endpoint_id||c.endpoint_id!==a.endpoint_id||receipt.epoch!==c.epoch||!same(receipt.recovery_hash,digest(a.recovery_key)))throw Error('DEVELOPMENT_CLAIM_RECEIPT_UNAVAILABLE');
   return {id:a.id,endpoint_id:c.endpoint_id,ticket:c.ticket,epoch:c.epoch,grants_execution:false,starts_worker:false};
  }
  if(['development_bridge_acquire','development_bridge_claim_acquire'].includes(method)){
   const recoverable=method==='development_bridge_claim_acquire';
   fields(a,recoverable?['id','endpoint_id','recovery_key']:['id','endpoint_id']);
   if(recoverable&&!uuid(a.recovery_key))throw Error('DEVELOPMENT_BRIDGE_INVALID');if(!id(a.id)||!uuid(a.endpoint_id))throw Error('DEVELOPMENT_BRIDGE_INVALID');
   const r=this.gate.row(a.id);if(r.node!==node)throw Error('DEVELOPMENT_BRIDGE_ROLE_DENIED');
   await this.g.repositories.refresh(r.task_id);this.authorization(r,node);
   const old=this.db.prepare('SELECT * FROM development_bridge_claims WHERE request_id=?').get(a.id);
   if(old){
    const receipt=this.db.prepare('SELECT * FROM development_bridge_claim_receipts WHERE request_id=?').get(a.id);
    if((recoverable||receipt)&&(!recoverable||!receipt||!same(receipt.recovery_hash,digest(a.recovery_key))))throw Error('DEVELOPMENT_CLAIM_RECEIPT_UNAVAILABLE');
    if(old.node!==node||old.endpoint_id!==a.endpoint_id||r.state!=='active'||r.epoch!==old.epoch)throw Error('DEVELOPMENT_BRIDGE_STALE_FENCE');
    this.gate.assert(r.id,node,old.epoch);return {acquired:true,...this.status(r),grants_execution:true,execution_scope:'bounded_shared_cloud_checkout',ticket:old.ticket,endpoint_id:old.endpoint_id};
   }
   // Claim and ticket are committed in the SAME transaction as the resource fence.
   const ticket=randomUUID(),claimed=this.gate.acquire(r.id,x=>{this.db.prepare('INSERT INTO development_bridge_claims VALUES (?,?,?,?,?)').run(x.id,node,a.endpoint_id,ticket,x.epoch);if(recoverable)this.db.prepare('INSERT INTO development_bridge_claim_receipts VALUES (?,?,?,?,?)').run(x.id,node,a.endpoint_id,digest(a.recovery_key),x.epoch);});
   if(!claimed.acquired)this.gate.event(r.id,'bridge_waiting',{node,reason:claimed.reason});
   return {...this.status(this.gate.row(r.id)),...claimed,...(claimed.acquired?{grants_execution:true,execution_scope:'bounded_shared_cloud_checkout',ticket,endpoint_id:a.endpoint_id}:{})};
  }
  const extra={development_bridge_read:workspace?['path']:[],development_bridge_write:['call_id','expected_hash','content',...(workspace?['path']:[])],...(workspace?{development_bridge_command:['call_id','expected_hash','command_id']}:{development_bridge_test:['call_id','expected_hash']}),development_bridge_finish:[],development_bridge_fail:[]}[method];
  if(!extra)throw Error('METHOD_DENIED');fields(a,[...binding,...extra]);let r=this.bound(a,node);
  if(method==='development_bridge_finish'&&r.state==='completed')return {...this.status(r),replayed:true};
  if(method==='development_bridge_fail'){
   if(!['active','needs_review'].includes(r.state))throw Error('DEVELOPMENT_BRIDGE_STALE_FENCE');
   this.gate.block(r.id,'DEVELOPMENT_ENDPOINT_REVIEW');return this.status(this.gate.row(r.id));
  }
  this.authorization(r,node);
  if(method==='development_bridge_read'){
   const result=this.gate.read(r.id,node,a.epoch,a.path);
   // A manifest hash is a CAS token; unrelated filenames are not approved read inputs.
   if(workspace){const {manifest,...visible}=result;return {...visible,storage_host:'cloud'};}
   return {...result,storage_host:'cloud'};
  }
  if(method==='development_bridge_write'){
   if(!id(a.call_id))throw Error('DEVELOPMENT_BRIDGE_INVALID');
   this.gate.admitWriteCall(r.id,node,a.epoch,a.call_id);
   await this.g.repositories.refresh(r.task_id);r=this.bound(a,node);
   this.authorization(r,node);return this.gate.write(r.id,node,a.epoch,a);
  }
  if(method==='development_bridge_command'){
   if(!id(a.call_id)||!id(a.command_id))throw Error('DEVELOPMENT_BRIDGE_INVALID');
   await this.g.repositories.refresh(r.task_id);r=this.bound(a,node);this.authorization(r,node);
   if(a.expected_hash!==r.expected_hash)throw Error('DEVELOPMENT_FILE_CONFLICT');
   // Gate owns the durable fingerprint, budget and drain barrier. A repeated HTTP
   // request cannot create a second container for an unresolved command.
   return this.gate.command(r.id,node,a.epoch,a);
  }
  if(method==='development_bridge_test'){
   if(!id(a.call_id))throw Error('DEVELOPMENT_BRIDGE_INVALID');
   this.gate.assert(r.id,node,a.epoch);if(a.expected_hash!==undefined&&a.expected_hash!==r.expected_hash)throw Error('DEVELOPMENT_FILE_CONFLICT');
   const key=r.id+':'+a.call_id,fp=digest({epoch:a.epoch,expected_hash:r.expected_hash}),old=this.db.prepare('SELECT * FROM development_bridge_tests WHERE id=?').get(key);
   if(old){if(old.fingerprint!==fp)throw Error('DEVELOPMENT_BRIDGE_CALL_CONFLICT');if(old.state!=='completed')throw Error('DEVELOPMENT_BRIDGE_TEST_UNCERTAIN');return {...JSON.parse(old.result),replayed:true};}
   // A timed-out HTTP request never starts a second child on retransmission.
   this.db.prepare("INSERT INTO development_bridge_tests VALUES (?,?,?,'running',NULL)").run(key,r.id,fp);
   try{const result=await this.gate.test(r.id,node,a.epoch);this.db.prepare("UPDATE development_bridge_tests SET state='completed',result=? WHERE id=?").run(canonical(result),key);return result;}
   catch(e){this.db.prepare("UPDATE development_bridge_tests SET state='needs_review' WHERE id=?").run(key);throw e;}
  }
  if(this.db.prepare("SELECT 1 FROM development_bridge_tests WHERE request_id=? AND state<>'completed'").get(r.id))throw Error('DEVELOPMENT_NOT_DRAINED');
  // No caller flag can override the actual cloud write/test barriers. A completed
  // fence revokes every old client operation, even if a local model is still idle/running.
  this.gate.finish(r.id,node,a.epoch,{agentDrained:true});return {...this.status(this.gate.row(r.id)),committed:false,pushed:false,published:false};
 }
}
