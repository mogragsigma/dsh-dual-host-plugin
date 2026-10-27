import {randomUUID} from 'node:crypto';
import {canonical,digest} from './approval-ledger.js';
import {approvedDevelopment} from './development-contract.js';
import {DevelopmentWorkspace} from './development-workspace.js';
import {DevelopmentFiles} from './development-files.js';
const uuid=x=>typeof x==='string'&&/^[a-f0-9-]{36}$/.test(x);
const fields=(a,n)=>{if(!a||typeof a!=='object'||Array.isArray(a)||Object.keys(a).some(k=>!n.includes(k)))throw Error('DEVELOPMENT_REVIEW_INVALID');};
const binding=['id','endpoint_id','ticket','epoch'];
// All evidence stays within the authenticated role and original claim. This is
// internal operator reconciliation, never a model tool, automatic retry or new approval.
export class DevelopmentReconciliation {
 constructor(bridge){this.b=bridge;this.gate=bridge.gate;this.db=bridge.db;
  this.db.exec(`CREATE TABLE IF NOT EXISTS development_bridge_reviews(event_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,request_id TEXT NOT NULL,node TEXT NOT NULL,proof_hash TEXT NOT NULL,note TEXT NOT NULL,result TEXT NOT NULL,created INTEGER NOT NULL);`);
 }
 evidence(a,node){
  const r=this.b.bound(a,node),t=this.gate.store.task(r.task_id);
  const v=this.gate.ledger.view(r.approval_id),approvalState=this.gate.ledger.validity(this.gate.ledger.row(r.approval_id),{ignoreTaskBlock:true});
  let workspace='unverified',actual_hash=null;
  try{const auth=approvedDevelopment(this.gate.ledger,r.task_id,r.approval_id,JSON.parse(r.policy),{review:true}),binding=this.gate.bindings[r.task_id];
   if(!binding||binding.approval_hash!==auth.hash||auth.hash!==r.authority_hash||!auth.spec.executors?.includes(node))throw Error('DEVELOPMENT_APPROVAL_CHANGED');
   const w=new (auth.spec.kind==='workspace-v1'?DevelopmentFiles:DevelopmentWorkspace)(binding,auth.spec,auth.approval.proposal.repository);this.gate.assertWorkspace(r,w);actual_hash=w.check(r.expected_hash).hash;workspace='verified';
  }catch{}
  const writes=this.db.prepare('SELECT id,fingerprint,old_hash,new_hash,state FROM development_writes WHERE request_id=? ORDER BY created,id').all(r.id);
  const tests=this.db.prepare('SELECT id,fingerprint,state,result FROM development_bridge_tests WHERE request_id=? ORDER BY rowid').all(r.id).map(x=>({...x,result:x.result?JSON.parse(x.result):null}));
  const commands=this.db.prepare('SELECT id,command_id,fingerprint,operation_id,state,result FROM development_commands WHERE request_id=? ORDER BY rowid').all(r.id).map(x=>({...x,result:x.result?JSON.parse(x.result):null}));
  const operations=this.db.prepare('SELECT id,epoch,state,closed,exit_code,signal FROM development_operations WHERE request_id=? ORDER BY started,id').all(r.id);
  const called=this.db.prepare("SELECT data FROM development_events WHERE request_id=? AND type='write_tool_called' ORDER BY seq").all(r.id).map(x=>JSON.parse(x.data));
  const unsettled=called.some(x=>!writes.some(w=>w.id===r.id+':'+x.call_id&&w.state==='applied'));
  const evidence={schema:1,request_id:r.id,node:r.node,state:r.state,epoch:r.epoch,endpoint_id:a.endpoint_id,authority_hash:r.authority_hash,
   expected_hash:r.expected_hash,actual_hash,workspace,approval_state:approvalState,approval_hash:v.proposal_hash,
   repository_fresh:!!this.gate.ledger.repositories?.status(r.task_id).verification_fresh,
   task:{owner:t.owner,epoch:t.epoch,busy:!!t.busy,blocked:!!t.blocked},writes,tests,operations,...(v.proposal.development?.kind==='workspace-v1'?{commands}:{}),
   unsettled_write_calls:unsettled,legacy_operations_unsettled:!!this.db.prepare("SELECT 1 FROM intents WHERE task_id=? AND status IN ('granted','writing')").get(r.task_id),local_operations_drained:!this.gate.inflight.has(r.id),grants_execution:false};
  return {evidence,proof_hash:digest(evidence)};
 }
 async call(method,a,node){
  if(method==='development_bridge_evidence'){fields(a,binding);return this.evidence(a,node);}
  fields(a,[...binding,'event_id','proof_hash','note','new_endpoint_id']);
  if(typeof a.event_id!=='string'||!a.event_id||a.event_id.length>256||!uuid(a.new_endpoint_id)||typeof a.note!=='string'||!a.note.trim()||a.note.length>2000||!(/^[a-f0-9]{64}$/).test(a.proof_hash??''))throw Error('DEVELOPMENT_REVIEW_INVALID');
  const fp=digest(a),old=this.db.prepare('SELECT * FROM development_bridge_reviews WHERE event_id=?').get(a.event_id);
  if(old){if(old.node!==node||old.fingerprint!==fp)throw Error('DEVELOPMENT_REVIEW_CONFLICT');return {...JSON.parse(old.result),replayed:true};}
  const initial=this.b.bound(a,node);await this.b.g.repositories.refresh(initial.task_id);
  return this.gate.store.tx(()=>{
   const prior=this.db.prepare('SELECT * FROM development_bridge_reviews WHERE event_id=?').get(a.event_id);
   if(prior){if(prior.node!==node||prior.fingerprint!==fp)throw Error('DEVELOPMENT_REVIEW_CONFLICT');return {...JSON.parse(prior.result),replayed:true};}
   const snapshot=this.evidence(a,node),e=snapshot.evidence,r=this.gate.row(a.id);
   if(snapshot.proof_hash!==a.proof_hash)throw Error('DEVELOPMENT_REVIEW_STALE_EVIDENCE');
   if(!this.gate.enabled||this.gate.busy(r.task_id)||!['active','needs_review'].includes(r.state)||e.task.owner!==node||e.task.epoch!==r.epoch||!e.task.busy||
      (e.task.blocked&&r.state!=='needs_review')||e.approval_state!=='approved'||!e.repository_fresh||e.workspace!=='verified'||
      !e.local_operations_drained||e.unsettled_write_calls||e.legacy_operations_unsettled||e.writes.some(w=>w.state!=='applied')||
      e.operations.some(o=>o.state!=='closed')||e.tests.some(t=>t.state!=='completed')||(e.commands??[]).some(c=>c.state!=='completed'||!c.result?.drained)||
      (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='development_jobs'").get()&&this.db.prepare('SELECT 1 FROM development_jobs WHERE request_id=?').get(r.id)))throw Error('DEVELOPMENT_REVIEW_NOT_AVAILABLE');
   const epoch=r.epoch+1,ticket=randomUUID();
   this.db.prepare("UPDATE tasks SET epoch=?,blocked=0 WHERE id=?").run(epoch,r.task_id);
   this.db.prepare("UPDATE development_requests SET state='active',epoch=?,error=NULL WHERE id=?").run(epoch,r.id);
   this.db.prepare('UPDATE development_bridge_claims SET endpoint_id=?,ticket=?,epoch=? WHERE request_id=?').run(a.new_endpoint_id,ticket,epoch,r.id);
   const result={id:r.id,endpoint_id:a.new_endpoint_id,ticket,epoch,prior_epoch:r.epoch,review_event:a.event_id,request_preserved:true,budget_reset:false,starts_worker:false,scope:'same-approved-cloud-checkout'};
   this.db.prepare('INSERT INTO development_bridge_reviews VALUES (?,?,?,?,?,?,?,?)').run(a.event_id,fp,r.id,node,a.proof_hash,a.note,canonical(result),this.gate.now());
   this.gate.event(r.id,'bridge_review_applied',{event_id:a.event_id,proof_hash:a.proof_hash,prior_epoch:r.epoch,epoch,node});return result;
  });
 }
}
