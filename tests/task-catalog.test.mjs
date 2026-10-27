import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {Gateway} from '../bundle/index.js';
import {Coordinator} from '../bundle/store.js';
import {TaskCatalog} from '../bundle/task-catalog.js';
import {makeEnvelope,selectedHumanContext,parseEnvelope} from '../bundle/task-envelope.js';
import {registerNativeTools} from '../bundle/native-tools.js';
const policy={provider:'chosen',model:'glm-5.3',reasoningEffort:'low'};
const msg=(id,text)=>({id,role:'user',source:{kind:'user'},content:[{type:'text',text}]});
async function fixture(t){
 const root=mkdtempSync(tmpdir()+'/task-catalog-'),tokenFile=root+'/tokens.json';writeFileSync(tokenFile,JSON.stringify({localToken:'l'.repeat(32),cloudToken:'c'.repeat(32)}),{mode:0o600});
 const agents=new Map(),ctx={on(){},effect(){},agents:{get:id=>agents.get(id),list:()=>[...agents.values()]},agentPresets:{composedPreset:c=>c.preset}};
 const cloud=new Gateway(ctx,{role:'cloud',entryMode:'native',namespace:'catalog',stateDir:root+'/cloud',tokenFile,port:0,scheduler:{lockPort:0,intervalMs:60000}},{scheduler:{allowEphemeralLock:true}});await cloud.start();
 const local=new Gateway(ctx,{role:'local',entryMode:'native',namespace:'catalog',stateDir:root+'/local',tokenFile,port:0,coordinatorUrl:'http://127.0.0.1:'+cloud.server.address().port});
 const tools=new Map();registerNativeTools({taskGateway:local,tools:{register:d=>tools.set(d.name,d)}});
 let messages=[msg('one','只登记周报任务，不执行。')];let a={id:'session-one',ctx:{preset:'standard'},session:{deriveMessages:()=>messages}};agents.set(a.id,a);
 const invoke=(name,input,callId='call')=>tools.get(name).execute(input,{agent:a,callId});
 const create=(title='周报任务')=>invoke('task_submit',{goal:'保留全部要求',title,target:'cloud',intent:'register'});
 const update=(task_id,expected_revision,extra={})=>invoke('task_update',{task_id,expected_revision,summary:'补充后的完整理解',...extra});
 t.after(async()=>{await local.close();await cloud.close();rmSync(root,{recursive:true,force:true});});
 return {root,cloud,local,tools,invoke,create,update,message:(id,text)=>messages.push(msg(id,text)),session:(id,items)=>{messages=items;a={id,ctx:{preset:'standard'},session:{deriveMessages:()=>messages}};agents.set(id,a);}};
}
test('catalog finds a named task from another session without creating tasks or exposing all requests',async t=>{
 const f=await fixture(t),a=await f.create();f.session('another-session',[msg('two','查一下周报任务')]);
 const list=await f.invoke('task_catalog',{query:'周报'});assert.equal(list.items[0].task_id,a.task_id);assert.equal(list.requires_clarification,false);assert.equal(list.items[0].spec_revision,1);assert.equal(list.items[0].request,undefined);
 const detail=await f.invoke('task_status',{task_id:a.task_id});assert.equal(detail.catalog.request.request_text,'只登记周报任务，不执行。');assert.equal(f.cloud.store.snapshot().tasks.length,1);
});
test('duplicate titles stay distinct and require clarification; literal query does not run SQL',async t=>{
 const f=await fixture(t);await f.create();f.message('two','另一个同名任务只登记');await f.create();
 const x=await f.invoke('task_catalog',{query:'周报任务',limit:1});assert.equal(x.total,2);assert.equal(x.requires_clarification,true);assert.equal(x.next_cursor,1);
 assert.equal((await f.invoke('task_catalog',{query:"%' OR 1=1 --"})).total,0);
});
test('amend appends exact direct user text, keeps original ingress and writer revision, and survives reopen',async t=>{
 const f=await fixture(t),a=await f.create(),before=f.cloud.store.snapshot().ingress;f.message('two','补充：必须区分已受理与已完成。');
 const r=await f.update(a.task_id,1,{title:'新的周报名称'});assert.equal(r.spec_revision,2);assert.equal((await f.invoke('task_catalog',{query:'周报任务'})).items[0].task_id,a.task_id);assert.equal(r.execution,'not_scheduled');assert.equal(f.cloud.store.task(a.task_id).revision,0);
 const head=f.cloud.catalog.view(a.task_id);assert.equal(head.request.request_text,'只登记周报任务，不执行。');assert.equal(head.request.task_context.sources[1].text,'补充：必须区分已受理与已完成。');assert.deepEqual(f.cloud.store.snapshot().ingress,before);
 const reopened=new Coordinator(f.root+'/cloud/coordinator');try{assert.deepEqual(new TaskCatalog(reopened).view(a.task_id),head);}finally{reopened.close();}
});
test('lost-response replay uses stable source event; conflicting payload and stale revisions are rejected',async t=>{
 const f=await fixture(t),a=await f.create();f.message('two','补充一个约束');const first=await f.update(a.task_id,1);
 assert.deepEqual(await f.update(a.task_id,1),first);assert.equal(f.cloud.catalog.view(a.task_id).revisions.length,2);
 await assert.rejects(f.update(a.task_id,1,{summary:'changed payload same message'}),/UPDATE_EVENT_CONFLICT/);
 f.message('three','另一次补充');await assert.rejects(f.update(a.task_id,1),/TASK_REVISION_CONFLICT/);
});
test('register becomes explicit model-bound plan on same task; repeated schedule creates one job',async t=>{
 const f=await fixture(t),a=await f.create();await assert.rejects(f.invoke('task_schedule',{task_id:a.task_id,...policy}),/TASK_REGISTER_ONLY/);
 f.message('two','现在用 chosen 的 glm-5.3 低推理开始只读规划');const r=await f.update(a.task_id,1,{intent:'plan',model_policy:policy});assert.equal(r.spec_revision,2);
 await assert.rejects(f.invoke('task_schedule',{task_id:a.task_id,...policy}),/TASK_REVISION_REQUIRED/);
 const args={task_id:a.task_id,expected_revision:2,provider:policy.provider,model:policy.model,reasoning_effort:'low',delay_seconds:600};
 const job=await f.invoke('task_schedule',args,'schedule1');assert.equal((await f.invoke('task_schedule',args,'schedule2')).job_id,job.job_id);
 const saved=f.cloud.scheduler.jobs.get(job.job_id);assert.equal(parseEnvelope(saved.goal).task_context.spec_revision,2);assert.deepEqual(JSON.parse(saved.policy),policy);assert.equal(f.cloud.store.snapshot().tasks.length,1);
 await assert.rejects(f.invoke('task_schedule',{...args,model:'wrong'}),/TASK_MODEL_POLICY_MISMATCH/);
});
test('queued, paused, running and cancelled-but-draining jobs block amendments without altering history',async t=>{
 const f=await fixture(t),a=await f.create();f.message('two','开始只读规划');await f.update(a.task_id,1,{intent:'plan',model_policy:policy});
 const job=await f.invoke('task_schedule',{task_id:a.task_id,expected_revision:2,provider:policy.provider,model:policy.model,reasoning_effort:'low',delay_seconds:600});f.message('three','修改任务目标');
 await assert.rejects(f.update(a.task_id,2),/TASK_NOT_QUIESCENT/);
 f.cloud.scheduler.jobs.db.prepare('UPDATE jobs SET due=0 WHERE id=?').run(job.job_id);const claimed=f.cloud.scheduler.jobs.claim(new Set(['plan']),new Set(['plan']));assert.equal(claimed.status,'running');await assert.rejects(f.update(a.task_id,2),/TASK_NOT_QUIESCENT/);
 await f.invoke('task_control',{job_id:job.job_id,action:'pause'},'pause');await assert.rejects(f.update(a.task_id,2),/TASK_NOT_QUIESCENT/);
 await f.invoke('task_control',{job_id:job.job_id,action:'cancel'},'cancel');f.cloud.scheduler.active.set(job.job_id,{task_id:a.task_id,controller:new AbortController(),run:Promise.resolve()});
 await assert.rejects(f.update(a.task_id,2),/TASK_NOT_QUIESCENT/);f.cloud.scheduler.active.clear();assert.equal((await f.update(a.task_id,2)).intent,'register');
});
test('task ownership busy and blocked states are not replaced by spec revision or connection status',async t=>{
 const f=await fixture(t),a=await f.create();f.message('two','补充');f.cloud.store.db.prepare('UPDATE tasks SET busy=1 WHERE id=?').run(a.task_id);
 await assert.rejects(f.update(a.task_id,1),/TASK_NOT_QUIESCENT/);f.cloud.store.db.prepare('UPDATE tasks SET busy=0,blocked=1 WHERE id=?').run(a.task_id);
 await assert.rejects(f.update(a.task_id,1),/NEEDS_REVIEW/);
});
test('selected context only admits direct text in the same session and preserves chronological order',()=>{
 const messages=[msg('first','第一条'),msg('second','第二条'),{...msg('peer','同意开发'),source:{kind:'plugin'}},msg('last','只登记这个上下文')],agent={id:'test',session:{deriveMessages:()=>messages}};
 assert.deepEqual(selectedHumanContext(agent,'local',['second','first']).map(x=>x.text),['第一条','第二条','只登记这个上下文']);
 for(const ids of [['peer'],['other-session'],['first','first']])assert.throws(()=>selectedHumanContext(agent,'local',ids),/CONTEXT_SELECTION_INVALID/);
 const e=makeEnvelope(agent,'local',{goal:'摘要',title:'名称',target:'cloud',intent:'register',context_message_ids:['first']});assert.equal(parseEnvelope(e.goal).task_context.sources.length,2);
});
test('reference pointers require user source and remain unverified; suggestions never create children',async t=>{
 const f=await fixture(t);f.message('ref','只登记参考 https://example.com/report 和本地 /tmp/report.pdf，不读取。');const a=await f.invoke('task_submit',{goal:'资料规划',title:'参考任务',target:'cloud',intent:'register',references:[{kind:'url',title:'网页',uri:'https://example.com/report'},{kind:'file-reference',title:'附件',uri:'/tmp/report.pdf',host:'local'}],split_suggestions:[{title:'分析',summary:'只作拆分建议'}]});
 const v=f.cloud.catalog.view(a.task_id);assert(v.references.every(x=>x.availability==='unverified'&&x.content_read===false));assert.equal(v.split_suggestions[0].status,'suggestion_only');assert.equal(f.cloud.store.snapshot().tasks.length,1);
 f.message('two','补充内容');await assert.rejects(f.update(a.task_id,1,{references:[{kind:'url',title:'伪造',uri:'https://example.com/secret'}]}),/REFERENCE_NOT_IN_USER_CONTEXT/);
});
test('non-text, unsafe URLs and excessive context fail visibly without truncating or mutating revisions',async t=>{
 const f=await fixture(t);f.message('long','原文 '.repeat(1500));const a=await f.create();f.message('two','补充 '.repeat(1500));await assert.rejects(f.update(a.task_id,1),/CONTEXT_LIMIT/);assert.equal(f.cloud.catalog.view(a.task_id).spec_revision,1);
 f.session('unsafe',[msg('ref','https://user:pass@example.com/a')]);await assert.rejects(f.update(a.task_id,1,{references:[{kind:'url',title:'unsafe',uri:'https://user:pass@example.com/a'}]}),/UNSUPPORTED_REFERENCE/);
 f.session('image',[{...msg('image',''),content:[{type:'image',url:'x'}]}]);assert.throws(()=>f.update(a.task_id,1),/TEXT_TASK_REQUIRED/);
});
test('RPC cannot forge amendment origin or expose approvals/writers',async t=>{
 const f=await fixture(t),a=await f.create();const source=selectedHumanContext({id:'fake',session:{deriveMessages:()=>[msg('m','fake')]}},'cloud');
 await assert.rejects(f.local.call('task_amend',{task_id:a.task_id,expected_revision:1,event_id:'e',summary:'x',intent:'register',sources:source}),/CONTEXT_ORIGIN_MISMATCH/);
 for(const method of ['approve','write','release','register'])await assert.rejects(f.local.call(method,{}),/METHOD_DENIED/);
 assert.equal(f.tools.has('approve'),false);assert.equal(f.cloud.writer.bindings.size,0);
});
test('old opaque tasks are discoverable but never implicitly promoted or rewritten',async t=>{
 const f=await fixture(t),t0=f.cloud.store.accept('cloud',{task_key:'old',ingress_id:'old',source:'desktop',goal:'历史任务'}),before=f.cloud.store.snapshot().ingress;
 assert.equal((await f.invoke('task_catalog',{query:'历史任务'})).items[0].legacy_readonly,true);await assert.rejects(f.update(t0.id,1),/LEGACY_TASK_READONLY/);assert.deepEqual(f.cloud.store.snapshot().ingress,before);
});
test('explicit title conflicts cannot merge distinct tasks sharing a key',async t=>{
 const f=await fixture(t);await f.invoke('task_submit',{goal:'same',title:'名称甲',task_key:'explicit',target:'cloud',intent:'register'});f.session('second',[msg('one','只登记周报任务，不执行。')]);
 const second=await f.invoke('task_submit',{goal:'same',title:'名称乙',task_key:'explicit',target:'cloud',intent:'register'});assert.equal(second.status,'needs_review');
});
test('proposal notifications do not instruct users to execute retired approval commands',async t=>{
 const f=await fixture(t),a=await f.create();f.message('two','开始只读');await f.update(a.task_id,1,{intent:'plan',model_policy:policy});
 await f.invoke('task_schedule',{task_id:a.task_id,expected_revision:2,provider:policy.provider,model:policy.model,reasoning_effort:'low'});
 const j=f.cloud.scheduler.jobs.claim(new Set(['plan']),new Set(['plan']));f.cloud.scheduler.jobs.finish(j,{outcome:'proposal',summary:'只读方案',proposal:'等待可信批准'});
 assert.equal(f.cloud.scheduler.jobs.db.prepare('SELECT count(*) n FROM job_notifications').get().n,0);
 // Historical tasks retain their old notice wording, while new tasks use only the task-level outbox.
 f.cloud.scheduler.jobs.enqueue({task_id:'legacy',trigger_id:'legacy-proposal',goal:'legacy plain goal',policy});
 const legacy=f.cloud.scheduler.jobs.claim(new Set(['plan']),new Set(['plan']));f.cloud.scheduler.jobs.finish(legacy,{outcome:'proposal',summary:'只读方案',proposal:'等待可信批准'});
 const notice=f.cloud.scheduler.jobs.db.prepare('SELECT text FROM job_notifications').get().text;assert(!notice.includes('/approve job-'));assert(notice.includes('当前可信开发审批入口尚未开放'));
});

test('new amendment defaults high without rewriting history and replay keeps its original fingerprint',async t=>{
 const f=await fixture(t),a=await f.create();f.message('high-plan','现在用用户选择的新模型规划，未指定程度。');
 const p={provider:'another-provider',model:'another-model'},input={intent:'plan',model_policy:p};
 const result=await f.update(a.task_id,1,input);assert.deepEqual(result.model_policy,{...p,reasoningEffort:'high'});
 assert.deepEqual(await f.update(a.task_id,1,input),result);
 assert.equal(f.cloud.catalog.view(a.task_id).revisions[0].model_policy,null);
 const j=await f.invoke('task_schedule',{task_id:a.task_id,expected_revision:2,...p,delay_seconds:600});
 assert.equal(JSON.parse(f.cloud.scheduler.jobs.get(j.job_id).policy).reasoningEffort,'high');
});
