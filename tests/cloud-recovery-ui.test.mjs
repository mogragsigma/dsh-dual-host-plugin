import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createCloudFlow,cloudActions,cloudRecovery} from '../ui-source/onboarding/cloud-flow.js';
const oldId='11111111-1111-4111-8111-111111111111',newId='22222222-2222-4222-8222-222222222222';
function fixture({state='needs_review',remote={state:'absent'},configured=true}={}){
 let source={state,operationId:'op1',revision:4,root:'/own/host-'+oldId,remote},binding={configured,revision:2,installationId:oldId},clock=1000,fail=null,lose=null;
 const calls=[],caps={preparation:true,runtime:true};
 const request=async(method,args)=>{
  calls.push({method,args});if(fail===method)throw Error('ONBOARDING_SSH_TIMEOUT');
  let result;
  if(method==='cloud_operation_status')result=source;
  else if(method==='cloud_runtime')result=args.action==='runtime_record'?{recorded:false}:{state:'not_started'};
  else if(method==='ssh_status')result=binding;
  else if(method==='cloud_retire'){source={...source,state:'retired',revision:5,remote:{state:'retired',operationId:'op1',root:source.root,barrier:'regular-file-no-replace',originalRequestIsolated:true,originalProcessTerminated:false}};result=source;}
  else if(method==='cloud_new_target'){assert.equal(args.expectedBindingRevision,binding.revision);binding={...binding,revision:3,installationId:newId};result=binding;}
  else if(method==='cloud_stage'){source={state:'prepared',operationId:'op2',revision:1,root:'/own/host-'+newId};result=source;}
  else if(method==='cloud_preview')result={id:'plan2',fingerprint:'hash2',canStage:true,expiresAt:clock+300000};
  else throw Error('unexpected '+method);
  if(lose===method)throw Error('ONBOARDING_SSH_TIMEOUT');return structuredClone(result);
 };
 const flow=createCloudFlow(request,()=>{},caps,()=>clock);
 return {flow,calls,get:flow.get,actions:()=>cloudActions(flow.get(),caps,clock),setSource:v=>source={...source,...v},setBinding:v=>binding={...binding,...v},tick:n=>clock+=n,fail:v=>fail=v,lose:v=>lose=v};
}
test('absent unknown requires a fresh remote observation and explicit fence confirmation',async()=>{
 const f=fixture();await f.flow.act('load');assert(!f.actions().retire);assert(!f.actions().preview);assert(!f.actions().new_target);
 await f.flow.act('refresh');assert(f.actions().retire);assert.equal(await f.flow.act('retire'),false);assert(!f.calls.some(x=>x.method==='cloud_retire'));
 assert(await f.flow.act('retire',true));assert.deepEqual(f.calls.at(-1),{method:'cloud_retire',args:{operationId:'op1',expectedRevision:4,confirm:true}});assert(!f.actions().new_target);assert(!f.actions().preview);
});
test('fencing, target allocation and installation preview are three separate user actions',async()=>{
 const f=fixture();await f.flow.act('load');await f.flow.act('refresh');await f.flow.act('retire',true);await f.flow.act('refresh');assert(f.actions().new_target);assert(!f.actions().preview);
 assert.equal(await f.flow.act('new_target'),false);assert(await f.flow.act('new_target',true));assert.equal(f.get().source.state,'retired');assert.equal(f.get().source.root,'/own/host-'+oldId);assert(!f.actions().preview);
 await f.flow.act('refresh');assert(!f.actions().new_target);assert(f.actions().preview);assert(cloudRecovery(f.get()).replacement);assert.equal(f.calls.filter(x=>x.method==='cloud_preview').length,0);
 await f.flow.act('preview');assert(f.actions().stage);assert(!f.calls.some(x=>['cloud_stage','cloud_runtime'].includes(x.method)));
});
test('lost target allocation acknowledgement recovers via binding read without allocating twice',async()=>{
 const f=fixture();await f.flow.act('load');await f.flow.act('refresh');await f.flow.act('retire',true);await f.flow.act('refresh');f.lose('cloud_new_target');assert.equal(await f.flow.act('new_target',true),false);assert(f.get().uncertain);assert(!f.actions().new_target);assert(!f.actions().preview);
 f.lose(null);await f.flow.act('refresh');assert(f.actions().preview);assert(!f.actions().new_target);assert.equal(f.calls.filter(x=>x.method==='cloud_new_target').length,1);
});
test('lost fence acknowledgement requires read-only refresh, never automatic second fence',async()=>{
 const f=fixture();await f.flow.act('load');await f.flow.act('refresh');f.lose('cloud_retire');assert.equal(await f.flow.act('retire',true),false);assert(!f.actions().retire);assert(!f.actions().new_target);
 f.lose(null);await f.flow.act('refresh');assert(f.actions().new_target);assert.equal(f.calls.filter(x=>x.method==='cloud_retire').length,1);
});
test('unproven, present, stale or disabled recovery cannot send mutations',async()=>{
 for(const patch of [{state:'prepared'}, {remote:null}, {remote:{state:'prepared'}}]){
  const f=fixture({...patch});await f.flow.act('load');await f.flow.act('refresh');assert(!f.actions().retire);assert(!f.actions().new_target);
 }
 const f=fixture();await f.flow.act('load');await f.flow.act('refresh');f.tick(60001);assert.equal(await f.flow.act('retire',true),false);assert(!f.calls.some(x=>x.method==='cloud_retire'));
 assert(!cloudActions({...f.get(),fresh:true,observedAt:61001},{preparation:false},61001).retire);
});
test('retiring but freshly absent permits explicit fence continuation; load alone never permits it',async()=>{
 const f=fixture({state:'retiring'});await f.flow.act('load');assert(!f.actions().retire);await f.flow.act('refresh');assert(f.actions().retire);assert(await f.flow.act('retire',true));
});
test('retired state text without verified barrier fields cannot unlock replacement',async()=>{
 const f=fixture();await f.flow.act('load');await f.flow.act('refresh');await f.flow.act('retire',true);await f.flow.act('refresh');const s=f.get();assert(cloudRecovery(s).originalBinding);
 for(const patch of [{originalRequestIsolated:false},{originalProcessTerminated:true},{barrier:'directory'},{operationId:'other'},{root:'/other'}])assert(!cloudRecovery({...s,source:{...s.source,remote:{...s.source.remote,...patch}}}).fenced);
 f.fail('ssh_status');await f.flow.act('refresh');assert(!f.actions().new_target);assert(!f.actions().preview);assert.equal(f.get().binding,null);
});
test('recovery remains history after page reopen; local load never mutates or observes remotely',async()=>{
 const f=fixture();await f.flow.act('load');await f.flow.act('refresh');await f.flow.act('retire',true);await f.flow.act('refresh');await f.flow.act('new_target',true);await f.flow.act('refresh');const n=f.calls.length;
 await f.flow.act('load');assert.deepEqual(f.calls.slice(n).map(x=>x.method),['cloud_operation_status','ssh_status']);assert.equal(f.calls[n].args.refresh,false);assert(!f.actions().new_target);assert(!f.actions().preview);
});
test('UI exposes scoped recovery confirmations using the existing styled action components',async()=>{
 const source=await fs.readFile(new URL('../ui-source/onboarding/cloud-installation.jsx',import.meta.url),'utf8');
 for(const label of ['安装请求恢复','隔离旧安装请求','分配新的独立目标','旧事务和屏障不会被复用或删除'])assert(source.includes(label));
 assert(source.includes("confirm('retire'"));assert(source.includes("confirm('new_target'"));assert(!source.includes('<button'));assert(!source.includes('setInterval'));
});

async function previewReplacement(f){await f.flow.act('load');await f.flow.act('refresh');await f.flow.act('retire',true);await f.flow.act('refresh');await f.flow.act('new_target',true);await f.flow.act('refresh');await f.flow.act('preview');}
test('replacement approval uses the advertised five-minute plan window, not the earlier observation clock',async()=>{
 const f=fixture();await previewReplacement(f);f.tick(61000);assert(!f.actions().preview);assert(f.actions().stage);assert.equal(await f.flow.act('stage'),false);assert(await f.flow.act('stage',true));assert.equal(f.get().source.operationId,'op2');assert.equal(f.calls.filter(x=>x.method==='cloud_stage').length,1);
});
test('expired replacement plan and failed manual refresh cannot dispatch preparation',async()=>{
 for(const mode of ['expired','refresh_failed','reload']){const f=fixture();await previewReplacement(f);if(mode==='expired')f.tick(300001);else if(mode==='refresh_failed'){f.fail('cloud_operation_status');await f.flow.act('refresh');}else await f.flow.act('load');assert.equal(await f.flow.act('stage',true),false);assert(!f.calls.some(x=>x.method==='cloud_stage'));}
});
