import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {TaskJobs} from '../bundle/task-jobs.js';
import {TaskTriggers} from '../bundle/task-triggers.js';
import {TaskScheduler} from '../bundle/task-scheduler.js';
import {makeEnvelope,selectedHumanContext} from '../bundle/task-envelope.js';
import {validateTiming,firstDue,coalesceDue} from '../bundle/task-trigger-time.js';
const START=Date.parse('2026-10-18T08:00:00Z'),DAY=86400000,policy={provider:'task-provider',model:'task-selected-model',reasoningEffort:'low'};
const caps=new Set(['plan']);
const agent={id:'entry',session:{deriveMessages:()=>[{id:'user-1',role:'user',source:{kind:'user'},content:[{type:'text',text:'请按明确计划使用所选模型只读研究；资料到齐后再继续，不开发。'}]}]}};
const source=selectedHumanContext(agent,'cloud'),goal=makeEnvelope(agent,'cloud',{goal:'read only',target:'cloud',intent:'plan',model_policy:policy}).goal;
const args=(now=START,overrides={})=>({task_id:'t1',revision:1,event_id:'user-schedule:1',goal,policy,source,timing:{rule:{kind:'interval',start_at:now,every_seconds:3600},end_at:now+90*DAY,max_occurrences:8,max_runs:4},...overrides});
function setup(t,io={}){
 const dir=mkdtempSync(tmpdir()+'/task-trigger-');let now=START,jobs=new TaskJobs(dir,()=>now),triggers=new TaskTriggers(jobs,io);
 t.after(()=>{jobs.close();rmSync(dir,{recursive:true,force:true});});
 return {get jobs(){return jobs;},get triggers(){return triggers;},get now(){return now;},advance:n=>now+=n,reopen(){jobs.close();jobs=new TaskJobs(dir,()=>now);triggers=new TaskTriggers(jobs,io);return triggers;},complete(){const j=jobs.claim(caps,caps,x=>triggers.canClaim(x));assert.ok(j);jobs.finish(j,{outcome:'done',summary:'fixture complete'});return j;}};
}
test('persistent occurrence intent survives restart; selected model and exact budget never become global defaults',t=>{
 const f=setup(t),s=f.triggers.create(args());f.triggers.tick();const first=f.triggers.list('t1')[0];assert.equal(first.emitted,1);assert.equal(first.occurrences.length,1);
 assert.deepEqual(JSON.parse(f.jobs.get(first.occurrences[0].job_id).policy),policy);
 f.reopen().tick();assert.equal(f.triggers.get(s.id).emitted,1);f.complete();f.advance(3600000);f.triggers.tick();assert.equal(f.triggers.get(s.id).emitted,2);
 assert.equal(f.jobs.db.prepare('SELECT count(*) n FROM jobs').get().n,2);
});
test('same registration after time passes is idempotent; mutated scope conflicts and simultaneous duplicate schedule is refused',t=>{
 const f=setup(t),a=args(),s=f.triggers.create(a);f.advance(DAY);assert.equal(f.triggers.create(a).id,s.id);
 assert.throws(()=>f.triggers.create({...a,timing:{...a.timing,max_occurrences:9}}),/EVENT_CONFLICT/);
 assert.throws(()=>f.triggers.create(args(f.now,{event_id:'new'})),/ALREADY_EXISTS/);
});
test('once accepts explicit-offset ISO time, never runs early and closes after its sole occurrence',t=>{
 const f=setup(t),s=f.triggers.create(args(START,{timing:{rule:{kind:'once',at:'2026-10-18T17:00:00+08:00'},end_at:'2026-10-19T17:00:00+08:00',max_occurrences:1,max_runs:2}}));
 f.triggers.tick();assert.equal(f.triggers.get(s.id).reason,'waiting_time');assert.equal(f.jobs.claim(caps,caps),null);
 f.advance(3600000);f.triggers.tick();f.complete();f.triggers.tick();assert.equal(f.triggers.get(s.id).status,'closed');
});
test('missed intervals coalesce to the newest slot, count missed times and do not spend model runs per missed period',t=>{
 const f=setup(t),s=f.triggers.create(args());f.advance(60*DAY+123);f.reopen().tick();const state=f.triggers.get(s.id);
 assert.equal(state.emitted,1);assert.equal(state.skipped,1440);assert.equal(f.jobs.db.prepare('SELECT count(*) n FROM jobs').get().n,1);
 assert.equal(f.jobs.db.prepare('SELECT due FROM jobs').get().due,START+60*DAY);
});
test('a waiting occurrence blocks later slots but not an unrelated task; occurrence budgets stop at their exact limit',t=>{
 const f=setup(t),s=f.triggers.create(args(START,{timing:{...args().timing,max_occurrences:2}}));f.triggers.tick();const j=f.jobs.claim(caps,caps);
 f.jobs.finish(j,{outcome:'checkpoint',summary:'first step',delay_seconds:7200});f.advance(3600000);f.triggers.tick();assert.equal(f.triggers.get(s.id).emitted,1);assert.equal(f.triggers.get(s.id).reason,'occurrence:waiting');
 const other=f.jobs.enqueue({task_id:'other',trigger_id:'other',goal:'other read only',policy});assert.equal(f.jobs.claim(caps,caps).id,other.id);
 f.advance(3600000);f.complete();f.triggers.tick();f.complete();f.advance(DAY);f.triggers.tick();assert.equal(f.triggers.get(s.id).emitted,2);assert.equal(f.triggers.get(s.id).status,'closed');
});
for(const phase of ['afterPrepared','afterEnqueued'])test('crash window '+phase+' recovers the same occurrence and job without extra budget',t=>{
 let crash=true;const f=setup(t,{[phase](){if(crash){crash=false;throw Error('simulated-stop');}}}),s=f.triggers.create(args());
 assert.throws(()=>f.triggers.tick(),/simulated-stop/);f.reopen().tick();f.triggers.tick();
 assert.equal(f.triggers.get(s.id).emitted,1);assert.equal(f.jobs.db.prepare('SELECT count(*) n FROM jobs').get().n,1);
 assert.equal(f.jobs.db.prepare('SELECT count(*) n FROM schedule_occurrences').get().n,1);f.complete();
});
test('pause before crash recovery cannot create runnable work; resume keeps occurrence and run budget',t=>{
 let crash=true;const f=setup(t,{afterPrepared(){if(crash){crash=false;throw Error('stop');}}}),s=f.triggers.create(args());
 assert.throws(()=>f.triggers.tick(),/stop/);f.triggers.control({id:s.id,action:'pause',event_id:'pause',actor:'owner'});f.reopen().tick();
 const j=f.jobs.db.prepare('SELECT * FROM jobs').get();assert.equal(j.status,'paused');assert.equal(f.jobs.claim(caps,caps,x=>f.triggers.canClaim(x)),null);
 f.triggers.control({id:s.id,action:'resume',event_id:'resume',actor:'owner'});f.complete();assert.equal(f.jobs.get(j.id).attempts,1);assert.equal(f.triggers.get(s.id).emitted,1);
});
test('cancel before materialization and restart preserves cancellation, not automatic retry',t=>{
 let crash=true;const f=setup(t,{afterEnqueued(){if(crash){crash=false;throw Error('stop');}}}),s=f.triggers.create(args());
 assert.throws(()=>f.triggers.tick(),/stop/);f.triggers.control({id:s.id,action:'cancel',event_id:'cancel',actor:'owner'});f.reopen().tick();
 assert.equal(f.jobs.db.prepare('SELECT status FROM jobs').get().status,'cancelled');assert.equal(f.jobs.claim(caps,caps,x=>f.triggers.canClaim(x)),null);
});
test('interrupted schedule control is finished on restart with its original event identity',t=>{
 let crash=true,f;const io={control:a=>{if(crash){crash=false;throw Error('stop');}return f.jobs.control(a);}};f=setup(t,io);const s=f.triggers.create(args());f.triggers.tick();
 assert.throws(()=>f.triggers.control({id:s.id,action:'pause',event_id:'pause',actor:'owner'}),/stop/);assert.equal(f.triggers.get(s.id).status,'paused');
 f.reopen().tick();assert.equal(f.jobs.db.prepare('SELECT status FROM jobs').get().status,'paused');assert.deepEqual(f.triggers.control({id:s.id,action:'pause',event_id:'pause',actor:'owner'}),{id:s.id,status:'paused'});
});
test('schedule resume does not unpause a job independently paused by user',t=>{
 const f=setup(t),s=f.triggers.create(args());f.triggers.tick();const id=f.triggers.list('t1')[0].occurrences[0].job_id;
 f.jobs.control({id,action:'pause',event_id:'individual',actor:'authenticated-user'});f.triggers.control({id:s.id,action:'pause',event_id:'all-pause',actor:'owner'});f.triggers.control({id:s.id,action:'resume',event_id:'all-resume',actor:'owner'});
 assert.equal(f.jobs.get(id).status,'paused');
});
test('explicit event dedup survives restart and exhausted budget cannot silently accept a new event',t=>{
 const f=setup(t),s=f.triggers.create(args(START,{timing:{...args().timing,rule:{kind:'event',name:'资料到齐'},max_occurrences:1}}));f.triggers.tick();assert.equal(f.triggers.get(s.id).reason,'waiting_event');
 const signal={id:s.id,name:'资料到齐',event_id:'message:1',source};assert.equal(f.triggers.signal(signal).status,'pending');assert.throws(()=>f.triggers.signal({...signal,name:'other'}),/EVENT_CONFLICT/);
 f.reopen().tick();assert.equal(f.triggers.signal(signal).status,'consumed');f.complete();f.triggers.tick();assert.throws(()=>f.triggers.signal({...signal,event_id:'message:2'}),/NOT_ACCEPTED/);
});
test('completed immutable read-only dependency releases schedule; failed/cancelled dependency never means success',t=>{
 const f=setup(t),parent=f.jobs.enqueue({task_id:'parent',trigger_id:'parent-job',goal:'parent',policy}),s=f.triggers.create(args(START,{dependencies:[parent.id]}));
 f.triggers.tick();assert.equal(f.triggers.get(s.id).reason,'dependency:queued');assert.equal(f.triggers.get(s.id).emitted,0);f.complete();f.triggers.tick();assert.equal(f.triggers.get(s.id).emitted,1);
 const dev=f.jobs.enqueue({task_id:'dev',trigger_id:'dev-job',kind:'development',goal:'dev',policy});assert.throws(()=>f.triggers.create(args(START,{task_id:'child',event_id:'child',dependencies:[dev.id]})),/DEPENDENCIES_INVALID/);
});
test('revision/authority changes stop future schedules and deadline cancels queued work without creating a burst',t=>{
 let valid=true;const f=setup(t,{validate(){if(!valid)throw Error('changed');}}),s=f.triggers.create(args());valid=false;f.triggers.tick();assert.equal(f.triggers.get(s.id).status,'review');assert.equal(f.triggers.get(s.id).emitted,0);
 valid=true;const other=f.triggers.create(args(START,{task_id:'other',event_id:'other'}));f.triggers.tick();f.advance(91*DAY);f.triggers.tick();assert.equal(f.triggers.get(other.id).status,'closed');assert.equal(f.jobs.db.prepare('SELECT status FROM jobs').get().status,'cancelled');
});
test('weekly local wall time applies documented DST gap-forward and overlap-earlier policy',()=>{
 const gap={kind:'weekly',start_at:Date.parse('2027-03-13T00:00Z'),weekday:7,hour:2,minute:30,timezone:'America/New_York'};
 assert.equal(new Date(firstDue(gap)).toISOString(),'2027-03-14T07:30:00.000Z');
 assert.equal(new Date(coalesceDue(gap,firstDue(gap),Date.parse('2027-03-21T08:00Z'),Date.parse('2027-04-01T00:00Z')).due).toISOString(),'2027-03-21T06:30:00.000Z');
 const overlap={...gap,start_at:Date.parse('2026-10-31T00:00Z'),hour:1};assert.equal(new Date(firstDue(overlap)).toISOString(),'2026-11-01T05:30:00.000Z');
});
test('timing validation rejects missing zone/offset, extra actions, unbounded counts and unknown rules',()=>{
 for(const timing of [{...args().timing,max_occurrences:0},{...args().timing,max_runs:11},{...args().timing,end_at:'2026-11-01T10:00:00'},{...args().timing,rule:{kind:'once',at:START,command:'shell'}},{...args().timing,rule:{kind:'cron',expression:'* * * * *'}},{...args().timing,rule:{kind:'weekly',start_at:START,weekday:1,hour:9,minute:0,timezone:'No/Such'}}])assert.throws(()=>validateTiming(timing,START),/RULE_INVALID/);
});
test('waiting-input releases worker, accepts only exact question, preserves sources and run budget across restart',t=>{
 const f=setup(t),s=f.triggers.create(args());f.triggers.tick();const j=f.jobs.claim(caps,caps);f.jobs.finish(j,{outcome:'input',summary:'need one fact',question:'要分析哪份资料？'});
 assert.equal(f.jobs.get(j.id).status,'waiting_input');f.advance(DAY);f.reopen().tick();assert.equal(f.jobs.claim(caps,caps),null);assert.equal(f.triggers.get(s.id).reason,'occurrence:waiting_input');
 const a={id:j.id,question_run_id:j.run_id,event_id:'answer',source};assert.throws(()=>f.jobs.answer({...a,question_run_id:'wrong'}),/INPUT_STALE/);f.jobs.answer(a);f.reopen();f.jobs.answer(a);
 assert.equal(f.jobs.inputs(j.id).length,1);assert.equal(f.jobs.get(j.id).attempts,1);const resumed=f.jobs.claim(caps,caps);assert.equal(resumed.attempts,2);assert.notEqual(resumed.session_id,j.session_id);assert.deepEqual(JSON.parse(resumed.policy),policy);
 f.jobs.finish(resumed,{outcome:'done',summary:'answer used'});assert.throws(()=>f.jobs.answer({...a,event_id:'answer-new'}),/INPUT_STALE/);
});
test('waiting-input at final run cannot reset the exhausted budget',t=>{
 const f=setup(t);f.jobs.enqueue({task_id:'t',trigger_id:'j',goal,policy,max_runs:1});const j=f.jobs.claim(caps,caps);f.jobs.finish(j,{outcome:'input',summary:'need more',question:'which?'});
 assert.equal(f.jobs.get(j.id).status,'needs_review');assert.throws(()=>f.jobs.answer({id:j.id,question_run_id:j.run_id,event_id:'answer',source}),/INPUT_STALE/);
});
test('bounded concurrency permits independent tasks but never a same-task successor before actual drain',async t=>{
 let clock=START;const dir=mkdtempSync(tmpdir()+'/task-concurrency-'),s=new TaskScheduler({on(){}},{stateDir:dir,lockPort:0,intervalMs:60000,maxConcurrent:2},{allowEphemeralLock:true,now:()=>clock++});
 let unblock;const drained=new Promise(r=>unblock=r);t.after(async()=>{unblock();await s.close();rmSync(dir,{recursive:true,force:true});});
 s.register('test.checkpoint',{replaySafe:true,run:async()=>{await drained;return {outcome:'done',summary:'bounded fixture'};}});await s.start();
 const put=(task_id,trigger_id)=>s.jobs.enqueue({task_id,trigger_id,goal:'fixture',policy,kind:'test.checkpoint'});
 const first=put('a','a1'),second=put('a','a2'),other=put('b','b1');s.tick();assert.equal(s.active.size,2);assert.equal(s.jobs.get(other.id).status,'running');assert.equal(s.jobs.get(second.id).status,'queued');
 s.control({id:first.id,action:'pause',event_id:'p',actor:'owner'});s.tick();assert.equal(s.active.size,2);assert.equal(s.jobs.get(second.id).status,'queued');
 unblock();await Promise.all([...s.active.values()].map(x=>x.run));s.tick();assert.equal(s.jobs.get(second.id).status,'running');
});
test('invalid concurrency is rejected; synchronous admission failure leaves no orphan active slot',async t=>{
 const dir=mkdtempSync(tmpdir()+'/task-admission-');t.after(()=>rmSync(dir,{recursive:true,force:true}));
 for(const maxConcurrent of [0,5,1.5])assert.throws(()=>new TaskScheduler({on(){}},{stateDir:dir,lockPort:0,maxConcurrent},{allowEphemeralLock:true}),/INVALID_SCHEDULER_CONCURRENCY/);
 const s=new TaskScheduler({on(){}},{stateDir:dir,lockPort:0,intervalMs:60000,admit(){throw Error('TASK_BLOCKED');}},{allowEphemeralLock:true});t.after(()=>s.close());await s.start();
 s.jobs.enqueue({task_id:'t',trigger_id:'j',goal:'fixture',policy});s.tick();await Promise.all([...s.active.values()].map(x=>x.run));assert.equal(s.active.size,0);
});

