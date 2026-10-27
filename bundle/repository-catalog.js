import {randomUUID} from 'node:crypto';
import {digest,canonical} from './approval-ledger.js';
import {validSources,validPolicy} from './task-context.js';
const text=(v,n)=>{if(typeof v!=='string'||!v.trim()||v.length>n)throw Error('INVALID_REPOSITORY_ARGUMENT');return v;};
const FRESH_MS=300000;
// This catalog never receives RepositoryWriter and never acquires a lease or mutates a repository.
export class RepositoryCatalog {
 constructor(store,catalog,provider,now=Date.now,assertQuiescent=()=>{}){
  Object.assign(this,{store,db:store.db,catalog,provider,now,assertQuiescent});
  this.db.exec(`CREATE TABLE IF NOT EXISTS repository_resolutions(id TEXT PRIMARY KEY,reference TEXT,requested_branch TEXT,snapshot TEXT,fingerprint TEXT,created INTEGER,expires INTEGER);
   CREATE TABLE IF NOT EXISTS repository_associations(task_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,state TEXT NOT NULL,snapshot TEXT,fingerprint TEXT,verified INTEGER,last_error TEXT);
   CREATE TABLE IF NOT EXISTS repository_events(event_id TEXT PRIMARY KEY,fingerprint TEXT,result TEXT,sources TEXT,created INTEGER);`);
 }
 async resolve(a){
  const resolved=this.provider.resolve?await this.provider.resolve(a.reference,a.branch):null;
  const ref=resolved?.reference??await this.provider.reference(a.reference);if(ref.requires_clarification)return {...ref,execution:'disabled'};
  const snapshot=resolved?.snapshot??await this.provider.inspect(ref.url,a.branch),id='repo-'+randomUUID(),created=this.now(),fingerprint=digest(snapshot);
  this.db.prepare('INSERT INTO repository_resolutions VALUES (?,?,?,?,?,?,?)').run(id,a.reference,a.branch??null,canonical(snapshot),fingerprint,created,created+FRESH_MS);
  return {resolution_id:id,...snapshot,fingerprint,expires:created+FRESH_MS,branch_source:a.branch?'explicit':'provider_default',access:{read:'verified',write:'unknown'},execution:'disabled'};
 }
 row(task_id){this.store.task(task_id);return this.db.prepare('SELECT * FROM repository_associations WHERE task_id=?').get(task_id)??{task_id,revision:0,state:'unbound',snapshot:null,fingerprint:null,verified:null,last_error:null};}
 status(task_id){const r=this.row(task_id);return {task_id,binding_revision:r.revision,state:r.state,repository:r.snapshot?{...JSON.parse(r.snapshot),binding_revision:r.revision,fingerprint:r.fingerprint}:null,verified_at:r.verified,verification_fresh:r.state==='bound'&&!r.last_error&&r.verified+FRESH_MS>this.now(),last_error:r.last_error,access:{read:r.verified?'verified_at_timestamp':'not_verified',write:'unknown'},workspace:'not_checked_out',execution:'disabled'};}
 mutate(node,a,remove=false){
  if(!['local','cloud'].includes(node)||!Number.isInteger(a.expected_revision)||a.expected_revision<1||!Number.isInteger(a.expected_binding_revision)||a.expected_binding_revision<0)throw Error('INVALID_REPOSITORY_REVISION');
  const event=text(a.event_id,256),task_id=text(a.task_id,128),sources=validSources(a.sources);
  if(!sources.length||sources.some(s=>s.role!==node))throw Error('CONTEXT_ORIGIN_MISMATCH');
  if(!remove)text(a.resolution_id,128);
  const fp=digest({node,task_id,remove,expected_revision:a.expected_revision,expected_binding_revision:a.expected_binding_revision,resolution_id:remove?null:a.resolution_id,sources});
  return this.store.tx(()=>{
   const prior=this.db.prepare('SELECT * FROM repository_events WHERE event_id=?').get(event);
   if(prior){if(prior.fingerprint!==fp)throw Error('REPOSITORY_EVENT_CONFLICT');return {...JSON.parse(prior.result),replayed:true,current:this.status(task_id)};}
   const h=this.catalog.head(task_id),old=this.row(task_id);
   if(h.legacy)throw Error('LEGACY_TASK_READONLY');if(h.spec_revision!==a.expected_revision)throw Error('TASK_REVISION_CONFLICT');
   if(old.revision!==a.expected_binding_revision)throw Error('REPOSITORY_REVISION_CONFLICT');
   if(this.store.task(task_id).blocked)throw Error('TASK_BLOCKED');this.assertQuiescent(task_id);
   let resolution=null;
   if(!remove){
    resolution=this.db.prepare('SELECT * FROM repository_resolutions WHERE id=?').get(a.resolution_id);
    if(!resolution||resolution.expires<=this.now())throw Error('REPOSITORY_RESOLUTION_EXPIRED');
    if(!sources.some(s=>s.text.includes(resolution.reference))||resolution.requested_branch&&!sources.some(s=>s.text.includes(resolution.requested_branch)))throw Error('REPOSITORY_REFERENCE_NOT_IN_USER_CONTEXT');
   }
   // Every explicit association mutation advances generation, including unbind. Old approvals cannot revive.
   this.db.prepare('INSERT INTO repository_associations VALUES (?,?,?,?,?,?,NULL) ON CONFLICT(task_id) DO UPDATE SET revision=excluded.revision,state=excluded.state,snapshot=excluded.snapshot,fingerprint=excluded.fingerprint,verified=excluded.verified,last_error=NULL').run(task_id,old.revision+1,remove?'unbound':'bound',resolution?.snapshot??null,resolution?.fingerprint??null,resolution?.created??null);
   this.invalidate(task_id);
   const result=this.status(task_id);
   this.db.prepare('INSERT INTO repository_events VALUES (?,?,?,?,?)').run(event,fp,canonical(result),canonical(sources),this.now());return result;
  });
 }
 invalidate(task_id){
  // Persist the terminal state too: a rollback to the prior read-only release must not revive approval.
  if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='approval_requests'").get())this.db.prepare("UPDATE approval_requests SET state='repository_changed' WHERE task_id=? AND state IN ('pending','approved')").run(task_id);
 }
 async refresh(task_id){
  const old=this.row(task_id);if(old.state==='unbound')return this.status(task_id);
  const snapshot=JSON.parse(old.snapshot);let current,error;
  try{current=await this.provider.inspect(snapshot.url,snapshot.branch);}catch(e){error=/^REPOSITORY_[A-Z_]+$/.test(e.message)?e.message:'REPOSITORY_PROVIDER_UNAVAILABLE';}
  // No transaction spans I/O. CAS prevents late network replies overwriting a newer bind/unbind.
  this.store.tx(()=>{
   const now=this.row(task_id);if(now.revision!==old.revision||now.fingerprint!==old.fingerprint)return;
   const changed=current&&digest(current)!==old.fingerprint||['REPOSITORY_NOT_FOUND_OR_PRIVATE','REPOSITORY_ACCESS_DENIED','REPOSITORY_IDENTITY_MISMATCH'].includes(error);
   this.db.prepare('UPDATE repository_associations SET state=?,verified=?,last_error=? WHERE task_id=?').run(changed?'changed':now.state,current?this.now():now.verified,error??(changed?'REPOSITORY_BASELINE_CHANGED':null),task_id);
   if(changed)this.invalidate(task_id);
  });return this.status(task_id);
 }
 approvalSnapshot(task_id,reference){
  const r=this.status(task_id);
  if(r.state==='unbound'){if(reference!==null)throw Error('REPOSITORY_NOT_BOUND');return {revision:r.binding_revision,snapshot:null};}
  if(!r.verification_fresh)throw Error('REPOSITORY_REVERIFY_REQUIRED');
  if(!reference||reference.binding_revision!==r.binding_revision||reference.fingerprint!==r.repository.fingerprint)throw Error('REPOSITORY_APPROVAL_REFERENCE_MISMATCH');
  return {revision:r.binding_revision,snapshot:r.repository};
 }
 matches(task_id,revision,snapshot){const r=this.row(task_id);return r.revision===revision&&(snapshot?r.state==='bound'&&r.fingerprint===snapshot.fingerprint:r.state==='unbound');}
 async gate(task_id,a,ledger){
  const r=await this.refresh(task_id),task=this.store.task(task_id),h=this.catalog.head(task_id),blockers=['DEVELOPMENT_DISABLED'];
  if(task.blocked)blockers.push('TASK_BLOCKED');if(h.legacy)blockers.push('LEGACY_TASK_READONLY');
  let quiescent=true;try{this.assertQuiescent(task_id);}catch{quiescent=false;blockers.push('TASK_NOT_QUIESCENT');}
  if(r.state!=='bound')blockers.push('REPOSITORY_NOT_BOUND_OR_CHANGED');if(!r.verification_fresh)blockers.push('REPOSITORY_REVERIFY_REQUIRED');
  // This release binds remote metadata only: neither read access nor approval establishes a checkout or write rights.
  blockers.push('WORKSPACE_NOT_BOUND','WRITE_ACCESS_NOT_VERIFIED');
  let approval_valid=false;
  if(a.approval_id){const v=ledger.view(a.approval_id);approval_valid=v.task_id===task_id&&v.state==='approved'&&v.proposal.scopes.includes(a.action??'develop')&&!!a.model_policy&&canonical(validPolicy(a.model_policy))===canonical(v.proposal.model_policy)&&this.matches(task_id,v.repository_revision,v.proposal.repository);}
  if(!approval_valid)blockers.push('APPROVAL_NOT_VALID_FOR_OPERATION');
  return {task_id,spec_revision:h.spec_revision,repository:r,approval_valid,quiescent,task_busy:!!task.busy,owner:task.owner,epoch:task.epoch,executable:false,reason:'DEVELOPMENT_DISABLED',blockers,queued:false,ownership_changed:false};
 }
}
