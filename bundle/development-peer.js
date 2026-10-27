import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';
import {errorInfo} from './link-contract.js';
import {canonical,digest} from './approval-ledger.js';
const safe=e=>errorInfo(e).code;
// Internal plugin API only. No model tools or native chat interception. Local code
// proposals go through the authoritative cloud writer, never arbitrary local paths.
export class DevelopmentPeer {
 constructor(g,c,io={}){
  if(!Number.isInteger(c.lockPort)||c.lockPort<0||c.lockPort>65535||c.lockPort===0&&!io.allowEphemeralLock)throw Error('DEVELOPMENT_PEER_CONFIG_INVALID');
  this.g=g;this.c=c;this.db=g.db;this.instance=randomUUID();this.closed=false;this.started=false;this.pending=new Set();
  this.db.exec(`CREATE TABLE IF NOT EXISTS development_peer_owner(id INTEGER PRIMARY KEY CHECK(id=1),role TEXT NOT NULL,port INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS development_peer_requests(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,payload TEXT NOT NULL,
    state TEXT NOT NULL,request_id TEXT,claim TEXT,error TEXT,updated INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS development_peer_calls(id TEXT PRIMARY KEY,local_id TEXT NOT NULL,fingerprint TEXT NOT NULL,
    state TEXT NOT NULL,result TEXT,error TEXT);
   CREATE TABLE IF NOT EXISTS development_peer_claim_intents(local_id TEXT PRIMARY KEY,request_id TEXT NOT NULL,endpoint_id TEXT NOT NULL,recovery_key TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS development_peer_evidence(local_id TEXT PRIMARY KEY,proof_hash TEXT NOT NULL,evidence TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS development_peer_reviews(event_id TEXT PRIMARY KEY,local_id TEXT NOT NULL,fingerprint TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,result TEXT);`);
  const columns=this.db.prepare('PRAGMA table_info(development_peer_calls)').all().map(c=>c.name);
  for(const name of ['kind','call_id','wire_fingerprint'])if(!columns.includes(name))this.db.exec('ALTER TABLE development_peer_calls ADD COLUMN '+name+' TEXT;');
 }
 async start(){
  if(this.closed)throw Error('DEVELOPMENT_PEER_CLOSED');if(this.started)return;if(this.starting)return this.starting;
  this.starting=this.startExclusive();try{await this.starting;}finally{this.starting=null;}
 }
 async startExclusive(){
  const own=this.db.prepare('SELECT * FROM development_peer_owner WHERE id=1').get();
  if(own&&(own.role!==this.g.c.role||(this.c.lockPort!==0&&own.port!==this.c.lockPort)))throw Error('DEVELOPMENT_PEER_OWNER_CHANGED');
  this.lock=createServer(s=>s.destroy());
  try{
   await new Promise((resolve,reject)=>{this.lock.once('error',reject);this.lock.listen({host:'127.0.0.1',port:own?.port??this.c.lockPort,exclusive:true},resolve);});
   if(this.closed)throw Error('DEVELOPMENT_PEER_CLOSED');
   const port=this.lock.address().port;this.db.prepare('INSERT OR IGNORE INTO development_peer_owner VALUES(1,?,?)').run(this.g.c.role,port);
   const saved=this.db.prepare('SELECT * FROM development_peer_owner WHERE id=1').get();if(saved.role!==this.g.c.role||saved.port!==port)throw Error('DEVELOPMENT_PEER_OWNER_CHANGED');
   // An old process may have lost a response or left a native agent. No auto replay,
   // new ticket, or remote release merely because this local process can start.
   this.db.prepare("UPDATE development_peer_requests SET state='needs_review',error='DEVELOPMENT_PEER_RESTART_UNKNOWN' WHERE state IN ('claiming','active','finishing','reviewing')").run();
   this.db.prepare("UPDATE development_peer_calls SET state='needs_review',error='DEVELOPMENT_PEER_RESTART_UNKNOWN' WHERE state='pending'").run();this.started=true;
  }catch(e){if(this.lock.listening)await new Promise(r=>this.lock.close(r));throw e;}
 }
 row(id){const r=this.db.prepare('SELECT * FROM development_peer_requests WHERE id=?').get(id);if(!r)throw Error('DEVELOPMENT_PEER_NOT_FOUND');return r;}
 workspace(id){return JSON.parse(this.row(id).payload).contract==='workspace-v1';}
 remote(id,operation,args){return this.g.call((this.workspace(id)?'workspace_bridge_':'development_bridge_')+operation,args);}
 state(id,state,error=null){this.db.prepare('UPDATE development_peer_requests SET state=?,error=?,updated=? WHERE id=?').run(state,error,this.g.now(),id);}
 view(id){const r=this.row(id);return {id:r.id,state:r.state,request_id:r.request_id,error:r.error,storage_host:'cloud',grants_execution:false};}
 assertOpen(){if(this.closed||!this.started)throw Error('DEVELOPMENT_PEER_CLOSED');}
 track(fn){this.g.maintenance?.assertOpen();this.assertOpen();const p=Promise.resolve().then(fn);this.pending.add(p);p.finally(()=>this.pending.delete(p)).catch(()=>{});return p;}
 submit(a){
  this.g.maintenance?.assertOpen();this.assertOpen();if(!a||typeof a.event_id!=='string'||!a.event_id||a.event_id.length>220||Object.keys(a).some(k=>!['event_id','task_id','approval_id','policy','contract'].includes(k)))throw Error('DEVELOPMENT_BRIDGE_INVALID');
  if(a.contract!==undefined&&a.contract!=='workspace-v1')throw Error('DEVELOPMENT_BRIDGE_INVALID');
  const fp=digest(a),old=this.db.prepare('SELECT * FROM development_peer_requests WHERE id=?').get(a.event_id);
  if(old){if(old.fingerprint!==fp)throw Error('DEVELOPMENT_PEER_CONFLICT');return this.view(old.id);}
  this.db.prepare("INSERT INTO development_peer_requests VALUES (?,?,?,'pending',NULL,NULL,NULL,?)").run(a.event_id,fp,canonical(a),this.g.now());return this.view(a.event_id);
 }
 tick(){if(this.g.maintenance?.blocked)return Promise.resolve();if(this.ticking)return this.ticking;this.ticking=this.track(async()=>{
  for(const r of this.db.prepare("SELECT * FROM development_peer_requests WHERE state='pending' ORDER BY rowid LIMIT 10").all()){
   if(this.closed)return;
   try{const {contract,...payload}=JSON.parse(r.payload);const q=await this.remote(r.id,'enqueue',payload);this.db.prepare("UPDATE development_peer_requests SET state='cloud_queued',request_id=?,error=NULL,updated=? WHERE id=?").run(q.id,this.g.now(),r.id);}
   catch(e){const category=errorInfo(e).category;this.state(r.id,['validation_or_review','authentication'].includes(category)?'needs_review':'pending',safe(e));break;}
  }
 }).finally(()=>{this.ticking=null;});return this.ticking;}
 acquire(id){return this.track(async()=>{
  const r=this.row(id);if(r.state!=='cloud_queued')throw Error('DEVELOPMENT_PEER_NOT_QUEUED');this.state(id,'claiming');
  const recovery_key=randomUUID();this.db.prepare('INSERT OR REPLACE INTO development_peer_claim_intents VALUES(?,?,?,?)').run(id,r.request_id,this.instance,recovery_key);
  try{
   const c=await this.remote(id,'claim_acquire',{id:r.request_id,endpoint_id:this.instance,recovery_key});
   if(!c.acquired){this.state(id,'cloud_queued');return {...this.view(id),acquired:false,reason:c.reason};}
   this.db.prepare("UPDATE development_peer_requests SET state='active',claim=?,error=NULL,updated=? WHERE id=?").run(canonical({id:c.id,epoch:c.epoch,endpoint_id:c.endpoint_id,ticket:c.ticket}),this.g.now(),id);
   return {...this.view(id),acquired:true,grants_execution:true,starts_worker:false,epoch:c.epoch};
  }catch(e){if(this.row(id).state!=='cancelled')this.state(id,'needs_review',safe(e));throw e;}
 });}
 claim(id){const r=this.row(id),c=r.claim&&JSON.parse(r.claim);if(r.state!=='active'||!c||c.endpoint_id!==this.instance)throw Error('DEVELOPMENT_PEER_STALE_FENCE');return c;}
 read(id,path){return this.track(async()=>this.remote(id,'read',{...this.claim(id),...(path===undefined?{}:{path})}));}
 operation(id,kind,a){return this.track(async()=>{
  const workspace=this.workspace(id);
  if(!(workspace?['write','command']:['write','test']).includes(kind)||!a||typeof a.call_id!=='string'||!a.call_id||a.call_id.length>256)throw Error('DEVELOPMENT_BRIDGE_INVALID');
  const fields=kind==='write'?['call_id','expected_hash','content',...(workspace?['path']:[])]:kind==='command'?['call_id','command_id']:['call_id'];if(Object.keys(a).some(k=>!fields.includes(k)))throw Error('DEVELOPMENT_BRIDGE_INVALID');
  const claim=this.claim(id),key=id+':'+a.call_id,fp=digest({kind,a,epoch:claim.epoch}),old=this.db.prepare('SELECT * FROM development_peer_calls WHERE id=?').get(key);
  if(old){if(old.fingerprint!==fp)throw Error('DEVELOPMENT_PEER_CONFLICT');if(old.state!=='completed')throw Error('DEVELOPMENT_BRIDGE_RESULT_UNKNOWN');return {...JSON.parse(old.result),replayed:true};}
  if(this.db.prepare("SELECT 1 FROM development_peer_calls WHERE local_id=? AND state<>'completed'").get(id))throw Error('DEVELOPMENT_NOT_DRAINED');
  this.db.prepare("INSERT INTO development_peer_calls(id,local_id,fingerprint,state,kind,call_id) VALUES (?,?,?,'pending',?,?)").run(key,id,fp,kind,a.call_id);
  try{
   const wire=kind!=='write'?{...a,expected_hash:(await this.remote(id,'read',claim)).hash}:a;
   this.claim(id);
   const wirefp=digest(kind==='write'?{epoch:claim.epoch,expected_hash:wire.expected_hash,content:wire.content,...(workspace?{path:wire.path}:{})}:kind==='command'?{epoch:claim.epoch,command_id:wire.command_id,file_hash:wire.expected_hash}:{epoch:claim.epoch,expected_hash:wire.expected_hash});
   this.db.prepare('UPDATE development_peer_calls SET wire_fingerprint=? WHERE id=?').run(wirefp,key);
   const result=await this.remote(id,kind,{...wire,...claim});this.db.prepare("UPDATE development_peer_calls SET state='completed',result=? WHERE id=?").run(canonical(result),key);return result;}
  catch(e){this.db.prepare("UPDATE development_peer_calls SET state='needs_review',error=? WHERE id=?").run(safe(e),key);this.state(id,'needs_review',safe(e));throw e;}
 });}
 finish(id){return this.track(async()=>{
  const claim=this.claim(id);if(this.db.prepare("SELECT 1 FROM development_peer_calls WHERE local_id=? AND state<>'completed'").get(id))throw Error('DEVELOPMENT_NOT_DRAINED');
  this.state(id,'finishing');try{const r=await this.remote(id,'finish',claim);if(r.state!=='completed')throw Error('DEVELOPMENT_BRIDGE_RESULT_UNKNOWN');this.state(id,'completed');return this.view(id);}catch(e){this.state(id,'needs_review',safe(e));throw e;}
 });}
 // Evidence repairs only local receipts, never repeats a mutation or releases the cloud fence.
 reconcile(id){return this.track(async()=>{
  const r=this.row(id);let claim=r.claim&&JSON.parse(r.claim);
  if(!['needs_review','completed'].includes(r.state))throw Error('DEVELOPMENT_REVIEW_NOT_AVAILABLE');
  if(!claim){
   const intent=this.db.prepare('SELECT * FROM development_peer_claim_intents WHERE local_id=?').get(id);
   if(!intent||intent.request_id!==r.request_id)throw Error('DEVELOPMENT_REVIEW_NOT_AVAILABLE');
   const c=await this.remote(id,'claim_receipt',{id:intent.request_id,endpoint_id:intent.endpoint_id,recovery_key:intent.recovery_key});
   if(c.id!==r.request_id||c.endpoint_id!==intent.endpoint_id||!Number.isSafeInteger(c.epoch)||c.epoch<1||!(/^[a-f0-9-]{36}$/).test(c.ticket??'')||c.grants_execution!==false)throw Error('DEVELOPMENT_REVIEW_EVIDENCE_MISMATCH');
   claim={id:c.id,endpoint_id:c.endpoint_id,ticket:c.ticket,epoch:c.epoch};this.db.prepare('UPDATE development_peer_requests SET claim=? WHERE id=?').run(canonical(claim),id);
  }
  const report=await this.remote(id,'evidence',claim),e=report.evidence;
  if(!e||report.proof_hash!==digest(e)||e.request_id!==r.request_id||e.node!==this.g.c.role||e.epoch!==claim.epoch||e.endpoint_id!==claim.endpoint_id)throw Error('DEVELOPMENT_REVIEW_EVIDENCE_MISMATCH');
  for(const c of this.db.prepare("SELECT * FROM development_peer_calls WHERE local_id=? AND state<>'completed'").all(id)){
   if(!c.wire_fingerprint||!c.kind||!c.call_id)continue; // Legacy intent is not sufficient proof.
   const receipt=(c.kind==='write'?e.writes:c.kind==='command'?e.commands:e.tests)?.find(w=>w.id===r.request_id+':'+c.call_id&&w.fingerprint===c.wire_fingerprint);
   if(!receipt||(c.kind==='write'?receipt.state!=='applied':receipt.state!=='completed')||c.kind==='command'&&(!receipt.result?.drained||!e.operations.some(o=>o.id===receipt.operation_id&&o.state==='closed')))continue;
   const result=c.kind==='write'?{sha256:receipt.new_hash,committed:false,pushed:false,reconciled:true}:{...receipt.result,reconciled:true};
   this.db.prepare("UPDATE development_peer_calls SET state='completed',result=? WHERE id=?").run(canonical(result),c.id);
  }
  this.db.prepare('INSERT OR REPLACE INTO development_peer_evidence VALUES (?,?,?)').run(id,report.proof_hash,canonical(e));
  const unresolved=this.db.prepare("SELECT count(*) n FROM development_peer_calls WHERE local_id=? AND state<>'completed'").get(id).n;
  if(e.state==='completed'&&!unresolved)this.state(id,'completed');
  return {...this.view(id),cloud_state:e.state,proof_hash:report.proof_hash,unresolved_calls:unresolved,grants_execution:false};
 });}
 // Explicit internal operator action. A pending review RPC is retried with exactly its
 // durable original event, including the old process endpoint; it never resets a budget.
 resumeReviewed(id,{event_id,proof_hash,note}={}){return this.track(async()=>{
  if(typeof event_id!=='string'||!event_id||event_id.length>256||typeof note!=='string'||!note.trim()||note.length>2000||!(/^[a-f0-9]{64}$/).test(proof_hash??''))throw Error('DEVELOPMENT_REVIEW_INVALID');
  const fp=digest({id,event_id,proof_hash,note}),prior=this.db.prepare('SELECT * FROM development_peer_reviews WHERE event_id=?').get(event_id);
  if(prior&&(prior.local_id!==id||prior.fingerprint!==fp))throw Error('DEVELOPMENT_REVIEW_CONFLICT');
  if(prior?.state==='completed')return {...this.view(id),review_replayed:true};
  let payload;
  if(prior)payload=JSON.parse(prior.payload);
  else{
   const r=this.row(id),proof=this.db.prepare('SELECT * FROM development_peer_evidence WHERE local_id=?').get(id);
   if(r.state!=='needs_review'||!r.claim||!proof||proof.proof_hash!==proof_hash||this.db.prepare("SELECT 1 FROM development_peer_calls WHERE local_id=? AND state<>'completed'").get(id))throw Error('DEVELOPMENT_REVIEW_NOT_AVAILABLE');
   if(this.db.prepare("SELECT 1 FROM development_peer_reviews WHERE local_id=? AND state='pending'").get(id))throw Error('DEVELOPMENT_REVIEW_PENDING');
   payload={...JSON.parse(r.claim),event_id,proof_hash,note,new_endpoint_id:this.instance};
   this.db.prepare("INSERT INTO development_peer_reviews VALUES (?,?,?,?,'pending',NULL)").run(event_id,id,fp,canonical(payload));
  }
  this.state(id,'reviewing');
  try{
   const c=await this.remote(id,'review',payload);
   if(c.id!==payload.id||c.endpoint_id!==payload.new_endpoint_id||c.prior_epoch!==payload.epoch||c.epoch!==payload.epoch+1||typeof c.ticket!=='string'||c.review_event!==event_id||c.budget_reset!==false)throw Error('DEVELOPMENT_REVIEW_EVIDENCE_MISMATCH');
   const current=c.endpoint_id===this.instance;
   this.db.prepare("UPDATE development_peer_requests SET claim=?,state=?,error=?,updated=? WHERE id=?").run(canonical({id:c.id,epoch:c.epoch,endpoint_id:c.endpoint_id,ticket:c.ticket}),'needs_review',current?'DEVELOPMENT_REVIEW_VALIDATION_PENDING':'DEVELOPMENT_PEER_RESTART_UNKNOWN',this.g.now(),id);
   this.db.prepare("UPDATE development_peer_reviews SET state='completed',result=? WHERE event_id=?").run(canonical(c),event_id);
   // A recovered response is historical, not proof that the approval is still valid.
   if(current){await this.remote(id,'read',JSON.parse(this.row(id).claim));this.state(id,'active');}
   return {...this.view(id),epoch:c.epoch,grants_execution:current,starts_worker:false,budget_reset:false};
  }catch(e){this.state(id,'needs_review',safe(e));throw e;}
 });}
 cancel(id){return this.track(async()=>{
  const r=this.row(id),unknownUnclaimed=r.state==='needs_review'&&!r.claim&&this.db.prepare('SELECT 1 FROM development_peer_claim_intents WHERE local_id=?').get(id)&&!this.db.prepare('SELECT 1 FROM development_peer_calls WHERE local_id=?').get(id);
  if(r.state!=='cloud_queued'&&!unknownUnclaimed)throw Error('DEVELOPMENT_PEER_NOT_QUEUED');
  try{const v=await this.remote(id,'cancel',{id:r.request_id});if(v.state!=='rejected')throw Error('DEVELOPMENT_BRIDGE_RESULT_UNKNOWN');this.state(id,'cancelled');return this.view(id);}catch(e){this.state(id,'needs_review',safe(e));throw e;}
 });}
 snapshot(){return {enabled:this.started&&!this.closed,storage_host:'cloud',queues:this.db.prepare('SELECT state,count(*) count FROM development_peer_requests GROUP BY state').all(),automatic_execution:false};}
 close(){if(this.closing)return this.closing;this.closed=true;this.closing=(async()=>{try{await this.starting;}catch{}await Promise.allSettled([...this.pending]);if(this.lock?.listening)await new Promise(r=>this.lock.close(r));})();return this.closing;}
}
