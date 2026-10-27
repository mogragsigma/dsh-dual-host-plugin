import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {TaskJobs} from '../bundle/task-jobs.js';
import {TaskScheduler} from '../bundle/task-scheduler.js';
function fixture(t){const root=mkdtempSync(tmpdir()+'/dsh-jobs-');let now=100000,s=new TaskJobs(root,()=>now);t.after(()=>{s.close();rmSync(root,{recursive:true,force:true});});return {root,get s(){return s;},advance(n){now+=n;},reopen(){s.close();s=new TaskJobs(root,()=>now);return s;}};}
const input=(x={})=>({task_id:'task-test',trigger_id:'one',goal:'只读规划',policy:{provider:'chosen',model:'chosen-model'},...x});
const capabilities=new Set(['plan','test.checkpoint']);
test('durable schedule is idempotent despite clock change; changed model/trigger body conflicts',t=>{
 const f=fixture(t),a=f.s.enqueue(input({delay_seconds:60}));f.advance(3000);assert.equal(f.s.enqueue(input({delay_seconds:60})).id,a.id);
 assert.throws(()=>f.s.enqueue(input({delay_seconds:61})),/TRIGGER_CONFLICT/);assert.throws(()=>f.s.enqueue(input({delay_seconds:60,policy:{provider:'x',model:'y'}})),/TRIGGER_CONFLICT/);
 assert.equal(f.reopen().get(a.id).status,'queued');assert.equal(f.s.claim(capabilities,capabilities),null);f.advance(60000);assert.equal(f.s.claim(capabilities,capabilities).id,a.id);
});
test('reasoning effort survives restart, participates in idempotency and exact proposal scope',t=>{
 const f=fixture(t),policy={provider:'chosen',model:'chosen-model',reasoningEffort:'low'},a=f.s.enqueue(input({policy}));
 assert.deepEqual(JSON.parse(f.reopen().get(a.id).policy),policy);
 assert.throws(()=>f.s.enqueue(input({policy:{...policy,reasoningEffort:'high'}})),/TRIGGER_CONFLICT/);
 assert.throws(()=>f.s.enqueue(input({trigger_id:'bad',policy:{...policy,reasoningEffort:3}})),/INVALID_MODEL_POLICY/);
});
test('checkpoint commits before durable wait; releases claim and restarts a separate session',t=>{
 const f=fixture(t),a=f.s.enqueue(input());const first=f.s.claim(capabilities,capabilities);const waiting=f.s.finish(first,{outcome:'checkpoint',summary:'verified stage one',delay_seconds:3600});assert.equal(waiting.status,'waiting');
 f.reopen();f.s.recover(capabilities);assert.equal(f.s.claim(capabilities,capabilities),null);f.advance(3600000);const next=f.s.claim(capabilities,capabilities);assert.notEqual(next.session_id,first.session_id);assert.equal(JSON.parse(next.checkpoint).summary,'verified stage one');assert.equal(next.attempts,2);
 f.s.finish(next,{outcome:'done',summary:'planning complete'});assert.equal(f.s.get(a.id).status,'completed');
});
test('interrupted readonly batch replays from checkpoint; stale process cannot commit',t=>{
 const f=fixture(t);f.s.enqueue(input());const old=f.s.claim(capabilities,capabilities);f.reopen();f.s.recover(capabilities);const next=f.s.claim(capabilities,capabilities);
 assert.notEqual(next.claim,old.claim);assert.throws(()=>f.s.finish(old,{outcome:'done',summary:'late'}),/STALE_JOB_CLAIM/);assert.equal(f.s.get(old.id).attempts,2);
});
test('approval is bound to exact proposal; restart, timers, pause/resume and duplicate controls cannot bypass',t=>{
 const f=fixture(t);f.s.enqueue(input());const j=f.s.claim(capabilities,capabilities),p=f.s.finish(j,{outcome:'proposal',summary:'plan ready',proposal:'Implement feature A, no publish'});
 f.reopen();f.s.recover(capabilities);f.advance(999999);assert.equal(f.s.claim(capabilities,capabilities),null);
 assert.throws(()=>f.s.control({id:j.id,action:'resume',event_id:'bypass',actor:'owner'}),/RESUME_NOT_ALLOWED/);
 assert.throws(()=>f.s.control({id:j.id,action:'pause',event_id:'bypass',actor:'owner'}),/CONTROL_NOT_ALLOWED/);
 assert.throws(()=>f.s.control({id:j.id,action:'approve',event_id:'wrong',actor:'owner',proposal_hash:'0'.repeat(64)}),/APPROVAL_SCOPE_MISMATCH/);
 const args={id:j.id,action:'approve',event_id:'human:1',actor:'owner',proposal_hash:p.proposal_hash};assert.equal(f.s.control(args).status,'waiting_capability');assert.deepEqual(f.s.control(args),{id:j.id,status:'waiting_capability'});
 assert.throws(()=>f.s.control({...args,proposal_hash:'changed'}),/CONTROL_CONFLICT/);assert.equal(f.s.claim(capabilities,capabilities),null);
});
test('development job cannot claim without approval even if an executor were registered',t=>{
 const f=fixture(t),j=f.s.enqueue(input({kind:'development'}));assert.equal(j.status,'waiting_approval');
 f.s.db.prepare("UPDATE jobs SET status='queued' WHERE id=?").run(j.id);assert.equal(f.s.claim(new Set(['development']),new Set()),null);assert.equal(f.s.get(j.id).status,'waiting_approval');
});
test('unknown capability/version and non-replay-safe crash are held, never guessed complete',t=>{
 const f=fixture(t),j=f.s.enqueue(input({kind:'development'}));f.s.db.prepare("UPDATE jobs SET status='running' WHERE id=?").run(j.id);f.s.recover(capabilities);assert.equal(f.s.get(j.id).status,'needs_review');
 const a=f.s.enqueue(input({trigger_id:'version'}));f.s.db.prepare("UPDATE jobs SET version='future' WHERE id=?").run(a.id);assert.equal(f.s.claim(capabilities,capabilities),null);assert.equal(f.s.get(a.id).error,'VERSION_MISMATCH');
});
test('pause/cancel invalidate active claims; explicit resume is durable and bounded',t=>{
 const f=fixture(t);f.s.enqueue(input());const j=f.s.claim(capabilities,capabilities);f.s.control({id:j.id,action:'pause',event_id:'pause',actor:'owner'});
 assert.throws(()=>f.s.finish(j,{outcome:'done',summary:'late'}),/STALE_JOB_CLAIM/);assert.equal(f.s.claim(capabilities,capabilities),null);
 f.s.control({id:j.id,action:'resume',event_id:'resume',actor:'owner'});const next=f.s.claim(capabilities,capabilities);f.s.control({id:j.id,action:'cancel',event_id:'cancel',actor:'owner'});
 assert.throws(()=>f.s.finish(next,{outcome:'done',summary:'late'}),/STALE_JOB_CLAIM/);assert.equal(f.s.claim(capabilities,capabilities),null);
});
test('run budget prevents perpetual checkpoint loops and crash replay',t=>{
 const f=fixture(t);f.s.enqueue(input({max_runs:1}));const j=f.s.claim(capabilities,capabilities);assert.equal(f.s.finish(j,{outcome:'checkpoint',summary:'needs more time',delay_seconds:1}).status,'needs_review');
 assert.equal(f.s.get(j.id).error,'RUN_BUDGET_EXHAUSTED');assert.equal(f.s.claim(capabilities,capabilities),null);
});
test('same task serializes; another task can be claimed; delayed jobs do not consume slots',t=>{
 const f=fixture(t);f.s.enqueue(input());f.s.enqueue(input({trigger_id:'two'}));f.s.enqueue(input({trigger_id:'three',task_id:'other'}));
 const a=f.s.claim(capabilities,capabilities),b=f.s.claim(capabilities,capabilities);assert.notEqual(a.task_id,b.task_id);assert.equal(f.s.claim(capabilities,capabilities),null);
});
test('result notification is durable, unique per run, and shares checkpoint transaction',t=>{
 const f=fixture(t);f.s.enqueue(input());const j=f.s.claim(capabilities,capabilities);f.s.finish(j,{outcome:'proposal',summary:'ready',proposal:'only plan'});
 assert.equal(f.s.db.prepare('SELECT count(*) n FROM job_notifications').get().n,1);f.reopen();assert.equal(f.s.db.prepare('SELECT count(*) n FROM job_notifications').get().n,1);
 assert.throws(()=>f.s.finish(j,{outcome:'proposal',summary:'again',proposal:'different'}),/STALE_JOB_CLAIM/);
});
test('scheduler process lock refuses second consumer before recovery and preserves active claim',async t=>{
 const root=mkdtempSync(tmpdir()+'/dsh-scheduler-'),a=new TaskScheduler({on(){}}, {stateDir:root,lockPort:0,intervalMs:60000},{allowEphemeralLock:true});let b;
 t.after(async()=>{await b?.close();await a.close();rmSync(root,{recursive:true,force:true});});await a.start();const j=a.jobs.enqueue(input());a.jobs.claim(capabilities,capabilities);
 b=new TaskScheduler({on(){}}, {stateDir:root,lockPort:a.lock.address().port});await assert.rejects(b.start(),e=>e.code==='EADDRINUSE');assert.equal(a.jobs.get(j.id).status,'running');
});
test('scheduler is nonblocking; cooperative cancellation revokes reports and clears active slot',async t=>{
 const root=mkdtempSync(tmpdir()+'/dsh-scheduler-');const s=new TaskScheduler({on(){}}, {stateDir:root,lockPort:0,intervalMs:60000,timeoutMs:1000},{allowEphemeralLock:true});t.after(async()=>{await s.close();rmSync(root,{recursive:true,force:true});});
 await s.start();s.register('test.checkpoint',{replaySafe:true,run:async(j,signal)=>{await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));return {outcome:'done',summary:'late'};}});
 const j=s.jobs.enqueue(input({kind:'test.checkpoint'}));s.tick();await new Promise(r=>setImmediate(r));assert.equal(s.active.size,1);assert.equal(s.jobs.get(j.id).status,'running');
 s.control({id:j.id,action:'cancel',event_id:'cancel',actor:'owner'});await Promise.all([...s.active.values()].map(x=>x.run));assert.equal(s.active.size,0);assert.equal(s.jobs.get(j.id).status,'cancelled');
});
test('synchronously throwing executor cannot leave a permanent active slot',async t=>{
 const root=mkdtempSync(tmpdir()+'/dsh-scheduler-');const s=new TaskScheduler({on(){}}, {stateDir:root,lockPort:0,intervalMs:60000},{allowEphemeralLock:true});t.after(async()=>{await s.close();rmSync(root,{recursive:true,force:true});});await s.start();
 s.register('test.checkpoint',{replaySafe:true,run(){throw Error('test');}});const j=s.jobs.enqueue(input({kind:'test.checkpoint'}));s.tick();await Promise.all([...s.active.values()].map(x=>x.run));assert.equal(s.active.size,0);assert.equal(s.jobs.get(j.id).status,'needs_review');
});