test('pausing waiting-input twice and resuming cannot manufacture an answer or start a model',t=>{
 const f=setup(t),s=f.triggers.create(args());f.triggers.tick();const j=f.jobs.claim(caps,caps);f.jobs.finish(j,{outcome:'input',summary:'need fact',question:'which report?'});
 f.jobs.control({id:j.id,action:'pause',event_id:'pause-1',actor:'owner'});f.jobs.control({id:j.id,action:'pause',event_id:'pause-2',actor:'owner'});f.reopen();
 assert.equal(f.jobs.control({id:j.id,action:'resume',event_id:'resume',actor:'owner'}).status,'waiting_input');assert.equal(f.jobs.claim(caps,caps),null);
 f.triggers.control({id:s.id,action:'pause',event_id:'schedule-pause',actor:'owner'});assert.equal(f.jobs.get(j.id).status,'paused');f.triggers.control({id:s.id,action:'resume',event_id:'schedule-resume',actor:'owner'});assert.equal(f.jobs.get(j.id).status,'waiting_input');
});
test('pending named events reserve occurrence budget; no accepted event disappears because a later event overbooks it',t=>{
 const f=setup(t),s=f.triggers.create(args(START,{timing:{...args().timing,rule:{kind:'event',name:'ready'},max_occurrences:1}}));
 f.triggers.signal({id:s.id,name:'ready',source,event_id:'one'});assert.throws(()=>f.triggers.signal({id:s.id,name:'ready',source,event_id:'two'}),/NOT_ACCEPTED/);f.triggers.tick();assert.equal(f.triggers.get(s.id).emitted,1);
});

