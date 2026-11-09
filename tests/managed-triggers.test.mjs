import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {fixture} from './helpers/continuity-fixture.mjs';
import {CLOUD_TASK_POLICY} from '../bundle/managed-cloud-policy.js';
import {makeEnvelope} from '../bundle/task-envelope.js';
import {ManagedTriggers} from '../bundle/managed-triggers.js';
import {validateTiming,firstDue,coalesceDue} from '../bundle/task-trigger-time.js';
import {CAPABILITIES,requireCapability} from '../bundle/link-contract.js';
const policy={provider:'fixture',model:'fixture'},binding=r=>({task_id:r.task_id,claim:r.claim,instance_id:r.instance});
function setup(t){const f=fixture(t,{managedExecution:{enabled:true}});f.g.ctx.llm.resolveCallConfig=async()=>policy;return f;}
async function create(f,name,channel='local-dsh'){
 const role=channel==='cloud-im'?'cloud':'local',agent=f.agent('entry-'+name,'任务 '+name+'：资料到齐后开始；同批不要重复。');
 const e=makeEnvelope(agent,role,{goal:name,target:'cloud',intent:'register',continuity:1,execution_policy:CLOUD_TASK_POLICY,channel}),r=await f.g.call('accept',{...e,source:'native-'+role},role);
 const cwd=join(f.dir,name);mkdirSync(cwd);return {id:r.id,cwd:realpathSync(cwd),agent};
}
const queue=(f,c,extra={})=>f.g.call('execution_start',{task_id:c.id,expected_revision:1,cwd:c.cwd,...extra},'local');
const claim=f=>f.g.execution.claim('cloud',{instance_id:'fixture-endpoint',development_contract:1,autonomy_contract:1}).item;
const begin=(f,r=claim(f))=>r&&f.g.execution.begin('cloud',binding(r)).item;
function finish(f,r,extra={}){const v=f.g.execution.validate('cloud',binding(r));return f.g.execution.finish('cloud',{...binding(r),outcome:'ready',summary:'已核对本轮结果',session_id:'managed-'+r.task_id,drained:true,completion:{input_cursor:v.input_cursor,control_version:v.control_version,round:r.runs},...extra});}
const schedule=(f,id)=>f.g.execution.schedules.list(id).at(-1);
const signal=(f,id,event='event-1',name='资料到齐')=>f.g.call('trigger_signal',{id,name,event_id:event,sources:[f.source('本人明确通知：'+name,'local',event)]},'local');
const eventPlan={schedule:{rule:{kind:'event',name:'资料到齐'}}};

