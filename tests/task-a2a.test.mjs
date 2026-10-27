import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {Gateway} from '../bundle/index.js';
import {makeEnvelope} from '../bundle/task-envelope.js';
import {registerNativeTools} from '../bundle/native-tools.js';

async function fixture(t,{enabled=true,intent='plan',rpc=false}={}) {
 const root=mkdtempSync(tmpdir()+'/a2a-contract-'),tokenFile=root+'/tokens.json';
 writeFileSync(tokenFile,JSON.stringify({localToken:'l'.repeat(32),cloudToken:'c'.repeat(32)}),{mode:0o600});
 let now=Date.now(),seq=0,g,local;const ctx={on(){},effect(){},get(){return null;},agents:{list:()=>[],get(){}},agentPresets:{composedPreset:()=> 'standard'}};
 const base={namespace:'a2a-contract',port:0,tokenFile,entryMode:'native',a2a:{enabled}};
 const open=async()=>{g=new Gateway(ctx,{...base,role:'cloud',stateDir:root+'/cloud'},{now:()=>now});if(rpc){await g.start();local=new Gateway(ctx,{...base,role:'local',stateDir:root+'/local',coordinatorUrl:'http://127.0.0.1:'+g.server.address().port},{now:()=>now});}};
 await open();t.after(async()=>{await local?.close();await g.close();rmSync(root,{recursive:true,force:true});});
 const source=(text,role='cloud')=>[{role,session_id:'fixture',message_id:'m'+(++seq),text,sha256:createHash('sha256').update(text).digest('hex')}];
 const human=(text='允许双方只读协作，本例不调用真实模型',role='cloud')=>({sources:source(text,role),authorization_quote:text,event_id:'event-'+(++seq)});
 const policy={provider:'fixture',model:'never-called',reasoningEffort:'high'};
 const agent={id:'entry',session:{deriveMessages:()=>[{id:'original',role:'user',source:{kind:'user'},content:[{type:'text',text:'只读 A2A 测试，登记 /safe/local.md 由本地读取，不准写入'}]}]}};
 const task=await g.call('accept',{...makeEnvelope(agent,'cloud',{goal:'双端协作',title:'双端协作测试',intent,target:'cloud',model_policy:policy,references:[{kind:'file-reference',title:'本地资料',host:'local',uri:'/safe/local.md'}]}),source:'native-cloud'});
 const grantArgs=(patch={})=>({task_id:task.id,expected_revision:1,scope:{local:{model_policy:{...policy},capabilities:['context'],references:[]},cloud:{model_policy:{...policy},capabilities:['context'],references:[]}},end_at:now+3600000,max_turns:4,max_model_requests:12,reply_timeout_seconds:300,...human(),...patch});
 const create=(patch={})=>g.a2a.create('cloud',grantArgs(patch));
 const start=(w,role='cloud')=>g.a2a.start(role,{grant_id:w.id,instruction:'请分析对端所需上下文',...human('现在开始这项只读协作',role)});
 const claim=(role='local')=>g.a2a.claim(role,{instance_id:'instance-'+role}).item;
 const bound=r=>({request_id:r.id,claim:r.claim,instance_id:r.instance_id});
 const begin=r=>g.a2a.begin(r.to,bound(r));
 const finish=(r,followup)=>g.a2a.finish(r.to,{...bound(r),result:{summary:'真实夹具结果，不是模型调用',...(followup?{followup}: {})}});
 const reserve=(r,id='dispatch-'+(++seq),p=policy)=>g.a2a.reserve(r.to,{...bound(r),dispatch_id:id,model_policy:p});
 const control=(w,action)=>g.a2a.control('cloud',{grant_id:w.id,action,...human('用户要求 '+action)});
 return {get g(){return g;},get local(){return local;},root,ctx,task,policy,source,human,grantArgs,create,start,claim,bound,begin,finish,reserve,control,advance:ms=>now+=ms,now:()=>now,
  async restart(){await local?.close();await g.close();await open();}};
}

