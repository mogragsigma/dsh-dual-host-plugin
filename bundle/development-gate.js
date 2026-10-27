import {randomUUID} from 'node:crypto';
import {canonical,digest} from './approval-ledger.js';
import {approvedDevelopment} from './development-contract.js';
import {DevelopmentFiles} from './development-files.js';
import {DevelopmentWorkspace,contentHash} from './development-workspace.js';

// Cloud-authoritative, internal component. No RPC, model tool or default activation.
// The host adapter must own one exclusive scheduler instance before recover/acquire.
export class DevelopmentGate {
 constructor({store,ledger,bindings={},enabled=false,now=Date.now,busy=()=>false,commands=null}){
  Object.assign(this,{store,db:store.db,ledger,bindings:structuredClone(bindings),enabled,now,busy,commands});
  this.inflight=new Set();
  this.db.exec(`CREATE TABLE IF NOT EXISTS development_requests(
   seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,event_id TEXT UNIQUE,fingerprint TEXT,
   task_id TEXT,approval_id TEXT,authority_hash TEXT,node TEXT,resource TEXT,policy TEXT,state TEXT,epoch INTEGER,
   expected_hash TEXT,test_result TEXT,created INTEGER,error TEXT);
   CREATE UNIQUE INDEX IF NOT EXISTS development_resource_owner ON development_requests(resource)
    WHERE state IN ('active','needs_review');
   CREATE TABLE IF NOT EXISTS development_writes(id TEXT PRIMARY KEY,request_id TEXT,fingerprint TEXT,
    old_hash TEXT,new_hash TEXT,state TEXT,created INTEGER);
   CREATE TABLE IF NOT EXISTS development_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT,type TEXT,data TEXT,created INTEGER);
   CREATE TABLE IF NOT EXISTS development_operations(id TEXT PRIMARY KEY,request_id TEXT NOT NULL,epoch INTEGER NOT NULL,
    kind TEXT NOT NULL,state TEXT NOT NULL,pid INTEGER,started INTEGER NOT NULL,closed INTEGER,exit_code INTEGER,signal TEXT);`);
  this.db.exec(`CREATE TABLE IF NOT EXISTS development_commands(id TEXT PRIMARY KEY,request_id TEXT NOT NULL,command_id TEXT NOT NULL,fingerprint TEXT NOT NULL,operation_id TEXT NOT NULL,state TEXT NOT NULL,result TEXT,created INTEGER NOT NULL);`);
  // Legacy rows remain NULL and cannot silently adopt the current filesystem.
  if(!this.db.prepare('PRAGMA table_info(development_requests)').all().some(c=>c.name==='workspace_identity'))this.db.exec('ALTER TABLE development_requests ADD COLUMN workspace_identity TEXT;');
 }
 event(id,type,data={}){this.db.prepare('INSERT INTO development_events(request_id,type,data,created) VALUES (?,?,?,?)').run(id,type,canonical(data),this.now());}
 row(id){const r=this.db.prepare('SELECT * FROM development_requests WHERE id=?').get(id);if(!r)throw Error('DEVELOPMENT_REQUEST_NOT_FOUND');return r;}
 authority(task,approval,policy,{requireFresh=true}={}){
  if(!this.enabled)throw Error('DEVELOPMENT_DISABLED');
  const a=approvedDevelopment(this.ledger,task,approval,policy),b=this.bindings[task];
  if(requireFresh&&!this.ledger.repositories?.status(task).verification_fresh)throw Error('DEVELOPMENT_REPOSITORY_NOT_FRESH');
  if(!b||b.approval_hash!==a.hash)throw Error('DEVELOPMENT_OPERATOR_BINDING_REQUIRED');
  return {...a,workspace:new (a.spec.kind==='workspace-v1'?DevelopmentFiles:DevelopmentWorkspace)(b,a.spec,a.approval.proposal.repository)};
 }
 enqueue(node,{task_id,approval_id,policy,event_id}){
  if(!['local','cloud'].includes(node)||typeof event_id!=='string'||!event_id||event_id.length>256)throw Error('DEVELOPMENT_INVALID_REQUEST');
  const a=this.authority(task_id,approval_id,policy),resource=a.approval.proposal.repository.url;
  if(a.spec.executors&&!a.spec.executors.includes(node))throw Error('DEVELOPMENT_EXECUTOR_DENIED');
  const fp=digest({node,task_id,approval_id,policy,event_id});
  return this.store.tx(()=>{
   const old=this.db.prepare('SELECT * FROM development_requests WHERE event_id=?').get(event_id);
   if(old){if(old.fingerprint!==fp)throw Error('DEVELOPMENT_EVENT_CONFLICT');this.assertWorkspace(old,a.workspace);return this.view(old.id);}
   const id='development-'+randomUUID();
   this.db.prepare(`INSERT INTO development_requests(id,event_id,fingerprint,task_id,approval_id,authority_hash,node,resource,policy,state,created)
    VALUES (?,?,?,?,?,?,?,?,?,'queued',?)`).run(id,event_id,fp,task_id,approval_id,a.hash,node,resource,canonical(policy),this.now());
   this.db.prepare('UPDATE development_requests SET workspace_identity=? WHERE id=?').run(canonical(a.workspace.identity()),id);
   this.event(id,'queued');return this.view(id);
  });
 }
 view(id){const r=this.row(id);return {id:r.id,task_id:r.task_id,node:r.node,state:r.state,epoch:r.epoch,error:r.error,expected_hash:r.expected_hash,test_result:r.test_result?JSON.parse(r.test_result):null};}
 waiting(id){
  // Read-only projection shared by admission and diagnostics. Never acquires or repairs.
  const r=this.row(id),t=this.store.task(r.task_id);
  if(r.state==='needs_review'||t.blocked)return 'development_review';
  if(this.unresolved(id)||this.inflight.has(id))return 'development_draining';
  if(r.state!=='queued')return null;
  if(t.busy||this.busy(r.task_id))return 'task_busy';
  const owner=this.db.prepare("SELECT id,state FROM development_requests WHERE resource=? AND state IN ('active','needs_review')").get(r.resource);
  if(owner)return owner.state==='needs_review'?'development_resource_review':this.unresolved(owner.id)||this.inflight.has(owner.id)?'development_resource_draining':'development_resource_busy';
  // Optional journal shares the SAME database. Cutoff merges FIFO order across
  // both queues without wall-clock ties; absence preserves the previous behavior.
  if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='delivery_actions'").get()){
   const delivery=this.db.prepare("SELECT state FROM delivery_actions WHERE resource=? AND state IN ('active','needs_review')").get(r.resource);
   if(delivery)return delivery.state==='needs_review'?'delivery_resource_review':'delivery_resource_busy';
   if(this.db.prepare("SELECT 1 FROM delivery_actions WHERE resource=? AND state='queued' AND development_cutoff<?").get(r.resource,r.seq))return 'delivery_fifo';
  }
  if(this.db.prepare("SELECT 1 FROM development_requests WHERE resource=? AND state='queued' AND seq<?").get(r.resource,r.seq))return 'development_fifo';
  return null;
 }
 assertWorkspace(r,workspace){
  if(!r.workspace_identity)throw Error('DEVELOPMENT_WORKSPACE_IDENTITY_REQUIRED');
  if(r.workspace_identity!==canonical(workspace.identity()))throw Error('DEVELOPMENT_WORKSPACE_IDENTITY_CHANGED');
 }
 acquire(id,onAcquire){
  return this.store.tx(()=>{
   const r=this.row(id);if(r.state!=='queued')throw Error('DEVELOPMENT_NOT_QUEUED');
   const t=this.store.task(r.task_id);
   if(t.blocked)throw Error('DEVELOPMENT_TASK_BLOCKED');
   const a=this.authority(r.task_id,r.approval_id,JSON.parse(r.policy),{requireFresh:false});if(a.hash!==r.authority_hash)throw Error('DEVELOPMENT_APPROVAL_CHANGED');
   this.assertWorkspace(r,a.workspace);
   // Claiming an idle resource does not authorize reads/writes: run refreshes remote metadata first.
   const waiting=this.waiting(id);if(waiting)return {acquired:false,reason:waiting};
   // Continue only our last attested file, never import arbitrary pre-existing dirty work.
   const previous=this.db.prepare("SELECT expected_hash FROM development_requests WHERE task_id=? AND resource=? AND state='completed' ORDER BY seq DESC LIMIT 1").get(r.task_id,r.resource);
   // Explicit workspace recovery retains the attested dirty manifest on this
   // same queued request. Never reset it to HEAD or adopt arbitrary dirty files.
   let expected=(a.spec.kind==='workspace-v1'?r.expected_hash:null)??previous?.expected_hash??null;const checked=a.workspace.check(expected);
   if(a.spec.kind==='workspace-v1')expected=checked.hash;
   this.db.prepare('UPDATE tasks SET owner=?,epoch=epoch+1,busy=1 WHERE id=?').run(r.node,r.task_id);
   const epoch=t.epoch+1;this.db.prepare("UPDATE development_requests SET state='active',epoch=?,expected_hash=? WHERE id=?").run(epoch,expected,r.id);
   this.event(id,'acquired',{node:r.node,epoch});onAcquire?.({id:r.id,node:r.node,epoch});return {acquired:true,...this.view(id)};
  });
 }
 assert(id,node,epoch){
  const r=this.row(id);if(r.state!=='active'||r.node!==node||r.epoch!==epoch)throw Error('DEVELOPMENT_STALE_FENCE');
  const t=this.store.fence(node,r.task_id,epoch);if(!t.busy)throw Error('DEVELOPMENT_NOT_BUSY');
  const a=this.authority(r.task_id,r.approval_id,JSON.parse(r.policy));if(a.hash!==r.authority_hash)throw Error('DEVELOPMENT_APPROVAL_CHANGED');
  this.assertWorkspace(r,a.workspace);
  return {r,...a};
 }
 read(id,node,epoch,path){const {r,workspace,spec}=this.assert(id,node,epoch);return spec.kind==='workspace-v1'?workspace.read(r.expected_hash,path):workspace.check(r.expected_hash);}
 progress(id){
  const r=this.row(id),spec=this.ledger.view(r.approval_id).proposal.development;
  const count=table=>this.db.prepare(`SELECT count(*) n FROM ${table} x JOIN development_requests r ON r.id=x.request_id WHERE r.approval_id=?`).get(r.approval_id).n;
  const calls=this.db.prepare("SELECT count(*) n FROM development_events e JOIN development_requests r ON r.id=e.request_id WHERE r.approval_id=? AND e.type='write_tool_called'").get(r.approval_id).n;
  const commands=this.db.prepare('SELECT command_id,state,result FROM development_commands WHERE request_id=? ORDER BY rowid').all(id).map(c=>{
   const v=c.result&&JSON.parse(c.result);return {command_id:c.command_id,state:c.state,passed:v?.passed===true,drained:v?.drained===true,current_manifest:v?.file_hash===r.expected_hash,code:v?.code??null};
  });
  return {write_budget:{limit:spec.max_writes,intents_used:count('development_writes'),calls_used:calls},command_budget:{limit:spec.max_commands,used:count('development_commands')},previous_commands:commands};
 }
 admitWriteCall(id,node,epoch,call_id){
  return this.store.tx(()=>{
   const {spec,r}=this.assert(id,node,epoch);if(this.unresolved(id))throw Error('DEVELOPMENT_CHILD_DRAIN_UNKNOWN');
   if(typeof call_id!=='string'||!call_id||call_id.length>256)throw Error('DEVELOPMENT_INVALID_WRITE');
   const calls=this.db.prepare("SELECT e.request_id,e.data FROM development_events e JOIN development_requests r ON r.id=e.request_id WHERE r.approval_id=? AND e.type='write_tool_called'").all(r.approval_id).map(x=>({...JSON.parse(x.data),request_id:x.request_id}));
   if(calls.some(x=>x.request_id===id&&x.call_id===call_id))return;
   if(calls.length>=spec.max_writes)throw Error('DEVELOPMENT_WRITE_CALL_BUDGET');
   this.event(id,'write_tool_called',{epoch,call_id});
  });
 }
 write(id,node,epoch,{call_id,expected_hash,content,path}){
  const {r,workspace,spec}=this.assert(id,node,epoch);
  if(this.inflight.has(id))throw Error('DEVELOPMENT_OPERATION_IN_FLIGHT');
  if(this.unresolved(id))throw Error('DEVELOPMENT_CHILD_DRAIN_UNKNOWN');
  const multi=spec.kind==='workspace-v1';
  if(typeof call_id!=='string'||!call_id||call_id.length>256||(!multi&&(typeof content!=='string'||!content.trim()||Buffer.byteLength(content)>8192||content.includes('\0'))))throw Error('DEVELOPMENT_INVALID_WRITE');
  const key=id+':'+call_id,fp=digest({epoch,expected_hash,content,...(multi?{path}:{})}),old=this.db.prepare('SELECT * FROM development_writes WHERE id=?').get(key);
  if(old){if(old.fingerprint!==fp)throw Error('DEVELOPMENT_WRITE_CONFLICT');if(old.state!=='applied')throw Error('DEVELOPMENT_WRITE_UNCERTAIN');return {sha256:old.new_hash,replayed:true};}
  if(expected_hash!==r.expected_hash)throw Error('DEVELOPMENT_FILE_CONFLICT');
  const count=this.db.prepare('SELECT COUNT(*) n FROM development_writes w JOIN development_requests r ON r.id=w.request_id WHERE r.approval_id=?').get(r.approval_id).n;
  if(count>=spec.max_writes)throw Error('DEVELOPMENT_WRITE_BUDGET');
  workspace.check(r.expected_hash);
  const hash=multi?workspace.prepare(expected_hash,{path,content}).hash:contentHash(content);
  this.store.tx(()=>{this.assert(id,node,epoch);this.db.prepare("INSERT INTO development_writes VALUES (?,?,?,?,?,'writing',?)").run(key,id,fp,expected_hash,hash,this.now());this.event(id,'write_intent',{call_id,hash,...(multi?{path,deleted:content===null}:{})});});
  try{
   workspace.write(multi?{path,content}:content,expected_hash);
   this.store.tx(()=>{this.assert(id,node,epoch);this.db.prepare("UPDATE development_writes SET state='applied' WHERE id=?").run(key);this.db.prepare('UPDATE development_requests SET expected_hash=?,test_result=NULL WHERE id=?').run(hash,id);this.event(id,'write_applied',{call_id,hash});});
   return {sha256:hash,committed:false,pushed:false};
  }catch(e){this.block(id,'DEVELOPMENT_WRITE_UNCERTAIN');throw e;}
 }
 unresolved(id){return !!this.db.prepare("SELECT 1 FROM development_operations WHERE request_id=? AND state<>'closed'").get(id);}
 async test(id,node,epoch,signal){
  const {r,workspace,spec}=this.assert(id,node,epoch);if(spec.kind==='workspace-v1')throw Error('DEVELOPMENT_USE_APPROVED_COMMAND');if(this.inflight.has(id))throw Error('DEVELOPMENT_OPERATION_IN_FLIGHT');
  if(this.unresolved(id))throw Error('DEVELOPMENT_CHILD_DRAIN_UNKNOWN');
  const operation='operation-'+randomUUID();
  this.store.tx(()=>{this.assert(id,node,epoch);this.db.prepare("INSERT INTO development_operations VALUES (?,?,?,'test','intent',NULL,?,NULL,NULL,NULL)").run(operation,id,epoch,this.now());
   this.db.prepare('UPDATE development_requests SET test_result=NULL WHERE id=?').run(id);this.event(id,'test_intent',{operation,epoch,file_hash:r.expected_hash});});
  const closed=({code=null,signal=null}={})=>this.store.tx(()=>{this.db.prepare("UPDATE development_operations SET state='closed',closed=?,exit_code=?,signal=? WHERE id=?").run(this.now(),code,signal,operation);this.event(id,'test_drained',{operation,code,signal});});
  this.inflight.add(id);
  try{
   const result=await workspace.test(r.expected_hash,signal,{onSpawn:({pid})=>{this.db.prepare("UPDATE development_operations SET state=?,pid=? WHERE id=?").run(pid?'spawned':'intent',pid,operation);},onClose:closed});
   // Validation may reject a source without creating a child. A returned result is
   // only possible after the adapter's close barrier, never after an early error.
   if(this.unresolved(id))closed();
   this.assert(id,node,epoch);this.db.prepare('UPDATE development_requests SET test_result=? WHERE id=?').run(canonical(result),id);this.event(id,'tested',result);return result;
  }catch(e){
   const op=this.db.prepare('SELECT * FROM development_operations WHERE id=?').get(operation);
   if(op.state==='intent'&&op.pid===null&&e.drained===true)closed();
   if(this.unresolved(id))this.block(id,'DEVELOPMENT_CHILD_DRAIN_UNKNOWN');throw e;
  }finally{this.inflight.delete(id);}
 }

 async command(id,node,epoch,{command_id,call_id},signal){
  const {r,workspace,spec}=this.assert(id,node,epoch);
  if(spec.kind!=='workspace-v1'||!spec.commands.some(c=>c.id===command_id))throw Error('DEVELOPMENT_COMMAND_DENIED');
  if(!this.commands)throw Error('DEVELOPMENT_CONTAINER_UNAVAILABLE');
  if(typeof call_id!=='string'||!call_id||call_id.length>256)throw Error('DEVELOPMENT_INVALID_REQUEST');
  if(this.inflight.has(id)||this.unresolved(id))throw Error('DEVELOPMENT_NOT_DRAINED');
  const key=id+':'+call_id,fp=digest({epoch,command_id,file_hash:r.expected_hash});
  const old=this.db.prepare('SELECT * FROM development_commands WHERE id=?').get(key);
  if(old){if(old.fingerprint!==fp)throw Error('DEVELOPMENT_COMMAND_CONFLICT');if(old.state!=='completed')throw Error('DEVELOPMENT_COMMAND_UNCERTAIN');return {...JSON.parse(old.result),replayed:true};}
  const count=this.db.prepare('SELECT COUNT(*) n FROM development_commands c JOIN development_requests r ON r.id=c.request_id WHERE r.approval_id=?').get(r.approval_id).n;
  if(count>=spec.max_commands)throw Error('DEVELOPMENT_COMMAND_BUDGET');workspace.check(r.expected_hash);
  const operation='operation-'+randomUUID();
  this.store.tx(()=>{
   this.assert(id,node,epoch);
   this.db.prepare("INSERT INTO development_commands VALUES (?,?,?,?,?,'running',NULL,?)").run(key,id,command_id,fp,operation,this.now());
   this.db.prepare("INSERT INTO development_operations VALUES (?,?,?,'command','intent',NULL,?,NULL,NULL,NULL)").run(operation,id,epoch,this.now());
   this.db.prepare('UPDATE development_requests SET test_result=NULL WHERE id=?').run(id);
   this.event(id,'command_intent',{operation,command_id,file_hash:r.expected_hash,epoch});
  });
  const closed=({code=null,signal=null,container_id=null}={})=>this.store.tx(()=>{
   this.db.prepare("UPDATE development_operations SET state='closed',closed=?,exit_code=?,signal=? WHERE id=?").run(this.now(),code,signal,operation);
   this.event(id,'command_drained',{operation,container_id,code,signal});
  });
  this.inflight.add(id);
  try{
   const result=await this.commands.run(workspace,r.expected_hash,command_id,{operation,signal,
    onCreated:c=>this.event(id,'command_container',{operation,...c}),onClosed:closed});
   if(this.unresolved(id)||!result.drained)throw Error('DEVELOPMENT_CONTAINER_DRAIN_UNKNOWN');
   this.assert(id,node,epoch);workspace.check(r.expected_hash);
   if(result.file_hash!==r.expected_hash||result.command_id!==command_id||result.command_hash!==digest(spec.commands.find(c=>c.id===command_id)))throw Error('DEVELOPMENT_COMMAND_RECEIPT_INVALID');
   this.store.tx(()=>{
    this.db.prepare("UPDATE development_commands SET state='completed',result=? WHERE id=?").run(canonical(result),key);
    const results=spec.commands.filter(c=>c.required).map(c=>{
     const latest=this.db.prepare('SELECT result,state FROM development_commands WHERE request_id=? AND command_id=? ORDER BY rowid DESC LIMIT 1').get(id,c.id);
     return latest?.state==='completed'?JSON.parse(latest.result):{command_id:c.id,passed:false};
    });
    const test={passed:results.every(c=>c.passed&&c.file_hash===r.expected_hash),file_hash:r.expected_hash,validator:'approved-commands-v1',commands:results};
    this.db.prepare('UPDATE development_requests SET test_result=? WHERE id=?').run(canonical(test),id);
    this.event(id,'command_result',{operation,...result});
   });return result;
  }catch(e){
   if(e.drained===true&&this.unresolved(id))closed();
   this.db.prepare("UPDATE development_commands SET state='needs_review' WHERE id=? AND state='running'").run(key);
   this.block(id,'DEVELOPMENT_COMMAND_REVIEW_REQUIRED');throw e;
  }finally{this.inflight.delete(id);}
 }

 finish(id,node,epoch,{agentDrained=false}={}){
  if(!agentDrained||this.inflight.has(id)||this.unresolved(id))throw Error('DEVELOPMENT_NOT_DRAINED');
  return this.store.tx(()=>{
   const {r,workspace}=this.assert(id,node,epoch),test=r.test_result&&JSON.parse(r.test_result);workspace.check(r.expected_hash);
   if(!test?.passed||test.file_hash!==r.expected_hash)throw Error('DEVELOPMENT_TEST_REQUIRED');
   if(this.db.prepare("SELECT 1 FROM development_writes WHERE request_id=? AND state<>'applied'").get(id))throw Error('DEVELOPMENT_WRITE_UNCERTAIN');
   this.db.prepare("UPDATE development_requests SET state='completed' WHERE id=?").run(id);
   this.db.prepare('UPDATE tasks SET busy=0,checkpoint=? WHERE id=?').run('Bounded development drained; tested sha256 '+r.expected_hash,r.task_id);
   this.event(id,'safe_point',{node,epoch,hash:r.expected_hash});return {...this.view(id),committed:false,pushed:false,published:false};
  });
 }
 block(id,code){
  return this.store.tx(()=>{const r=this.row(id);if(r.state!=='active')return;
   this.db.prepare("UPDATE development_requests SET state='needs_review',error=? WHERE id=?").run(code,id);
   this.db.prepare('UPDATE tasks SET blocked=1 WHERE id=?').run(r.task_id);this.event(id,'blocked',{code});
  });
 }
 rejectQueued(id,code){const r=this.row(id);if(r.state!=='queued')return;this.store.tx(()=>{this.db.prepare("UPDATE development_requests SET state='rejected',error=? WHERE id=? AND state='queued'").run(code,id);this.event(id,'rejected',{code});});}
 recover(){
  // Never call while another process may hold an agent/child. No timeout-based takeover.
  if(this.inflight.size)throw Error('DEVELOPMENT_NOT_DRAINED');
  for(const r of this.db.prepare("SELECT id FROM development_requests WHERE state='active'").all())this.block(r.id,'DEVELOPMENT_HOST_RESTARTED_REVIEW');
 }
}
