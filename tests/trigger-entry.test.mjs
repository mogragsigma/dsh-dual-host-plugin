import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {Gateway} from '../bundle/index.js';
import {registerNativeTools} from '../bundle/native-tools.js';
const policy={provider:'per-task',model:'not-a-fixed-glm',reasoningEffort:'medium'};
async function fixture(t){
 const root=mkdtempSync(tmpdir()+'/trigger-entry-'),tokenFile=root+'/tokens';writeFileSync(tokenFile,JSON.stringify({localToken:'l'.repeat(32),cloudToken:'c'.repeat(32)}),{mode:0o600});
 const agents=new Map(),ctx={on(){},effect(){},agents:{get:id=>agents.get(id),list:()=>[...agents.values()]},agentPresets:{composedPreset:c=>c.preset}};
 const cloud=new Gateway(ctx,{role:'cloud',entryMode:'native',namespace:'triggers',stateDir:root+'/cloud',tokenFile,port:0,scheduler:{lockPort:0,intervalMs:60000}},{scheduler:{allowEphemeralLock:true}});await cloud.start();
 const local=new Gateway(ctx,{role:'local',entryMode:'native',namespace:'triggers',stateDir:root+'/local',tokenFile,port:0,coordinatorUrl:'http://127.0.0.1:'+cloud.server.address().port});
 let currentRole='local';const messages=[],agent={id:'entry',ctx:{preset:'standard'},session:{deriveMessages:()=>messages}},tools=new Map();agents.set(agent.id,agent);
 const mount=role=>{currentRole=role;tools.clear();registerNativeTools({taskGateway:role==='local'?local:cloud,tools:{register:d=>tools.set(d.name,d)}});};mount('local');
 const message=(text,kind='user')=>messages.push({id:'m'+messages.length,role:'user',source:{kind},content:[{type:'text',text}]});message('请只读规划，每小时检查一次，一周内最多三次，每次最多两批；不开发。');
 let calls=0;const invoke=(name,args,callId='call-'+ ++calls)=>tools.get(name).execute(args,{agent,callId});
 const submit=(intent='plan')=>invoke('task_submit',{goal:'scheduled readonly task',title:'触发回归',target:'cloud',intent,...(intent==='plan'?{model_policy:policy}:{})});
 const timing=()=>({rule:{kind:'interval',start_at:Date.now()+60000,every_seconds:3600},end_at:Date.now()+7*86400000,max_occurrences:3,max_runs:2});
 const create=(task,extra={})=>invoke('task_trigger_create',{task_id:task.task_id,expected_revision:1,model_policy:policy,timing:timing(),...extra});
 t.after(async()=>{await local.close();await cloud.close();rmSync(root,{recursive:true,force:true});});return {cloud,local,agent,tools,invoke,submit,create,timing,message,mount,get role(){return currentRole;}};
}
test('native local tool crosses authenticated RPC, preserves direct source, returns schedule and leaves ordinary session untouched',async t=>{
 const f=await fixture(t),task=await f.submit(),s=await f.create(task),state=await f.invoke('task_status',{task_id:task.task_id});
 assert.equal(s.execution,'readonly');assert.equal(s.development,false);assert.equal(state.schedules[0].id,s.id);assert.equal(state.jobs.length,0);assert.equal(f.cloud.scheduler.active.size,0);
 assert.deepEqual(s.model_policy,policy);const saved=f.cloud.scheduler.triggers.get(s.id);assert.match(JSON.parse(saved.source)[0].text,/每小时/);assert.equal(f.agent.ctx.preset,'standard');assert.equal(f.cloud.development,undefined);
});
test('registration-only, wrong model/revision, unbounded time and hidden write fields never create schedules',async t=>{
 const f=await fixture(t),task=await f.submit('register');await assert.rejects(f.create(task),/TASK_REGISTER_ONLY/);
 f.message('现在只读开始，按所选任务模型');const plan=await f.submit();await assert.rejects(f.create(plan,{model_policy:{...policy,model:'fallback'}}),/TASK_MODEL_POLICY_MISMATCH/);
 await assert.rejects(f.create(plan,{expected_revision:2}),/TASK_REVISION_CONFLICT/);
 await assert.rejects(f.create(plan,{timing:{...f.timing(),max_occurrences:99999}}),/SCHEDULER_RULE_INVALID/);
 assert.equal(f.cloud.scheduler.jobs.db.prepare('SELECT count(*) n FROM task_schedules').get().n,0);
});
test('older peer missing triggers capability fails explicitly without altering existing scheduler capability',async t=>{
 const f=await fixture(t),task=await f.submit(),hello=f.cloud.hello.bind(f.cloud);f.cloud.hello=()=>{const h=hello();delete h.capabilities.triggers;return h;};
 await assert.rejects(f.create(task),/CAPABILITY_UNAVAILABLE/);const job=await f.invoke('task_schedule',{task_id:task.task_id,provider:policy.provider,model:policy.model,reasoning_effort:policy.reasoningEffort,delay_seconds:600});assert.equal(job.status,'queued');
});
test('cloud can pause local-created schedule; pause does not bypass model/revision fence or enable unrelated single dispatch',async t=>{
 const f=await fixture(t),task=await f.submit(),s=await f.create(task);f.mount('cloud');f.message('暂停这个长期任务');const r=await f.invoke('task_trigger_control',{schedule_id:s.id,action:'pause'});assert.equal(r.status,'paused');
 await assert.rejects(f.invoke('task_schedule',{task_id:task.task_id,provider:policy.provider,model:policy.model,reasoning_effort:policy.reasoningEffort}),/SCHEDULER_ALREADY_EXISTS/);
 await assert.rejects(f.invoke('task_update',{task_id:task.task_id,expected_revision:1,summary:'修改目标'}),/TASK_NOT_QUIESCENT/);
 await f.invoke('task_trigger_control',{schedule_id:s.id,action:'cancel'});assert.equal((await f.invoke('task_update',{task_id:task.task_id,expected_revision:1,summary:'修改目标'})).spec_revision,2);
});
test('only named direct user event becomes a signal; repeated model calls for the same message are one event',async t=>{
 const f=await fixture(t),task=await f.submit(),s=await f.create(task,{timing:{...f.timing(),rule:{kind:'event',name:'资料到齐'}}});
 await assert.rejects(f.invoke('task_trigger_signal',{schedule_id:s.id,name:'资料到齐'}),/SCHEDULER_SIGNAL_NOT_IN_USER_CONTEXT/);
 f.message('资料到齐，请处理');const a=await f.invoke('task_trigger_signal',{schedule_id:s.id,name:'资料到齐'}),b=await f.invoke('task_trigger_signal',{schedule_id:s.id,name:'资料到齐'});assert.equal(a.event_id,b.event_id);
 f.cloud.scheduler.triggers.tick();const job=f.cloud.scheduler.jobs.db.prepare('SELECT * FROM jobs').get();assert.equal(job.version,'0.19.0');assert.equal(f.cloud.scheduler.triggers.context(job.id).event_source[0].text,'资料到齐，请处理');assert.equal(f.cloud.scheduler.active.size,0);
});
test('trusted context origin cannot be changed by the remote model; signal is not an approval RPC',async t=>{
 const f=await fixture(t),task=await f.submit();await assert.rejects(f.local.call('trigger_create',{task_id:task.task_id,expected_revision:1,policy,timing:f.timing(),event_id:'forged',sources:[{role:'cloud',session_id:'s',message_id:'m',text:'event',sha256:'bad'}]}),/INVALID_CONTEXT_SOURCE/);
 for(const method of ['trigger_approve','trigger_write','trigger_reset_budget','worker_report'])await assert.rejects(f.local.call(method,{}),/METHOD_DENIED/);
 assert.equal(f.cloud.store.snapshot().intents.length,0);
});
test('input from another entry resumes the same read-only budget and cannot alter task model or answer old question twice',async t=>{
 const f=await fixture(t),task=await f.submit(),r=await f.invoke('task_schedule',{task_id:task.task_id,provider:policy.provider,model:policy.model,reasoning_effort:policy.reasoningEffort}),jobs=f.cloud.scheduler.jobs;
 const j=jobs.claim(new Set(['plan']),new Set(['plan']));jobs.finish(j,{outcome:'input',summary:'need user data',question:'报告覆盖几周？'});assert.equal(j.id,r.job_id);
 f.mount('cloud');f.message('报告覆盖四周');const response=await f.invoke('task_input',{job_id:j.id,question_run_id:j.run_id});assert.equal(response.status,'queued');
 await f.invoke('task_input',{job_id:j.id,question_run_id:j.run_id});assert.equal(jobs.inputs(j.id).length,1);assert.equal(jobs.inputs(j.id)[0].source[0].text,'报告覆盖四周');assert.deepEqual(JSON.parse(jobs.get(j.id).policy),policy);assert.equal(jobs.get(j.id).attempts,1);
 f.message('另一个回答');await assert.rejects(f.invoke('task_input',{job_id:j.id,question_run_id:j.run_id}),/SCHEDULER_INPUT_STALE/);
});
const graph=[{key:'first',title:'分析',instruction:'只分析给定材料',depends_on:[],max_runs:2},{key:'second',title:'汇总',instruction:'汇总前置结果',depends_on:['first'],max_runs:2}];
const workflow=(f,task,extra={})=>f.invoke('task_workflow_create',{task_id:task.task_id,expected_revision:1,model_policy:policy,nodes:graph,max_total_runs:3,end_at:Date.now()+86400000,...extra});
test('local native workflow creation reaches cloud with captured source; cloud controls same parent graph without preset/IM takeover',async t=>{
 const f=await fixture(t),task=await f.submit(),w=await workflow(f,task);assert.equal(w.execution,'readonly');assert.deepEqual(w.model_policy,policy);f.cloud.scheduler.workflows.tick();
 const state=await f.invoke('task_status',{task_id:task.task_id});assert.equal(state.workflows[0].nodes.length,2);assert.equal(state.jobs.length,2);assert.equal(f.agent.ctx.preset,'standard');
 f.mount('cloud');f.message('暂停整个分析任务');const r=await f.invoke('task_workflow_control',{workflow_id:w.id,action:'pause'});assert.equal(r.status,'paused');assert((await f.invoke('task_workflow_list',{task_id:task.task_id})).items[0].nodes.every(n=>n.status==='paused'));assert.equal(f.cloud.scheduler.active.size,0);
});
test('workflow rejects model/revision mismatch, registration-only and missing peer capability before dispatch',async t=>{
 const f=await fixture(t),task=await f.submit('register');await assert.rejects(workflow(f,task),/TASK_REGISTER_ONLY/);f.message('用指定模型只读开始');const plan=await f.submit();
 await assert.rejects(workflow(f,plan,{model_policy:{...policy,model:'fallback'}}),/TASK_MODEL_POLICY_MISMATCH/);await assert.rejects(workflow(f,plan,{expected_revision:2}),/TASK_REVISION_CONFLICT/);
 const hello=f.cloud.hello.bind(f.cloud);f.cloud.hello=()=>{const h=hello();delete h.capabilities.workflows;return h;};await assert.rejects(workflow(f,plan),/CAPABILITY_UNAVAILABLE/);assert.equal(f.cloud.scheduler.jobs.db.prepare('SELECT count(*) n FROM jobs').get().n,0);
});
test('cancelling child workflow cannot switch dispatch family to silently regain budget under same task revision',async t=>{
 const f=await fixture(t),task=await f.submit(),w=await workflow(f,task);await f.invoke('task_workflow_control',{workflow_id:w.id,action:'cancel'});
 await assert.rejects(f.invoke('task_schedule',{task_id:task.task_id,provider:policy.provider,model:policy.model,reasoning_effort:policy.reasoningEffort}),/DISPATCH_FAMILY_CONFLICT/);await assert.rejects(f.create(task),/DISPATCH_FAMILY_CONFLICT/);
});
test('a completed single job cannot be repackaged as a fresh workflow to spend additional runs without a new revision',async t=>{
 const f=await fixture(t),task=await f.submit(),r=await f.invoke('task_schedule',{task_id:task.task_id,provider:policy.provider,model:policy.model,reasoning_effort:policy.reasoningEffort});
 await f.invoke('task_control',{job_id:r.job_id,action:'cancel'});await assert.rejects(workflow(f,task),/DISPATCH_FAMILY_CONFLICT/);
});
test('native inventory reads cloud actual capability over authenticated RPC without selecting model or starting work',async t=>{
 const f=await fixture(t),r=await f.invoke('task_source_capabilities',{});assert.equal(r.host,'cloud');assert.equal(r.capabilities.file_text,false);assert.equal(r.capabilities.web_search,false);assert.equal(r.grant,false);assert.equal(r.observation.freshness,'live_response');assert.equal(r.worker_enabled,true);
 assert.equal(f.cloud.scheduler.jobs.db.prepare('SELECT count(*) n FROM jobs').get().n,0);assert.equal(f.agent.ctx.preset,'standard');
 f.mount('cloud');assert.equal((await f.invoke('task_source_capabilities',{})).capabilities.peer_file_read,false);
 await assert.rejects(f.invoke('task_source_capabilities',{readRoots:['/']}),/SOURCE_ARGUMENT_INVALID/);
});
test('old or disconnected peers never inherit local capabilities or a cached read grant',async t=>{
 const f=await fixture(t),hello=f.cloud.hello.bind(f.cloud);f.cloud.hello=()=>{const h=hello();delete h.capabilities.sources;return h;};
 await assert.rejects(f.invoke('task_source_capabilities',{}),/CAPABILITY_UNAVAILABLE/);f.cloud.hello=hello;
 await f.invoke('task_source_capabilities',{});f.local.c.coordinatorUrl='http://127.0.0.1:1';await assert.rejects(f.invoke('task_source_capabilities',{}));assert.equal(f.cloud.scheduler.active.size,0);
});
