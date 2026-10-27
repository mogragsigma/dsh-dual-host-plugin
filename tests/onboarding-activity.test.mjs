import test from 'node:test';
import assert from 'node:assert/strict';
import {createOnboardingActivity} from '../bundle/onboarding-activity.js';
import {createOnboardingService} from '../bundle/onboarding-host.js';
import {createGatewayMaintenance} from '../bundle/gateway-maintenance.js';
const confirm=p=>({id:p.id,fingerprint:p.fingerprint,confirm:true});
const hold=m=>m.apply(confirm(m.preview({})));
const release=(m,s)=>m.release({operationId:s.operationId,instanceId:s.instanceId,confirm:true});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {resolve,promise};};
test('fresh onboarding has a fixed-label independent gate, never a Host stop grant',()=>{
 const m=createOnboardingActivity();assert.equal(m.status().scope,'own_onboarding_only');assert(!m.status().persisted&&!m.status().hostStopAuthorized&&!m.status().pluginSwitchAuthorized);assert(m.preview().canApply);assert.throws(()=>m.enter('SECRET_USER_TEXT'),/LABEL_REVIEW/);assert(!JSON.stringify(m.status()).includes('SECRET'));assert.throws(()=>m.preview({unexpected:1}),/ARGUMENTS/);
});
test('sync, rejected and asynchronous requests release exact activity once',async()=>{
 const m=createOnboardingActivity();assert.equal(m.run('rpc',()=>4),4);assert.throws(()=>m.run('rpc',()=>{throw Error('x');}),/x/);await assert.rejects(m.run('rpc',()=>Promise.reject(Error('x'))));const done=m.enter('startup');done();done();assert(!m.status().busy);
 const d=deferred(),p=m.run('rpc',()=>d.promise);assert.equal(m.status().counts.rpc,1);d.resolve(5);assert.equal(await p,5);assert(!m.status().busy);
});
test('work arriving after preview rejects hold without cancelling or replacing it',async()=>{
 const m=createOnboardingActivity(),p=m.preview(),d=deferred(),work=m.run('model_attempt',()=>d.promise);assert.throws(()=>m.apply(confirm(p)),/BUSY/);assert.equal(m.status().state,'open');d.resolve('original');assert.equal(await work,'original');assert(m.preview().canApply);
});
test('live lease is idempotent, release binds instance, expired or released plans cannot reacquire',()=>{
 let now=1000;const m=createOnboardingActivity({now:()=>now}),p=m.preview(),s=m.apply(confirm(p));assert(m.apply(confirm(p)).notResent);assert.throws(()=>m.enter('rpc'),/HELD/);assert.throws(()=>m.release({operationId:s.operationId,instanceId:'old',confirm:true}),/INSTANCE_CHANGED/);assert.equal(release(m,s).state,'open');assert(release(m,s).notResent);assert.throws(()=>m.apply(confirm(p)),/RELEASED/);
 const next=m.preview();now+=300001;assert.throws(()=>m.apply(confirm(next)),/PLAN_EXPIRED/);assert.throws(()=>m.apply({...confirm(next),confirm:false}),/CONFIRMATION_REQUIRED/);
});
test('closing rejects new admission but never clears accepted operations to fabricate idle',async()=>{
 const m=createOnboardingActivity(),d=deferred(),work=m.run('startup',()=>d.promise);m.close();assert.equal(m.status().state,'closed');assert.equal(m.status().counts.startup,1);assert.throws(()=>m.enter('rpc'),/CLOSED/);d.resolve();await work;assert.equal(m.status().counts.startup,0);assert(!m.status().canHold);
});
test('public fresh service exposes hold and rejects new calls without changing ordinary detection when released',async()=>{
 const service=createOnboardingService({}, {},{home:'/isolated-empty-fixture',env:{PATH:''}});
 const d=await service.call('describe',{});assert.equal(d.capabilities.onboardingMaintenanceHoldContract,1);assert.equal(d.capabilities.gatewayMaintenanceHoldContract,0);
 const p=await service.call('onboarding_hold_preview',{}),s=await service.call('onboarding_hold_apply',confirm(p));assert.equal(s.state,'held');
 await assert.rejects(service.call('detect',{}),/ACTIVITY_HELD/);assert.equal((await service.call('describe',{})).pages,6);
 await service.call('onboarding_hold_release',{operationId:s.operationId,instanceId:s.instanceId,confirm:true});assert.equal((await service.call('detect',{})).checks.modelRequests,0);await service.dispose();
});
test('native HTTP RPC promise stays counted without a Gateway until original model status resolves',async()=>{
 const d=deferred(),m=createOnboardingActivity(),service=createOnboardingService({}, {},{activity:m,models:{probe:{status:()=>d.promise}}});const p=m.preview(),request=service.call('model_probe_status',{});assert.equal(m.status().counts.rpc,1);assert.throws(()=>m.apply(confirm(p)),/BUSY/);d.resolve({receipt:'original'});assert.deepEqual(await request,{receipt:'original'});assert(!m.status().busy);await service.dispose();
});
test('existing Gateway denial releases only its failed onboarding admission and retains both scopes',async()=>{
 const g={instanceId:'fixture',deliveries:new Map()},gateway={maintenance:createGatewayMaintenance(g)},m=createOnboardingActivity(),service=createOnboardingService({}, {},{activity:m,gateway});const held=hold(gateway.maintenance);
 await assert.rejects(service.call('detect',{}),/GATEWAY_HOLD_ACTIVE/);assert(!m.status().busy);assert.equal(gateway.maintenance.status().state,'held');release(gateway.maintenance,held);
 const own=await service.call('onboarding_hold_apply',confirm(await service.call('onboarding_hold_preview',{})));assert.equal(own.state,'held');assert.equal(gateway.maintenance.status().state,'open');await service.dispose();
});

