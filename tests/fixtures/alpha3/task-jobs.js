import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {supportedJobVersions,requiredJobVersion} from './job-version.js';
export const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const json=x=>JSON.stringify(x);
export class TaskJobs {
 constructor(root,now=Date.now){
  this.now=now;mkdirSync(root,{recursive:true,mode:0o700});this.file=join(root,'jobs.sqlite');this.db=new DatabaseSync(this.file);chmodSync(this.file,0o600);
  this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,trigger_id TEXT UNIQUE,fingerprint TEXT,task_id TEXT,kind TEXT,goal TEXT,policy TEXT,status TEXT,due INTEGER,checkpoint TEXT,proposal TEXT,proposal_hash TEXT,approved_by TEXT,approval_event TEXT,attempts INTEGER DEFAULT 0,max_runs INTEGER,claim TEXT,version TEXT,created INTEGER,error TEXT);
   CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,job_id TEXT,claim TEXT,session_id TEXT,status TEXT,started INTEGER,finished INTEGER,error TEXT);
   CREATE TABLE IF NOT EXISTS controls(event_id TEXT PRIMARY KEY,fingerprint TEXT,result TEXT);
   CREATE TABLE IF NOT EXISTS job_notifications(id TEXT PRIMARY KEY,text TEXT,delivered INTEGER DEFAULT 0);
   CREATE TABLE IF NOT EXISTS job_inputs(event_id TEXT PRIMARY KEY,fingerprint TEXT,job_id TEXT,question_run_id TEXT,source TEXT,at INTEGER);
   CREATE TABLE IF NOT EXISTS job_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT,type TEXT,data TEXT,at INTEGER);`);
  this.db.exec(`CREATE TABLE IF NOT EXISTS worker_model_reservations(id TEXT PRIMARY KEY,job_id TEXT NOT NULL,run_id TEXT NOT NULL,claim TEXT NOT NULL,purpose TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,reasoning TEXT,max_tokens INTEGER NOT NULL,created INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS worker_budget_by_run ON worker_model_reservations(run_id);`);
 }
 tx(fn){this.db.exec('BEGIN IMMEDIATE');try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 event(id,type,data={}){this.db.prepare('INSERT INTO job_events(job_id,type,data,at) VALUES (?,?,?,?)').run(id,type,json(data),this.now());}
 get(id){const j=this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);if(!j)throw Error('JOB_NOT_FOUND');return j;}
 list(task_id){return this.db.prepare('SELECT id,task_id,kind,status,due,checkpoint,proposal,proposal_hash,attempts,max_runs,error FROM jobs WHERE task_id=? ORDER BY created,id').all(task_id);}
 enqueue({task_id,trigger_id,kind='plan',goal,policy={},due,delay_seconds=0,max_runs=4,version='0.5.0'}){
  if(!supportedJobVersions.has(version)||version!=='0.5.0'&&kind!=='plan')throw Error('INVALID_JOB_VERSION');
  const requestedVersion=version;
  version=requiredJobVersion({kind,goal,version});
  const requestedDue=due??null;
  if(!Number.isInteger(delay_seconds)||delay_seconds<0||delay_seconds>366*86400)throw Error('INVALID_JOB');
  due??=this.now()+delay_seconds*1000;
  if(typeof task_id!=='string'||!task_id||typeof trigger_id!=='string'||!trigger_id||trigger_id.length>256||!['plan','development','test.checkpoint'].includes(kind)||typeof goal!=='string'||!goal.trim()||goal.length>12000||!Number.isSafeInteger(due)||due<0||due>this.now()+366*86400000||!Number.isInteger(max_runs)||max_runs<1||max_runs>10)throw Error('INVALID_JOB');
  if(!policy||typeof policy!=='object'||Array.isArray(policy)||Object.keys(policy).some(k=>!['provider','model','reasoningEffort'].includes(k))||Object.values(policy).some(v=>typeof v!=='string'||!v||v.length>128))throw Error('INVALID_MODEL_POLICY');
  const fingerprint=v=>digest({task_id,kind,goal,policy,requestedDue,delay_seconds,max_runs,...(v!=='0.5.0'?{version:v}:{})}),fp=fingerprint(version);
  return this.tx(()=>{const old=this.db.prepare('SELECT * FROM jobs WHERE trigger_id=?').get(trigger_id);if(old){
   // Finish linking an identically prepared OLD occurrence without upgrading its authority/version.
   // claim() will hold it; an upgrade must not stall every unrelated task on TRIGGER_CONFLICT.
   const legacyReplay=requestedVersion!==version&&old.version===requestedVersion&&old.fingerprint===fingerprint(requestedVersion);
   if(old.fingerprint!==fp&&!legacyReplay)throw Error('TRIGGER_CONFLICT');return old;}
   const id='job-'+randomUUID();this.db.prepare('INSERT INTO jobs(id,trigger_id,fingerprint,task_id,kind,goal,policy,status,due,checkpoint,max_runs,version,created) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,trigger_id,fp,task_id,kind,goal,json(policy),kind==='development'?'waiting_approval':'queued',due,'{}',max_runs,version,this.now());this.event(id,'enqueued');return this.get(id);});
 }
 // Must be called only after acquiring exclusive process ownership of the scheduler.
 recover(replaySafe){return this.tx(()=>{for(const j of this.db.prepare("SELECT * FROM jobs WHERE status='running'").all()){
  const status=supportedJobVersions.has(j.version)&&requiredJobVersion(j)===j.version&&replaySafe.has(j.kind)&&j.attempts<j.max_runs?'queued':'needs_review';
  this.db.prepare('UPDATE jobs SET status=?,claim=NULL,error=? WHERE id=?').run(status,'HOST_RESTARTED',j.id);
  this.db.prepare("UPDATE runs SET status='interrupted',finished=?,error='HOST_RESTARTED' WHERE job_id=? AND status='running'").run(this.now(),j.id);this.event(j.id,'recovered',{status});
 } });}
 claim(available,replaySafe,canClaim=()=>true){return this.tx(()=>{
  for(const j of this.db.prepare("SELECT * FROM jobs WHERE status IN ('queued','waiting') AND due<=? ORDER BY due,created,id").all(this.now())){
   if(!supportedJobVersions.has(j.version)){this.db.prepare("UPDATE jobs SET status='needs_review',error='VERSION_MISMATCH' WHERE id=?").run(j.id);continue;}
   if(requiredJobVersion(j)!==j.version){this.db.prepare("UPDATE jobs SET status='needs_review',error='SOURCE_JOB_VERSION_REQUIRED' WHERE id=?").run(j.id);continue;}
   if(j.kind==='development'&&!j.approved_by){this.db.prepare("UPDATE jobs SET status='waiting_approval' WHERE id=?").run(j.id);continue;}
   if(!available.has(j.kind)){this.db.prepare("UPDATE jobs SET status='waiting_capability',error='CAPABILITY_UNAVAILABLE' WHERE id=?").run(j.id);continue;}
   if(j.attempts>=j.max_runs){this.db.prepare("UPDATE jobs SET status='needs_review',error='RUN_BUDGET_EXHAUSTED' WHERE id=?").run(j.id);continue;}
   if(this.db.prepare("SELECT 1 FROM jobs WHERE task_id=? AND status='running'").get(j.task_id))continue;
   try{if(!canClaim(j))continue;}catch(e){this.db.prepare("UPDATE jobs SET status='needs_review',error=? WHERE id=?").run(/^DEVELOPMENT_[A-Z_]+$/.test(e.message)?e.message:'DEVELOPMENT_ADMISSION_FAILED',j.id);continue;}
   const claim=randomUUID(),run_id='run-'+randomUUID(),session_id='task-worker-'+randomUUID();
   this.db.prepare("UPDATE jobs SET status='running',claim=?,attempts=attempts+1,error=NULL WHERE id=?").run(claim,j.id);
   this.db.prepare("INSERT INTO runs(id,job_id,claim,session_id,status,started) VALUES (?,?,?,?,'running',?)").run(run_id,j.id,claim,session_id,this.now());
   this.event(j.id,'started',{run_id,session_id,replaySafe:replaySafe.has(j.kind)});return {...this.get(j.id),run_id,session_id};
  }return null;
 });}
 assertClaim(id,claim){const j=this.get(id);if(j.status!=='running'||j.claim!==claim)throw Error('STALE_JOB_CLAIM');return j;}
 // Reserve before actual dispatch. Failed/unknown dispatches are never refunded, including after restart.
 // This is accounting, NOT permission to invoke a search provider or to change the task policy.
 reserveModelRequest(job,request){
  if(!request||Object.keys(request).some(k=>!['purpose','provider','model','reasoningEffort','maxTokens'].includes(k))||!['worker','search'].includes(request.purpose)||request.maxTokens!==2048||
   ['provider','model'].some(k=>typeof request[k]!=='string'||!request[k]||request[k].length>128)||request.reasoningEffort!==undefined&&(typeof request.reasoningEffort!=='string'||!request.reasoningEffort||request.reasoningEffort.length>64))throw Error('WORKER_MODEL_RESERVATION_INVALID');
  return this.tx(()=>{
   const current=this.assertClaim(job.id,job.claim),policy=JSON.parse(current.policy);
   if(current.kind!=='plan'||!this.db.prepare("SELECT 1 FROM runs WHERE id=? AND job_id=? AND claim=? AND status='running'").get(job.run_id,job.id,job.claim))throw Error('WORKER_MODEL_RUN_MISMATCH');
   if(!policy.provider||!policy.model||request.provider!==policy.provider||request.model!==policy.model||
    (request.purpose==='worker'&&policy.reasoningEffort!==undefined&&request.reasoningEffort!==policy.reasoningEffort)||
    (request.purpose==='search'&&request.reasoningEffort!=='disabled'))throw Error('WORKER_MODEL_ROUTE_MISMATCH');
   const used=this.db.prepare('SELECT count(*) n FROM worker_model_reservations WHERE run_id=?').get(job.run_id).n;
   if(used>=6)throw Error('WORKER_REQUEST_BUDGET');
   const id='model-reservation-'+randomUUID();
   this.db.prepare('INSERT INTO worker_model_reservations VALUES (?,?,?,?,?,?,?,?,?,?)').run(id,job.id,job.run_id,job.claim,request.purpose,request.provider,request.model,request.reasoningEffort??null,request.maxTokens,this.now());
   return {id,used:used+1,limit:6,purpose:request.purpose,state:'reserved_not_proof_of_provider_success'};
  });
 }
 finish(job,result){return this.tx(()=>{
  const j=this.assertClaim(job.id,job.claim);
  if(!result||!['checkpoint','proposal','done','input'].includes(result.outcome)||typeof result.summary!=='string'||!result.summary.trim()||result.summary.length>4000)throw Error('INVALID_CHECKPOINT');
  let status='completed',due=j.due,proposal=null,ph=null;
  if(result.outcome==='checkpoint'){
   if(!Number.isInteger(result.delay_seconds)||result.delay_seconds<1||result.delay_seconds>366*86400)throw Error('INVALID_NEXT_RUN');
   status=j.attempts>=j.max_runs?'needs_review':'waiting';due=this.now()+result.delay_seconds*1000;
  }
  if(result.outcome==='input'){
   if(j.kind!=='plan'||typeof result.question!=='string'||!result.question.trim()||result.question.length>2000)throw Error('INVALID_INPUT_REQUEST');
   status=j.attempts>=j.max_runs?'needs_review':'waiting_input';
   this.db.prepare("UPDATE jobs SET version=CASE WHEN version IN ('0.17.1','0.18.0','0.18.1') THEN version ELSE '0.17.0' END WHERE id=?").run(j.id);
  }
  if(result.outcome==='proposal'){
   if(typeof result.proposal!=='string'||!result.proposal.trim()||result.proposal.length>8000)throw Error('INVALID_PROPOSAL');
   proposal=result.proposal;ph=digest({job_id:j.id,task_id:j.task_id,goal:j.goal,policy:JSON.parse(j.policy),proposal});status='waiting_approval';
  }
  this.db.prepare('UPDATE jobs SET status=?,due=?,checkpoint=?,proposal=?,proposal_hash=?,claim=NULL,error=? WHERE id=?').run(status,due,json({summary:result.summary,...(result.outcome==='input'?{question:result.question,question_run_id:job.run_id}:{})}),proposal,ph,status==='needs_review'?'RUN_BUDGET_EXHAUSTED':null,j.id);
  this.db.prepare("UPDATE runs SET status='completed',finished=? WHERE id=? AND claim=?").run(this.now(),job.run_id,job.claim);this.event(j.id,'checkpoint',{status});
  if(j.kind!=='test.checkpoint'&&status!=='waiting'){
   const text=status==='waiting_approval'?'DSH 只读规划完成，等待开发审批。任务 '+j.task_id+'\n'+result.summary+'\n方案：'+proposal+'\n当前可信开发审批入口尚未开放；请按任务名称查询方案。旧 /approve 测试命令已退役。此通知不授权开发或写入仓库。':'DSH 规划批次 '+j.id+'：'+status+'\n'+result.summary+'\n这不表示整个长期任务已完成。';
   this.db.prepare('INSERT OR IGNORE INTO job_notifications(id,text) VALUES (?,?)').run('job-result:'+job.run_id,text);
  }
  return this.get(j.id);
 });}
 fail(job,code){return this.tx(()=>{const j=this.get(job.id);if(j.claim!==job.claim||j.status!=='running')return;
  this.db.prepare("UPDATE jobs SET status='needs_review',error=?,claim=NULL WHERE id=?").run(code,j.id);this.db.prepare("UPDATE runs SET status='failed',finished=?,error=? WHERE id=?").run(this.now(),code,job.run_id);this.event(j.id,'failed',{code});if(j.kind!=='test.checkpoint')this.db.prepare('INSERT OR IGNORE INTO job_notifications(id,text) VALUES (?,?)').run('job-failed:'+job.run_id,'DSH 批次 '+j.id+' 待核对：'+code+'，未授权开发。');
 });}
 control({id,action,event_id,actor,proposal_hash}){
  if(!['pause','resume','cancel','approve'].includes(action)||typeof event_id!=='string'||!event_id||event_id.length>256||typeof actor!=='string'||!actor||actor.length>128)throw Error('INVALID_CONTROL');
  return this.tx(()=>{
   const fp=digest({id,action,actor,proposal_hash}),old=this.db.prepare('SELECT * FROM controls WHERE event_id=?').get(event_id);
   if(old){if(old.fingerprint!==fp)throw Error('CONTROL_CONFLICT');return JSON.parse(old.result);}
   const j=this.get(id);let status;
   if(action==='approve'){
    if(j.status!=='waiting_approval'||!j.proposal_hash||proposal_hash!==j.proposal_hash)throw Error('APPROVAL_SCOPE_MISMATCH');
    // No development adapter is shipped in this release. Approval never implies execution.
    status='waiting_capability';this.db.prepare('UPDATE jobs SET approved_by=?,approval_event=?,status=?,error=? WHERE id=?').run(actor,event_id,status,'DEVELOPMENT_ADAPTER_NOT_ENABLED',id);
   }else if(action==='resume'){
    if(j.status!=='paused')throw Error('RESUME_NOT_ALLOWED');
    const pause=this.db.prepare("SELECT data FROM job_events WHERE job_id=? AND type='pause' ORDER BY seq DESC LIMIT 1").get(id);
    status=pause&&JSON.parse(pause.data).from_status==='waiting_input'?'waiting_input':'queued';this.db.prepare('UPDATE jobs SET status=?,due=?,claim=NULL WHERE id=?').run(status,this.now(),id);
   }else{
    if(['completed','cancelled'].includes(j.status))throw Error('CONTROL_NOT_ALLOWED');
    if(action==='pause'&&!['queued','waiting','running','paused','waiting_input'].includes(j.status))throw Error('CONTROL_NOT_ALLOWED');
    // Invalidates every delayed tool/report before signalling the active agent.
    status=action==='pause'?'paused':'cancelled';this.db.prepare('UPDATE jobs SET status=?,claim=NULL WHERE id=?').run(status,id);
    this.db.prepare("UPDATE runs SET status='cancelled',finished=? WHERE job_id=? AND status='running'").run(this.now(),id);
   }
   const result={id,status};this.db.prepare('INSERT INTO controls VALUES (?,?,?)').run(event_id,fp,json(result));this.event(id,action,{actor,event_id,...(action==='pause'?{from_status:j.status==='paused'?(JSON.parse(this.db.prepare("SELECT data FROM job_events WHERE job_id=? AND type='pause' ORDER BY seq DESC LIMIT 1").get(id)?.data??'{}').from_status??'queued'):j.status}:{})});return result;
  });
 }
 inputs(id){return this.db.prepare('SELECT event_id,question_run_id,source,at FROM job_inputs WHERE job_id=? ORDER BY at,event_id').all(id).map(x=>({...x,source:JSON.parse(x.source)}));}
 answer({id,question_run_id,event_id,source}){
  if(typeof event_id!=='string'||!event_id||event_id.length>256||!Array.isArray(source)||!source.length||json(source).length>12000)throw Error('SCHEDULER_INPUT_INVALID');
  return this.tx(()=>{
   const fp=digest({id,question_run_id,source}),old=this.db.prepare('SELECT * FROM job_inputs WHERE event_id=?').get(event_id);
   if(old){if(old.fingerprint!==fp)throw Error('SCHEDULER_EVENT_CONFLICT');return {id,status:this.get(id).status,recorded:true};}
   const j=this.get(id),checkpoint=JSON.parse(j.checkpoint);
   if(j.kind!=='plan'||j.status!=='waiting_input'||checkpoint.question_run_id!==question_run_id)throw Error('SCHEDULER_INPUT_STALE');
   if(j.attempts>=j.max_runs)throw Error('SCHEDULER_INPUT_BUDGET_EXHAUSTED');
   if(this.db.prepare('SELECT count(*) AS n FROM job_inputs WHERE job_id=?').get(id).n>=9)throw Error('SCHEDULER_INPUT_BUDGET_EXHAUSTED');
   this.db.prepare('INSERT INTO job_inputs VALUES (?,?,?,?,?,?)').run(event_id,fp,id,question_run_id,json(source),this.now());
   this.db.prepare("UPDATE jobs SET status='queued',due=?,claim=NULL WHERE id=?").run(this.now(),id);this.event(id,'input_received',{event_id,question_run_id});
   return {id,status:'queued',recorded:true};
  });
 }
 close(){this.db.close();}
}
