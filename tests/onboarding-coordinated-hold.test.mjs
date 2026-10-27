import test from 'node:test';
import assert from 'node:assert/strict';
import {createOnboardingCoordinatedHold} from '../bundle/onboarding-coordinated-hold.js';
import {createOnboardingActivity} from '../bundle/onboarding-activity.js';
import {createOnboardingAgentHold} from '../bundle/onboarding-agent-hold.js';
import {createGatewayMaintenance} from '../bundle/gateway-maintenance.js';
import {createOnboardingService} from '../bundle/onboarding-host.js';
const confirm=p=>({id:p.id,fingerprint:p.fingerprint,confirm:true});
const release=(m,s)=>m.release({operationId:s.operationId,instanceId:s.instanceId,confirm:true});
function fixture(withGateway=true){
 const listeners=new Map(),agents=[],ctx={agents:{list:()=>agents},on(name,fn){listeners.set(name,fn);return ()=>listeners.delete(name);}};
 const onboarding=createOnboardingActivity(),g={instanceId:'fixture',deliveries:new Map()},gateway=withGateway?createGatewayMaintenance(g):undefined,agentHold=createOnboardingAgentHold(ctx);
 const c={onboarding,gateway,agents:agentHold,gatewayExpected:withGateway,imPresent:true};let now=1000;
 const own=createOnboardingCoordinatedHold({components:()=>c,now:()=>now});return {own,c,g,agents,ctx,advance:n=>now+=n};
}
test('joint session acquires and releases three real component gates without granting stop authority',()=>{
 const f=fixture(),p=f.own.preview();assert(p.canApply);const s=f.own.apply(confirm(p));assert.equal(s.state,'held');assert.equal(s.thirdPartyIm,'unverified');assert(!s.persisted&&!s.hostStopAuthorized&&!s.pluginSwitchAuthorized);
 for(const row of Object.values(s.components))assert.equal(row.state,'held');assert(f.own.apply(confirm(p)).notResent);assert.throws(()=>f.c.onboarding.enter('rpc'),/HELD/);assert.throws(()=>f.c.gateway.enter('request'),/MAINTENANCE/);
 assert.equal(release(f.own,s).state,'open');assert(release(f.own,s).notResent);assert.throws(()=>f.own.apply(confirm(p)),/RELEASED/);
});
test('absent unconfigured Gateway is optional, missing required component never is',()=>{
 const f=fixture(false);assert(f.own.preview().canApply);const s=f.own.apply(confirm(f.own.preview()));assert.equal(s.components.gateway.state,'not_configured');release(f.own,s);
 f.c.gatewayExpected=true;assert(!f.own.preview().canApply);f.c.gatewayExpected=false;f.c.agents=undefined;assert(!f.own.preview().canApply);
});
test('activity arriving after preview rolls back only acquired own gates without cancelling work',()=>{
 const f=fixture(),p=f.own.preview(),done=f.c.gateway.enter('original');assert.throws(()=>f.own.apply(confirm(p)),/ACQUIRE_FAILED/);assert.equal(f.c.onboarding.status().state,'open');assert.equal(f.c.gateway.status().counts.requests,1);assert.equal(f.own.status().last.state,'acquire_failed_released');done();assert(f.own.preview().canApply);
});
test('new busy native agent after preview rejects without leaking already acquired gates',()=>{
 const f=fixture(),p=f.own.preview();f.agents.push({status:'running',runMaintenance(){throw Error('MUST_NOT_CANCEL');},inbox:{nextTurn:[],nextStep:[]}});
 assert.throws(()=>f.own.apply(confirm(p)),/ACQUIRE_FAILED/);assert.equal(f.c.gateway.status().state,'open');assert.equal(f.c.onboarding.status().state,'open');assert.equal(f.agents[0].status,'running');
});
test('replacing a dependency before apply rejects stale preview without touching replacement',()=>{
 const f=fixture(),p=f.own.preview(),replacement=createGatewayMaintenance({instanceId:'replacement',deliveries:new Map()});f.c.gateway=replacement;
 assert.throws(()=>f.own.apply(confirm(p)),/DEPENDENCY_CHANGED/);assert.equal(replacement.status().state,'open');assert.equal(f.c.onboarding.status().state,'open');
});
test('replacement during hold is review, release uses old captured member not replacement',()=>{
 const f=fixture(),old=f.c.gateway,s=f.own.apply(confirm(f.own.preview()));f.c.gateway=createGatewayMaintenance({instanceId:'replacement',deliveries:new Map()});const p=f.c.gateway.preview(),other=f.c.gateway.apply(confirm(p));
 assert.equal(f.own.status().state,'needs_review');release(f.own,s);assert.equal(old.status().state,'open');assert.equal(f.c.gateway.status().operationId,other.operationId);release(f.c.gateway,other);
});
test('verified closed original member can finish its session without releasing a replacement lease',()=>{
 const f=fixture(),old=f.c.gateway,s=f.own.apply(confirm(f.own.preview()));f.g.closed=true;old.completeClosure(()=>{},true);
 f.c.gateway=createGatewayMaintenance({instanceId:'replacement',deliveries:new Map()});const other=f.c.gateway.apply(confirm(f.c.gateway.preview()));
 assert.equal(f.own.status().state,'needs_review');assert.equal(f.own.status().originalComponents.gateway.state,'closed');
 old.release=()=>{throw Error('MUST_NOT_RELEASE_CLOSED_INSTANCE');};assert.equal(release(f.own,s).state,'open');
 assert.equal(f.c.gateway.status().operationId,other.operationId);release(f.c.gateway,other);
});
test('closed flag without closure proof retains both remaining gates and the original operation',()=>{
 const f=fixture(),old=f.c.gateway,s=f.own.apply(confirm(f.own.preview()));f.g.closed=true;f.c.gateway=undefined;
 assert.equal(f.own.status().originalComponents.gateway.state,'unavailable');assert.throws(()=>release(f.own,s),/RELEASE_REVIEW/);
 assert.equal(f.c.onboarding.status().state,'held');assert.equal(f.c.agents.status().state,'held');
 old.completeClosure(()=>{},true);assert.equal(release(f.own,s).state,'open');
});
test('foreign or incomplete closure observations cannot end the captured gateway lease',()=>{
 for(const patch of [{instanceId:'foreign'},{operationId:'foreign'},{scope:'whole_host'},{counts:{}},{counts:{requests:1}},{counts:{requests:-1}},{hostStopAuthorized:true}]){
  const f=fixture(),old=f.c.gateway,s=f.own.apply(confirm(f.own.preview()));f.g.closed=true;old.completeClosure(()=>{},true);const proof=old.closureStatus();old.closureStatus=()=>({...proof,...patch});
  assert.throws(()=>release(f.own,s),/RELEASE_REVIEW/);assert.equal(f.c.onboarding.status().state,'held');assert.equal(f.c.agents.status().state,'held');
 }
});
test('pending native inbox is retained and visible, not passed off as whole Host drained',()=>{
 const f=fixture();f.agents.push({status:'idle',inbox:{nextTurn:['DO_NOT_READ_BODY'],nextStep:[]},runMaintenance(fn){return fn(new AbortController().signal);}});
 const s=f.own.apply(confirm(f.own.preview()));assert.equal(s.components.agents.inboxState,'pending');assert.equal(s.components.agents.counts.pendingNextTurn,1);assert(!JSON.stringify(s).includes('DO_NOT_READ_BODY'));assert(!s.hostStopAuthorized);release(f.own,s);assert.equal(f.agents[0].inbox.nextTurn.length,1);
});
test('release failure retains remaining gates; explicit retry only releases original captured member',()=>{
 const f=fixture(),s=f.own.apply(confirm(f.own.preview())),original=f.c.gateway.release;let calls=0;
 f.c.gateway.release=()=>{calls++;throw Error('DO_NOT_EXPOSE')};assert.throws(()=>release(f.own,s),/RELEASE_REVIEW/);assert.equal(f.own.status().state,'needs_review');assert.equal(f.c.onboarding.status().state,'held');assert.equal(f.c.agents.status().state,'held');assert.equal(calls,1);
 f.c.gateway.release=original;assert.equal(release(f.own,s).state,'open');
});
test('releasing session starts deferred dependencies only after other component gates reopen',async()=>{
 const f=fixture(),s=f.own.apply(confirm(f.own.preview()));let starts=0;f.c.onboarding.deferStartup('models',()=>{assert.equal(f.c.gateway.status().state,'open');assert.equal(f.c.agents.status().state,'open');starts++;});assert.equal(starts,0);release(f.own,s);await new Promise(setImmediate);assert.equal(starts,1);
});
test('invalid confirmation, expiry and wrong process reference cannot release or acquire',()=>{
 const f=fixture(),p=f.own.preview();assert.throws(()=>f.own.apply({...confirm(p),confirm:false}),/CONFIRMATION/);f.advance(300001);assert.throws(()=>f.own.apply(confirm(p)),/EXPIRED/);const s=f.own.apply(confirm(f.own.preview()));assert.throws(()=>f.own.release({operationId:s.operationId,instanceId:'wrong',confirm:true}),/INSTANCE_CHANGED/);assert.equal(f.own.status().state,'held');release(f.own,s);
});
test('public RPC jointly holds real gates and prevents individual release escaping session ownership',async()=>{
 const f=fixture(),svc=createOnboardingService({}, {},{activity:f.c.onboarding,gateway:{maintenance:f.c.gateway},agentHold:f.c.agents,home:'/isolated-empty-fixture',env:{PATH:''}});
 assert.equal((await svc.call('describe',{})).capabilities.coordinatedMaintenanceHoldContract,1);
 const p=await svc.call('coordinated_hold_preview',{}),s=await svc.call('coordinated_hold_apply',confirm(p));assert.equal(s.state,'held');await assert.rejects(svc.call('detect',{}),/HELD/);
 for(const key of ['agent','gateway','onboarding'])await assert.rejects(svc.call(key+'_hold_release',{}),/SESSION_ACTIVE/);
 assert.equal((await svc.call('agent_hold_status',{})).state,'held');await svc.call('coordinated_hold_release',{operationId:s.operationId,instanceId:s.instanceId,confirm:true});assert.equal((await svc.call('detect',{})).checks.writes,0);await svc.dispose();
});
test('disposing own service releases captured native/Gateway leases without launching deferred initialization',async()=>{
 const f=fixture(),svc=createOnboardingService({}, {},{activity:f.c.onboarding,gateway:{maintenance:f.c.gateway},agentHold:f.c.agents});
 await svc.call('coordinated_hold_apply',confirm(await svc.call('coordinated_hold_preview',{})));let starts=0;f.c.onboarding.deferStartup('models',()=>starts++);await svc.dispose();assert.equal(starts,0);assert.equal(f.c.gateway.status().state,'open');assert.equal(f.c.agents.status().state,'open');assert.equal(f.c.onboarding.status().state,'closed');
});
test('actual installed RPC wiring defers credential/LLM rebind and drops disposed scopes',async t=>{
 const {installOnboarding}=await import('../bundle/onboarding-host.js');const bindings=new Map(),globalDisposers=[];let route;
 const sub={inject(deps,fn){bindings.set(deps.join(','),fn);},effect(setup){globalDisposers.push(setup());},connection:{fetch:{register(r){route=r;}}}};
 installOnboarding({inject:(_,fn)=>fn(sub)},{});
 function scope(extra){const off=[];return {...extra,effect(setup){off.push(setup());},async dispose(){for(const f of off.reverse())await f?.();}};}
 const agents=scope({agents:{list:()=>[]},on:()=>()=>{}});bindings.get('agents')(agents);t.after(async()=>{await agents.dispose();for(const f of globalDisposers.reverse())await f?.();});
 async function rpc(method,args={}){const req=new Request('http://localhost/api/task-onboarding/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:'fixture',method:'task-onboarding/control',payload:{method,args}})});const res=await (await route.fetch(req)).json();assert(res.result.ok,res.result.error?.code);return res.result.value;}
 const bootScope=scope({credentials:{readRecord:async()=>null,describeRecord:async()=>({writable:true}),modifyRecord:async()=>{throw Error('BOOT_MUST_NOT_WRITE');}}});bindings.get('credentials')(bootScope);await new Promise(setImmediate);
 const p=await rpc('coordinated_hold_preview'),s=await rpc('coordinated_hold_apply',confirm(p));let oldReads=0,currentReads=0,writes=0;
 const creds=fn=>({readRecord:async key=>{if(key!=='dsh-task-gateway/onboarding-maintenance-record-v1')fn();return null;},describeRecord:async()=>({writable:true}),modifyRecord:async()=>{writes++;throw Error('NO_WRITE_ALLOWED');}});
 const llm={registerAdapter(){throw Error('UNAPPROVED_BINDING');},listProviders:()=>[],listModels:()=>[],resolveCallConfig:()=>({})};
 const old=scope({credentials:creds(()=>oldReads++),llm});bindings.get('llm,credentials')(old);await old.dispose();const current=scope({credentials:creds(()=>currentReads++),llm});bindings.get('llm,credentials')(current);const credentialsScope=scope({credentials:current.credentials});bindings.get('credentials')(credentialsScope);bindings.get('credentials,agents,agentPresets,tools,sessions,llm')(credentialsScope);
 let cloudStarts=0;const cloud=scope({onboardingTaskRuntime:{configured:false,start:async()=>{cloudStarts++;}}});bindings.get('onboardingTaskRuntime')(cloud);
 assert.equal(oldReads,0);assert.equal(currentReads,0);assert.equal(cloudStarts,0);const waiting=await rpc('onboarding_hold_status');assert.equal(waiting.startups.models,'waiting');assert.equal(waiting.startups.token_models,'waiting');assert.equal(waiting.startups.local_pair,'waiting');assert.equal(waiting.startups.cloud_runtime,'waiting');
 await rpc('coordinated_hold_release',{instanceId:s.instanceId,operationId:s.operationId,confirm:true});await new Promise(setImmediate);assert.equal(oldReads,0);assert(currentReads>=2);assert.equal(writes,0);assert.equal(cloudStarts,1);const ended=await rpc('onboarding_hold_status');assert.equal(ended.counts.startup,0);assert.equal(ended.startups.models,'settled');await cloud.dispose();await current.dispose();await credentialsScope.dispose();
});
test('new required Gateway missing during joint hold is review, not an unchanged successful observation',()=>{
 const f=fixture(false),s=f.own.apply(confirm(f.own.preview()));f.c.gatewayExpected=true;assert.equal(f.own.status().state,'needs_review');assert.equal(f.own.status().components.gateway.state,'unavailable');release(f.own,s);
});
test('component throwing after actual acquisition still rolls back exact acquired member',()=>{
 const f=fixture(),apply=f.c.gateway.apply;f.c.gateway.apply=a=>{apply(a);throw Error('LOST_RETURN');};assert.throws(()=>f.own.apply(confirm(f.own.preview())),/ACQUIRE_FAILED/);assert.equal(f.c.gateway.status().state,'open');assert.equal(f.c.onboarding.status().state,'open');assert.equal(f.own.status().last.state,'acquire_failed_released');
});