test('once waits without creating workers, activates native cloud only and closes exactly once',async t=>{
 const f=setup(t),c=await create(f,'once');const q=await queue(f,c,{schedule:{rule:{kind:'once',at:f.g.now()+60000}}});
 assert.equal(q.state,'scheduled');assert.equal(claim(f),null);assert.equal(f.g.execution.slots.list().length,0);assert.deepEqual(f.sideEffects,{agents:0,model:0});
 f.advance(60000);const r=begin(f);assert.equal(r.task_id,c.id);assert.equal(r.trigger.rule.kind,'once');assert.equal(r.budget.max_requests,null);finish(f,r);assert.equal(claim(f),null);
 assert.equal(schedule(f,c.id).status,'closed');assert.equal(schedule(f,c.id).emitted,1);assert.equal(f.g.scheduler.jobs.list(c.id).length,0);
});
test('time AND exact dependency ready are required; prior failure/queue is not readiness',async t=>{
 const f=setup(t),a=await create(f,'upstream'),b=await create(f,'downstream');await queue(f,a);await queue(f,b,{schedule:{rule:{kind:'once',at:f.g.now()+60000},dependencies:[a.id]}});
 const r=begin(f);assert.equal(r.task_id,a.id);for(let i=0;i<3;i++){f.advance(20000);f.g.execution.validate('cloud',binding(r));}assert.equal(claim(f),null);
 // Keep the original run heartbeat valid rather than reviving an expired lease.
});
test('dependency completion plus due time releases one downstream round',async t=>{
 const f=setup(t),a=await create(f,'parent'),b=await create(f,'child');await queue(f,a);await queue(f,b,{schedule:{rule:{kind:'once',at:f.g.now()+60000},dependencies:[a.id]}});
 finish(f,begin(f));assert.equal(claim(f),null);f.advance(60000);const r=begin(f);assert.equal(r.task_id,b.id);finish(f,r);assert.equal(claim(f),null);
});
test('failed dependency, cancelled dependency and revision changes never masquerade as ready',async t=>{
 const f=setup(t),a=await create(f,'failed'),b=await create(f,'blocked');await queue(f,a);await queue(f,b,{schedule:{rule:{kind:'once',at:f.g.now()},dependencies:[a.id]}});
 finish(f,begin(f),{outcome:'failed'});assert.equal(claim(f),null);assert.equal(schedule(f,b.id).waiting_reason,'dependency_not_ready');
 await f.g.call('task_lifecycle',f.control(a.id,'stop',f.source('停止','local')),'local');assert.equal(claim(f),null);
});
test('unfinished occurrence resumes before newest missed interval; no backlog replay',async t=>{
 const f=setup(t),c=await create(f,'interval');await queue(f,c,{schedule:{rule:{kind:'interval',start_at:f.g.now(),every_seconds:60}}});
 const r=begin(f);finish(f,r,{outcome:'interrupted'});f.advance(300000);const resumed=begin(f);assert.equal(resumed.occurrence_id,r.occurrence_id);assert.equal(resumed.session_id,'managed-'+c.id);assert.equal(schedule(f,c.id).emitted,1);
 finish(f,resumed);const newest=begin(f);assert.notEqual(newest.occurrence_id,r.occurrence_id);assert.equal(newest.trigger.due,f.g.now());assert.equal(schedule(f,c.id).skipped,4);finish(f,newest);assert.equal(claim(f),null);
});
test('claimed but never started expiry keeps original occurrence, not another signal or round',async t=>{
 const f=setup(t),c=await create(f,'claim-expiry');await queue(f,c,eventPlan);const s=schedule(f,c.id);await signal(f,s.id);const first=claim(f);f.advance(30001);const second=claim(f);assert.notEqual(second.claim,first.claim);assert.equal(second.occurrence_id,first.occurrence_id);assert.equal(schedule(f,c.id).emitted,1);finish(f,begin(f,second));
});
test('distinct signals retain order and source; retry/reopen cannot duplicate or merge batches',async t=>{
 const f=setup(t),c=await create(f,'signals');await queue(f,c,eventPlan);const s=schedule(f,c.id);await signal(f,s.id,'batch-z');await signal(f,s.id,'batch-a');
 f.g.execution.schedules=new ManagedTriggers(f.g.execution);assert.equal((await signal(f,s.id,'batch-z')).status,'pending');
 const first=begin(f);assert.equal(first.trigger.event_id,'batch-z');assert.match(first.trigger.event_source[0].text,/本人明确通知/);finish(f,first);
 const second=begin(f);assert.equal(second.trigger.event_id,'batch-a');assert.equal(second.session_id,first.session_id??'managed-'+c.id);finish(f,second);assert.equal(claim(f),null);assert.equal((await signal(f,s.id,'batch-z')).status,'consumed');assert.equal(schedule(f,c.id).emitted,2);
});
test('followup alone never fires a signal plan or duplicates an accepted signal',async t=>{
 const f=setup(t),c=await create(f,'follow');await queue(f,c,eventPlan);f.g.continuity.receive('local',f.input(c.id,f.source('稍后会发资料到齐，现在仅补充限制','local')));assert.equal(claim(f),null);
 await signal(f,schedule(f,c.id).id);const r=begin(f);f.g.execution.inputs('cloud',binding(r));finish(f,r);assert.equal(claim(f),null);assert.equal(schedule(f,c.id).emitted,1);
});
test('pause retains queued signals without unpausing; resume processes them; stop cannot revive',async t=>{
 const f=setup(t),c=await create(f,'pause');await queue(f,c,eventPlan);const s=schedule(f,c.id);await signal(f,s.id,'before-pause');
 await f.g.call('task_lifecycle',f.control(c.id,'pause',f.source('暂停','local')),'local');assert.equal(claim(f),null);await assert.rejects(signal(f,s.id,'during-pause'),/SIGNAL_NOT_ACCEPTED/);
 f.advance(86400000);await f.g.call('task_lifecycle',f.control(c.id,'resume',f.source('继续','local')),'local');const r=begin(f);assert.equal(r.trigger.event_id,'before-pause');finish(f,r);
 await f.g.call('task_lifecycle',f.control(c.id,'stop',f.source('停止','local')),'local');await assert.rejects(signal(f,s.id,'after-stop'),/SIGNAL_NOT_ACCEPTED/);assert.equal(claim(f),null);assert.equal(schedule(f,c.id).status,'cancelled');
});
test('pause during an unfinished native round restores that occurrence, then newest time',async t=>{
 const f=setup(t),c=await create(f,'running-pause');await queue(f,c,{schedule:{rule:{kind:'interval',start_at:f.g.now(),every_seconds:60}}});const r=begin(f);
 await f.g.call('task_lifecycle',f.control(c.id,'pause',f.source('暂停','local')),'local');f.g.execution.finish('cloud',{...binding(r),outcome:'interrupted',summary:'已排空暂停',session_id:'managed-'+c.id,drained:true});f.advance(300000);
 await f.g.call('task_lifecycle',f.control(c.id,'resume',f.source('继续','local')),'local');const resumed=begin(f);assert.equal(resumed.occurrence_id,r.occurrence_id);finish(f,resumed);const next=begin(f);assert.notEqual(next.occurrence_id,r.occurrence_id);finish(f,next);
});
test('explicit deadline expires signals; no invented TTL or model call cap',async t=>{
 const f=setup(t),a=await create(f,'expiry'),b=await create(f,'no-expiry');await queue(f,a,{...eventPlan,end_at:f.g.now()+60000});await queue(f,b,eventPlan);
 await signal(f,schedule(f,a.id).id);f.advance(8000000);assert.equal(claim(f),null);assert.equal(schedule(f,a.id).status,'closed');assert.equal(schedule(f,b.id).timing.end_at,null);
 await signal(f,schedule(f,b.id).id,'no-expiry-event');const r=begin(f);assert.equal(r.task_id,b.id);for(let i=0;i<40;i++)f.g.execution.reserve('cloud',{...binding(r),policy,purpose:'fixture'});assert.equal(f.g.execution.budgets.view(b.id).max_requests,null);finish(f,r);
});
test('business occurrence count is explicit, signal overflow rejects visibly and does not reset model usage',async t=>{
 const f=setup(t),c=await create(f,'business-count');await queue(f,c,{schedule:{...eventPlan.schedule,max_occurrences:2}});const s=schedule(f,c.id);await signal(f,s.id,'one');await signal(f,s.id,'two');await assert.rejects(signal(f,s.id,'three'),/SIGNAL_NOT_ACCEPTED/);
 for(let i=0;i<2;i++){const r=begin(f);f.g.execution.reserve('cloud',{...binding(r),policy,purpose:'fixture'});finish(f,r);}assert.equal(claim(f),null);assert.equal(schedule(f,c.id).status,'closed');assert.equal(f.g.execution.budgets.view(c.id).used,2);
});
test('invalid plans fail atomically; legacy calls and model-cap knobs remain rejected',async t=>{
 const f=setup(t),c=await create(f,'invalid');for(const schedule of [{rule:{kind:'cron'}},{rule:{kind:'once',at:f.g.now()},max_runs:6},{rule:{kind:'event',name:'x'},dependencies:[c.id]},{rule:{kind:'event',name:'x'},dependencies:['missing']}])await assert.rejects(queue(f,c,{schedule}),/SCHEDULER_/);
 await assert.rejects(queue(f,c,{...eventPlan,period_seconds:60}),/SCHEDULE_INVALID/);assert.equal(f.g.execution.get(c.id),undefined);assert.equal(f.g.store.db.prepare('SELECT count(*) n FROM task_schedules').get().n,0);
 for(const method of ['schedule','trigger_create','workflow_create'])await assert.rejects(f.g.call(method,{task_id:c.id}),/DIRECT_PATH_REQUIRED/);
});
test('execution start replay after its time passed cannot reset occurrences or restart a closed plan',async t=>{
 const f=setup(t),c=await create(f,'replay'),plan={schedule:{rule:{kind:'once',at:f.g.now()}}};await queue(f,c,plan);finish(f,begin(f));f.advance(100000);assert.equal(claim(f),null);await queue(f,c,plan);assert.equal(claim(f),null);assert.equal(schedule(f,c.id).emitted,1);
 await assert.rejects(queue(f,c,eventPlan),/REVISION_REQUIRED/);
});
test('signal route validates exact source origin/name, preserves conflict and requires task lifecycle',async t=>{
 const f=setup(t),c=await create(f,'source');await queue(f,c,eventPlan);const s=schedule(f,c.id);await assert.rejects(f.g.call('trigger_signal',{id:s.id,name:'资料到齐',event_id:'forged',sources:[f.source('资料到齐','cloud')]},'local'),/CONTEXT_ORIGIN_MISMATCH/);
 await assert.rejects(f.g.call('trigger_signal',{id:s.id,name:'资料到齐',event_id:'missing',sources:[f.source('普通消息','local')]},'local'),/SIGNAL_NOT_IN_USER_CONTEXT/);
 await signal(f,s.id,'stable');await assert.rejects(signal(f,s.id,'stable','其他'),/EVENT_CONFLICT/);await assert.rejects(f.g.call('trigger_control',{id:s.id,action:'resume'}),/USE_TASK_LIFECYCLE/);
 assert.equal((await f.g.call('trigger_list',{task_id:c.id})).items[0].execution,'native-cloud');
});
test('weekly supports years without iteration cap, same DST wall-time policy; old timing remains bounded',()=>{
 const now=Date.parse('2026-10-18T08:00:00Z'),t=validateTiming({rule:{kind:'weekly',start_at:now,weekday:7,hour:1,minute:30,timezone:'America/New_York'}},now,{native:true});assert.equal(t.end_at,null);assert.equal(t.max_occurrences,null);
 const latest=Date.parse('2030-11-04T12:00:00Z'),slot=coalesceDue(t.rule,firstDue(t.rule),latest,null);assert.equal(new Date(slot.due).toISOString(),'2030-11-03T05:30:00.000Z');assert(slot.skipped>200);
 assert.throws(()=>validateTiming({rule:t.rule},now),/RULE_INVALID/);
});
test('new schedule contract requires advertised capability, not successful SSH/older peer',()=>{
 const a={schema:1,protocol:{min:1,max:1},plugin_version:'0.34.0-alpha.2',role:'local',namespace:'test',instance_id:'12345678-1234-1234-1234-123456789abc',capabilities:CAPABILITIES},b={...a,role:'cloud',capabilities:{...CAPABILITIES}};delete b.capabilities.managed_triggers;
 assert.throws(()=>requireCapability('execution_start',a,b,eventPlan),/CAPABILITY_VERSION_INCOMPATIBLE/);assert.throws(()=>requireCapability('trigger_signal',a,b,{id:'schedule-native-example'}),/CAPABILITY_VERSION_INCOMPATIBLE/);
});

