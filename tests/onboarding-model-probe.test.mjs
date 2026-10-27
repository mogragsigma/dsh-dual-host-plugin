import {createOnboardingActivity} from '../bundle/onboarding-activity.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOnboardingModelProbe,MODEL_PROBE_LIMITS,MODEL_PROBE_SYSTEM,MODEL_PROBE_INPUT} from '../bundle/onboarding-model-probe.js';
const provider='dsh-onboarding-deepseek',selection={provider,provider_name:'DeepSeek（双端配置）',model:'deepseek-flash',model_name:'DeepSeek Flash'};
const success=[{type:'block-start',index:0,blockType:'text'},{type:'text-delta',index:0,text:'DSH_CONNECTION_OK'},{type:'block-end',index:0,block:{type:'text',text:'DSH_CONNECTION_OK'}},{type:'finish',reason:{kind:'stop'}}];
function fixture(){
 const records=new Map();let tail=Promise.resolve(),time=1000,calls=0,prepared=0,writes=0,throwWrite=false,entered;
 const started=new Promise(r=>entered=r),lookups=[],requests=[],binding={state:'configured_unverified',registered:true,provider,bindingRevision:1,credentialRevision:1,target:{role:'local',name:'本地大肥鱼',source:'setup_configuration',platform:'darwin'}};
 const credentials={readRecord:async k=>structuredClone(records.get(k)),modifyRecord(k,f){const p=tail.then(async()=>{if(throwWrite)throw Error('PRIVATE_STORAGE_ERROR');const next=await f(structuredClone(records.get(k)));if(next!==undefined){writes++;records.set(k,structuredClone(next));}});tail=p.catch(()=>{});return p;}};
 const state={selection:structuredClone(selection),resolution:'resolved',chunks:success,configChange:{},stream:undefined,prepareError:undefined};
 const llm={async prepareCall(policy,signal){prepared++;if(state.prepareError)throw state.prepareError;return {config:{...policy,...state.configChange},stream(a){calls++;requests.push(a);entered();return state.stream?state.stream(a):(async function*(){for(const chunk of state.chunks)yield chunk;})();}};}};
 const options={credentials:()=>credentials,llm:()=>llm,snapshot:async()=>structuredClone(binding),resolve:async a=>{lookups.push(structuredClone(a));return {status:state.resolution,selection:structuredClone(state.selection)};},provider,recordName:'onboarding-model-binding-v1',now:()=>time};
 const probe=createOnboardingModelProbe(options);
 return {probe,options,records,binding,state,started,requests,lookups,counts:()=>({calls,prepared,writes}),advance:n=>time+=n,throwWrite:()=>throwWrite=true};
}
const preview=f=>f.probe.preview({query:'ds flash',acknowledgeUnknown:null});
const confirm=p=>({id:p.id,fingerprint:p.fingerprint,confirm:true});
test('metadata and preview neither infer nor create a receipt',async()=>{const f=fixture();assert.equal((await f.probe.status({})).receipt,null);const p=await preview(f);assert.equal(p.selection.model,selection.model);assert.equal(p.reasoningEffort,'high');assert.equal(p.limits.requests,1);assert.equal(p.modelRequests,0);assert.deepEqual(f.counts(),{calls:0,prepared:0,writes:0});});
test('confirmed attempt uses exact native route, High, fixed input, no tools; records no output',async()=>{
 const f=fixture(),p=await preview(f),r=await f.probe.apply(confirm(p));assert.equal(r.receipt.state,'succeeded');assert(r.receipt.verifiedForCurrentBinding);assert.equal(f.counts().calls,1);
 const q=f.requests[0];assert.equal(q.provider,provider);assert.equal(q.model,selection.model);assert.equal(q.reasoningEffort,'high');assert.equal(q.maxTokens,1024);assert.equal(q.system,MODEL_PROBE_SYSTEM);assert.equal(q.messages[0].content[0].text,MODEL_PROBE_INPUT);assert.deepEqual(q.tools,[]);assert.equal(q.purpose,'onboarding-connection-check');assert(q.signal.aborted);
 const saved=[...f.records.values()][0].payload;assert(saved.request.messages[0].id);assert(!('response' in saved));assert(!JSON.stringify(r).includes(MODEL_PROBE_SYSTEM));assert(!r.defaultModelChanged&&!r.taskStarted&&!r.automaticRetry);
 const again=await f.probe.apply(confirm(p));assert.deepEqual(again.receipt,r.receipt);assert.equal(f.counts().calls,1);
});
test('confirmation and freshness are required before durable start',async()=>{const f=fixture(),p=await preview(f);await assert.rejects(f.probe.apply({...confirm(p),confirm:false}),/CONFIRMATION_REQUIRED/);f.advance(300001);await assert.rejects(f.probe.apply(confirm(p)),/PLAN_EXPIRED/);assert.equal(f.counts().calls,0);assert.equal(f.counts().writes,0);});
test('missing binding, ambiguous catalog and other native providers cannot be probed',async()=>{
 const f=fixture();f.binding.state='not_configured';await assert.rejects(preview(f),/BINDING_REQUIRED/);f.binding.state='configured_unverified';f.state.resolution='ambiguous';await assert.rejects(preview(f),/MODEL_SELECTION_REQUIRED/);f.state.resolution='resolved';f.state.selection.provider='native-daily';await assert.rejects(preview(f),/OWN_ROUTE_REQUIRED/);assert.equal(f.counts().prepared,0);
});
test('changed credential, catalog or prepared route stops before stream',async()=>{
 const f=fixture(),p=await preview(f);f.binding.credentialRevision++;await assert.rejects(f.probe.apply(confirm(p)),/BINDING_CHANGED/);assert.equal(f.counts().calls,0);
 const g=fixture(),q=await preview(g);g.state.selection.model='another-model';await assert.rejects(g.probe.apply(confirm(q)),/ROUTE_CHANGED/);assert.equal(g.counts().calls,0);
 const h=fixture(),a=await preview(h);h.state.configChange.reasoningEffort='low';const r=await h.probe.apply(confirm(a));assert.equal(r.receipt.error,'ROUTE_CHANGED');assert.equal(r.receipt.state,'failed');assert.equal(h.counts().calls,0);
});
test('current credential revision invalidates historic successful observation without retry',async()=>{const f=fixture();await f.probe.apply(confirm(await preview(f)));f.binding.credentialRevision++;const r=await f.probe.status({});assert.equal(r.receipt.state,'succeeded');assert.equal(r.receipt.verifiedForCurrentBinding,false);assert.equal(f.counts().calls,1);});
test('two competing controllers cannot execute the same receipt generation',async()=>{
 const f=fixture(),other=createOnboardingModelProbe(f.options),a=await preview(f),b=await other.preview({query:'ds flash',acknowledgeUnknown:null});
 const done=await Promise.allSettled([f.probe.apply(confirm(a)),other.apply(confirm(b))]);assert.equal(done.filter(x=>x.status==='fulfilled').length,1);assert.match(done.find(x=>x.status==='rejected').reason.message,/RECEIPT_CHANGED/);assert.equal(f.counts().calls,1);
});
test('active call rejects another preview; status can observe running without creating a call',async()=>{
 const f=fixture();let release;f.state.stream=async function*(){await new Promise(r=>release=r);yield* success;};const p=await preview(f),run=f.probe.apply(confirm(p));await f.started;
 assert.equal((await f.probe.status({})).receipt.state,'running');await assert.rejects(preview(f),/BUSY/);release();await run;assert.equal(f.counts().calls,1);
});
test('provider failure is classified without retaining private text or retrying',async()=>{
 const f=fixture();f.state.chunks=[{type:'finish',reason:{kind:'error',failure:{code:'AUTH',message:'SYNTHETIC_SECRET_VALUE'}}}];const r=await f.probe.apply(confirm(await preview(f)));assert.equal(r.receipt.error,'AUTH');assert.equal(r.receipt.state,'failed');assert(!JSON.stringify(r).includes('SYNTHETIC_SECRET_VALUE'));assert(!JSON.stringify([...f.records.values()]).includes('SYNTHETIC_SECRET_VALUE'));assert.equal(f.counts().calls,1);
});
test('missing terminal response stays unknown; a new distinct confirmation must acknowledge it',async()=>{
 const f=fixture();f.state.chunks=success.slice(0,-1);const original=await preview(f),r=await f.probe.apply(confirm(original));assert.equal(r.receipt.state,'unknown');await assert.rejects(preview(f),/UNKNOWN_ACK_REQUIRED/);
 const plan=await f.probe.preview({query:'ds flash',acknowledgeUnknown:original.id});assert.equal(plan.previousUnknown,original.id);assert.notEqual(plan.id,original.id);assert.equal(f.counts().calls,1);
 // A status-only replay is not another request; the new plan remains unsubmitted.
 assert.equal((await f.probe.apply(confirm(original))).receipt.state,'unknown');assert.equal(f.counts().calls,1);
});
test('crash before settlement remains unknown on restart and never replays',async()=>{
 const f=fixture(),p=await preview(f);f.state.stream=async function*(){f.throwWrite();yield* success;};await assert.rejects(f.probe.apply(confirm(p)),/OUTCOME_UNKNOWN/);
 const next=createOnboardingModelProbe(f.options);assert.equal((await next.status({})).receipt.state,'unknown');await next.apply(confirm(p));assert.equal(f.counts().calls,1);await assert.rejects(next.preview({query:'ds flash',acknowledgeUnknown:p.id}),/BUSY/);
 f.advance(MODEL_PROBE_LIMITS.timeoutMs);const newer=await next.preview({query:'ds flash',acknowledgeUnknown:p.id});assert.equal(newer.previousUnknown,p.id);assert.equal(f.counts().calls,1);
});
test('bounded timeout aborts native request and records uncertainty rather than success',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture();f.state.stream=async function*(){await new Promise(()=>{});};const p=await preview(f),run=f.probe.apply(confirm(p));await f.started;t.mock.timers.tick(MODEL_PROBE_LIMITS.timeoutMs);const r=await run;assert.equal(r.receipt.state,'unknown');assert.equal(r.receipt.error,'DEADLINE');assert(f.requests[0].signal.aborted);assert.equal(f.counts().calls,1);
});
test('oversized output and tool blocks cannot pass the connection check',async()=>{
 const f=fixture();f.state.chunks=[{type:'text-delta',index:0,text:'x'.repeat(MODEL_PROBE_LIMITS.maxResponseBytes+1)}];assert.equal((await f.probe.apply(confirm(await preview(f)))).receipt.error,'OUTPUT_LIMIT');
 const g=fixture();g.state.chunks=[{type:'block-start',index:0,blockType:'tool-call'},{type:'block-end',index:0,block:{type:'tool-call',id:'test',name:'write',arguments:'{}'}},{type:'finish',reason:{kind:'stop'}}];assert.equal((await g.probe.apply(confirm(await preview(g)))).receipt.error,'TOOL_DENIED');
});
test('malformed and foreign durable records are retained and rejected',async()=>{const f=fixture();await f.probe.apply(confirm(await preview(f)));const k=[...f.records.keys()][0];f.records.set(k,{kind:'api-key',key:'KEEP_USER_RECORD'});await assert.rejects(f.probe.status({}),/RECORD_REVIEW/);assert.equal(f.records.get(k).key,'KEEP_USER_RECORD');});
test('arguments cannot inject provider, prompt, endpoint, tools or extra request count',async()=>{const f=fixture();for(const [k,v] of Object.entries({provider:'daily',prompt:'write files',endpoint:'https://invalid.example',tools:['write'],requests:2})){await assert.rejects(f.probe.preview({query:'ds flash',acknowledgeUnknown:null,[k]:v}),/ARGUMENTS/);}await assert.rejects(f.probe.apply({id:randomUUID(),fingerprint:'a'.repeat(64),confirm:true,query:'other'}),/CONFIRMATION_REQUIRED/);assert.equal(f.counts().calls,0);});
test('prepared model drift and changed credential during streaming cannot verify another route',async()=>{
 const f=fixture();f.state.configChange.model='different';const r=await f.probe.apply(confirm(await preview(f)));assert.equal(r.receipt.error,'ROUTE_CHANGED');assert.equal(f.counts().calls,0);
 const g=fixture();g.state.stream=async function*(){g.binding.credentialRevision++;yield* success;};const changed=await g.probe.apply(confirm(await preview(g)));assert.equal(changed.receipt.error,'BINDING_CHANGED');assert.equal(changed.receipt.verifiedForCurrentBinding,false);
});
test('malformed outcome or cross-provider receipt is rejected rather than shown as verified',async()=>{
 const f=fixture();await f.probe.apply(confirm(await preview(f)));const k=[...f.records.keys()][0],original=structuredClone(f.records.get(k));
 for(const patch of [{state:'started'},{completedAt:null},{error:'AUTH'},{selection:{...selection,provider:'other-provider'}}]){f.records.set(k,{...original,payload:{...original.payload,...patch}});await assert.rejects(f.probe.status({}),/RECORD_REVIEW/);}
});
test('late credential read cannot dispatch after the probe deadline',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture();let reads=0,release,reached;const waiting=new Promise(r=>reached=r);
 const probe=createOnboardingModelProbe({...f.options,snapshot:async()=>{reads++;if(reads===4){reached();await new Promise(r=>release=r);}return structuredClone(f.binding);}});
 const p=await probe.preview({query:'ds flash',acknowledgeUnknown:null}),run=probe.apply(confirm(p));await waiting;t.mock.timers.tick(MODEL_PROBE_LIMITS.timeoutMs);const r=await run;assert.equal(r.receipt.state,'unknown');release();await new Promise(r=>setImmediate(r));assert.equal(f.counts().calls,0);
});
test('async start commits intent and returns while provider is pending; status/replay do not retry',async()=>{
 const f=fixture();let release;f.state.stream=async function*(){await new Promise(r=>release=r);yield* success;};
 const p=await preview(f),r=await f.probe.start(confirm(p));await f.started;assert.equal(r.contract,2);assert.equal(r.receipt.state,'running');assert.equal([...f.records.values()][0].payload.state,'started');
 assert.equal((await f.probe.start(confirm(p))).receipt.id,p.id);await assert.rejects(preview(f),/BUSY/);assert.equal(f.counts().calls,1);
 release();await new Promise(r=>setImmediate(r));assert.equal((await f.probe.status({})).receipt.state,'succeeded');assert.equal(f.counts().calls,1);
});
test('async settlement storage failure preserves unknown intent and consumes its authorization',async()=>{
 const f=fixture();let release;f.state.stream=async function*(){await new Promise(r=>release=r);f.throwWrite();yield* success;};
 const p=await preview(f);await f.probe.start(confirm(p));await f.started;release();await new Promise(r=>setImmediate(r));
 const restarted=createOnboardingModelProbe(f.options);assert.equal((await restarted.status({})).receipt.state,'unknown');await restarted.start(confirm(p));assert.equal(f.counts().calls,1);
});
test('async busy remains closed while settlement is pending even after deadline',async()=>{
 const f=fixture();let unblock,entered;const held=new Promise(r=>entered=r);let hold=false;
 const base=f.options.credentials(),credentials={...base,modifyRecord:async(k,fn)=>{if(hold){entered();await new Promise(r=>unblock=r);}return base.modifyRecord(k,fn);}};
 const probe=createOnboardingModelProbe({...f.options,credentials:()=>credentials});f.state.stream=async function*(){hold=true;yield* success;};
 await probe.start(confirm(await probe.preview({query:'ds flash',acknowledgeUnknown:null})));await held;f.advance(70000);
 await assert.rejects(probe.preview({query:'ds flash',acknowledgeUnknown:null}),/BUSY/);unblock();await new Promise(r=>setImmediate(r));assert.equal((await probe.status({})).receipt.state,'succeeded');
});

