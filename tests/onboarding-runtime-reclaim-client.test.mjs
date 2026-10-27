import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import {randomUUID,createHash} from 'node:crypto';
import {runtimeReclaimClient,reclaimRecordKey,parseReclaimRequest,reclaimBlocked,reclaimPending} from '../bundle/onboarding-runtime-reclaim-client.js';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
async function fixture(){
 const files=[];for(const n of ['onboarding-remote-control.js','onboarding-runtime-extension.js'])files.push({path:'plugin/'+n,data:(await fs.readFile(new URL('../bundle/'+n,import.meta.url))).toString('base64')});
 const caps=Object.fromEntries(['onboardingPluginVersion','onboardingPluginVersionLifecycle','onboardingPluginVersionArtifacts','onboardingPluginUninstall','onboardingRuntimeReclamation','onboardingRuntimeReclamationRequests'].map(k=>[k,1]));files.push({path:'plugin/compatibility.json',data:Buffer.from(JSON.stringify(caps)).toString('base64')});
 const a={files,baseline:{node:{path:'/usr/local/bin/node'}}},p={id:randomUUID(),installationId:randomUUID(),root:'/isolated/'+randomUUID(),proof:'b'.repeat(64),planHash:hash('plan'),archiveHash:hash(a),bindingFingerprint:hash('binding')},runtimeId=randomUUID(),records=new Map();let calls=0,clock=100000,override=null,state='not_requested',id=randomUUID(),fp=hash('plan');
 const ledger=()=>records.get(reclaimRecordKey(p.id))?.payload,c={readRecord:async k=>structuredClone(records.get(k)),modifyRecord:async(k,fn)=>records.set(k,structuredClone(fn(structuredClone(records.get(k)))))};
 const common={contract:1,scope:'stopped_owned_runtime_keep_user_data',operationId:p.id,runtimeId,hostStarted:false,initialization:false,automaticRetry:false,userDataPreserved:true,backupsRetained:true,userDataDeleted:false,irreversible:true};
 const view=()=>({...common,id:state==='not_requested'?null:id,state,completed:state==='committed'?40:0,total:state==='not_requested'?0:40,recoveryRequired:state==='deleting',managedRestartBlocked:state!=='not_requested',runtimeFilesRemoved:state==='committed'});
 async function run(q){
  const n=q.versionAction;if(n==='reclaim_preview')return {...view(),id,fingerprint:fp,expiresAt:clock+300000,canApply:true,files:39,entries:40,bytes:500,removeRoots:['runtime/node_modules'],retainedPaths:['runtime/native-home','runtime/native-tmp','runtime/workspace','runtime','.control','plugin'],requiresExplicitConfirmation:true};
  if(n==='reclaim_recoveryPreview')return {...view(),id,state:state==='not_requested'?'unobserved':state,recoveryRequired:true,managedRestartBlocked:true,total:40,action:state==='not_requested'?'start_original_manifest_if_still_unobserved':'continue_original_manifest_only',fingerprint:hash(state),requiresExplicitConfirmation:true};
  if(['reclaim_apply','reclaim_recover'].includes(n)){assert.equal(ledger().requests.at(-1).state,'requested');assert.equal(q.args.id,id);state='committed';}
  return view();
 }
 const options={p,a,b:{fixture:true},runtimeId,credentials:()=>c,now:()=>clock,ssh:{execute:async(b,command,input)=>{calls++;assert(!command.includes(p.proof));const q=JSON.parse(input);return JSON.stringify({ok:true,value:override?await override(q,run):await run(q)});}}};
 const call=(action,args={})=>runtimeReclaimClient({...options,args:{action:'reclaim_'+action,operationId:p.id,...args}});
 return {call,options,records,ledger,id,view,get calls(){return calls;},setOverride:f=>override=f,setState:s=>state=s,advance:n=>clock+=n,confirm:p=>({id:p.id,fingerprint:p.fingerprint,confirm:true})};
}
test('record is local only; original capabilities cannot be granted by newest client',async()=>{
 const f=await fixture();assert((await f.call('record')).supported);assert.equal(f.calls,0);const c=f.options.a.files.at(-1);c.data=Buffer.from('{}').toString('base64');assert(!(await f.call('record')).supported);await assert.rejects(f.call('preview'),/UNSUPPORTED/);assert.equal(f.calls,0);
});
test('intent precedes SSH, duplicate apply is local and terminal fence remains',async()=>{
 const f=await fixture(),p=await f.call('preview');assert.equal((await f.call('apply',f.confirm(p))).state,'committed');const count=f.calls;assert((await f.call('apply',f.confirm(p))).notResent);assert.equal(f.calls,count);
 assert(reclaimBlocked(f.ledger())&&!reclaimPending(f.ledger()));await assert.rejects(f.call('preview'),/RECOVERY_REQUIRED/);assert.equal(f.calls,count);
});
test('unknown send remains pending across client recreation; query observes result without repeating apply',async()=>{
 const f=await fixture(),p=await f.call('preview');f.setOverride(async(q,run)=>{const v=await run(q);if(q.versionAction==='reclaim_apply')throw Error('lost after completion');return v;});
 await assert.rejects(f.call('apply',f.confirm(p)),/OUTCOME_UNKNOWN/);const n=f.calls;assert((await f.call('record')).pending);assert((await f.call('apply',f.confirm(p))).notResent);assert.equal(f.calls,n);
 assert.equal((await f.call('status',{id:p.id})).state,'committed');assert(!(await f.call('record')).pending);
});
test('loss before target intent is not called unexecuted; separate recovery approval closes the gap',async()=>{
 const f=await fixture(),p=await f.call('preview');f.setOverride(async(q,run)=>{if(q.versionAction==='reclaim_apply')throw Error('before target');return run(q);});await assert.rejects(f.call('apply',f.confirm(p)),/OUTCOME_UNKNOWN/);
 await assert.rejects(f.call('recover_preview',{id:p.id}),/OUTCOME_UNKNOWN/);const s=await f.call('status',{id:p.id});assert(s.outcomeUnknown&&s.observedState==='not_requested');assert((await f.call('record')).pending);
 const r=await f.call('recover_preview',{id:p.id});assert.notEqual(r.id,p.id);assert.equal(r.transactionId,p.id);assert.equal(r.action,'start_original_manifest_if_still_unobserved');assert.equal(f.ledger().requests.length,1);
 assert.equal((await f.call('recover',f.confirm(r))).state,'committed');assert.equal(f.ledger().requests.length,2);assert(!reclaimPending(f.ledger()));const n=f.calls;assert((await f.call('recover',f.confirm(r))).notResent);assert.equal(f.calls,n);
});
test('partial state needs query and separate recovery, no timer or automatic resend',async()=>{
 const f=await fixture(),p=await f.call('preview');f.setOverride(async(q,run)=>{if(q.versionAction==='reclaim_apply'){f.setState('deleting');throw Error('partial');}return run(q);});await assert.rejects(f.call('apply',f.confirm(p)),/OUTCOME_UNKNOWN/);
 assert.equal((await f.call('status',{id:p.id})).state,'deleting');const r=await f.call('recover_preview',{id:p.id});assert.equal(r.action,'continue_original_manifest_only');assert.equal((await f.call('recover',f.confirm(r))).state,'committed');
});
for(const fault of ['scope','runtime','total','data','completed'])test('foreign or invalid receipt '+fault+' cannot clear intent',async()=>{
 const f=await fixture(),p=await f.call('preview');f.setOverride(async(q,run)=>{const v=await run(q);if(q.versionAction==='reclaim_apply'){if(fault==='scope')v.scope='all_data';if(fault==='runtime')v.runtimeId=randomUUID();if(fault==='total')v.total=150001;if(fault==='data')v.userDataDeleted=true;if(fault==='completed')v.completed=0;}return v;});
 await assert.rejects(f.call('apply',f.confirm(p)),/RESPONSE_REVIEW/);assert.equal(f.ledger().requests[0].state,'requested');assert((await f.call('record')).pending);
});
for(const fault of ['wrong_target','remove_user','unknown_recovery'])test('untrusted plan '+fault+' is not persisted',async()=>{
 const f=await fixture(),p=await f.call('preview');
 if(fault==='remove_user'){f.setOverride(async(q,run)=>({...await run(q),removeRoots:['runtime/native-home']}));const count=f.ledger().plans.length;await assert.rejects(f.call('preview'),/RESPONSE_REVIEW/);assert.equal(f.ledger().plans.length,count);return;}
 f.setOverride(async(q,run)=>{if(q.versionAction==='reclaim_apply'){f.setState('deleting');throw Error('partial');}return run(q);});await assert.rejects(f.call('apply',f.confirm(p)),/OUTCOME_UNKNOWN/);await f.call('status',{id:p.id});
 f.setOverride(async(q,run)=>({...await run(q),...(fault==='wrong_target'?{id:randomUUID()}:{action:'delete_everything'})}));await assert.rejects(f.call('recover_preview',{id:p.id}),/RESPONSE_REVIEW/);assert.equal(f.ledger().plans.length,1);
});
test('stale, false and extra confirmation fields never send',async()=>{
 const f=await fixture(),p=await f.call('preview'),n=f.calls;await assert.rejects(f.call('apply',{...f.confirm(p),confirm:false}),/CONFIRMATION/);await assert.rejects(f.call('apply',{...f.confirm(p),root:'/'}),/CONFIRMATION/);f.advance(300001);await assert.rejects(f.call('apply',f.confirm(p)),/PLAN_EXPIRED/);assert.equal(f.calls,n);assert.equal(f.ledger().requests.length,0);
});
test('lost send cannot switch to a different previously previewed plan',async()=>{
 const f=await fixture(),p=await f.call('preview');f.setOverride(async(q,run)=>{if(q.versionAction==='reclaim_preview')return {...await run(q),id:randomUUID()};throw Error('lost');});const other=await f.call('preview');await assert.rejects(f.call('apply',f.confirm(other)),/OUTCOME_UNKNOWN/);const n=f.calls;await assert.rejects(f.call('apply',f.confirm(p)),/RECOVERY_REQUIRED/);assert.equal(f.calls,n);
});
test('missing or corrupted local ledger never fabricates an observed receipt',async()=>{
 const f=await fixture(),p=await f.call('preview');f.records.set(reclaimRecordKey(f.options.p.id),{kind:'grant',payload:{schema:1}});await assert.rejects(f.call('record'),/LOCAL_LEDGER_REVIEW/);assert.throws(()=>parseReclaimRequest({kind:'grant',payload:{}},f.options.p.id));
});
test('binding drift refuses all network and local history access',async()=>{
 const f=await fixture();await f.call('preview');const n=f.calls;f.options.p.archiveHash=hash('other');await assert.rejects(f.call('record'),/BINDING_CHANGED/);assert.equal(f.calls,n);
});

