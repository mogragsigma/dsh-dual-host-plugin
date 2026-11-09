import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {ModelSelection} from '../bundle/model-selection.js';
import {Gateway} from '../bundle/index.js';
import {registerNativeTools} from '../bundle/native-tools.js';
import {CAPABILITIES,validateHello,requireCapability} from '../bundle/link-contract.js';
const route=(provider='deepseek-official',model='deepseek-flash',name='DeepSeek Flash')=>({provider,id:model,name});
function fixture({routes=[route()],role='cloud',aliases=[],llm={}}={}){
 const calls={list:0,validate:[],inference:0};
 const api={listProviders:()=>[...new Set(routes.map(m=>m.provider))].map(id=>({id,name:id==='deepseek-official'?'DeepSeek 官方':id})),listModels:async p=>{calls.list++;return routes.filter(m=>m.provider===p);},resolveCallConfig:async p=>{calls.validate.push(p);return p;},...llm};
 const g={c:{role,modelSelection:{aliases}},ctx:{llm:api},now:()=>1234};
 return {selector:new ModelSelection(g),g,calls,routes};
}
for(const query of ['ds flash','DS FLASH','DeepSeek-Flash','deepseek_flash','DeepSeek Flash','ｄｓ　ｆｌａｓｈ'])test('unique nickname '+query,async()=>{
 const f=fixture(),r=await f.selector.resolve({host:'cloud',query});assert.equal(r.status,'resolved');assert.deepEqual(r.model_policy,{provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:'high'});assert.equal(r.execution_authorized,false);assert.equal(r.provider_io_verified,false);assert.equal(f.calls.inference,0);
});
test('duplicates across providers require plain language; official hint resolves',async()=>{
 const f=fixture({routes:[route(),route('configured-channel')]});let r=await f.selector.resolve({host:'cloud',query:'ds flash'});assert.equal(r.status,'ambiguous');assert.equal(r.candidates.length,2);assert.equal(r.model_policy,undefined);assert.equal(f.calls.validate.length,0);
 r=await f.selector.resolve({host:'cloud',query:'ds flash',provider_hint:'官方那个'});assert.equal(r.status,'resolved');assert.equal(r.model_policy.provider,'deepseek-official');
});
test('dated version is never silently interpreted as another version',async()=>{
 for(const query of ['DeepSeek-v4.1-flash1017','deepseek-flahs','ds flahs']){const r=await fixture().selector.resolve({host:'cloud',query});assert.equal(r.status,'not_found');assert.equal(r.model_policy,undefined);}
});
test('explicit operator alias only works while its exact route exists',async()=>{
 const aliases=[{alias:'ds flash',provider:'private',model:'DeepSeek-v4.1-flash1017'}];
 let f=fixture({aliases,routes:[route('private','DeepSeek-v4.1-flash1017','私有模型名称')]});assert.equal((await f.selector.resolve({host:'cloud',query:'ds flash'})).model_policy.model,aliases[0].model);
 f=fixture({aliases,routes:[route('private','another','另一个')]});assert.equal((await f.selector.resolve({host:'cloud',query:'ds flash'})).status,'not_found');
});
test('two configured aliases never silently select first',async()=>{
 const aliases=['a','b'].map(provider=>({alias:'鱼',provider,model:'m'}));const f=fixture({aliases,routes:[route('a','m','A'),route('b','m','B')]});assert.equal((await f.selector.resolve({host:'cloud',query:'鱼'})).status,'ambiguous');
});
test('empty query lists metadata only, no endpoint credentials or arbitrary properties',async()=>{
 const f=fixture({routes:[{...route(),apiKey:'SECRET',description:'SECRET',baseURL:'SECRET'}]});const r=await f.selector.resolve({host:'cloud',query:''});assert.equal(r.status,'catalog');assert(!JSON.stringify(r).includes('SECRET'));assert.equal(f.calls.validate.length,0);
});
test('partial catalog cannot establish uniqueness; suppress raw adapter errors',async()=>{
 const f=fixture({routes:[route(),route('failed')],llm:{listModels:async p=>{if(p==='failed')throw Error('SECRET_ENDPOINT');return [route()];}}});const r=await f.selector.resolve({host:'cloud',query:'ds flash'});assert.equal(r.status,'catalog_incomplete');assert.equal(r.model_policy,undefined);assert(!JSON.stringify(r).includes('SECRET'));assert.equal(f.calls.validate.length,0);
});
test('unsupported reasoning is rejected without silently changing high or leaking errors',async()=>{
 const f=fixture({llm:{resolveCallConfig:async()=>{throw Error('SECRET');}}});const r=await f.selector.resolve({host:'cloud',query:'ds flash'});assert.equal(r.status,'route_unavailable');assert.equal(r.model_policy,undefined);assert(!JSON.stringify(r).includes('SECRET'));
});
test('explicit effort wins and local default is not forced high',async()=>{
 let f=fixture();assert.equal((await f.selector.resolve({host:'cloud',query:'ds flash',reasoningEffort:'low'})).model_policy.reasoningEffort,'low');
 f=fixture({role:'local'});assert.equal((await f.selector.resolve({host:'local',query:'ds flash'})).model_policy.reasoningEffort,undefined);
});
test('validation cannot silently remap the selected route or effort',async()=>{
 for(const change of [{model:'different'},{provider:'elsewhere'},{reasoningEffort:'low'}])await assert.rejects(fixture({llm:{resolveCallConfig:async p=>({...p,...change})}}).selector.resolve({host:'cloud',query:'ds flash'}),/MODEL_ROUTE_CHANGED/);
});
test('catalog changing mid-validation invalidates resolution',async()=>{
 const f=fixture();f.g.ctx.llm.resolveCallConfig=async p=>{f.routes.push(route('second'));return p;};assert.equal((await f.selector.resolve({host:'cloud',query:'ds flash'})).status,'catalog_changed');
});
test('restart/config changes re-read; no stored default or approved policy mutations',async()=>{
 const f=fixture(),approved={provider:'saved',model:'fixed',reasoningEffort:'low'},before=JSON.stringify(approved);await f.selector.resolve({host:'cloud',query:'ds flash'});f.routes.push(route('second'));assert.equal((await f.selector.resolve({host:'cloud',query:'ds flash'})).status,'ambiguous');assert.equal(JSON.stringify(approved),before);
});
test('invalid request/alias and foreign host fail without provider I/O',async()=>{
 const f=fixture();for(const a of [{host:'local',query:'ds flash'},{host:'cloud',query:'ds flash',apiKey:'x'},{host:'cloud',query:'a\nb'},{host:'cloud',query:'ds flash',provider_hint:'那个'},{host:'cloud',query:'x'.repeat(201)}])await assert.rejects(f.selector.resolve(a),/MODEL_SELECTION_INVALID/);
 assert.throws(()=>fixture({aliases:[{alias:'鱼',provider:'x'}]}),/MODEL_ALIAS_CONFIG_INVALID/);assert.equal(f.calls.validate.length,0);
});
test('cross-provider catalog entries cannot introduce a route',async()=>{
 const f=fixture({llm:{listModels:async()=>[route('attacker')]}});assert.equal((await f.selector.resolve({host:'cloud',query:'ds flash'})).status,'catalog_incomplete');
});
test('empty catalog is not permission to invent a provider',async()=>{assert.equal((await fixture({routes:[]}).selector.resolve({host:'cloud',query:'ds flash'})).status,'not_found');});
test('candidate truncation never pretends unique',async()=>{const f=fixture({routes:Array.from({length:31},(_,i)=>route('provider-'+i))});const r=await f.selector.resolve({host:'cloud',query:'ds flash'});assert.equal(r.status,'ambiguous');assert.equal(r.candidate_count,31);assert.equal(r.candidates.length,30);assert.equal(r.truncated,true);});
test('new protocol advertises optional resolver without removing old capabilities',()=>{assert.equal(CAPABILITIES.model_selection,1);assert.equal(CAPABILITIES.approval,1);for(const key of ['catalog','scheduler','triggers','continuity','managed_execution','cloud_autonomy'])assert(CAPABILITIES[key]>=1);const h={schema:1,protocol:{min:1,max:1},plugin_version:'0.34.0-alpha.2',role:'local',namespace:'test',instance_id:'12345678-1234-1234-1234-123456789abc',capabilities:CAPABILITIES};const peer={...h,role:'cloud',capabilities:{...CAPABILITIES,future_optional:1}};assert.doesNotThrow(()=>requireCapability('model_resolve',h,peer));assert.throws(()=>requireCapability('model_resolve',h,{...peer,capabilities:{...peer.capabilities,model_selection:2}}),/CAPABILITY_VERSION_INCOMPATIBLE/);assert.throws(()=>requireCapability('model_resolve',h,{...peer,capabilities:{catalog:1}}),/CAPABILITY_UNAVAILABLE/);validateHello({schema:1,protocol:{min:1,max:1},plugin_version:'0.24.0-alpha.19',role:'cloud',namespace:'test',instance_id:'12345678-1234-1234-1234-123456789abc',capabilities:CAPABILITIES});});
async function gateways(t){
 const dir=mkdtempSync(tmpdir()+'/model-gateway-');writeFileSync(dir+'/tokens',JSON.stringify({localToken:'l'.repeat(32),cloudToken:'c'.repeat(32)}),{mode:0o600});
 const cloudF=fixture(),localF=fixture({role:'local',routes:[route('mac-only','mac-model','本地专用')]}),base={namespace:'model-test',entryMode:'native',peerEnabled:false,tokenFile:dir+'/tokens',port:0};
 const context=f=>({...f.g.ctx,on(){},effect(){},agents:{list:()=>[]},agentPresets:{}});
 const cloud=new Gateway(context(cloudF),{...base,role:'cloud',stateDir:dir+'/cloud'}),local=new Gateway(context(localF),{...base,role:'local',stateDir:dir+'/local',coordinatorUrl:'http://127.0.0.1:1'});
 t.after(async()=>{await local.close();await cloud.close();rmSync(dir,{recursive:true,force:true});});
 local.link.transport=async(method,args)=>method==='negotiate'?{hello:cloud.hello()}:{result:await cloud.call(method,args,'local'),observation:cloud.observation()};
 return {local,cloud,cloudF,localF};
}
test('Mac entry resolves cloud catalog, never Mac inventory; own local resolution stays local',async t=>{
 const {local,cloud,localF}=await gateways(t);const r=await local.call('model_resolve',{host:'cloud',query:'ds flash'});assert.equal(r.status,'resolved');assert.equal(r.host,'cloud');assert.equal(r.observation.authority,'cloud');assert.equal(localF.calls.list,0);
 assert.equal((await local.call('model_resolve',{host:'local',query:'本地专用'})).model_policy.provider,'mac-only');await assert.rejects(cloud.call('model_resolve',{host:'local',query:'ds flash'}),/MODEL_TARGET_ENTRY_REQUIRED/);assert.equal(cloud.store.db.prepare('SELECT count(*) n FROM tasks').get().n,0);
});
test('unreachable/old target refuses instead of local or cached fallback',async t=>{
 const {local}=await gateways(t);await local.call('model_resolve',{host:'cloud',query:'ds flash'});local.link.transport=async()=>{throw Error('COORDINATOR_UNAVAILABLE');};await assert.rejects(local.call('model_resolve',{host:'cloud',query:'ds flash'}),/COORDINATOR_UNAVAILABLE/);
});
test('native resolver is additive and uses no callback or exact provider schema',async()=>{
 const tools=new Map(),calls=[];registerNativeTools({tools:{register:d=>tools.set(d.name,d)},taskGateway:{c:{role:'local'},assertNativeAgent(){},call:(m,a)=>{calls.push({m,a});return {status:'ambiguous'};}}});const tool=tools.get('task_model_resolve');assert.deepEqual(tool.parameters.required,['host','query']);assert.equal(tool.parameters.properties.provider,undefined);await tool.execute({host:'cloud',query:'ds flash'},{agent:{},callId:'test'});assert.equal(calls[0].m,'model_resolve');assert(tools.has('task_approval_request'));
});
test('native context loads current autonomous rules without restoring universal approvals',async()=>{
 const {installNativeContext}=await import('../bundle/native-context.js');let context;
 const ctx={taskGateway:{c:{role:'local',managedExecution:{enabled:true}},assertNativeAgent(){}},inject:(_deps,fn)=>fn({systemPrompt:{context:x=>{context=x;}}})};
 installNativeContext(ctx);const text=context.text({agent:{}});
 assert.match(text,/不要要求 task_decide、approval_id 或 IM 批准/);assert.match(text,/省略 model_query/);assert.match(text,/model_query/);
 const tools=readFileSync(new URL('../bundle/native-tools.js',import.meta.url),'utf8');assert.match(tools,/ambiguous asks ONE ordinary text question/);assert.match(tools,/never ask_user_question\/cards/);
 ctx.taskGateway.c.managedExecution.enabled=false;
 assert(context.text({agent:{}}).includes(readFileSync(new URL('../bundle/native-rules/AGENTS.md',import.meta.url),'utf8')));
});

test('official channel hint must not match unofficial substring',async()=>{const f=fixture({routes:[route('unofficial-proxy')]});const r=await f.selector.resolve({host:'cloud',query:'ds flash',provider_hint:'官方那个'});assert.equal(r.status,'not_found');assert.equal(r.model_policy,undefined);});
test('public provider-list exceptions do not leak raw configuration errors',async()=>{const f=fixture({llm:{listProviders(){throw Error('SECRET_ENDPOINT_OR_CREDENTIAL');}}});await assert.rejects(f.selector.resolve({host:'cloud',query:'ds flash'}),e=>e.message==='MODEL_CATALOG_UNAVAILABLE');});
