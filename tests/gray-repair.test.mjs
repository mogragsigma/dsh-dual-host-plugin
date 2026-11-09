import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {fixture} from './helpers/continuity-fixture.mjs';
import {makeEnvelope,currentHumanRequest,selectedHumanContext} from '../bundle/task-envelope.js';
import {CLOUD_TASK_POLICY} from '../bundle/managed-cloud-policy.js';
const text=s=>[{type:'text',text:s}],user=(id,s)=>({id,role:'user',source:{kind:'user'},content:text(s)});
function questions(){return [user('u1','先问读者，不要执行'),{id:'ask',role:'assistant',source:{kind:'model'},content:[{type:'tool-call',id:'q1',name:'ask_user_question',arguments:JSON.stringify({questions:[{id:'reader',question:'读者是谁？',options:[{label:'开发者'}]}]})}]},{id:'reply',role:'tool',source:{kind:'tool',callId:'q1'},toolCallId:'q1',isError:false,content:text(JSON.stringify({answers:[{id:'reader',selected:[],custom:'首次安装用户；现在按此前要求执行。'}]}))}]}
const agent=messages=>({id:'entry',session:{deriveMessages:()=>messages}});
test('G01 native question answers become selectable original context with paired questions',()=>{
 const a=agent(questions());assert.equal(currentHumanRequest(a).message_id,'reply');assert.match(currentHumanRequest(a).text,/首次安装用户/);
 const s=selectedHumanContext(a,'cloud',['u1','reply'],true);assert.equal(s.length,2);assert.match(s[1].text,/读者是谁/);
 const e=JSON.parse(makeEnvelope(a,'cloud',{goal:'整理',target:'cloud',intent:'register',continuity:1,execution_policy:CLOUD_TASK_POLICY,channel:'cloud-im',context_message_ids:['u1','reply']}).goal);assert.equal(e.origin.message_id,'reply');assert.equal(e.task_context.sources.length,2);
});
test('G02 arbitrary tool output, pending, skipped and assistant claims never become consent',()=>{
 const ms=questions();ms[1].content[0].name='bash';assert.equal(currentHumanRequest(agent(ms)).message_id,'u1');
 for(const payload of [{pending:true,callId:'q1'},{answers:[{id:'reader',selected:[]}]}]){const xs=questions();xs[2].content=text(JSON.stringify(payload));assert.equal(currentHumanRequest(agent(xs)).message_id,'u1');}
 const err=questions();err[2].isError=true;assert.equal(currentHumanRequest(agent(err)).message_id,'u1');
});
test('G03 native late reply is paired; malformed or unmatched answer is not silently submitted',()=>{
 const ms=questions();ms[2]={id:'late',role:'user',source:{kind:'user-question-reply',callId:'q1',outcome:'answered'},content:text(JSON.stringify({answers:[{id:'reader',selected:['开发者']}]}))};assert.equal(currentHumanRequest(agent(ms)).message_id,'late');
 ms[2].content=text(JSON.stringify({answers:[{id:'other',selected:['开发者']}]}));assert.throws(()=>currentHumanRequest(agent(ms)),/NATIVE_ANSWER/);
});
async function setup(t){const f=fixture(t,{managedExecution:{enabled:true,defaultModel:{provider:'fixture',model:'fixture'}}});f.g.ctx.llm.resolveCallConfig=async p=>p;const a=f.agent(),e=makeEnvelope(a,'local',{goal:'周期',target:'cloud',intent:'register',continuity:1,execution_policy:CLOUD_TASK_POLICY,channel:'local-dsh'});const r=await f.g.call('accept',{goal:e.goal,task_key:e.task_key,ingress_id:e.ingress_id,source:'native-local'},'local');const cwd=join(f.dir,'work');mkdirSync(cwd);await f.g.call('execution_start',{task_id:r.id,expected_revision:1,cwd:realpathSync(cwd),period_seconds:180});return {...f,id:r.id};}
test('G04 one human message may pause AND follow up, both independently idempotent through outbox',async t=>{
 const f=await setup(t),s=f.source('暂停，并增加后续观察；不要增加权限。');const c=f.control(f.id,'pause',s),i=f.input(f.id,s);
 assert.equal((await f.g.continuityOutbox.submit('task_lifecycle',c)).state,'paused');assert.equal((await f.g.continuityOutbox.submit('task_followup',i)).status,'saved');
 await f.g.continuityOutbox.submit('task_lifecycle',c);await f.g.continuityOutbox.submit('task_followup',i);assert.equal(f.g.continuity.read(f.id).items.length,1);assert.equal(f.g.catalog.head(f.id).spec_revision,1);
 assert.throws(()=>f.g.continuityOutbox.submit('task_followup',{...i,mode:'reference'}),/INPUT_CONFLICT/);
});
test('G05 pending followup survives pause/resume on original task without revision drift',async t=>{
 const f=await setup(t);await f.g.call('task_lifecycle',f.control(f.id,'pause'));await f.g.call('task_followup',f.input(f.id));const r=await f.g.call('task_lifecycle',f.control(f.id,'resume'));assert.equal(r.state,'active');assert.equal(f.g.execution.get(f.id).state,'waiting');assert.equal(f.g.execution.get(f.id).due,f.g.now()+180000);assert.equal(f.g.execution.get(f.id).revision,1);assert.equal(f.g.execution.budgets.view(f.id).used,0);
});
test('G06 revision mismatch fails resume atomically; never report active with fenced execution',async t=>{
 const f=await setup(t);await f.g.call('task_lifecycle',f.control(f.id,'pause'));await f.g.call('task_amend',{task_id:f.id,expected_revision:1,summary:'修订',intent:'register',sources:[f.source()],event_id:'revision'});
 await assert.rejects(f.g.call('task_lifecycle',f.control(f.id,'resume')),/AUTHORITY_CHANGED/);assert.equal(f.g.continuity.state(f.id).state,'paused');assert.equal(f.g.continuity.state(f.id).version,1);
});

