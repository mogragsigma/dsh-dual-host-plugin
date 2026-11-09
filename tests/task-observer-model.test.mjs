import test from 'node:test';import assert from 'node:assert/strict';
import {observationModel} from '../bundle/task-observer-model.js';
import {TaskObserver} from '../bundle/task-observer.js';
import {setup,policy} from './helpers/observation-fixture.mjs';
const result={summary:'疑似交接等待',missing_evidence:'需要核对报告',suggestion:'查看已有成果'},chunks=[{type:'text-delta',index:0,text:JSON.stringify(result)},{type:'finish',reason:{kind:'stop'}}];
function fixture({alter={},output=chunks,retries=1,limit=3}={}){
 let middleware,used=0,calls=0,seen,disposed=false;
 const ctx={on(name,fn){assert.equal(name,'llm/stream');middleware=fn;return ()=>disposed=true;},llm:{prepareCall:async c=>({config:{...c,...alter},async *stream(o){seen=o;for(let i=0;i<retries;i++)yield*middleware(o,async function*(){calls++;yield*output;});}})}};
 const model=observationModel(ctx,{policy,timeoutMs:1000},()=>{if(used>=limit)throw Error('BUDGET_EXHAUSTED');used++;});
 return {model,ctx,run:signal=>model.run({task:'仅合成资料'},signal??new AbortController().signal),stats:()=>({used,calls,seen,disposed})};
}
test('public model adapter uses exact route, no tools/agents/sessions, token/response bound',async()=>{const f=fixture();assert.deepEqual(await f.run(),result);const s=f.stats();assert.equal(s.used,1);assert.equal(s.calls,1);assert.equal(s.seen.maxTokens,800);assert.deepEqual(s.seen.tools,[]);assert.equal(s.seen.purpose,'task-observer');f.model.dispose();assert.equal(f.stats().disposed,true);});
test('native retry streams reserve each request before dispatch; budget prevents second retry',async()=>{const f=fixture({retries:2,limit:1});await assert.rejects(f.run(),/BUDGET_EXHAUSTED/);assert.equal(f.stats().calls,1);assert.equal(f.stats().used,1);});
test('changed prepared model is denied before dispatch and does not consume a request',async()=>{const f=fixture({alter:{model:'other'}});await assert.rejects(f.run(),/MODEL_CHANGED/);assert.equal(f.stats().calls,0);assert.equal(f.stats().used,0);});
for(const reason of [{kind:'max-tokens'},{kind:'error',failure:{code:'X',message:'synthetic'}}])test('non-success terminal cannot become diagnosis '+reason.kind,async()=>{const f=fixture({output:[chunks[0],{type:'finish',reason}]});await assert.rejects(f.run(),/INCOMPLETE/);assert.equal(f.stats().used,1);});
test('missing finish, invalid JSON, tools, and oversized response rejected',async()=>{
 for(const output of [[chunks[0]],[{type:'text-delta',index:0,text:'not JSON'},chunks[1]],[{type:'block-start',index:0,blockType:'tool-call'},{type:'tool-call-delta',index:0,id:'x',name:'bash',argumentsDelta:'{}'},chunks[1]],[{type:'text-delta',index:0,text:'x'.repeat(25000)},chunks[1]]])await assert.rejects(fixture({output}).run());
});
test('aborted diagnosis cannot dispatch',async()=>{const f=fixture(),c=new AbortController();c.abort();await assert.rejects(f.run(c.signal));assert.equal(f.stats().calls,0);});
test('persistent observer budget is cumulative across restart and cannot silently shrink below use',async t=>{
 const f=setup(t),c={enabled:true,diagnostics:{enabled:true,policy,maxRequests:2,endAt:f.g.now()+10000}};
 const a=new TaskObserver(f.g,c);a.budgets.reserve('task-observer-budget',policy,'observer');await a.close();
 const b=new TaskObserver(f.g,c);assert.equal(b.budgets.view('task-observer-budget').used,1);b.budgets.reserve('task-observer-budget',policy,'observer');assert.throws(()=>b.budgets.reserve('task-observer-budget',policy,'observer'),/BUDGET_EXHAUSTED/);await b.close();assert.throws(()=>new TaskObserver(f.g,{...c,diagnostics:{...c.diagnostics,maxRequests:1}}),/BELOW_USED/);
});
test('expired explicit diagnosis authorization never creates model adapter',t=>{const f=setup(t);const o=new TaskObserver(f.g,{enabled:true,diagnostics:{enabled:true,policy,maxRequests:1,endAt:f.g.now()-1}});assert(!o.review);});