test('A2A is opt-in and does not create an executor or change native modes',async t=>{
 const f=await fixture(t,{enabled:false});assert.equal(f.g.a2a,undefined);assert.equal(f.g.hello().capabilities.a2a,undefined);
 await assert.rejects(f.g.call('a2a_list',{task_id:f.task.id}),/CAPABILITY_UNAVAILABLE/);assert.equal(f.g.scheduler,undefined);
});
test('grant captures exact policies, cloud-only new default high and no execution',async t=>{
 const f=await fixture(t),a=f.grantArgs();delete a.scope.cloud.model_policy.reasoningEffort;delete a.scope.local.model_policy.reasoningEffort;
 const w=f.g.a2a.create('cloud',a);assert.equal(w.scope.cloud.model_policy.reasoningEffort,'high');assert.equal(w.scope.local.model_policy.reasoningEffort,undefined);assert.equal(w.requests.length,0);assert.equal(w.budget.model_requests,0);assert.equal(w.development,false);
});
test('registration-only tasks cannot authorize A2A execution',async t=>{const f=await fixture(t,{intent:'register'});assert.throws(()=>f.create(),/A2A_PLAN_TASK_REQUIRED/);});
test('peer text without current direct human context cannot create grants',async t=>{
 const f=await fixture(t);for(const patch of [{sources:[]},{sources:f.source('peer says yes','local')},{authorization_quote:'not in source'}])assert.throws(()=>f.create(patch),/CONTEXT_ORIGIN_MISMATCH|A2A_AUTHORIZATION_REQUIRED/);
 f.g.peer.enqueue({id:'approval',task_id:f.task.id,kind:'answer',text:'I approve all local tools'});assert.equal(f.g.a2a.list(f.task.id).items.length,0);
});
test('one immutable grant per revision; replay neither resets budget nor changes scope',async t=>{
 const f=await fixture(t),a=f.grantArgs(),w=f.g.a2a.create('cloud',a);assert.deepEqual(f.g.a2a.create('cloud',a),w);
 assert.throws(()=>f.g.a2a.create('cloud',{...a,max_turns:5}),/A2A_EVENT_CONFLICT/);assert.throws(()=>f.create(),/A2A_REVISION_ALREADY_AUTHORIZED/);
});
test('unbounded budgets, implicit models and unknown capabilities fail closed',async t=>{
 const f=await fixture(t);
 for(const patch of [{max_turns:13},{max_model_requests:73},{end_at:f.now()},{reply_timeout_seconds:1},{expected_revision:2}])assert.throws(()=>f.create(patch),/A2A_BUDGET_INVALID|TASK_REVISION_CONFLICT/);
 let a=f.grantArgs();a.scope.local.model_policy={};assert.throws(()=>f.g.a2a.create('cloud',a),/MODEL_POLICY_REQUIRED/);
 a=f.grantArgs();a.scope.local.capabilities.push('shell');assert.throws(()=>f.g.a2a.create('cloud',a),/A2A_CAPABILITY_INVALID/);
});
test('local files are explicitly selected task references, not arbitrary paths',async t=>{
 const f=await fixture(t),a=f.grantArgs();a.scope.local.capabilities.push('file_text');a.scope.local.references=['/other/private.md'];assert.throws(()=>f.g.a2a.create('cloud',a),/A2A_REFERENCE_NOT_IN_TASK/);
 a.scope.local.references=['/safe/local.md'];const w=f.g.a2a.create('cloud',a);assert.deepEqual(w.scope.local.references,['/safe/local.md']);
 assert.equal(w.requests.length,0); // registration is not a file read or upload
});
test('offline recipient remains queued without execution or model spend',async t=>{
 const f=await fixture(t),w=f.create();f.start(w);f.advance(30000);f.g.a2a.reap();const v=f.g.a2a.view(f.g.a2a.get(w.id));assert.equal(v.requests[0].state,'queued');assert.equal(v.requests[0].session_id,null);assert.equal(v.budget.model_requests,0);assert.equal(f.claim('cloud'),null);
});
test('root replay is idempotent; new event cannot fork another conversation',async t=>{
 const f=await fixture(t),w=f.create(),a={grant_id:w.id,instruction:'问对端',...f.human()};const r=f.g.a2a.start('cloud',a);assert.deepEqual(f.g.a2a.start('cloud',a),r);assert.throws(()=>f.start(w),/A2A_ROOT_ALREADY_EXISTS/);assert.equal(f.g.a2a.get(w.id).used_turns,1);
});
test('claim is role-bound and cannot be acknowledged by the other host',async t=>{
 const f=await fixture(t),w=f.create();f.start(w);const r=f.claim();assert.equal(r.to,'local');assert.throws(()=>f.g.a2a.begin('cloud',f.bound(r)),/A2A_CLAIM_DENIED/);assert.throws(()=>f.g.a2a.begin('local',{...f.bound(r),claim:'fake'}),/A2A_CLAIM_DENIED/);
});
test('unbegun claim expiry permits a new claim but fences the old token',async t=>{
 const f=await fixture(t),w=f.create();f.start(w);const first=f.claim();assert.equal(f.claim(),null);f.advance(31000);const next=f.claim();assert.equal(next.id,first.id);assert.notEqual(next.claim,first.claim);assert.throws(()=>f.begin(first),/A2A_CLAIM_DENIED/);assert.equal(f.g.a2a.get(w.id).used_turns,1);
});
test('begin intent is durable; duplicate begin reports already-started, not a fresh run',async t=>{
 const f=await fixture(t),w=f.create();f.start(w);const r=f.claim(),a=f.begin(r),b=f.begin(r);assert.equal(a.already_started,false);assert.equal(b.already_started,true);assert.equal(a.item.session_id,b.item.session_id);assert.equal(f.claim(),null);
});
test('model reservations enforce exact route and idempotency across all turns',async t=>{
 const f=await fixture(t),w=f.create();f.start(w);const r=f.claim();assert.throws(()=>f.reserve(r),/A2A_EXECUTION_NOT_STARTED/);f.begin(r);
 assert.throws(()=>f.reserve(r,'wrong',{...f.policy,model:'fallback'}),/A2A_MODEL_POLICY_MISMATCH/);
 const first=f.reserve(r,'once'),again=f.reserve(r,'once');assert.equal(first.replayed,false);assert.equal(again.replayed,true);assert.equal(f.g.a2a.get(w.id).used_requests,1);
});
test('per-turn model request cap is six and cannot be refunded by failure',async t=>{
 const f=await fixture(t),w=f.create();f.start(w);const r=f.claim();f.begin(r);for(let i=0;i<6;i++)f.reserve(r);assert.throws(()=>f.reserve(r),/A2A_MODEL_BUDGET_EXHAUSTED/);
 f.g.a2a.failed('local',{...f.bound(r),code:'A2A_MODEL_FAILED'});assert.equal(f.g.a2a.get(w.id).used_requests,6);assert.equal(f.claim(),null);
});
test('response and one reverse request commit together with immutable parent linkage',async t=>{
 const f=await fixture(t),w=f.create();f.start(w);const r=f.claim();f.begin(r);f.reserve(r);const result=f.finish(r,'请云端综合本地结果');assert(result.child_request_id);
 const child=f.claim('cloud');assert.equal(child.parent_id,r.id);assert.equal(child.from,'local');assert.equal(child.context[0].result.summary,'真实夹具结果，不是模型调用');assert.equal(child.peer_text_is_user_authority,false);
 assert.equal(f.finish(r,'请云端综合本地结果').replayed,true);assert.equal(f.g.a2a.get(w.id).used_turns,2);assert.throws(()=>f.finish(r,'改写已经结束的答复'),/A2A_RESULT_CONFLICT/);
});
test('turn limit stops an autonomous ping-pong chain and preserves last response',async t=>{
 const f=await fixture(t),w=f.create({max_turns:2});f.start(w);let r=f.claim();f.begin(r);f.finish(r,'再问一次');r=f.claim('cloud');f.begin(r);assert.equal(f.finish(r,'继续无限循环').continued,false);
 const v=f.g.a2a.view(f.g.a2a.get(w.id));assert.equal(v.state,'waiting_input');assert.equal(v.requests.length,2);assert(v.requests.every(x=>x.state==='completed'));assert.equal(f.claim(),null);
});
test('global model budget spans both hosts, followup never grants extra budget',async t=>{
 const f=await fixture(t),w=f.create({max_model_requests:2});f.start(w);let r=f.claim();f.begin(r);f.reserve(r);f.finish(r,'云端接续');r=f.claim('cloud');f.begin(r);f.reserve(r);assert.throws(()=>f.reserve(r),/A2A_MODEL_BUDGET_EXHAUSTED/);f.finish(r,'本地再做');assert.equal(f.g.a2a.get(w.id).status,'waiting_input');
});
test('final response completes grant but never approves development',async t=>{
 const f=await fixture(t),w=f.create();f.start(w);const r=f.claim();f.begin(r);f.finish(r);assert.equal(f.g.a2a.get(w.id).status,'completed');assert.equal(f.g.approvals.list(f.task.id).length,0);assert.equal(f.g.store.task(f.task.id).busy,0);
});
test('queued pause and resume preserve budget and invalidate the former claim',async t=>{
 const f=await fixture(t),w=f.create();f.start(w);const r=f.claim();const p=f.control(w,'pause');assert.equal(p.drained,true);assert.throws(()=>f.begin(r),/A2A_CLAIM_DENIED/);assert.equal(f.claim(),null);f.control(w,'resume');const n=f.claim();assert.equal(n.id,r.id);assert.notEqual(n.claim,r.claim);assert.equal(f.g.a2a.get(w.id).used_turns,1);
});
test('pause during execution fences models immediately but never claims drain',async t=>{
 const f=await fixture(t),w=f.create();f.start(w);const r=f.claim();f.begin(r);assert.equal(f.control(w,'pause').drained,false);assert.throws(()=>f.reserve(r),/A2A_EXECUTION_FENCED/);assert.throws(()=>f.control(w,'resume'),/A2A_DRAIN_OR_REVIEW_REQUIRED/);assert.equal(f.g.a2a.busy(f.task.id),true);
});
test('late result after pause is retained for review without spawning a followup',async t=>{
 const f=await fixture(t),w=f.create();f.start(w);const r=f.claim();f.begin(r);f.control(w,'pause');const out=f.finish(r,'应该被阻断');assert.equal(out.state,'needs_review');assert.equal(out.continued,false);const v=f.g.a2a.view(f.g.a2a.get(w.id));assert(v.requests[0].late_result);assert.equal(v.requests[0].result,null);assert.equal(f.g.a2a.busy(f.task.id),false);assert.throws(()=>f.control(w,'resume'),/A2A_DRAIN_OR_REVIEW_REQUIRED/);
});
test('revoke queued request is terminal and cannot be resumed',async t=>{
 const f=await fixture(t),w=f.create();f.start(w);f.control(w,'revoke');assert.equal(f.g.a2a.view(f.g.a2a.get(w.id)).requests[0].state,'cancelled');assert.throws(()=>f.control(w,'resume'),/A2A_RESUME_DENIED/);assert.equal(f.claim(),null);
});
test('request deadline expires while Mac offline without pretending execution',async t=>{
 const f=await fixture(t),w=f.create({reply_timeout_seconds:60});f.start(w);f.advance(61000);f.g.a2a.reap();const v=f.g.a2a.view(f.g.a2a.get(w.id));assert.equal(v.state,'needs_review');assert.equal(v.requests[0].state,'timed_out');assert.equal(v.requests[0].session_id,null);assert.equal(v.budget.model_requests,0);
});
test('running timeout requires actual endpoint drain and never requeues',async t=>{
 const f=await fixture(t),w=f.create({reply_timeout_seconds:60});f.start(w);const r=f.claim();f.begin(r);f.advance(61000);f.g.a2a.reap();assert.equal(f.g.a2a.request(r.id).state,'stopping');assert.equal(f.g.a2a.busy(f.task.id),true);assert.equal(f.claim(),null);f.g.a2a.failed('local',{...f.bound(r),code:'A2A_TIMED_OUT'});assert.equal(f.g.a2a.busy(f.task.id),false);assert.equal(f.g.a2a.request(r.id).state,'needs_review');
});
test('grant expiry cancels queued work and does not reset consumed turns',async t=>{
 const f=await fixture(t),w=f.create({end_at:f.now()+1000});f.start(w);f.advance(1001);f.g.a2a.reap();assert.equal(f.g.a2a.get(w.id).status,'invalidated');assert.equal(f.g.a2a.get(w.id).used_turns,1);assert.equal(f.claim(),null);
});
test('task revision change invalidates old A2A grant before model reservation',async t=>{
 const f=await fixture(t),w=f.create();f.start(w);const r=f.claim();f.begin(r);f.g.store.db.prepare('UPDATE task_catalog SET spec_revision=2 WHERE task_id=?').run(f.task.id);assert.throws(()=>f.reserve(r),/A2A_TASK_REVISION_CHANGED/);assert.equal(f.g.a2a.get(w.id).status,'invalidated');
});
test('task quiescence does not ignore queued A2A or an undrained endpoint',async t=>{
 const f=await fixture(t),w=f.create();f.start(w);assert.throws(()=>f.g.assertTaskQuiescent(f.task.id),/TASK_NOT_QUIESCENT/);await assert.rejects(f.g.call('schedule',{task_id:f.task.id}),/A2A_TASK_BUSY/);f.control(w,'revoke');assert.doesNotThrow(()=>f.g.assertTaskQuiescent(f.task.id));
});
test('restarting authority retains running intent, model spend and no duplicate claim',async t=>{
 const f=await fixture(t),w=f.create();f.start(w);const r=f.claim();f.begin(r);f.reserve(r);await f.restart();assert.equal(f.g.a2a.get(w.id).used_requests,1);assert.equal(f.g.a2a.request(r.id).state,'running');assert.equal(f.claim(),null);assert.equal(f.begin(r).already_started,true);
});
test('completed reply survives restart and late failure cannot overwrite it',async t=>{
 const f=await fixture(t),w=f.create();f.start(w);const r=f.claim();f.begin(r);f.finish(r);await f.restart();assert.equal(f.finish(r).replayed,true);assert.equal(f.g.a2a.failed('local',{...f.bound(r),code:'A2A_OLD_FAILURE'}).unchanged,true);assert.equal(f.g.a2a.request(r.id).state,'completed');
});
test('authenticated dual Gateway RPC negotiates A2A and keeps sender identity',async t=>{
 const f=await fixture(t,{rpc:true}),w=f.create();f.start(w);
 const r=(await f.local.call('a2a_claim',{instance_id:'rpc-local'})).item;assert.equal(r.to,'local');assert.equal(f.local.link.snapshot().negotiated.capabilities.a2a,2);
 await f.local.call('a2a_begin',f.bound(r));await f.local.call('a2a_finish',{...f.bound(r),result:{summary:'已关联的本地结果',followup:'请云端归纳'}});
 const c=f.claim('cloud');assert.equal(c.parent_id,r.id);assert.equal(c.context[0].result.summary,'已关联的本地结果');
 const resp=await fetch(f.local.c.coordinatorUrl+'/rpc',{method:'POST',headers:{Authorization:'Bearer invalid','Content-Type':'application/json'},body:JSON.stringify({method:'a2a_claim',args:{instance_id:'rogue'}})});assert.equal((await resp.json()).error,'AUTH_DENIED');
});
test('old or disabled peer cannot use new A2A methods through negotiation',async t=>{
 const f=await fixture(t,{rpc:true});f.local.c.a2a.enabled=false;await assert.rejects(f.local.call('a2a_list',{task_id:f.task.id}),/CAPABILITY_UNAVAILABLE/);f.local.c.a2a.enabled=true;f.g.c.a2a.enabled=false;await assert.rejects(f.local.call('a2a_list',{task_id:f.task.id}),/CAPABILITY_UNAVAILABLE/);
});
test('local native entry captures direct user source without installing any global tool guard',async t=>{
 const f=await fixture(t,{rpc:true}),tools=new Map();let guards=0;
 const agent={id:'ordinary-entry',ctx:{preset:'standard'},session:{deriveMessages:()=>[{id:'native-source',role:'user',source:{kind:'user'},content:[{type:'text',text:'允许双方只读协作；现在开始'}]}]}};
 f.ctx.agents.get=id=>id===agent.id?agent:undefined;
 registerNativeTools({taskGateway:f.local,tools:{register:x=>tools.set(x.name,x),guard:()=>guards++}});
 const a=f.grantArgs();delete a.sources;delete a.event_id;a.authorization_quote='允许双方只读协作';
 const w=await tools.get('task_a2a_authorize').execute(a,{agent,callId:'grant'});
 assert.equal(JSON.parse(f.g.a2a.get(w.id).source)[0].role,'local');assert.equal(guards,0);
 const out=await tools.get('task_a2a_start').execute({grant_id:w.id,instruction:'云端先处理',authorization_quote:'现在开始'},{agent,callId:'start'});
 assert.equal(out.state,'queued');const c=f.claim('cloud');assert.equal(c.from,'local');assert.equal(c.to,'cloud');
 assert.throws(()=>tools.get('task_a2a_authorize').execute(a,{agent:{...agent},callId:'forged'}),/UNBOUND_NATIVE_SESSION/);
});
test('pause control replay is stable and cannot be changed to resume under same event',async t=>{
 const f=await fixture(t),w=f.create(),a={grant_id:w.id,action:'pause',...f.human('暂停这项协作')};
 const result=f.g.a2a.control('cloud',a);assert.deepEqual(f.g.a2a.control('cloud',a),result);assert.throws(()=>f.g.a2a.control('cloud',{...a,action:'resume'}),/A2A_EVENT_CONFLICT/);
});
test('stale request cannot finish or consume the budget of another task grant',async t=>{
 const f=await fixture(t),w=f.create();f.start(w);const r=f.claim();f.begin(r);
 assert.throws(()=>f.g.a2a.finish('local',{...f.bound(r),request_id:'wake-nonexistent',result:{summary:'unrelated'}}),/A2A_REQUEST_NOT_FOUND/);
 assert.throws(()=>f.g.a2a.start('cloud',{grant_id:w.id,parent_id:r.id,instruction:'fork',...f.human()}),/A2A_ARGUMENT_INVALID/);
 assert.equal(f.g.a2a.requests(w.id).length,1);
});
test('expired execution intent remains fenced after authority restart',async t=>{
 const f=await fixture(t),w=f.create({reply_timeout_seconds:60});f.start(w);const r=f.claim();f.begin(r);f.advance(61000);await f.restart();
 assert.throws(()=>f.reserve(r),/A2A_EXECUTION_FENCED/);assert.equal(f.g.a2a.request(r.id).state,'stopping');assert.equal(f.claim(),null);
});
test('background authority tick expires offline work without a status query or executor',async t=>{
 const f=await fixture(t),w=f.create({reply_timeout_seconds:60});f.start(w);f.advance(61000);await f.g.tick();
 assert.equal(f.g.a2a.get(w.id).status,'needs_review');assert.equal(f.g.a2a.requests(w.id)[0].state,'timed_out');assert.equal(f.g.scheduler,undefined);
});
test('A2A v1 peer is refused before claim under observation-aware v2; catalog remains independent',async t=>{const f=await fixture(t,{rpc:true}),w=f.create();f.start(w);const hello=f.local.hello.bind(f.local);f.local.hello=()=>{const h=hello();return {...h,capabilities:{...h.capabilities,a2a:1}};};await assert.rejects(f.local.call('a2a_claim',{instance_id:'old-endpoint'}),/CAPABILITY_VERSION_INCOMPATIBLE/);assert.equal(f.g.a2a.list(f.task.id).items[0].requests[0].state,'queued');assert((await f.local.call('catalog',{})).items);});
