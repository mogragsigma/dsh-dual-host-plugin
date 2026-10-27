import test from 'node:test';
import assert from 'node:assert/strict';
import {createOnboardingService} from '../bundle/onboarding-host.js';
import {createOnboardingActivity} from '../bundle/onboarding-activity.js';
import {createGatewayMaintenance} from '../bundle/gateway-maintenance.js';
function fixture(){
 const g={closed:false,instanceId:'test'},gate=createGatewayMaintenance(g),activity=createOnboardingActivity();
 const quiescent=async()=>{assert.equal(activity.status().counts.rpc,1);if(!gate.status().canHold)throw Error('BUSY');return 'idle';};
 const taskRuntime={preview:quiescent,apply:quiescent,fence:quiescent,pairing:{preview:quiescent,apply:quiescent,fence:quiescent,forward:async()=>gate.status().counts.requests}};
 const svc=createOnboardingService({}, {},{gateway:{maintenance:gate},activity,taskRuntime,home:'/not-used',env:{PATH:''}});return {svc,g,gate,activity};
}
for(const method of ['task_runtime_preview','task_runtime_apply','task_runtime_fence','task_pair_preview','task_pair_apply','task_pair_fence'])test(method+' does not count itself as Gateway work, but preserves admission barriers',async t=>{
 const f=fixture();t.after(()=>f.svc.dispose());assert.equal(await f.svc.call(method,{}),'idle');
 const leave=f.gate.enter('real-peer');await assert.rejects(f.svc.call(method,{}),/BUSY/);leave();
 const p=f.gate.preview();f.gate.apply({id:p.id,fingerprint:p.fingerprint,confirm:true});await assert.rejects(f.svc.call(method,{}),/GATEWAY_HOLD_ACTIVE/);
 assert.equal(f.activity.status().counts.rpc,0);
});
test('peer data frames remain counted in both admission barriers',async t=>{const f=fixture();t.after(()=>f.svc.dispose());assert.equal(await f.svc.call('task_pair_forward',{}),1);assert.equal(f.gate.status().counts.requests,0);});
test('onboarding hold still rejects runtime lifecycle changes',async t=>{const f=fixture();t.after(()=>f.svc.dispose());const p=f.activity.preview();f.activity.apply({id:p.id,fingerprint:p.fingerprint,confirm:true});await assert.rejects(f.svc.call('task_runtime_apply',{}),/ACTIVITY_HELD/);});
