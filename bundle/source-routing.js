// Durable source -> Input/policy task seam. No platform client, IM consumer or task DB.
import {createHash} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {sourceAssessor,validateAssessment,SOURCE_RULES} from './source-assessment.js';
import {makePolicyEnvelope} from './source-policy-envelope.js';
import {CLOUD_TASK_POLICY} from './managed-cloud-policy.js';
import {executionSpec} from './managed-execution.js';
import {resolveManagedModel} from './managed-runtime.js';
import {validPolicy} from './task-context.js';
const json=JSON.stringify,hash=x=>createHash('sha256').update(typeof x==='string'?x:json(x)).digest('hex');
const fail=s=>{throw Error('SOURCE_ROUTING_'+s);};
const text=(s,n=256)=>typeof s==='string'&&s.trim().length>0&&s.length<=n&&!s.includes('\0');
const key=s=>text(s,80)&&/^[a-zA-Z0-9][\w.-]*$/.test(s);
const atomic=(db,f)=>{if(db.isTransaction)return f();db.exec('BEGIN IMMEDIATE');try{const r=f();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}};
export async function boundedAssessment(run,signal){
 signal.throwIfAborted();let abort;const stop=new Promise((_,reject)=>{abort=()=>reject(Error('SOURCE_ASSESSMENT_ABORTED'));signal.addEventListener('abort',abort,{once:true});});
 try{return await Promise.race([Promise.resolve().then(run),stop]);}finally{signal.removeEventListener('abort',abort);}
}
export const sourceThread=(source,thread)=>'source-thread:'+hash([source,thread]);
export class SourceRouting {
 constructor(g,{assess=sourceAssessor(g)}={}){
  this.g=g;this.db=g.store.db;this.assess=assess;this.closed=false;this.pending=null;this.controller=new AbortController();
  this.db.exec(`CREATE TABLE IF NOT EXISTS source_routing_settings(id TEXT PRIMARY KEY,record TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS source_routing_sources(id TEXT PRIMARY KEY,enabled INTEGER NOT NULL,revision INTEGER NOT NULL,cut_seq INTEGER NOT NULL,cursor INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS source_routing_policies(id TEXT,revision INTEGER,period_id TEXT,record TEXT,revoked INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(id,revision));
   CREATE TABLE IF NOT EXISTS source_routing_periods(policy_id TEXT,period_id TEXT,max_tasks INTEGER NOT NULL,PRIMARY KEY(policy_id,period_id));
   CREATE TABLE IF NOT EXISTS source_routing_events(id TEXT PRIMARY KEY,source_id TEXT NOT NULL,seq INTEGER NOT NULL,thread_key TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,result TEXT);
   CREATE INDEX IF NOT EXISTS source_routing_events_page ON source_routing_events(source_id,seq);
   CREATE TABLE IF NOT EXISTS source_routing_tasks(task_id TEXT PRIMARY KEY,event_id TEXT UNIQUE,policy_id TEXT,revision INTEGER,period_id TEXT,released INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS source_routing_operations(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL);`);
  this.db.prepare("INSERT OR IGNORE INTO source_routing_settings VALUES ('mode',?)").run(json({mode:'off',version:0}));
 }
 configs(){const all=this.g.c.sourceIntake?.sources??[];if(!Array.isArray(all)||all.length>128)fail('CONFIG_INVALID');return all;}
 base(id){const found=this.configs().filter(s=>s.id===id);if(found.length!==1)fail('SOURCE_UNBOUND');return found[0];}
 config(base){const row=this.db.prepare('SELECT * FROM source_routing_sources WHERE id=?').get(base.id);return row?{...base,enabled:base.enabled&&!!row.enabled,revision:base.revision+':routing-'+row.revision}:base;}
 mode(){return JSON.parse(this.db.prepare("SELECT record FROM source_routing_settings WHERE id='mode'").get().record);}
 high(id){return this.g.db.prepare("SELECT 1 FROM sqlite_master WHERE name='source_intake_events'").get()?this.g.db.prepare('SELECT coalesce(max(seq),0) n FROM source_intake_events WHERE source_id=?').get(id).n:0;}
 sourceRow(id){let row=this.db.prepare('SELECT * FROM source_routing_sources WHERE id=?').get(id);if(!row){const b=this.base(id);this.db.prepare('INSERT INTO source_routing_sources VALUES (?,?,0,0,0)').run(id,b.enabled?1:0);row=this.db.prepare('SELECT * FROM source_routing_sources WHERE id=?').get(id);}return row;}
 assertSource(id){const c=this.config(this.base(id));if(this.closed||this.g.closed||!c.enabled||this.g.c.sourceIntake?.enabled!==true)fail('SOURCE_DISABLED');return c;}
 // Trusted assembly alone may bind a transport. No RPC or model tool exposes this port.
 adapter(id,adapterId){const c=this.base(id);if(c.adapterId!==adapterId)fail('SOURCE_UNBOUND');const p=this.g.sourceIntake.bind(id,adapterId);return Object.freeze({receiveBatch:b=>p.receiveBatch(b),status:()=>({...p.status(),currentConfigRevision:this.config(c).revision})});}
 latest(id){const r=this.db.prepare('SELECT * FROM source_routing_policies WHERE id=? ORDER BY revision DESC LIMIT 1').get(id);return r?{...JSON.parse(r.record),revoked:!!r.revoked}:null;}
 policies(){return this.db.prepare('SELECT DISTINCT id FROM source_routing_policies ORDER BY id').all().map(r=>this.latest(r.id));}
 used(id,period){return this.db.prepare('SELECT count(*) n FROM source_routing_tasks WHERE policy_id=? AND period_id=?').get(id,period).n;}
 policyRecord(p,source,old,action){
  if(!p||Object.keys(p).some(k=>!['id','period_id','source_id','scope','goal','rules','bots','cwd','delivery','model_policy','max_tasks','end_at','development'].includes(k))||
   !key(p.id)||!key(p.period_id)||!text(p.source_id)||!text(p.scope)||!text(p.goal,2000)||!text(p.delivery,2000)||
   !Array.isArray(p.rules)||!p.rules.length||p.rules.length>2||new Set(p.rules).size!==p.rules.length||p.rules.some(x=>!Object.hasOwn(SOURCE_RULES,x))||
   !Number.isSafeInteger(p.max_tasks)||p.max_tasks<1||p.end_at!==undefined&&(!Number.isSafeInteger(p.end_at)||p.end_at<=this.g.now())||
   p.bots!==undefined&&(!Array.isArray(p.bots)||p.bots.length>64||p.bots.some(x=>!text(x))))fail('POLICY_INVALID');
  const b=this.base(p.source_id);if(!b.scopes.includes(p.scope))fail('POLICY_SCOPE_INVALID');
  if(old&&action!=='new_period'&&old.period_id!==p.period_id||old&&action==='new_period'&&this.db.prepare('SELECT 1 FROM source_routing_periods WHERE policy_id=? AND period_id=?').get(p.id,p.period_id))fail('PERIOD_CONFLICT');
  if(p.max_tasks<this.used(p.id,p.period_id))fail('TOTAL_BELOW_USED');
  const cwd=realpathSync(p.cwd),spec=executionSpec({role:'cloud',cwd,execution_policy:CLOUD_TASK_POLICY,...(p.end_at?{end_at:p.end_at}:{}),...(p.development?{development:p.development}:{})});
  if(p.model_policy)validPolicy(p.model_policy);
  if(this.policies().some(x=>x.id!==p.id&&!x.revoked&&x.source_id===p.source_id&&x.scope===p.scope))fail('POLICY_OVERLAP');
  return {...p,cwd,spec,bots:p.bots??[],revision:(old?.revision??0)+1,confirmation:source};
 }
 cut(){for(const c of this.configs()){this.sourceRow(c.id);this.db.prepare('UPDATE source_routing_sources SET cut_seq=? WHERE id=?').run(this.high(c.id),c.id);}}
 control(node,a){
  if(!a||Object.keys(a).some(k=>!['action','source','expected_version','expected_revision','mode','source_id','enabled','policy','policy_id','accepted_effect','thread_id','task_ids','link_mode','task_id'].includes(k)))fail('CONTROL_INVALID');
  const source=this.g.continuity.source(node,a.source),target=a.policy?.id??a.policy_id??a.source_id??a.task_id??'global';
  const id='source-control:'+hash([source.role,source.session_id,source.message_id,a.action,target]),fp=hash(a);
  const out=atomic(this.db,()=>{
   const saved=this.db.prepare('SELECT * FROM source_routing_operations WHERE id=?').get(id);if(saved){if(saved.fingerprint!==fp)fail('CONTROL_CONFLICT');return {...JSON.parse(saved.result),historical_receipt:true};}
   let result;
   if(a.action==='mode'){
    const old=this.mode();if(old.version!==a.expected_version||!['off','observe','auto'].includes(a.mode))fail('CONTROL_CONFLICT');
    if(a.mode==='auto'&&!this.policies().some(p=>!p.revoked&&(!p.end_at||p.end_at>this.g.now())&&this.used(p.id,p.period_id)<p.max_tasks))fail('POLICY_REQUIRED');
    this.cut();this.db.prepare("UPDATE source_routing_settings SET record=? WHERE id='mode'").run(json({mode:a.mode,version:old.version+1}));result=this.mode();
   }else if(a.action==='source'){
    const row=this.sourceRow(a.source_id);if(row.revision!==a.expected_revision||typeof a.enabled!=='boolean')fail('CONTROL_CONFLICT');
    this.db.prepare('UPDATE source_routing_sources SET enabled=?,revision=revision+1,cut_seq=?,cursor=max(cursor,?) WHERE id=?').run(a.enabled?1:0,this.high(a.source_id),this.high(a.source_id),a.source_id);
    this.db.prepare("UPDATE source_routing_events SET status='ignored',result=? WHERE source_id=? AND status IN ('pending','unavailable')").run(json({reason:'source-cutover-no-backlog-replay'}),a.source_id);
    result={source_id:a.source_id,enabled:a.enabled,revision:row.revision+1,scope:'this-source-binding-not-native-im'};
   }else if(['set_policy','new_period'].includes(a.action)){
    const old=this.latest(a.policy?.id);if((old?.revision??0)!==a.expected_revision||old&&!['keep_accepted','revoke_accepted'].includes(a.accepted_effect))fail('CONTROL_CONFLICT');
    const p=this.policyRecord(a.policy,source,old,a.action);
    if(old&&a.accepted_effect==='revoke_accepted')this.revoke(p.id);
    this.db.prepare('INSERT INTO source_routing_policies VALUES (?,?,?,?,0)').run(p.id,p.revision,p.period_id,json(p));
    this.db.prepare('INSERT INTO source_routing_periods VALUES (?,?,?) ON CONFLICT(policy_id,period_id) DO UPDATE SET max_tasks=excluded.max_tasks').run(p.id,p.period_id,p.max_tasks);
    // Config edits never replay already judged candidates; pending results recheck revision.
    result={policy_id:p.id,revision:p.revision,period_id:p.period_id,used:this.used(p.id,p.period_id),max_tasks:p.max_tasks};
   }else if(a.action==='revoke'){
    const p=this.latest(a.policy_id);if(!p||p.revision!==a.expected_revision)fail('CONTROL_CONFLICT');this.revoke(p.id);result={policy_id:p.id,revoked:true};
   }else if(a.action==='attach'){
    this.base(a.source_id);if(!text(a.thread_id)||!['reference','follow'].includes(a.link_mode))fail('CONTROL_INVALID');
    const ids=this.g.continuity.selected(a.task_ids),thread=sourceThread(a.source_id,a.thread_id);
    for(const task of ids)this.db.prepare('INSERT INTO task_input_links VALUES (?,?,?,0,1) ON CONFLICT(thread_key,task_id) DO UPDATE SET mode=excluded.mode,active=1').run(thread,task,a.link_mode);
    result={thread_key:thread,task_ids:ids,mode:a.link_mode,history_replayed:false};
   }else if(a.action==='adopt_task'){
    // Explicit user takeover removes this one policy dependency, never resumes a stopped task.
    const r=this.db.prepare('SELECT * FROM source_routing_tasks WHERE task_id=?').get(a.task_id),e=this.g.execution.get(a.task_id);
    if(!r||!e||this.g.catalog.head(a.task_id).spec_revision!==a.expected_revision)fail('CONTROL_CONFLICT');
    this.g.assertTaskQuiescent(a.task_id);if(this.g.continuity.state(a.task_id).state==='stopped')fail('TASK_STOPPED');
    this.db.prepare('UPDATE source_routing_tasks SET released=1 WHERE task_id=?').run(a.task_id);
    const authority={...JSON.parse(e.authority),kind:'direct-user-task',adoption:source};
    this.db.prepare('UPDATE managed_executions SET authority=? WHERE task_id=?').run(json(authority),a.task_id);result={task_id:a.task_id,authority:'direct-user-task',resumed:false};
   }else fail('CONTROL_INVALID');
   const receipt={...result,recorded:true,operation_id:id,source,execution_started:false};this.db.prepare('INSERT INTO source_routing_operations VALUES (?,?,?)').run(id,fp,json(receipt));return receipt;
  });
  this.reconcileRevocations();return {...out,effect:this.effect()};
 }
 revoke(id){this.db.prepare('UPDATE source_routing_policies SET revoked=1 WHERE id=?').run(id);}
 assertTask(id,{required=false}={}){
  const r=this.db.prepare('SELECT * FROM source_routing_tasks WHERE task_id=?').get(id);if(!r){if(required)fail('POLICY_REQUIRED');return;}if(r.released)return;
  const p=this.db.prepare('SELECT * FROM source_routing_policies WHERE id=? AND revision=?').get(r.policy_id,r.revision);
  if(!p||p.revoked)fail('POLICY_REVOKED');const record=JSON.parse(p.record);if(record.end_at&&record.end_at<=this.g.now())fail('BUSINESS_DEADLINE');return record;
 }
 reconcileRevocations(){
  for(const row of this.db.prepare('SELECT * FROM source_routing_tasks WHERE released=0').all()){
   try{this.assertTask(row.task_id);}catch(e){
    if(this.g.continuity.state(row.task_id).state!=='active')continue;
    // Use the same programmatic fence/drain as lifecycle; no forged human control.
    this.g.execution.control(row.task_id,'pause');
    this.db.prepare("UPDATE task_continuity SET state='paused',version=version+1,control_id=NULL,targets='[]' WHERE task_id=?").run(row.task_id);
    this.db.prepare('UPDATE managed_executions SET error=? WHERE task_id=?').run(e.message,row.task_id);
   }
  }
 }
 effect(){const items=this.db.prepare('SELECT task_id FROM source_routing_tasks WHERE released=0').all().flatMap(r=>{try{this.assertTask(r.task_id);return [];}catch{return [{task_id:r.task_id,status:this.g.execution.busy(r.task_id)?'draining-or-endpoint-unconfirmed':'effective'}];}});return {items,status:items.some(x=>x.status!=='effective')?'draining-or-endpoint-unconfirmed':'effective',external_effects_recalled:false};}
 status({after=0,limit=30}={}){
  if(!Number.isSafeInteger(after)||after<0||!Number.isInteger(limit)||limit<1||limit>50)fail('PAGE_INVALID');
  const sources=this.configs().map(c=>{const row=this.db.prepare('SELECT * FROM source_routing_sources WHERE id=?').get(c.id);let state;try{state=this.g.sourceIntake.bind(c.id,c.adapterId).status();}catch(e){state={lastError:e.message};}return {id:c.id,scopes:c.scopes,enabled:this.config(c).enabled&&this.g.c.sourceIntake?.enabled===true,revision:row?.revision??0,transport:'not-attached',...state,...this.g.sourceTransports?.status(c.id)};});
  const decisions=this.db.prepare('SELECT id,source_id,seq,thread_key,status,attempts,result FROM source_routing_events ORDER BY rowid LIMIT ? OFFSET ?').all(limit+1,after);
  return {available:true,authority:'cloud',mode:this.mode(),sources,policies:this.policies().map(p=>({id:p.id,revision:p.revision,source_id:p.source_id,scope:p.scope,goal:p.goal,rules:p.rules,delivery:p.delivery,period_id:p.period_id,used:this.used(p.id,p.period_id),max_tasks:this.db.prepare('SELECT max_tasks FROM source_routing_periods WHERE policy_id=? AND period_id=?').get(p.id,p.period_id).max_tasks,end_at:p.end_at??null,model_policy:p.model_policy??null,revoked:p.revoked})),decisions:decisions.slice(0,limit).map(r=>({...r,result:r.result?JSON.parse(r.result):null})),next_cursor:decisions.length>limit?after+limit:null,effect:this.effect(),live_source_verified:sources.some(s=>s.enabled&&s.live_verified===true&&!s.last_poll_error)};
 }
 ingest(){
  for(const base of this.configs()){
   const c=this.config(base);if(!c.enabled||this.g.c.sourceIntake?.enabled!==true)continue;
   const row=this.sourceRow(c.id),page=this.g.sourceIntake.bind(c.id,c.adapterId).read({after:row.cursor,limit:50});
   atomic(this.db,()=>{
    for(const e of page.events){if(e.disposition!=='stored')continue;
     const id='source-event:'+hash([e.sourceId,e.namespace,e.id]),thread=sourceThread(e.sourceId,e.event.thread.id);
     this.db.prepare("INSERT OR IGNORE INTO source_routing_events(id,source_id,seq,thread_key,payload,status) VALUES (?,?,?,?,?,'pending')").run(id,c.id,e.seq,thread,json(e));
    }
    this.db.prepare('UPDATE source_routing_sources SET cursor=? WHERE id=?').run(page.after,c.id);
   });
  }
 }
 finish(id,status,result){this.db.prepare('UPDATE source_routing_events SET status=?,result=? WHERE id=?').run(status,json(result),id);}
 fanout(row,e){
  const links=this.db.prepare('SELECT * FROM task_input_links WHERE thread_key=? AND active=1').all(row.thread_key);
  let owned=false;
  for(const l of links){
   if(!this.g.continuity.canRun(l.task_id))continue;
   const er=this.g.execution.get(l.task_id);if(!er)continue;
   const alive=['claimed','running','queued','waiting','waiting_input','scheduled'].includes(er.state);
   // Reference and bot/CI data never wake an ended task. Human != trusted owner.
   if(!alive&&(l.mode!=='follow'||e.actor.kind!=='human'))continue;
   const prior=this.db.prepare('SELECT * FROM task_inputs WHERE event_id=? AND task_id=?').get(row.id,l.task_id);
   if(prior?.state==='handed_back')continue;
   this.g.continuity.receiveSource({id:row.id,thread:row.thread_key,source_id:row.source_id,event:e,task:l.task_id,mode:l.mode});
   if(l.mode==='follow')owned=true;
  }
  return owned;
 }
 eligible(row,e){
  const c=this.assertSource(row.source_id),sr=this.sourceRow(c.id),mode=this.mode();
  if(this.db.prepare("SELECT 1 FROM task_input_links l JOIN task_continuity t ON t.task_id=l.task_id WHERE l.thread_key=? AND l.active=1 AND l.mode='follow' AND t.state<>'active'").get(row.thread_key))return {reason:'thread-owner-paused-or-stopped'};
  if(row.seq<=sr.cut_seq)return {reason:'cutover-no-backlog-replay'};
  if(mode.mode==='off')return {reason:'proactive-off'};
  const p=this.policies().find(p=>!p.revoked&&p.source_id===c.id&&p.scope===e.scope);
  if(!p)return {reason:'no-policy'};
  if(p.end_at&&p.end_at<=this.g.now())return {reason:'business-deadline'};
  const maximum=this.db.prepare('SELECT max_tasks FROM source_routing_periods WHERE policy_id=? AND period_id=?').get(p.id,p.period_id).max_tasks;
  if(mode.mode==='auto'&&this.used(p.id,p.period_id)>=maximum)return {reason:'new-task-total-reached'};
  if(e.actor.kind==='unknown'||e.actor.kind==='bot'&&!p.bots.includes(e.actor.id))return {reason:'source-actor-not-eligible'};
  return {policy:p,mode,stamp:hash([p.revision,mode.version,c.revision])};
 }
 async process(row){
  const e=JSON.parse(row.payload).event,c=this.assertSource(row.source_id);
  if(!c.scopes.includes(e.scope)){this.finish(row.id,'ignored',{reason:'scope-removed'});return;}
  if(this.fanout(row,e)){this.finish(row.id,'owned',{reason:'existing-task-input'});return;}
  const gate=this.eligible(row,e);if(!gate.policy){this.finish(row.id,'ignored',{reason:gate.reason});return;}
  if(row.status==='unavailable'&&row.attempts>=3)return;
  const controller=this.controller;
  this.db.prepare("UPDATE source_routing_events SET attempts=attempts+1,next_at=? WHERE id=?").run(this.g.now()+5000,row.id);
  let decision;
  try{const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(45000)]);
   // Technical timeout only: no task lifetime or model-call allowance.
   decision=await boundedAssessment(()=>this.assess({event:e,policy:gate.policy,signal}),signal);validateAssessment(decision.assessment,gate.policy.rules,e);}
  catch(err){if(!this.closed)this.finish(row.id,'unavailable',{reason:/^SOURCE_[A-Z_]+$/.test(err.message)?err.message:'SOURCE_ASSESSMENT_UNAVAILABLE'});return;}
  if(this.closed||this.g.closed||this.g.maintenance.blocked)return;
  const current=this.eligible(row,e);
  if(current.stamp!==gate.stamp){if(current.policy)this.finish(row.id,'pending',{reason:'policy-changed'});else this.finish(row.id,'ignored',{reason:current.reason});return;}
  const a=decision.assessment,record={assessment:a,policy_id:gate.policy.id,policy_revision:gate.policy.revision,model:decision.model??null,usage:decision.usage??null};
  if(a.decision!=='accept'){this.finish(row.id,a.decision==='ignore'?'ignored':'unavailable',record);return;}
  if(gate.mode.mode==='observe'){this.finish(row.id,'observed',{...record,would_accept:true});return;}
  const model=await resolveManagedModel(this.g.ctx,gate.policy.model_policy,this.g.c.managedExecution.defaultModel);
  atomic(this.db,()=>{
   const fresh=this.eligible(row,e);if(fresh.stamp!==gate.stamp)fail('POLICY_CHANGED');
   if(this.fanout(row,e)){this.finish(row.id,'owned',{reason:'existing-task-input'});return;}
   const old=this.db.prepare('SELECT task_id FROM source_routing_tasks WHERE event_id=?').get(row.id);if(old){this.finish(row.id,'accepted',{...record,task_id:old.task_id});return;}
   const envelope=makePolicyEnvelope({policy:gate.policy,event_key:row.id,thread_key:row.thread_key,event:e,title:a.title,goal:a.goal,model});
   const task=this.g.store.accept('cloud',{task_key:'source-'+hash(row.id).slice(0,40),ingress_id:row.id,source:'confirmed-policy',goal:json(envelope)},t=>{
    this.g.catalog.ensure(t.id);this.g.continuity.registerPolicy(t,envelope);
    this.db.prepare('INSERT INTO source_routing_tasks VALUES (?,?,?,?,?,0)').run(t.id,row.id,gate.policy.id,gate.policy.revision,gate.policy.period_id);
   },{withinTransaction:true});
   this.g.execution.start({task_id:task.id,expected_revision:1,spec:gate.policy.spec,policy:model});
   this.finish(row.id,'accepted',{...record,task_id:task.id});
  });
 }
 tick(){
  if(this.closed||this.g.closed||this.g.maintenance.blocked)return Promise.resolve();if(this.pending)return this.pending;
  this.pending=this.g.maintenance.run('source_routing',()=>this.run()).finally(()=>{this.pending=null;});return this.pending;
 }
 async run(){
  this.reconcileRevocations();this.ingest();
  // Owned events are revisited only after every responsible task handed them back.
  for(const r of this.db.prepare("SELECT * FROM source_routing_events WHERE status='owned'").all())if(!this.db.prepare("SELECT 1 FROM task_inputs WHERE event_id=? AND mode='follow' AND state<>'handed_back'").get(r.id))this.finish(r.id,'pending',{reason:'all-owners-handed-back'});
  const rows=this.db.prepare("SELECT * FROM source_routing_events WHERE status IN ('pending','unavailable') AND next_at<=? AND attempts<3 ORDER BY rowid LIMIT 16").all(this.g.now());
  for(const row of rows){if(this.closed||this.g.maintenance.blocked)return;
   try{await this.process(row);}catch(e){this.db.prepare('UPDATE source_routing_events SET attempts=attempts+1,next_at=? WHERE id=?').run(this.g.now()+5000,row.id);this.finish(row.id,'unavailable',{reason:/^(SOURCE_|TASK_)[A-Z_]+$/.test(e.message)?e.message:'SOURCE_ROUTING_UNAVAILABLE'});}
  }
 }
 close(){this.closed=true;this.controller.abort();return this.pending??Promise.resolve();}
}