test('native-only cloud without legacy scheduler exposes signal and list through negotiated protocol',async t=>{
 const f=fixture(t,{managedExecution:{enabled:true},scheduler:false});f.g.ctx.llm.resolveCallConfig=async()=>policy;const c=await create(f,'no-legacy');await queue(f,c,eventPlan);assert.equal(f.g.scheduler,undefined);
 const own={...f.g.hello(),role:'local'};assert.equal(f.g.hello().capabilities.triggers,1);assert.equal(f.g.hello().capabilities.managed_triggers,1);const s=(await f.g.call('trigger_list',{task_id:c.id})).items[0];requireCapability('trigger_signal',own,f.g.hello(),{id:s.id});await signal(f,s.id);finish(f,begin(f));assert.equal(claim(f),null);
});
test('closed business plan allows explicit result followup without creating another scheduled occurrence',async t=>{
 const f=setup(t),c=await create(f,'closed-follow');await queue(f,c,{schedule:{rule:{kind:'once',at:f.g.now()}}});finish(f,begin(f));assert.equal(claim(f),null);assert.equal(f.g.execution.get(c.id).state,'idle');
 f.g.continuity.receive('local',f.input(c.id,f.source('修改刚才的成果表达','local')));const r=begin(f);assert.equal(r.occurrence_id,null);f.g.execution.inputs('cloud',binding(r));finish(f,r);assert.equal(schedule(f,c.id).emitted,1);assert.equal(claim(f),null);assert.equal(f.g.execution.view(c.id).state,'idle');
});
test('waiting schedule observation is quiet and native queue never reads a nonexistent approval/capped budget',async t=>{
 const {TaskObserver}=await import('../bundle/task-observer.js');const f=setup(t);f.g.observer=new TaskObserver(f.g,{enabled:true});const c=await create(f,'observe');await queue(f,c,eventPlan);assert.equal(claim(f),null);
 const o=f.g.observer.facts(f.g.execution.get(c.id));assert.equal(o.kind,'waiting');assert.equal(o.notify,false);assert.equal(o.reason,'waiting_event');await signal(f,schedule(f,c.id).id);f.g.execution.reconcile();assert.equal(f.g.observer.facts(f.g.execution.get(c.id)).reason,'awaiting_dispatch');assert.equal(f.g.store.db.prepare('SELECT count(*) n FROM approval_requests').get().n,0);
});
test('contract amendment cannot silently discard an unresolved occurrence',async t=>{
 const f=setup(t),c=await create(f,'unsettled');await queue(f,c,eventPlan);await signal(f,schedule(f,c.id).id);const r=begin(f);finish(f,r,{outcome:'waiting'});
 await assert.rejects(queue(f,c,{...eventPlan,end_at:f.g.now()+60000}),/SCHEDULE_OCCURRENCE_UNSETTLED/);assert.equal(schedule(f,c.id).emitted,1);assert.equal(f.g.execution.get(c.id).occurrence_id,r.occurrence_id);
});
test('schedule activation transaction rolls back on injected failure, restart then activates once',async t=>{
 const f=setup(t),c=await create(f,'transaction');await queue(f,c,eventPlan);const s=schedule(f,c.id);await signal(f,s.id);const audit=f.g.execution.schedules.audit.bind(f.g.execution.schedules);f.g.execution.schedules.audit=()=>{throw Error('synthetic transaction interruption');};assert.throws(()=>claim(f),/synthetic/);
 assert.equal(schedule(f,c.id).emitted,0);assert.equal((await signal(f,s.id)).status,'pending');assert.equal(f.g.execution.get(c.id).occurrence_id,null);
 f.g.execution.schedules.audit=audit;f.g.execution.schedules=new ManagedTriggers(f.g.execution);const r=begin(f);assert.equal(schedule(f,c.id).emitted,1);finish(f,r);assert.equal(claim(f),null);
});