test('new control cannot overtake an interrupted earlier control; restart settles the original journal first',t=>{
 let blocked=true,f;f=setup(t,{control:a=>{if(blocked)throw Error('stop');return f.jobs.control(a);}});const s=f.triggers.create(args());f.triggers.tick();
 assert.throws(()=>f.triggers.control({id:s.id,action:'pause',event_id:'p',actor:'owner'}),/stop/);
 assert.throws(()=>f.triggers.control({id:s.id,action:'resume',event_id:'r',actor:'owner'}),/CONTROL_PENDING/);
 blocked=false;f.reopen().tick();assert.equal(f.triggers.control({id:s.id,action:'resume',event_id:'r',actor:'owner'}).status,'active');
});
test('invalid policy fields are rejected before a durable occurrence can become unrecoverable',t=>{
 const f=setup(t);assert.throws(()=>f.triggers.create(args(START,{policy:{...policy,command:'write'}})),/INVALID_MODEL_POLICY/);assert.equal(f.jobs.db.prepare('SELECT count(*) n FROM task_schedules').get().n,0);
});

test('new call IDs cannot recycle the same user source to reset exhausted schedule budgets',t=>{
 const f=setup(t),a=args(START,{timing:{...args().timing,rule:{kind:'once',at:START},max_occurrences:1}}),s=f.triggers.create(a);f.triggers.tick();f.complete();f.triggers.tick();assert.equal(f.triggers.get(s.id).status,'closed');
 assert.throws(()=>f.triggers.create({...a,event_id:'another-model-call'}),/SOURCE_ALREADY_USED/);
 const moreContext=[...source,{...source[0],message_id:'new-explicit-request'}];const next=f.triggers.create({...a,event_id:'new-user-event',source:moreContext});assert.notEqual(next.id,s.id);
});
test('deadline does not erase a needs-review batch or its failed run',t=>{
 const f=setup(t),s=f.triggers.create(args());f.triggers.tick();const job=f.jobs.claim(caps,caps);f.jobs.fail(job,'WORKER_FAILED');f.advance(91*DAY);f.triggers.tick();
 assert.equal(f.triggers.get(s.id).status,'closed');assert.equal(f.jobs.get(job.id).status,'needs_review');assert.equal(f.jobs.db.prepare('SELECT status FROM runs WHERE id=?').get(job.run_id).status,'failed');
});