test('plain clarification remains bound through preview and start revalidation',async()=>{
 const f=fixture(),lookup={query:'ds flash',clarification:'请用 DeepSeek（双端配置）'},p=await f.probe.preview({...lookup,acknowledgeUnknown:null});assert.deepEqual(f.lookups,[lookup]);await f.probe.apply(confirm(p));assert.deepEqual(f.lookups,[lookup,lookup]);assert.equal(f.counts().calls,1);assert(!JSON.stringify([...f.records.values()]).includes(lookup.clarification));
});
test('invalid clarification fails before lookup, storage or model access',async()=>{
 const f=fixture();for(const clarification of ['',null,'x'.repeat(201),'a\nb','a\x7fb',44])await assert.rejects(f.probe.preview({query:'ds flash',clarification,acknowledgeUnknown:null}),/ARGUMENTS/);await assert.rejects(f.probe.preview(null),/ARGUMENTS/);assert.equal(f.lookups.length,0);assert.deepEqual(f.counts(),{calls:0,prepared:0,writes:0});
});

test('maintenance refusal precedes a model intent and does not spend a model request',async()=>{
 const f=fixture(),gate=createOnboardingActivity(),probe=createOnboardingModelProbe({...f.options,admit:label=>gate.enter(label)}),p=await probe.preview({query:'ds flash',acknowledgeUnknown:null}),h=gate.preview({});gate.apply(confirm(h));
 await assert.rejects(probe.start(confirm(p)),/ACTIVITY_HELD/);assert.equal(f.counts().writes,0);assert.equal(f.counts().prepared,0);assert(!gate.status().busy);
});
test('model timeout keeps actual adapter work busy until it settles, without rerunning it',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture(),gate=createOnboardingActivity();let finish;
 f.state.stream=async function*(){await new Promise(r=>finish=r);yield* success;};
 const probe=createOnboardingModelProbe({...f.options,admit:label=>gate.enter(label)}),p=await probe.preview({query:'ds flash',acknowledgeUnknown:null});await probe.start(confirm(p));await f.started;
 assert.equal(gate.status().counts.model_attempt,1);t.mock.timers.tick(MODEL_PROBE_LIMITS.timeoutMs);await new Promise(r=>setImmediate(r));
 assert.equal((await probe.status({})).receipt.state,'unknown');assert.equal(gate.status().counts.model_attempt,1);assert(!gate.preview({}).canApply);
 await assert.rejects(probe.preview({query:'ds flash',acknowledgeUnknown:p.id}),/BUSY/);finish();await new Promise(r=>setImmediate(r));assert.equal(gate.status().counts.model_attempt,0);assert(gate.preview({}).canApply);assert.equal(f.counts().calls,1);
});
test('failed model intent releases admission without dispatching, and successful ledger settlement releases normally',async()=>{
 const f=fixture(),gate=createOnboardingActivity(),probe=createOnboardingModelProbe({...f.options,admit:label=>gate.enter(label)}),p=await probe.preview({query:'ds flash',acknowledgeUnknown:null});f.throwWrite();await assert.rejects(probe.apply(confirm(p)),/PRIVATE_STORAGE_ERROR/);assert(!gate.status().busy);assert.equal(f.counts().calls,0);
 const g=fixture(),other=createOnboardingModelProbe({...g.options,admit:label=>gate.enter(label)}),q=await other.preview({query:'ds flash',acknowledgeUnknown:null});await other.apply(confirm(q));await new Promise(r=>setImmediate(r));assert(!gate.status().busy);
});