test('G07 native tools cannot invent worker override; omitted model uses cloud default',async t=>{
 const f=await setup(t),a=f.agent('operator','沿用云端默认模型，不要切换渠道。');const execute=f.tools.get('task_execute');assert(!execute.parameters.properties.model_policy);
 await assert.rejects(execute.execute({task_id:f.id,expected_revision:1,cwd:f.g.execution.item(f.g.execution.get(f.id)).spec.cwd,model_policy:{provider:'other',model:'other'}},{agent:a,callId:'wrong'}),/USE_USER_QUERY/);
 await assert.rejects(execute.execute({task_id:f.id,expected_revision:1,cwd:f.dir,model_query:'ds flash'},{agent:a,callId:'invented'}),/USER_QUERY_REQUIRED/);
 assert.equal(f.g.execution.budgets.view(f.id).policy.provider,'fixture');
});
test('G08 managed search contract has no old quota/extra quote; configured auxiliary default is reused',async t=>{
 const f=await setup(t),a=f.agent('operator','核对官方资料，可用现有搜索。');const e=makeEnvelope(a,'local',{goal:'检索',target:'cloud',intent:'register',continuity:1,execution_policy:CLOUD_TASK_POLICY,channel:'local-dsh',search:{scope:'官方资料'}});assert.deepEqual(JSON.parse(e.goal).search,{scope:'官方资料'});
 assert(!f.tools.get('task_submit').parameters.properties.search.anyOf[1].properties.max_requests);
 f.g.c.managedExecution.endpoint={search:{credentialRef:'FIXTURE_KEY',model_policy:{provider:'deepseek-official',model:'search-fixture',reasoningEffort:'disabled'}}};
 const q=await f.g.call('execution_start',{task_id:f.id,expected_revision:1,cwd:f.g.execution.item(f.g.execution.get(f.id)).spec.cwd,search:{scope:'官方资料'}});assert.equal(q.budget.search.max_requests,undefined);assert.equal(q.budget.search.model_policy.model,'search-fixture');
 const caps=await f.g.call('source_capabilities',{});assert.equal(caps.capabilities.search.max_requests,null);assert.equal(caps.capabilities.files.mode,'native-host-account');
});
test('G09 stopped task cannot resume or restart; old input replay remains historical',async t=>{
 const f=await setup(t),i=f.input(f.id);await f.g.call('task_followup',i);await f.g.call('task_lifecycle',f.control(f.id,'stop'));await f.g.call('task_followup',i);await assert.rejects(f.g.call('task_lifecycle',f.control(f.id,'resume')),/NOT_ALLOWED/);await assert.rejects(f.g.call('execution_start',{task_id:f.id,expected_revision:1,cwd:f.dir}),/TASK_STOPPED/);assert.equal(f.g.execution.budgets.view(f.id).used,0);
});

test('G10 explicit native model name uses existing resolver; ordinary default never invokes resolver',async t=>{
 const f=fixture(t,{role:'local',managedExecution:{enabled:true}}),a=f.agent('choice','请用 fixture-special 处理。');let resolved=0;const call=f.g.call.bind(f.g);f.g.call=async(method,args,...rest)=>{if(method==='model_resolve'){resolved++;assert.equal(args.query,'fixture-special');return {status:'resolved',model_policy:{provider:'fixture',model:'chosen'}};}return call(method,args,...rest);};
 const {nativeModelChoice}=await import('../bundle/native-model-choice.js');assert.equal(await nativeModelChoice(f.g,{}, {agent:a}),null);assert.equal(resolved,0);assert.deepEqual(await nativeModelChoice(f.g,{model_query:'fixture-special'},{agent:a}),{provider:'fixture',model:'chosen'});assert.equal(resolved,1);
});
test('G11 missing native question call or partial answer batch fails closed without trusting tool text',()=>{
 const ms=questions();ms[2].toolCallId='wrong';assert.equal(currentHumanRequest(agent(ms)).message_id,'u1');
 const late={id:'late',role:'user',source:{kind:'user-question-reply',callId:'absent',outcome:'answered'},content:text('{"answers":[]}')};assert.throws(()=>currentHumanRequest(agent([user('u','original'),late])),/CONTEXT_MISSING/);
 const bad=questions();bad[2].content=text('{"answers":[]}');assert.throws(()=>currentHumanRequest(agent(bad)),/NATIVE_ANSWER/);
});
test('G12 old message-keyed input receipts stay replayable; a new control purpose does not overwrite them',async t=>{
 const f=await setup(t),s=f.source('旧跟进，同时暂停'),i=f.input(f.id,s),r=await f.g.call('task_followup',i);const old=r.input_id.replace(/:input$/,'');const db=f.g.store.db;
 db.prepare('UPDATE task_input_events SET id=? WHERE id=?').run(old,r.input_id);db.prepare('UPDATE task_inputs SET event_id=? WHERE event_id=?').run(old,r.input_id);db.prepare('UPDATE task_input_links SET thread_key=? WHERE thread_key=?').run(old,r.input_id);
 const op=db.prepare('SELECT result FROM task_input_operations WHERE id=?').get(r.input_id);db.prepare('UPDATE task_input_operations SET id=?,result=? WHERE id=?').run(old,op.result.replaceAll(r.input_id,old),r.input_id);
 assert.equal((await f.g.call('task_followup',i)).input_id,old);await f.g.call('task_lifecycle',f.control(f.id,'pause',s));assert.equal(f.g.continuity.state(f.id).state,'paused');assert.equal(f.g.continuity.read(f.id).items.length,1);
});
