// Single-user task continuity. Native Host/IM admission is upstream, not a new identity service.
// Thread/Input/handback semantics follow the reviewed prototype; one existing Coordinator owns state.
import {digest,canonical} from './approval-ledger.js';
import {ruleInterpretation,validateInterpretation} from './approval-semantics.js';
import {hash} from './store.js';
import {errorInfo,retryBarrierErrors} from './link-contract.js';
import {parseEnvelope} from './task-envelope.js';
const json=JSON.stringify;
const text=(s,n=256)=>{if(typeof s!=='string'||!s.trim()||s.length>n)throw Error('TASK_INPUT_INVALID');return s;};
const idOf=s=>'r2:'+hash(json([s.role,s.session_id,s.message_id]));
export function nativeInput(agent,role,current){
 return {role,session_id:agent.id,...current};
}
export class TaskContinuity {
 constructor(g){
  this.g=g;this.db=g.store.db;this.store=g.store;
  this.db.exec(`CREATE TABLE IF NOT EXISTS task_input_events(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,source TEXT NOT NULL,purpose TEXT NOT NULL,created INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS task_input_links(thread_key TEXT,task_id TEXT,mode TEXT,origin INTEGER,active INTEGER,PRIMARY KEY(thread_key,task_id));
   CREATE TABLE IF NOT EXISTS task_inputs(seq INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT,task_id TEXT,mode TEXT,state TEXT,revision INTEGER,artifact_id TEXT,run_id TEXT,reason TEXT,UNIQUE(event_id,task_id));
   CREATE TABLE IF NOT EXISTS task_continuity(task_id TEXT PRIMARY KEY,state TEXT,version INTEGER,control_id TEXT,targets TEXT);
   CREATE TABLE IF NOT EXISTS task_native_decisions(event_id TEXT PRIMARY KEY,request_id TEXT,action TEXT,record TEXT,fingerprint TEXT,decision_id TEXT);
   CREATE TABLE IF NOT EXISTS task_input_operations(id TEXT PRIMARY KEY,fingerprint TEXT,result TEXT);
   CREATE INDEX IF NOT EXISTS task_inputs_task_sequence ON task_inputs(task_id,seq);
   CREATE INDEX IF NOT EXISTS task_input_links_task ON task_input_links(task_id);`);
 }
 source(node,s){
  if(!s||s.role!==node||!['local','cloud'].includes(node)||Object.keys(s).some(k=>!['role','session_id','message_id','text','sha256'].includes(k)))throw Error('CONTEXT_ORIGIN_MISMATCH');
  text(s.session_id);text(s.message_id);text(s.text,262144);if(s.sha256!==hash(s.text))throw Error('TASK_INPUT_INVALID');return structuredClone(s);
 }
 eventId(s,purpose){const old=idOf(s);return this.db.prepare('SELECT purpose FROM task_input_events WHERE id=?').get(old)?.purpose===purpose?old:old+':'+purpose;}
 event(node,s,purpose){
  s=this.source(node,s);const id=this.eventId(s,purpose),fp=hash(json(s));
  const old=this.db.prepare('SELECT * FROM task_input_events WHERE id=?').get(id);
  if(old){if(old.fingerprint!==fp||old.purpose!==purpose)throw Error('TASK_INPUT_CONFLICT');}
  else this.db.prepare('INSERT INTO task_input_events VALUES (?,?,?,?,?)').run(id,fp,json(s),purpose,this.g.now());
  return id;
 }
 decide(node,{request_id,expected_revision,proposal_hash,expected_decision_id,action,source}){
  source=this.source(node,source);text(request_id);text(proposal_hash);if(!['approve','reject','hold','amend','clarify','revoke'].includes(action))throw Error('INVALID_APPROVAL_ACTION');
  if(expected_decision_id!==null)text(expected_decision_id);
  const l=this.g.approvals,r=l.row(request_id);this.selected([r.task_id]);
  const quick=ruleInterpretation(source.text),interpretation=quick??validateInterpretation({intent:action,unconditional:action==='approve',changes:[],reason:'原生入口对当前用户完整意见的解释。'},source.text);
  // Full-text negation, conditions and quotations cannot be replaced by a positive excerpt.
  if(interpretation.intent!==action)throw Error('TASK_DECISION_INTERPRETATION_CONFLICT');
  const event=this.eventId(source,'decision'),record={event,request_id,expected_revision,proposal_hash,expected_decision_id,action,source,interpretation},fp=digest(record);
  return this.store.tx(()=>{
   const old=this.db.prepare('SELECT * FROM task_native_decisions WHERE event_id=?').get(event);
   if(old){if(old.fingerprint!==fp)throw Error('TASK_INPUT_CONFLICT');return {...l.view(request_id),recorded:true,historical_receipt:true,execution_started:false};}
   if(this.state(r.task_id).state==='stopped')throw Error('TASK_STOPPED');
   const current=l.row(request_id);
   if(current.spec_revision!==expected_revision||this.g.catalog.head(r.task_id).spec_revision!==expected_revision||current.proposal_hash!==proposal_hash||current.decision_id!==expected_decision_id)throw Error('APPROVAL_WORKBENCH_CHANGED');
   this.event(node,source,'decision');
   this.db.prepare('INSERT INTO task_native_decisions VALUES (?,?,?,?,?,NULL)').run(event,request_id,action,canonical(record),fp);
   const result=l.recordDecision({request_id,action,principal:'single-user-'+node,credential_id:'task-native',proof_hash:fp,challenge_id:event,nativeTask:true});
   this.db.prepare('UPDATE task_native_decisions SET decision_id=? WHERE event_id=?').run(l.row(request_id).decision_id,event);
   return {...l.view(request_id),recorded:true,execution_started:false};
  });
 }
 managed(id){return !!this.db.prepare('SELECT 1 FROM task_continuity WHERE task_id=?').get(id);}
 register(task,envelope){
  if(envelope?.continuity!==1)return;
  const s={role:envelope.origin.role,session_id:envelope.origin.session_id,message_id:envelope.origin.message_id,text:envelope.request_text,sha256:envelope.origin.request_sha256};
  const id=this.event(s.role,s,'create');
  this.db.prepare("INSERT OR IGNORE INTO task_continuity VALUES (?,'active',0,NULL,'[]')").run(task.id);
  this.db.prepare("INSERT OR IGNORE INTO task_input_links VALUES (?,?,'follow',1,1)").run(id,task.id);
 }
 registerPolicy(task,envelope){
  if(envelope.origin?.kind!=='policy')throw Error('SOURCE_POLICY_ENVELOPE_INVALID');
  this.db.prepare("INSERT OR IGNORE INTO task_continuity VALUES (?,'active',0,NULL,'[]')").run(task.id);
  this.db.prepare("INSERT OR IGNORE INTO task_input_links VALUES (?,?,'follow',1,1)").run(envelope.origin.thread_key,task.id);
 }
 // Internal source data, never passed through the public human-source validator.
 receiveSource({id,thread,source_id,event,task,mode}){
  this.assertActive(task);this.g.sourceRouting.assertTask(task);
  const source={kind:'source-data',source_id,event_id:event.id,actor:event.actor,text:event.text,sha256:hash(event.text)},fp=hash(json(source));
  const write=()=>{
   const old=this.db.prepare('SELECT fingerprint FROM task_input_events WHERE id=?').get(id);
   if(old&&old.fingerprint!==fp)throw Error('TASK_INPUT_CONFLICT');
   this.db.prepare("INSERT OR IGNORE INTO task_input_events VALUES (?,?,?,'input',?)").run(id,fp,json(source),this.g.now());
   this.db.prepare("INSERT OR IGNORE INTO task_inputs(event_id,task_id,mode,state,revision) VALUES (?,?,?,'saved',?)").run(id,task,mode,this.g.catalog.head(task).spec_revision);
  };
  if(this.db.isTransaction)write();else this.store.tx(write);
  if(mode==='follow')this.g.execution.follow(task);
 }
 state(id){this.store.task(id);return this.db.prepare('SELECT state,version FROM task_continuity WHERE task_id=?').get(id)??{state:'legacy',version:0};}
 assertActive(id){const s=this.state(id);if(!['legacy','active'].includes(s.state))throw Error(s.state==='stopped'?'TASK_STOPPED':'TASK_PAUSED');}
 resolve({task_id,query,thread_key}={}){
  if([task_id,query,thread_key].filter(x=>x!==undefined).length!==1)throw Error('TASK_REFERENCE_REQUIRED');
  if(task_id){const h=this.g.catalog.head(text(task_id));return {items:[{task_id,title:h.title,spec_revision:h.spec_revision,...this.state(task_id)}],requires_clarification:false};}
  if(query!==undefined){text(query,120);const r=this.g.catalog.find({query,limit:50});return {...r,requires_clarification:r.total!==1};}
  text(thread_key);const items=this.db.prepare('SELECT task_id,mode FROM task_input_links WHERE thread_key=? AND active=1').all(thread_key).map(x=>({...x,title:this.g.catalog.head(x.task_id).title,spec_revision:this.g.catalog.head(x.task_id).spec_revision,...this.state(x.task_id)}));
  return {items,requires_clarification:items.filter(x=>x.mode==='follow').length!==1};
 }
 selected(ids){
  if(!Array.isArray(ids)||!ids.length||ids.length>8||new Set(ids).size!==ids.length)throw Error('TASK_REFERENCE_REQUIRED');
  for(const id of ids){text(id);if(!this.managed(id))throw Error('LEGACY_TASK_CONTINUITY_UNAVAILABLE');}return [...ids].sort();
 }
 receive(node,{task_ids,source,mode='follow',artifact_id=null,thread_key=null,expected_revisions}){
  const ids=this.selected(task_ids);if(!['follow','reference'].includes(mode))throw Error('TASK_INPUT_INVALID');
  source=this.source(node,source);const id=this.eventId(source,'input'),fp=hash(json({ids,source,mode,artifact_id,thread_key,expected_revisions}));
  const result=this.store.tx(()=>{
   const old=this.db.prepare('SELECT * FROM task_input_operations WHERE id=?').get(id);
   if(old){if(old.fingerprint!==fp)throw Error('TASK_INPUT_CONFLICT');return JSON.parse(old.result);}
   this.event(node,source,'input');
   // A thread is an explicit known message chain, never an entire group or most-recent session.
   if(thread_key&&!this.db.prepare('SELECT 1 FROM task_input_links WHERE thread_key=? AND active=1').get(text(thread_key)))throw Error('TASK_THREAD_NOT_FOUND');
   for(const task of ids){
    if(thread_key&&this.db.prepare('SELECT active FROM task_input_links WHERE thread_key=? AND task_id=?').get(thread_key,task)?.active===0)throw Error('TASK_THREAD_UNLINKED');
    const h=this.g.catalog.head(task);
    if(!expected_revisions||expected_revisions[task]!==h.spec_revision)throw Error('TASK_REVISION_CONFLICT');
    if(artifact_id){text(artifact_id);if(!this.g.artifacts)throw Error('ARTIFACT_NOT_FOUND');this.g.artifacts.load(task,artifact_id);}
    this.db.prepare("INSERT INTO task_inputs(event_id,task_id,mode,state,revision,artifact_id) VALUES (?,?,?,'saved',?,?)").run(id,task,mode,h.spec_revision,artifact_id);
    this.db.prepare('INSERT OR IGNORE INTO task_input_links VALUES (?,?,?,0,1)').run(thread_key??id,task,mode);
   }
   const result={input_id:id,thread_key:thread_key??id,task_ids:ids,status:'saved',delivered:false,applied:false,authority:'cloud'};
   this.db.prepare('INSERT INTO task_input_operations VALUES (?,?,?)').run(id,fp,json(result));return result;
  });
  for(const task of ids){this.g.scheduler?.worker.notifyInput(task,result.input_id);this.g.execution?.follow(task);}
  return result;
 }
 read(id,{after=0,limit=20}={}){
  this.store.task(id);if(!Number.isSafeInteger(after)||after<0||!Number.isInteger(limit)||limit<1||limit>50)throw Error('TASK_INPUT_INVALID');
  const rows=this.db.prepare('SELECT i.*,e.source,e.created FROM task_inputs i JOIN task_input_events e ON e.id=i.event_id WHERE i.task_id=? AND i.seq>? ORDER BY i.seq LIMIT ?').all(id,after,limit+1);
  let bytes=0;const page=[];for(const row of rows.slice(0,limit)){const n=Buffer.byteLength(row.source);if(page.length&&bytes+n>524288)break;page.push(row);bytes+=n;}
  const items=page.map(r=>({...r,source:JSON.parse(r.source),applied:false}));
  return {task_id:id,...this.state(id),items,next_cursor:rows.length>items.length?items.at(-1).seq:null,authority:'cloud'};
 }
 workerRead(job,{after=0,limit=20}={}){
  this.assertActive(job.task_id);const h=this.g.catalog.head(job.task_id);
  if(h.spec_revision!==(parseEnvelope(job.goal)?.task_context?.spec_revision??1))throw Error('TASK_REVISION_CONFLICT');
  const r=this.read(job.task_id,{after,limit});
  // Delivery means returned as worker tool data, not model-read or implemented.
  for(const i of r.items)if(i.state!=='handed_back')this.db.prepare("UPDATE task_inputs SET state='delivered',run_id=? WHERE seq=? AND state<>'handed_back'").run(job.run_id,i.seq);
  return {...r,items:r.items.map(i=>({...i,state:i.state==='saved'?'delivered':i.state})),grants_execution:false};
 }
 handback(job,{input_id,reason}){
  text(input_id);text(reason,1000);this.assertActive(job.task_id);
  return this.store.tx(()=>{
   const r=this.db.prepare('SELECT * FROM task_inputs WHERE task_id=? AND event_id=?').get(job.task_id,input_id);
   if(!r||r.mode!=='follow'||r.state==='saved'||r.run_id!==job.run_id)throw Error('TASK_INPUT_NOT_DELIVERED');
   if(r.state==='handed_back'&&r.reason!==reason)throw Error('TASK_INPUT_CONFLICT');
   this.db.prepare("UPDATE task_inputs SET state='handed_back',reason=? WHERE seq=?").run(reason,r.seq);
   return {input_id,task_id:job.task_id,status:'handed_back',routing_required:!this.db.prepare("SELECT 1 FROM task_inputs WHERE event_id=? AND mode='follow' AND state<>'handed_back'").get(input_id)};
  });
 }
 reroute(node,{input_id,task_ids,source,expected_revisions}){
  const ids=this.selected(task_ids);source=this.source(node,source);text(input_id);
  return this.store.tx(()=>{
   const op=this.eventId(source,'reroute'),fp=hash(json({input_id,ids,source,expected_revisions})),old=this.db.prepare('SELECT * FROM task_input_operations WHERE id=?').get(op);
   if(old){if(old.fingerprint!==fp)throw Error('TASK_INPUT_CONFLICT');return JSON.parse(old.result);}
   this.event(node,source,'reroute');
   if(!this.db.prepare("SELECT 1 FROM task_input_events WHERE id=? AND purpose='input'").get(input_id))throw Error('TASK_INPUT_NOT_FOUND');
   if(this.db.prepare("SELECT 1 FROM task_inputs WHERE event_id=? AND mode='follow' AND state<>'handed_back'").get(input_id))throw Error('TASK_INPUT_STILL_OWNED');
   for(const id of ids){if(this.db.prepare('SELECT 1 FROM task_inputs WHERE event_id=? AND task_id=?').get(input_id,id))throw Error('TASK_INPUT_ALREADY_ROUTED');
    const h=this.g.catalog.head(id);if(expected_revisions?.[id]!==h.spec_revision)throw Error('TASK_REVISION_CONFLICT');
    this.db.prepare("INSERT INTO task_inputs(event_id,task_id,mode,state,revision) VALUES (?,?,'follow','saved',?)").run(input_id,id,h.spec_revision);
    this.db.prepare("INSERT OR IGNORE INTO task_input_links VALUES (?,?,'follow',0,1)").run(input_id,id);
   }
   const result={input_id,task_ids:ids,status:'saved',applied:false};this.db.prepare('INSERT INTO task_input_operations VALUES (?,?,?)').run(op,fp,json(result));return result;
  });
 }
 unlink(node,{task_id,thread_key,source}){
  source=this.source(node,source);text(thread_key);this.selected([task_id]);
  return this.store.tx(()=>{
   const op=this.eventId(source,'unlink'),fp=hash(json({task_id,thread_key,source})),old=this.db.prepare('SELECT * FROM task_input_operations WHERE id=?').get(op);
   if(old){if(old.fingerprint!==fp)throw Error('TASK_INPUT_CONFLICT');return JSON.parse(old.result);}
   const r=this.db.prepare('SELECT * FROM task_input_links WHERE thread_key=? AND task_id=?').get(thread_key,task_id);
   if(!r)throw Error('TASK_THREAD_NOT_FOUND');if(r.origin)throw Error('TASK_ORIGIN_LINK_REQUIRED');
   this.event(node,source,'unlink');this.db.prepare('UPDATE task_input_links SET active=0 WHERE thread_key=? AND task_id=?').run(thread_key,task_id);
   const result={task_id,thread_key,status:'unlinked',history_retained:true};this.db.prepare('INSERT INTO task_input_operations VALUES (?,?,?)').run(op,fp,json(result));return result;
  });
 }
 control(node,{task_id,action,expected_version,source}){
  this.selected([task_id]);source=this.source(node,source);
  if(!['pause','resume','stop'].includes(action))throw Error('INVALID_CONTROL');
  const id=this.eventId(source,'control'),fp=hash(json({task_id,action,expected_version,source}));
  this.store.tx(()=>{
   const old=this.db.prepare('SELECT * FROM task_input_operations WHERE id=?').get(id);
   if(old){if(old.fingerprint!==fp)throw Error('TASK_INPUT_CONFLICT');return;}
   const state=this.state(task_id);if(state.version!==expected_version)throw Error('TASK_CONTROL_CONFLICT');
   if(state.state==='stopped'||action==='pause'&&state.state!=='active'||action==='resume'&&state.state!=='paused')throw Error('TASK_CONTROL_NOT_ALLOWED');
   if(action==='resume'){if(!this.controlStatus(task_id).execution_settled)throw Error('TASK_NOT_QUIESCENT');this.g.execution?.assertResume(task_id);
    for(const j of this.g.scheduler?.jobs.list(task_id)??[])if(!['completed','cancelled'].includes(j.status)){const e=parseEnvelope(j.goal);if((e?.task_context?.spec_revision??1)!==this.g.catalog.head(task_id).spec_revision)throw Error('TASK_REVISION_CONFLICT');}
   }
   this.g.execution?.control(task_id,action==='resume'?'resuming':action);
   this.event(node,source,'control');
   const current=this.db.prepare('SELECT targets FROM task_continuity WHERE task_id=?').get(task_id);
   const targets=action==='resume'?JSON.parse(current.targets):this.g.scheduler?.jobs.list(task_id).filter(j=>action==='stop'?!['completed','cancelled'].includes(j.status):['queued','waiting','running','waiting_input'].includes(j.status)).map(j=>({id:j.id,event:'r2-control:'+hash(id+':'+j.id)}))??[];
   this.db.prepare('UPDATE task_continuity SET state=?,version=version+1,control_id=?,targets=? WHERE task_id=?').run(action==='stop'?'stopped':action==='pause'?'paused':'resuming',id,json(targets),task_id);
   this.db.prepare('INSERT INTO task_input_operations VALUES (?,?,?)').run(id,fp,json({task_id,action,status:'accepted',phase:'pending'}));
  });
  this.reconcile(task_id);return this.controlStatus(task_id);
 }
 reconcileAll(){for(const r of this.db.prepare("SELECT c.task_id FROM task_continuity c JOIN task_input_operations o ON c.control_id=o.id WHERE json_extract(o.result,'$.phase')='pending'").all())this.reconcile(r.task_id);}
 reconcile(task_id){
  const r=this.db.prepare('SELECT * FROM task_continuity WHERE task_id=?').get(task_id);if(!r)return;
  const operation=this.db.prepare('SELECT result FROM task_input_operations WHERE id=?').get(r.control_id??'');if(!operation||JSON.parse(operation.result).phase!=='pending')return;
  const scheduler=this.g.scheduler;
  for(const t of JSON.parse(r.targets)){
   const j=scheduler?.jobs.get(t.id);if(!j||['completed','cancelled'].includes(j.status))continue;
   if(r.state==='resuming'){
    const last=scheduler.jobs.db.prepare("SELECT data FROM job_events WHERE job_id=? AND type IN ('pause','resume','cancel') ORDER BY seq DESC LIMIT 1").get(t.id);
    if(j.status==='paused'&&last&&JSON.parse(last.data).event_id===t.event)scheduler.control({id:t.id,action:'resume',event_id:'r2-resume:'+hash(r.control_id+t.id),actor:'task-continuity'});
   }else if(r.state==='stopped'||r.state==='paused'&&['queued','waiting','running','waiting_input','paused'].includes(j.status))scheduler.control({id:t.id,action:r.state==='stopped'?'cancel':'pause',event_id:t.event,actor:'task-continuity'});
  }
  if(r.state==='resuming'){
   try{this.g.execution?.assertResume(task_id);}catch(e){this.db.prepare("UPDATE task_continuity SET state='paused' WHERE task_id=?").run(task_id);this.db.prepare('UPDATE task_input_operations SET result=? WHERE id=?').run(json({...JSON.parse(operation.result),phase:'blocked',error:e.message}),r.control_id);return;}
   this.store.tx(()=>{this.db.prepare("UPDATE task_continuity SET state='active',targets='[]' WHERE task_id=? AND control_id=?").run(task_id,r.control_id);this.g.execution?.control(task_id,'resume');});
  }
  this.db.prepare('UPDATE task_input_operations SET result=? WHERE id=?').run(json({...JSON.parse(operation.result),phase:'settled'}),r.control_id);
 }
 controlStatus(id){
  const s=this.state(id),draining=[...(this.g.scheduler?.active.values()??[])].some(x=>x.task_id===id)||this.g.store.task(id).busy||!!this.g.execution?.busy(id)||!!this.g.a2a?.busy(id)||!!this.g.deliveryRuntime?.busy(id)||!!this.g.development?.busy(id);
  const links=this.db.prepare('SELECT thread_key,mode,origin,active FROM task_input_links WHERE task_id=?').all(id);
  return {task_id:id,...s,links,pending_inputs:this.db.prepare("SELECT count(*) n FROM task_inputs WHERE task_id=? AND state='saved'").get(id).n,status:draining&&s.state!=='active'?'draining':s.state,execution_settled:!draining&&s.state!=='resuming',authority:'cloud'};
 }
 canRun(id){return ['legacy','active'].includes(this.state(id).state);}
}

