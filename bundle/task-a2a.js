import {validateModelObservation} from './a2a-dispatches.js';
import {createHash, randomUUID} from 'node:crypto';
import {validSources, validPolicy} from './task-context.js';
import {parseEnvelope} from './task-envelope.js';
import {tx} from './recovery.js';

const json = JSON.stringify;
const hash = x => createHash('sha256').update(json(x)).digest('hex');
const other = role => role === 'local' ? 'cloud' : 'local';
const activeRequests = new Set(['claimed', 'running', 'stopping']);
const text = (x, n = 256) => typeof x === 'string' && !!x.trim() && x.length <= n;
function shape(x, keys) {
 if (!x || typeof x !== 'object' || Array.isArray(x) || Object.keys(x).some(k => !keys.includes(k))) throw Error('A2A_ARGUMENT_INVALID');
}
function human(node, a) {
 const sources = validSources(a.sources);
 if (!sources.length || sources.some(s => s.role !== node)) throw Error('CONTEXT_ORIGIN_MISMATCH');
 if (!text(a.authorization_quote, 4000) || !sources.at(-1).text.includes(a.authorization_quote)) throw Error('A2A_AUTHORIZATION_REQUIRED');
 if (!text(a.event_id)) throw Error('A2A_EVENT_INVALID');
 return sources;
}

