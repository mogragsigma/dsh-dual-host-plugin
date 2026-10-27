import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setup,plan,fakeCommands,result} from './workspace-fixture.mjs';
import {proposal} from './approval-fixture.mjs';
import {TaskJobs} from '../bundle/task-jobs.js';
import {TaskJobs as PriorJobs} from './fixtures/v021-alpha5/task-jobs.js';
import {DevelopmentRuntime} from '../bundle/development-runtime.js';
import {DevelopmentModelBudget} from '../bundle/development-model-budget.js';
import {TaskArtifacts} from '../bundle/task-artifacts.js';
import {developmentSnapshot} from '../bundle/task-board-development.js';
import {apply as toolsApply} from '../bundle/development-tools.js';
import {CAPABILITIES,requireCapability,errorInfo} from '../bundle/link-contract.js';

async function native(t,{max=12,behavior,policy=proposal.model_policy,selectedSpec,commands=fakeCommands}={}){
 const spec=selectedSpec??plan();spec.max_model_requests=max;const f=await setup(t,{selectedSpec:spec}),jobs=new TaskJobs(join(f.dir,'native-jobs'),f.ledger.now);t.after(()=>jobs.close());
 let requestHook,streamHook,guard,disposed=false,prompt;const tools=new Map(),denied=[];
 const agent={id:'task-worker-'+randomUUID(),session:{},ctx:{tools:{restrict(x){assert.deepEqual(x.allow,['skill','development_workspace_read','development_workspace_write','development_workspace_command','development_report']);}},on(n,fn){if(n==='agent/request')requestHook=fn;}},followup(m){prompt=m;},cancel(){},async whenIdle(){await behavior?.({f,agent,model,call,stream,policy});}};
 const ctx={on(n,fn){if(n==='llm/stream')streamHook=fn;},agents:{get:id=>id===agent.id?agent:null,withoutInitiator:fn=>fn(),create:async o=>{await o.setup(agent.ctx);assert.deepEqual(o.agentOptions,{...policy,maxTokens:2048});return {agent,dispose:async()=>{disposed=true;}};}},agentPresets:{mount:async()=>{}},sessions:{flush:async()=>{}}};
 const g={ctx,c:{role:'cloud',stateDir:join(f.dir,'artifact-state')},store:f.store,catalog:f.catalog,approvals:f.ledger,repositories:f.repos,scheduler:{jobs},now:f.ledger.now,closed:false};g.artifacts=new TaskArtifacts(g);t.after(()=>g.artifacts.close());
 const runtime=g.development=new DevelopmentRuntime(g,{enabled:true,bindings:f.bindings});
 // Unit-only adapter injection; no production path bypasses Linux constructor.
 runtime.workspaceEnabled=true;runtime.gate.commands=commands;f.runtime=runtime;
 toolsApply({taskGateway:g,inject(_n,fn){fn({systemPrompt:{context(){}}});},tools:{register(t){tools.set(t.name,t);},guard(fn){guard=fn;}}});
 const call=async(name,args={})=>{const e={agent,callId:randomUUID(),signal:new AbortController().signal,name};const reason=guard(e);if(reason){denied.push(reason);throw Error(reason);}return tools.get(name).execute(args,e);};
 const stream=async(parts=[{type:'finish',reason:{kind:'tool-calls'}}],overrides={})=>{for await(const _ of streamHook({sessionId:agent.id,...policy,maxTokens:2048,...overrides},()=>typeof parts==='function'?parts():(async function*(){yield* parts;})())){};};
 const model=async(parts,overrides={})=>{await requestHook({},async()=>({...policy,...overrides}));await stream(parts,overrides);};
 const scheduled=await runtime.schedule({task_id:f.task.id,approval_id:f.req.id,model_policy:policy},{workspace:true});
 const job=jobs.claim(new Set(['development']),new Set(),j=>runtime.canClaim(j));assert.equal(job.id,scheduled.job_id);assert.equal(job.version,'0.22.0');
 return {...f,g,jobs,job,agent,call,model,stream,observed:()=>({disposed,prompt,denied}),run:()=>runtime.run(job,new AbortController().signal)};
}
const complete=async({call})=>{
 let r=await call('development_workspace_read');assert(r.commands.length===2);assert(!JSON.stringify(r).includes('README.md'));
 r=await call('development_workspace_write',{path:'docs/report.md',action:'write',content:'# general plan result',base_version:r.base_version});
 r=await call('development_workspace_write',{path:'src/remove.txt',action:'delete',base_version:r.base_version});
 await call('development_workspace_command',{command_id:'build'});await call('development_workspace_command',{command_id:'test'});await call('development_report',{summary:'Explicit native API fixture, not a live model.'});
};
test('native workspace worker uses approved task goal, restricted tools and authoritative report',async t=>{
 const f=await native(t,{behavior:async c=>{await c.model();await complete(c);}}),r=await f.run();assert.equal(r.outcome,'done');assert(f.observed().disposed);
 assert.match(f.observed().prompt.content[0].text,/任务原文/);assert(!f.observed().prompt.content[0].text.includes('实现 ES module 导出的 summarize'));
 assert.equal(f.runtime.modelBudget.view(f.runtime.requestFor(f.job).id).used,1);
 const item=f.g.artifacts.list(f.task.id).items[0];assert.equal(item.state,'pending_run');f.jobs.finish(f.job,r);f.runtime.finished(f.job);
 assert.equal(f.g.artifacts.list(f.task.id).items[0].state,'needs_verification');const data=f.g.artifacts.readLocal(f.g.artifacts.load(f.task.id,item.id)).bytes.toString();assert(data.includes('workspace_sha256')&&data.includes('model_budget'));
});
test('old tools, raw shell and cross-kind operations are denied in workspace worker',async t=>{
 const f=await native(t,{behavior:async({call})=>{for(const name of ['bash','development_write','development_read','development_test'])await assert.rejects(call(name,{}),/CAPABILITY_DENIED/);await complete({call});}});await f.run();assert.equal(f.observed().denied.length,4);
});
test('workspace write rejects null unions, unknown fields and command overrides',async t=>{
 const f=await native(t,{behavior:async({call})=>{const r=await call('development_workspace_read');
  await assert.rejects(call('development_workspace_write',{path:'docs/report.md',action:'write',content:null,base_version:r.base_version}),/INVALID_WRITE/);
  await assert.rejects(call('development_workspace_write',{path:'src/remove.txt',action:'delete',content:'',base_version:r.base_version}),/INVALID_WRITE/);
  await assert.rejects(call('development_workspace_command',{command_id:'build',argv:['bad']}),/INVALID_REQUEST/);await complete({call});}});await f.run();
});
test('provider/model/effort cannot silently change; mismatch makes zero reservations/writes',async t=>{
 for(const mismatch of [{model:'other'},{provider:'other'},{reasoningEffort:'high'}]){const f=await native(t,{behavior:async c=>c.model(undefined,mismatch)});await assert.rejects(f.run(),/MODEL_MISMATCH/);assert.equal(f.g.store.db.prepare('SELECT count(*) n FROM development_model_requests').get().n,0);assert.equal(f.g.store.db.prepare('SELECT count(*) n FROM development_writes').get().n,0);}
});
test('retry stream dispatches consume durable budget even without another agent request',async t=>{
 const f=await native(t,{max:2,behavior:async c=>{await c.model([{type:'finish',reason:{kind:'error',failure:{code:'RATE_LIMIT',message:'secret'}}}]);await c.stream([{type:'finish',reason:{kind:'tool-calls'}}]);await assert.rejects(c.stream(),/MODEL_BUDGET/);await complete(c);}});await f.run();
 const rows=f.g.store.db.prepare('SELECT state,code FROM development_model_requests').all();assert.deepEqual(rows.map(x=>x.state),['failed','succeeded']);assert(!JSON.stringify(rows).includes('secret'));
 const reopened=new DevelopmentModelBudget(f.runtime.gate,f.jobs);assert.equal(reopened.view(f.runtime.requestFor(f.job).id).used,2);
});
test('auxiliary model is denied before dispatch and cannot evade accounting',async t=>{
 const f=await native(t,{behavior:async c=>{await assert.rejects(c.stream(undefined,{purpose:'session-title'}),/AUX_MODEL_DENIED/);await complete(c);}});await f.run();assert.equal(f.g.store.db.prepare('SELECT count(*) n FROM development_model_requests').get().n,0);
});
test('missing finish and thrown transport retain unknown/failed reservations; no refund',async t=>{
 const f=await native(t,{behavior:async c=>{await c.model([{type:'text-delta',text:'fixture'}]);await assert.rejects(c.stream(async function*(){throw Object.assign(Error('secret'),{code:'ABORTED'});}));await complete(c);}});await f.run();assert.deepEqual(f.g.store.db.prepare('SELECT state FROM development_model_requests').all().map(x=>x.state),['unknown','failed']);
});
test('new schedule protocol requires exact capability; old intake still works',()=>{
 const h={schema:1,protocol:{min:1,max:1},plugin_version:'0.22.0-alpha.2',namespace:'fixture',instance_id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',capabilities:{...CAPABILITIES}},l={...h,role:'local'},r={...h,role:'cloud',capabilities:{...CAPABILITIES}};delete r.capabilities.development_workspace;
 assert.throws(()=>requireCapability('workspace_development_schedule',l,r),/CAPABILITY_UNAVAILABLE/);assert.doesNotThrow(()=>requireCapability('accept',l,r));
});
for(const running of [false,true])test('frozen 0.21 consumer holds 0.22 '+(running?'running':'queued')+' job without execution',async t=>{
 const f=await setup(t),dir=join(f.dir,'prior-jobs');let j=new TaskJobs(dir);const row=j.enqueue({task_id:f.task.id,trigger_id:'new',kind:'development',goal:'new plan',policy:proposal.model_policy,version:'0.22.0',max_runs:1});j.db.prepare("UPDATE jobs SET approved_by='fixture',status='queued' WHERE id=?").run(row.id);if(running)j.claim(new Set(['development']),new Set());j.close();j=new PriorJobs(dir);try{j.recover(new Set(['development']));assert.equal(j.claim(new Set(['development']),new Set(['development'])),null);assert.equal(j.get(row.id).status,'needs_review');assert.equal(j.get(row.id).attempts,running?1:0);}finally{j.close();}
});

test('reserved dispatch survives accounting reopen and cannot be refunded or settled twice',async t=>{
 const f=await native(t,{max:1}),id=f.runtime.requestFor(f.job).id;
 const args={purpose:'worker',...JSON.parse(f.job.policy),maxTokens:2048};
 const first=f.runtime.modelBudget.reserve(id,f.job,args);
 const reopened=new DevelopmentModelBudget(f.runtime.gate,f.jobs);
 assert.deepEqual(reopened.view(id).states,{reserved:1});assert.throws(()=>reopened.reserve(id,f.job,args),/MODEL_BUDGET/);
 reopened.settle(first.id,'unknown','INCOMPLETE_STREAM');assert.equal(reopened.view(id).used,1);
 assert.throws(()=>reopened.settle(first.id,'succeeded'),/ALREADY_SETTLED/);
 assert.throws(()=>reopened.reserve(id,{...f.job,claim:'stale'},args),/STALE_JOB_CLAIM/);
 assert.equal(errorInfo('DEVELOPMENT_MODEL_BUDGET').retry,'operator_review');
});

const repairSpec=max=>{const s=plan();s.files=[s.files.find(x=>x.path==='src/count.py')];s.reads=[];s.commands=[s.commands[1]];s.max_writes=max;s.max_commands=3;return s;};
const failingThenPassing=()=>{let count=0;return {async run(w,h,id,o){o.onCreated({id:'unit-container',name:'unit'});o.onClosed({code:count?0:1});return {...result(w,h,id,!!count++),output:'unit fixture only'};}};};
test('failed required command is retained and only a real later receipt on changed manifest permits report',async t=>{
 const f=await native(t,{selectedSpec:repairSpec(3),commands:failingThenPassing(),behavior:async({call})=>{
  let r=await call('development_workspace_read');r=await call('development_workspace_write',{path:'src/count.py',action:'write',content:'def total(a,b): return 0\n',base_version:r.base_version});
  const fail=await call('development_workspace_command',{command_id:'test'});assert.equal(fail.passed,false);
  await assert.rejects(call('development_report',{summary:'pretend done'}),/TEST_REQUIRED/);
  r=await call('development_workspace_write',{path:'src/count.py',action:'write',content:'def total(a,b): return a+b\n',base_version:r.base_version});
  await assert.rejects(call('development_report',{summary:'old result'}),/TEST_REQUIRED/);
  assert.equal((await call('development_workspace_command',{command_id:'test'})).passed,true);
  await call('development_report',{summary:'unit bounded repair'});
 }}),r=await f.run();f.jobs.finish(f.job,r);f.runtime.finished(f.job);
 const receipts=f.g.store.db.prepare('SELECT result FROM development_commands ORDER BY rowid').all().map(x=>JSON.parse(x.result));assert.deepEqual(receipts.map(x=>x.passed),[false,true]);assert.notEqual(receipts[0].file_hash,receipts[1].file_hash);
 assert.equal(f.g.store.db.prepare('SELECT count(*) n FROM development_attention').get().n,0);
});
test('budget exhaustion yields durable attention and failed checkpoint, not a success artifact or resume',async t=>{
 const f=await native(t,{selectedSpec:repairSpec(1),commands:failingThenPassing(),behavior:async({call})=>{
  const r=await call('development_workspace_read');await call('development_workspace_write',{path:'src/count.py',action:'write',content:'def total(a,b): return 0\n',base_version:r.base_version});
  await call('development_workspace_command',{command_id:'test'});
 }});let failure;try{await f.run();assert.fail('must not succeed');}catch(e){failure=e;}
 assert.equal(failure.message,'DEVELOPMENT_REPORT_REQUIRED');assert.equal(failure.developmentAttention.grants_execution,false);
 f.runtime.failed(f.job);f.jobs.fail(f.job,failure.message,failure.developmentAttention);
 const row=f.g.store.db.prepare('SELECT snapshot FROM development_attention').get(),a=JSON.parse(row.snapshot);
 assert.deepEqual(a.exhausted,['write']);assert.equal(a.test_passed_on_recorded_manifest,false);assert.equal(a.success_artifact,false);assert.equal(a.budget_reset,false);assert.match(a.summary,/写入预算/);assert.match(a.question,/重新审批/);
 assert.equal(f.g.artifacts.list(f.task.id).items.length,0);assert.equal(f.jobs.get(f.job.id).status,'needs_review');assert.match(JSON.parse(f.jobs.get(f.job.id).checkpoint).question,/原失败与消耗保留/);
 const event=JSON.parse(f.jobs.db.prepare("SELECT data FROM job_events WHERE type='failed'").get().data);assert.equal(event.summary,a.summary);assert.equal(event.question,a.question);
 const notice=f.jobs.db.prepare('SELECT text FROM job_notifications').get().text;assert(notice.includes(a.summary));
 const beforeRead=f.g.store.db.prepare('SELECT total_changes() n').get().n;const projection=developmentSnapshot(f.g,f.task.id,1);assert.equal(projection.items[0].attention.summary,a.summary);assert.equal(projection.items[0].attention.historical,false);assert.equal(f.g.store.db.prepare('SELECT total_changes() n').get().n,beforeRead);
 const again=f.runtime.attention.record(f.job,Error('secret different transport'));assert.deepEqual(again,a);assert.equal(f.g.store.db.prepare('SELECT count(*) n FROM development_attention').get().n,1);
 assert.throws(()=>f.jobs.control({id:f.job.id,action:'resume',event_id:'blind',actor:'operator'}),/RESUME_NOT_ALLOWED/);assert(f.g.store.task(f.task.id).blocked);
 f.runtime.recover();assert.equal(f.jobs.get(f.job.id).status,'needs_review');assert.equal(f.runtime.gate.progress(f.runtime.requestFor(f.job).id).write_budget.calls_used,1);
});
test('attention scrubs arbitrary errors, is not created for success, and rejects another run claim',async t=>{
 const f=await native(t,{behavior:async()=>{throw Error('PRIVATE_TOKEN=secret-url');}});await assert.rejects(f.run(),/PRIVATE_TOKEN/);
 const a=JSON.parse(f.g.store.db.prepare('SELECT snapshot FROM development_attention').get().snapshot);assert.equal(a.code,'DEVELOPMENT_WORKER_FAILED');assert(!JSON.stringify(a).includes('PRIVATE_TOKEN'));assert.deepEqual(a.exhausted,[]);
 assert.throws(()=>f.runtime.attention.record({...f.job,claim:'wrong'},Error('no')),/RUN_MISMATCH/);
 f.jobs.fail(f.job,'WORKER_FAILED',{schema:1,run_id:'wrong',summary:'fake',question:'fake',grants_execution:false});assert(!JSON.stringify(f.jobs.get(f.job.id).checkpoint).includes('fake'));
});
test('model exhaustion is preserved as an attention budget with zero fabricated test success',async t=>{
 const f=await native(t,{max:1,behavior:async({model})=>{await model();await model();}});await assert.rejects(f.run(),/MODEL_BUDGET/);
 const a=JSON.parse(f.g.store.db.prepare('SELECT snapshot FROM development_attention').get().snapshot);assert(a.exhausted.includes('model'));assert.equal(a.model_budget.used,1);assert.equal(a.test_passed_on_recorded_manifest,false);
});

test('command budget is diagnosed without refunding a failed command or trusting a model completion claim',async t=>{
 const spec=repairSpec(3);spec.max_commands=1;const f=await native(t,{selectedSpec:spec,commands:failingThenPassing(),behavior:async({call})=>{
  await call('development_workspace_command',{command_id:'test'});await call('development_workspace_command',{command_id:'test'});
 }});await assert.rejects(f.run(),/COMMAND_BUDGET/);
 const a=JSON.parse(f.g.store.db.prepare('SELECT snapshot FROM development_attention').get().snapshot);assert.deepEqual(a.exhausted,['command']);assert.equal(a.command_budget.used,1);assert.equal(a.previous_commands[0].passed,false);assert.equal(a.previous_commands[0].drained,true);assert.equal(f.g.artifacts.list(f.task.id).items.length,0);
});
