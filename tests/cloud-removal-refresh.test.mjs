import test from 'node:test';
import assert from 'node:assert/strict';
import {createCloudFlow,cloudActions,cloudStateLabels} from '../ui-source/onboarding/cloud-flow.js';

function fixture(state='plugin_uninstalled',changes={}){
 const calls=[],caps={preparation:true,runtime:true};
 const runtime={state,managedRestartBlocked:true,hostActive:false,childActive:false,workerActive:false,restartLauncherActive:false,...changes};
 const receipt={state:'repair_committed',repair:{id:'old-repair',state:'committed',recoveryRequired:false},activation:{cached:true,liveStateVerified:false,observedAt:123}};
 const pluginRepair={supported:true,activationSupported:true,pending:false,id:'old-repair',receipt};
 const request=async(method,args)=>{
  calls.push(args.action??method);
  if(method==='cloud_operation_status')return {state:'prepared',operationId:'op'};
  if(args.action==='runtime_status')return runtime;
  if(args.action==='runtime_record')return {recorded:true,receipt:runtime,pluginRepair};
  // Reproduces the actual alpha49 native GUI failure after successful uninstall.
  if(args.action==='runtime_repair_status')throw Error('ONBOARDING_CLOUD_RUNTIME_UNINSTALL_ALREADY_UNINSTALLED');
  throw Error('Unexpected mutation or query: '+args.action);
 };
 const flow=createCloudFlow(request,()=>{},caps,()=>1000);
 return {flow,calls,pluginRepair,runtime,receipt,actions:()=>cloudActions(flow.get(),caps,1000)};
}

for(const state of ['plugin_uninstalled','runtime_reclaimed','reclamation_needs_review','uninstall_needs_review'])test(`${state}: refresh keeps retirement authoritative and old repair historical`,async()=>{
 const f=fixture(state);await f.flow.act('load');assert(!f.flow.get().fresh);
 assert(await f.flow.act('refresh'));const s=f.flow.get();assert(s.fresh&&!s.uncertain&&!s.repairFresh);assert.equal(s.runtime.state,state);assert.deepEqual(s.repairStatus,f.receipt);
 assert.deepEqual(f.calls,['cloud_operation_status','runtime_record','cloud_operation_status','runtime_status','runtime_record']);
 for(const name of ['runtime_repair_preview','runtime_repair_apply','runtime_repair_recover','runtime_repair_verify','runtime_restart_preview','runtime_restart','runtime_start','rollback'])assert(!f.actions()[name],name);
 assert(cloudStateLabels[state]);assert.equal(s.repairStatus.activation.observedAt,123);
});

for(const changes of [{managedRestartBlocked:false},{hostActive:true},{workerActive:true},{childActive:undefined},{restartLauncherActive:true},{cleanupActive:true}])test(`inconsistent removed runtime cannot become fresh: ${JSON.stringify(changes)}`,async()=>{
 const f=fixture('plugin_uninstalled',changes);await f.flow.act('load');assert.equal(await f.flow.act('refresh'),false);assert(!f.flow.get().fresh);assert(f.flow.get().uncertain);
});

test('a normal runtime repair-status error is not silently suppressed',async()=>{
 const f=fixture('host_stopped',{managedRestartBlocked:false});await f.flow.act('load');assert.equal(await f.flow.act('refresh'),false);
 assert(f.calls.includes('runtime_repair_status'));assert.equal(f.flow.get().error,'ONBOARDING_CLOUD_RUNTIME_UNINSTALL_ALREADY_UNINSTALLED');assert(!f.flow.get().fresh);
});

test('terminal runtime does not erase an unresolved local repair request',async()=>{
 const f=fixture();f.pluginRepair.pending=true;await f.flow.act('load');assert(await f.flow.act('refresh'));assert(f.flow.get().repairPending);assert(!f.actions().runtime_repair_recover);
});

// A live reclaim worker is not the native/installer worker. Parent observation
// stays read-only; the independent reclaim flow still gates recovery.
test('active and interrupted reclamation keep repair closed without losing history',async()=>{
 for(const workerActive of [true,false]){
  const f=fixture('reclamation_needs_review',{reclamation:{state:'deleting',workerActive,recoveryRequired:!workerActive}});
  await f.flow.act('load');assert(await f.flow.act('refresh'));
  assert(!f.calls.includes('runtime_repair_status'));assert(!f.actions().runtime_repair_preview);
  assert.equal(f.flow.get().runtime.reclamation.workerActive,workerActive);
 }
});

for(const state of ['reclamation_needs_review','uninstall_needs_review'])test(`${state}: stopped-process proof remains mandatory`,async()=>{
 for(const changes of [{managedRestartBlocked:false},{hostActive:true},{workerActive:true},{childActive:undefined},{restartLauncherActive:true},{cleanupActive:true}]){
  const f=fixture(state,changes);await f.flow.act('load');assert.equal(await f.flow.act('refresh'),false);assert(!f.flow.get().fresh);
 }
});