// Cloud authority. Peer text never creates a grant. The separate endpoint must validate
// this ledger before each model/tool dispatch; broker storage is not execution proof.
export class TaskA2A {
 constructor(g) {
  this.g = g; this.db = g.db; this.now = g.now;
  this.db.exec(`
   CREATE TABLE IF NOT EXISTS a2a_grants(
    id TEXT PRIMARY KEY,event_id TEXT UNIQUE NOT NULL,fingerprint TEXT NOT NULL,
    task_id TEXT NOT NULL,revision INTEGER NOT NULL,goal_hash TEXT NOT NULL,scope TEXT NOT NULL,
    source TEXT NOT NULL,status TEXT NOT NULL,epoch INTEGER NOT NULL,end_at INTEGER NOT NULL,
    max_turns INTEGER NOT NULL,max_requests INTEGER NOT NULL,reply_timeout INTEGER NOT NULL,
    used_turns INTEGER NOT NULL DEFAULT 0,used_requests INTEGER NOT NULL DEFAULT 0,
    reason TEXT,created INTEGER NOT NULL,UNIQUE(task_id,revision));
   CREATE TABLE IF NOT EXISTS a2a_requests(
    id TEXT PRIMARY KEY,grant_id TEXT NOT NULL,parent_id TEXT UNIQUE,origin TEXT NOT NULL,
    destination TEXT NOT NULL,instruction TEXT NOT NULL,state TEXT NOT NULL,deadline INTEGER NOT NULL,
    claim TEXT,instance TEXT,epoch INTEGER,lease_until INTEGER,session_id TEXT,
    result TEXT,result_hash TEXT,late_result TEXT,error TEXT,drained_at INTEGER,created INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS a2a_pending ON a2a_requests(destination,state,created);
   CREATE TABLE IF NOT EXISTS a2a_events(event_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS a2a_dispatches(id TEXT PRIMARY KEY,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,record TEXT NOT NULL,created INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS a2a_model_observations(id TEXT PRIMARY KEY,request_id TEXT NOT NULL,record TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS a2a_audit(seq INTEGER PRIMARY KEY AUTOINCREMENT,grant_id TEXT NOT NULL,type TEXT NOT NULL,data TEXT NOT NULL,at INTEGER NOT NULL);
  `);
 }
 audit(id, type, data = {}) { this.db.prepare('INSERT INTO a2a_audit(grant_id,type,data,at) VALUES (?,?,?,?)').run(id, type, json(data), this.now()); }
 get(id) { const r = this.db.prepare('SELECT * FROM a2a_grants WHERE id=?').get(id); if (!r) throw Error('A2A_GRANT_NOT_FOUND'); return r; }
 request(id) { const r = this.db.prepare('SELECT * FROM a2a_requests WHERE id=?').get(id); if (!r) throw Error('A2A_REQUEST_NOT_FOUND'); return r; }
 requests(id) { return this.db.prepare('SELECT * FROM a2a_requests WHERE grant_id=? ORDER BY created,rowid').all(id); }
 busy(task) {
  return !!this.db.prepare("SELECT 1 FROM a2a_requests r JOIN a2a_grants g ON g.id=r.grant_id WHERE g.task_id=? AND (r.state IN ('queued','claimed','running','stopping') OR (r.state='needs_review' AND r.drained_at IS NULL))").get(task);
 }
 current(w) {
  const h = this.g.catalog.head(w.task_id), t = this.g.store.task(w.task_id);
  if (h.spec_revision !== w.revision || hash(h.goal) !== w.goal_hash) throw Error('A2A_TASK_REVISION_CHANGED');
  if (t.blocked) throw Error('TASK_BLOCKED');
  if (t.busy) throw Error('A2A_TASK_BUSY');
  if (w.end_at <= this.now()) throw Error('A2A_GRANT_EXPIRED');
  return h;
 }
 view(w) {
  return {id:w.id, task_id:w.task_id, spec_revision:w.revision, state:w.status, epoch:w.epoch,
   scope:JSON.parse(w.scope), budget:{turns:w.used_turns, max_turns:w.max_turns, model_requests:w.used_requests, max_model_requests:w.max_requests, end_at:w.end_at, reply_timeout_seconds:w.reply_timeout},
   reason:w.reason, execution:'bounded-readonly-a2a', development:false, publish:false,
   requests:this.requests(w.id).map(r => ({id:r.id, parent_id:r.parent_id, from:r.origin, to:r.destination, state:r.state,
    deadline:r.deadline, session_id:r.session_id, result:r.result ? JSON.parse(r.result) : null,model_calls:this.db.prepare('SELECT record FROM a2a_model_observations WHERE request_id=? ORDER BY rowid').all(r.id).map(x=>JSON.parse(x.record)),
    late_result:r.late_result ? JSON.parse(r.late_result) : null, error:r.error, drained:r.drained_at !== null}))};
 }
 list(task) { this.g.store.task(task); this.reap(); return {items:this.db.prepare('SELECT * FROM a2a_grants WHERE task_id=? ORDER BY created,rowid').all(task).map(w => this.view(w)), authority:'cloud'}; }
 create(node, a) {
  shape(a, ['task_id','expected_revision','scope','end_at','max_turns','max_model_requests','reply_timeout_seconds','sources','authorization_quote','event_id']);
  const sources = human(node, a);
  shape(a.scope, ['local','cloud']);
  const scope = {};
  for (const role of ['local','cloud']) {
   const s = a.scope[role]; shape(s, ['model_policy','capabilities','references']);
   const policy = validPolicy(s.model_policy);
   // No model fallback. high applies only to this newly authorized cloud stage.
   if (role === 'cloud' && policy.reasoningEffort === undefined) policy.reasoningEffort = 'high';
   if (!Array.isArray(s.capabilities) || !s.capabilities.length || new Set(s.capabilities).size !== s.capabilities.length || s.capabilities.some(k => !['context','file_text'].includes(k)) || !s.capabilities.includes('context')) throw Error('A2A_CAPABILITY_INVALID');
   if (!Array.isArray(s.references ?? []) || (s.references ?? []).length > 8 || new Set(s.references ?? []).size !== (s.references ?? []).length || (s.references ?? []).some(x => !text(x,1000))) throw Error('A2A_REFERENCE_INVALID');
   if ((s.references ?? []).length && !s.capabilities.includes('file_text')) throw Error('A2A_CAPABILITY_INVALID');
   scope[role] = {model_policy:policy, capabilities:[...s.capabilities].sort(), references:[...(s.references ?? [])].sort()};
  }
  const fp = hash({node,...a,scope,sources});
  const old = this.db.prepare('SELECT * FROM a2a_grants WHERE event_id=?').get(a.event_id);
  if (old) { if (old.fingerprint !== fp) throw Error('A2A_EVENT_CONFLICT'); return this.view(old); }
  const h = this.g.catalog.head(a.task_id), e = parseEnvelope(h.goal);
  if (h.legacy || !e || e.intent !== 'plan') throw Error('A2A_PLAN_TASK_REQUIRED');
  if (h.spec_revision !== a.expected_revision) throw Error('TASK_REVISION_CONFLICT');
  if (!Number.isSafeInteger(a.end_at) || a.end_at <= this.now() || a.end_at > this.now()+366*86400000 ||
   !Number.isInteger(a.max_turns) || a.max_turns < 1 || a.max_turns > 12 ||
   !Number.isInteger(a.max_model_requests) || a.max_model_requests < 1 || a.max_model_requests > 72 ||
   !Number.isInteger(a.reply_timeout_seconds) || a.reply_timeout_seconds < 60 || a.reply_timeout_seconds > 7*86400) throw Error('A2A_BUDGET_INVALID');
  for (const role of ['local','cloud']) for (const uri of scope[role].references) {
   if (!(e.task_context?.references ?? []).some(r => r.kind === 'file-reference' && r.host === role && r.uri === uri)) throw Error('A2A_REFERENCE_NOT_IN_TASK');
  }
  this.g.assertTaskQuiescent(a.task_id);
  const id = tx(this.db, () => {
   if (this.db.prepare('SELECT 1 FROM a2a_grants WHERE task_id=? AND revision=?').get(a.task_id,h.spec_revision)) throw Error('A2A_REVISION_ALREADY_AUTHORIZED');
   const id = 'collab-'+randomUUID();
   this.db.prepare("INSERT INTO a2a_grants(id,event_id,fingerprint,task_id,revision,goal_hash,scope,source,status,epoch,end_at,max_turns,max_requests,reply_timeout,created) VALUES (?,?,?,?,?,?,?,?,'active',1,?,?,?,?,?)")
    .run(id,a.event_id,fp,a.task_id,h.spec_revision,hash(h.goal),json(scope),json(sources),a.end_at,a.max_turns,a.max_model_requests,a.reply_timeout_seconds,this.now());
   this.audit(id,'authorized',{origin:node,execution_started:false}); return id;
  });
  return this.view(this.get(id));
 }
 insertRequest(w, from, instruction, parent = null) {
  if (w.used_turns >= w.max_turns) throw Error('A2A_TURN_BUDGET_EXHAUSTED');
  const id = 'wake-'+randomUUID(), deadline = Math.min(w.end_at,this.now()+w.reply_timeout*1000);
  this.db.prepare("INSERT INTO a2a_requests(id,grant_id,parent_id,origin,destination,instruction,state,deadline,created) VALUES (?,?,?,?,?,?,'queued',?,?)").run(id,w.id,parent,from,other(from),instruction,deadline,this.now());
  this.db.prepare('UPDATE a2a_grants SET used_turns=used_turns+1 WHERE id=?').run(w.id);
  this.audit(w.id,'queued',{request_id:id,parent_id:parent,from,to:other(from)}); return id;
 }
 start(node, a) {
  shape(a, ['grant_id','instruction','sources','authorization_quote','event_id']); human(node,a);
  if (!text(a.instruction,4000)) throw Error('A2A_INSTRUCTION_INVALID');
  const fp = hash({node,...a});
  return tx(this.db, () => {
   const old = this.db.prepare('SELECT * FROM a2a_events WHERE event_id=?').get(a.event_id);
   if (old) { if (old.fingerprint !== fp) throw Error('A2A_EVENT_CONFLICT'); return JSON.parse(old.result); }
   const w = this.get(a.grant_id); this.current(w);
   if (w.status !== 'active') throw Error('A2A_GRANT_INACTIVE');
   if (this.requests(w.id).length) throw Error('A2A_ROOT_ALREADY_EXISTS');
   this.g.assertTaskQuiescent(w.task_id);
   const id = this.insertRequest(w,node,a.instruction), result = {grant_id:w.id, request_id:id, state:'queued', meaning:'waiting for authorized recipient; not executed'};
   this.db.prepare('INSERT INTO a2a_events VALUES (?,?,?)').run(a.event_id,fp,json(result)); return result;
  });
 }
 reap() {
  tx(this.db, () => {
   for (const w of this.db.prepare("SELECT * FROM a2a_grants WHERE status IN ('active','paused')").all()) {
    let code; try { this.current(w); } catch(e) { code=e.message; }
    if (code) { this.stop(w,'invalidated',code); continue; }
    for (const r of this.requests(w.id)) {
     if (r.deadline <= this.now() && ['queued','claimed','running'].includes(r.state)) {
      this.db.prepare('UPDATE a2a_requests SET state=?,error=?,drained_at=? WHERE id=?').run(r.state==='running'?'stopping':'timed_out','A2A_REPLY_TIMEOUT',r.state==='running'?null:this.now(),r.id);
      this.db.prepare("UPDATE a2a_grants SET status='needs_review',reason='A2A_REPLY_TIMEOUT',epoch=epoch+1 WHERE id=?").run(w.id);
      this.audit(w.id,'timeout',{request_id:r.id});
     } else if (r.state === 'claimed' && r.lease_until <= this.now()) {
      // Only a claim with no begin intent may return to the queue.
      this.db.prepare("UPDATE a2a_requests SET state='queued',claim=NULL,instance=NULL,epoch=NULL,lease_until=NULL WHERE id=?").run(r.id);
     }
    }
   }
  });
 }
 claim(node, a) {
  shape(a,['instance_id']); if (!text(a.instance_id)) throw Error('A2A_INSTANCE_INVALID');
  this.reap();
  return tx(this.db, () => {
   // A polling endpoint cannot acquire a second execution while its first is undrained.
   if (this.db.prepare("SELECT 1 FROM a2a_requests WHERE destination=? AND state IN ('claimed','running','stopping')").get(node)) return {item:null,reason:'recipient_busy'};
   const r = this.db.prepare("SELECT r.* FROM a2a_requests r JOIN a2a_grants g ON g.id=r.grant_id WHERE r.destination=? AND r.state='queued' AND g.status='active' ORDER BY r.created,r.rowid LIMIT 1").get(node);
   if (!r) return {item:null,reason:'no_authorized_work'};
   const w = this.get(r.grant_id); this.current(w); const claim=randomUUID();
   this.db.prepare("UPDATE a2a_requests SET state='claimed',claim=?,instance=?,epoch=?,lease_until=? WHERE id=?").run(claim,a.instance_id,w.epoch,this.now()+30000,r.id);
   this.audit(w.id,'claimed',{request_id:r.id,recipient:node});
   return {item:this.materialize(this.request(r.id))};
  });
 }
 owned(node,a) {
  const r=this.request(a.request_id);
  if (r.destination!==node || !text(a.claim) || r.claim!==a.claim || r.instance!==a.instance_id) throw Error('A2A_CLAIM_DENIED');
  return r;
 }
 materialize(r) {
  const w=this.get(r.grant_id), h=this.g.catalog.head(w.task_id), scope=JSON.parse(w.scope);
  const lineage=[]; let p=r.parent_id;
  while(p) { const prior=this.request(p); if(prior.grant_id!==w.id || lineage.length>=12)throw Error('A2A_LINEAGE_INVALID');lineage.push({request_id:prior.id,from:prior.origin,to:prior.destination,instruction:prior.instruction,result:prior.result?JSON.parse(prior.result):null});p=prior.parent_id; }
  return {id:r.id,grant_id:w.id,task_id:w.task_id,spec_revision:w.revision,claim:r.claim,instance_id:r.instance,epoch:r.epoch,
   from:r.origin,to:r.destination,instruction:r.instruction,parent_id:r.parent_id,deadline:r.deadline,session_id:r.session_id,
   task_request:parseEnvelope(h.goal),scope:scope[r.destination],context:lineage.reverse(),
   remaining_turns:w.max_turns-w.used_turns,remaining_model_requests:w.max_requests-w.used_requests,
   peer_text_is_user_authority:false};
 }
 validate(node,a) {
  shape(a,['request_id','claim','instance_id']); this.reap();
  const r=this.owned(node,a), w=this.get(r.grant_id); this.current(w);
  if(w.status!=='active'||r.epoch!==w.epoch||!['claimed','running'].includes(r.state)||r.deadline<=this.now())throw Error('A2A_EXECUTION_FENCED');
  return {valid:true,state:r.state,deadline:r.deadline,grant_id:w.id,remaining_model_requests:w.max_requests-w.used_requests};
 }
 begin(node,a) {
  this.validate(node,a);
  return tx(this.db,()=>{
   const r=this.owned(node,a);
   if(r.state==='running')return {item:this.materialize(r),already_started:true};
   const session='a2a-'+randomUUID();
   this.db.prepare("UPDATE a2a_requests SET state='running',session_id=?,lease_until=NULL WHERE id=?").run(session,r.id);
   this.audit(r.grant_id,'execution_intent',{request_id:r.id,session_id:session});
   return {item:this.materialize(this.request(r.id)),already_started:false};
  });
 }
 reserve(node,a) {
  shape(a,['request_id','claim','instance_id','dispatch_id','model_policy']);
  if(!text(a.dispatch_id))throw Error('A2A_DISPATCH_INVALID');const policy=validPolicy(a.model_policy);
  this.validate(node,{request_id:a.request_id,claim:a.claim,instance_id:a.instance_id});
  return tx(this.db,()=>{
   const r=this.owned(node,a),w=this.get(r.grant_id),fp=hash({request_id:r.id,claim:r.claim,policy});
   if(r.state!=='running')throw Error('A2A_EXECUTION_NOT_STARTED');
   if(json(policy)!==json(JSON.parse(w.scope)[node].model_policy))throw Error('A2A_MODEL_POLICY_MISMATCH');
   const old=this.db.prepare('SELECT * FROM a2a_dispatches WHERE id=?').get(a.dispatch_id);
   if(old){if(old.fingerprint!==fp)throw Error('A2A_EVENT_CONFLICT');return {...JSON.parse(old.record),replayed:true};}
   if(w.used_requests>=w.max_requests||this.db.prepare('SELECT count(*) n FROM a2a_dispatches WHERE request_id=?').get(r.id).n>=6)throw Error('A2A_MODEL_BUDGET_EXHAUSTED');
   const record={reserved:true,dispatch_id:a.dispatch_id,request_id:r.id,model_policy:policy,replayed:false};
   this.db.prepare('INSERT INTO a2a_dispatches VALUES (?,?,?,?,?)').run(a.dispatch_id,r.id,fp,json(record),this.now());
   this.db.prepare('UPDATE a2a_grants SET used_requests=used_requests+1 WHERE id=?').run(w.id);
   this.audit(w.id,'model_reserved',{request_id:r.id,dispatch_id:a.dispatch_id});return record;
  });
 }
 recordModels(r,models=[]){
  if(!Array.isArray(models)||models.length>6)throw Error('A2A_MODEL_OBSERVATION_INVALID');
  const seen=new Set();for(const raw of models){const m=validateModelObservation(raw);if(seen.has(m.dispatch_id))throw Error('A2A_MODEL_OBSERVATION_INVALID');seen.add(m.dispatch_id);
   const reserved=this.db.prepare('SELECT record FROM a2a_dispatches WHERE id=? AND request_id=?').get(m.dispatch_id,r.id);if(!reserved)throw Error('A2A_MODEL_RESERVATION_REQUIRED');
   const p=JSON.parse(reserved.record).model_policy;
   if(m.provider!==p.provider||m.model!==p.model||p.reasoningEffort!==undefined&&m.reasoningEffort!==p.reasoningEffort)throw Error('A2A_MODEL_POLICY_MISMATCH');
   const old=this.db.prepare('SELECT record FROM a2a_model_observations WHERE id=?').get(m.dispatch_id);
   if(old){if(old.record!==json(m))throw Error('A2A_MODEL_OBSERVATION_CONFLICT');}
   else this.db.prepare('INSERT INTO a2a_model_observations VALUES (?,?,?)').run(m.dispatch_id,r.id,json(m));
  }
 }
 finish(node,a) {
  shape(a,['request_id','claim','instance_id','result','model_calls']);shape(a.result,['summary','followup','evidence']);
  if(a.result.evidence!==undefined){
   if(!Array.isArray(a.result.evidence)||a.result.evidence.length>8)throw Error('A2A_EVIDENCE_INVALID');
   const seen=new Set();for(const e of a.result.evidence){shape(e,['id','source_id','host','title','format','size','sha256','read_at']);
    if(!text(e.id,100)||seen.has(e.id)||!text(e.source_id,100)||e.host!==node||!text(e.title,500)||!['markdown','text','json','csv'].includes(e.format)||!Number.isInteger(e.size)||e.size<0||e.size>65536||!/^[a-f0-9]{64}$/.test(e.sha256??'')||!Number.isSafeInteger(e.read_at))throw Error('A2A_EVIDENCE_INVALID');seen.add(e.id);
   }
  }
  if(!text(a.result.summary,4000)||a.result.followup!==undefined&&!text(a.result.followup,4000))throw Error('A2A_RESULT_INVALID');
  this.reap();
  return tx(this.db,()=>{
   const r=this.owned(node,a),w=this.get(r.grant_id),fp=hash(a.result);this.recordModels(r,a.model_calls);
   if(r.result_hash){if(r.result_hash!==fp)throw Error('A2A_RESULT_CONFLICT');return {recorded:true,replayed:true,state:r.state};}
   if(!['running','stopping','needs_review'].includes(r.state))throw Error('A2A_EXECUTION_NOT_STARTED');
   // Teardown proof is supplied by the endpoint only after its owned agent is disposed.
   if(r.state!=='running'||w.status!=='active'||r.epoch!==w.epoch){
    if(r.late_result&&r.late_result!==json(a.result))throw Error('A2A_RESULT_CONFLICT');
    this.db.prepare("UPDATE a2a_requests SET state='needs_review',late_result=?,drained_at=? WHERE id=?").run(json(a.result),this.now(),r.id);
    this.audit(w.id,'late_result',{request_id:r.id});return {recorded:true,state:'needs_review',continued:false};
   }
   this.db.prepare("UPDATE a2a_requests SET state='completed',result=?,result_hash=?,drained_at=? WHERE id=?").run(json(a.result),fp,this.now(),r.id);
   let child=null;
   if(a.result.followup){
    if(w.used_turns>=w.max_turns||w.used_requests>=w.max_requests)this.db.prepare("UPDATE a2a_grants SET status='waiting_input',reason='A2A_BUDGET_EXHAUSTED' WHERE id=?").run(w.id);
    else child=this.insertRequest(w,node,a.result.followup,r.id);
   }else this.db.prepare("UPDATE a2a_grants SET status='completed',reason=NULL WHERE id=?").run(w.id);
   this.audit(w.id,'completed',{request_id:r.id,child_request_id:child});return {recorded:true,state:'completed',continued:!!child,child_request_id:child};
  });
 }
 failed(node,a) {
  shape(a,['request_id','claim','instance_id','code','model_calls']); const code=/^A2A_[A-Z_]{1,80}$/.test(a.code??'')?a.code:'A2A_EXECUTION_FAILED';
  return tx(this.db,()=>{
   const r=this.owned(node,a),w=this.get(r.grant_id);this.recordModels(r,a.model_calls);
   if(r.result_hash||r.state==='needs_review'&&r.drained_at!==null)return {state:r.state,unchanged:true};
   if(!activeRequests.has(r.state)&&r.state!=='needs_review')throw Error('A2A_EXECUTION_NOT_STARTED');
   this.db.prepare("UPDATE a2a_requests SET state='needs_review',error=COALESCE(error,?),drained_at=? WHERE id=?").run(code,this.now(),r.id);
   if(w.status==='active')this.db.prepare("UPDATE a2a_grants SET status='needs_review',reason=?,epoch=epoch+1 WHERE id=?").run(code,w.id);
   this.audit(w.id,'drained_failure',{request_id:r.id,code});return {state:'needs_review',drained:true,retry:false};
  });
 }
 stop(w,status,reason) {
  this.db.prepare('UPDATE a2a_grants SET status=?,reason=?,epoch=epoch+1 WHERE id=?').run(status,reason,w.id);
  for(const r of this.requests(w.id)) {
   if(r.state==='running')this.db.prepare("UPDATE a2a_requests SET state='stopping',error=? WHERE id=?").run(reason,r.id);
   else if(['queued','claimed'].includes(r.state))this.db.prepare('UPDATE a2a_requests SET state=?,claim=NULL,instance=NULL,epoch=NULL,lease_until=NULL,error=?,drained_at=? WHERE id=?')
    .run(status==='paused'?'queued':'cancelled',reason,status==='paused'?null:this.now(),r.id);
  }
  this.audit(w.id,status,{reason});
 }
 control(node,a) {
  shape(a,['grant_id','action','sources','authorization_quote','event_id']);human(node,a);
  if(!['pause','resume','revoke'].includes(a.action))throw Error('A2A_CONTROL_INVALID');const fp=hash({node,...a});
  return tx(this.db,()=>{
   const old=this.db.prepare('SELECT * FROM a2a_events WHERE event_id=?').get(a.event_id);
   if(old){if(old.fingerprint!==fp)throw Error('A2A_EVENT_CONFLICT');return JSON.parse(old.result);}
   const w=this.get(a.grant_id);
   if(a.action==='resume'){
    this.current(w);if(w.status!=='paused')throw Error('A2A_RESUME_DENIED');
    if(this.requests(w.id).some(r=>activeRequests.has(r.state)||r.state==='needs_review'))throw Error('A2A_DRAIN_OR_REVIEW_REQUIRED');
    this.db.prepare("UPDATE a2a_grants SET status='active',reason=NULL,epoch=epoch+1 WHERE id=?").run(w.id);this.audit(w.id,'resumed');
   }else{
    if(!['active','paused','needs_review','waiting_input'].includes(w.status))throw Error('A2A_CONTROL_INVALID');
    this.stop(w,a.action==='pause'?'paused':'revoked',a.action==='pause'?'A2A_USER_PAUSED':'A2A_USER_REVOKED');
   }
   const result={id:w.id,state:this.get(w.id).status,drained:!this.requests(w.id).some(r=>activeRequests.has(r.state)||r.state==='needs_review'&&r.drained_at===null),budget_reset:false};
   this.db.prepare('INSERT INTO a2a_events VALUES (?,?,?)').run(a.event_id,fp,json(result));return result;
  });
 }
 call(method,a,node) {
  if(!['local','cloud'].includes(node))throw Error('AUTH_DENIED');
  const methods={a2a_create:'create',a2a_start:'start',a2a_claim:'claim',a2a_begin:'begin',a2a_validate:'validate',a2a_reserve:'reserve',a2a_finish:'finish',a2a_failed:'failed',a2a_control:'control'};
  if(method==='a2a_list'){shape(a,['task_id']);return this.list(a.task_id);}
  if(!Object.hasOwn(methods,method))throw Error('METHOD_DENIED');return this[methods[method]](node,a);
 }
}