test('three approved creation channels all accept the same native plan without IM grants',async t=>{
 const f=setup(t);for(const channel of ['local-dsh','local-im','cloud-im']){const c=await create(f,'entry-'+channel,channel);await queue(f,c,eventPlan);assert.equal(schedule(f,c.id).execution,'native-cloud');assert.equal(f.g.execution.view(c.id).budget.max_requests,null);}assert.equal(claim(f),null);assert.equal(f.g.store.db.prepare('SELECT count(*) n FROM approval_requests').get().n,0);
});
test('dependency revision drift blocks activation; cycles are rejected before altering the plan',async t=>{
 const f=setup(t),a=await create(f,'cycle-a'),b=await create(f,'cycle-b');await queue(f,a);await queue(f,b,{schedule:{...eventPlan.schedule,dependencies:[a.id]}});
 assert.throws(()=>f.g.execution.schedules.prepare(a.id,{schedule:{...eventPlan.schedule,dependencies:[b.id]}},null),/DEPENDENCY_CYCLE/);
 const head=f.g.catalog.head.bind(f.g.catalog);f.g.catalog.head=id=>id===a.id?{...head(id),spec_revision:2}:head(id);await signal(f,schedule(f,b.id).id);assert.equal(f.g.execution.schedules.dependenciesReady(f.g.execution.schedules.current(b.id)),false);assert.equal(schedule(f,b.id).waiting_reason,'dependency_revision_changed');f.g.catalog.head=head;
});
test('authenticated DirectLink can start and signal native-only cloud plan without a legacy scheduler',async t=>{
 const {Gateway}=await import('../bundle/index.js');const f=fixture(t,{managedExecution:{enabled:true},scheduler:false});f.g.ctx.llm.resolveCallConfig=async()=>policy;const c=await create(f,'wire');f.g.c.port=33041;await f.g.start();
 const local=new Gateway(f.g.ctx,{role:'local',entryMode:'native',namespace:f.g.c.namespace,stateDir:join(f.dir,'local'),peerEnabled:false,continuity:{enabled:true},managedExecution:{enabled:true},coordinatorUrl:'http://127.0.0.1:33041'},{secrets:{localToken:'l'.repeat(32),cloudToken:'c'.repeat(32)}});t.after(()=>local.close());
 const q=await local.call('execution_start',{task_id:c.id,expected_revision:1,cwd:c.cwd,...eventPlan});assert.equal(q.state,'scheduled');const s=(await local.call('trigger_list',{task_id:c.id})).items[0];
 await local.call('trigger_signal',{id:s.id,name:'资料到齐',event_id:'wire-signal',sources:[f.source('本人通知资料到齐','local')]});const r=begin(f);assert.equal(r.trigger.event_id,'wire-signal');finish(f,r);assert.equal((await local.call('execution_status',{task_id:c.id})).runs,1);
});

