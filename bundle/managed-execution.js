import {ManagedTriggers} from './managed-triggers.js';
import {CLOUD_TASK_POLICY,autonomous} from './managed-cloud-policy.js';
import {parseEnvelope} from './task-envelope.js';
import {developmentContract,legacyResourceBusy} from './managed-development-contract.js';
import {repositoryResources} from './managed-development.js';
// One cloud authority for native long-running work. Legacy local records are retained, not dispatched.
// Existing authenticated DirectLink transports this protocol. IM is not an authority.
import {ManagedSlots,ManagedBudget} from './managed-runtime.js';
import {tx} from './recovery.js';
import {isAbsolute,normalize} from 'node:path';
const json=JSON.stringify;
const atomic=(db,fn)=>db.isTransaction?fn():tx(db,fn);
const fail=s=>{throw Error('TASK_EXECUTION_'+s);};
export function executionSpec(x){
 if(!x||Object.keys(x).some(k=>!['execution_policy','end_at','schedule','role','cwd','max_requests','active_timeout_ms','period_seconds','search','commands','development'].includes(k))||!['local','cloud'].includes(x.role)||typeof x.cwd!=='string'||!isAbsolute(x.cwd)||normalize(x.cwd)!==x.cwd||x.cwd.length>1000||x.cwd.includes('\0'))fail('SPEC_INVALID');
 const free=autonomous(x);if(x.schedule!==undefined&&(!free||x.period_seconds!==undefined||!x.schedule||typeof x.schedule!=='object'||Array.isArray(x.schedule)))fail('SCHEDULE_INVALID');if(x.execution_policy!==undefined&&!free||free&&x.role!=='cloud')fail('CLOUD_ONLY');
 if(free&&(x.max_requests!==undefined||x.active_timeout_ms!==undefined||x.commands!==undefined))fail('RETIRED_LIMIT');
 if(free&&x.end_at!==undefined&&(!Number.isSafeInteger(x.end_at)||x.end_at<=0))fail('LIMIT_INVALID');
 if(!free&&(!Number.isInteger(x.max_requests)||x.max_requests<1||x.max_requests>100000||!Number.isInteger(x.active_timeout_ms)||x.active_timeout_ms<1000||x.active_timeout_ms>86400000)||x.period_seconds!==undefined&&(!Number.isInteger(x.period_seconds)||x.period_seconds<60||x.period_seconds>366*86400))fail('LIMIT_INVALID');
 if(x.commands!==undefined&&(!Array.isArray(x.commands)||x.role!=='local'||x.commands.length<1||x.commands.length>8||new Set(x.commands).size!==x.commands.length||x.commands.some(n=>typeof n!=='string'||!/^[a-z][a-z0-9_-]{0,39}$/.test(n))))fail('COMMAND_CONTRACT_INVALID');
 if(x.search!==undefined){const s=x.search,p=s?.model_policy;if(!s||Object.keys(s).some(k=>!['scope','model_policy','max_requests'].includes(k))||typeof s.scope!=='string'||!s.scope.trim()||s.scope.length>1000||!p||Object.keys(p).some(k=>!['provider','model','reasoningEffort'].includes(k))||p.provider!=='deepseek-official'||typeof p.model!=='string'||!p.model.trim()||p.model.length>200||p.reasoningEffort!=='disabled'||(!free&&(!Number.isSafeInteger(s.max_requests)||s.max_requests<1||s.max_requests>x.max_requests))||free&&s.max_requests!==undefined)fail('SEARCH_CONTRACT_INVALID');}
 return {role:x.role,cwd:x.cwd,...(free?{execution_policy:CLOUD_TASK_POLICY,...(x.end_at!==undefined?{end_at:x.end_at}:{})}:{max_requests:x.max_requests,active_timeout_ms:x.active_timeout_ms}),...(x.schedule?{schedule:x.schedule}:{}),...(x.period_seconds?{period_seconds:x.period_seconds}:{}),...(x.search?{search:x.search}:{}),...(x.commands?{commands:x.commands}:{}),...(x.development!==undefined?{development:developmentContract(x.development,x.role)}:{})};
}
export class ManagedExecution {
 constructor(g){
  this.g=g;this.db=g.store.db;this.now=g.now;this.slots=new ManagedSlots(this.db,this.now,{localEnabled:false});this.budgets=new ManagedBudget(this.db,this.now);
  this.db.exec(`CREATE TABLE IF NOT EXISTS managed_development_evidence(task_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,record TEXT NOT NULL); CREATE TABLE IF NOT EXISTS managed_executions(task_id TEXT PRIMARY KEY,approval_id TEXT NOT NULL,
   revision INTEGER NOT NULL,role TEXT NOT NULL,spec TEXT NOT NULL,state TEXT NOT NULL,due INTEGER NOT NULL,
   human INTEGER NOT NULL DEFAULT 0,claim TEXT,instance TEXT,started INTEGER,lease_until INTEGER,
   session_id TEXT,report TEXT,error TEXT,parked_state TEXT,runs INTEGER NOT NULL DEFAULT 0,input_cursor INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS managed_execution_receipts(claim TEXT PRIMARY KEY,payload TEXT NOT NULL,result TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS managed_unstarted_reclaims(claim TEXT PRIMARY KEY,task_id TEXT NOT NULL,instance TEXT NOT NULL,role TEXT NOT NULL);`);
  if(!this.db.prepare('PRAGMA table_info(managed_executions)').all().some(x=>x.name==='authority'))this.db.exec('ALTER TABLE managed_executions ADD COLUMN authority TEXT');
  if(!this.db.prepare('PRAGMA table_info(managed_executions)').all().some(x=>x.name==='occurrence_id'))this.db.exec('ALTER TABLE managed_executions ADD COLUMN occurrence_id TEXT');
  this.schedules=new ManagedTriggers(this);
 }
 observed(id,baseline){try{this.g.observer?.changed(id,baseline);}catch{} /* Never block execution for observation failure. */}
 get(id){return this.db.prepare('SELECT * FROM managed_executions WHERE task_id=?').get(id);}
 busy(id){return !!this.db.prepare('SELECT 1 FROM managed_slots WHERE task_id=?').get(id);}
 owns(id){return !!this.get(id);}
 authority(r,{resuming=false}={}){
  if(!r)fail('NOT_FOUND');if(!resuming)this.g.continuity.assertActive(r.task_id);
  if(autonomous(JSON.parse(r.spec))){
   if(!r.authority||this.g.catalog.head(r.task_id).spec_revision!==r.revision)fail('AUTHORITY_CHANGED');
   const spec=JSON.parse(r.spec);if(spec.end_at&&this.now()>=spec.end_at)fail('BUSINESS_DEADLINE');
   this.g.sourceRouting?.assertTask(r.task_id,{required:JSON.parse(r.authority).kind==='proactive-policy'});
   return JSON.parse(r.authority);
  }
  const a=this.g.approvals.view(r.approval_id);
  if(a.state!=='approved'||a.spec_revision!==r.revision||json(a.proposal.execution)!==r.spec)fail('AUTHORITY_CHANGED');
  return a;
 }
 view(id){const r=this.get(id);if(!r)return null;return {task_id:id,role:r.role,state:r.state,due:r.due,report:r.report?JSON.parse(r.report):null,error:r.error,runs:r.runs,session_id:r.session_id,development:this.evidenceView(id),budget:this.budgets.view(id),filesystem:r.role==='cloud'?'host-account':'approved-local-workspace',slot_held:this.busy(id),schedules:this.schedules.list(id)};}
 evidenceView(id){const r=this.db.prepare('SELECT * FROM managed_development_evidence WHERE task_id=?').get(id);return r?{...JSON.parse(r.record),task_revision:r.revision,historical:r.revision!==this.g.catalog.head(id).spec_revision||JSON.parse(r.record).approval_id!==this.get(id)?.approval_id,checked_now:false}:null;}
 evidence(role,a){this.validate(role,a);const r=this.owned(role,a);if(!JSON.parse(r.spec).development||!a.evidence||a.evidence.schema!==1||Buffer.byteLength(json(a.evidence))>131072)fail('EVIDENCE_INVALID');this.db.prepare('INSERT OR REPLACE INTO managed_development_evidence VALUES (?,?,?)').run(r.task_id,r.revision,json({...a.evidence,approval_id:r.approval_id}));return {saved:true};}
 // Direct, durable user-task authority; approval_id='' is only a schema-compatible
 // absence marker. There is no synthetic approval or credential row.
 start({task_id,expected_revision,spec,policy}){
  const h=this.g.catalog.head(task_id),e=parseEnvelope(h.goal);
  if(!autonomous(e)||!this.g.continuity?.managed(task_id))fail('NATIVE_TASK_REQUIRED');
  if(h.spec_revision!==expected_revision)fail('REVISION_CHANGED');
  this.g.continuity.assertActive(task_id);spec=executionSpec(spec);
  if(!autonomous(spec)||spec.role!=='cloud')fail('CLOUD_ONLY');
  const old=this.get(task_id);
  const existingAuthority=old?.authority?JSON.parse(old.authority):null;
  if(e.origin.kind==='policy'){if(!this.g.sourceRouting)fail('AUTHORITY_CHANGED');this.g.sourceRouting.assertTask(task_id,{required:true});}
  const authority=json({kind:e.origin.kind==='policy'&&existingAuthority?.kind!=='direct-user-task'?'proactive-policy':'direct-user-task',model_policy:policy,origin:e.origin,...(existingAuthority?.adoption?{adoption:existingAuthority.adoption}:{})});
  if(old){
   if(!autonomous(JSON.parse(old.spec)))fail('LEGACY_CONTRACT_RETAINED');
   if(old.revision===expected_revision&&old.spec===json(spec)&&old.authority===authority)return this.view(task_id);
   if(old.role!==spec.role||JSON.parse(old.spec).cwd!==spec.cwd)fail('SESSION_BINDING_CHANGED');
  }
  this.g.assertTaskQuiescent(task_id);
  if(this.schedules.current(task_id)&&this.schedules.pending(this.schedules.current(task_id)))fail('SCHEDULE_OCCURRENCE_UNSETTLED');
  const plan=this.schedules.prepare(task_id,spec,old);
  atomic(this.db,()=>{
   this.budgets.bind(task_id,policy,{executionPolicy:CLOUD_TASK_POLICY,endAt:spec.end_at,search:spec.search},{amend:!!old});
   if(old)this.db.prepare("UPDATE managed_executions SET revision=?,spec=?,authority=?,state='queued',due=?,error=NULL,parked_state=NULL WHERE task_id=?").run(expected_revision,json(spec),authority,this.now(),task_id);
   else this.db.prepare("INSERT INTO managed_executions(task_id,approval_id,revision,role,spec,authority,state,due) VALUES (?,'',?,'cloud',?,?,'queued',?)").run(task_id,expected_revision,json(spec),authority,this.now());
   this.schedules.bind(task_id,spec,plan);if(plan)this.db.prepare("UPDATE managed_executions SET state='scheduled',human=0 WHERE task_id=?").run(task_id);
  });this.observed(task_id,old?.runs??0);return this.view(task_id);
 }
 enqueue({task_id,approval_id}){
  if(!this.g.continuity?.managed(task_id))fail('NATIVE_TASK_REQUIRED');
  const existing=this.get(task_id);if(autonomous(parseEnvelope(this.g.catalog.head(task_id).goal)))fail('DIRECT_EXECUTION_REQUIRED');
  if(existing?.approval_id===approval_id)return this.view(task_id);
  this.g.continuity.assertActive(task_id);this.g.assertTaskQuiescent(task_id);
  const a=this.g.approvals.view(approval_id),e=a.proposal.execution;
  if(a.task_id!==task_id||a.state!=='approved'||!e||a.proposal.scopes.join()!=='develop')fail('APPROVAL_REQUIRED');
  if(existing&&(existing.role!==e.role||JSON.parse(existing.spec).cwd!==e.cwd))fail('SESSION_BINDING_CHANGED');
  tx(this.db,()=>{
   this.budgets.bind(task_id,a.proposal.model_policy,{maxRequests:e.max_requests,endAt:a.expires,search:e.search},{amend:!!existing});
   if(existing)this.db.prepare("UPDATE managed_executions SET approval_id=?,revision=?,spec=?,state='queued',due=?,human=0,error=NULL,parked_state=NULL WHERE task_id=?").run(approval_id,a.spec_revision,json(e),this.now(),task_id);
   else this.db.prepare("INSERT INTO managed_executions(task_id,approval_id,revision,role,spec,state,due) VALUES (?,?,?,?,?,'queued',?)").run(task_id,approval_id,a.spec_revision,e.role,json(e),this.now());
  });this.observed(task_id,existing?.runs??0);return this.view(task_id);
 }
 // Only persisted, direct human follow-input can earn the +1. New tasks never do.
 follow(id){
  const r=this.get(id);if(r&&JSON.parse(r.spec).schedule&&!this.schedules.followAllowed(r))return;if(!r||!['idle','waiting','waiting_input','queued'].includes(r.state)||!r.runs||!this.g.continuity.canRun(id))return;
  const pending=this.db.prepare("SELECT count(*) n,max(CASE WHEN json_extract(e.source,'$.kind') IS NULL THEN 1 ELSE 0 END) human FROM task_inputs i JOIN task_input_events e ON i.event_id=e.id WHERE i.task_id=? AND i.mode='follow' AND i.state='saved' AND i.seq>?").get(id,r.input_cursor);
  if(pending.n)this.db.prepare("UPDATE managed_executions SET state='queued',human=?,due=? WHERE task_id=?").run(pending.human?1:0,this.now(),id);
 }
 claim(role,{instance_id,development_contract,autonomy_contract}){
  if(role==='local')return {item:null,reason:'local-managed-execution-retired'};
  if(typeof instance_id!=='string'||!instance_id||instance_id.length>100)fail('INSTANCE_INVALID');
  return tx(this.db,()=>{
   this.reconcile();
   const ready=this.db.prepare("SELECT * FROM managed_executions WHERE role=? AND state IN ('queued','waiting') AND due<=? ORDER BY human DESC,due,task_id").all(role,this.now());
   for(const r of ready){
    if(autonomous(JSON.parse(r.spec))&&autonomy_contract!==1)continue;
    if(JSON.parse(r.spec).development&&development_contract!==1)continue;
    if(!this.schedules.canClaim(r))continue;
    try{this.authority(r);}catch(e){this.db.prepare("UPDATE managed_executions SET error=? WHERE task_id=?").run(e.message,r.task_id);continue;}
    // Until finer path-conflict evidence exists, one explicit working directory is
    // a cross-host resource key. It is a scheduling key, NOT a cloud file sandbox.
    const spec=JSON.parse(r.spec);let resources=['cwd:'+spec.cwd];
    if(spec.development){if(role==='cloud'){try{resources.push(...repositoryResources(spec.cwd,spec.development));}catch(e){if(spec.development.branch){this.db.prepare('UPDATE managed_executions SET error=? WHERE task_id=?').run(e.message,r.task_id);continue;}}}else if(role==='local')resources.push('local-managed-development');}
    if(legacyResourceBusy(this.db,resources))continue;
    const slot=this.slots.reserve({task_id:r.task_id,role,resources,humanFollowup:!!r.human});
    if(!slot.reserved)continue;
    this.db.prepare("UPDATE managed_executions SET state='claimed',claim=?,instance=?,lease_until=?,error=NULL WHERE task_id=?").run(slot.claim,instance_id,this.now()+30000,r.task_id);
    return {item:this.item(this.get(r.task_id))};
   }return {item:null};
  });
 }
 item(r){const a=r.authority?JSON.parse(r.authority):this.g.approvals.view(r.approval_id);return {...r,spec:JSON.parse(r.spec),policy:a.model_policy??a.proposal.model_policy,goal:this.g.catalog.head(r.task_id).goal,task_scope:r.authority?parseEnvelope(this.g.catalog.head(r.task_id).goal).entry_interpretation:a.proposal.changes,budget:this.budgets.view(r.task_id),trigger:this.schedules.context(r.occurrence_id)};}
 owned(role,a){const r=this.get(a.task_id);if(!r||r.role!==role||r.claim!==a.claim||r.instance!==a.instance_id)fail('CLAIM_DENIED');this.slots.assert(r.task_id,r.claim);return r;}
 validate(role,a){
  const r=this.owned(role,a);this.authority(r);
  if(!['claimed','running'].includes(r.state)||r.lease_until<=this.now())fail('LEASE_ENDED');
  if(r.started&&JSON.parse(r.spec).active_timeout_ms&&this.now()>=r.started+JSON.parse(r.spec).active_timeout_ms)fail('ACTIVE_LIMIT');
  this.db.prepare('UPDATE managed_executions SET lease_until=? WHERE task_id=?').run(this.now()+30000,r.task_id);
  try{this.g.observer?.capture(r,a.observation);}catch{} // Observability must not interrupt valid execution.
  return {valid:true,lease_ms:30000,control_version:this.g.continuity.state(r.task_id).version,task_id:r.task_id,input_cursor:r.input_cursor,pending_input:this.db.prepare("SELECT max(seq) seq FROM task_inputs WHERE task_id=? AND mode='follow' AND state='saved'").get(r.task_id).seq??null};
 }
 begin(role,a){
  this.validate(role,a);const r=this.owned(role,a);
  if(r.state==='running')return {item:this.item(r),already_started:true};
  this.db.prepare("UPDATE managed_executions SET state='running',started=?,human=0,runs=runs+1 WHERE task_id=?").run(this.now(),r.task_id);
  return {item:this.item(this.get(r.task_id)),already_started:false};
 }
 reserve(role,a){this.validate(role,a);const r=this.owned(role,a);if(r.state!=='running')fail('NOT_RUNNING');if(a.channel!==undefined&&a.channel!=='search')fail('BUDGET_CHANNEL_INVALID');return this.budgets.reserve(r.task_id,a.policy,a.purpose,{search:a.channel==='search'});}
 usage(role,a){this.owned(role,a);return this.budgets.usage(a.task_id,a.request_id,a.usage);}
 inputs(role,a){this.validate(role,a);const r=this.owned(role,a);if(r.authority&&(a.after??0)>r.input_cursor)fail('INPUT_CURSOR_GAP');const result=this.g.continuity.workerRead({task_id:r.task_id,run_id:r.claim,goal:this.g.catalog.head(r.task_id).goal},{after:a.after??0,limit:20});
  if(result.items.length)this.db.prepare('UPDATE managed_executions SET input_cursor=max(input_cursor,?) WHERE task_id=?').run(result.items.at(-1).seq,r.task_id);
  return result;
 }
 finish(role,a){
  const payload=json(a),old=this.db.prepare('SELECT * FROM managed_execution_receipts WHERE claim=?').get(a.claim);
  if(old){if(this.get(a.task_id)?.role!==role)fail('CLAIM_DENIED');if(old.payload!==payload)fail('RECEIPT_CONFLICT');return JSON.parse(old.result);}
  return tx(this.db,()=>{
   const reclaimed=this.db.prepare('SELECT * FROM managed_unstarted_reclaims WHERE claim=?').get(a.claim);
   if(reclaimed){
    if(reclaimed.role!==role||reclaimed.task_id!==a.task_id||reclaimed.instance!==a.instance_id)fail('CLAIM_DENIED');
    if(a.drained!==true||a.outcome!=='interrupted')fail('REPORT_INVALID');
    const result={recorded:true,state:'reclaimed_before_start',task_id:a.task_id};
    this.db.prepare('INSERT INTO managed_execution_receipts VALUES (?,?,?)').run(a.claim,payload,json(result));return result;
   }
   const r=this.owned(role,a);if(a.drained!==true)fail('DRAIN_REQUIRED');
   if(!(typeof a.session_id==='string'&&a.session_id.startsWith('managed-')||a.session_id===null&&['failed','interrupted'].includes(a.outcome)&&!r.session_id)||typeof a.summary!=='string'||!a.summary||a.summary.length>4000||!['ready','waiting','failed','stopped','interrupted'].includes(a.outcome))fail('REPORT_INVALID');
   if(a.error!==undefined&&(typeof a.error!=='string'||!/^([A-Z][A-Z_]{1,100})$/.test(a.error)))fail('REPORT_INVALID');
   if(r.session_id&&r.session_id!==a.session_id)fail('SESSION_CHANGED');
   let valid=true;try{this.authority(r);}catch{valid=false;}
   const spec=JSON.parse(r.spec);if(valid&&a.outcome==='ready'&&autonomous(spec))this.assertCompletion(r,a.completion);
   if(valid&&a.outcome==='ready'&&spec.development){const evidence=this.evidenceView(r.task_id),expected={workspace:'workspace_ready',commit:'commit_verified',push:'remote_commit_verified',pr:'pr_verified'}[spec.development.delivery];if(!evidence||evidence.historical||evidence.at<r.started||evidence.delivery?.mode!==spec.development.delivery||evidence.delivery?.state!==expected||evidence.checks?.some(c=>c.state!=='passed'))fail('DEVELOPMENT_EVIDENCE_REQUIRED');}
   const state=!valid?'fenced':a.outcome==='interrupted'?(spec.period_seconds?'waiting':'queued'):a.outcome==='failed'?'needs_review':a.outcome==='stopped'?'needs_review':a.outcome==='waiting'?'waiting_input':spec.schedule&&r.occurrence_id?'scheduled':spec.period_seconds?'waiting':'idle';
   // A late completion is retained, never used to revive stopped/revoked work.
   this.db.prepare('UPDATE managed_executions SET state=?,due=?,session_id=?,report=?,error=?,claim=NULL,instance=NULL,lease_until=NULL,started=NULL WHERE task_id=?').run(state,spec.period_seconds?this.now()+spec.period_seconds*1000:this.now(),a.session_id,json({outcome:a.outcome,summary:a.summary,at:this.now(),late:!valid,spec_revision:r.revision}),a.error??null,r.task_id);
   this.slots.release(r.task_id,r.claim,{drained:true});if(valid&&a.outcome==='ready')this.schedules.complete(r);this.follow(r.task_id);
   this.observed(r.task_id,Math.max(0,r.runs-1));
   const result={recorded:true,state:this.get(r.task_id).state,task_id:r.task_id};this.db.prepare('INSERT INTO managed_execution_receipts VALUES (?,?,?)').run(a.claim,payload,json(result));return result;
  });
 }
 // Only never-started expired claims are reclaimable. Running/unknown work keeps
 // its slot until its owning endpoint reports actual drain, even after reboot.
 reconcile(){this.schedules.tick();for(const r of this.db.prepare("SELECT * FROM managed_executions WHERE state='claimed' AND lease_until<=?").all(this.now()))atomic(this.db,()=>{this.db.prepare('INSERT INTO managed_unstarted_reclaims VALUES (?,?,?,?)').run(r.claim,r.task_id,r.instance,r.role);this.slots.release(r.task_id,r.claim,{drained:true});this.db.prepare("UPDATE managed_executions SET state='queued',claim=NULL,instance=NULL WHERE task_id=?").run(r.task_id);});
  for(const r of this.db.prepare("SELECT task_id FROM managed_executions WHERE state IN ('idle','waiting','waiting_input','queued')").all())this.follow(r.task_id);
 }
 assertResume(id){const r=this.get(id);if(!r)return;if(r.claim||this.busy(id))fail('NOT_QUIESCENT');this.authority(r,{resuming:true});if(!r.parked_state||!['queued','waiting','waiting_input','idle','scheduled'].includes(r.parked_state))fail('RESUME_NOT_READY');}
 control(id,action){
  const r=this.get(id);if(!r)return;this.observed(id,r.runs);this.schedules.control(id,action);
  if(action==='pause'){const periodic=JSON.parse(r.spec).period_seconds;const parked=['claimed','running','queued'].includes(r.state)?(periodic?'waiting':'queued'):r.state;this.db.prepare('UPDATE managed_executions SET parked_state=? WHERE task_id=?').run(parked,id);}
  if(action==='stop')this.db.prepare("UPDATE managed_executions SET parked_state=NULL,state=CASE WHEN claim IS NULL THEN 'fenced' ELSE state END WHERE task_id=?").run(id);
  if(action==='resume'&&r.parked_state){
   const period=JSON.parse(r.spec).period_seconds;this.authority(r);const valid=true;
   this.db.prepare('UPDATE managed_executions SET state=?,due=?,parked_state=NULL WHERE task_id=?').run(valid?r.parked_state:'fenced',r.parked_state==='waiting'&&period?this.now()+period*1000:this.now(),id);
   if(valid)this.follow(id);
  }
 }
 suspend(role,a){
  const done=this.db.prepare('SELECT payload FROM managed_execution_receipts WHERE claim=?').get(a.claim);
  if(done){const p=JSON.parse(done.payload);if(p.task_id!==a.task_id||p.instance_id!==a.instance_id||this.get(a.task_id)?.role!==role)fail('CLAIM_DENIED');return {historical_receipt:true};}
  const r=this.owned(role,a);return atomic(this.db,()=>{
   const state=this.g.continuity.state(r.task_id);if(state.state==='active'){this.control(r.task_id,'pause');this.db.prepare("UPDATE task_continuity SET state='paused',version=version+1,control_id=NULL,targets='[]' WHERE task_id=?").run(r.task_id);this.db.prepare("UPDATE managed_executions SET error='TASK_EXECUTION_NATIVE_ARCHIVE_STOP' WHERE task_id=?").run(r.task_id);}
   return {paused:this.g.continuity.state(r.task_id).state==='paused',task_id:r.task_id};
  });
 }
 assertCompletion(r,c){
  const latest=this.db.prepare("SELECT max(seq) n FROM task_inputs WHERE task_id=? AND mode='follow' AND state<>'handed_back'").get(r.task_id).n??0;
  if(!c||c.round!==r.runs||c.input_cursor!==r.input_cursor||latest>r.input_cursor||c.control_version!==this.g.continuity.state(r.task_id).version)fail('COMPLETION_STALE');
 }
 recover(role,a){const r=this.owned(role,a);this.authority(r);if(r.state!=='running')fail('NOT_RUNNING');this.db.prepare('UPDATE managed_executions SET lease_until=? WHERE task_id=?').run(this.now()+30000,r.task_id);return this.item(this.get(r.task_id));}
 grantId(r){return r.authority?'task:'+r.task_id+':'+r.revision+':'+r.runs+':'+r.input_cursor:r.approval_id;}
 async deliver(role,a){this.validate(role,a);const r=this.owned(role,a),d=JSON.parse(r.spec).development,n=d?.notification;if(!n)fail('DELIVERY_AGREEMENT_REQUIRED');if(r.authority)this.assertCompletion(r,a.completion);const artifact=this.g.artifacts.load(r.task_id,a.artifact_id);if(artifact.kind!=='native_file'||artifact.spec_revision!==r.revision||!d.artifacts.includes(artifact.path)||a.current_sha256!==artifact.sha256)fail('ARTIFACT_NOT_AUTHORIZED');return this.g.notifications.media.enqueueTask(role,{task_id:r.task_id,artifact_id:a.artifact_id,mode:'file',expected_revision:r.revision,expected_binding_revision:n.binding_revision,event_id:'managed-delivery:'+this.grantId(r)+':'+artifact.id},this.grantId(r),n.target_key);}
 artifact(role,a){this.validate(role,a);const r=this.owned(role,a),d=JSON.parse(r.spec).development;if(!d||!d.artifacts.includes(a.path))fail('ARTIFACT_NOT_AUTHORIZED');return this.g.artifacts.nativeChunk(r,a);}
 call(method,a,role){if(!['local','cloud'].includes(role))fail('ROLE_INVALID');const m=method.slice('execution_'.length);if(m==='enqueue')return this.enqueue(a);if(m==='status')return this.view(a.task_id);if(!['usage','recover','claim','begin','validate','reserve','inputs','finish','suspend','evidence','artifact','deliver'].includes(m))fail('METHOD_DENIED');return this[m](role,a);}
}