test('dependency binding during hold is deferred until explicit release exactly once',async()=>{
 const m=createOnboardingActivity(),s=hold(m);let starts=0;const d=deferred();const cancel=m.deferStartup('models',()=>{starts++;return d.promise;});
 assert.equal(starts,0);assert.equal(m.status().startups.models,'waiting');assert(!m.status().busy);
 const after=release(m,s);assert.equal(starts,1);assert.equal(after.counts.startup,1);assert.equal(after.startups.models,'running');assert(release(m,s).notResent);assert.equal(starts,1);
 d.resolve();await new Promise(setImmediate);assert.equal(m.status().counts.startup,0);cancel();assert(!m.status().startups.models);
});
test('disposed deferred scope is never started; only replacement live binding resumes',async()=>{
 const m=createOnboardingActivity(),s=hold(m);let obsolete=0,current=0;
 const off=m.deferStartup('models',()=>obsolete++);off();m.deferStartup('models',()=>current++);release(m,s);await new Promise(setImmediate);assert.equal(obsolete,0);assert.equal(current,1);
});
test('scope disposal cannot erase active initialization; original completion is required',async()=>{
 const m=createOnboardingActivity(),d=deferred(),off=m.deferStartup('local_pair',()=>d.promise);assert.equal(m.status().counts.startup,1);off();assert.equal(m.status().counts.startup,1);assert(!m.preview().canApply);d.resolve();await new Promise(setImmediate);assert.equal(m.status().counts.startup,0);
});
test('failed startup stays reviewable and is not retried by observation or later release',async()=>{
 const m=createOnboardingActivity();let calls=0;m.deferStartup('token_models',()=>{calls++;throw Error('DO_NOT_EXPOSE_CREDENTIAL');});assert.equal(m.status().startups.token_models,'needs_review');assert(!JSON.stringify(m.status()).includes('CREDENTIAL'));const s=hold(m);release(m,s);assert.equal(calls,1);
});
test('closed activity drops deferred starts and fixed names reject untrusted labels',()=>{
 const m=createOnboardingActivity();hold(m);let calls=0;m.deferStartup('models',()=>calls++);assert.throws(()=>m.deferStartup('models',()=>{}),/DUPLICATE/);assert.throws(()=>m.deferStartup('UNTRUSTED_INPUT',()=>{}),/REVIEW/);m.close();assert.equal(calls,0);assert.deepEqual(m.status().startups,{});
});
test('replacement initialization waits for disposed original callback rather than overlapping it',async()=>{
 const m=createOnboardingActivity(),d=deferred();let replacement=0;const off=m.deferStartup('models',()=>d.promise);off();m.deferStartup('models',()=>replacement++);assert.equal(replacement,0);assert.equal(m.status().startups.models,'waiting');assert.equal(m.status().counts.startup,1);d.resolve();await new Promise(setImmediate);assert.equal(replacement,1);assert.equal(m.status().startups.models,'settled');
});


test('notification background sync remains counted, blocks hold, and respects admission',async()=>{
 const m=createOnboardingActivity(),d=deferred(),preview=m.preview();
 const work=m.run('notification_defaults_sync',()=>d.promise);assert.equal(m.status().counts.notification_defaults_sync,1);
 assert.throws(()=>m.apply(confirm(preview)),/BUSY/);d.resolve();await work;assert.equal(m.status().counts.notification_defaults_sync,0);
 const s=hold(m);assert.throws(()=>m.run('notification_defaults_sync',()=>assert.fail('held')),/HELD/);release(m,s);
});
