import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NativeTaskWorker} from '../bundle/task-worker.js';
function fixture(){
 let current=true,worker,options,disposed=0,hidden=0,mounted=0,requests,dispatch,errorHandler;const agent={id:'dedicated',ctx:{on(n,fn){if(n==='agent/request')requests=fn;if(n==='agent/error')errorHandler=fn;}},session:{},followup(){},whenIdle:async()=>{},cancel(){}};
 const ctx={on(_n,fn){dispatch=fn;},agents:{get:()=>agent,withoutInitiator:fn=>{hidden++;return fn();},create:async o=>{options=o;await o.setup({});return {agent,dispose:async()=>{disposed++;}};}},agentPresets:{mount:async()=>{mounted++;}},sessions:{flush:async()=>{}}};
 const reservations=[];
 worker=new NativeTaskWorker(ctx,{inputs:()=>[],assertClaim(){if(!current)throw Error('STALE_JOB_CLAIM');},reserveModelRequest(_j,r){reservations.push(r);if(reservations.length>6)throw Error('WORKER_REQUEST_BUDGET');}},{workspace:'/isolated'});
 const job={id:'job',claim:'token',session_id:'dedicated',task_id:'task',run_id:'run',policy:JSON.stringify({provider:'selected',model:'selected'}),checkpoint:'{}',goal:'read only',max_runs:4,attempts:1};
 return {worker,agent,job,ctx,reservations,get options(){return options;},get disposed(){return disposed;},get hidden(){return hidden;},get mounted(){return mounted;},request:next=>requests({agent},next),dispatch:async(options,next=()=>[])=>{const stream=dispatch(options,next);assert.equal(stream instanceof Promise,false);const result=[];for await(const x of stream)result.push(x);return result;},error:code=>errorHandler({error:{code}}),invalidate(){current=false;}};
}
test('native worker has its own root, hides initiator, tears down before result commit',async()=>{
 const f=fixture();const report=await f.worker.run(f.job,new AbortController().signal,async()=>f.worker.report(f.agent,{outcome:'done',summary:'read-only plan'}));
 assert.equal(report.summary,'read-only plan');assert.equal(f.options.parentAgent,undefined);assert.equal(f.options.sessionId,'dedicated');assert.equal(f.hidden,1);assert.equal(f.mounted,1);assert.equal(f.disposed,1);assert.equal(f.worker.active.size,0);
});
test('idle without a verified report is not success',async()=>{const f=fixture();await assert.rejects(f.worker.run(f.job,new AbortController().signal),/WORKER_REPORT_REQUIRED/);assert.equal(f.disposed,1);});
test('provider output exhaustion is diagnosed without new requests or a false completion',async()=>{
 for(const reported of [false,true]){
  const f=fixture();f.job.policy=JSON.stringify({provider:'selected',model:'selected',reasoningEffort:'high'});
  const chunks=[{type:'finish',reason:{kind:'max-tokens'}}];
  f.agent.whenIdle=async()=>{
   assert.deepEqual(await f.dispatch({sessionId:'dedicated',provider:'selected',model:'selected',reasoningEffort:'high',maxTokens:2048},()=>chunks),chunks);
   if(reported)f.worker.report(f.agent,{outcome:'done',summary:'must not certify truncated run'});
  };
  await assert.rejects(f.worker.run(f.job,new AbortController().signal),/WORKER_MODEL_OUTPUT_LIMIT/);
  assert.equal(f.reservations.length,1);assert.equal(f.options.agentOptions.reasoningEffort,'high');assert.equal(f.disposed,1);
  assert.deepEqual(await f.dispatch({sessionId:'ordinary'},()=>chunks),chunks);
 }
});
test('successful provider finishes still require a worker report and preserve the stream',async()=>{
 for(const kind of ['tool-calls','stop']){
  const f=fixture(),chunks=[{type:'finish',reason:{kind}}];
  f.agent.whenIdle=async()=>{assert.deepEqual(await f.dispatch({sessionId:'dedicated',provider:'selected',model:'selected',maxTokens:2048},()=>chunks),chunks);f.worker.report(f.agent,{outcome:'done',summary:'actual report'});};
  assert.equal((await f.worker.run(f.job,new AbortController().signal)).summary,'actual report');
 }
});
test('explicit provider/model are checked at every actual request; no silent fallback',async()=>{
 const f=fixture();f.agent.whenIdle=()=>f.request(async()=>({provider:'selected',model:'fallback'}));await assert.rejects(f.worker.run(f.job,new AbortController().signal),/MODEL_ROUTE_MISMATCH/);assert.equal(f.options.agentOptions.model,'selected');assert.equal(f.disposed,1);
});
test('request budget is bounded even when the model never produces report',async()=>{
 const f=fixture();f.agent.whenIdle=async()=>{for(let i=0;i<7;i++)await f.request(async()=>({provider:'selected',model:'selected'}));};await assert.rejects(f.worker.run(f.job,new AbortController().signal),/REQUEST_BUDGET/);assert.equal(f.disposed,1);
});
test('stale claims, cancellation and forged agents cannot report; probe cannot invoke any model',async()=>{
 const f=fixture(),c=new AbortController();await assert.rejects(f.worker.run(f.job,c.signal,async()=>{
  assert.throws(()=>f.worker.report({...f.agent},{outcome:'done',summary:'forged'}),/UNBOUND/);
  await assert.rejects(f.request(async()=>({provider:'x',model:'y'})),/NO_MODEL/);f.invalidate();f.worker.report(f.agent,{outcome:'done',summary:'late'});
 }),/STALE_JOB_CLAIM/);assert.equal(f.disposed,1);
 const g=fixture(),abort=new AbortController();await assert.rejects(g.worker.run(g.job,abort.signal,async()=>{abort.abort();g.worker.report(g.agent,{outcome:'done',summary:'cancelled'});}),/WORKER_CANCELLED/);
});
test('reasoning policy is explicit, delivered and cannot silently change',async()=>{
 const f=fixture();f.job.policy=JSON.stringify({provider:'selected',model:'selected',reasoningEffort:'low'});
 f.agent.whenIdle=async()=>{await f.request(async()=>({provider:'selected',model:'selected',reasoningEffort:'off'}));};
 await assert.rejects(f.worker.run(f.job,new AbortController().signal),/MODEL_ROUTE_MISMATCH/);assert.equal(f.options.agentOptions.reasoningEffort,'low');
});
test('model failure remains actionable rather than becoming missing-report success/failure',async()=>{
 const f=fixture();f.agent.whenIdle=async()=>{f.error('INVALID_REQUEST');};
 await assert.rejects(f.worker.run(f.job,new AbortController().signal),/WORKER_MODEL_INVALID_REQUEST/);assert.equal(f.disposed,1);
});
test('actual dispatch refuses worker auxiliary titles, wrong routes, token overflow and excess retry calls',async()=>{
 const f=fixture(),o={sessionId:'dedicated',provider:'selected',model:'selected',maxTokens:2048};
 f.agent.whenIdle=async()=>{
  await assert.rejects(f.dispatch({...o,purpose:'session-title'}),/AUX_MODEL_DENIED/);
  await assert.rejects(f.dispatch({...o,model:'fallback'}),/MODEL_ROUTE_MISMATCH/);
  await assert.rejects(f.dispatch({...o,maxTokens:4096}),/TOKEN_BUDGET/);
  for(let i=0;i<5;i++)await f.dispatch(o);
  await assert.rejects(f.dispatch(o),/REQUEST_BUDGET/);
  f.worker.report(f.agent,{outcome:'done',summary:'checked'});
 };
 await f.worker.run(f.job,new AbortController().signal);
 assert.deepEqual(await f.dispatch({...o,sessionId:'ordinary'}),[]);
});

