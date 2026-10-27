import test from 'node:test';
import assert from 'node:assert/strict';
import {semanticClassifier} from '../bundle/approval-semantic-model.js';
const policy={provider:'fixture',model:'test',reasoningEffort:'low'},config={enabled:true,policy};
const args={text:'我看过了，按这份计划开始吧',proposal:{summary:'无副作用测试'},signal:new AbortController().signal};
function fixture(chunks,alter={}){let seen;const ctx={llm:{prepareCall:async options=>({config:{...options,...alter},stream:async function*(o){seen=o;yield*chunks;}})}};return {run:semanticClassifier(ctx,config),seen:()=>seen};}
const output={intent:'approve',unconditional:true,changes:[],reason:'明确批准原方案'};
const chunks=[{type:'text-delta',index:0,text:JSON.stringify(output)},{type:'finish',reason:{kind:'stop'}}];
test('public DSH model adapter has fixed route, no tools, no agent/session and bounded tokens',async()=>{const f=fixture(chunks);assert.deepEqual(await f.run(args),output);assert.deepEqual(f.seen().tools,[]);assert.equal(f.seen().purpose,'approval-interpretation');assert.equal(f.seen().maxTokens,800);assert.equal(f.seen().provider,'fixture');assert.deepEqual(f.run.policy,policy);});
test('wrong prepared route is refused before streaming',async()=>{const f=fixture(chunks,{model:'other'});await assert.rejects(f.run(args),/ROUTE_CHANGED/);assert.equal(f.seen(),undefined);});
for(const end of [{kind:'max-tokens'},{kind:'error',failure:{code:'AUTH',message:'fixture'}}])test('non-success finish cannot yield approval: '+end.kind,async()=>{const f=fixture([chunks[0],{type:'finish',reason:end}]);await assert.rejects(f.run(args),/INCOMPLETE/);});
test('missing terminal chunk and malformed JSON fail closed',async()=>{await assert.rejects(fixture([chunks[0]]).run(args),/INCOMPLETE/);await assert.rejects(fixture([{type:'text-delta',index:0,text:'approve'},chunks[1]]).run(args));});
test('no configured semantic model is not an implicit fallback to the entry model',()=>{assert.equal(semanticClassifier({},{}),undefined);assert.equal(semanticClassifier({},{enabled:true}),undefined);});
