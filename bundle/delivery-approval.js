// Ledger bridge. Constructed only by the opt-in delivery runtime; never writes Git.
// Stage is operator/runtime-only: public proposals accept an opaque reference, not objects or approval flags.
import {randomUUID} from 'node:crypto';
import {canonical,digest} from './approval-ledger.js';
import {verifyObjects} from './delivery-object-plan.js';
const fail=code=>{throw Error('DELIVERY_APPROVAL_'+code);};
const proofHash=r=>digest({task_id:r.task_id,spec_revision:r.spec_revision,task_hash:r.task_hash,proposal:JSON.parse(r.proposal),repository_revision:r.repository_revision,expires:r.expires});
const same=(a,b)=>canonical(a)===canonical(b);
export class DeliveryApproval {
 constructor({ledger,preview,journal,enabled=false}){
  this.l=ledger;this.db=ledger.db;this.preview=preview;this.j=journal;this.enabled=enabled;
  if(journal.db!==this.db||preview.db!==this.db)fail('DATABASE_MISMATCH');
  this.db.exec(`CREATE TABLE IF NOT EXISTS delivery_approval_plans(id TEXT PRIMARY KEY,event_id TEXT UNIQUE NOT NULL,
   task_id TEXT NOT NULL,event_fingerprint TEXT NOT NULL,snapshot TEXT NOT NULL,created INTEGER NOT NULL);`);
  this.db.exec(`CREATE TABLE IF NOT EXISTS delivery_plan_objects(plan_id TEXT NOT NULL,ordinal INTEGER NOT NULL,
   oid TEXT NOT NULL,type TEXT NOT NULL,bytes BLOB NOT NULL,PRIMARY KEY(plan_id,ordinal),UNIQUE(plan_id,oid));`);
 }
 sourceEvidence(p){
  // Completed development is historical evidence. Superseding its approval must not erase it.
  const r=this.db.prepare('SELECT * FROM development_requests WHERE id=?').get(p.request_id);
  if(!r||r.task_id!==p.task_id||r.state!=='completed'||r.approval_id!==p.source_approval.id||r.expected_hash!==p.tested_content.sha256)fail('SOURCE_CHANGED');
  const a=this.l.row(r.approval_id);if(a.task_id!==p.task_id||a.spec_revision!==p.spec_revision||a.proposal_hash!==p.source_approval.proposal_hash||proofHash(a)!==a.proposal_hash)fail('SOURCE_CHANGED');
  const operations=this.db.prepare('SELECT * FROM development_operations WHERE request_id=? ORDER BY id').all(r.id);
  const writes=this.db.prepare('SELECT * FROM development_writes WHERE request_id=? ORDER BY id').all(r.id);
  if(operations.some(o=>o.state!=='closed')||writes.some(w=>w.state!=='applied'))fail('SOURCE_CHANGED');
  const commands=this.db.prepare('SELECT * FROM development_commands WHERE request_id=? ORDER BY id').all(r.id);
  const safe=this.db.prepare("SELECT data FROM development_events WHERE request_id=? AND type='safe_point' ORDER BY seq DESC LIMIT 1").get(r.id);
  return digest({request:r,operations,writes,commands,safe,source_approval_hash:a.proposal_hash});
 }
 stage({event_id,task_id,preview_id,fingerprint,resource,workspace_identity,plan,objects}){
  if(this.enabled!==true)fail('DISABLED');
  if(typeof event_id!=='string'||!event_id.trim()||event_id.length>256||/[\x00-\x1f\x7f]/.test(event_id))fail('INVALID_EVENT');
  return this.l.store.tx(()=>{
   const intent=this.j.prepare({task_id,resource,workspace_identity,plan,objects});
   const event_fingerprint=digest({task_id,preview_id,fingerprint,intent});
   const old=this.db.prepare('SELECT * FROM delivery_approval_plans WHERE event_id=?').get(event_id);
   if(old){if(old.event_fingerprint!==event_fingerprint)fail('EVENT_CONFLICT');const s=this.stored(task_id,old.id,JSON.parse(old.snapshot).fingerprint);return {reference:this.reference(s),replayed:true,grants_execution:false};}
   const p=this.preview.stored(task_id,preview_id,fingerprint),head=this.l.catalog.head(task_id);
   if(head.legacy||head.spec_revision!==p.spec_revision||this.l.store.task(task_id).blocked)fail('TASK_CHANGED');
   const checked=this.preview.checked(p),changes=p.files.map(f=>({path:f.path,action:f.approved_action,before_sha256:f.before_sha256,after_sha256:f.after_sha256})).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
   if(p.repository.url!==resource||p.workspace_branch!==plan.branch||p.baseline_commit!==plan.parent||
    !same({kind:p.tested_content.kind,sha256:p.tested_content.sha256},plan.tested_content)||!same(changes,plan.changes)||!same(checked.w.identity(),workspace_identity))fail('PREVIEW_MISMATCH');
   // The private read adapter re-compiles against actual bytes; preview metadata alone is insufficient.
   this.j.readiness(intent);
   const body={schema:1,kind:'commit-approval-plan-v1',id:'commit-plan-'+randomUUID(),task_id,spec_revision:p.spec_revision,task_hash:digest(head.goal),
    preview_id:p.id,preview_fingerprint:p.fingerprint,repository:structuredClone(p.repository),policy:structuredClone(checked.a.proposal.model_policy),
    source_evidence_hash:this.sourceEvidence(p),intent,created:this.l.now()};
   const s={...body,fingerprint:digest(body)};
   this.db.prepare('INSERT INTO delivery_approval_plans VALUES (?,?,?,?,?,?)').run(s.id,event_id,task_id,event_fingerprint,canonical(s),s.created);
   const put=this.db.prepare('INSERT INTO delivery_plan_objects VALUES (?,?,?,?,?)');
   objects.forEach((o,n)=>put.run(s.id,n,o.oid,o.type,Buffer.from(o.data)));
   return {reference:this.reference(s),replayed:false,grants_execution:false};
  });
 }
 reference(s){return {kind:'commit-execution-reference-v1',plan_id:s.id,fingerprint:s.fingerprint};}
 objects(s){
  // Durable exact bytes allow queue admission while the workspace is busy. No
  // regeneration from mutable worktree contents, and no caller-supplied objects.
  const rows=this.db.prepare('SELECT oid,type,bytes FROM delivery_plan_objects WHERE plan_id=? ORDER BY ordinal').all(s.id);
  const objects=rows.map(o=>({oid:o.oid,type:o.type,data:Buffer.from(o.bytes)}));
  verifyObjects(s.intent.plan,objects);return objects;
 }
 stored(task,id,fingerprint){
  const row=this.db.prepare('SELECT * FROM delivery_approval_plans WHERE id=?').get(id);if(!row||row.task_id!==task)fail('PLAN_NOT_FOUND');
  const s=JSON.parse(row.snapshot),{fingerprint:hash,...body}=s,{fingerprint:ih,...ib}=s.intent??{}, {fingerprint:ph,...pb}=s.intent?.plan??{};
  if(s.id!==id||s.task_id!==task||s.kind!=='commit-approval-plan-v1'||s.schema!==1||hash!==fingerprint||digest(body)!==hash||digest(ib)!==ih||digest(pb)!==ph)fail('PLAN_CHANGED');return s;
 }
 current(s,revision){
  const h=this.l.catalog.head(s.task_id),p=this.preview.stored(s.task_id,s.preview_id,s.preview_fingerprint);
  if(s.spec_revision!==revision||h.spec_revision!==revision||digest(h.goal)!==s.task_hash||
   this.l.store.task(s.task_id).revision!==s.intent.task_revision||this.sourceEvidence(p)!==s.source_evidence_hash)fail('SOURCE_CHANGED');
  return p;
 }
 snapshot(s){
  const p=s.intent.plan;
  return {kind:'commit-execution-v1',plan_id:s.id,fingerprint:s.fingerprint,intent_fingerprint:s.intent.fingerprint,plan_fingerprint:p.fingerprint,
   preview_id:s.preview_id,preview_fingerprint:s.preview_fingerprint,task_revision:s.spec_revision,workspace_revision:s.intent.task_revision,
   repository_fingerprint:s.repository.fingerprint,workspace_branch:p.branch,baseline_commit:p.parent,computed_commit_oid:p.computed_commit_oid,
   tree_oid:p.tree_oid,format:p.format,manifest_sha256:p.manifest_sha256,tested_content:structuredClone(p.tested_content),
   files_digest:digest(p.changes),file_count:p.changes.length,author:structuredClone(p.author),committer:structuredClone(p.committer),
   timestamp:p.when,commit_message:p.message,source_evidence_hash:s.source_evidence_hash,execution:'requires_runtime_gate',
   hooks:false,filters:false,signed:false,max_commits:1,push:false,publish:false,deploy:false};
 }
 approvalSnapshot(task,revision,reference,repository,policy){
  if(reference.kind!=='commit-execution-reference-v1')return this.preview.approvalSnapshot(task,revision,reference,repository,policy);
  if(this.enabled!==true)fail('DISABLED');const s=this.stored(task,reference.plan_id,reference.fingerprint),p=this.current(s,revision);
  if(!same(s.repository,repository)||!same(s.policy,policy))fail('BINDING_CHANGED');
  this.preview.checked(p);this.j.readiness(s.intent);return this.snapshot(s);
 }
 matches(task,revision,plan){
  if(plan?.kind!=='commit-execution-v1')return this.preview.matches(task,revision,plan);
  try{const s=this.stored(task,plan.plan_id,plan.fingerprint);this.current(s,revision);return same(this.snapshot(s),plan);}catch{return false;}
 }
 decisionProof(r){
  const d=this.db.prepare('SELECT * FROM approval_decisions WHERE id=?').get(r.decision_id);
  if(!d||d.request_id!==r.id||d.action!=='approve'||!d.principal)fail('PROOF_REQUIRED');
  if(d.credential_id?.startsWith('chat:')){
   const proof=this.db.prepare('SELECT * FROM approval_chat_proofs WHERE challenge_id=?').get(d.challenge_id);
   const b=proof&&this.db.prepare('SELECT * FROM approval_chat_bindings WHERE id=? AND disabled=0').get(proof.binding_hash);
   const route=this.db.prepare('SELECT * FROM approval_chat_deliveries WHERE request_id=?').get(r.id);
   if(!proof||!b||!route)fail('PROOF_REQUIRED');const p=JSON.parse(proof.proof),binding=JSON.parse(b.binding);
   if(proof.proof_hash!==d.proof_hash||digest(p)!==d.proof_hash||d.credential_id!=='chat:'+b.id||digest(binding)!==b.id||
    p.provider!=='feishu'||p.binding_hash!==b.id||p.request_id!==r.id||p.proposal_hash!==r.proposal_hash||p.actor!==binding.approverOpenId||
    d.principal!==`feishu:${binding.appId}:${binding.approverOpenId}`||p.message_id!==proof.message_id||p.parent_id!==route.message_id||
    p.prompt_version!==route.prompt_version||route.binding_hash!==b.id||route.state!=='sent'||
    (p.interpretation?(p.interpretation.intent!=='approve'||p.interpretation.unconditional!==true):!['确定','/yes'].includes(p.text?.trim())))fail('PROOF_REQUIRED');
  }else{
   const c=this.db.prepare('SELECT * FROM approval_credentials WHERE id=? AND disabled=0').get(d.credential_id);
   const q=this.db.prepare('SELECT * FROM approval_challenges WHERE id=?').get(d.challenge_id);
   if(!c||c.principal!==d.principal||q?.kind!=='decision'||q.used!==1)fail('PROOF_REQUIRED');
   const binding=JSON.parse(q.binding),result=JSON.parse(q.result??'null');
   if(binding.request_id!==r.id||binding.action!=='approve'||binding.proposal_hash!==r.proposal_hash||result?.proof_hash!==d.proof_hash)fail('PROOF_REQUIRED');
  }
  return {decision_id:d.id,proof_hash:d.proof_hash};
 }
 readSnapshot(fn){
  // Can run inside the journal's write transaction. A nested BEGIN would break enqueue/acquire.
  const name='delivery_authority_'+randomUUID().replaceAll('-','');this.db.exec('SAVEPOINT '+name);
  try{const result=fn();this.db.exec('RELEASE '+name);return result;}catch(e){this.db.exec('ROLLBACK TO '+name);this.db.exec('RELEASE '+name);throw e;}
 }
 authorize({approval_id,intent}){
  if(this.enabled!==true)fail('DISABLED');
  return this.readSnapshot(()=>{
   const r=this.l.row(approval_id),v=this.l.view(approval_id),p=v.proposal.delivery;
   if(v.state!=='approved'||!same(v.proposal.scopes,['commit'])||p?.kind!=='commit-execution-v1'||proofHash(r)!==r.proposal_hash)fail('EXECUTION_APPROVAL_REQUIRED');
   const s=this.stored(r.task_id,p.plan_id,p.fingerprint);
   if(!same(s.intent,intent)||!same(s.policy,v.proposal.model_policy)||!same(s.repository,v.proposal.repository))fail('INTENT_CHANGED');
   const proof=this.decisionProof(r);
   return {kind:'delivery-execution-v1',scope:'commit',execution:true,approval_id:r.id,task_id:r.task_id,task_revision:intent.task_revision,
    intent_fingerprint:intent.fingerprint,authority_hash:digest({approval_id:r.id,proposal_hash:r.proposal_hash,intent_fingerprint:intent.fingerprint,...proof})};
  });
 }
}
