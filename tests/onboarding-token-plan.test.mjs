import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOnboardingTokenPlanModels,TOKEN_PLAN_PROVIDER,TOKEN_PLAN_ENDPOINT,TOKEN_PLAN_NAME} from '../bundle/onboarding-token-plan.js';
import {createOnboardingState} from '../bundle/onboarding-state.js';
import {createOnboardingModels} from '../bundle/onboarding-models.js';
import {createOnboardingService} from '../bundle/onboarding-host.js';
const secret='sk-SYNTHETIC_TOKEN_PLAN_S56_NOT_REAL';
const confirm=p=>({id:p.id,fingerprint:p.fingerprint,confirm:true});
function fixture(extra={}){
 const records=new Map(),adapters=new Map();let writes=0,tail=Promise.resolve(),time=1000;
 const credentials={readRecord:async k=>structuredClone(records.get(k)),describeRecord:async()=>({writable:true}),modifyRecord(k,f){const p=tail.then(async()=>{const v=await f(structuredClone(records.get(k)));if(v!==undefined){records.set(k,structuredClone(v));writes++;}});tail=p.catch(()=>{});return p;}};
 const llm={registerAdapter(ids,adapter){for(const id of ids){assert(!adapters.has(id));adapters.set(id,adapter);}},listProviders:()=>[{id:'existing-native',name:'untouched'},...[...adapters].map(([id,a])=>a.providerInfo(id))],listModels:async p=>adapters.has(p)?adapters.get(p).listModels(p):[],resolveCallConfig:async c=>c};
 const runtime={credentials,llm,home:'/isolated/token/home',env:{},now:()=>time,...extra};
 const models=createOnboardingTokenPlanModels({}, {},runtime),state=createOnboardingState({}, {},runtime);
 const put=(slot='token-plan',revision=0,value=secret)=>state.put({slot,expectedRevision:revision,operation:randomUUID(),confirm:true,secret:value});
 return {records,adapters,llm,runtime,models,state,put,advance:n=>{time+=n;},writes:()=>writes,adapter:()=>adapters.get(TOKEN_PLAN_PROVIDER)};
}
async function enabled(){const f=fixture();await f.put();await f.models.apply(confirm(await f.models.preview({enabled:true})));return f;}
async function highModel(f){for(const row of await f.llm.listModels(TOKEN_PLAN_PROVIDER)){const m=await f.adapter().resolveModel(TOKEN_PLAN_PROVIDER,row.id);if(m.reasoning?.efforts?.some(x=>x.id==='high'))return row;}throw Error('Installed catalog has no High model');}
test('optional token adapter is dormant without a binding, including missing dependencies',async()=>{
 let loads=0;const f=fixture({loadTokenPlan:async()=>{loads++;throw Error('missing synthetic dependency');}});
 await f.models.start();assert.equal((await f.models.status()).state,'not_configured');assert.equal(loads,0);assert.equal(f.writes(),0);
 await f.put();await assert.rejects(f.models.preview({enabled:true}),/ADAPTER_UNAVAILABLE/);assert.equal(loads,1);assert.equal(f.adapters.size,0);
 const ds=createOnboardingModels({}, {},f.runtime);assert.equal((await ds.status()).state,'not_configured');
});
test('DeepSeek keys do not satisfy Token Plan and ordinary form cannot redirect endpoint',async()=>{
 const f=fixture();await f.put('deepseek-local');await f.put('deepseek-cloud');await assert.rejects(f.models.preview({enabled:true}),/CREDENTIAL_REQUIRED/);
 await assert.rejects(f.models.preview({enabled:true,endpoint:'https://invalid.example'}),/ARGUMENTS/);assert.equal(f.adapters.size,0);
});
test('native upstream adapter/catalog loads under a separate approved route without inference',async()=>{
 const f=fixture();await f.put();const count=f.writes(),plan=await f.models.preview({enabled:true});assert.equal(f.writes(),count);assert.equal(f.adapters.size,0);assert.equal(plan.endpoint,TOKEN_PLAN_ENDPOINT);assert.equal(plan.credentialSlot,'token-plan');
 const s=await f.models.apply(confirm(plan));assert.equal(s.state,'configured_unverified');assert.equal(s.provider,TOKEN_PLAN_PROVIDER);assert.equal(s.providerName,TOKEN_PLAN_NAME);assert(!s.verificationRecorded&&!s.defaultModelChanged&&!s.cloudTransferred);
 const models=await f.llm.listModels(TOKEN_PLAN_PROVIDER);assert(models.length>0);assert(models.every(x=>x.provider===TOKEN_PLAN_PROVIDER));assert(f.llm.listProviders().some(x=>x.id==='existing-native'));assert(!JSON.stringify({plan,s,models}).includes(secret));
 const metadata=await f.adapter().resolveModel(TOKEN_PLAN_PROVIDER,models[0].id);assert.equal(metadata.provider,TOKEN_PLAN_PROVIDER);assert.equal(f.adapter().providerRetryPolicy(TOKEN_PLAN_PROVIDER).maxRetries,0);
});
test('native discovery and name resolution use target catalog, no borrowed credential or default write',async()=>{
 const f=await enabled(),models=await f.llm.listModels(TOKEN_PLAN_PROVIDER),count=f.writes();
 const row=models.find(x=>/glm/i.test(x.id))??models[0];const resolved=await f.models.resolve({query:row.id});
 assert.equal(resolved.status,'resolved');assert.equal(resolved.selection.provider,TOKEN_PLAN_PROVIDER);assert.equal(resolved.model_policy.reasoningEffort,'high');assert(!resolved.provider_io_verified&&!resolved.execution_authorized);assert.equal(f.writes(),count);
});
test('rotated and removed Token Plan key invalidates only its own binding',async()=>{
 const f=await enabled();await f.put('deepseek-local');const deepseekRecord=structuredClone(f.records.get('dsh-task-gateway/onboarding-deepseek-local-v1'));
 await f.put('token-plan',1,'sk-ROTATED_SYNTHETIC_TOKEN_ONLY');assert.equal((await f.models.status()).state,'credential_changed');assert.deepEqual(await f.llm.listModels(TOKEN_PLAN_PROVIDER),[]);
 await f.models.apply(confirm(await f.models.preview({enabled:true})));assert.equal((await f.models.status()).state,'configured_unverified');await f.state.remove({slot:'token-plan',expectedRevision:2,operation:randomUUID(),confirm:true});assert.deepEqual(await f.llm.listModels(TOKEN_PLAN_PROVIDER),[]);assert.deepEqual(f.records.get('dsh-task-gateway/onboarding-deepseek-local-v1'),deepseekRecord);
});
test('explicit disable preserves Key; disabled native streams reject before any network',async()=>{
 const f=await enabled(),row=await highModel(f);await f.models.apply(confirm(await f.models.preview({enabled:false})));
 assert.equal((await f.models.status()).state,'disabled');assert.equal((await f.state.readManagedSecret('token-plan')).value,secret);assert.deepEqual(await f.llm.listModels(TOKEN_PLAN_PROVIDER),[]);
 await assert.rejects(async()=>{for await(const _ of f.adapter().stream({provider:TOKEN_PLAN_PROVIDER,model:row.id,messages:[],reasoningEffort:'high'})){}},/未启用|凭据已变化/);
});
test('restart restores only approved token binding, not a duplicate secret or other route',async()=>{
 const f=await enabled(),count=f.writes();f.adapters.clear();const next=createOnboardingTokenPlanModels({}, {},f.runtime);await next.start();assert.equal((await next.status()).state,'configured_unverified');assert.equal(f.writes(),count);assert.equal(f.adapters.size,1);
});
test('stale, expired and concurrent token plans fail closed; same approval is idempotent',async()=>{
 const f=fixture();await f.put();const a=await f.models.preview({enabled:true});await f.put('token-plan',1,secret+'2');await assert.rejects(f.models.apply(confirm(a)),/CREDENTIAL_CHANGED/);
 const b=await f.models.preview({enabled:true});f.advance(300001);await assert.rejects(f.models.apply(confirm(b)),/PLAN_EXPIRED/);
 const other=createOnboardingTokenPlanModels({}, {},f.runtime),c=await other.preview({enabled:false}),d=await f.models.preview({enabled:true});await f.models.apply(confirm(d));const n=f.writes();await f.models.apply(confirm(d));assert.equal(f.writes(),n);await assert.rejects(other.apply(confirm(c)),/BINDING_CONFLICT/);
});
test('token RPC is explicit and redacted, preserves existing DeepSeek RPC contract',async()=>{
 const f=await enabled(),ds=createOnboardingModels({}, {},f.runtime),rpc=createOnboardingService({}, {},{...f.runtime,models:ds,tokenModels:f.models});
 assert((await rpc.call('describe',{})).capabilities.tokenPlanBinding);assert.equal((await rpc.call('model_status',{})).state,'not_configured');assert.equal((await rpc.call('token_model_status',{})).state,'configured_unverified');
 await assert.rejects(rpc.call('token_model_auth',{}),/METHOD_DENIED/);await assert.rejects(rpc.call('token_model_preview',{enabled:true,slot:'deepseek-local'}),/ARGUMENTS/);assert(!JSON.stringify(await rpc.call('token_model_status',{})).includes(secret));
});
test('official adapter mocked transport uses own Key, fixed endpoint and native High mapping, no live HTTP',async t=>{
 const f=await enabled(),row=await highModel(f),original=globalThis.fetch,requests=[];t.after(()=>{globalThis.fetch=original;});
 globalThis.fetch=async(url,init)=>{
  const endpoint=String(url),headers=new Headers(init?.headers),body=JSON.parse(init.body);
  requests.push({endpoint,headers,body});assert.equal(endpoint,TOKEN_PLAN_ENDPOINT+'/chat/completions');assert.equal(headers.get('authorization'),'Bearer '+secret);
  return new Response('data: '+JSON.stringify({id:'synthetic',object:'chat.completion.chunk',model:row.id,choices:[{index:0,delta:{role:'assistant',content:'ok'},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({id:'synthetic',object:'chat.completion.chunk',model:row.id,choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{status:200,headers:{'content-type':'text/event-stream'}});
 };
 const chunks=[];for await(const x of f.adapter().stream({provider:TOKEN_PLAN_PROVIDER,model:row.id,messages:[{role:'user',content:[{type:'text',text:'synthetic adapter contract'}]}],reasoningEffort:'high',maxTokens:32}))chunks.push(x);
 assert.equal(requests.length,1);assert.equal(requests[0].body.model,row.id);assert.equal(chunks.filter(x=>x.type==='text-delta').map(x=>x.text).join(''),'ok');assert(chunks.some(x=>x.type==='finish'&&x.reason?.kind==='stop'));
 assert(requests[0].body.reasoning_effort==='high'||requests[0].body.enable_thinking===true||requests[0].body.thinking?.type==='enabled');
});
