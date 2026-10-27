// Real product service -> actual UI flow contract. Do not replace plans with mock literals.
import test from 'node:test';import assert from 'node:assert/strict';
import {createOnboardingService} from '../bundle/onboarding-host.js';
import {createOnboardingActivity} from '../bundle/onboarding-activity.js';
import {createOnboardingAgentHold} from '../bundle/onboarding-agent-hold.js';
import {createSelfDisableFlow} from '../ui-source/onboarding/self-disable-flow.js';
import {createSelfRemoveFlow} from '../ui-source/onboarding/self-remove-flow.js';
for(const operation of ['disable','remove'])test('current real service plan is accepted by '+operation+' UI; separate risk gate retained',async t=>{
 const records=new Map(),calls=[],NAME='@mogragsigma/dsh-dual-host-plugin',entryId='include:own';
 const credentials={describeRecord:async()=>({writable:true}),readRecord:async k=>structuredClone(records.get(k)),modifyRecord:async(k,fn)=>{const n=fn(structuredClone(records.get(k)));if(n!==undefined)records.set(k,structuredClone(n));}};
 const manager={listPlugins:async()=>[{entryId,moduleName:NAME,enabled:true,fiberPhase:'active'}],listBundles:async()=>[{name:NAME,availability:'profile',enabled:true,installed:true,removable:true,version:'1.0.0',rows:[{entryId,moduleName:NAME}],overrides:[]}],setBundleEnabled:async(name,enabled)=>{calls.push('disable');return {stage:'enable',target:name,enabled,changed:true,application:'applied'};},removeBundle:async name=>{calls.push('remove');return {stage:'remove',target:name,changed:true,application:'applied'};}};
 const activity=createOnboardingActivity(),agents=createOnboardingAgentHold({agents:{list:()=>[]},on:()=>()=>{}}),svc=createOnboardingService({}, {},{activity,agentHold:agents,credentials,pluginManager:manager,ownEntryId:entryId});t.after(()=>svc.dispose());
 const hold=await svc.call('maintenance_record_preview',{});await svc.call('maintenance_record_apply',{id:hold.id,fingerprint:hold.fingerprint,confirm:true});
 const stored=new Map(),storage={getItem:k=>stored.get(k)??null,setItem:(k,v)=>stored.set(k,v)};
 const flow=(operation==='disable'?createSelfDisableFlow:createSelfRemoveFlow)((m,a)=>svc.call(m,a),()=>{},1,storage);
 assert(await flow.act('refresh'));assert(await flow.act(operation),flow.get().error);assert(flow.get().plan);assert.equal(await flow.act('confirm',true,false),false);assert.deepEqual(calls,[]);assert(await flow.act('confirm',true,true),flow.get().error);assert.deepEqual(calls,[operation]);assert.equal(flow.get().receipt.state,'manager_applied');assert.deepEqual([...stored.keys()],['dsh-self-'+operation+'-reference-v1']);
});