test('classified stale target plan can be freshly previewed without resending the old confirmation',async()=>{
 const f=await fixture(),p=await f.call('preview');f.options.ssh.execute=async()=>JSON.stringify({ok:false,error:'ONBOARDING_CLOUD_RUNTIME_RECLAIM_PLAN_EXPIRED'});
 await assert.rejects(f.call('apply',f.confirm(p)),/PLAN_EXPIRED/);assert.equal(f.ledger().requests[0].receipt.state,'refused');assert(!reclaimBlocked(f.ledger())&&!reclaimPending(f.ledger()));assert.equal((await f.call('apply',f.confirm(p))).state,'refused');
});
for(const code of ['ONBOARDING_CLOUD_RUNTIME_RECLAIM_DRIFT','ONBOARDING_CLOUD_RUNTIME_RECLAIM_PLAN_REVIEW','ONBOARDING_CLOUD_RUNTIME_RECLAIM_ALREADY_REQUESTED'])test('target '+code+' cannot be classified as pre-intent refusal',async()=>{
 const f=await fixture(),p=await f.call('preview');f.options.ssh.execute=async()=>JSON.stringify({ok:false,error:code});await assert.rejects(f.call('apply',f.confirm(p)));assert(reclaimBlocked(f.ledger())&&reclaimPending(f.ledger()));assert.equal(f.ledger().requests[0].state,'requested');
});

