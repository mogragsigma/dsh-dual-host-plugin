import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import {createOnboardingService} from '../bundle/onboarding-host.js';
import {createOnboardingState} from '../bundle/onboarding-state.js';
import {createOnboardingCloudRepositories} from '../bundle/onboarding-cloud-repositories.js';
import {repositoryRegistryStatus,repositoryRegistryPlan} from '../bundle/onboarding-repositories.js';
import {digest} from '../bundle/onboarding-ssh.js';
const input={url:'https://gitee.com/fixture/results',alias:'成果库',authentication:'anonymous',enabled:true},confirm=p=>({id:p.id,fingerprint:p.fingerprint,confirm:true});
function store(){const records=new Map();let tail=Promise.resolve(),writes=0;return {records,writes:()=>writes,readRecord:async k=>structuredClone(records.get(k)),describeRecord:async()=>({writable:true}),modifyRecord(k,fn){const p=tail.then(()=>{const v=fn(structuredClone(records.get(k)));if(v!==undefined){records.set(k,structuredClone(v));writes++;}});tail=p.catch(()=>{});return p;}};}
function fixture(){
 const credentials=store(),cloudCredentials=store(),target={operationId:randomUUID(),installationId:randomUUID(),runtimeId:randomUUID(),manifestHash:'a'.repeat(64),root:'/isolated/cloud',role:'cloud',hostVersion:'0.2.1-rc.2'};
 let time=1000,mode='normal',savedApply,mutator=null;
 const runtime={credentials:cloudCredentials,platform:'linux',home:'/isolated/cloud',env:{},now:()=>time,repositoryFetch:async u=>Response.json(u.includes('/branches/')?{name:'main',commit:{sha:'a'.repeat(40)}}:{id:8,full_name:'fixture/results',private:false,default_branch:'main'})};
 let cloud=createOnboardingService({}, {onboarding:{role:'cloud'}},runtime);const calls=[];
 const localState=createOnboardingState({}, {},{credentials,home:'/isolated/mac',env:{}});
 const remote=async(method,args)=>{
  calls.push({method,args});if(args.targetHash)assert.equal(args.targetHash,digest(target));
  if(mode==='offline')throw Error('OFFLINE');
  const {targetHash,...a}=args;
  if(method==='repository_registry_apply'&&['unsent','late'].includes(mode)){savedApply=a;throw Error('UNKNOWN');}
  if(method==='repository_registry_fence'&&mode==='late'){await cloud.call('repository_registry_apply',savedApply);}
  const value=await cloud.call(method,a);
  if(method==='repository_registry_apply'&&mode==='lost')throw Error('LOST_RESPONSE');
  const result={target:structuredClone(target),value};return mutator?mutator(result,method):result;
 };
 const deps={state:localState,credentials:()=>credentials,remote,enabled:()=>true,now:()=>time};
 return {credentials,cloudCredentials,localState,target,calls,runtime,deps,client:createOnboardingCloudRepositories(deps),cloudCall:(m,a={})=>cloud.call('repository_registry_'+m,a),setMode:v=>mode=v,setMutator:f=>mutator=f,advance:n=>time+=n,restartCloud:()=>{cloud=createOnboardingService({}, {onboarding:{role:'cloud'}},runtime);},lateApply:()=>cloud.call('repository_registry_apply',savedApply)};
}
test('cached mount reads no SSH; explicit preview/confirm targets cloud and does not enable runtime',async()=>{
 const f=fixture(),s=await f.client.status({refresh:false});assert.equal(s.operation.state,'not_started');assert.equal(f.calls.length,0);
 const p=await f.client.preview(input);assert.equal(f.credentials.writes(),0);assert.equal(f.cloudCredentials.writes(),0);assert.equal(p.remoteTarget.root,f.target.root);
 const r=await f.client.apply(confirm(p));assert.equal(r.operation.state,'applied');assert.equal(r.registry.revision,1);assert.equal(r.registry.runtimeConfigured,false);assert(!r.taskBound&&!r.writeAuthorized);
 assert.equal((await f.localState.secrets()).slots.some(x=>x.configured),false);assert(!JSON.stringify(f.credentials.records).includes('secret'));
});
test('lost apply response is recovered across both service restarts with no resend',async()=>{
 const f=fixture(),p=await f.client.preview(input);f.setMode('lost');assert.equal((await f.client.apply(confirm(p))).operation.state,'needs_review');f.setMode('normal');f.restartCloud();
 const restarted=createOnboardingCloudRepositories(f.deps),n=f.calls.length;assert.equal((await restarted.status({refresh:false})).operation.state,'needs_review');assert.equal(f.calls.length,n);
 assert.equal((await restarted.status({refresh:true})).operation.state,'applied');assert((await restarted.apply(confirm(p))).notResent);assert.equal(f.calls.filter(x=>x.method==='repository_registry_apply').length,1);assert.equal((await f.cloudCall('status')).revision,1);
});
test('unconfirmed send blocks new preview; recovery preserves entries and fences delayed old apply',async()=>{
 const f=fixture(),p=await f.client.preview(input);f.setMode('unsent');await f.client.apply(confirm(p));await assert.rejects(f.client.preview({...input,alias:'new'}),/RECOVERY_REQUIRED/);
 f.setMode('normal');const close=await f.client.recoveryPreview({});assert.equal(close.mode,'fence');assert(close.preservesEntries);const r=await f.client.recoveryApply(confirm(close));assert.equal(r.operation.state,'closed');assert.deepEqual(r.registry.entries,[]);assert.equal(r.registry.revision,1);
 await assert.rejects(f.lateApply(),/REGISTRY_CONFLICT/);assert((await f.client.recoveryApply(confirm(close))).notResent);assert.equal(f.calls.filter(x=>x.method==='repository_registry_fence').length,1);
});
test('original request winning the close race reports applied, never falsely revoked',async()=>{
 const f=fixture(),p=await f.client.preview(input);f.setMode('late');await f.client.apply(confirm(p));const close=await f.client.recoveryPreview({}),r=await f.client.recoveryApply(confirm(close));assert.equal(r.operation.state,'applied');assert.equal(r.registry.entries[0].alias,input.alias);assert.equal(r.registry.revision,1);
});
test('unrelated larger revision closes uncertainty without overwriting its configuration',async()=>{
 const f=fixture(),p=await f.client.preview(input);f.setMode('unsent');await f.client.apply(confirm(p));f.setMode('normal');const q=await f.cloudCall('preview',{...input,alias:'另一个已确认名称'});await f.cloudCall('apply',confirm(q));
 const r=await f.client.status({refresh:true});assert.equal(r.operation.state,'closed');assert.equal(r.registry.entries[0].alias,'另一个已确认名称');assert.equal(f.calls.filter(x=>x.method==='repository_registry_fence').length,0);
});
test('cloud restart before apply rejects expired remote plan; explicit barrier safely closes it',async()=>{
 const f=fixture(),p=await f.client.preview(input);f.restartCloud();const r=await f.client.apply(confirm(p));assert.equal(r.operation.state,'needs_review');assert.equal((await f.cloudCall('status')).revision,0);const c=await f.client.recoveryPreview({});assert.equal((await f.client.recoveryApply(confirm(c))).operation.state,'closed');
});
test('offline/manual queries keep historical applied receipt but never claim current registry readiness',async()=>{
 const f=fixture(),p=await f.client.preview(input);await f.client.apply(confirm(p));f.setMode('offline');const r=await f.client.status({refresh:true});assert.equal(r.operation.state,'applied');assert.equal(r.registry,null);assert.equal(r.freshness,'check_failed');assert(r.operation.error);
});
test('target replacement cannot adopt an old confirmation or status result',async()=>{
 const f=fixture(),p=await f.client.preview(input);f.setMutator(r=>({...r,target:{...r.target,runtimeId:randomUUID()}}));const r=await f.client.apply(confirm(p));assert.equal(r.operation.state,'needs_review');assert.equal((await f.client.status({refresh:true})).freshness,'check_failed');f.setMutator(null);assert.equal((await f.client.status({refresh:true})).operation.state,'applied');
});
test('expired local confirmation never sends cloud mutation',async()=>{const f=fixture(),p=await f.client.preview(input);f.advance(300001);await assert.rejects(f.client.apply(confirm(p)),/PLAN_EXPIRED/);assert.equal(f.calls.filter(x=>x.method==='repository_registry_apply').length,0);});
test('competing control tabs use local ledger CAS; only winning tab sends',async()=>{
 const f=fixture(),second=createOnboardingCloudRepositories(f.deps),p=await f.client.preview(input),q=await second.preview({...input,alias:'另一页'});await f.client.apply(confirm(p));await assert.rejects(second.apply(confirm(q)),/LEDGER_CONFLICT/);assert.equal(f.calls.filter(x=>x.method==='repository_registry_apply').length,1);
});
test('corrupt/foreign local ledger remains intact and no network request follows',async()=>{
 const f=fixture(),key='dsh-task-gateway/onboarding-cloud-repositories-v1';f.credentials.records.set(key,{kind:'api-key',key:'KEEP'});await assert.rejects(f.client.preview(input),/LEDGER_REVIEW/);assert.equal(f.calls.length,0);assert.equal(f.credentials.records.get(key).key,'KEEP');
});
test('malformed target plans and overclaiming registry responses cannot pass',async()=>{
 const f=fixture(),p=await f.cloudCall('preview',input);assert.equal(repositoryRegistryPlan(p).entry.alias,input.alias);
 for(const patch of [{fingerprint:'f'.repeat(64)},{taskBound:true},{credentialRevision:1},{secret:'DO_NOT_FORWARD'}])assert.throws(()=>repositoryRegistryPlan({...p,...patch}),/REGISTRY_REVIEW/);
 const s=await f.cloudCall('status');for(const patch of [{contract:1},{writeAuthorized:true},{entries:[{secret:'BAD'}]},{target:{...s.target,secret:'BAD'}}])assert.throws(()=>repositoryRegistryStatus({...s,...patch}),/REGISTRY_REVIEW/);
 f.setMutator(r=>({...r,value:{...r.value,taskBound:true}}));await assert.rejects(f.client.preview(input),/REGISTRY_REVIEW/);assert.equal(f.credentials.writes(),0);
});
test('barrier keeps existing registration and credentials unchanged',async()=>{
 const f=fixture(),p=await f.cloudCall('preview',input),s=await f.cloudCall('apply',confirm(p));const r=await f.cloudCall('fence',{operation:randomUUID(),expectedRevision:s.revision,confirm:true});assert.deepEqual(r.entries,s.entries);assert.equal(r.revision,2);assert.equal(f.cloudCredentials.records.size,1);await assert.rejects(f.cloudCall('fence',{operation:randomUUID(),expectedRevision:1,confirm:true}),/REGISTRY_CONFLICT/);
});
test('public facade route uses explicit refresh and deny arbitrary calls',async()=>{const f=fixture(),s=createOnboardingService({}, {},{credentials:f.credentials,home:'/isolated/mac',env:{}});assert.equal((await s.call('cloud_repository_registry_status',{refresh:false})).operation.state,'not_started');await assert.rejects(s.call('cloud_repository_registry_delete',{}),/METHOD_DENIED/);});
test('registry UI reuses approved components and manual requests; changing inputs invalidates confirmation',async()=>{
 const s=await fs.readFile(new URL('../ui-source/onboarding/registry.jsx',import.meta.url),'utf8');assert(s.includes('<Panel className="connection-panel"'));assert(s.includes('className="connection-confirm"'));assert(s.includes('current.current===started'));assert(!/setInterval|setTimeout|<style/.test(s));assert(s.includes('refresh:false'));assert(s.includes('refresh:true'));assert(s.includes('disabled={busy||!confirm}'));assert(s.includes('setPlan(null);setConfirm(false)'));assert(s.includes('不授权任务或 Git 写入'));
});
