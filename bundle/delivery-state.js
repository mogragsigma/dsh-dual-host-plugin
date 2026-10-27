// Read-only persisted projection. No Git, filesystem observation, migration,
// approval renewal, lease acquisition or execution callback is allowed here.
import {canonical,digest} from './approval-ledger.js';
import {validatePushIntent,pushReadback} from './delivery-push-plan.js';
const has=(db,t)=>!!db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const parse=s=>{try{return JSON.parse(s);}catch{return null;}};
const same=(a,b)=>canonical(a)===canonical(b);
const states=new Set(['queued','active','needs_review','completed','not_applied','cancelled']);
const types=new Set(['queued','acquired','dispatched','operation_intent','operation_spawned','operation_drained','needs_review','readback_completed','not_applied_confirmed','cancelled','recovery_applied','remote_readback_failed']);
const codes=new Set(['EFFECT_UNKNOWN','DRAIN_REQUIRED','READBACK_UNKNOWN','READBACK_MISMATCH','UNAPPLIED_READBACK_UNKNOWN','UNAPPLIED_READBACK_MISMATCH','HOST_RESTART_REVIEW','user_cancelled','superseded','preflight_failed']);
export function deliveryWaiting(db,r,t){
 if(r.state==='needs_review'||t.blocked)return 'delivery_review';if(r.state!=='queued')return null;
 if(t.busy)return 'task_busy';
 const owner=db.prepare("SELECT state FROM delivery_actions WHERE resource=? AND state IN ('active','needs_review')").get(r.resource);
 if(owner)return owner.state==='needs_review'?'delivery_resource_review':'delivery_resource_busy';
 if(has(db,'development_requests')){
  if(has(db,'development_operations')&&db.prepare("SELECT 1 FROM development_operations o JOIN development_requests d ON d.id=o.request_id WHERE d.resource=? AND o.state<>'closed'").get(r.resource))return 'development_resource_draining';
  const d=db.prepare("SELECT state FROM development_requests WHERE resource=? AND state IN ('active','needs_review')").get(r.resource);
  if(d)return d.state==='needs_review'?'development_resource_review':'development_resource_busy';
  if(db.prepare("SELECT 1 FROM development_requests WHERE resource=? AND state='queued' AND seq<=?").get(r.resource,r.development_cutoff))return 'development_fifo';
 }
 if(db.prepare("SELECT 1 FROM delivery_actions WHERE resource=? AND state='queued' AND seq<?").get(r.resource,r.seq))return 'delivery_fifo';
 return null;
}
function projectPush(db,r,task,i,base){
 try{validatePushIntent(i);}catch{return base;}
 if(!states.has(r.state)||r.state==='not_applied'||i.task_id!==r.task_id||i.resource!==r.resource||
  digest({event_id:r.event_id,approval_id:r.approval_id,intent:i})!==r.fingerprint)return base;
 const p=i.plan,result=parse(r.result),open=db.prepare("SELECT count(*) n FROM delivery_operations WHERE action_id=? AND state<>'closed'").get(r.id).n;
 const e=db.prepare("SELECT data,created FROM delivery_events WHERE action_id=? AND type='readback_completed' ORDER BY seq DESC LIMIT 1").get(r.id),proof=parse(e?.data);
 let completed=false;
 if(r.state==='completed'&&r.dispatched===1&&Number.isSafeInteger(r.epoch)&&open===0&&proof?.epoch===r.epoch&&same(proof.result,result)&&
  Number.isSafeInteger(result?.observed_at)&&result.observed_at<=e.created){
  try{completed=same(pushReadback(i,{...result,ref_oid:result.commit_oid,workspace_identity:i.workspace_identity},result.observed_at),result);}catch{}
 }
 const state=r.state==='completed'&&!completed?'evidence_invalid':r.state;
 return {...base,kind:'push',state,error:state==='evidence_invalid'?base.error:r.error?(codes.has(r.error)?r.error:'DELIVERY_REVIEW_REQUIRED'):null,
  approval_id:r.approval_id,workspace_revision:i.task_revision,revision_matches:i.task_revision===task.revision,
  branch:p.branch,source_commit_oid:p.commit_oid,commit_oid:null,repository_url:p.url,repository_id:p.repository_id,
  expected_remote_oid:p.expected_remote_oid,remote_ref_oid:completed?result.commit_oid:null,
  remote_acceptance:completed?'ref_observed':'not_observed',remote_observed_at:completed?result.observed_at:null,
  dispatched:r.dispatched===1,unclosed_operations:open,waiting_reason:deliveryWaiting(db,r,task),external_drain_checked_now:false,
  timeline:db.prepare('SELECT seq,type,created FROM delivery_events WHERE action_id=? ORDER BY seq DESC LIMIT 12').all(r.id).reverse().map(e=>({seq:e.seq,type:types.has(e.type)?e.type:'other',at:e.created}))};
}
function project(db,r,task){
 const i=parse(r.intent),{fingerprint:ih,...ib}=i??{},p=i?.plan,{fingerprint:ph,...pb}=p??{};
 const base={id:r.id,created:r.created,state:'evidence_invalid',error:'DELIVERY_EVIDENCE_INVALID',commit_oid:null,
  computed_commit_oid:null,remote_acceptance:'not_observed',runtime_adoption:'not_observed',historical:true,timeline:[]};
 if(i?.kind==='push-execution-intent-v1')return projectPush(db,r,task,i,base);
 if(!states.has(r.state)||i?.kind!=='commit-execution-intent-v1'||i.task_id!==r.task_id||i.resource!==r.resource||
  digest(ib)!==ih||p?.kind!=='commit-objects-v1'||p.persisted!==false||p.grants_execution!==false||digest(pb)!==ph||
  digest({event_id:r.event_id,approval_id:r.approval_id,intent:i})!==r.fingerprint)return base;
 const result=parse(r.result),open=db.prepare("SELECT count(*) n FROM delivery_operations WHERE action_id=? AND state<>'closed'").get(r.id).n;
 const event=db.prepare("SELECT data,created FROM delivery_events WHERE action_id=? AND type='readback_completed' ORDER BY seq DESC LIMIT 1").get(r.id),proof=parse(event?.data);
 const completed=r.state==='completed'&&r.dispatched===1&&Number.isSafeInteger(r.epoch)&&open===0&&proof?.epoch===r.epoch&&same(proof.result,result)&&
  result?.kind==='commit-readback-v1'&&result.intent_fingerprint===i.fingerprint&&result.commit_oid===p.computed_commit_oid&&
  result.tree_oid===p.tree_oid&&result.branch===p.branch&&result.manifest_sha256===p.manifest_sha256&&same(result.tested_content,p.tested_content)&&result.drained===true;
 const unappliedEvent=r.state==='not_applied'?db.prepare("SELECT data FROM delivery_events WHERE action_id=? AND type='not_applied_confirmed' ORDER BY seq DESC LIMIT 1").get(r.id):null;
 const unappliedProof=parse(unappliedEvent?.data),before=parse(r.before_snapshot),{fingerprint:beforeHash,...beforeBody}=before??{};
 const unapplied=r.state==='not_applied'&&open===0&&Number.isSafeInteger(r.epoch)&&unappliedProof?.epoch===r.epoch&&same(unappliedProof.result,result)&&
  result?.kind==='commit-not-applied-v1'&&result.intent_fingerprint===i.fingerprint&&beforeHash&&digest(beforeBody)===beforeHash&&
  before.intent_fingerprint===i.fingerprint&&result.baseline_fingerprint===beforeHash&&result.drained===true&&result.unchanged===true&&result.object_presence_unchanged===true&&result.retry_authorized===false;
 const state=r.state==='completed'&&!completed||r.state==='not_applied'&&!unapplied?'evidence_invalid':r.state;
 return {...base,state,error:state==='evidence_invalid'?base.error:r.error?(codes.has(r.error)?r.error:'DELIVERY_REVIEW_REQUIRED'):null,
  approval_id:r.approval_id,workspace_revision:i.task_revision,revision_matches:i.task_revision===task.revision,
  branch:p.branch,computed_commit_oid:p.computed_commit_oid,commit_oid:completed?result.commit_oid:null,
  commit_observed_at:completed?event.created:null,dispatched:r.dispatched===1,unclosed_operations:open,
  waiting_reason:deliveryWaiting(db,r,task),external_drain_checked_now:false,
  timeline:db.prepare('SELECT seq,type,created FROM delivery_events WHERE action_id=? ORDER BY seq DESC LIMIT 12').all(r.id).reverse().map(e=>({seq:e.seq,type:types.has(e.type)?e.type:'other',at:e.created}))};
}
export function deliveryActions(g,taskId){
 const db=g.store?.db,base={schema:1,available:false,items:[],total:0,read_only:true,grants_execution:false,
  execution_enabled:g.deliveryRuntime?.executionEnabled===true,push_execution_enabled:g.deliveryRuntime?.pushExecutionEnabled===true,filesystem_checked_now:false,remote_checked_now:false,automatic_retry:false};
 if(!['delivery_actions','delivery_operations','delivery_events'].every(t=>has(db,t)))return base;
 try{
  const task=db.prepare('SELECT revision,busy,blocked FROM tasks WHERE id=?').get(taskId);if(!task)return base;
  const total=db.prepare('SELECT count(*) n FROM delivery_actions WHERE task_id=?').get(taskId).n;
  const rows=db.prepare("SELECT * FROM delivery_actions WHERE task_id=? ORDER BY CASE WHEN state='needs_review' THEN 0 WHEN state NOT IN ('queued','active','completed','not_applied','cancelled') THEN 1 WHEN state='active' THEN 2 WHEN state='queued' THEN 3 ELSE 4 END,seq DESC LIMIT 20").all(taskId);
  return {...base,available:true,total,items:rows.map(r=>project(db,r,task))};
 }catch{return {...base,error:'DELIVERY_STATE_UNAVAILABLE'};}
}