test('worker prompt preserves assigned child, prerequisite result and shared budget without new model/authority',async()=>{
 const f=fixture(),context={workflow_id:'w',parent_task_id:'task',child_id:'child',instruction:'Only summarize dependency',dependencies:[{status:'completed',checkpoint:{summary:'prior result'}}],shared_budget:{used_runs:2,max_runs:3},development:false};
 f.worker.config.workflowContext=id=>{assert.equal(id,'job');return context;};let prompt;
 f.agent.followup=m=>{prompt=m.content[0].text;};f.agent.whenIdle=async()=>f.worker.report(f.agent,{outcome:'done',summary:'child result'});
 await f.worker.run(f.job,new AbortController().signal);assert(prompt.includes(JSON.stringify(context)));assert.match(prompt,/不重新执行整个父任务/);assert.match(prompt,/禁止递归派生/);assert.equal(f.options.agentOptions.model,'selected');assert.equal(f.disposed,1);
});

test('search adapter reservation shares dispatch counter, respects probe denial and cannot bypass a finished report',async()=>{
 const f=fixture(),r={provider:'selected',model:'selected',maxTokens:2048,reasoningEffort:'disabled'},o={sessionId:'dedicated',provider:'selected',model:'selected',maxTokens:2048};
 f.agent.whenIdle=async()=>{
  for(let i=0;i<3;i++){await f.dispatch(o);f.worker.reserveSearchRequest(f.agent,r);}
  await assert.rejects(f.dispatch(o),/REQUEST_BUDGET/);assert.equal(f.reservations.length,6);assert.equal(f.reservations.filter(x=>x.purpose==='search').length,3);
  f.worker.report(f.agent,{outcome:'done',summary:'bounded fixture, no provider calls'});
  assert.throws(()=>f.worker.reserveSearchRequest(f.agent,r),/BATCH_ALREADY_FINAL/);
 };
 await f.worker.run(f.job,new AbortController().signal);
 const g=fixture();await g.worker.run(g.job,new AbortController().signal,async()=>{
  assert.throws(()=>g.worker.reserveSearchRequest(g.agent,r),/NO_MODEL/);
  assert.equal(g.reservations.length,0);g.worker.report(g.agent,{outcome:'done',summary:'probe checked'});
 });
});

