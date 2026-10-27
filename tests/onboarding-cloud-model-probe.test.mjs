import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOnboardingModelProbe} from '../bundle/onboarding-model-probe.js';
import {createOnboardingCloudModelProbe} from '../bundle/onboarding-cloud-model-probe.js';
import {digest} from '../bundle/onboarding-ssh.js';
const confirm=p=>({id:p.id,fingerprint:p.fingerprint,confirm:true});
function fixture(provider='dsh-onboarding-deepseek'){
 const records=new Map(),target={operationId:randomUUID(),installationId:randomUUID(),runtimeId:randomUUID(),manifestHash:'a'.repeat(64),root:'/isolated/cloud',role:'cloud',hostVersion:'0.2.1-rc.2'},identity={role:'cloud',name:'云端大肥鱼',source:'setup_configuration',platform:'linux'};
 let time=1000,lose=false,offline=false,requests=0,release;const calls=[],selection={provider,provider_name:'Test provider',model:'test-flash',model_name:'Test Flash'};
 const credentials={readRecord:async k=>structuredClone(records.get(k)),modifyRecord:async(k,fn)=>records.set(k,structuredClone(fn(structuredClone(records.get(k)))))};
 const probe=createOnboardingModelProbe({credentials:()=>credentials,llm:()=>({prepareCall:async policy=>({config:policy,stream:async function*(){requests++;await new Promise(r=>release=r);yield {type:'block-start',index:0,blockType:'text'};yield {type:'block-end',index:0,block:{type:'text',text:'mock'}};yield {type:'finish',reason:{kind:'stop'}};}})}),snapshot:async()=>({target:identity,state:'configured_unverified',registered:true,provider,bindingRevision:1,credentialRevision:1}),resolve:async()=>({status:'resolved',selection}),provider,recordName:'test-probe',now:()=>time});
 const remote=async(method,args)=>{calls.push({method,args});if(offline)throw Error('OFFLINE');const {targetHash,...a}=args;if(targetHash)assert.equal(targetHash,digest(target));const value=await probe[method.slice(12)](a);if(lose&&method==='model_probe_start')throw Error('LOST');return {target,value};};
 const deps={remote,provider,now:()=>time},cloud=createOnboardingCloudModelProbe(deps);
 return {cloud,deps,target,records,calls,requests:()=>requests,lose:()=>lose=true,offline:()=>offline=true,advance:()=>time+=300001,release:async()=>{release();await new Promise(r=>setImmediate(r));}};
}
test('cloud preview binds identity and route; async start returns before provider completes',async()=>{
 const f=fixture();assert.equal(f.calls.length,0);assert.equal((await f.cloud.status({})).receipt,null);
 const p=await f.cloud.preview({query:'ds flash',acknowledgeUnknown:null});assert.equal(f.requests(),0);assert.equal(p.scope,'managed_cloud_only');assert.equal(p.modelRequests,0);assert.equal(p.limits.requests,1);
 const r=await f.cloud.start(confirm(p));assert.equal(r.receipt.state,'running');assert.equal(r.receipt.id,p.operationId);assert.equal(f.calls.at(-1).args.targetHash,digest(f.target));assert.equal(f.requests(),1);
 await f.release();assert.equal((await f.cloud.status({})).receipt.state,'succeeded');assert.equal(f.requests(),1);
});
test('lost start response and controller restart only reconcile status, never resend',async()=>{
 const f=fixture(),p=await f.cloud.preview({query:'ds flash',acknowledgeUnknown:null});f.lose();await assert.rejects(f.cloud.start(confirm(p)),/LOST/);await assert.rejects(f.cloud.start(confirm(p)),/PLAN_EXPIRED/);
 const restarted=createOnboardingCloudModelProbe(f.deps);assert.equal((await restarted.status({})).receipt.id,p.operationId);await assert.rejects(restarted.start(confirm(p)),/PLAN_EXPIRED/);await f.release();assert.equal((await restarted.status({})).receipt.state,'succeeded');assert.equal(f.requests(),1);assert.equal(f.calls.filter(x=>x.method==='model_probe_start').length,1);
});
test('offline does not invoke local model or silently retry',async()=>{const f=fixture();f.offline();await assert.rejects(f.cloud.status({}),/OFFLINE/);assert.equal(f.calls.length,1);assert.equal(f.requests(),0);});
test('changed target response is rejected; no success claim or auto retry',async()=>{const f=fixture(),cloud=createOnboardingCloudModelProbe({...f.deps,remote:async(...args)=>{const r=await f.deps.remote(...args);return args[0]==='model_probe_start'?{...r,target:{...r.target,runtimeId:randomUUID()}}:r;}}),p=await cloud.preview({query:'ds flash',acknowledgeUnknown:null});await assert.rejects(cloud.start(confirm(p)),/IDENTITY_REVIEW/);await f.release();assert.equal(f.requests(),1);});
test('expired, unconfirmed and injected provider/prompt requests never start',async()=>{const f=fixture();await assert.rejects(f.cloud.preview({query:'ds flash',acknowledgeUnknown:null,provider:'daily'}),/ARGUMENTS/);const p=await f.cloud.preview({query:'ds flash',acknowledgeUnknown:null});await assert.rejects(f.cloud.start({...confirm(p),confirm:false}),/CONFIRMATION_REQUIRED/);f.advance();await assert.rejects(f.cloud.start(confirm(p)),/PLAN_EXPIRED/);assert.equal(f.requests(),0);});
test('foreign provider, changed limits, legacy contract and secret output are rejected',async()=>{
 for(const mutate of [v=>({...v,contract:1}),v=>({...v,secret:'NO_ECHO'}),v=>({...v,limits:{...v.limits,requests:2}}),v=>({...v,target:{...v.target,role:'local'}})]){const f=fixture(),cloud=createOnboardingCloudModelProbe({...f.deps,remote:async(...a)=>{const r=await f.deps.remote(...a);return {...r,value:mutate(r.value)};}});await assert.rejects(cloud.status({}),/RESPONSE_REVIEW|IDENTITY_REVIEW/);assert.equal(f.requests(),0);}
 const f=fixture('foreign-provider'),cloud=createOnboardingCloudModelProbe({...f.deps,provider:'dsh-onboarding-deepseek'});await assert.rejects(cloud.preview({query:'flash',acknowledgeUnknown:null}),/RESPONSE_REVIEW/);
});

test('cloud preview forwards ordinary clarification; unrecognized fields and malformed phrases never reach transport',async()=>{
 const f=fixture(),phrase='请用 DeepSeek（双端配置）';await f.cloud.preview({query:'ds flash',clarification:phrase,acknowledgeUnknown:null});assert.equal(f.calls.at(-1).args.clarification,phrase);const n=f.calls.length;
 for(const clarification of ['',null,'x'.repeat(201),'a\nb','a\x7fb',44])await assert.rejects(f.cloud.preview({query:'ds flash',clarification,acknowledgeUnknown:null}),/ARGUMENTS/);await assert.rejects(f.cloud.preview(null),/ARGUMENTS/);assert.equal(f.calls.length,n);assert.equal(f.requests(),0);
});
