import test from 'node:test';
import assert from 'node:assert/strict';
import {routingFixture,positive,model} from './helpers/source-routing-fixture.mjs';
import {sourceThread} from '../bundle/source-routing.js';
import {parseEnvelope} from '../bundle/task-envelope.js';
import {validateAssessment} from '../bundle/source-assessment.js';
const decisions=f=>f.r.status().decisions,tasks=f=>f.g.store.db.prepare('SELECT * FROM tasks').all();

test('SR09/SR10 reception alone and off never assess or create a worker/task',async t=>{
 const f=routingFixture(t);f.push();assert.equal(tasks(f).length,0);await f.r.tick();assert.equal(f.calls,0);assert.equal(tasks(f).length,0);assert.equal(decisions(f)[0].status,'ignored');assert.equal(f.sideEffects.agents,0);
});
test('SR11 observe records would-accept without new task, execution or notification',async t=>{
 const f=routingFixture(t);f.save();f.mode('observe');f.push();await f.r.tick();assert.equal(f.calls,1);assert.equal(decisions(f)[0].status,'observed');assert.equal(decisions(f)[0].result.would_accept,true);assert.equal(tasks(f).length,0);assert.equal(f.g.execution.slots.snapshot().held,0);
});
test('SR12 auto accepts a policy-origin task with native unlimited execution, not an owner message',async t=>{
 const f=routingFixture(t);f.save();f.mode('auto');f.push();await f.r.tick();assert.equal(tasks(f).length,1);const task=tasks(f)[0],e=parseEnvelope(f.g.catalog.head(task.id).goal);
 assert.equal(e.origin.kind,'policy');assert.equal(e.origin.session_id,undefined);assert.equal(e.source_events[0].kind,'source-data');assert.equal(e.task_context.sources[0].text,f.r.latest('copy-policy').confirmation.text);
 const ex=f.g.execution.get(task.id);assert.equal(JSON.parse(ex.authority).kind,'proactive-policy');assert.equal(f.g.execution.budgets.view(task.id).max_requests,null);assert.equal(f.g.execution.budgets.view(task.id).end_at,null);assert.equal(ex.state,'queued');assert.equal(f.sideEffects.agents,0);
});
test('SR01/SR15 public acceptance rejects forged policy origin, while direct user task is independent of off',async t=>{
 const f=routingFixture(t);const manual=await f.create();f.save();f.mode('auto');f.push();await f.r.tick();const id=decisions(f)[0].result.task_id,goal=f.g.catalog.head(id).goal;
 await assert.rejects(f.g.call('accept',{goal,task_key:'forged',ingress_id:'forged',source:'native-cloud'},'cloud'),/INTERNAL_ONLY/);
 f.mode('off');assert.equal(f.g.execution.authority(f.g.execution.get(manual)).kind,'direct-user-task');
});
test('SR02/SR04 filtered scopes, unknown actors, unlisted bots and independent IDs',async t=>{
 const f=routingFixture(t);f.save({max_tasks:5});f.mode('auto');f.push('filtered',{scope:'elsewhere'});f.push('unknown',{actor:{id:'x',kind:'unknown'}});f.push('bot',{actor:{id:'bot',kind:'bot'}});await f.r.tick();assert.equal(f.calls,0);
 f.push('first',{thread:{id:'one'}});f.push('same-text-new-id',{thread:{id:'two'}});await f.r.tick();assert.equal(tasks(f).length,2);assert.equal(f.r.status().policies[0].used,2);
});
test('SR03 duplicate delivery returns original task; conflicting same event is never overwritten',async t=>{
 const f=routingFixture(t);f.save();f.mode('auto');f.push('same');await f.r.tick();const task=tasks(f)[0].id;f.push('same');await f.r.tick();assert.equal(tasks(f).length,1);assert.equal(tasks(f)[0].id,task);assert.equal(f.calls,1);
 assert.throws(()=>f.push('same',{text:'different'}),/EVENT_CONFLICT/);
});
test('SR05/SR07 own-thread human source followup goes to same task; all handbacks keep original identity',async t=>{
 const f=routingFixture(t);f.save();f.mode('auto');f.push('first');await f.r.tick();const task=tasks(f)[0].id,r=f.begin();f.finish(r);
 f.push('second');await f.r.tick();assert.equal(tasks(f).length,1);assert.equal(f.calls,1);let inputs=f.g.continuity.read(task).items;assert.equal(inputs.length,1);assert.equal(inputs[0].source.kind,'source-data');assert.equal(f.g.execution.get(task).human,0);
 const run=f.begin();f.g.execution.inputs('cloud',f.binding(run));f.g.continuity.handback({task_id:task,run_id:run.claim},{input_id:inputs[0].event_id,reason:'outside original wording task'});f.finish(run);await f.r.tick();assert.equal(f.calls,2);assert.equal(tasks(f).length,2);
});
test('SR06 reference/bot data cannot resume ended work or earn human priority',async t=>{
 const f=routingFixture(t),id=await f.create();f.finish(f.begin());f.ctl({action:'attach',source_id:'fixture',thread_id:'thread-1',task_ids:[id],link_mode:'reference'});
 f.push('ref');await f.r.tick();assert.equal(f.g.execution.get(id).state,'idle');assert.equal(f.g.continuity.read(id).items.length,0);
 f.ctl({action:'attach',source_id:'fixture',thread_id:'thread-1',task_ids:[id],link_mode:'follow'});f.push('bot',{actor:{kind:'bot',id:'ci'}});await f.r.tick();assert.equal(f.g.execution.get(id).state,'idle');assert.equal(f.g.execution.get(id).human,0);
});
test('SR07 two owners must both hand back before an event is evaluated',async t=>{
 const f=routingFixture(t),a=await f.create('a'),b=await f.create('b');f.save();f.mode('auto');f.ctl({action:'attach',source_id:'fixture',thread_id:'thread-1',task_ids:[a,b],link_mode:'follow'});f.push();await f.r.tick();assert.equal(f.calls,0);
 const x=f.begin(),y=f.begin();for(const r of [x,y])f.g.execution.inputs('cloud',f.binding(r));const input=f.g.continuity.read(a).items[0].event_id;
 f.g.continuity.handback({task_id:x.task_id,run_id:x.claim},{input_id:input,reason:'not mine'});await f.r.tick();assert.equal(f.calls,0);
 f.g.continuity.handback({task_id:y.task_id,run_id:y.claim},{input_id:input,reason:'not mine'});await f.r.tick();assert.equal(f.calls,1);
});
test('SR08/SR13 unavailable is not no-demand; failure is bounded and independent events proceed',async t=>{
 const f=routingFixture(t,{assess:async({event})=>{if(event.id==='bad')throw Error('SOURCE_ASSESSMENT_INVALID_JSON');return positive(event);}});f.save();f.mode('observe');f.push('bad');f.push('good',{thread:{id:'other'}});await f.r.tick();assert.equal(decisions(f)[0].status,'unavailable');assert.equal(decisions(f)[1].status,'observed');
 f.advance(5001);await f.r.tick();f.advance(5001);await f.r.tick();const calls=f.calls;f.advance(10000);await f.r.tick();assert.equal(f.calls,calls);assert.equal(decisions(f)[0].attempts,3);
});
test('SR14 stale assessment after mode change cannot accept; manual worker remains valid',async t=>{
 let release,entered;const start=new Promise(r=>entered=r),wait=new Promise(r=>release=r);const f=routingFixture(t,{assess:async({event})=>{entered();await wait;return positive(event);}});const manual=await f.create();f.save();f.mode('auto');f.push();const run=f.r.tick();await start;f.mode('off');release();await run;assert.equal(tasks(f).length,1);assert.equal(f.g.execution.authority(f.g.execution.get(manual)).kind,'direct-user-task');
});
test('SR15 tool-free assessment validates all rules, target and implementation intent',()=>{
 const result=positive({id:'e',text:'source data'}).assessment;assert.equal(validateAssessment(result,['copy']).decision,'accept');
 for(const a of [{...result,rules:[]},{...result,target_settled:false},{...result,requires_design_decision:true},{...result,implementation_requested:false}])assert.throws(()=>validateAssessment(a,['copy']),/ASSESSMENT_INVALID/);
});
test('SR16/SR17 atomic task, grant and counter roll back on enqueue failure; original source persists',async t=>{
 const f=routingFixture(t);f.save();f.mode('auto');f.push();const start=f.g.execution.start;f.g.execution.start=()=>{throw Error('TASK_EXECUTION_FIXTURE_FAILURE');};await f.r.tick();assert.equal(tasks(f).length,0);assert.equal(f.r.used('copy-policy','first'),0);assert.equal(f.port.status().stored,1);
 f.g.execution.start=start;f.advance(5001);await f.r.tick();assert.equal(tasks(f).length,1);assert.equal(f.r.used('copy-policy','first'),1);
});
test('SR18 total counts newly accepted tasks, not followup/observation/model calls; no automatic reset',async t=>{
 const f=routingFixture(t);f.save({max_tasks:1});f.mode('auto');f.push();await f.r.tick();const id=tasks(f)[0].id;f.push('next',{thread:{id:'different'}});await f.r.tick();assert.equal(f.calls,1);assert.equal(tasks(f).length,1);
 f.save({max_tasks:1,goal:'same period edited'},{accepted_effect:'keep_accepted'});assert.equal(f.r.used('copy-policy','first'),1);
 assert.throws(()=>f.save({period_id:'different',max_tasks:1},{accepted_effect:'keep_accepted'}),/PERIOD_CONFLICT/);
 f.ctl({action:'new_period',expected_revision:2,accepted_effect:'keep_accepted',policy:f.config({period_id:'second',max_tasks:1})});assert.equal(f.r.used('copy-policy','second'),0);assert.equal(f.g.execution.get(id).state,'queued');
});
test('SR19 unlimited model ledger remains unlimited on a policy task, beyond former caps/time',async t=>{
 const f=routingFixture(t);f.save();f.mode('auto');f.push();await f.r.tick();const r=f.begin();for(let i=0;i<250;i++)f.g.execution.reserve('cloud',{...f.binding(r),policy:model,purpose:'root'});
 for(let i=0;i<400;i++){f.advance(20000);f.g.execution.validate('cloud',f.binding(r));}assert.equal(f.g.execution.budgets.view(r.task_id).used,250);assert.equal(f.g.execution.budgets.view(r.task_id).max_requests,null);
});
test('SR20 explicit business deadline fences dependent tasks only',async t=>{
 const f=routingFixture(t);f.save({end_at:f.g.now()+60000});f.mode('auto');f.push();await f.r.tick();const id=tasks(f)[0].id,manual=await f.create();f.advance(60001);await f.r.tick();assert.equal(f.g.continuity.state(id).state,'paused');assert.equal(f.g.continuity.state(manual).state,'active');
});
test('SR21 mode downgrade does not revoke or prevent an already accepted task from running',async t=>{
 const f=routingFixture(t);f.save();f.mode('auto');f.push();await f.r.tick();f.mode('off');const r=f.begin();assert(r);f.finish(r);f.g.continuity.receive('local',f.input(r.task_id,f.source('继续原目标','local')));assert.equal(f.begin().task_id,r.task_id);
});
test('SR22 source disable fences intake and fresh source processing but not independent stored work',async t=>{
 const f=routingFixture(t);f.save();f.mode('auto');f.push();await f.r.tick();const id=tasks(f)[0].id;f.ctl({action:'source',source_id:'fixture',enabled:false,expected_revision:0});assert.throws(()=>f.push(),/DISABLED/);assert.throws(()=>f.r.assertSource('fixture'),/DISABLED/);assert.equal(f.begin().task_id,id);assert.equal(f.g.legacy,null);
});
test('SR23/SR24 revoke fences queue, begin, validation and resume; active claims stay held until drain',async t=>{
 const f=routingFixture(t);f.save();f.mode('auto');f.push('first',{thread:{id:'one'}});f.push('second',{thread:{id:'two'}});await f.r.tick();const r=f.begin(),held=f.g.execution.slots.snapshot().held;
 const receipt=f.ctl({action:'revoke',policy_id:'copy-policy',expected_revision:1});assert.equal(receipt.effect.status,'draining-or-endpoint-unconfirmed');assert.equal(f.claim(),null);assert.throws(()=>f.g.execution.validate('cloud',f.binding(r)),/TASK_PAUSED|POLICY_REVOKED/);assert.equal(f.g.execution.slots.snapshot().held,held);
 f.g.execution.finish('cloud',{...f.binding(r),outcome:'interrupted',summary:'drained',session_id:'managed-original',drained:true});assert.equal(f.r.effect().status,'effective');assert.throws(()=>f.g.continuity.control('local',f.control(r.task_id,'resume',f.source('继续','local'))),/POLICY_REVOKED/);
});
test('SR25 explicitly adopting a drained policy task removes dependency without resuming or IM approval',async t=>{
 const f=routingFixture(t);f.save();f.mode('auto');f.push();await f.r.tick();const id=tasks(f)[0].id;f.ctl({action:'revoke',policy_id:'copy-policy',expected_revision:1});f.ctl({action:'adopt_task',task_id:id,expected_revision:1});assert.equal(f.g.continuity.state(id).state,'paused');f.g.continuity.control('local',f.control(id,'resume',f.source('恢复我接管的任务','local')));assert.equal(f.begin().task_id,id);
});
test('SR26 reenable skips old candidates and never revives stopped tasks',async t=>{
 const f=routingFixture(t);f.save();f.push('old');f.mode('auto');await f.r.tick();assert.equal(tasks(f).length,0);f.push('new');await f.r.tick();const id=tasks(f)[0].id;f.g.continuity.control('local',f.control(id,'stop',f.source('停止','local')));f.mode('off');f.mode('auto');f.push('follow');await f.r.tick();assert.equal(f.g.continuity.state(id).state,'stopped');assert.equal(f.g.execution.get(id).state,'fenced');assert.equal(tasks(f).length,1);
});
test('SR27 source followup uses ordinary slots; only direct user followup may use the extra slot',async t=>{
 const f=routingFixture(t);f.save();f.mode('auto');f.push('first');await f.r.tick();const old=f.begin();f.finish(old);
 for(let i=0;i<3;i++){await f.create('manual'+i);assert(f.begin());}
 f.push('follow');await f.r.tick();assert.equal(f.claim(),null);assert.equal(f.g.execution.get(old.task_id).human,0);
 f.g.continuity.receive('local',f.input(old.task_id,f.source('本人继续跟进','local')));assert.equal(f.begin().task_id,old.task_id);assert.equal(f.g.execution.slots.snapshot().held,4);
});
test('SR30 source controls are idempotent, versioned, Host-provenance only; querying never asserts live transport',t=>{
 const f=routingFixture(t),s=f.source('确认这份策略');const a={action:'set_policy',policy:f.config(),expected_revision:0,source:s};const one=f.r.control(s.role,a),two=f.r.control(s.role,a);assert.equal(one.operation_id,two.operation_id);assert.equal(two.historical_receipt,true);
 assert.throws(()=>f.r.control(s.role,{...a,policy:f.config({max_tasks:5})}),/CONTROL_CONFLICT/);assert.throws(()=>f.r.control(s.role,{...a,source:{...s,kind:'bot'}}),/ORIGIN_MISMATCH/);
 assert.equal(f.r.status().live_source_verified,false);assert.equal(f.r.status().sources[0].transport,'not-attached');assert.equal(f.g.sourceRouting.base('fixture').id,'fixture');assert.match(sourceThread('fixture','t'),/^source-thread:/);
});