test('durable reservation failure prevents actual stream dispatch, while normal entry sessions remain unchanged',async()=>{
 const f=fixture();let sends=0;f.worker.jobs.reserveModelRequest=()=>{throw Error('WORKER_REQUEST_BUDGET');};
 f.agent.whenIdle=async()=>{await f.dispatch({sessionId:'dedicated',provider:'selected',model:'selected',maxTokens:2048},()=>{sends++;return [];});};
 await assert.rejects(f.worker.run(f.job,new AbortController().signal),/REQUEST_BUDGET/);assert.equal(sends,0);
 await f.dispatch({sessionId:'ordinary'},()=>{sends++;return [];});assert.equal(sends,1);
});

test('an unresolved search dispatch cannot be certified by a successful worker report',async()=>{
 const f=fixture();f.worker.sources={searcher:{uncertain:()=>true}};
 f.agent.whenIdle=async()=>{f.worker.report(f.agent,{outcome:'done',summary:'model claimed completion'});};
 await assert.rejects(f.worker.run(f.job,new AbortController().signal),/SOURCE_SEARCH_DISPATCH_UNCERTAIN/);assert.equal(f.disposed,1);
});

test('unsupported high stops the managed worker without fallback or retry',async()=>{
 const f=fixture();f.job.policy=JSON.stringify({provider:'selected',model:'selected',reasoningEffort:'high'});let calls=0;
 f.agent.whenIdle=async()=>{calls++;f.error('UNSUPPORTED_REASONING_EFFORT');};
 await assert.rejects(f.worker.run(f.job,new AbortController().signal),/WORKER_MODEL_UNSUPPORTED_REASONING_EFFORT/);
 assert.equal(calls,1);assert.equal(f.options.agentOptions.reasoningEffort,'high');assert.equal(f.disposed,1);
});
