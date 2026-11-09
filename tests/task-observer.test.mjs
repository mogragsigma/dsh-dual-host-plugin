import test from 'node:test';
import assert from 'node:assert/strict';
import {setup,contract,start,finish,sample,update,observe,notices,bind,own,policy} from './helpers/observation-fixture.mjs';
import {validateObserver,TaskObserver} from '../bundle/task-observer.js';
const view=(f,id)=>f.g.observer.view(id),row=(f,id)=>f.g.store.db.prepare('SELECT * FROM task_observations WHERE task_id=?').get(id);

test('optional observer config is bounded, explicit model authorization; disabled creates nothing',t=>{
 for(const c of [{enabled:1},{enabled:true,intervalMs:0},{enabled:true,windowMs:0},{enabled:true,diagnostics:{enabled:true}},{enabled:true,diagnostics:{enabled:true,policy,maxRequests:1,endAt:1,extra:true}}])assert.throws(()=>validateObserver(c),/CONFIG_INVALID/);
 validateObserver(undefined);validateObserver({enabled:false});const f=setup(t,{observation:{enabled:false}});assert(!f.g.observer);assert.equal(f.sideEffects.model,0);
});
test('idle is not failure; unobserved state unknown; status and read transport observation do not collide',async t=>{
 const f=setup(t),id=await contract(f,'status');assert.equal(view(f,id).kind,'unknown');observe(f);assert.equal(view(f,id).kind,'checking');
 const direct=await f.g.call('status',{task_id:id}),read=await f.g.observedCall('status',{task_id:id});assert.equal(direct.task_observation.kind,'checking');assert.equal(read.task_observation.kind,'checking');assert.equal(read.observation.authority,'cloud');assert.equal(read.task_observation.grants_execution,false);
});
test('healthy native activity/background remains quiet; activity is not substantive progress',async t=>{
 const f=setup(t),id=await contract(f,'active'),r=start(f);
 for(const s of [{active:true},{tools:1},{background:true}]){sample(f,r,s);observe(f);assert.equal(view(f,id).kind,'running');f.advance(3000);}
 assert.equal(notices(f).length,0);assert.equal(f.sideEffects.model,0);assert.equal(view(f,id).evidence.semantic_progress,'not_attested');
});
test('two spaced observations exclude transient idle, no fake progress from activity counter alone',async t=>{
 const f=setup(t),id=await contract(f,'idle'),r=start(f);sample(f,r);observe(f);observe(f);assert.equal(view(f,id).kind,'checking');
 f.advance(2000);sample(f,r,{activity:999});observe(f);assert.equal(view(f,id).kind,'suspected');assert.equal(notices(f).length,0);assert.equal(f.g.execution.get(id).state,'running');assert.equal(f.g.execution.slots.snapshot().held,1);
});
test('missing/stale telemetry and lease contact loss are unknown, never stopped or released',async t=>{
 const f=setup(t),id=await contract(f,'offline'),r=start(f);observe(f);assert.equal(view(f,id).reason,'activity_unavailable');sample(f,r);observe(f);f.advance(61000);observe(f);assert.equal(view(f,id).kind,'unknown');assert.equal(view(f,id).reason,'contact_lost');f.advance(2000);observe(f);assert.equal(view(f,id).kind,'unknown');assert.equal(f.g.execution.slots.snapshot().held,1);assert.equal(f.g.execution.get(id).state,'running');
});
test('telemetry cannot arrive on a forged claim and invalid data never interrupts execution',async t=>{
 const f=setup(t),id=await contract(f,'auth'),r=start(f);
 assert.throws(()=>f.g.execution.validate('cloud',{...own(r),claim:'fake',observation:{active:true}}),/CLAIM_DENIED/);assert(!f.g.store.db.prepare('SELECT * FROM task_observation_samples').get());
 assert.equal(f.g.execution.validate('cloud',{...own(r),observation:{active:true,tools:-1}}).valid,true);assert(!f.g.store.db.prepare('SELECT * FROM task_observation_samples').get());
});
test('periodic wait, occupied cwd and cloud capacity are quiet legitimate waits',async t=>{
 const f=setup(t),period=await contract(f,'period',{period_seconds:60}),r=start(f);finish(f,r);observe(f);assert.equal(view(f,period).reason,'schedule');
 for(let i=0;i<3;i++){await contract(f,'busy'+i);start(f);}
 const queued=await contract(f,'queued');observe(f);assert.equal(view(f,queued).reason,'capacity');const held=f.g.execution.slots.list()[0];update(f,queued,{spec:JSON.stringify({...JSON.parse(f.g.execution.get(queued).spec),cwd:JSON.parse(held.resources)[0].slice(4)})});observe(f);assert.equal(view(f,queued).reason,'resource');assert.equal(notices(f).length,0);
});
test('pause/stop wins over diagnosis; unresolved failure cannot resume or cause repeated notices',async t=>{
 const f=setup(t),id=await contract(f,'pause');await bind(f,id);update(f,id,{state:'needs_review',error:'TASK_EXECUTION_FAILED'});observe(f);assert.equal(notices(f).length,1);const episode=row(f,id).episode;
 f.g.continuity.control('cloud',f.control(id,'pause'));assert.equal(view(f,id).reason,'paused');observe(f);assert.equal(row(f,id).episode,episode);
 assert.throws(()=>f.g.continuity.control('cloud',f.control(id,'resume')),/TASK_EXECUTION_RESUME_NOT_READY/);assert.equal(f.g.continuity.state(id).state,'paused');observe(f);assert.equal(notices(f).length,1);f.g.continuity.control('cloud',f.control(id,'stop'));assert.equal(view(f,id).reason,'stopped');
});
test('stable failure is deduped, recovery quiet, later recurrence is a new episode',async t=>{
 const f=setup(t),id=await contract(f,'episodes');await bind(f,id);update(f,id,{state:'needs_review',error:'TASK_EXECUTION_FAILED'});observe(f);const first=row(f,id).episode;
 for(let i=0;i<4;i++){f.advance(3000);observe(f);}assert.equal(notices(f).length,1);update(f,id,{state:'idle'});observe(f);assert.equal(notices(f).length,1);update(f,id,{state:'needs_review'});observe(f);assert.equal(row(f,id).episode,first+1);assert.equal(notices(f).length,2);
});
test('new result is emitted once; historical settled results are not replayed on first observation',async t=>{
 const f=setup(t),id=await contract(f,'result');await bind(f,id);const r=start(f);observe(f);finish(f,r);observe(f);observe(f);assert.equal(notices(f).filter(x=>x.category==='result').length,1);
 const observer=f.g.observer;f.g.observer=undefined;const old=await contract(f,'historical');await bind(f,old);finish(f,start(f));f.g.observer=observer;observe(f);assert.equal(notices(f).filter(x=>x.task_id===old).length,0);
});
test('waiting for an answer uses current question; repeated checks do not notify again',async t=>{
 const f=setup(t),id=await contract(f,'question');await bind(f,id);finish(f,start(f),{outcome:'waiting',summary:'需要确认读者'});observe(f);observe(f);assert.equal(view(f,id).kind,'waiting');assert.equal(view(f,id).detail,'需要确认读者');assert.equal(notices(f).length,1);
});
test('freshness degrades honestly and a stopped observer never controls the task',async t=>{
 const f=setup(t),id=await contract(f,'stale'),r=start(f);sample(f,r,{active:true});observe(f);const before=f.g.execution.get(id);f.advance(4000);assert.equal(view(f,id).stale,true);assert.equal(view(f,id).kind,'unknown');assert.deepEqual(f.g.execution.get(id),before);await f.g.observer.close();observe(f);assert.equal(row(f,id).observed_at,100000);
});
test('bounded cursor processes 50 per tick and source failure does not block other tasks',async t=>{
 const f=setup(t);for(let i=0;i<52;i++)await contract(f,'page-'+i);observe(f);assert.equal(f.g.store.db.prepare('SELECT count(*) n FROM task_observations').get().n,50);observe(f);assert.equal(f.g.store.db.prepare('SELECT count(*) n FROM task_observations').get().n,52);
 const facts=f.g.observer.facts.bind(f.g.observer);f.g.observer.facts=()=>{throw Error('synthetic');};observe(f);assert.equal(f.g.observer.lastError,'TASK_OBSERVER_SOURCE_UNAVAILABLE');f.g.observer.facts=facts;observe(f);assert.equal(f.g.observer.lastError,null);assert.equal(f.sideEffects.agents,0);
});
test('observer only writes observation/notification records, not contracts/inputs/budgets/approval/control',async t=>{
 const f=setup(t),id=await contract(f,'readonly'),r=start(f);sample(f,r);const tables=['managed_executions','managed_slots','managed_budgets','managed_model_requests','task_inputs'];const snap=()=>JSON.stringify(tables.map(n=>f.g.store.db.prepare('SELECT * FROM '+n).all()));const before=snap();const control=f.g.continuity.state(id),approvals=f.g.approvals.list(id);observe(f);f.advance(2000);observe(f);assert.equal(snap(),before);assert.deepEqual(f.g.continuity.state(id),control);assert.deepEqual(f.g.approvals.list(id),approvals);assert.equal(f.sideEffects.agents,0);
});
test('diagnosis once per episode and stale completion cannot overwrite current task/control',async t=>{
 const f=setup(t),id=await contract(f,'diagnose');observe(f);f.advance(2000);let calls=0,resolve;f.g.observer.review={run:()=>{calls++;return new Promise(r=>resolve=r);},dispose(){}};observe(f);assert.equal(calls,1);observe(f);assert.equal(calls,1);
 f.g.continuity.control('cloud',f.control(id,'pause'));resolve({summary:'待核对',missing_evidence:'缺报告',suggestion:'先看已有成果'});await f.g.observer.pending;assert.equal(row(f,id).diagnostic_state,'unavailable');assert.equal(row(f,id).diagnostic,null);observe(f);assert.equal(calls,1);
});
test('failed/unknown diagnosis and persisted pending after restart never automatically retry',async t=>{
 const f=setup(t),id=await contract(f,'unknown');let calls=0;f.g.observer.review={run:async()=>{calls++;throw Error('timeout');},dispose(){}};observe(f);f.advance(2000);observe(f);await f.g.observer.pending;observe(f);assert.equal(calls,1);assert.equal(row(f,id).diagnostic_state,'unavailable');
 f.g.store.db.prepare("UPDATE task_observations SET diagnostic_state='pending' WHERE task_id=?").run(id);const restart=new TaskObserver(f.g,{enabled:true});assert.equal(row(f,id).diagnostic_state,'unavailable');await restart.close();
});

test('fast completion between observation ticks is delivered once using bounded dirty IDs',async t=>{const f=setup(t),id=await contract(f,'fast');await bind(f,id);finish(f,start(f));observe(f);assert.equal(notices(f).length,1);observe(f);assert.equal(notices(f).length,1);assert.equal(f.g.store.db.prepare('SELECT count(*) n FROM task_observation_dirty').get().n,0);});
