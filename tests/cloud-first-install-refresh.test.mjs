import test from 'node:test';
import assert from 'node:assert/strict';
import {createCloudFlow,cloudActions} from '../ui-source/onboarding/cloud-flow.js';

function fixture({recorded=false,state='not_started',inventoryCount,repair={},runtimeFlags={}}={}){
 const calls=[],caps={preparation:true,runtime:true,optionalIm:true};
 const runtime={state,...(inventoryCount===undefined?{}:{inventoryCount}),...runtimeFlags};
 const request=async(method,args)=>{
  const action=args.action??method;calls.push(action);
  if(method==='cloud_operation_status')return {state:'prepared',operationId:'fresh'};
  if(action==='runtime_record')return {recorded,receipt:recorded?runtime:null,pluginRepair:{supported:true,pending:false,id:null,receipt:null,...repair}};
  if(action==='runtime_status')return runtime;
  if(action==='runtime_repair_status')throw Error('ONBOARDING_CLOUD_RUNTIME_REPAIR_NOT_READY');
  if(action==='runtime_preview')return {fingerprint:'plan',optionalIm:args.im?{package:'@xmanrui/dsh-im',version:'5.0.3'}:null};
  throw Error('Unexpected '+action);
 };
 const flow=createCloudFlow(request,()=>{},caps,()=>1000);
 return {flow,calls,actions:()=>cloudActions(flow.get(),caps,1000)};
}

test('fresh staged source refresh never queries nonexistent repair runtime; start remains separately confirmed',async()=>{
 const f=fixture();assert(await f.flow.act('load'));assert(!f.actions().runtime_preview);
 assert(await f.flow.act('refresh'));assert(f.flow.get().fresh&&!f.flow.get().uncertain);
 assert(!f.calls.includes('runtime_repair_status'));assert(f.actions().runtime_preview);
 assert(!f.actions().runtime_repair_preview&&!f.actions().runtime_repair_apply);
 assert(f.flow.selectIm(true));assert(await f.flow.act('runtime_preview'));assert(f.actions().runtime_start);
 assert.equal(await f.flow.act('runtime_start'),false);assert(!f.calls.includes('runtime_start'));
});

test('recorded but absent runtime stays read-only; no new start or cleanup',async()=>{
 const f=fixture({recorded:true});await f.flow.act('load');assert(await f.flow.act('refresh'));
 assert(!f.calls.includes('runtime_repair_status'));
 for(const name of ['runtime_start','runtime_preview','runtime_repair_preview','rollback'])assert(!f.actions()[name],name);
});

test('pending repair is never hidden by a not-started observation',async()=>{
 const f=fixture({recorded:true,repair:{pending:true,id:'prior'}});await f.flow.act('load');
 assert.equal(await f.flow.act('refresh'),false);assert(f.calls.includes('runtime_repair_status'));
 assert(f.flow.get().repairPending&&f.flow.get().uncertain);assert(!f.actions().runtime_preview);
});

test('normal existing runtime repair errors are not swallowed',async()=>{
 const f=fixture({recorded:true,state:'host_stopped',inventoryCount:10});await f.flow.act('load');
 assert.equal(await f.flow.act('refresh'),false);assert(f.calls.includes('runtime_repair_status'));
 assert.equal(f.flow.get().error,'ONBOARDING_CLOUD_RUNTIME_REPAIR_NOT_READY');
});

for(const state of ['launching','installing','configuring','starting_host','runtime_ready','host_ready'])test(`${state}: active first installer has no finalized repair inventory yet`,async()=>{
 const f=fixture({recorded:true,state,inventoryCount:0,runtimeFlags:{workerActive:true}});
 await f.flow.act('load');assert(await f.flow.act('refresh'));assert(!f.calls.includes('runtime_repair_status'));
 assert(f.flow.get().fresh);assert(!f.actions().runtime_repair_preview&&!f.actions().runtime_start);
});

test('an ended installer with missing inventory still fails closed',async()=>{
 const f=fixture({recorded:true,state:'failed',inventoryCount:0,runtimeFlags:{workerActive:false,childActive:false}});
 await f.flow.act('load');assert.equal(await f.flow.act('refresh'),false);assert(f.calls.includes('runtime_repair_status'));
});

test('existing repair intent during initialization still requires reconciliation',async()=>{
 const f=fixture({recorded:true,state:'installing',inventoryCount:0,runtimeFlags:{workerActive:true},repair:{pending:true,id:'prior'}});
 await f.flow.act('load');assert.equal(await f.flow.act('refresh'),false);assert(f.flow.get().repairPending);
});
