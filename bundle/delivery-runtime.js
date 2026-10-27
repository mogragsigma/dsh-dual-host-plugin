// Opt-in cloud orchestration over the existing coordinator and approval ledger.
// Staging is metadata-only. Scheduling requires a separate operator execution
// switch AND a current exact trusted approval. No action is queued by approval.
import {DeliveryJournal} from './delivery-journal.js';
import {DeliveryApproval} from './delivery-approval.js';
import {DeliveryPushApproval} from './delivery-push-approval.js';
import {DeliveryPush} from './delivery-push.js';
import {DeliveryProcessReceipts} from './delivery-process-receipts.js';
import {DeliveryPushRecovery} from './delivery-push-recovery.js';
import {realpathSync} from 'node:fs';
import {join} from 'node:path';
import {compilePush} from './delivery-push-plan.js';
import {DeliveryGitRead} from './delivery-git-read.js';
import {DeliveryCommit} from './delivery-commit.js';
import {DeliveryRecovery} from './delivery-recovery.js';
import {canonical} from './approval-ledger.js';
const fail=c=>{throw Error('DELIVERY_RUNTIME_'+c);};
const has=(db,t)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const fields=(a,keys)=>a&&typeof a==='object'&&!Array.isArray(a)&&Object.keys(a).length===keys.length&&keys.every(k=>Object.hasOwn(a,k));
const event=x=>typeof x==='string'&&x.length>0&&x.length<=180&&!/[\x00-\x1f\x7f]/.test(x);
const identifier=x=>typeof x==='string'&&x.length>0&&x.length<=128&&!/[\x00-\x1f\x7f]/.test(x);
export class DeliveryRuntime {
 constructor(g,c,io={}){
  if(g.c.role!=='cloud'||!g.scheduler||!g.development||c.enabled!==true)fail('DISABLED');
  if(Object.keys(c).some(k=>!['enabled','execute','author','committer','push'].includes(k))||c.execute!==undefined&&typeof c.execute!=='boolean')fail('CONFIG');
  if(c.push!==undefined&&(!fields(c.push,['enabled','execute','keyFile','knownHostsFile'])||typeof c.push.enabled!=='boolean'||typeof c.push.execute!=='boolean'||c.push.execute&&!c.push.enabled||
   [c.push.keyFile,c.push.knownHostsFile].some(p=>typeof p!=='string'||!p.startsWith('/')||p.length>2048||/[\x00-\x1f\x7f]/.test(p))))fail('PUSH_CONFIG');
  if(c.push?.enabled&&process.platform!=='linux'&&!io.push)fail('PUSH_PLATFORM_UNSUPPORTED');
  for(const v of [c.author,c.committer])if(!fields(v,['name','email'])||typeof v.name!=='string'||!v.name||v.name.length>256||typeof v.email!=='string'||!v.email||v.email.length>254||/[<>\x00-\x1f\x7f]/.test(v.name+v.email))fail('IDENTITY_REQUIRED');
  this.g=g;this.c=structuredClone(c);this.io=io;this.executionEnabled=c.execute===true;this.closed=false;this.started=false;this.pending=null;this.scanAfter=0;
  this.pushEnabled=c.push?.enabled===true;this.pushExecutionEnabled=this.pushEnabled&&c.push.execute===true;this.pushEngines=new Map();this.preparations=new Map();
  this.journal=new DeliveryJournal({store:g.store,enabled:true,pushEnabled:this.pushEnabled,now:g.now,exclusive:()=>this.exclusive(),
   authorize:a=>(this.pushApproval??this.approval).authorize(a),preflight:i=>i.kind==='push-execution-intent-v1'?this.push(i.task_id).cachedPreflight(i):this.reader(i.task_id).preflight(i),
   observe:i=>i.kind==='push-execution-intent-v1'?this.push(i.task_id).cachedReadback(i):this.reader(i.task_id).observe(i),observeUnapplied:(i,b)=>this.reader(i.task_id).unchanged(i,b)});
  this.approval=new DeliveryApproval({ledger:g.approvals,preview:g.delivery,journal:this.journal,enabled:true});
  if(this.pushEnabled)this.pushApproval=new DeliveryPushApproval({commit:this.approval,journal:this.journal,enabled:true});
  g.approvals.delivery=this.pushApproval??this.approval;
 }
 status(){return {staging_enabled:true,execution_enabled:this.executionEnabled,started:this.started&&!this.closed,active_runs:this.pending?1:0,push_staging_enabled:this.pushEnabled,push_enabled:this.pushExecutionEnabled,publish_enabled:false,grants_execution:false};}
 busy(task){return !!this.g.store.db.prepare("SELECT 1 FROM delivery_actions WHERE task_id=? AND state IN ('queued','active','needs_review')").get(task);}
 exclusive(){const s=this.g.scheduler;return s.started&&!s.closed&&s.lock?.listening===true;}
 assertOpen(){if(this.closed||this.g.closed||!this.started||!this.exclusive())fail('EXCLUSIVE_OWNER_REQUIRED');}
 binding(task){
  const b=this.g.development.gate.bindings[task];if(!b)fail('BINDING_REQUIRED');
  return {root:b.root,url:b.url,branch:b.branch,base_sha:b.base_sha};
 }
 drained(task){
  if(!this.exclusive())return false;
  const g=this.g,db=g.store.db,b=this.binding(task);
  if(g.store.task(task).blocked||[...g.scheduler.active.values()].some(a=>a.task_id===task)||g.a2a?.busy(task))return false;
  if(has(db,'development_operations')&&db.prepare("SELECT 1 FROM development_operations o JOIN development_requests r ON r.id=o.request_id WHERE r.resource=? AND o.state<>'closed'").get(b.url))return false;
  for(const id of g.development.gate.inflight.keys())if(g.development.gate.row(id).resource===b.url)return false;
  if(db.prepare("SELECT 1 FROM delivery_operations o JOIN delivery_actions r ON r.id=o.action_id WHERE r.resource=? AND o.state<>'closed'").get(b.url))return false;
  return true;
 }
 reader(task){return this.io.reader?this.io.reader(task):new DeliveryGitRead({binding:this.binding(task),drained:()=>this.drained(task)});}
 push(task){
  if(!this.pushEnabled)fail('PUSH_DISABLED');
  if(!this.pushEngines.has(task))this.pushEngines.set(task,this.io.push?this.io.push(task):new DeliveryPush({journal:this.journal,binding:this.binding(task),
   provider:this.g.repositories.provider,credentials:this.c.push,receipts:this.processReceipts(),enabled:true,externalDrained:()=>this.drained(task),now:this.g.now}));
  return this.pushEngines.get(task);
 }
 stagePush(node,a){
  this.assertOpen();if(!this.pushEnabled)fail('PUSH_DISABLED');
  if(!['local','cloud'].includes(node)||!fields(a,['task_id','commit_action_id','event_id'])||!event(a.event_id)||!identifier(a.task_id)||!/^delivery-[a-f0-9-]{36}$/.test(a.commit_action_id??''))fail('INVALID_PUSH_STAGE');
  const event_id='runtime:'+node+':'+a.event_id,old=this.g.store.db.prepare('SELECT snapshot FROM delivery_push_plans WHERE event_id=?').get(event_id);
  if(old){const value=JSON.parse(old.snapshot),s=this.pushApproval.stored(a.task_id,value.id,value.fingerprint);
   if(s.intent.plan.source_action_id!==a.commit_action_id)fail('EVENT_CONFLICT');return {reference:this.pushApproval.reference(s),replayed:true,remote_checked_now:false,grants_execution:false};}
  if(this.preparations.has(a.task_id))fail('PUSH_PREPARATION_BUSY');
  const controller=new AbortController(),entry={controller,promise:null};this.preparations.set(a.task_id,entry);
  entry.promise=Promise.resolve().then(async()=>{
   this.assertOpen();const source=this.pushApproval.source(a.task_id,a.commit_action_id),engine=this.push(a.task_id);
   const compile=expected_remote_oid=>compilePush({source_action_id:source.row.id,commit_intent:source.intent,commit_result:source.result,repository_id:source.repository.repository_id,expected_remote_oid});
   const input={task_id:a.task_id,resource:source.intent.resource,workspace_identity:source.intent.workspace_identity,plan:compile(null)};
   input.plan=compile(await engine.remoteBaseline(this.journal.prepare(input),{signal:controller.signal}));
   await engine.preflight(this.journal.prepare(input),{signal:controller.signal});this.assertOpen();
   return {...this.pushApproval.stage({...input,event_id}),remote_checked_now:true};
  }).finally(()=>this.preparations.delete(a.task_id));return entry.promise;
 }
 schedulePush(node,a){
  this.assertOpen();if(!this.pushExecutionEnabled)fail('PUSH_EXECUTION_DISABLED');
  if(!['local','cloud'].includes(node)||!fields(a,['task_id','approval_id','event_id'])||!event(a.event_id)||!identifier(a.task_id)||!identifier(a.approval_id))fail('INVALID_PUSH_SCHEDULE');
  const r=this.g.approvals.row(a.approval_id),plan=JSON.parse(r.proposal).delivery;
  if(r.task_id!==a.task_id||plan?.kind!=='push-execution-v1')fail('PUSH_APPROVAL_REQUIRED');
  const s=this.pushApproval.stored(a.task_id,plan.plan_id,plan.fingerprint),i=s.intent;
  if(canonical(this.binding(a.task_id))!==canonical({root:i.workspace_identity.root,url:i.resource,branch:i.plan.branch,base_sha:i.plan.parent_oid}))fail('BINDING_CHANGED');
  return {action:this.journal.enqueue({...i,approval_id:a.approval_id,event_id:'runtime:'+node+':'+a.event_id}),execution:'queued_or_recorded',grants_execution:false};
 }
 stage(node,a){
  this.assertOpen();
  if(!['local','cloud'].includes(node)||!fields(a,['task_id','preview_id','fingerprint','commit_message','event_id'])||!event(a.event_id)||
   !identifier(a.task_id)||!/^delivery-[a-f0-9-]{36}$/.test(a.preview_id??'')||!/^[a-f0-9]{64}$/.test(a.fingerprint??'')||
   typeof a.commit_message!=='string'||!a.commit_message.trim()||a.commit_message.length>2000||/[\x00-\x09\x0b-\x1f\x7f]/.test(a.commit_message))fail('INVALID_STAGE');
  const event_id='runtime:'+node+':'+a.event_id,db=this.g.store.db;
  const old=db.prepare('SELECT snapshot FROM delivery_approval_plans WHERE event_id=?').get(event_id);
  if(old){
   const value=JSON.parse(old.snapshot),s=this.approval.stored(a.task_id,value.id,value.fingerprint);
   if(s.preview_id!==a.preview_id||s.preview_fingerprint!==a.fingerprint||s.intent.plan.message!==(a.commit_message.endsWith('\n')?a.commit_message:a.commit_message+'\n'))fail('EVENT_CONFLICT');
   return {reference:this.approval.reference(s),replayed:true,filesystem_checked_now:false,grants_execution:false};
  }
  const p=this.g.delivery.stored(a.task_id,a.preview_id,a.fingerprint);this.g.delivery.checked(p);
  const reader=this.reader(a.task_id),compiled=reader.compile({parent:p.baseline_commit,branch:p.workspace_branch,
   changes:p.files.map(f=>({path:f.path,action:f.approved_action,before_sha256:f.before_sha256,after_sha256:f.after_sha256})),
   tested_content:{kind:p.tested_content.kind,sha256:p.tested_content.sha256},author:this.c.author,committer:this.c.committer,
   when:Math.floor(this.g.now()/1000),message:a.commit_message});
  return {...this.approval.stage({event_id,task_id:a.task_id,preview_id:a.preview_id,fingerprint:a.fingerprint,resource:p.repository.url,...compiled}),filesystem_checked_now:true};
 }
 schedule(node,a){
  this.assertOpen();if(!this.executionEnabled)fail('EXECUTION_DISABLED');
  if(!['local','cloud'].includes(node)||!fields(a,['task_id','approval_id','event_id'])||!event(a.event_id)||!identifier(a.task_id)||!identifier(a.approval_id))fail('INVALID_SCHEDULE');
  const r=this.g.approvals.row(a.approval_id),plan=JSON.parse(r.proposal).delivery;
  if(r.task_id!==a.task_id||plan?.kind!=='commit-execution-v1')fail('APPROVAL_REQUIRED');
  const s=this.approval.stored(a.task_id,plan.plan_id,plan.fingerprint),i=s.intent;
  if(canonical(this.binding(a.task_id))!==canonical({root:i.workspace_identity.root,url:i.resource,branch:i.plan.branch,base_sha:i.plan.parent}))fail('BINDING_CHANGED');
  // Exact stored objects, not a live workspace read: a busy task can safely queue.
  return {action:this.journal.enqueue({task_id:a.task_id,resource:i.resource,workspace_identity:i.workspace_identity,plan:i.plan,
   objects:this.approval.objects(s),approval_id:a.approval_id,event_id:'runtime:'+node+':'+a.event_id}),execution:'queued_or_recorded',grants_execution:false};
 }
 start(){
  if(this.started)return;if(this.closed||!this.exclusive())fail('EXCLUSIVE_OWNER_REQUIRED');
  this.journal.recover();this.started=true; // Active -> review only; no retry/unlock.
 }
 tick(){
  if(this.g.maintenance?.blocked||this.closed||!this.started||(!this.executionEnabled&&!this.pushExecutionEnabled)||this.pending||!this.exclusive())return;
  const select=this.g.store.db.prepare("SELECT id,seq FROM delivery_actions WHERE state='queued' AND seq>? ORDER BY seq LIMIT 50");
  let rows=select.all(this.scanAfter);if(!rows.length){this.scanAfter=0;rows=select.all(0);}
  for(const {id,seq} of rows){
   this.scanAfter=seq; // Bounded scan without starving unrelated tasks behind 50 busy rows.
   if(this.journal.waiting(id))continue;
   let claimed=false;
   try{
    const r=this.journal.row(id);
    const intent=this.journal.intent(r);
    if(intent.kind==='push-execution-intent-v1'){
     if(!this.pushExecutionEnabled||this.preparations.has(r.task_id)||!this.drained(r.task_id))continue;
     this.controller=new AbortController();const signal=this.controller.signal;
     this.pending=this.runPush(id,intent,signal).finally(()=>{this.pending=null;this.controller=null;});return;
    }
    if(!this.executionEnabled||this.preparations.has(r.task_id))continue;
    if(!this.drained(r.task_id))continue;
    const a=this.journal.acquire(id);if(!a.acquired)continue;claimed=true;
    const request=this.g.approvals.row(r.approval_id),p=JSON.parse(request.proposal).delivery;
    const s=this.approval.stored(r.task_id,p.plan_id,p.fingerprint),objects=this.approval.objects(s),binding=this.binding(r.task_id);
    const executor=this.io.commit?this.io.commit(r.task_id):new DeliveryCommit({journal:this.journal,binding,enabled:true,externalDrained:()=>this.drained(r.task_id)});
    this.controller=new AbortController();
    this.pending=Promise.resolve().then(()=>executor.execute(id,a.epoch,objects,{signal:this.controller.signal})).catch(()=>{
     this.journal.recordFailure(id,a.epoch);
    }).catch(()=>{/* Lost ownership retains the old fence; never repair implicitly. */}).finally(()=>{this.pending=null;this.controller=null;});
    return;
   }catch{
    if(claimed){try{this.journal.recordFailure(id,this.journal.row(id).epoch);}catch{}}
    else this.journal.cancelQueued(id,'superseded'); // No silent retry after admission failure.
   }
  }
 }
 async runPush(id,intent,signal){
  let epoch;
  try{
   const executor=this.push(intent.task_id);await executor.preflight(intent,{signal});
   this.assertOpen();if(signal.aborted)fail('ABORTED');
   const a=this.journal.acquire(id);if(!a.acquired)return;epoch=a.epoch;
   await executor.execute(id,epoch,{signal});
  }catch{
   if(epoch!==undefined){try{this.journal.recordFailure(id,epoch);}catch{}}
   else if(!this.closed){try{this.journal.cancelQueued(id,'preflight_failed');}catch{}} // No send; never loop an unavailable preflight.
  }
 }
 recovery(task){
  this.assertOpen();
  return new DeliveryRecovery({journal:this.journal,binding:this.binding(task),enabled:true,quiescent:()=>!this.pending&&this.drained(task)});
 }
 processReceipts(){
  if(!this.pushEnabled)fail('PUSH_DISABLED');
  this.receipts??=new DeliveryProcessReceipts({journal:this.journal,directory:join(realpathSync(this.g.c.stateDir),'delivery-process-receipts'),enabled:true});return this.receipts;
 }
 pushRecovery(task){
  this.assertOpen();
  return new DeliveryPushRecovery({journal:this.journal,receipts:this.processReceipts(),executor:this.push(task),enabled:true,
   quiescent:()=>!this.pending&&!this.preparations.size&&this.exclusive()&&!this.closed});
 }
 async close(){this.closed=true;this.controller?.abort();for(const p of this.preparations.values())p.controller.abort();await Promise.allSettled([this.pending,...[...this.preparations.values()].map(p=>p.promise)]);}
}
