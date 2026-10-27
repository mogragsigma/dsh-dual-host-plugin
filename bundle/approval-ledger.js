import {developmentSpec} from './development-contract.js';
import {deliveryReference,deliveryExecution} from './delivery-contract.js';
import {createHash,randomUUID} from 'node:crypto';
import {newCloudPolicy,validPolicy} from './task-context.js';
import {parseEnvelope} from './task-envelope.js';
export const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
export const digest=v=>createHash('sha256').update(typeof v==='string'?v:canonical(v)).digest('hex');
export const scopes=['develop','commit','push','publish','deploy'];
const text=(x,n)=>{if(typeof x!=='string'||!x.trim()||x.length>n)throw Error('INVALID_APPROVAL_PROPOSAL');return x;};
function proposal(p){
 if(!p||Object.keys(p).some(k=>!['summary','changes','validation','risks','rollback','model_policy','scopes','repository','development','delivery'].includes(k)))throw Error('INVALID_APPROVAL_PROPOSAL');
 if(!Array.isArray(p.scopes)||!p.scopes.length||p.scopes.length>5||new Set(p.scopes).size!==p.scopes.length||p.scopes.some(x=>!scopes.includes(x)))throw Error('INVALID_APPROVAL_SCOPE');
 // Only an opaque reference is accepted. The coordinator supplies the immutable provider-verified snapshot.
 if(p.repository!==null&&(!p.repository||typeof p.repository!=='object'||Array.isArray(p.repository)||Object.keys(p.repository).some(k=>!['binding_revision','fingerprint'].includes(k))||!Number.isInteger(p.repository.binding_revision)||p.repository.binding_revision<1||!(/^[a-f0-9]{64}$/).test(p.repository.fingerprint??'')))throw Error('REPOSITORY_BINDING_NOT_IMPLEMENTED');
 const result={summary:text(p.summary,1000),changes:text(p.changes,4000),validation:text(p.validation,2000),risks:text(p.risks,2000),rollback:text(p.rollback,2000),model_policy:validPolicy(p.model_policy),scopes:[...p.scopes].sort(),repository:p.repository};
 if(p.development!==undefined){if(p.scopes.length!==1||p.scopes[0]!=='develop'||p.repository===null)throw Error('DEVELOPMENT_SCOPE_DENIED');result.development=developmentSpec(p.development);}
 if(p.delivery!==undefined){if(p.development!==undefined||p.scopes.length!==1||p.scopes[0]!==(p.delivery?.kind==='push-execution-reference-v1'?'push':'commit')||p.repository===null)throw Error('DELIVERY_SCOPE_DENIED');result.delivery=deliveryReference(p.delivery);}
 if(canonical(result).length>12000)throw Error('APPROVAL_PROPOSAL_TOO_LARGE');return result;
}
export class ApprovalLedger {
 constructor(store,catalog,now=Date.now,repositories=null){
  this.store=store;this.db=store.db;this.catalog=catalog;this.now=now;this.repositories=repositories;
  this.db.exec(`CREATE TABLE IF NOT EXISTS approval_requests(id TEXT PRIMARY KEY,event_id TEXT UNIQUE,fingerprint TEXT,task_id TEXT,spec_revision INTEGER,task_hash TEXT,proposal TEXT,proposal_hash TEXT,state TEXT,created INTEGER,expires INTEGER,decision_id TEXT);
   CREATE TABLE IF NOT EXISTS approval_decisions(id TEXT PRIMARY KEY,request_id TEXT,action TEXT,principal TEXT,credential_id TEXT,proof_hash TEXT UNIQUE,challenge_id TEXT UNIQUE,created INTEGER);
   CREATE TABLE IF NOT EXISTS approval_credentials(id TEXT PRIMARY KEY,principal TEXT NOT NULL,public_key BLOB NOT NULL,counter INTEGER NOT NULL,disabled INTEGER NOT NULL DEFAULT 0,created INTEGER);
   CREATE TABLE IF NOT EXISTS approval_challenges(id TEXT PRIMARY KEY,kind TEXT,challenge TEXT,binding TEXT,expires INTEGER,used INTEGER DEFAULT 0,result TEXT);
   CREATE TABLE IF NOT EXISTS approval_enrollment(ticket_hash TEXT PRIMARY KEY,principal TEXT,expires INTEGER,used INTEGER DEFAULT 0);
   CREATE TABLE IF NOT EXISTS approval_chat_evaluations(binding_hash TEXT NOT NULL,message_id TEXT NOT NULL,request_id TEXT NOT NULL,state TEXT NOT NULL,created INTEGER NOT NULL,interpretation TEXT,last_error TEXT,PRIMARY KEY(binding_hash,message_id));
   CREATE TABLE IF NOT EXISTS approval_chat_bindings(id TEXT PRIMARY KEY,binding TEXT NOT NULL,disabled INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS approval_chat_deliveries(request_id TEXT PRIMARY KEY,binding_hash TEXT NOT NULL,uuid TEXT UNIQUE,text TEXT NOT NULL,state TEXT NOT NULL,created INTEGER,message_id TEXT UNIQUE,last_error TEXT,prompt_version TEXT);
   CREATE TABLE IF NOT EXISTS approval_chat_proofs(challenge_id TEXT PRIMARY KEY,binding_hash TEXT NOT NULL,message_id TEXT NOT NULL,proof_hash TEXT UNIQUE,proof TEXT NOT NULL,created INTEGER,UNIQUE(binding_hash,message_id));
   CREATE TABLE IF NOT EXISTS approval_receipts(decision_id TEXT PRIMARY KEY,request_id TEXT NOT NULL,binding_hash TEXT NOT NULL,uuid TEXT UNIQUE NOT NULL,state TEXT NOT NULL,created INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,text TEXT,snapshot_state TEXT,snapshot_at INTEGER,message_id TEXT UNIQUE,last_error TEXT);`);
  if(!this.db.prepare('PRAGMA table_info(approval_requests)').all().some(c=>c.name==='repository_revision'))this.db.exec('ALTER TABLE approval_requests ADD COLUMN repository_revision INTEGER NOT NULL DEFAULT 0');
  if(!this.db.prepare('PRAGMA table_info(approval_chat_deliveries)').all().some(c=>c.name==='semantics_version'))this.db.exec('ALTER TABLE approval_chat_deliveries ADD COLUMN semantics_version INTEGER NOT NULL DEFAULT 0');
  if(!this.db.prepare('PRAGMA table_info(approval_chat_deliveries)').all().some(c=>c.name==='prompt_version'))this.db.exec('ALTER TABLE approval_chat_deliveries ADD COLUMN prompt_version TEXT');
 }
 request(node,a){
  if(!['local','cloud'].includes(node)||!a||!Number.isInteger(a.expected_revision)||a.expected_revision<1)throw Error('INVALID_APPROVAL_REQUEST');
  const event=text(a.event_id,256),task_id=text(a.task_id,128),p=proposal(a.proposal),ttl=a.ttl_seconds??3600;
  if(!Number.isInteger(ttl)||ttl<60||ttl>86400)throw Error('INVALID_APPROVAL_EXPIRY');
  const fp=digest({node,task_id,revision:a.expected_revision,proposal:p,ttl});
  return this.store.tx(()=>{
   const old=this.db.prepare('SELECT id,fingerprint FROM approval_requests WHERE event_id=?').get(event);
   if(old){if(old.fingerprint!==fp)throw Error('APPROVAL_EVENT_CONFLICT');return this.view(old.id);}
   const h=this.catalog.head(task_id);if(h.legacy)throw Error('LEGACY_TASK_READONLY');if(h.spec_revision!==a.expected_revision)throw Error('TASK_REVISION_CONFLICT');
   if(this.store.task(task_id).blocked)throw Error('TASK_BLOCKED');
   if(!this.repositories&&p.repository!==null)throw Error('REPOSITORY_BINDING_NOT_IMPLEMENTED');
   const binding=this.repositories?.approvalSnapshot(task_id,p.repository)??{revision:0,snapshot:null},resolved={...p,model_policy:newCloudPolicy(p.model_policy),repository:binding.snapshot};
   if(p.delivery){if(!this.delivery)throw Error('DELIVERY_CAPABILITY_REQUIRED');resolved.delivery=this.delivery.approvalSnapshot(task_id,h.spec_revision,p.delivery,binding.snapshot,resolved.model_policy);}
   if(canonical(resolved).length>16000)throw Error('APPROVAL_PROPOSAL_TOO_LARGE');
   const previous=this.db.prepare("SELECT proposal FROM approval_requests WHERE task_id=? AND state='changes_requested' ORDER BY created DESC,rowid DESC LIMIT 1").get(task_id);
   if(previous&&canonical(JSON.parse(previous.proposal))===canonical(resolved))throw Error('APPROVAL_AMENDMENT_REQUIRED');
   const id='approval-'+randomUUID(),created=this.now(),expires=created+ttl*1000,task_hash=digest(h.goal),proposal_hash=digest({task_id,spec_revision:h.spec_revision,task_hash,proposal:resolved,repository_revision:binding.revision,expires});
   this.db.prepare("UPDATE approval_requests SET state='superseded' WHERE task_id=? AND state IN ('pending','approved','held','clarification_required','changes_requested')").run(task_id);
   this.db.prepare("INSERT INTO approval_requests (id,event_id,fingerprint,task_id,spec_revision,task_hash,proposal,proposal_hash,state,created,expires,decision_id,repository_revision) VALUES (?,?,?,?,?,?,?,?,'pending',?,?,NULL,?)").run(id,event,fp,task_id,h.spec_revision,task_hash,canonical(resolved),proposal_hash,created,expires,binding.revision);
   return this.view(id);
  });
 }
 row(id){const r=this.db.prepare('SELECT * FROM approval_requests WHERE id=?').get(id);if(!r)throw Error('APPROVAL_NOT_FOUND');return r;}
 validity(r,{ignoreInterpretation=false,ignoreTaskBlock=false}={}){
  const h=this.catalog.head(r.task_id);if(r.state==='superseded'||r.state==='revoked'||r.state==='rejected'||r.state==='repository_changed'||r.state==='changes_requested')return r.state;
  if(r.expires<=this.now())return 'expired';
  if(h.spec_revision!==r.spec_revision||digest(h.goal)!==r.task_hash)return 'stale_revision';
  if(!ignoreTaskBlock&&this.store.task(r.task_id).blocked)return 'task_blocked';
  if(this.repositories&&!this.repositories.matches(r.task_id,r.repository_revision,JSON.parse(r.proposal).repository))return 'repository_changed';
  const proposal=JSON.parse(r.proposal),delivery=proposal.delivery;
  if(delivery&&(canonical(proposal.scopes)!==canonical([delivery.kind==='push-execution-v1'?'push':'commit'])||digest({task_id:r.task_id,spec_revision:r.spec_revision,task_hash:r.task_hash,proposal,repository_revision:r.repository_revision,expires:r.expires})!==r.proposal_hash||!this.delivery?.matches(r.task_id,r.spec_revision,delivery)))return 'delivery_changed';
  if(!ignoreInterpretation&&this.db.prepare("SELECT 1 FROM approval_chat_evaluations WHERE request_id=? AND state IN ('processing','needs_review')").get(r.id))return 'confirmation_review';
  if(r.state==='approved'){
   const d=this.db.prepare('SELECT credential_id,challenge_id,proof_hash FROM approval_decisions WHERE id=?').get(r.decision_id);
   if(d?.credential_id?.startsWith('workbench-im:')){
    const exists=this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workbench_im_proofs'").get();
    const p=exists&&this.db.prepare('SELECT binding_hash,proof_hash FROM workbench_im_proofs WHERE challenge_id=?').get(d.challenge_id),b=p&&this.db.prepare('SELECT disabled FROM approval_chat_bindings WHERE id=?').get(p.binding_hash);
    if(!b||b.disabled||d.credential_id!=='workbench-im:'+p.binding_hash||d.proof_hash!==p.proof_hash)return 'identity_revoked';
   }else if(d?.credential_id?.startsWith('chat:')){
    const p=this.db.prepare('SELECT binding_hash,proof_hash FROM approval_chat_proofs WHERE challenge_id=?').get(d.challenge_id),b=p&&this.db.prepare('SELECT disabled FROM approval_chat_bindings WHERE id=?').get(p.binding_hash);
    if(!b||b.disabled||d.credential_id!=='chat:'+p.binding_hash||d.proof_hash!==p.proof_hash)return 'identity_revoked';
   }else{const c=d&&this.db.prepare('SELECT disabled FROM approval_credentials WHERE id=?').get(d.credential_id);if(!c||c.disabled)return 'identity_revoked';}
  }
  return r.state;
 }
 view(id){const r=this.row(id),revision=this.db.prepare('SELECT title,goal FROM task_revisions WHERE task_id=? AND revision=?').get(r.task_id,r.spec_revision),e=parseEnvelope(revision.goal);return {id:r.id,task_id:r.task_id,title:revision.title,spec_revision:r.spec_revision,task_sources:e?.task_context?.sources?.map(s=>s.text)??[e?.request_text??revision.goal],proposal:JSON.parse(r.proposal),proposal_hash:r.proposal_hash,recorded_state:r.state,state:this.validity(r),created:r.created,expires:r.expires,decision:r.decision_id?this.db.prepare('SELECT action,principal,created FROM approval_decisions WHERE id=?').get(r.decision_id):null,execution:deliveryExecution(JSON.parse(r.proposal))?'requires_delivery_runtime_gate':JSON.parse(r.proposal).development?'requires_runtime_gate':'disabled',repository_revision:r.repository_revision,repository_binding:JSON.parse(r.proposal).repository?'metadata_only':'unbound',feedback:this.feedback(r.id)};}
 list(task_id){if(task_id)this.store.task(task_id);return this.db.prepare('SELECT id FROM approval_requests '+(task_id?'WHERE task_id=? ':'')+'ORDER BY created DESC,id LIMIT 100').all(...(task_id?[task_id]:[])).map(x=>this.view(x.id));}
 feedback(id){
  const current=this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workbench_im_proofs'").get()?this.db.prepare('SELECT p.* FROM workbench_im_proofs p JOIN approval_decisions d ON d.challenge_id=p.challenge_id JOIN approval_requests r ON r.decision_id=d.id WHERE r.id=?').get(id):null;
  if(current){const i=JSON.parse(current.interpretation);return {...i,user_text:current.user_text,requires_new_proposal:i.intent==='amend',source:'workbench-existing-im'};}
  const row=this.db.prepare("SELECT p.proof FROM approval_chat_proofs p JOIN approval_decisions d ON d.challenge_id=p.challenge_id WHERE d.request_id=? ORDER BY d.created DESC,d.rowid DESC LIMIT 1").get(id);
  const web=this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='approval_workbench_proofs'").get()?this.db.prepare('SELECT p.* FROM approval_workbench_proofs p JOIN approval_requests r ON r.decision_id=(SELECT id FROM approval_decisions WHERE challenge_id=p.challenge_id) WHERE r.id=?').get(id):null;
  if(web){const i=JSON.parse(web.interpretation);return {...i,user_text:web.user_text,requires_new_proposal:i.intent==='amend',source:'workbench'};}
  if(!row)return null;const p=JSON.parse(row.proof);return p.interpretation?{...p.interpretation,user_text:p.text,requires_new_proposal:p.interpretation.intent==='amend'}:null;
 }
 assertDecision(id,action,{chatEvaluation=false,workbenchEvaluation=false}={}){
  const r=this.row(id);if(!['approve','reject','revoke',...((chatEvaluation||workbenchEvaluation)?['hold','amend','clarify']:[])].includes(action))throw Error('INVALID_APPROVAL_ACTION');
  const state=this.validity(r,{ignoreInterpretation:chatEvaluation});
  if(chatEvaluation||workbenchEvaluation){if(!['pending','approved','held','clarification_required'].includes(state))throw Error('APPROVAL_NOT_PENDING');}
  else if(action==='revoke'){if(r.state!=='approved')throw Error('APPROVAL_NOT_APPROVED');}
  else if(!['pending','held','clarification_required'].includes(state))throw Error('APPROVAL_NOT_PENDING');
  return r;
 }
 // Internal ledger operation. Runtime authority currently comes from a verified IM reply.
 // Historical credential/proof rows remain readable; retired ceremonies have no live entry.
 recordDecision({request_id,action,principal,credential_id,proof_hash,challenge_id,chatEvaluation=false,workbenchEvaluation=false,workbenchIM=false}){
  if(workbenchIM){
   const p=this.db.prepare('SELECT * FROM workbench_im_proofs WHERE challenge_id=?').get(challenge_id),b=p&&this.db.prepare('SELECT disabled FROM approval_chat_bindings WHERE id=?').get(p.binding_hash);
   if(!p||!b||b.disabled||credential_id!=='workbench-im:'+p.binding_hash||p.request_id!==request_id||p.credential_id!==credential_id||p.principal!==principal||p.action!==action||p.proof_hash!==proof_hash||digest(JSON.parse(p.proof))!==proof_hash)throw Error('APPROVAL_WORKBENCH_PROOF_REQUIRED');
  }
  if(chatEvaluation){
   const proof=this.db.prepare('SELECT proof_hash FROM approval_chat_proofs WHERE challenge_id=?').get(challenge_id);
   if(!credential_id?.startsWith('chat:')||proof?.proof_hash!==proof_hash)throw Error('CHAT_PROOF_REQUIRED');
  }
  if(workbenchEvaluation){
   const p=this.db.prepare('SELECT * FROM approval_workbench_proofs WHERE challenge_id=?').get(challenge_id);
   if(!p||p.request_id!==request_id||p.credential_id!==credential_id||p.principal!==principal||p.action!==action||p.proof_hash!==proof_hash)throw Error('APPROVAL_WORKBENCH_PROOF_REQUIRED');
  }
  const r=this.assertDecision(request_id,action,{chatEvaluation,workbenchEvaluation:workbenchEvaluation||workbenchIM}),id='decision-'+randomUUID();
  this.db.prepare('INSERT INTO approval_decisions VALUES (?,?,?,?,?,?,?,?)').run(id,r.id,action,principal,credential_id,proof_hash,challenge_id,this.now());
  this.db.prepare('UPDATE approval_requests SET state=?,decision_id=? WHERE id=?').run({approve:'approved',reject:'rejected',revoke:'revoked',hold:'held',amend:'changes_requested',clarify:'clarification_required'}[action],id,r.id);
  this.enqueueReceipt(id);
  return this.view(r.id);
 }
 // Part of the decision transaction. A notification is never an authorization input.
 enqueueReceipt(decision_id,localWorkbenchBinding=null){
  const d=this.db.prepare('SELECT * FROM approval_decisions WHERE id=?').get(decision_id);
  if(!d)return;
  let route=this.db.prepare("SELECT * FROM approval_chat_deliveries WHERE request_id=? AND state IN ('sent','inactive') AND message_id IS NOT NULL AND prompt_version IS NOT NULL").get(d.request_id);
  // Only the live local-workbench decision transaction may create this fallback.
  // Historical startup backfill never supplies a binding and cannot reroute old decisions.
  if(d.credential_id?.startsWith('workbench-im:')){
   const p=this.db.prepare('SELECT * FROM workbench_im_proofs WHERE challenge_id=?').get(d.challenge_id);
   if(!p||p.request_id!==d.request_id||p.credential_id!==d.credential_id||p.proof_hash!==d.proof_hash)return;
   if(!route&&localWorkbenchBinding===p.binding_hash)route={binding_hash:p.binding_hash};
   if(route?.binding_hash!==p.binding_hash)return;
  }
  if(!route||this.db.prepare('SELECT disabled FROM approval_chat_bindings WHERE id=?').get(route.binding_hash)?.disabled!==0)return;
  if(d.credential_id?.startsWith('chat:')){
   const p=this.db.prepare('SELECT * FROM approval_chat_proofs WHERE challenge_id=?').get(d.challenge_id);
   if(!p||p.binding_hash!==route.binding_hash||d.credential_id!=='chat:'+p.binding_hash||p.proof_hash!==d.proof_hash)return;
  }
  this.db.prepare("INSERT OR IGNORE INTO approval_receipts(decision_id,request_id,binding_hash,uuid,state,created) VALUES (?,?,?,?,'queued',?)").run(d.id,d.request_id,route.binding_hash,randomUUID(),d.created);
 }
 check(id,action){const r=this.row(id),p=JSON.parse(r.proposal);return {approval_valid:this.validity(r)==='approved'&&p.scopes.includes(action),executable:false,reason:deliveryExecution(p)?'DELIVERY_RUNTIME_REQUIRED':p.delivery?'DELIVERY_EXECUTION_DISABLED':'DEVELOPMENT_DISABLED',...(p.delivery?{delivery_bound:true,filesystem_checked_now:false,content_recheck_required:true}: {})};}
}