test('mode cutover preserves a saved follow input but does not replay an unrelated candidate',async t=>{
 const f=routingFixture(t);f.save();f.mode('auto');f.push();await f.r.tick();const r=f.begin();f.finish(r);f.push('follow');f.push('backlog',{thread:{id:'other'}});f.mode('off');await f.r.tick();assert.equal(f.calls,1);assert.equal(tasks(f).length,1);assert.equal(f.g.continuity.read(r.task_id).items.length,1);assert.equal(f.g.execution.get(r.task_id).human,0);
});
test('source reenable skips unprocessed transport backlog even on an existing thread',async t=>{
 const f=routingFixture(t);f.save();f.mode('auto');f.push();await f.r.tick();const r=f.begin();f.finish(r);f.push('backlog');f.ctl({action:'source',source_id:'fixture',enabled:false,expected_revision:0});f.ctl({action:'source',source_id:'fixture',enabled:true,expected_revision:1});await f.r.tick();assert.equal(f.g.continuity.read(r.task_id).items.length,0);assert.equal(f.g.execution.get(r.task_id).state,'idle');
});
test('maintenance observes pending assessment; closing aborts without waiting for a broken adapter',async t=>{
 let entered;const start=new Promise(r=>entered=r);const f=routingFixture(t,{assess:()=>{entered();return new Promise(()=>{});}});f.save();f.mode('observe');f.push();const job=f.r.tick();await start;assert.equal(f.g.maintenance.status().canHold,false);await f.r.close();await job;assert.equal(f.g.maintenance.status().canHold,true);assert.equal(tasks(f).length,0);
});
test('SR16/SR17 restart preserves source cursor, task identity and period total',async t=>{
 const {mkdtempSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path');const root=mkdtempSync(join(tmpdir(),'source-reopen-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const f=routingFixture(t,{fixture:{root}});f.save();f.mode('auto');f.push();await f.r.tick();const id=tasks(f)[0].id;await f.g.close();const again=routingFixture(t,{fixture:{root}});await again.r.tick();assert.equal(tasks(again).length,1);assert.equal(tasks(again)[0].id,id);assert.equal(again.r.used('copy-policy','first'),1);assert.equal(again.calls,0);assert.equal(again.port.status().stored,1);await again.g.close();
});
test('policy editing requires an explicit choice for already accepted tasks',async t=>{
 const f=routingFixture(t);f.save();f.mode('auto');f.push();await f.r.tick();const id=tasks(f)[0].id;assert.throws(()=>f.save({goal:'updated'}),/CONTROL_CONFLICT/);f.save({goal:'updated'},{accepted_effect:'revoke_accepted'});assert.equal(f.g.continuity.state(id).state,'paused');assert.throws(()=>f.r.assertTask(id),/REVOKED/);assert.equal(f.r.used('copy-policy','first'),1);
});

test('SR24 revocation blocks pending dispatch but preserves already accepted receipt',async t=>{
 const {targets,bind}=await import('./helpers/observation-fixture.mjs');const f=routingFixture(t,{fixture:{notificationTargets:targets}});f.save();f.mode('auto');f.push();await f.r.tick();const id=tasks(f)[0].id;await bind(f,id);const b=f.g.db.prepare('SELECT * FROM notification_bindings WHERE task_id=?').get(id);
 for(const [n,state,message] of [['pending','queued',null],['done','accepted','synthetic-prior-message']])f.g.db.prepare('INSERT INTO task_notifications(id,task_id,binding_revision,target_key,host,route_hash,category,text,state,due,created,message_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(n,id,b.revision,b.target_key,'cloud',b.route_hash,'result','fixture',state,0,0,message);
 const lease=f.g.notifications.lease('cloud').items[0];assert(lease);f.ctl({action:'revoke',policy_id:'copy-policy',expected_revision:1});assert.equal(f.g.notifications.authorize('cloud',lease).allowed,false);assert.equal(f.g.notifications.lease('cloud').items.length,0);const prior=f.g.db.prepare("SELECT * FROM task_notifications WHERE id='done'").get();assert.equal(prior.state,'accepted');assert.equal(prior.message_id,'synthetic-prior-message');
});
test('missing internal grant fails closed; native tools cannot invent a source adapter',async t=>{
 const f=routingFixture(t);f.save();f.mode('auto');f.push();await f.r.tick();const id=tasks(f)[0].id;f.g.store.db.prepare('DELETE FROM source_routing_tasks WHERE task_id=?').run(id);assert.throws(()=>f.g.execution.authority(f.g.execution.get(id)),/POLICY_REQUIRED/);assert(!f.tools.has('task_source_ingest'));assert(!f.tools.has('task_source_bind'));assert(f.tools.has('task_source_control'));assert(f.tools.has('task_source_status'));
});
