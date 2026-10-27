import {createServer} from 'node:net';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {hostname} from 'node:os';
import {TaskJobs} from './task-jobs.js';
import {TaskWorkflows} from './task-workflows.js';
import {TaskTriggers} from './task-triggers.js';
import {NativeTaskWorker} from './task-worker.js';
export class TaskScheduler {
 constructor(ctx,config,io={}){
  if(!Number.isInteger(config.lockPort)||config.lockPort<0||config.lockPort>65535||(config.lockPort===0&&!io.allowEphemeralLock))throw Error('INVALID_SCHEDULER_LOCK');
  this.maxConcurrent=config.maxConcurrent??1;if(!Number.isInteger(this.maxConcurrent)||this.maxConcurrent<1||this.maxConcurrent>4)throw Error('INVALID_SCHEDULER_CONCURRENCY');
  this.ctx=ctx;this.c=config;this.closed=false;this.active=new Map();this.executors=new Map();this.started=false;
  this.preexistingDatabase=existsSync(join(config.stateDir,'jobs.sqlite'));
  this.jobs=new TaskJobs(config.stateDir,io.now);
  // A genuinely fresh database knows its original fixed port even if the first
  // socket bind fails. Retrying that same port is not legacy adoption.
  if(!this.preexistingDatabase&&config.lockPort!==0){
   this.jobs.db.exec('CREATE TABLE IF NOT EXISTS scheduler_owner(id INTEGER PRIMARY KEY CHECK(id=1),host TEXT NOT NULL,port INTEGER NOT NULL);');
   this.jobs.db.prepare('INSERT OR IGNORE INTO scheduler_owner VALUES(1,?,?)').run(hostname(),config.lockPort);
  }
  this.worker=new NativeTaskWorker(ctx,this.jobs,config);
  this.executors.set('plan',{replaySafe:true,run:(job,signal)=>this.worker.run(job,signal)});
  this.triggers=new TaskTriggers(this.jobs,{...io.triggers,validate:s=>this.c.validateSchedule?.(s),control:a=>this.control(a)});
  this.worker.config.triggerContext=id=>this.triggers.context(id);
  this.workflows=new TaskWorkflows(this.jobs,{...io.workflows,validate:w=>this.c.validateSchedule?.(w),control:a=>this.control(a)});
  this.worker.config.workflowContext=id=>this.workflows.context(id);
  const admit=config.admit;this.c.admit=j=>{this.workflows.assertRunning(j);admit?.(j);};
  this.timeout=config.timeoutMs??120000;this.interval=config.intervalMs??1000;
  if(!Number.isInteger(this.timeout)||this.timeout<100||this.timeout>300000||!Number.isInteger(this.interval)||this.interval<50||this.interval>60000)throw Error('INVALID_SCHEDULER_LIMITS');
 }
 // Operator-owned capability registration. Never exposed as a model tool or remote RPC.
 register(kind,executor){if(this.executors.has(kind)||!['test.checkpoint'].includes(kind)||executor.replaySafe!==true)throw Error('CAPABILITY_REGISTRATION_DENIED');this.executors.set(kind,executor);return ()=>this.executors.delete(kind);}
 async start(){
  if(this.closed)throw Error('SCHEDULER_CLOSED');if(this.started)return;if(this.starting)return this.starting;
  this.starting=this.startExclusive();try{await this.starting;}finally{this.starting=null;}
 }
 async startExclusive(){
  // Persist the lock coordinate with this database. Changing a port must not let
  // a second process recover live work. Local state directories are not shared across hosts.
  this.jobs.db.exec('CREATE TABLE IF NOT EXISTS scheduler_owner(id INTEGER PRIMARY KEY CHECK(id=1),host TEXT NOT NULL,port INTEGER NOT NULL);');
  const host=hostname(),owner=this.jobs.db.prepare('SELECT * FROM scheduler_owner WHERE id=1').get();
  if(!owner&&this.preexistingDatabase)throw Error('SCHEDULER_OWNER_MIGRATION_REQUIRED');
  if(owner&&(owner.host!==host||(this.c.lockPort!==0&&owner.port!==this.c.lockPort)))throw Error('SCHEDULER_OWNER_CHANGED');
  this.lock=createServer(s=>s.destroy());
  try{
   await new Promise((resolve,reject)=>{this.lock.once('error',reject);this.lock.listen({host:'127.0.0.1',port:owner?.port??this.c.lockPort,exclusive:true},resolve);});
   if(this.closed)throw Error('SCHEDULER_CLOSED');
   const port=this.lock.address().port;
   this.jobs.tx(()=>{this.jobs.db.prepare('INSERT OR IGNORE INTO scheduler_owner VALUES (1,?,?)').run(host,port);
    const saved=this.jobs.db.prepare('SELECT * FROM scheduler_owner WHERE id=1').get();if(saved.host!==host||saved.port!==port)throw Error('SCHEDULER_OWNER_CHANGED');});
   this.jobs.recover(new Set(['plan','test.checkpoint']));this.c.afterRecover?.();this.started=true;
   this.timer=setInterval(()=>{try{this.tick();}catch{this.lastError='SCHEDULER_TICK_FAILED';}},this.interval);this.timer.unref?.();
  }catch(e){if(this.lock.listening)await new Promise(r=>this.lock.close(r));throw e;}
 }

