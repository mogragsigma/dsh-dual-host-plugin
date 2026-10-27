import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOnboardingState} from '../bundle/onboarding-state.js';
import {createOnboardingHandoff} from '../bundle/onboarding-handoff.js';
import {createOnboardingCloudModels} from '../bundle/onboarding-cloud-models.js';
import {createOnboardingTokenPlanModels,TOKEN_PLAN_PROVIDER,TOKEN_PLAN_ENDPOINT} from '../bundle/onboarding-token-plan.js';
import {createOnboardingModels} from '../bundle/onboarding-models.js';
import {createOnboardingService} from '../bundle/onboarding-host.js';
import {defaults,validateDraft} from '../bundle/onboarding-schema.js';
import {digest} from '../bundle/onboarding-ssh.js';
const secret='sk-SYNTHETIC_CLOUD_TOKEN_NOT_REAL',confirm=p=>({id:p.id,fingerprint:p.fingerprint,confirm:true});
function store(){const records=new Map();let writes=0,tail=Promise.resolve();return {records,writes:()=>writes,readRecord:async k=>structuredClone(records.get(k)),describeRecord:async()=>({writable:true}),modifyRecord(k,fn){const p=tail.then(async()=>{const v=await fn(structuredClone(records.get(k)));if(v!==undefined){records.set(k,structuredClone(v));writes++;}});tail=p.catch(()=>{});return p;}};}
function fixture(){
 const c=store(),d=store(),adapters=new Map(),calls=[];let time=1000,drop=false,losePut=false,loseApply=false;
 const base={home:'/isolated/cloud-token',env:{},now:()=>time},local=createOnboardingState({}, {},{...base,credentials:c}),cloud=createOnboardingState({}, {},{...base,credentials:d});
 const llm={registerAdapter(ids,a){for(const id of ids){assert(!adapters.has(id));adapters.set(id,a);}},listProviders:()=>[...adapters].map(([id,a])=>a.providerInfo(id)),listModels:p=>adapters.get(p)?.listModels(p)??[],resolveCallConfig:async x=>x};
 const runtime={...base,credentials:d,llm,platform:'linux'},config={onboarding:{role:'cloud'}},native=createOnboardingTokenPlanModels({},config,runtime),deepseek=createOnboardingModels({},config,runtime);
 const target={operationId:randomUUID(),installationId:randomUUID(),runtimeId:randomUUID(),manifestHash:'a'.repeat(64),root:'/isolated/token-cloud',role:'cloud',hostVersion:'0.2.1-rc.2'};
 const remote=async(method,args)=>{
  calls.push({method,args});if(drop)throw Error('OFFLINE');if(args.targetHash)assert.equal(args.targetHash,digest(target));
  const token=method.startsWith('token_'),action=token?method.slice(6):method,slot=token?'token-plan':'deepseek-local';
  if(action.startsWith('model_')){const {targetHash,...a}=args;const value=await (token?native:deepseek)[action.slice(6)](a);if(loseApply&&action==='model_apply')throw Error('LOST_MODEL_RECEIPT');return {target,value};}
  if(action==='inspect'){const s=(await cloud.secrets()).slots.find(x=>x.slot===slot);return {target,slot,revision:s.revision,configured:s.configured,fencingSupported:true};}
  const a={slot,operation:args.operation,expectedRevision:args.expectedRevision};
  if(action==='put'){await cloud.put({...a,secret:args.secret,confirm:true});if(losePut)throw Error('LOST_KEY_RECEIPT');}
  if(action==='fence')await cloud.fence({...a,confirm:true});
  const s=await cloud.secretReceipt(a);return {target,slot,revision:s.revision,configured:s.configured,operationMatched:s.operationMatched,fencingSupported:true};
 };
 const deps={state:local,credentials:()=>c,remote,enabled:()=>true,now:()=>time,service:'token-plan'};
 return {c,d,local,cloud,native,deepseek,runtime,config,adapters,calls,target,deps,remote,handoff:createOnboardingHandoff(deps),models:createOnboardingCloudModels(deps),put:(slot='token-plan-cloud',rev=0,value=secret)=>local.put({slot,expectedRevision:rev,operation:randomUUID(),confirm:true,secret:value}),drop:v=>{drop=v;},losePut:()=>{losePut=true;},loseApply:()=>{loseApply=true;},advance:()=>{time+=300001;}};
}
async function delivered(){const f=fixture();await f.put();await f.handoff.apply(confirm(await f.handoff.preview({})));return f;}
test('cloud token needs its staged Key; neither local Token Plan nor DeepSeek can satisfy it',async()=>{
 const f=fixture();for(const slot of ['deepseek-local','deepseek-cloud','token-plan'])await f.put(slot);
 assert.equal((await f.handoff.status({refresh:false})).state,'not_started');await assert.rejects(f.handoff.preview({}),/SOURCE_REQUIRED/);assert.equal(f.calls.length,0);
 await f.put();const p=await f.handoff.preview({});assert.equal(p.sourceSlot,'token-plan-cloud');assert.equal(p.destinationSlot,'token-plan');assert.equal(f.d.writes(),0);assert(!JSON.stringify(p).includes(secret));
});
test('two services use separate ledgers and target slots, never implicitly enable a model',async()=>{
 const f=await delivered();assert.equal((await f.cloud.readManagedSecret('token-plan')).value,secret);assert.equal((await f.cloud.readManagedSecret('deepseek-local')).value,null);
 assert.equal((await f.native.status()).state,'not_configured');assert.equal(f.adapters.size,0);
 const other=createOnboardingHandoff({...f.deps,service:'deepseek'});assert.equal((await other.status({refresh:false})).state,'not_started');
 await f.put('deepseek-cloud',0,secret+'DEEPSEEK');await other.apply(confirm(await other.preview({})));assert.equal((await f.handoff.status({refresh:false})).state,'delivered');
 assert.equal((await f.cloud.readManagedSecret('token-plan')).value,secret);assert.equal((await f.cloud.readManagedSecret('deepseek-local')).value,secret+'DEEPSEEK');
 assert(!JSON.stringify([...f.c.records].filter(([k])=>k.includes('handoff'))).includes(secret));
});
test('lost token handoff receipt survives controller restart and source removal without a resend',async()=>{
 const f=fixture();await f.put();const p=await f.handoff.preview({});f.losePut();assert.equal((await f.handoff.apply(confirm(p))).state,'needs_review');
 await f.local.remove({slot:'token-plan-cloud',expectedRevision:1,operation:randomUUID(),confirm:true});const next=createOnboardingHandoff(f.deps);
 assert((await next.apply(confirm(p))).notResent);assert.equal((await next.status({refresh:true})).state,'delivered');assert.equal(f.calls.filter(x=>x.method==='token_put').length,1);assert.equal(f.d.writes(),1);
});
test('token delayed write fenced after explicit closure, preserving DeepSeek and local staging',async()=>{
 const f=fixture();await f.put();await f.cloud.put({slot:'deepseek-local',expectedRevision:0,operation:randomUUID(),confirm:true,secret:secret+'KEEP'});
 const old=await f.handoff.preview({});f.drop(true);await f.handoff.apply(confirm(old));f.drop(false);const p=await f.handoff.recoveryPreview({});assert.equal(p.mode,'fence');assert.equal((await f.handoff.recoveryApply(confirm(p))).state,'closed');
 assert.deepEqual(await f.cloud.readManagedSecret('token-plan'),{value:null,revision:1});assert.equal((await f.cloud.readManagedSecret('deepseek-local')).value,secret+'KEEP');
 await assert.rejects(f.cloud.put({slot:'token-plan',operation:old.id,expectedRevision:0,confirm:true,secret}),/SECRET_CONFLICT/);assert.equal((await f.local.readManagedSecret('token-plan-cloud')).value,secret);
});
test('copying a DeepSeek handoff ledger under the token key is rejected, not adopted',async()=>{
 const f=fixture(),other=createOnboardingHandoff({...f.deps,service:'deepseek'});await f.put('deepseek-cloud');await other.apply(confirm(await other.preview({})));
 f.c.records.set('dsh-task-gateway/onboarding-token-cloud-handoff-v1',structuredClone(f.c.records.get('dsh-task-gateway/onboarding-cloud-handoff-v1')));
 await assert.rejects(f.handoff.status({refresh:false}),/LEDGER_REVIEW/);
});
test('cloud Token Plan status and apply are bound to actual token endpoint/slot, not DeepSeek',async()=>{
 const f=await delivered(),n=f.d.writes(),p=await f.models.preview({enabled:true});assert.equal(p.endpoint,TOKEN_PLAN_ENDPOINT);assert.equal(f.d.writes(),n);
 const s=await f.models.apply(confirm(p));assert.equal(s.provider,TOKEN_PLAN_PROVIDER);assert.equal(s.state,'configured_unverified');assert.equal(s.reasoningEffort,'high');assert(!s.verificationRecorded&&!s.defaultModelChanged);assert.equal((await f.deepseek.status()).state,'not_configured');
 const rows=await f.runtime.llm.listModels(TOKEN_PLAN_PROVIDER),query=(rows.find(x=>/glm/i.test(x.id))??rows[0]).id,r=await f.models.resolve({query});assert.equal(r.host,'cloud');assert.equal(r.status,'resolved');assert.equal(r.selection.provider,TOKEN_PLAN_PROVIDER);assert(!r.execution_authorized&&!r.provider_io_verified);
 assert(!JSON.stringify(f.calls.filter(x=>x.method.includes('model_'))).includes(secret));
});
test('cloud model apply reply loss reconciles without retransmission or local fallback',async()=>{
 const f=await delivered(),p=await f.models.preview({enabled:true});f.loseApply();await assert.rejects(f.models.apply(confirm(p)),/LOST_MODEL_RECEIPT/);await assert.rejects(f.models.apply(confirm(p)),/PLAN_EXPIRED/);
 const s=await createOnboardingCloudModels(f.deps).status({});assert.equal(s.state,'configured_unverified');assert.equal(f.calls.filter(x=>x.method==='token_model_apply').length,1);
});
test('token cloud model rejects foreign service response, credential rotation and target drift',async()=>{
 const f=await delivered(),wrong=createOnboardingCloudModels({...f.deps,remote:(method,args)=>f.remote(method.replace('token_',''),args)});
 await assert.rejects(wrong.status({}),/RESPONSE_REVIEW/);const p=await f.models.preview({enabled:true});await f.cloud.put({slot:'token-plan',expectedRevision:1,operation:randomUUID(),confirm:true,secret:secret+'ROTATE'});await assert.rejects(f.models.apply(confirm(p)),/CREDENTIAL_CHANGED/);
 const drift=createOnboardingCloudModels({...f.deps,remote:async(...a)=>{const r=await f.remote(...a);return a[0]==='token_model_apply'?{...r,target:{...r.target,runtimeId:randomUUID()}}:r;}});await assert.rejects(drift.apply(confirm(await drift.preview({enabled:true}))),/IDENTITY_REVIEW/);
});
test('approved token binding restores at target restart; explicit disable retains only its Key',async()=>{
 const f=await delivered();await f.models.apply(confirm(await f.models.preview({enabled:true})));f.adapters.clear();const next=createOnboardingTokenPlanModels({},f.config,f.runtime);await next.start();assert.equal((await next.status()).state,'configured_unverified');
 await f.models.apply(confirm(await f.models.preview({enabled:false})));assert.equal((await f.models.status({})).state,'disabled');assert.equal((await f.cloud.readManagedSecret('token-plan')).value,secret);assert.deepEqual(await f.runtime.llm.listModels(TOKEN_PLAN_PROVIDER),[]);
});
test('caller cannot select an arbitrary handoff service, destination slot or endpoint',async()=>{
 const f=fixture();assert.throws(()=>createOnboardingHandoff({...f.deps,service:'arbitrary'}),/SERVICE_REVIEW/);assert.throws(()=>createOnboardingCloudModels({...f.deps,service:'arbitrary'}),/SERVICE_REVIEW/);
 await assert.rejects(f.handoff.preview({slot:'deepseek-local'}),/ARGUMENTS/);await assert.rejects(f.models.preview({enabled:true,service:'deepseek'}),/ARGUMENTS/);await assert.rejects(f.cloud.fence({slot:'token-plan-cloud',operation:randomUUID(),expectedRevision:0,confirm:true}),/INVALID_SECRET_REQUEST/);assert.equal(f.d.writes(),0);
});
test('dedicated public RPC maps token handoff and cloud model actions without opening raw access',async()=>{
 const f=fixture(),rpc=createOnboardingService({}, {},{...f.runtime,credentials:f.c,tokenModels:f.native,models:f.deepseek});const d=await rpc.call('describe',{});assert(d.capabilities.cloudTokenPlanHandoff&&d.capabilities.cloudTokenPlanBinding&&d.capabilities.tokenPlanCredentialReceipt&&d.capabilities.tokenPlanCredentialFence);
 assert.equal((await rpc.call('token_handoff_status',{refresh:false})).state,'not_started');await assert.rejects(rpc.call('token_handoff_preview',{}),/SOURCE_REQUIRED/);await assert.rejects(rpc.call('cloud_token_model_status',{}),/CLOUD_RUNTIME_SOURCE_NOT_READY/);
 await assert.rejects(rpc.call('cloud_token_model_status',{service:'deepseek'}),/ARGUMENTS/);await assert.rejects(rpc.call('readManagedSecret',{slot:'token-plan-cloud'}),/INVALID_ARGUMENTS|METHOD_DENIED/);
});
test('new optional cloud reference preserves old drafts and refuses accidental secret strings',()=>{
 const d={...defaults(),host:'ecs.example',user:'worker',sshReference:'ecs',deepseekReference:'base-key',model:'ds flash'};delete d.cloudTokenReference;assert(validateDraft(d).pageValid[1]);assert(validateDraft({...d,cloudTokenReference:'dsh-managed:token-plan-cloud'}).pageValid[1]);assert(!validateDraft({...d,cloudTokenReference:secret}).pageValid[1]);
});
test('optional Token Plan supports cloud-only and local-only configuration, not a forced pair',()=>{
 const base={...defaults(),host:'ecs.example',user:'worker',sshReference:'ecs',deepseekReference:'base-key',model:'ds flash',extra:true};
 assert(!validateDraft(base).pageValid[1]);
 assert(validateDraft({...base,cloudTokenReference:'dsh-managed:token-plan-cloud'}).pageValid[1]);
 assert(validateDraft({...base,tokenReference:'dsh-managed:token-plan'}).pageValid[1]);
 assert(validateDraft({...base,tokenReference:'dsh-managed:token-plan',cloudTokenReference:'dsh-managed:token-plan-cloud'}).pageValid[1]);
 assert(!validateDraft({...base,tokenReference:'bad reference',cloudTokenReference:'dsh-managed:token-plan-cloud'}).pageValid[1]);
 assert(!validateDraft({...base,tokenReference:'dsh-managed:token-plan',cloudTokenReference:'bad reference'}).pageValid[1]);
 assert(validateDraft({...base,extra:false}).pageValid[1]);
});
