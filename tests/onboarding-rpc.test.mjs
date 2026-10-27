import test from 'node:test';
import assert from 'node:assert/strict';
import {callOnboarding} from '../ui-source/onboarding/rpc.js';
test('onboarding RPC preserves returned values and the exact public call shape',async()=>{
 const result=await callOnboarding(async(...a)=>{assert.deepEqual(a,['/api','task-onboarding/control',{method:'model_status',args:{}}]);return {ok:true,value:{state:'disabled'}};},'model_status',{});
 assert.deepEqual(result,{state:'disabled'});
});
test('onboarding RPC normalizes both returned and thrown official error codes',async()=>{
 const code='ONBOARDING_MODEL_CREDENTIAL_REQUIRED';
 for(const call of [async()=>({ok:false,error:{code,message:'opaque'}}),async()=>{throw Object.assign(Error('operation failed'),{code,isDSHRemoteError:true});},async()=>{throw Error(code);}])await assert.rejects(callOnboarding(call,'model_preview',{}),{message:code});
});
test('onboarding RPC never exposes freeform server error text',async()=>{
 for(const call of [async()=>{throw Error('secret test text');},async()=>({ok:false,error:{code:'arbitrary secret'}}),async()=>undefined])await assert.rejects(callOnboarding(call,'model_status',{}),{message:'ONBOARDING_UNAVAILABLE'});
});
test('native transport failures preserve bounded categories without exposing freeform details or retrying',async()=>{
 const errors=[['transport failure for /api/task-onboarding/control: HTTP 431','HEADERS_TOO_LARGE'],['transport failure for /api/task-onboarding/control: HTTP 403','AUTH_REQUIRED'],['transport failure for /api/task-onboarding/control: HTTP 502','UNAVAILABLE'],['transport failure for /api/task-onboarding/control: HTTP 422','HTTP_REJECTED'],['rpcId mismatch for task-onboarding/control: sent PRIVATE, got PRIVATE','RESPONSE_INVALID'],['connection: invalid server-response result','RESPONSE_INVALID']];
 for(const [message,category] of errors){let calls=0;await assert.rejects(callOnboarding(async()=>{calls++;throw Error(message);},'cloud_runtime',{}),{message:'ONBOARDING_TRANSPORT_'+category});assert.equal(calls,1);}
 await assert.rejects(callOnboarding(async()=>{throw new TypeError('Failed to fetch');},'cloud_runtime',{}),{message:'ONBOARDING_TRANSPORT_INTERRUPTED'});
 await assert.rejects(callOnboarding(async()=>{throw Error('transport failure for /api/other: HTTP 431 PRIVATE');},'cloud_runtime',{}),{message:'ONBOARDING_UNAVAILABLE'});
});

test('onboarding failure envelope conforms to native connection contract including details',async()=>{
 const {installOnboarding}=await import('../bundle/onboarding-host.js');let route;const disposers=[];
 installOnboarding({inject:(_,fn)=>fn({effect:setup=>disposers.push(setup()),connection:{fetch:{register:r=>{route=r;}}}})},{});
 const response=await route.fetch(new Request('http://localhost/api/task-onboarding/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:'contract',method:'task-onboarding/control',payload:{method:'model_preview',args:{enabled:true}}})}));
 const wire=await response.json();assert.equal(wire.type,'server-response');assert.equal(wire.result.ok,false);assert.equal(wire.result.error.code,'ONBOARDING_ACTIVITY_ADMISSION_BLOCKED');assert.deepEqual(wire.result.error.details,{});assert.equal(typeof wire.result.error.message,'string');
 await assert.rejects(callOnboarding(async()=>wire.result,'model_preview',{}),{message:'ONBOARDING_ACTIVITY_ADMISSION_BLOCKED'});
 assert.equal(disposers.length,1);await disposers[0]();
});