 tick(){
  if(this.closed||!this.started||this.c.canTick?.()===false)return;
  this.triggers.tick();this.workflows.tick();
  while(this.active.size<this.maxConcurrent){
  const job=this.jobs.claim(new Set(this.executors.keys()),new Set([...this.executors].filter(([,x])=>x.replaySafe).map(([k])=>k)),j=>![...this.active.values()].some(a=>a.task_id===j.task_id)&&this.triggers.canClaim(j)&&this.workflows.canClaim(j)&&(this.c.canClaim?.(j)??true));if(!job)return;
  const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),this.timeout);const executor=this.executors.get(job.kind);
  const run=Promise.resolve().then(async()=>{try{
   this.c.admit?.(job);
   const result=await executor.run(job,controller.signal);if(controller.signal.aborted)throw Error('WORKER_CANCELLED');this.jobs.finish(job,result);this.c.afterFinish?.(job);
  }catch(e){
   // Preserve running records on host shutdown: next exclusive owner reconciles replay-safe work.
   this.c.afterFailure?.(job);if(!this.closed)this.jobs.fail(job,/^(DEVELOPMENT|WORKFLOW|SOURCE)_[A-Z_]+$/.test(e.message)||['MODEL_POLICY_REQUIRED','WORKER_MODEL_ROUTE_MISMATCH','WORKER_REQUEST_BUDGET','WORKER_TOKEN_BUDGET','WORKER_REPORT_REQUIRED','STALE_JOB_CLAIM','TASK_BLOCKED','TASK_REVISION_CONFLICT'].includes(e.message)||/^WORKER_MODEL_(INVALID_REQUEST|UNKNOWN_MODEL|NO_ADAPTER|MISSING_CREDENTIAL|INVALID_CREDENTIAL|UNSUPPORTED_REASONING_EFFORT|QUOTA|RATE_LIMIT|ABORTED|FAILED)$/.test(e.message)?e.message:(controller.signal.aborted?'WORKER_CANCELLED':'WORKER_FAILED'),e.developmentAttention);
  }finally{clearTimeout(timeout);this.active.delete(job.id);}});this.active.set(job.id,{controller,run,task_id:job.task_id});
  }
 }
 control(args){const r=this.jobs.control(args);if(['pause','cancel'].includes(args.action)&&this.jobs.get(args.id).status===r.status)this.active.get(args.id)?.controller.abort();return r;}
 snapshot(){return {enabled:this.started&&!this.closed,activeRuns:this.active.size,maxConcurrent:this.maxConcurrent,lastError:this.lastError??null,jobs:this.jobs.db.prepare('SELECT status,count(*) AS count FROM jobs GROUP BY status').all()};}
 close(){if(this.closing)return this.closing;this.closed=true;clearInterval(this.timer);for(const a of this.active.values())a.controller.abort();
  this.closing=(async()=>{try{await this.starting;}catch{}await Promise.allSettled([...this.active.values()].map(x=>x.run));this.jobs.close();if(this.lock?.listening)await new Promise(r=>this.lock.close(r));})();return this.closing;
 }
}