// Exact historical action lookup for derived deliverables; independent of the
// twenty-row UI window and of whether the execution runtime is currently enabled.
export function deliveryAction(g,taskId,id){
 const db=g.store?.db;
 if(!['delivery_actions','delivery_operations','delivery_events'].every(t=>has(db,t)))return null;
 try{const task=db.prepare('SELECT revision,busy,blocked FROM tasks WHERE id=?').get(taskId),r=db.prepare('SELECT * FROM delivery_actions WHERE id=? AND task_id=?').get(id,taskId);
  return task&&r?project(db,r,task):null;
 }catch{return null;}
}

// Pending delivery belongs to the task even without a worker job. Completed
// delivery is historical evidence, never proof that the whole task is done.
export function deliveryDisplayState(fallback,execution){
 if(execution?.error)return 'delivery_state_unavailable';
 if(!execution?.available)return fallback;
 const items=execution.items;
 if(items.some(x=>['needs_review','evidence_invalid'].includes(x.state)))return 'delivery_review';
 if(items.some(x=>x.unclosed_operations>0))return 'delivery_draining';
 if(items.some(x=>x.state==='active'))return 'delivery_active';
 // Do not hide another executing/blocked component with an ordinary queue.
 if(!['registered','completed','cancelled','development_handed_off'].includes(fallback))return fallback;
 if(items.some(x=>x.state==='queued'))return 'delivery_queued';
 return fallback;
}