test('changing other execution fields cannot reset the same-revision plan or lose accepted signals',async t=>{
 const f=setup(t),c=await create(f,'rebind');await queue(f,c,eventPlan);const s=schedule(f,c.id);await signal(f,s.id,'retained');
 await assert.rejects(queue(f,c,{...eventPlan,end_at:f.g.now()+60000}),/REVISION_REQUIRED/);assert.equal((await signal(f,s.id,'retained')).status,'pending');
 const head=f.g.catalog.head.bind(f.g.catalog);f.g.catalog.head=id=>id===c.id?{...head(id),spec_revision:2}:head(id);
 await assert.rejects(queue(f,c,{...eventPlan,expected_revision:2}),/SIGNALS_UNSETTLED/);f.g.catalog.head=head;
 assert.equal(f.g.execution.get(c.id).revision,1);assert.equal(schedule(f,c.id).id,s.id);assert.equal((await signal(f,s.id,'retained')).status,'pending');finish(f,begin(f));
});

test('native weekly plan uses wall time and coalesces missed weeks to the latest occurrence',async t=>{
 const f=setup(t),c=await create(f,'weekly');await queue(f,c,{schedule:{rule:{kind:'weekly',start_at:f.g.now(),weekday:4,hour:0,minute:2,timezone:'UTC'}}});assert.equal(claim(f),null);f.advance(20000);const r=begin(f);assert.equal(r.trigger.due,120000);finish(f,r);
 f.advance(3*7*86400000+30000);const latest=begin(f);assert.equal(latest.trigger.due,120000+3*7*86400000);assert.equal(schedule(f,c.id).skipped,2);finish(f,latest);assert.equal(claim(f),null);
});
test('scheduled occurrences keep three ordinary slots and only an existing followup earns the fourth',async t=>{
 const f=setup(t);for(let i=0;i<4;i++){const c=await create(f,'slots-'+i);await queue(f,c,eventPlan);await signal(f,schedule(f,c.id).id,'slots-'+i);}
 const held=[begin(f),begin(f),begin(f)];assert(held.every(Boolean));assert.equal(claim(f),null);const waiting=held.shift();finish(f,waiting,{outcome:'waiting'});held.push(begin(f));assert.equal(claim(f),null);
 f.g.continuity.receive('local',f.input(waiting.task_id,f.source('补充本轮缺少的资料','local')));const extra=begin(f);assert.equal(extra.task_id,waiting.task_id);assert.equal(f.g.execution.slots.list().length,4);assert.equal(claim(f),null);f.g.execution.inputs('cloud',binding(extra));finish(f,extra);for(const r of held)finish(f,r);assert.equal(f.g.execution.slots.list().length,0);
});
