import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createExistingSetup,existingRepositorySnapshot} from '../bundle/onboarding-existing-setup.js';
const choices={query:'ds flash',clarification:'',im:false,repoUrl:null};
function fixture(){
 const records=new Map();let now=1000,writes=0;const calls=[];
 const host=role=>({host:{role,instance_id:randomUUID(),plugin_version:'0.32.0-alpha.10'},paths:{dsh:'/isolated/'+role+'/dsh',agents:'/isolated/'+role+'/agents',source:'target_host_resolution',loadingVerified:false},rules:{state:'inspected',files:20,activationVerified:false},models:{state:'listed',models:2,catalogFingerprint:'a'.repeat(64)},im:{state:'listed',botsConfigured:1}});
 const pair={local:host('local'),cloud:host('cloud')},notification={enabled:true,revision:2,operation:randomUUID(),target:{host:'local',label:'Test private target'}};
 const repo={provider:'gitee',repository_id:42,url:'https://gitee.com/example/task-results',branch:'main',base_sha:'b'.repeat(40),private:true};
 const resolved={status:'resolved',host:'cloud',catalog_fingerprint:'a'.repeat(64),model_policy:{provider:'official-example',model:'test-flash',reasoningEffort:'high'}};
 const g={instanceId:pair.local.host.instance_id,c:{role:'local'},closed:false,link:{async call(m,a){calls.push([m,a]);return {result:m==='model_resolve'?structuredClone(resolved):m==='notification_default_status'?structuredClone(notification):m==='onboarding_existing_repository'?structuredClone(repo):null,observation:{authority:'cloud',freshness:'live_response',instance_id:pair.cloud.host.instance_id}};}}};
 const credentials={async readRecord(k){return structuredClone(records.get(k));},async modifyRecord(k,fn){const n=fn(structuredClone(records.get(k)));if(n!==undefined){records.set(k,structuredClone(n));writes++;}}};
 const options={gateway:()=>g,inspection:{available:()=>true,inspectPair:async()=>structuredClone(pair)},state:{available:()=>true},credentials:()=>credentials,notifications:{status:async()=>structuredClone(notification)},now:()=>now};
 const service=createExistingSetup(options);
 return {service,options,records,credentials,pair,notification,repo,resolved,g,calls,writes:()=>writes,advance:n=>now+=n,apply:p=>service.apply({id:p.id,fingerprint:p.fingerprint,confirm:true})};
}
test('six-page reuse preview reads actual pair but changes no configuration or records',async()=>{
 const f=fixture(),p=await f.service.preview(choices);assert.equal(f.writes(),0);assert.equal(p.installationOwned,false);assert.equal(p.executionAuthorized,false);assert.equal(p.nativeConfigurationChanged,false);assert.deepEqual(p.writes,['own_configuration_confirmation_record']);assert.equal(p.evidence.model.reasoningEffort,'high');assert.equal(p.evidence.repository,null);assert.equal(p.evidence.notification,null);
});
test('explicit confirmation writes only its new owned key and restart reads historical receipt',async()=>{
 const f=fixture(),p=await f.service.preview(choices);await assert.rejects(f.service.apply({id:p.id,fingerprint:p.fingerprint,confirm:false}),/CONFIRMATION/);const r=await f.apply(p);assert.equal(r.state,'confirmed_history');assert.equal(r.endToEndVerified,false);assert.equal(f.writes(),1);assert.deepEqual([...f.records.keys()],['dsh-task-gateway/onboarding-existing-setup-v1']);
 const next=createExistingSetup(f.options);assert.deepEqual(await next.status({}),r);assert.equal(f.calls.filter(([m])=>!['model_resolve'].includes(m)).length,0);await assert.rejects(f.apply(p),/EXPIRED/);
});
test('chosen IM and Gitee reuse only recheck existing choices, never publish or bind',async()=>{
 const f=fixture(),c={...choices,im:true,repoUrl:f.repo.url},p=await f.service.preview(c);const r=await f.apply(p);assert.equal(r.evidence.notification.target.host,'local');assert.equal(r.evidence.repository.base_sha,f.repo.base_sha);assert(f.calls.every(([m])=>['model_resolve','notification_default_status','onboarding_existing_repository'].includes(m)));assert.equal(f.writes(),1);
});
test('repository resolver projects only fixed Gitee metadata and rejects arbitrary origins',()=>{
 const f=fixture();assert.equal(existingRepositorySnapshot({...f.repo,token:'never-export'},f.repo.url).token,undefined);for(const url of ['https://other.example/a/b','https://gitee.com/a/b?token=abc','http://127.0.0.1/'])assert.throws(()=>existingRepositorySnapshot(f.repo,url));
});
test('optional skip keeps existing notifications and task repository untouched',async()=>{
 const f=fixture();await f.apply(await f.service.preview(choices));assert.equal(f.notification.enabled,true);assert(!f.calls.some(([m])=>/notification|repository/.test(m)));
});
test('secrets, unknown flags, empty inputs and implicit confirmation are rejected',async()=>{
 for(const c of [{...choices,query:'sk-THIS_IS_A_TEST_SECRET_1234567890'}, {...choices,clarification:'Bearer TEST_SECRET'}, {...choices,repoUrl:'https://u:pw@gitee.com/a/b'},{...choices,execute:true},{...choices,im:'true'},{}]){const f=fixture();await assert.rejects(f.service.preview(c));assert.equal(f.writes(),0);}
});
test('missing rules, incomplete catalogs and model ambiguity cannot confirm setup',async()=>{
 for(const mutate of [f=>f.pair.cloud.rules.state='needs_review',f=>f.pair.local.rules.files=0,f=>f.pair.cloud.models.state='catalog_incomplete',f=>f.resolved.status='ambiguous',f=>f.resolved.model_policy.reasoningEffort='low']){const f=fixture();mutate(f);await assert.rejects(f.service.preview(choices),/RULES_REQUIRED|MODEL_REQUIRED/);assert.equal(f.writes(),0);}
});
test('enabled IM requires a matching cloud ledger, not a local cached publication state',async()=>{
 const f=fixture();f.options.notifications.status=async()=>({...f.notification,revision:999,publication:{state:'active'}});await assert.rejects(f.service.preview({...choices,im:true}),/NOTIFICATION_REQUIRED/);assert.equal(f.writes(),0);
});
test('model, repository, notification and Host drift invalidate an already shown plan',async()=>{
 for(const change of [f=>f.resolved.model_policy.model='other-model',f=>f.repo.base_sha='c'.repeat(40),f=>f.notification.revision++,f=>f.pair.cloud.host.instance_id=randomUUID()]){const f=fixture(),p=await f.service.preview({...choices,im:true,repoUrl:f.repo.url});change(f);await assert.rejects(f.apply(p),/CONFIGURATION_CHANGED/);assert.equal(f.writes(),0);}
});
test('offline recheck stops before write, and expired/backwards-clock plans cannot execute',async()=>{
 for(const delta of [300001,-1]){const f=fixture(),p=await f.service.preview(choices);f.advance(delta);await assert.rejects(f.apply(p),/EXPIRED/);assert.equal(f.writes(),0);}
 const f=fixture(),p=await f.service.preview(choices);f.g.link.call=async()=>{throw Error('offline');};await assert.rejects(f.apply(p),/RECHECK_FAILED/);assert.equal(f.writes(),0);
});
test('two concurrent guide services cannot overwrite the first confirmed revision',async()=>{
 const f=fixture(),second=createExistingSetup(f.options),a=await f.service.preview(choices),b=await second.preview(choices);await f.apply(a);await assert.rejects(second.apply({id:b.id,fingerprint:b.fingerprint,confirm:true}),/WRITE_UNKNOWN/);assert.equal(f.writes(),1);assert.equal((await second.status({})).operation,a.id);
});
test('unknown save reconciles the original operation without replay',async()=>{
 const f=fixture(),p=await f.service.preview(choices),save=f.credentials.modifyRecord;f.credentials.modifyRecord=async(...a)=>{await save(...a);throw Error('lost response');};await assert.rejects(f.apply(p),/WRITE_UNKNOWN/);assert.equal((await f.service.status({})).operation,p.id);await assert.rejects(f.apply(p),/EXPIRED/);assert.equal(f.writes(),1);
});
test('explicit barrier closes an unconfirmed write and rejects its late callback',async()=>{
 const f=fixture(),p=await f.service.preview(choices),save=f.credentials.modifyRecord;let delayed;
 f.credentials.modifyRecord=async(k,fn)=>{delayed=()=>save(k,fn);throw Error('unknown');};await assert.rejects(f.apply(p),/WRITE_UNKNOWN/);f.credentials.modifyRecord=save;
 const a={expectedRevision:0,operation:randomUUID(),confirm:true},r=await f.service.fence(a);assert.equal(r.state,'not_confirmed');assert.equal(r.revision,1);await assert.rejects(delayed(),/REVISION_CONFLICT/);assert.equal(f.writes(),1);assert.deepEqual(await f.service.fence(a),r);
});
test('barrier cannot erase a confirmed operation that raced with an old status',async()=>{
 const f=fixture();await f.apply(await f.service.preview(choices));await assert.rejects(f.service.fence({expectedRevision:0,operation:randomUUID(),confirm:true}),/REVISION_CONFLICT/);assert.equal(f.writes(),1);
});
test('foreign credential key contents and malformed stored evidence are never overwritten',async()=>{
 const f=fixture();f.records.set('dsh-task-gateway/onboarding-existing-setup-v1',{kind:'api-key',key:'not-ours'});await assert.rejects(f.service.preview(choices),/RECORD_REVIEW/);assert.equal(f.writes(),0);
});
test('disposal prevents late confirmation write and model choice does not become a worker default',async()=>{
 const f=fixture(),p=await f.service.preview(choices);f.service.dispose();await assert.rejects(f.apply(p),/EXPIRED|UNAVAILABLE/);assert.equal(f.writes(),0);assert.deepEqual(f.g.c,{role:'local'});
});
