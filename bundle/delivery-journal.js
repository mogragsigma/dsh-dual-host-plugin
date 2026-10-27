// Internal, disabled-by-default commit journal. It never calls Git or executes an effect.
// Only the opt-in cloud runtime constructs this class; tools never supply adapters.
import {deliveryWaiting} from './delivery-state.js';
import {randomUUID} from 'node:crypto';
import {canonical,digest} from './approval-ledger.js';
import {verifyObjects} from './delivery-object-plan.js';
import {repositoryURL} from './repository-gitee.js';
import {validateGitBaseline} from './delivery-git-read.js';
import {pushIntent,validatePushIntent,validatePushReadiness,pushReadback} from './delivery-push-plan.js';
const fail=code=>{throw Error('DELIVERY_'+code);};
const denied=()=>fail('ADAPTER_REQUIRED');
const id=x=>typeof x==='string'&&x.length>0&&x.length<=256&&!/[\x00-\x1f\x7f]/.test(x);
const sync=x=>{if(x&&typeof x.then==='function')fail('ASYNC_ADAPTER_DENIED');return x;};
const table=(db,name)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
function workspace(v,plan,resource){
 if(!v||Object.keys(v).sort().join(',')!=='base_sha,branch,directory,git_directory,root,url'||
  typeof v.root!=='string'||!v.root.startsWith('/')||v.root.length>2048||/[\x00-\x1f\x7f]/.test(v.root)||
  v.url!==resource||v.branch!==plan.branch||v.base_sha!==plan.parent)fail('WORKSPACE_BINDING');
 for(const k of ['directory','git_directory'])if(!v[k]||Object.keys(v[k]).sort().join(',')!=='device,inode'||
  !/^[0-9]{1,30}$/.test(v[k].device)||!/^[0-9]{1,30}$/.test(v[k].inode))fail('WORKSPACE_BINDING');
 return structuredClone(v);
}
export class DeliveryJournal {
 constructor({store,enabled=false,pushEnabled=false,authorize=denied,preflight=denied,observe=denied,observeUnapplied=denied,exclusive=()=>false,now=Date.now}){
  Object.assign(this,{store,db:store.db,enabled,pushEnabled,authorize,preflight,observe,observeUnapplied,exclusive,now});
  this.db.exec(`CREATE TABLE IF NOT EXISTS delivery_actions(
   seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,event_id TEXT UNIQUE NOT NULL,fingerprint TEXT NOT NULL,
   task_id TEXT NOT NULL,approval_id TEXT NOT NULL,authority_hash TEXT NOT NULL,resource TEXT NOT NULL,intent TEXT NOT NULL,
   development_cutoff INTEGER NOT NULL,state TEXT NOT NULL,epoch INTEGER,dispatched INTEGER NOT NULL DEFAULT 0,
   created INTEGER NOT NULL,error TEXT,result TEXT);
   CREATE UNIQUE INDEX IF NOT EXISTS delivery_resource_owner ON delivery_actions(resource) WHERE state IN ('active','needs_review');
   CREATE UNIQUE INDEX IF NOT EXISTS delivery_approval_once ON delivery_actions(approval_id);
   CREATE TABLE IF NOT EXISTS delivery_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,action_id TEXT NOT NULL,type TEXT NOT NULL,data TEXT NOT NULL,created INTEGER NOT NULL);`);
  this.db.exec(`CREATE TABLE IF NOT EXISTS delivery_operations(id TEXT PRIMARY KEY,action_id TEXT NOT NULL,epoch INTEGER NOT NULL,
   kind TEXT NOT NULL,detail TEXT NOT NULL,state TEXT NOT NULL,pid INTEGER,started INTEGER NOT NULL,closed INTEGER,code INTEGER,signal TEXT);`);
  if(!this.db.prepare('PRAGMA table_info(delivery_actions)').all().some(x=>x.name==='before_snapshot'))this.db.exec('ALTER TABLE delivery_actions ADD COLUMN before_snapshot TEXT');
 }
 enabledCheck(){if(this.enabled!==true)fail('DISABLED');}
 owner(){this.enabledCheck();if(sync(this.exclusive())!==true)fail('EXCLUSIVE_OWNER_REQUIRED');}
 row(id){const r=this.db.prepare('SELECT * FROM delivery_actions WHERE id=?').get(id);if(!r)fail('NOT_FOUND');return r;}
 intent(r){
  const value=JSON.parse(r.intent),{fingerprint,...body}=value,plan=value.plan;
  const {fingerprint:planFingerprint,...planBody}=plan??{};
  if(value.kind==='push-execution-intent-v1'){
   validatePushIntent(value);if(value.task_id!==r.task_id||value.resource!==r.resource||digest({event_id:r.event_id,approval_id:r.approval_id,intent:value})!==r.fingerprint)fail('INTENT_CHANGED');return value;
  }
  if(digest(body)!==fingerprint||digest(planBody)!==planFingerprint||value.kind!=='commit-execution-intent-v1'||
   value.task_id!==r.task_id||value.resource!==r.resource||plan.kind!=='commit-objects-v1'||plan.persisted!==false||plan.grants_execution!==false||
   digest({event_id:r.event_id,approval_id:r.approval_id,intent:value})!==r.fingerprint)fail('INTENT_CHANGED');
  return value;
 }
 event(id,type,data={}){this.db.prepare('INSERT INTO delivery_events(action_id,type,data,created) VALUES (?,?,?,?)').run(id,type,canonical(data),this.now());}
 prepare({task_id,resource,workspace_identity,plan,objects}){
  if(plan?.kind==='push-commit-v1'){if(this.pushEnabled!==true)fail('PUSH_DISABLED');return pushIntent(this.store,{task_id,resource,workspace_identity,plan});}
  verifyObjects(plan,objects);if(repositoryURL(resource).url!==resource)fail('RESOURCE');
  const task=this.store.task(task_id),identity=workspace(workspace_identity,plan,resource);
  const intent={schema:1,kind:'commit-execution-intent-v1',task_id,task_revision:task.revision,resource,workspace_identity:identity,plan:structuredClone(plan)};
  return {...intent,fingerprint:digest(intent)};
 }
 authority(approval_id,intent){
  this.enabledCheck();const scope=intent.kind==='push-execution-intent-v1'?'push':'commit';
  if(scope==='push'){
   if(this.pushEnabled!==true)fail('PUSH_DISABLED');
   if(canonical(pushIntent(this.store,{task_id:intent.task_id,resource:intent.resource,workspace_identity:intent.workspace_identity,plan:intent.plan}))!==canonical(intent))fail('SOURCE_CHANGED');
  }const task=this.store.task(intent.task_id);
  if(task.revision!==intent.task_revision)fail('TASK_REVISION_CHANGED');
  const a=sync(this.authorize({approval_id,intent:structuredClone(intent)}));
  // An old commit-preview-v1 or model-supplied "approved" flag never satisfies this contract.
  if(!a||a.kind!=='delivery-execution-v1'||a.scope!==scope||a.execution!==true||a.approval_id!==approval_id||
   a.task_id!==intent.task_id||a.task_revision!==intent.task_revision||a.intent_fingerprint!==intent.fingerprint||
   !/^[a-f0-9]{64}$/.test(a.authority_hash??''))fail('EXECUTION_APPROVAL_REQUIRED');
  return a.authority_hash;
 }
 readiness(intent){
  const r=sync(this.preflight(structuredClone(intent)));
  if(intent.kind==='push-execution-intent-v1')return validatePushReadiness(intent,r,this.now());
  if(!r||r.intent_fingerprint!==intent.fingerprint||r.drained!==true||r.manifest_sha256!==intent.plan.manifest_sha256||
   canonical(r.workspace_identity)!==canonical(intent.workspace_identity)||r.branch!==intent.plan.branch||r.parent!==intent.plan.parent)fail('PREFLIGHT_REQUIRED');
  return validateGitBaseline(intent,r.baseline);
 }
 enqueue(input){
  this.enabledCheck();if(!id(input.event_id)||!id(input.approval_id))fail('INVALID_REQUEST');
  return this.store.tx(()=>{
   const intent=this.prepare(input),fp=digest({event_id:input.event_id,approval_id:input.approval_id,intent});
   const old=this.db.prepare('SELECT * FROM delivery_actions WHERE event_id=?').get(input.event_id);
   if(old){if(old.fingerprint!==fp)fail('EVENT_CONFLICT');return this.view(old.id);}
   if(this.db.prepare('SELECT 1 FROM delivery_actions WHERE approval_id=?').get(input.approval_id))fail('APPROVAL_ALREADY_USED');
   const authority=this.authority(input.approval_id,intent);
   const cutoff=table(this.db,'development_requests')?this.db.prepare('SELECT COALESCE(MAX(seq),0) n FROM development_requests').get().n:0;
   const action='delivery-'+randomUUID();
   this.db.prepare(`INSERT INTO delivery_actions(id,event_id,fingerprint,task_id,approval_id,authority_hash,resource,intent,development_cutoff,state,created)
    VALUES (?,?,?,?,?,?,?,?,?,'queued',?)`).run(action,input.event_id,fp,intent.task_id,input.approval_id,authority,intent.resource,canonical(intent),cutoff,this.now());
   this.event(action,'queued');return this.view(action);
  });
 }
 view(id){const r=this.row(id);return {id:r.id,task_id:r.task_id,state:r.state,epoch:r.epoch,dispatched:r.dispatched===1,error:r.error,
  computed_commit_oid:this.intent(r).plan.computed_commit_oid??null,result:r.result?JSON.parse(r.result):null,
  ...(this.intent(r).kind==='push-execution-intent-v1'?{kind:'push',source_commit_oid:this.intent(r).plan.commit_oid}: {})};}
 waiting(id){const r=this.row(id);return deliveryWaiting(this.db,r,this.store.task(r.task_id));}
 acquire(id){return this.store.tx(()=>{
  this.owner();const r=this.row(id);if(r.state!=='queued')fail('NOT_QUEUED');
  const intent=this.intent(r);if(this.authority(r.approval_id,intent)!==r.authority_hash)fail('APPROVAL_CHANGED');
  const reason=this.waiting(id);if(reason)return {acquired:false,reason};const baseline=this.readiness(intent);
  const epoch=this.store.task(r.task_id).epoch+1;
  this.db.prepare("UPDATE tasks SET owner='cloud',epoch=?,busy=1 WHERE id=?").run(epoch,r.task_id);
  this.db.prepare("UPDATE delivery_actions SET state='active',epoch=?,before_snapshot=? WHERE id=?").run(epoch,canonical(baseline),id);
  this.event(id,'acquired',{epoch});return {acquired:true,...this.view(id)};
 });}
 fence(id,epoch,states=['active']){
  this.owner();const r=this.row(id);if(!states.includes(r.state)||r.epoch!==epoch)fail('STALE_FENCE');
  const t=this.store.fence('cloud',r.task_id,epoch);if(!t.busy)fail('NOT_BUSY');return r;
 }
 markDispatched(id,epoch){return this.store.tx(()=>{
  const r=this.fence(id,epoch);if(r.dispatched)fail('ALREADY_DISPATCHED');const intent=this.intent(r);
  if(this.unfinished(id))fail('DRAIN_REQUIRED');
  if(this.authority(r.approval_id,intent)!==r.authority_hash)fail('APPROVAL_CHANGED');
  if(!r.before_snapshot||canonical(this.readiness(intent))!==r.before_snapshot)fail('BEFORE_SNAPSHOT_CHANGED');
  // Must commit this record BEFORE a future trusted adapter is allowed to touch Git.
  this.db.prepare('UPDATE delivery_actions SET dispatched=1 WHERE id=?').run(id);this.event(id,'dispatched',{epoch});
  return {id,epoch,intent:structuredClone(intent)};
 });}
 #review(id,error='EFFECT_UNKNOWN'){
  const r=this.row(id);this.db.prepare("UPDATE delivery_actions SET state='needs_review',error=? WHERE id=?").run(error,id);
  // Do not clear or steal the task fence, and do not reset a possibly live process.
  this.event(id,'needs_review',{epoch:r.epoch,error});return this.view(id);
 }
 markUnknown(id,epoch){return this.store.tx(()=>{this.fence(id,epoch);return this.#review(id);});}
 recordFailure(id,epoch){return this.store.tx(()=>{
  this.owner();const r=this.row(id);if(r.epoch!==epoch||!['active','needs_review'].includes(r.state))fail('STALE_FENCE');
  // Reporting the old action's uncertainty does not modify or reacquire a task fence.
  return this.#review(id);
 });}
 unfinished(id){return !!this.db.prepare("SELECT 1 FROM delivery_operations WHERE action_id=? AND state<>'closed'").get(id);}
 effectAuthority(id,epoch,{cleanup=false}={}){
  const r=this.fence(id,epoch,cleanup?['active','needs_review']:['active']);if(!r.dispatched)fail('NOT_DISPATCHED');
  const intent=this.intent(r);if(!cleanup&&this.authority(r.approval_id,intent)!==r.authority_hash)fail('APPROVAL_CHANGED');return intent;
 }
 startOperation(id,epoch,kind,detail={}){return this.store.tx(()=>{
  const push=this.intent(this.row(id)).kind==='push-execution-intent-v1';
  if(!(push?['push']:['lock','object','reference','index','unlock']).includes(kind))fail('OPERATION_KIND');
  if(push&&this.db.prepare("SELECT 1 FROM delivery_operations WHERE action_id=? AND kind='push'").get(id))fail('PUSH_ALREADY_STARTED');
  this.effectAuthority(id,epoch,{cleanup:kind==='unlock'});if(this.unfinished(id))fail('DRAIN_REQUIRED');
  if(!detail||typeof detail!=='object'||Array.isArray(detail)||canonical(detail).length>2000)fail('OPERATION_DETAIL');
  const op='delivery-op-'+randomUUID();this.db.prepare("INSERT INTO delivery_operations(id,action_id,epoch,kind,detail,state,started) VALUES (?,?,?,?,?,'intent',?)").run(op,id,epoch,kind,canonical(detail),this.now());
  this.event(id,'operation_intent',{operation:op,epoch,kind});return op;
 });}
 operation(id){const r=this.db.prepare('SELECT * FROM delivery_operations WHERE id=?').get(id);if(!r)fail('OPERATION_NOT_FOUND');return r;}
 spawned(op,pid){return this.store.tx(()=>{
  const r=this.operation(op);if(r.state!=='intent'||r.pid!==null||!Number.isSafeInteger(pid)||pid<1)fail('OPERATION_SPAWN_INVALID');
  this.db.prepare("UPDATE delivery_operations SET state='spawned',pid=? WHERE id=?").run(pid,op);this.event(r.action_id,'operation_spawned',{operation:op,pid});
 });}
 closed(op,{code=null,signal=null,evidence}={}){return this.store.tx(()=>{
  if(code!==null&&!Number.isSafeInteger(code)||signal!==null&&(typeof signal!=='string'||!/^[A-Z0-9_-]{1,32}$/.test(signal)))fail('OPERATION_CLOSE_INVALID');
  if(evidence!==undefined&&(!evidence||Object.keys(evidence).sort().join(',')!=='binding_hash,kind,receipt_sha256'||evidence.kind!=='sealed-process-receipt-v1'||
   !/^[a-f0-9]{64}$/.test(evidence.binding_hash??'')||!/^[a-f0-9]{64}$/.test(evidence.receipt_sha256??'')))fail('OPERATION_CLOSE_INVALID');
  const r=this.operation(op);if(r.state==='closed'){if(r.code!==code||r.signal!==signal)fail('OPERATION_CLOSE_CONFLICT');return;}
  this.db.prepare("UPDATE delivery_operations SET state='closed',closed=?,code=?,signal=? WHERE id=?").run(this.now(),code,signal,op);
  this.event(r.action_id,'operation_drained',{operation:op,code,signal,...(evidence?{evidence}: {})});
 });}
 finish(id,epoch){return this.store.tx(()=>{
  this.owner();const prior=this.row(id);
  if(prior.state==='completed'&&prior.epoch===epoch)return {...this.view(id),replayed:true};
  const r=this.fence(id,epoch,['active','needs_review']);if(!r.dispatched)fail('NOT_DISPATCHED');
  if(this.unfinished(id))return this.#review(id,'DRAIN_REQUIRED');
  const intent=this.intent(r),p=intent.plan;let proof;
  try{proof=sync(this.observe(structuredClone(intent)));}catch{return this.#review(id,'READBACK_UNKNOWN');}
  if(intent.kind==='push-execution-intent-v1'){
   let result;try{result=pushReadback(intent,proof,this.now());}catch{return this.#review(id,'READBACK_MISMATCH');}
   this.db.prepare("UPDATE delivery_actions SET state='completed',error=NULL,result=? WHERE id=?").run(canonical(result),id);
   this.db.prepare('UPDATE tasks SET busy=0 WHERE id=?').run(r.task_id);this.event(id,'readback_completed',{epoch,result});return this.view(id);
  }
  if(!proof||proof.kind!=='commit-readback-v1'||proof.intent_fingerprint!==intent.fingerprint||proof.drained!==true||
   proof.object_exists!==true||proof.head_oid!==p.computed_commit_oid||proof.ref_oid!==p.computed_commit_oid||
   proof.commit_oid!==p.computed_commit_oid||proof.tree_oid!==p.tree_oid||proof.index_tree_oid!==p.tree_oid||
   proof.branch!==p.branch||proof.parent!==p.parent||proof.manifest_sha256!==p.manifest_sha256||
   canonical(proof.workspace_identity)!==canonical(intent.workspace_identity))return this.#review(id,'READBACK_MISMATCH');
  const result={kind:'commit-readback-v1',commit_oid:p.computed_commit_oid,tree_oid:p.tree_oid,branch:p.branch,manifest_sha256:p.manifest_sha256,
   intent_fingerprint:intent.fingerprint,tested_content:structuredClone(p.tested_content),drained:true,remote_acceptance:'not_observed',runtime_adoption:'not_observed'};
  this.db.prepare("UPDATE delivery_actions SET state='completed',error=NULL,result=? WHERE id=?").run(canonical(result),id);
  this.db.prepare('UPDATE tasks SET busy=0 WHERE id=?').run(r.task_id);this.event(id,'readback_completed',{epoch,result});return this.view(id);
 });}
 settleUnapplied(id,epoch){return this.store.tx(()=>{
  this.owner();const prior=this.row(id);if(prior.state==='not_applied'&&prior.epoch===epoch)return {...this.view(id),replayed:true};
  const r=this.fence(id,epoch,['needs_review']),intent=this.intent(r);
  // An unchanged ref cannot prove no push: objects may have arrived, or the ref may have moved back.
  if(intent.kind==='push-execution-intent-v1')fail('PUSH_UNAPPLIED_NOT_PROVEN');
  if(this.unfinished(id))return this.#review(id,'DRAIN_REQUIRED');
  if(!r.before_snapshot)fail('BEFORE_SNAPSHOT_REQUIRED');const baseline=validateGitBaseline(intent,JSON.parse(r.before_snapshot));let proof;
  try{proof=sync(this.observeUnapplied(structuredClone(intent),structuredClone(baseline)));}catch{return this.#review(id,'UNAPPLIED_READBACK_UNKNOWN');}
  if(!proof||proof.kind!=='commit-not-applied-v1'||proof.intent_fingerprint!==intent.fingerprint||proof.baseline_fingerprint!==baseline.fingerprint||
   proof.drained!==true||proof.unchanged!==true||proof.object_presence_unchanged!==true)return this.#review(id,'UNAPPLIED_READBACK_MISMATCH');
  const result={kind:'commit-not-applied-v1',intent_fingerprint:intent.fingerprint,baseline_fingerprint:baseline.fingerprint,
   drained:true,unchanged:true,object_presence_unchanged:true,retry_authorized:false};
  this.db.prepare("UPDATE delivery_actions SET state='not_applied',error=NULL,result=? WHERE id=?").run(canonical(result),id);
  this.db.prepare('UPDATE tasks SET busy=0 WHERE id=?').run(r.task_id);this.event(id,'not_applied_confirmed',{epoch,result});return this.view(id);
 });}
 cancelQueued(id,reason){return this.store.tx(()=>{
  this.owner();if(!['user_cancelled','superseded','preflight_failed'].includes(reason))fail('INVALID_CANCEL');const r=this.row(id);
  if(r.state!=='queued')fail('NOT_QUEUED');
  this.db.prepare("UPDATE delivery_actions SET state='cancelled',error=? WHERE id=?").run(reason,id);this.event(id,'cancelled',{reason});return this.view(id);
 });}
 recover(){return this.store.tx(()=>{
  this.owner();const rows=this.db.prepare("SELECT id FROM delivery_actions WHERE state='active' ORDER BY seq").all();
  // No dispatch, retry, unlock or automatic "no effect" inference, even before dispatch.
  for(const r of rows)this.#review(r.id,'HOST_RESTART_REVIEW');return {needs_review:rows.map(r=>r.id),retried:0};
 });}
}