// Existing Host-owned database and authenticated DirectLink; no IM consumer or credential service.
// A failed/unknown RPC retains the exact operation and message identity, never reports cloud acceptance.
export class ContinuityOutbox {
 constructor(g){this.g=g;this.db=g.db;this.pending=new Map();this.db.exec(`CREATE TABLE IF NOT EXISTS task_continuity_outbox(id TEXT PRIMARY KEY,fingerprint TEXT,payload TEXT,status TEXT,result TEXT,error TEXT,attempts INTEGER,next_at INTEGER);`);}
 submit(method,args){return this.g.maintenance.run('continuity-input',()=>{
  if(!['source_routing_control','task_followup','task_lifecycle','task_followup_reroute','task_thread_unlink','task_decide'].includes(method))throw Error('METHOD_DENIED');
  const source=args.source;if(source?.role!==this.g.c.role)throw Error('CONTEXT_ORIGIN_MISMATCH');
  const legacy=idOf(source),old=this.db.prepare('SELECT payload FROM task_continuity_outbox WHERE id=?').get(legacy);
  const id=method==='source_routing_control'?legacy+':source:'+hash(json([args.action,args.policy?.id??args.policy_id??args.source_id??args.task_id??'global'])):old&&JSON.parse(old.payload).method===method?legacy:legacy+':'+method,payload=json({method,args}),fp=hash(payload);
  this.db.prepare("INSERT OR IGNORE INTO task_continuity_outbox VALUES (?,?,?,'queued',NULL,NULL,0,0)").run(id,fp,payload);
  if(this.db.prepare('SELECT fingerprint FROM task_continuity_outbox WHERE id=?').get(id).fingerprint!==fp)throw Error('TASK_INPUT_CONFLICT');
  return this.deliver(id);
 });}
 deliver(id){if(this.pending.has(id))return this.pending.get(id);const p=this.send(id).finally(()=>this.pending.delete(id));this.pending.set(id,p);return p;}
 async send(id){
  const r=this.db.prepare('SELECT * FROM task_continuity_outbox WHERE id=?').get(id);
  if(r.status==='accepted')return {...JSON.parse(r.result),historical_receipt:true};
  if(r.status==='needs_review'||r.next_at>this.g.now())return {operation_id:id,status:r.status==='needs_review'?'needs_review':'queued_locally',error:r.error,cloud_accepted:false};
  let result;
  try{const p=JSON.parse(r.payload);result=await this.g.call(p.method,p.args);}
  catch(e){const code=errorInfo(e).code,barrier=retryBarrierErrors.has(code),retry=barrier||code==='COORDINATOR_UNAVAILABLE'||code.startsWith('TRANSIENT_');
   const status=retry&&(barrier||r.attempts<15)?'queued':'needs_review';
   this.db.prepare('UPDATE task_continuity_outbox SET status=?,error=?,attempts=?,next_at=? WHERE id=?').run(status,code,r.attempts+(barrier?0:1),this.g.now()+Math.min(300000,2000*2**Math.min(r.attempts,8)),id);
   return {operation_id:id,status:status==='queued'?'queued_locally':'needs_review',error:code,cloud_accepted:false};
  }
  this.db.prepare("UPDATE task_continuity_outbox SET status='accepted',result=?,error=NULL WHERE id=?").run(json(result),id);return result;
 }
 async tick(){for(const r of this.db.prepare("SELECT id FROM task_continuity_outbox WHERE status='queued' AND next_at<=? ORDER BY rowid LIMIT 10").all(this.g.now())){if(this.g.closed||this.g.maintenance.blocked)return;await this.deliver(r.id);}}
}
