// Separate push authority over a completed local commit. No Git/network effects.
// Reuses the same ledger and trusted decision verifier; a commit approval never
// authorizes push, and an old remote observation is not an execution preflight.
import {randomUUID} from 'node:crypto';
import {canonical,digest} from './approval-ledger.js';
const fail=c=>{throw Error('DELIVERY_PUSH_APPROVAL_'+c);};
const same=(a,b)=>canonical(a)===canonical(b);
const proofHash=r=>digest({task_id:r.task_id,spec_revision:r.spec_revision,task_hash:r.task_hash,proposal:JSON.parse(r.proposal),repository_revision:r.repository_revision,expires:r.expires});
export class DeliveryPushApproval {
 constructor({commit,journal,enabled=false}){
  this.commit=commit;this.j=journal;this.l=commit.l;this.db=this.l.db;this.enabled=enabled;
  if(journal.db!==this.db)fail('DATABASE_MISMATCH');
  this.db.exec(`CREATE TABLE IF NOT EXISTS delivery_push_plans(id TEXT PRIMARY KEY,event_id TEXT UNIQUE NOT NULL,
   task_id TEXT NOT NULL,event_fingerprint TEXT NOT NULL,snapshot TEXT NOT NULL,created INTEGER NOT NULL);`);
 }
 source(task,action){
  const r=this.j.row(action),i=this.j.intent(r),a=this.l.row(r.approval_id),p=JSON.parse(a.proposal),d=p.delivery;
  if(r.task_id!==task||r.state!=='completed'||i.kind!=='commit-execution-intent-v1'||a.task_id!==task||
   !same(p.scopes,['commit'])||d?.kind!=='commit-execution-v1'||proofHash(a)!==a.proposal_hash)fail('SOURCE_REQUIRED');
  const s=this.commit.stored(task,d.plan_id,d.fingerprint);this.commit.current(s,a.spec_revision);
  if(!same(this.commit.snapshot(s),d)||!same(s.intent,i)||!same(s.policy,p.model_policy)||!same(s.repository,p.repository)||
   !this.l.repositories?.matches(task,a.repository_revision,p.repository)||p.repository?.provider!=='gitee'||
   !Number.isSafeInteger(p.repository.repository_id)||p.repository.repository_id<1)fail('SOURCE_CHANGED');
  return {row:r,intent:i,result:JSON.parse(r.result),repository:p.repository,policy:p.model_policy,approval_hash:a.proposal_hash};
 }
 stage({event_id,task_id,resource,workspace_identity,plan}){
  if(this.enabled!==true)fail('DISABLED');
  if(typeof event_id!=='string'||!event_id.trim()||event_id.length>256||/[\x00-\x1f\x7f]/.test(event_id))fail('INVALID_EVENT');
  return this.l.store.tx(()=>{
   const intent=this.j.prepare({task_id,resource,workspace_identity,plan}),event_fingerprint=digest(intent);
   const old=this.db.prepare('SELECT * FROM delivery_push_plans WHERE event_id=?').get(event_id);
   if(old){if(old.event_fingerprint!==event_fingerprint)fail('EVENT_CONFLICT');const s=this.stored(task_id,old.id,JSON.parse(old.snapshot).fingerprint);return {reference:this.reference(s),replayed:true,grants_execution:false};}
   const source=this.source(task_id,plan.source_action_id),h=this.l.catalog.head(task_id);
   if(h.legacy||this.l.store.task(task_id).blocked||source.repository.url!==resource||source.repository.repository_id!==plan.repository_id)fail('SOURCE_CHANGED');
   this.j.readiness(intent); // A private, fresh, read-only preflight was primed before this transaction.
   const body={schema:1,kind:'push-approval-plan-v1',id:'push-plan-'+randomUUID(),task_id,spec_revision:h.spec_revision,task_hash:digest(h.goal),
    repository:structuredClone(source.repository),policy:structuredClone(source.policy),source_approval_hash:source.approval_hash,intent,created:this.l.now()};
   const s={...body,fingerprint:digest(body)};
   this.db.prepare('INSERT INTO delivery_push_plans VALUES (?,?,?,?,?,?)').run(s.id,event_id,task_id,event_fingerprint,canonical(s),s.created);
   return {reference:this.reference(s),replayed:false,grants_execution:false};
  });
 }
 reference(s){return {kind:'push-execution-reference-v1',plan_id:s.id,fingerprint:s.fingerprint};}
 stored(task,id,fingerprint){
  const row=this.db.prepare('SELECT * FROM delivery_push_plans WHERE id=?').get(id);if(!row||row.task_id!==task)fail('PLAN_NOT_FOUND');
  const s=JSON.parse(row.snapshot),{fingerprint:hash,...body}=s;
  if(s.id!==id||s.task_id!==task||s.kind!=='push-approval-plan-v1'||s.schema!==1||hash!==fingerprint||digest(body)!==hash)fail('PLAN_CHANGED');
  if(!same(this.j.prepare(s.intent),s.intent))fail('SOURCE_CHANGED');return s;
 }
 current(s,revision){
  const h=this.l.catalog.head(s.task_id),source=this.source(s.task_id,s.intent.plan.source_action_id);
  if(h.spec_revision!==revision||s.spec_revision!==revision||digest(h.goal)!==s.task_hash||
   !same(source.repository,s.repository)||!same(source.policy,s.policy)||source.approval_hash!==s.source_approval_hash)fail('SOURCE_CHANGED');
 }
 snapshot(s){
  const p=s.intent.plan;
  return {kind:'push-execution-v1',plan_id:s.id,fingerprint:s.fingerprint,intent_fingerprint:s.intent.fingerprint,plan_fingerprint:p.fingerprint,
   source_action_id:p.source_action_id,source_approval_hash:s.source_approval_hash,task_revision:s.spec_revision,workspace_revision:s.intent.task_revision,
   repository_id:p.repository_id,repository_url:p.url,repository_fingerprint:s.repository.fingerprint,workspace_branch:p.branch,ref:p.ref,
   expected_remote_oid:p.expected_remote_oid,commit_oid:p.commit_oid,tree_oid:p.tree_oid,manifest_sha256:p.manifest_sha256,
   tested_content:structuredClone(p.tested_content),prepared_at:s.created,execution:'requires_runtime_gate',max_pushes:1,
   hooks:false,signed:false,rewrite:false,delete:false,tags:false,commit:false,publish:false,deploy:false};
 }
 approvalSnapshot(task,revision,reference,repository,policy){
  if(reference.kind!=='push-execution-reference-v1')return this.commit.approvalSnapshot(task,revision,reference,repository,policy);
  if(this.enabled!==true)fail('DISABLED');const s=this.stored(task,reference.plan_id,reference.fingerprint);this.current(s,revision);
  if(!same(s.repository,repository)||!same(s.policy,policy))fail('BINDING_CHANGED');
  // Human approval can arrive later. No network I/O or freshness renewal here;
  // acquisition and transmission must obtain a new preflight for this exact baseline.
  return this.snapshot(s);
 }
 matches(task,revision,plan){
  if(plan?.kind!=='push-execution-v1')return this.commit.matches(task,revision,plan);
  try{if(this.enabled!==true)return false;const s=this.stored(task,plan.plan_id,plan.fingerprint);this.current(s,revision);return same(this.snapshot(s),plan);}catch{return false;}
 }
 authorize(a){
  if(a.intent?.kind!=='push-execution-intent-v1')return this.commit.authorize(a);
  if(this.enabled!==true)fail('DISABLED');
  return this.commit.readSnapshot(()=>{
   const r=this.l.row(a.approval_id),v=this.l.view(r.id),p=v.proposal.delivery;
   if(v.state!=='approved'||!same(v.proposal.scopes,['push'])||p?.kind!=='push-execution-v1'||proofHash(r)!==r.proposal_hash)fail('EXECUTION_APPROVAL_REQUIRED');
   const s=this.stored(r.task_id,p.plan_id,p.fingerprint);
   if(!same(s.intent,a.intent)||!same(s.policy,v.proposal.model_policy)||!same(s.repository,v.proposal.repository))fail('INTENT_CHANGED');
   const proof=this.commit.decisionProof(r);
   return {kind:'delivery-execution-v1',scope:'push',execution:true,approval_id:r.id,task_id:r.task_id,task_revision:a.intent.task_revision,
    intent_fingerprint:a.intent.fingerprint,authority_hash:digest({approval_id:r.id,proposal_hash:r.proposal_hash,intent_fingerprint:a.intent.fingerprint,...proof})};
  });
 }
}