test('background running receipt is not completion, cannot recover active work, query observes interruption',async()=>{
 const f=await fixture(),p=await f.call('preview');f.setOverride(async(q,run)=>{if(q.versionAction==='reclaim_apply'||q.versionAction==='reclaim_status'){f.setState('deleting');return {...f.view(),backgroundSupported:true,workerActive:true,executionState:'running',recoveryRequired:false};}return run(q);});
 const v=await f.call('apply',f.confirm(p));assert.equal(v.executionState,'running');assert((await f.call('record')).pending);await assert.rejects(f.call('recover_preview',{id:p.id}),/OUTCOME_UNKNOWN/);
 f.setOverride(async()=>({...f.view(),backgroundSupported:true,workerActive:false,executionState:'interrupted',recoveryRequired:true}));assert.equal((await f.call('status',{id:p.id})).executionState,'interrupted');assert(f.ledger().requests[0].receipt.recoveryRequired);
});
for(const fault of ['active','state','recovery'])test('invalid background receipt '+fault+' remains unknown',async()=>{
 const f=await fixture(),p=await f.call('preview');f.setOverride(async()=>{f.setState('deleting');return {...f.view(),backgroundSupported:true,workerActive:fault==='active'?'yes':true,executionState:fault==='state'?'completed':'running',recoveryRequired:fault==='recovery'};});await assert.rejects(f.call('apply',f.confirm(p)),/RESPONSE_REVIEW/);assert.equal(f.ledger().requests[0].state,'requested');
});
