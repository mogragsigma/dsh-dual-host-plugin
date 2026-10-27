import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createOnboardingIm} from '../bundle/onboarding-im.js';
import {createOnboardingService} from '../bundle/onboarding-host.js';
import {createImClientBridge} from '../ui-source/onboarding/im-client-bridge.js';
function fixture(rows=[]){let reads=0;const service={contractVersion:1,listBots:async()=>{reads++;return rows;},send(){assert.fail('must not send');},consumeInbound(){assert.fail('must not acquire consumer');},describeBot(){assert.fail('inventory must not verify platform identity');}};let current=service;const runtime={get im(){return current;},platform:'linux',now:()=>1000};return {runtime,service,im:createOnboardingIm({onboarding:{role:'cloud'}},runtime),reads:()=>reads,replace:x=>{current=x;}};}
test('IM capability is optional and introspection does not list bots or write',async()=>{
 const f=fixture();assert.equal(f.im.capability(),'available');assert.equal(f.reads(),0);
 const s=createOnboardingService({}, {},f.runtime);assert.equal((await s.call('describe',{})).capabilities.imInventory,true);assert.equal(f.reads(),0);
 for(const [service,state] of [[undefined,'missing_dependency'],[{contractVersion:2,listBots(){assert.fail();}},'unsupported_contract'],[{contractVersion:1},'unsupported_contract']]){
  f.replace(service);assert.equal((await f.im.inventory({})).state,state);
 }
});
test('manual inventory exposes only channel counts, never IDs, secrets, routes or online claims',async()=>{
 const f=fixture([{botId:'bot_1',channel:'feishu',secret:'DO_NOT_EXPOSE',route:{openId:'PRIVATE'}},{botId:'bot_2',channel:'feishu'},{botId:'bot_3',channel:'dingtalk'}]);
 const v=await f.im.inventory({});assert.equal(f.reads(),1);assert.equal(v.state,'listed');assert.equal(v.botsConfigured,3);assert.equal(v.target.role,'cloud');assert.equal(v.target.platform,'linux');
 assert.deepEqual(v.channels,[{channel:'dingtalk',count:1},{channel:'feishu',count:2}]);assert(v.notAuthorization);assert(!v.consumerAcquired&&!v.platformIdentityVerified);assert.equal(v.messagesSent,0);
 for(const x of ['bot_1','DO_NOT_EXPOSE','PRIVATE'])assert(!JSON.stringify(v).includes(x));
});
test('an empty native inventory is not a connected or initialized result',async()=>{
 const f=fixture(),v=await f.im.inventory({});assert.equal(v.state,'no_bots');assert.equal(v.botsConfigured,0);assert(!v.platformIdentityVerified);
});
for(const rows of [null,{},Array.from({length:513},(_,i)=>({botId:'bot_'+i,channel:'feishu'})),[{botId:'bad/id',channel:'feishu'}],[{botId:'a',channel:'BAD'}],[{botId:'a',channel:'feishu'},{botId:'a',channel:'dingtalk'}]])test('invalid provider inventory is not promoted into success '+JSON.stringify(rows)?.slice(0,45),async()=>{
 assert.equal((await fixture(rows).im.inventory({})).state,'needs_review');
});
test('raw provider errors and timeouts are bounded and never exposed',async()=>{
 for(const listBots of [async()=>{throw Error('SECRET_TRACE');},()=>new Promise(()=>{})]){
  const im=createOnboardingIm({}, {im:{contractVersion:1,listBots},timeoutMs:5}),v=await im.inventory({});assert.equal(v.state,'needs_review');assert(!JSON.stringify(v).includes('SECRET_TRACE'));
 }
});
test('provider loss during observation invalidates returned data',async()=>{
 const f=fixture();let done;f.service.listBots=()=>new Promise(r=>{done=r;});const result=f.im.inventory({});await Promise.resolve();f.replace(undefined);done([{botId:'old',channel:'feishu'}]);const v=await result;assert.equal(v.state,'provider_changed');assert(!v.channels);
});
test('inventory rejects user-chosen URLs, provider IDs and mutation parameters',async()=>{
 const f=fixture(),s=createOnboardingService({}, {},f.runtime);
 for(const args of [null,[],{url:'https://elsewhere'},{botId:'old'},{confirm:true}])await assert.rejects(s.call('im_inventory',args),/INVALID_ARGUMENTS/);
 for(const method of ['im_send','im_bind','im_consume','im_secret'])await assert.rejects(s.call(method,{}),/METHOD_DENIED/);
 assert.equal(f.reads(),0);
});
test('public client integration preserves native menu and renders fresh elements',()=>{
 const b=createImClientBridge();let changes=0,renders=0;const unsubscribe=b.subscribe(()=>changes++);
 assert.equal(b.getSnapshot().available,false);b.attach({version:2,render(){assert.fail();}});assert.equal(changes,0);
 const provider={version:1,render(options){assert.deepEqual(options,{preferredSectionId:'feishu'});return {id:++renders};},setSettingsVisible(){assert.fail('native settings must stay unchanged');}};
 const detach=b.attach(provider);assert.equal(changes,1);assert.equal(b.getSnapshot().available,true);assert.notDeepEqual(b.render(),b.render());assert.equal(renders,2);
 detach();assert.equal(changes,2);assert.equal(b.render(),null);unsubscribe();detach();assert.equal(changes,2);
});
test('late disposal of previous client provider cannot detach its replacement',()=>{
 const b=createImClientBridge(),off=b.attach({version:1,render:()=>1});b.attach({version:1,render:()=>2});off();assert.equal(b.render(),2);
});
test('built wizard isolates native management from own styling and retains draft view',async()=>{
 const ui=await readFile(new URL('../ui-source/workbench-client.js',import.meta.url),'utf8');
 assert(ui.includes("ctx.inject(['dshImClient']"));assert(ui.includes("display:imOpen||cloudEntry?'none':undefined"));assert(!ui.includes('setSettingsVisible('));
 const jsx=await readFile(new URL('../ui-source/onboarding/im.jsx',import.meta.url),'utf8');assert(jsx.includes('data-native-im-manager'));assert(jsx.includes('NativeImBoundary'));assert(!jsx.includes('setInterval'));assert(!jsx.includes('consumeInbound'));
});
