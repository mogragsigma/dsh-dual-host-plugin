import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID,createHmac} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const {parseCredentialKey}=await import(pathToFileURL(createRequire(new URL('../bundle/package.json',import.meta.url)).resolve('@deepseek-ai/dsh-credentials')));
import {retirementProgram} from '../bundle/onboarding-cloud-retirement.js';
import {createCloudOperations} from '../bundle/onboarding-cloud-operation.js';
import {cloudPackage} from '../bundle/onboarding-cloud-package.js';
import {remoteControl} from '../bundle/onboarding-remote-control.js';
import {runProcess,digest,shellQuote} from '../bundle/onboarding-ssh.js';
const KEY='dsh-task-gateway/onboarding-cloud-operation-v1';
async function waitFor(check){const end=Date.now()+5000;while(!check()){assert(Date.now()<end,'expected original operation did not start');await new Promise(r=>setTimeout(r,2));}}
async function fixture(t,cleanup=1,handoff=false,token=false,web=false,repository=false,peer=false,files=false,migration=false,queue=false,stop=false,restartConsent=true,hostStop=false){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'s55-operation-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const source=root+'/source';await fs.mkdir(source);await fs.writeFile(source+'/package.json',JSON.stringify({name:'@mogragsigma/dsh-dual-host-plugin',version:'0.0.1',files:['*.js','compatibility.json']}));await fs.writeFile(source+'/compatibility.json',JSON.stringify({version:'0.0.1',hostBaseline:'0.2.1-rc.2',onboardingHostRestart:1,...(restartConsent?{onboardingHostRestartConsent:1}:{}),onboardingRuntimeCleanup:cleanup}));await fs.copyFile(new URL('../bundle/onboarding-remote-control.js',import.meta.url),source+'/onboarding-remote-control.js');
 await fs.copyFile(new URL('../bundle/onboarding-runtime-extension.js',import.meta.url),source+'/onboarding-runtime-extension.js');
 if(stop){const c=JSON.parse(await fs.readFile(source+'/compatibility.json'));await fs.writeFile(source+'/compatibility.json',JSON.stringify({...c,onboardingRuntimeStopPlan:1,...(hostStop?{onboardingHostStopConsent:1}:{})}));await fs.copyFile(new URL('../bundle/onboarding-runtime-stop.js',import.meta.url),source+'/onboarding-runtime-stop.js');}
 if(handoff){await fs.writeFile(source+'/compatibility.json',JSON.stringify({version:'0.0.1',hostBaseline:'0.2.1-rc.2',onboardingCloudHandoff:2,onboardingCloudModels:1,...(token?{onboardingCloudTokenPlan:1}:{}),...(web?{onboardingCloudWeb:1}:{}),...(repository?{onboardingCloudRepository:1}:{}),...(peer?{onboardingPeerBinding:1}:{}),...(files?{onboardingCloudFiles:1}:{}),...(migration?{onboardingCloudFileMigration:1}:{}),...(queue?{onboardingCloudFileQueueReview:1}:{})}));await fs.copyFile(new URL('../bundle/onboarding-handoff-remote.js',import.meta.url),source+'/onboarding-handoff-remote.js');}
 const b={installationId:randomUUID(),revision:1},parent=root+'/remote',records=new Map();let clock=1000,enabled=true,calls=0,lose=false,drop=false,loseRetire=false;
 const credentials={readRecord:async k=>structuredClone(records.get(k)),modifyRecord:async(k,fn)=>{parseCredentialKey(k);const r=fn(structuredClone(records.get(k)));if(r!==undefined){if(r.kind==='grant')assert.deepEqual(r.payload,JSON.parse(JSON.stringify(r.payload)),'Official credential grants require lossless JSON values');records.set(k,structuredClone(r));}else records.delete(k);}};
 const inspect=async()=>{const r=JSON.parse(await runProcess(process.execPath,[fileURLToPath(new URL('../bundle/onboarding-remote-probe.js',import.meta.url))],{input:JSON.stringify({installationId:b.installationId,parent}),env:{PATH:process.env.PATH}}));return {...r,state:'observed'};};
 const pkg=await cloudPackage(source),p={id:randomUUID(),expiresAt:100000,canStage:true,conflicts:[],bindingFingerprint:digest(b),snapshot:await inspect(),sourceManifestHash:pkg.manifestHash};p.fingerprint=digest(p);
 const controlText=await fs.readFile(source+'/onboarding-remote-control.js','utf8');
 await fs.writeFile(root+'/retire.mjs',retirementProgram(controlText));const {remoteRetirement}=await import('file://'+root+'/retire.mjs');
 const options={credentials:()=>credentials,readBinding:async()=>structuredClone(b),readPlan:async()=>structuredClone(p),inspect,source,localState:root+'/local',now:()=>clock,enabled:()=>enabled,ssh:{execute:async(binding,command,input)=>{calls++;const q=JSON.parse(input),retire=['retire','retirement_status'].includes(q.action);assert.equal(command,shellQuote(p.snapshot.node.path)+' --input-type=module -e '+shellQuote(retire?retirementProgram(controlText)+'\nawait retirementCLI();':controlText+'\nawait remoteControlCLI();'));if(drop&&q.action==='prepare'){drop=false;throw Error('ONBOARDING_SSH_TIMEOUT');}let result;try{result=await (retire?remoteRetirement(q):remoteControl(q));}catch(e){return JSON.stringify({ok:false,error:e.message});}if(lose||loseRetire&&q.action==='retire'){lose=false;loseRetire=false;throw Error('ONBOARDING_SSH_TIMEOUT');}return JSON.stringify({ok:true,value:result});}}};
 const service=createCloudOperations(options),confirm={id:p.id,fingerprint:p.fingerprint,confirm:true};
 return {root,source,b,p,records,options,service,confirm,get calls(){return calls;},setEnabled:v=>enabled=v,setClock:v=>clock=v,lose:()=>lose=true,drop:()=>drop=true,loseRetire:()=>loseRetire=true};
}
test('disabled stage requires explicit operator opt-in',async t=>{const f=await fixture(t);f.setEnabled(false);await assert.rejects(f.service.stage(f.confirm),/PREPARATION_DISABLED/);assert.equal(f.calls,0);assert.equal(f.records.size,0);});
test('confirmation and source hash required before remote writes',async t=>{const f=await fixture(t);await assert.rejects(f.service.stage({...f.confirm,confirm:false}),/CONFIRMATION_REQUIRED/);await fs.writeFile(f.source+'/added.js','export const changed=1');await assert.rejects(f.service.stage(f.confirm),/SOURCE_CHANGED/);assert.equal(f.calls,0);assert.equal(f.records.size,0);});
test('expired plan does not authorize preparation',async t=>{const f=await fixture(t);f.setClock(100001);await assert.rejects(f.service.stage(f.confirm),/PLAN_EXPIRED/);assert.equal(f.calls,0);});
test('remote baseline drift is not silently accepted',async t=>{const f=await fixture(t);await fs.mkdir(f.root+'/remote');await assert.rejects(f.service.stage(f.confirm),/BASELINE_DRIFT/);assert.equal(f.calls,0);});
test('real journal and source packet, no proof in public receipt',async t=>{const f=await fixture(t),r=await f.service.stage(f.confirm),stored=f.records.get(KEY).payload;assert.equal(r.state,'prepared');assert.equal(r.remote.state,'prepared');assert(!JSON.stringify(r).includes(stored.proof));assert(!r.initialization&&!r.hostStarted);assert(await fs.stat(stored.root+'/plugin/onboarding-remote-control.js'));});
test('duplicate confirmation returns same receipt without repeating SSH, even after expiry',async t=>{const f=await fixture(t),r=await f.service.stage(f.confirm);f.setClock(100001);assert.deepEqual(await f.service.stage(f.confirm),r);assert.equal(f.calls,1);});
test('transport result lost is review, then original receipt is reconciled without duplicate prepare',async t=>{const f=await fixture(t);f.lose();let r=await f.service.stage(f.confirm);assert.equal(r.state,'needs_review');assert.equal(f.calls,1);r=await f.service.status({refresh:true});assert.equal(r.state,'prepared');assert.equal(f.calls,2);assert.equal(f.records.get(KEY).payload.id,r.operationId);});
test('restart reads persistent operation and archived program, independent of current source changes',async t=>{const f=await fixture(t),r=await f.service.stage(f.confirm);await fs.writeFile(f.source+'/onboarding-remote-control.js','BROKEN NEW CANDIDATE');const next=createCloudOperations(f.options),state=await next.status({refresh:true});assert.equal(state.operationId,r.operationId);assert.equal(state.state,'prepared');assert.equal((await next.rollback({operationId:state.operationId,expectedRevision:state.revision,confirm:true})).state,'rolled_back');});
test('rollback requires current revision and explicit confirmation',async t=>{const f=await fixture(t),r=await f.service.stage(f.confirm);await assert.rejects(f.service.rollback({operationId:r.operationId,expectedRevision:r.revision,confirm:false}),/CONFIRMATION_REQUIRED/);await assert.rejects(f.service.rollback({operationId:r.operationId,expectedRevision:0,confirm:true}),/OPERATION_CONFLICT/);const result=await f.service.rollback({operationId:r.operationId,expectedRevision:r.revision,confirm:true});assert.equal(result.state,'rolled_back');assert.equal(await f.service.hasUnfinished(),false);assert.equal((await f.service.status({refresh:true})).state,'rolled_back');});
test('edited cloud file is preserved by attempted rollback',async t=>{const f=await fixture(t),r=await f.service.stage(f.confirm);await fs.writeFile(r.root+'/my-data','KEEP');const result=await f.service.rollback({operationId:r.operationId,expectedRevision:r.revision,confirm:true});assert.equal(result.state,'needs_review');assert.equal(await fs.readFile(r.root+'/my-data','utf8'),'KEEP');assert(await f.service.hasUnfinished());});
test('archive alteration blocks all further remote calls',async t=>{const f=await fixture(t),r=await f.service.stage(f.confirm);await fs.appendFile(f.root+'/local/cloud/'+r.operationId+'/package.json','CHANGED');const result=await f.service.status({refresh:true});assert.equal(result.state,'needs_review');assert.match(result.error,/ARCHIVE_REVIEW/);assert.equal(f.calls,1);});
test('credential record collision is preserved',async t=>{const f=await fixture(t);f.records.set(KEY,{kind:'api-key',key:'USER_KEEP'});await assert.rejects(f.service.stage(f.confirm),/OPERATION_REVIEW/);assert.equal(f.records.get(KEY).key,'USER_KEEP');assert.equal(f.calls,0);});

test('unknown absent preparation is explicitly fenced, never called rolled back or terminated',async t=>{const f=await fixture(t);f.drop();let r=await f.service.stage(f.confirm);assert.equal(r.state,'needs_review');r=await f.service.status({refresh:true});assert.equal(r.state,'needs_review');await assert.rejects(f.service.retire({operationId:r.operationId,expectedRevision:r.revision,confirm:false}),/CONFIRMATION_REQUIRED/);r=await f.service.retire({operationId:r.operationId,expectedRevision:r.revision,confirm:true});assert.equal(r.state,'retired');assert(r.remote.originalRequestIsolated);assert(!r.remote.originalProcessTerminated);assert.equal(await f.service.hasUnfinished(),false);await assert.rejects(f.service.rollback({operationId:r.operationId,expectedRevision:r.revision,confirm:true}),/FENCE_RETAINED/);});
test('lost fence response reconciles after Host restart without deleting or resending prepare',async t=>{const f=await fixture(t);f.drop();let r=await f.service.stage(f.confirm);f.loseRetire();r=await f.service.retire({operationId:r.operationId,expectedRevision:r.revision,confirm:true});assert.equal(r.state,'retiring');r=await createCloudOperations(f.options).status({refresh:true});assert.equal(r.state,'retired');assert((await fs.lstat(r.root)).isFile());});
test('source arrived before retirement is still recoverable by original controller',async t=>{const f=await fixture(t);f.lose();let r=await f.service.stage(f.confirm);r=await f.service.retire({operationId:r.operationId,expectedRevision:r.revision,confirm:true});assert.equal(r.state,'needs_review');r=await f.service.status({refresh:true});assert.equal(r.state,'prepared');assert.equal((await f.service.rollback({operationId:r.operationId,expectedRevision:r.revision,confirm:true})).state,'rolled_back');});
test('retired transaction requires a different target and preserves credential history',async t=>{const f=await fixture(t);f.drop();let r=await f.service.stage(f.confirm);r=await f.service.retire({operationId:r.operationId,expectedRevision:r.revision,confirm:true});await f.service.archiveTerminal();const oldRoot=r.root,oldId=r.operationId;assert(f.records.has(KEY+'-'+oldId));f.b.installationId=randomUUID();f.b.revision++;delete f.p.fingerprint;Object.assign(f.p,{id:randomUUID(),snapshot:await f.options.inspect(),bindingFingerprint:digest(f.b)});f.p.fingerprint=digest(f.p);r=await f.service.stage({id:f.p.id,fingerprint:f.p.fingerprint,confirm:true});assert.equal(r.state,'prepared');assert.notEqual(r.root,oldRoot);assert((await fs.lstat(oldRoot)).isFile());assert.equal(f.records.get(KEY+'-'+oldId).payload.operation.phase,'retired');assert.equal((await f.service.rollback({operationId:r.operationId,expectedRevision:r.revision,confirm:true})).state,'rolled_back');assert((await fs.lstat(oldRoot)).isFile());});

test('retired root cannot be reused even under a newly confirmed plan',async t=>{const f=await fixture(t);f.drop();let r=await f.service.stage(f.confirm);r=await f.service.retire({operationId:r.operationId,expectedRevision:r.revision,confirm:true});delete f.p.fingerprint;f.p.id=randomUUID();f.p.fingerprint=digest(f.p);const calls=f.calls;await assert.rejects(f.service.stage({id:f.p.id,fingerprint:f.p.fingerprint,confirm:true}),/REPLACEMENT_REQUIRED/);assert.equal(f.calls,calls);assert((await fs.lstat(r.root)).isFile());});
test('terminal history collision is not overwritten',async t=>{const f=await fixture(t);f.drop();let r=await f.service.stage(f.confirm);r=await f.service.retire({operationId:r.operationId,expectedRevision:r.revision,confirm:true});f.records.set(KEY+'-'+r.operationId,{kind:'api-key',key:'USER_KEEP'});await assert.rejects(f.service.archiveTerminal(),/HISTORY_REVIEW/);assert.equal(f.records.get(KEY+'-'+r.operationId).key,'USER_KEEP');});

test('runtime installer is disabled independently of source preparation',async t=>{const f=await fixture(t),p=await f.service.stage(f.confirm);await assert.rejects(f.service.runtimeAction({action:'runtime_preview',operationId:p.operationId}),/RUNTIME_DISABLED/);});
test('runtime start requires explicit confirmation and exact arguments',async t=>{const f=await fixture(t);f.options.runtimeEnabled=()=>true;const p=await f.service.stage(f.confirm),s=createCloudOperations(f.options);await assert.rejects(s.runtimeAction({action:'runtime_start',operationId:p.operationId,fingerprint:digest('plan'),confirm:false}),/CONFIRMATION_REQUIRED/);await assert.rejects(s.runtimeAction({action:'runtime_preview',operationId:p.operationId,command:'user-command'}),/CONFIRMATION_REQUIRED/);});
test('runtime start intent precedes SSH and is not replayed after lost response or Host restart',async t=>{const f=await fixture(t);const p=await f.service.stage(f.confirm);f.options.runtimeEnabled=()=>true;let starts=0;const key='dsh-task-gateway/onboarding-runtime-v1-'+p.operationId;f.options.ssh.execute=async(b,command,input)=>{const q=JSON.parse(input);assert.equal(f.records.get(key)?.payload.state,'start_requested');assert(!command.includes(q.proof));if(q.action==='runtime_start'){starts++;throw Error('ONBOARDING_SSH_TIMEOUT');}return JSON.stringify({ok:true,value:{operationId:p.operationId,state:'runtime_ready',initialization:false,hostStarted:false,runtimeInstalled:true}});};let s=createCloudOperations(f.options);const args={action:'runtime_start',operationId:p.operationId,fingerprint:digest('plan'),confirm:true};await assert.rejects(s.runtimeAction(args),/SSH_TIMEOUT/);s=createCloudOperations(f.options);assert((await s.runtimeAction(args)).notResent);assert.equal(starts,1);assert.equal((await s.runtimeAction({action:'runtime_status',operationId:p.operationId})).state,'runtime_ready');assert.equal(starts,1);});
test('runtime credential collision is preserved, not adopted',async t=>{const f=await fixture(t),p=await f.service.stage(f.confirm);f.options.runtimeEnabled=()=>true;f.records.set('dsh-task-gateway/onboarding-runtime-v1-'+p.operationId,{kind:'api-key',key:'KEEP'});await assert.rejects(createCloudOperations(f.options).runtimeAction({action:'runtime_status',operationId:p.operationId}),/RUNTIME_RECORD_REVIEW/);});
test('runtime stop cannot invent an unrecorded transaction',async t=>{const f=await fixture(t),p=await f.service.stage(f.confirm);f.options.runtimeEnabled=()=>true;await assert.rejects(createCloudOperations(f.options).runtimeAction({action:'runtime_stop',operationId:p.operationId,confirm:true,stopPlan:{}}),/RUNTIME_RECORD_REVIEW/);});
test('known active-process refusal does not poison rollback intent or hide the live Host',async t=>{const f=await fixture(t),p=await f.service.stage(f.confirm);f.options.runtimeEnabled=()=>true;const key='dsh-task-gateway/onboarding-runtime-v1-'+p.operationId,prior={state:'host_ready',operationId:p.operationId,initialization:false,hostStarted:true,hostActive:true,nativeHostReady:true};f.records.set(key,{kind:'grant',payload:{owner:'dsh-dual-host-onboarding',schema:1,operationId:p.operationId,fingerprint:digest('plan'),state:'observed',remote:prior}});f.options.ssh.execute=async(b,c,input)=>JSON.stringify(JSON.parse(input).action==='runtime_rollback'?{ok:false,error:'ONBOARDING_CLOUD_RUNTIME_PROCESS_ACTIVE'}:{ok:true,value:prior});const s=createCloudOperations(f.options);await assert.rejects(s.runtimeAction({action:'runtime_rollback',operationId:p.operationId,confirm:true}),/RUNTIME_PROCESS_ACTIVE/);assert.equal(f.records.get(key).payload.state,'observed');assert.equal(f.records.get(key).payload.rollbackPrior,undefined);assert.deepEqual(await s.runtimeAction({action:'runtime_status',operationId:p.operationId}),prior);const duplicate=await s.runtimeAction({action:'runtime_start',operationId:p.operationId,fingerprint:digest('plan'),confirm:true});assert(duplicate.notResent&&duplicate.hostStarted);});
test('rollback intent survives lost receipt and is reconciled read-only, without a second delete',async t=>{const f=await fixture(t);const p=await f.service.stage(f.confirm);f.options.runtimeEnabled=()=>true;const key='dsh-task-gateway/onboarding-runtime-v1-'+p.operationId,id=randomUUID(),prior={state:'runtime_ready',runtimeId:id,operationId:p.operationId,inventoryCount:2,workerActive:false,childActive:false,worker:{pid:123},child:{pid:124},initialization:false,hostStarted:false};f.records.set(key,{kind:'grant',payload:{owner:'dsh-dual-host-onboarding',schema:1,operationId:p.operationId,fingerprint:digest('plan'),state:'observed',remote:prior}});let deletes=0,checks=0;f.options.ssh.execute=async(b,command,input,options)=>{const q=JSON.parse(input);if(q.action==='runtime_rollback'){assert.equal(f.records.get(key).payload.state,'rollback_requested');assert.deepEqual(f.records.get(key).payload.rollbackPrior,prior);assert.equal(options.timeoutMs,120000);deletes++;throw Error('ONBOARDING_SSH_TIMEOUT');}if(q.action==='runtime_status')return JSON.stringify({ok:true,value:{state:'not_started',operationId:p.operationId,initialization:false,hostStarted:false}});assert(command.includes(').runtimeAbsenceCLI()'));assert.deepEqual(q.prior,prior);checks++;return JSON.stringify({ok:true,value:{state:'rolled_back',operationId:p.operationId,runtimeId:id,installerProcessesEnded:true,initialization:false,hostStarted:false}});};let s=createCloudOperations(f.options);await assert.rejects(s.runtimeAction({action:'runtime_rollback',operationId:p.operationId,confirm:true}),/SSH_TIMEOUT/);s=createCloudOperations(f.options);assert.equal((await s.runtimeAction({action:'runtime_status',operationId:p.operationId})).state,'rolled_back');assert.equal((await s.runtimeAction({action:'runtime_status',operationId:p.operationId})).state,'rolled_back');assert.equal(deletes,1);assert.equal(checks,2);});
test('legacy lost rollback receipt can be explicitly reconciled without sending delete',async t=>{const f=await fixture(t),p=await f.service.stage(f.confirm);f.options.runtimeEnabled=()=>true;const id=randomUUID(),key='dsh-task-gateway/onboarding-runtime-v1-'+p.operationId;f.records.set(key,{kind:'grant',payload:{owner:'dsh-dual-host-onboarding',schema:1,operationId:p.operationId,fingerprint:digest('plan'),state:'observed',remote:{state:'runtime_ready',operationId:p.operationId,runtimeId:id}}});f.options.ssh.execute=async(b,command,input)=>{assert(command.includes(').runtimeAbsenceCLI()'));assert(!JSON.parse(input).action);return JSON.stringify({ok:true,value:{state:'rolled_back',operationId:p.operationId,runtimeId:id,installerProcessesEnded:true,initialization:false,hostStarted:false}});};assert.equal((await createCloudOperations(f.options).runtimeAction({action:'runtime_reconcile_rollback',operationId:p.operationId,confirm:true})).state,'rolled_back');});
test('incomplete rollback keeps its intent and cannot advertise a ready runtime',async t=>{const f=await fixture(t),p=await f.service.stage(f.confirm);f.options.runtimeEnabled=()=>true;const key='dsh-task-gateway/onboarding-runtime-v1-'+p.operationId;f.records.set(key,{kind:'grant',payload:{owner:'dsh-dual-host-onboarding',schema:1,operationId:p.operationId,fingerprint:digest('plan'),state:'rollback_requested',remote:null,rollbackPrior:{state:'runtime_ready'}}});f.options.ssh.execute=async()=>JSON.stringify({ok:true,value:{state:'runtime_ready',operationId:p.operationId,runtimeInstalled:true,initialization:false,hostStarted:false}});const r=await createCloudOperations(f.options).runtimeAction({action:'runtime_status',operationId:p.operationId});assert.equal(r.state,'rollback_outcome_unknown');assert(!r.runtimeInstalled);assert.equal(f.records.get(key).payload.state,'rollback_requested');});
test('source rollback waits for runtime-removal receipt and preserves source state',async t=>{const f=await fixture(t),p=await f.service.stage(f.confirm);f.records.set('dsh-task-gateway/onboarding-runtime-v1-'+p.operationId,{kind:'grant',payload:{owner:'dsh-dual-host-onboarding',schema:1,operationId:p.operationId,remote:{state:'runtime_ready'}}});const calls=f.calls;await assert.rejects(f.service.rollback({operationId:p.operationId,expectedRevision:p.revision,confirm:true}),/RUNTIME_REMOVAL_REQUIRED/);assert.equal(f.calls,calls);assert.equal((await f.service.status({refresh:false})).state,'prepared');});

test('runtime cached record reads original local archive only, never SSH or execution',async t=>{const f=await fixture(t),p=await f.service.stage(f.confirm);f.options.runtimeEnabled=()=>true;const service=createCloudOperations(f.options),key='dsh-task-gateway/onboarding-runtime-v1-'+p.operationId;const calls=f.calls;let r=await service.runtimeAction({action:'runtime_record',operationId:p.operationId});assert(!r.recorded&&r.cached&&!r.initialization);const old={owner:'dsh-dual-host-onboarding',schema:1,operationId:p.operationId,fingerprint:digest('plan'),state:'start_requested',remote:null,error:'ONBOARDING_SSH_TIMEOUT',updatedAt:123};f.records.set(key,{kind:'grant',payload:old});r=await service.runtimeAction({action:'runtime_record',operationId:p.operationId});assert(r.recorded&&r.cached);assert.equal(r.requestState,'start_requested');assert.equal(r.receipt,null);assert.equal(r.observedAt,123);assert.deepEqual(f.records.get(key).payload,old);assert.equal(f.calls,calls);});

test('restart intent survives lost response and old status never authorizes a second launch',async t=>{
 const f=await fixture(t),p=await f.service.stage(f.confirm);f.options.runtimeEnabled=()=>true;const key='dsh-task-gateway/onboarding-runtime-v1-'+p.operationId,fp=digest('restart-plan');
 const prior={state:'host_stopped',operationId:p.operationId,hostStarted:false,initialization:false};f.records.set(key,{kind:'grant',payload:{owner:'dsh-dual-host-onboarding',schema:1,operationId:p.operationId,fingerprint:digest('initial-plan'),state:'observed',remote:prior}});
 let starts=0,arrived=false;f.options.ssh.execute=async(b,c,input)=>{const q=JSON.parse(input);if(q.action==='runtime_restart'){starts++;assert.equal(f.records.get(key).payload.state,'restart_requested');throw Error('ONBOARDING_SSH_TIMEOUT');}return JSON.stringify({ok:true,value:{...prior,...(arrived?{state:'restarting',restartFingerprint:fp,restartId:'receipt-id'}:{})}});};
 let s=createCloudOperations(f.options),args={action:'runtime_restart',acknowledgeNativeResume:true,operationId:p.operationId,fingerprint:fp,confirm:true};await assert.rejects(s.runtimeAction(args),/SSH_TIMEOUT/);s=createCloudOperations(f.options);
 assert((await s.runtimeAction(args)).notResent);assert.equal(starts,1);assert.equal((await s.runtimeAction({action:'runtime_status',operationId:p.operationId})).state,'restart_outcome_unknown');assert.equal(f.records.get(key).payload.state,'restart_requested');
 await assert.rejects(s.runtimeAction({...args,fingerprint:digest('different')}),/RESTART_REVIEW/);arrived=true;assert.equal((await s.runtimeAction({action:'runtime_status',operationId:p.operationId})).state,'restarting');assert.equal(f.records.get(key).payload.state,'observed');assert((await s.runtimeAction(args)).notResent);assert.equal(starts,1);
});
test('restart preview never replaces the durable runtime receipt',async t=>{
 const f=await fixture(t),p=await f.service.stage(f.confirm);f.options.runtimeEnabled=()=>true;const key='dsh-task-gateway/onboarding-runtime-v1-'+p.operationId,prior={kind:'grant',payload:{owner:'dsh-dual-host-onboarding',schema:1,operationId:p.operationId,fingerprint:digest('initial'),state:'observed',remote:{state:'host_stopped'}}};f.records.set(key,prior);
 f.options.ssh.execute=async()=>JSON.stringify({ok:true,value:{operationId:p.operationId,fingerprint:digest('preview'),hostStarted:false,initialization:false}});await createCloudOperations(f.options).runtimeAction({action:'runtime_restart_preview',operationId:p.operationId});assert.deepEqual(f.records.get(key),prior);
});
async function pendingCleanup(f){const p=await f.service.stage(f.confirm);f.options.runtimeEnabled=()=>true;const key='dsh-task-gateway/onboarding-runtime-v1-'+p.operationId,fp=digest('cleanup-progress'),remote={state:'cleanup_pending',operationId:p.operationId,cleanupSupported:true,cleanupFingerprint:fp,initialization:false,hostStarted:false};f.records.set(key,{kind:'grant',payload:{owner:'dsh-dual-host-onboarding',schema:1,operationId:p.operationId,fingerprint:digest('install-plan'),state:'rollback_requested',remote,rollbackPrior:{state:'host_stopped'}}});return {p,key,fp,remote};}
test('observed signed cleanup progress is not hidden by the old unknown-rollback state',async t=>{const f=await fixture(t),{p,key,remote}=await pendingCleanup(f);let sent=[];f.options.ssh.execute=async(b,c,input)=>{sent.push(JSON.parse(input).action);return JSON.stringify({ok:true,value:remote});};const s=createCloudOperations(f.options),v=await s.runtimeAction({action:'runtime_status',operationId:p.operationId});assert.equal(v.state,'cleanup_pending');assert.equal(f.records.get(key).payload.state,'rollback_requested');assert.deepEqual(sent,['runtime_status']);});
test('cleanup continuation binds current fingerprint and persists intent before SSH',async t=>{const f=await fixture(t),{p,key,fp}=await pendingCleanup(f);let calls=0;f.options.ssh.execute=async(b,c,input)=>{calls++;const q=JSON.parse(input);assert.equal(q.action,'runtime_rollback_resume');assert.equal(q.fingerprint,fp);assert.equal(f.records.get(key).payload.state,'rollback_requested');return JSON.stringify({ok:true,value:{state:'rolled_back',operationId:p.operationId,initialization:false,hostStarted:false}});};const s=createCloudOperations(f.options),args={action:'runtime_rollback_resume',operationId:p.operationId,fingerprint:fp,confirm:true};await assert.rejects(s.runtimeAction({...args,confirm:false}),/CONFIRMATION/);await assert.rejects(s.runtimeAction({...args,fingerprint:digest('old')}),/CLEANUP_PLAN_DRIFT/);assert.equal(calls,0);assert.equal((await s.runtimeAction(args)).state,'rolled_back');assert.equal(calls,1);assert.equal(f.records.get(key).payload.state,'observed');});
test('legacy archived controllers cannot be replaced to continue cleanup',async t=>{const f=await fixture(t,null),{p,fp}=await pendingCleanup(f);let calls=0;f.options.ssh.execute=async()=>{calls++;throw Error('unexpected');};await assert.rejects(createCloudOperations(f.options).runtimeAction({action:'runtime_rollback_resume',operationId:p.operationId,fingerprint:fp,confirm:true}),/CLEANUP_UNSUPPORTED/);assert.equal(calls,0);});


test('archived handoff bridge exposes fixed readiness categories without retry or secret leakage',async t=>{
 const f=await fixture(t,1,true);await f.service.stage(f.confirm);f.options.runtimeEnabled=()=>true;
 const service=createCloudOperations(f.options),before=structuredClone([...f.records]);let error,calls=0;
 f.options.ssh.execute=async()=>{calls++;return JSON.stringify({ok:false,error});};
 for(error of ['ONBOARDING_CLOUD_HANDOFF_HOST_NOT_READY','ONBOARDING_CLOUD_HANDOFF_TARGET_CHANGED','ONBOARDING_CLOUD_HANDOFF_IDENTITY_REVIEW','ONBOARDING_CLOUD_HANDOFF_RUNTIME_SOURCE_CHANGED','ONBOARDING_CLOUD_HANDOFF_AUTH_FAILED']){
  const n=calls;await assert.rejects(service.hostRequest('receipt',{}),e=>e.message===error);assert.equal(calls,n+1);
 }
 for(error of ['sk-SYNTHETIC_ERROR_DO_NOT_ECHO','ONBOARDING_CLOUD_arbitrary_payload',{},null])await assert.rejects(service.hostRequest('model_status',{}),/CLOUD_HANDOFF_REMOTE_REVIEW/);
 error='ONBOARDING_MODEL_CREDENTIAL_REQUIRED';await assert.rejects(service.hostRequest('model_preview',{enabled:true}),/MODEL_CREDENTIAL_REQUIRED/);
 assert.deepEqual([...f.records],before);
});

test('old archive rejects optional cloud token before SSH and without replacing controller',async t=>{
 const f=await fixture(t,1,true);await f.service.stage(f.confirm);f.options.runtimeEnabled=()=>true;let n=0;f.options.ssh.execute=async()=>{n++;throw Error('MUST_NOT_EXECUTE');};const s=createCloudOperations(f.options);
 for(const action of ['token_inspect','token_receipt','token_put','token_fence','token_model_status','token_model_preview','token_model_apply','token_model_resolve'])await assert.rejects(s.hostRequest(action,{}),/CLOUD_TOKEN_UNSUPPORTED/);
 assert.equal(n,0);
});
test('new token archive forwards only bounded action over stdin and sanitizes model errors',async t=>{
 const f=await fixture(t,1,true,true);await f.service.stage(f.confirm);f.options.runtimeEnabled=()=>true;const s=createCloudOperations(f.options);let n=0;
 f.options.ssh.execute=async(binding,cmd,input)=>{n++;const q=JSON.parse(input);assert.equal(q.handoff.action,'token_model_status');assert(!cmd.includes('SYNTHETIC_KEY_SENTINEL'));return JSON.stringify({ok:false,error:'ONBOARDING_MODEL_CREDENTIAL_REQUIRED'});};
 await assert.rejects(s.hostRequest('token_model_status',{}),/MODEL_CREDENTIAL_REQUIRED/);assert.equal(n,1);
 f.options.ssh.execute=async()=>JSON.stringify({ok:false,error:'SYNTHETIC_KEY_SENTINEL'});await assert.rejects(s.hostRequest('token_model_status',{}),e=>e.message==='ONBOARDING_CLOUD_HANDOFF_REMOTE_REVIEW');
});

test('old archive rejects optional IM before SSH and cannot be upgraded by request parameters',async t=>{
 const f=await fixture(t),p=await f.service.stage(f.confirm);f.options.runtimeEnabled=()=>true;let calls=0;f.options.ssh.execute=async()=>{calls++;throw Error('unexpected');};const s=createCloudOperations(f.options);
 await assert.rejects(s.runtimeAction({action:'runtime_preview',operationId:p.operationId,im:true}),/OPTIONAL_IM_UNSUPPORTED/);assert.equal(calls,0);
 for(const q of [{action:'runtime_preview',im:'true'},{action:'runtime_status',im:true},{action:'runtime_start',im:true,fingerprint:digest('x'),confirm:false}])await assert.rejects(s.runtimeAction({operationId:p.operationId,...q}),/CONFIRMATION_REQUIRED/);assert.equal(calls,0);
});

test('cloud Web rejects an old archive before SSH, regardless of the current candidate',async t=>{
 const f=await fixture(t,1,true);await f.service.stage(f.confirm);f.options.runtimeEnabled=()=>true;let calls=0;
 f.options.ssh.execute=async()=>{calls++;throw Error('MUST_NOT_EXECUTE');};
 await assert.rejects(createCloudOperations(f.options).hostRequest('web_access',{}),/CLOUD_WEB_UNSUPPORTED/);assert.equal(calls,0);
});
test('cloud Web only forwards the original verified target and leaves ledgers unchanged',async t=>{
 const f=await fixture(t,1,true,false,true);await f.service.stage(f.confirm);f.options.runtimeEnabled=()=>true;
 const p=f.records.get(KEY).payload,recordBefore=structuredClone([...f.records]);let forwards=0,changed={};
 const a={target:{operationId:p.id,installationId:p.installationId,runtimeId:randomUUID(),manifestHash:p.manifestHash,root:p.root,role:'cloud',hostVersion:'0.2.1-rc.2'},value:{port:12345,token:'SYNTHETIC_NATIVE_TOKEN',nativeNonce:randomUUID()}};
 f.options.ssh.execute=async(b,cmd,input)=>{assert.deepEqual(b,f.b);const q=JSON.parse(input);assert.deepEqual(q.handoff,{action:'web_access'});assert(!cmd.includes(a.value.token));return JSON.stringify({ok:true,value:{...a,target:{...a.target,...changed}}});};
 const transport={port:23456};f.options.ssh.forward=async(b,port)=>{assert.deepEqual(b,f.b);assert.equal(port,12345);forwards++;return transport;};const s=createCloudOperations(f.options);
 for(changed of [{operationId:randomUUID()},{installationId:randomUUID()},{manifestHash:'b'.repeat(64)},{root:'/wrong-instance'}])await assert.rejects(s.hostRequest('web_access',{}),/CLOUD_WEB_TARGET_REVIEW/);
 assert.equal(forwards,0);changed={};const result=await s.hostRequest('web_access',{});assert.equal(result.tunnel,transport);assert.equal(forwards,1);assert.deepEqual([...f.records],recordBefore);
});


test('old archive rejects all Gitee actions before SSH; no bridge substitution',async t=>{
 const f=await fixture(t,1,true);await f.service.stage(f.confirm);f.options.runtimeEnabled=()=>true;let n=0;f.options.ssh.execute=async()=>{n++;throw Error('MUST_NOT_EXECUTE');};
 for(const a of ['repository_inspect','gitee_inspect','gitee_receipt','gitee_put','gitee_fence','repository_registry_status','repository_registry_preview','repository_registry_apply','repository_registry_fence'])await assert.rejects(createCloudOperations(f.options).hostRequest(a,{}),/CLOUD_REPOSITORY_UNSUPPORTED/);assert.equal(n,0);
});
test('Gitee archive maps bounded errors and validates original target without changing records',async t=>{
 const f=await fixture(t,1,true,false,false,true);await f.service.stage(f.confirm);f.options.runtimeEnabled=()=>true;const s=createCloudOperations(f.options),p=f.records.get(KEY).payload,before=structuredClone([...f.records]);
 f.options.ssh.execute=async()=>JSON.stringify({ok:false,error:'ONBOARDING_REPOSITORY_ACCESS_DENIED'});await assert.rejects(s.hostRequest('repository_inspect',{}),/REPOSITORY_ACCESS_DENIED/);
 f.options.ssh.execute=async()=>JSON.stringify({ok:true,value:{target:{operationId:p.id,installationId:p.installationId,root:'/wrong',manifestHash:p.manifestHash}}});await assert.rejects(s.hostRequest('repository_inspect',{}),/HANDOFF_TARGET_CHANGED/);assert.deepEqual([...f.records],before);
});


test('bounded peer FIFO respects remote lifecycle lock; controls drain without replay',async t=>{
 const f=await fixture(t,1,true,false,false,false,true);await f.service.stage(f.confirm);f.options.runtimeEnabled=()=>true;
 const service=createCloudOperations(f.options),p=f.records.get(KEY).payload,target={operationId:p.id,installationId:p.installationId,root:p.root,manifestHash:p.manifestHash};let started=0,controls=0;const pending=[];
 f.options.ssh.execute=async(_b,_cmd,input,options)=>{const a=JSON.parse(input).handoff.action;if(a==='task_pair_forward'){assert.equal(options.timeoutMs,30000);started++;await new Promise(resolve=>pending.push(resolve));}else controls++;return JSON.stringify({ok:true,value:{target,value:{ok:true,value:'accepted'}}});};
 const batch=Array.from({length:3},()=>service.hostRequest('task_pair_forward',{}));
 await waitFor(()=>started>=1);assert.equal(started,1);
 await assert.rejects(service.hostRequest('task_pair_forward',{}),/CLOUD_OPERATION_BUSY/);
 const control=service.hostRequest('task_pair_status',{});await new Promise(r=>setImmediate(r));assert.equal(controls,0);
 await assert.rejects(service.hostRequest('task_pair_forward',{}),/CLOUD_OPERATION_BUSY/);
 await assert.rejects(service.hostRequest('task_pair_status',{}),/CLOUD_OPERATION_BUSY/);
 for(let i=0;i<3;i++){await waitFor(()=>pending.length>i);assert.equal(started,i+1);pending[i]();}await Promise.all(batch);await control;assert.equal(controls,1);
 const calls=started;await assert.rejects(service.hostRequest('task_pair_forward',{}, {...target,root:'/other'}),/TARGET_CHANGED/);assert.equal(started,calls);
 await service.hostRequest('task_pair_status',{});assert.equal(controls,2);
});
test('failed peer frame releases draining control and does not resend either operation',async t=>{
 const f=await fixture(t,1,true,false,false,false,true);await f.service.stage(f.confirm);f.options.runtimeEnabled=()=>true;const s=createCloudOperations(f.options);let release,started=false,controls=0;
 f.options.ssh.execute=async(_b,_cmd,input)=>{if(JSON.parse(input).handoff.action==='task_pair_forward'){started=true;await new Promise(r=>release=r);throw Error('ONBOARDING_SSH_TIMEOUT');}controls++;return JSON.stringify({ok:false,error:'ONBOARDING_CLOUD_HANDOFF_HOST_NOT_READY'});};
 const send=s.hostRequest('task_pair_forward',{}),failed=assert.rejects(send,/SSH_TIMEOUT/);await waitFor(()=>started);
 const control=assert.rejects(s.hostRequest('task_pair_status',{}),/HOST_NOT_READY/);release();await failed;await control;assert.equal(controls,1);
});

test('legacy archive cannot silently discard ordinary model clarification',async t=>{
 const f=await fixture(t,1,true,true);await f.service.stage(f.confirm);f.options.runtimeEnabled=()=>true;let n=0;f.options.ssh.execute=async()=>{n++;throw Error('unexpected');};const service=createCloudOperations(f.options);
 for(const prefix of ['', 'token_'])for(const action of ['model_resolve','model_probe_preview'])await assert.rejects(service.hostRequest(prefix+action,{query:'ds flash',clarification:'请用 DeepSeek（双端配置）',...(action==='model_probe_preview'?{acknowledgeUnknown:null}:{})}),/CLOUD_MODEL_CLARIFICATION_UNSUPPORTED/);assert.equal(n,0);
});


test('old archived controller refuses all cloud file actions without SSH or archive replacement',async t=>{
 const f=await fixture(t,1,true);await f.service.stage(f.confirm);f.options.runtimeEnabled=()=>true;let n=0;f.options.ssh.execute=async()=>{n++;throw Error('MUST_NOT_EXECUTE');};const service=createCloudOperations(f.options);for(const action of ['file_transfer_status','file_transfer_preview','file_transfer_apply','file_transfer_fence'])await assert.rejects(service.hostRequest(action,{}),/CLOUD_FILES_UNSUPPORTED/);assert.equal(n,0);
});
test('file-capable archive preserves target binding and fixed safe error categories',async t=>{
 const f=await fixture(t,1,true,false,false,false,false,true);await f.service.stage(f.confirm);f.options.runtimeEnabled=()=>true;const service=createCloudOperations(f.options),p=f.records.get(KEY).payload;let calls=0;const target={operationId:p.id,installationId:p.installationId,root:p.root,manifestHash:p.manifestHash,runtimeId:randomUUID(),role:'cloud',hostVersion:'0.2.1-rc.2'};
 f.options.ssh.execute=async(binding,cmd,input)=>{calls++;assert.equal(JSON.parse(input).handoff.action,'file_transfer_status');return JSON.stringify({ok:true,value:{target,value:{state:'fixture-only'}}});};assert.equal((await service.hostRequest('file_transfer_status',{})).value.state,'fixture-only');assert.equal(calls,1);
 f.options.ssh.execute=async()=>JSON.stringify({ok:true,value:{target:{...target,root:'/different'},value:{}}});await assert.rejects(service.hostRequest('file_transfer_status',{}),/TARGET_CHANGED/);
 f.options.ssh.execute=async()=>JSON.stringify({ok:false,error:'ONBOARDING_FILES_RUNTIME_REQUIRED'});await assert.rejects(service.hostRequest('file_transfer_status',{}),/FILES_RUNTIME_REQUIRED/);
 f.options.ssh.execute=async()=>JSON.stringify({ok:false,error:'NO_SECRET_ECHO'});await assert.rejects(service.hostRequest('file_transfer_status',{}),e=>e.message==='ONBOARDING_CLOUD_HANDOFF_REMOTE_REVIEW');
});

test('old file-capable archive refuses migration without SSH; new archive preserves target/error category',async t=>{
 const old=await fixture(t,1,true,false,false,false,false,true);await old.service.stage(old.confirm);old.options.runtimeEnabled=()=>true;let calls=0;old.options.ssh.execute=async()=>{calls++;throw Error('NO');};const legacy=createCloudOperations(old.options);for(const method of ['file_transfer_migrationPreview','file_transfer_migrationRecover'])await assert.rejects(legacy.hostRequest(method,{}),/CLOUD_FILES_MIGRATION_UNSUPPORTED/);assert.equal(calls,0);
 const f=await fixture(t,1,true,false,false,false,false,true,true);await f.service.stage(f.confirm);f.options.runtimeEnabled=()=>true;const s=createCloudOperations(f.options),p=f.records.get(KEY).payload,target={operationId:p.id,installationId:p.installationId,root:p.root,manifestHash:p.manifestHash};
 f.options.ssh.execute=async(_b,_cmd,input)=>{assert.equal(JSON.parse(input).handoff.action,'file_transfer_migrationPreview');return JSON.stringify({ok:true,value:{target,value:{kind:'fixture-only'}}});};assert.equal((await s.hostRequest('file_transfer_migrationPreview',{})).value.kind,'fixture-only');f.options.ssh.execute=async()=>JSON.stringify({ok:false,error:'ONBOARDING_CLOUD_HANDOFF_FILES_MIGRATION_UNSUPPORTED'});await assert.rejects(s.hostRequest('file_transfer_migrationPreview',{}),/HANDOFF_FILES_MIGRATION_UNSUPPORTED/);
});
test('queue review requires its own archived-controller capability and propagates safe refusal',async t=>{
 const old=await fixture(t,1,true,false,false,false,false,true,true);await old.service.stage(old.confirm);old.options.runtimeEnabled=()=>true;let calls=0;old.options.ssh.execute=async()=>{calls++;throw Error('NO');};const legacy=createCloudOperations(old.options);for(const method of ['file_transfer_queueList','file_transfer_queueReviewApply','file_transfer_queueReviewClose'])await assert.rejects(legacy.hostRequest(method,{}),/CLOUD_FILES_QUEUE_UNSUPPORTED/);assert.equal(calls,0);
 const f=await fixture(t,1,true,false,false,false,false,true,true,true);await f.service.stage(f.confirm);f.options.runtimeEnabled=()=>true;const s=createCloudOperations(f.options),p=f.records.get(KEY).payload,target={operationId:p.id,installationId:p.installationId,root:p.root,manifestHash:p.manifestHash};f.options.ssh.execute=async(_b,_cmd,input)=>{assert.equal(JSON.parse(input).handoff.action,'file_transfer_queueList');return JSON.stringify({ok:true,value:{target,value:{kind:'fixture-only'}}});};assert.equal((await s.hostRequest('file_transfer_queueList',{})).value.kind,'fixture-only');f.options.ssh.execute=async()=>JSON.stringify({ok:false,error:'ONBOARDING_CLOUD_HANDOFF_FILES_QUEUE_UNSUPPORTED'});await assert.rejects(s.hostRequest('file_transfer_queueList',{}),/HANDOFF_FILES_QUEUE_UNSUPPORTED/);
});

async function stopFixture(t,supported=true,host=false){
 const f=await fixture(t,1,false,false,false,false,false,false,false,false,supported,true,host),p=await f.service.stage(f.confirm);
 f.options.runtimeEnabled=()=>true;
 const key='dsh-task-gateway/onboarding-runtime-v1-'+p.operationId,proof=f.records.get(KEY).payload.proof;
 const prior={state:'installing',operationId:p.operationId,hostStarted:false,initialization:false,workerActive:true,hostActive:false};
 f.records.set(key,{kind:'grant',payload:{owner:'dsh-dual-host-onboarding',schema:1,operationId:p.operationId,fingerprint:digest('initial-install'),state:'observed',remote:prior}});
 const body={schema:1,id:randomUUID(),operationId:p.operationId,runtimeId:randomUUID(),revision:1,scope:'installer_processes_only',createdAt:1000,expiresAt:301000,members:{worker:{platform:'linux',pid:123,boot:randomUUID(),start:'123'},child:null,launcher:null},host:null,canApply:true,reason:'ready'};
 const sign=(changes={})=>{const b={...body,...changes};return {...b,signature:createHmac('sha256',proof).update(JSON.stringify(b)).digest('hex')};};
 return {...f,p,key,prior,sign,plan:sign()};
}
test('stop preview leaves local ledger unchanged and sends no stop intent',async t=>{
 const f=await stopFixture(t),before=structuredClone([...f.records]);let sent=[];
 f.options.ssh.execute=async(b,c,input)=>{const q=JSON.parse(input);sent.push(q.action);assert(!c.includes(q.proof));return JSON.stringify({ok:true,value:{operationId:f.p.operationId,initialization:false,hostStarted:false,canApply:true,stopPlan:f.plan}});};
 const v=await createCloudOperations(f.options).runtimeAction({action:'runtime_stop_preview',operationId:f.p.operationId});
 assert.deepEqual(v.stopPlan,f.plan);assert.deepEqual(sent,['runtime_stop_preview']);assert.deepEqual([...f.records],before);
});
test('stop rejects tampering, wrong operation, known refusal, expiry and missing confirmation before intent or SSH',async t=>{
 const f=await stopFixture(t),before=structuredClone([...f.records]);let calls=0;f.options.ssh.execute=async()=>{calls++;throw Error('NO_DISPATCH');};
 const s=createCloudOperations(f.options),args={action:'runtime_stop',operationId:f.p.operationId,confirm:true,stopPlan:f.plan};
 await assert.rejects(s.runtimeAction({...args,confirm:false}),/CONFIRMATION_REQUIRED/);
 await assert.rejects(s.runtimeAction({...args,stopPlan:{...f.plan,revision:2}}),/STOP_PLAN_REVIEW/);
 await assert.rejects(s.runtimeAction({...args,stopPlan:f.sign({operationId:randomUUID()})}),/STOP_PLAN_REVIEW/);
 await assert.rejects(s.runtimeAction({...args,stopPlan:f.sign({canApply:false,reason:'host_drain_required'})}),/HOST_DRAIN_REQUIRED/);
 await assert.rejects(s.runtimeAction({...args,stopPlan:f.sign({canApply:false,reason:'no_active_installer'})}),/STOP_NOT_READY/);
 await assert.rejects(s.runtimeAction({...args,stopPlan:f.sign({createdAt:3000,expiresAt:303000})}),/STOP_PLAN_EXPIRED/);
 f.setClock(301000);await assert.rejects(s.runtimeAction(args),/STOP_PLAN_EXPIRED/);
 assert.equal(calls,0);assert.deepEqual([...f.records],before);
});
test('old archived controller cannot run a PID-only stop or be swapped for the new stop module',async t=>{
 const f=await stopFixture(t,false),before=structuredClone([...f.records]);let calls=0;f.options.ssh.execute=async()=>{calls++;throw Error('NO_DISPATCH');};
 const s=createCloudOperations(f.options);await assert.rejects(s.runtimeAction({action:'runtime_stop',operationId:f.p.operationId,confirm:true}),/CONFIRMATION_REQUIRED/);
 await assert.rejects(s.runtimeAction({action:'runtime_stop',operationId:f.p.operationId,confirm:true,stopPlan:f.plan}),/STOP_UNSUPPORTED/);
 await assert.rejects(s.runtimeAction({action:'runtime_stop_preview',operationId:f.p.operationId}),/STOP_UNSUPPORTED/);
 assert.equal(calls,0);assert.deepEqual([...f.records],before);
});
test('lost stop receipt survives local restart, blocks replay or replacement and reconciles only the matching target record',async t=>{
 const f=await stopFixture(t);let stops=0,checks=0,arrived=false,reconciles=0;
 f.options.ssh.execute=async(b,c,input)=>{const q=JSON.parse(input);assert(!c.includes(q.proof));
  if(q.action==='runtime_stop'){stops++;assert.equal(f.records.get(f.key).payload.state,'stop_requested');assert.deepEqual(f.records.get(f.key).payload.stopPlan,f.plan);throw Error('ONBOARDING_SSH_TIMEOUT');}
  if(q.action==='runtime_status'){checks++;return JSON.stringify({ok:true,value:{...f.prior,state:'stopped',workerActive:false,...(arrived?{stop:{id:f.plan.id,phase:'requested',scope:'installer_processes_only',activeInstallerMembers:0,reconcileRequired:true,stopPlan:f.plan,hostStopAuthorized:false}}:{})}});}
  assert.equal(q.action,'runtime_stop_reconcile');reconciles++;assert.deepEqual(q.stopPlan,f.plan);return JSON.stringify({ok:true,value:{...f.prior,state:'stopped',workerActive:false,stop:{id:f.plan.id,phase:'ended',reconcileRequired:false,hostStopAuthorized:false},notResent:true}});
 };
 let s=createCloudOperations(f.options);const args={action:'runtime_stop',operationId:f.p.operationId,confirm:true,stopPlan:f.plan};
 await assert.rejects(s.runtimeAction(args),/SSH_TIMEOUT/);s=createCloudOperations(f.options);
 for(const a of [args,{...args,stopPlan:f.sign({id:randomUUID()})},{action:'runtime_stop_preview',operationId:f.p.operationId},{action:'runtime_restart',acknowledgeNativeResume:true,operationId:f.p.operationId,confirm:true,fingerprint:digest('restart')},{action:'runtime_rollback',operationId:f.p.operationId,confirm:true}])await assert.rejects(s.runtimeAction(a),/STOP_RECONCILE_REQUIRED/);
 let v=await s.runtimeAction({action:'runtime_status',operationId:f.p.operationId});assert.equal(v.state,'stop_outcome_unknown');assert.equal(f.records.get(f.key).payload.state,'stop_requested');assert.equal(stops,1);
 arrived=true;v=await s.runtimeAction({action:'runtime_status',operationId:f.p.operationId});assert.equal(v.stop.phase,'requested');assert.equal(f.records.get(f.key).payload.state,'observed');
 f.setClock(999999);v=await s.runtimeAction({action:'runtime_stop_reconcile',operationId:f.p.operationId,confirm:true,stopPlan:f.plan});assert(v.notResent&&!v.stop.hostStopAuthorized);assert.equal(v.stop.phase,'ended');assert.equal(reconciles,1);assert.equal(stops,1);assert.equal(checks,2);
});
test('failed durable stop intent dispatches nothing and preserves prior record',async t=>{
 const f=await stopFixture(t),before=structuredClone(f.records.get(f.key)),old=f.options.credentials();let calls=0;
 f.options.credentials=()=>({...old,modifyRecord:async(k,fn)=>{if(k===f.key)throw Error('TEST_CREDENTIAL_WRITE_FAILED');return old.modifyRecord(k,fn);}});
 f.options.ssh.execute=async()=>{calls++;throw Error('NO_DISPATCH');};
 await assert.rejects(createCloudOperations(f.options).runtimeAction({action:'runtime_stop',operationId:f.p.operationId,confirm:true,stopPlan:f.plan}),/TEST_CREDENTIAL_WRITE_FAILED/);
 assert.equal(calls,0);assert.deepEqual(f.records.get(f.key),before);
});
test('restart requires explicit native-resume acknowledgement before any SSH or intent write',async t=>{
 const f=await fixture(t),p=await f.service.stage(f.confirm);f.options.runtimeEnabled=()=>true;let ssh=0;f.options.ssh.execute=async()=>{ssh++;throw Error('UNEXPECTED_SSH');};const s=createCloudOperations(f.options),before=JSON.stringify([...f.records]);
 for(const ack of [undefined,false,'true',1])await assert.rejects(s.runtimeAction({action:'runtime_restart',operationId:p.operationId,fingerprint:digest('plan'),confirm:true,...(ack===undefined?{}:{acknowledgeNativeResume:ack})}),/RESTART_CONSENT_REQUIRED/);
 assert.equal(ssh,0);assert.equal(JSON.stringify([...f.records]),before);
});
test('old archived source cannot start a newly consented restart; read-only status remains available',async t=>{
 const f=await fixture(t,1,...Array(10).fill(false)),p=await f.service.stage(f.confirm);f.options.runtimeEnabled=()=>true;const key='dsh-task-gateway/onboarding-runtime-v1-'+p.operationId;
 let sent=0;f.options.ssh.execute=async()=>{sent++;return JSON.stringify({ok:true,value:{operationId:p.operationId,state:'host_stopped',hostStarted:false,initialization:false}});};const s=createCloudOperations(f.options);
 // A start request records the real local shape; its stub response performs no process action.
 await s.runtimeAction({action:'runtime_start',operationId:p.operationId,fingerprint:digest('initial'),confirm:true});const before=JSON.stringify(f.records.get(key));sent=0;
 await assert.rejects(s.runtimeAction({action:'runtime_restart_preview',operationId:p.operationId}),/RESTART_CONSENT_UNSUPPORTED/);
 await assert.rejects(s.runtimeAction({action:'runtime_restart',operationId:p.operationId,fingerprint:digest('new'),confirm:true,acknowledgeNativeResume:true}),/RESTART_CONSENT_UNSUPPORTED/);
 assert.equal(sent,0);assert.equal(JSON.stringify(f.records.get(key)),before);assert.equal((await s.runtimeAction({action:'runtime_status',operationId:p.operationId})).state,'host_stopped');assert.equal(sent,1);
});
function hostPlan(f){return f.sign({schema:2,scope:'owned_host_with_loss_risk',members:{worker:null,child:null,launcher:null},host:{platform:'linux',pid:123,boot:randomUUID(),start:'1'},risk:{contract:1,lateNativeInputMayAbort:true,imInFlightMayAbort:true,ownQueuesRetained:true,ingressFrozen:false,automaticStop:false,requiresExplicitAcknowledgement:true},observation:{contract:1}});}
test('Host stop requires specific risk acknowledgement and the original archived capability before any SSH',async t=>{
 const f=await stopFixture(t,true),p=hostPlan(f),before=structuredClone([...f.records]);let sends=0;f.options.ssh.execute=async()=>{sends++;throw Error('NO_DISPATCH');};const service=createCloudOperations(f.options),a={action:'runtime_stop',operationId:f.p.operationId,confirm:true,stopPlan:p};
 await assert.rejects(service.runtimeAction(a),/CONFIRMATION_REQUIRED/);await assert.rejects(service.runtimeAction({...a,acknowledgeNativeInterruption:false}),/CONSENT_REQUIRED/);await assert.rejects(service.runtimeAction({...a,acknowledgeNativeInterruption:true}),/HOST_STOP_UNSUPPORTED/);assert.equal(sends,0);assert.deepEqual([...f.records],before);
});
test('Host risk confirmation travels only in stdin after local intent and unknown response is never resent',async t=>{
 const f=await stopFixture(t,true,true),p=hostPlan(f);let sends=0;f.options.ssh.execute=async(_b,cmd,input)=>{sends++;const q=JSON.parse(input);assert(q.acknowledgeNativeInterruption===true);assert(!cmd.includes(q.proof));assert.equal(f.records.get(f.key).payload.state,'stop_requested');throw Error('ONBOARDING_SSH_TIMEOUT');};
 const service=createCloudOperations(f.options),a={action:'runtime_stop',operationId:f.p.operationId,confirm:true,stopPlan:p,acknowledgeNativeInterruption:true};await assert.rejects(service.runtimeAction(a),/TIMEOUT/);await assert.rejects(service.runtimeAction(a),/RECONCILE_REQUIRED/);assert.equal(sends,1);
});
test('authoritative pre-intent refusal restores local status, never auto-retries',async t=>{
 const f=await stopFixture(t,true,true),p=hostPlan(f);let sends=0;f.options.ssh.execute=async()=>{sends++;return JSON.stringify({ok:false,error:'ONBOARDING_CLOUD_RUNTIME_HOST_STOP_PREFLIGHT_REFUSED'});};
 await assert.rejects(createCloudOperations(f.options).runtimeAction({action:'runtime_stop',operationId:f.p.operationId,confirm:true,stopPlan:p,acknowledgeNativeInterruption:true}),/PREFLIGHT_REFUSED/);assert.equal(f.records.get(f.key).payload.state,'observed');assert.equal(sends,1);
});

// Local unresolved repair intent fences the normal public runtime lifecycle path.
test('unresolved repair intent prevents lifecycle bypass while read-only status remains available',async t=>{
 const f=await fixture(t);const prepared=await f.service.stage(f.confirm);f.options.runtimeEnabled=()=>true;const service=createCloudOperations(f.options),id=randomUUID(),key='dsh-task-gateway/onboarding-runtime-repair-v1-'+prepared.operationId;let sends=0;f.options.ssh.execute=async()=>{sends++;return JSON.stringify({ok:true,value:{operationId:prepared.operationId,state:'host_stopped',initialization:false,hostStarted:false}});};
 for(const state of ['requested','observed']){f.records.set(key,{kind:'grant',payload:{schema:1,operationId:prepared.operationId,id,action:'runtime_repair_apply',fingerprint:'a'.repeat(64),state,receipt:state==='observed'?{state:'repair_needs_review',repair:{id,recoveryRequired:true}}:null}});await assert.rejects(service.runtimeAction({action:'runtime_restart',operationId:prepared.operationId,confirm:true,acknowledgeNativeResume:true,fingerprint:'b'.repeat(64)}),/REPAIR_RECOVERY_REQUIRED/);}
 assert.equal(sends,0);await service.runtimeAction({action:'runtime_status',operationId:prepared.operationId});assert.equal(sends,1);
});
test('local repair history never exposes a saved live activation as a fresh observation',async t=>{
 const f=await fixture(t),p=await f.service.stage(f.confirm);f.options.runtimeEnabled=()=>true;const service=createCloudOperations(f.options),id=randomUUID(),saved={state:'repair_committed',repair:{contract:1,id,state:'committed',recoveryRequired:false},activation:{contract:1,activationVerified:true,cached:false,observedAt:123}};
 const key='dsh-task-gateway/onboarding-runtime-repair-v1-'+p.operationId;f.records.set(key,{kind:'grant',payload:{schema:1,operationId:p.operationId,id,action:'runtime_repair_apply',fingerprint:'a'.repeat(64),state:'observed',receipt:saved}});
 const calls=f.calls,v=await service.runtimeAction({action:'runtime_record',operationId:p.operationId});assert.equal(f.calls,calls);assert(!v.pluginRepair.receipt.activation.activationVerified&&v.pluginRepair.receipt.activation.cached);assert.equal(v.pluginRepair.receipt.activation.observedAt,123);assert(f.records.get(key).payload.receipt.activation.activationVerified);assert(!v.pluginRepair.supported&&!v.pluginRepair.activationSupported);
});

// Public version routing shares the preparation gate, but never the ordinary
// runtime status ledger. Test receipts below are transport substitutes, not Hosts.
test('public cloud_version record uses original archive capability and never SSH',async t=>{
 const f=await fixture(t),p=await f.service.stage(f.confirm);f.options.runtimeEnabled=()=>true;const s=createCloudOperations(f.options),calls=f.calls;
 const r=await s.versionAction({action:'record',operationId:p.operationId});assert(!r.supported&&r.cached&&r.historical);assert.equal(f.calls,calls);
 await assert.rejects(s.versionAction({action:'candidate_preview',operationId:p.operationId}),/RECONCILE_REQUIRED/);assert.equal(f.calls,calls);
});
test('positive public service route stages a local version snapshot and receives one acknowledged package',async t=>{
 const f=await fixture(t),pkg=JSON.parse(await fs.readFile(f.source+'/package.json'));
 pkg.files.push('package-lock.json','runtime-package.json','runtime-lock.json','runtime-im-package.json','runtime-im-lock.json');await fs.writeFile(f.source+'/package.json',JSON.stringify(pkg));
 await fs.writeFile(f.source+'/package-lock.json',JSON.stringify({version:pkg.version,packages:{'':{version:pkg.version}}}));for(const n of ['runtime-package.json','runtime-lock.json','runtime-im-package.json','runtime-im-lock.json'])await fs.writeFile(f.source+'/'+n,'{}');
 const compat=JSON.parse(await fs.readFile(f.source+'/compatibility.json'));compat.onboardingPluginVersion=1;compat.onboardingPluginVersionRequests=1;await fs.writeFile(f.source+'/compatibility.json',JSON.stringify(compat));
 f.p.sourceManifestHash=(await cloudPackage(f.source)).manifestHash;const {fingerprint,...body}=f.p;f.p.fingerprint=digest(body);
 const staged=await f.service.stage({id:f.p.id,fingerprint:f.p.fingerprint,confirm:true}),operationId=staged.operationId,runtimeId=randomUUID();
 f.records.set('dsh-task-gateway/onboarding-runtime-v1-'+operationId,{kind:'grant',payload:{owner:'dsh-dual-host-onboarding',schema:1,operationId,state:'observed',remote:{runtimeId,state:'host_stopped'}}});
 for(const n of ['package.json','package-lock.json','compatibility.json']){const p=JSON.parse(await fs.readFile(f.source+'/'+n));p.version='0.0.2';if(p.packages)p.packages[''].version='0.0.2';await fs.writeFile(f.source+'/'+n,JSON.stringify(p));}
 const home=f.root+'/home',dsh=home+'/dsh',local=dsh+'/dual-host-onboarding';await fs.mkdir(local+'/cloud/'+operationId,{recursive:true});await fs.copyFile(f.root+'/local/cloud/'+operationId+'/package.json',local+'/cloud/'+operationId+'/package.json');
 let calls=0,loseVersion=false;const remote=async(b,c,input)=>{calls++;const q=JSON.parse(input);assert.equal(q.versionAction,'receive');if(loseVersion)throw Error('version transport lost');const ledger=f.records.get('dsh-task-gateway/onboarding-runtime-version-v1-'+operationId).payload;assert.equal(ledger.requests.at(-1).state,'requested');const v=ledger.candidates.at(-1);return JSON.stringify({ok:true,value:{operationId,runtimeId,initialization:false,hostStarted:false,activationVerified:false,contract:1,id:v.id,state:'ready',version:v.version,manifestHash:v.manifestHash,files:v.files,bytes:v.bytes,scope:'candidate_files_only',runtimeChanged:false,recoveryRequired:false}});};
 // A record-only call needs no new binding. Sending resolves the exact original
 // saved binding through the existing cloud-operation history seam.
 const op=f.records.get(KEY).payload;f.records.set('dsh-task-gateway/onboarding-cloud-operation-v1-'+operationId,{kind:'grant',payload:{owner:'dsh-dual-host-onboarding',schema:1,operation:op,binding:f.b}});
 f.options.credentials().describeRecord=async()=>({writable:true});
 const {createOnboardingService}=await import('../bundle/onboarding-host.js');const service=createOnboardingService({},{onboarding:{persistence:{enabled:true,isolatedRoot:f.root},cloud:{enabled:true}}},{home,env:{DSH_HOME:dsh,DSH_AGENTS_HOME:home+'/agents',DSH_ONBOARDING_ISOLATED_ROOT:f.root},credentials:f.options.credentials(),source:f.source,ssh:{execute:remote}});t.after(()=>service.dispose());
 const plan=await service.call('cloud_version',{action:'candidate_preview',operationId});assert.equal(plan.version,'0.0.2');assert.equal(calls,0);
 const r=await service.call('cloud_version',{action:'receive',operationId,id:plan.id,fingerprint:plan.fingerprint,confirm:true});assert.equal(r.state,'ready');assert.equal(calls,1);
 assert((await service.call('cloud_version',{action:'receive',operationId,id:plan.id,fingerprint:plan.fingerprint,confirm:true})).notResent);assert.equal(calls,1);
 assert((await service.call('cloud_version',{action:'record',operationId})).cached);assert.equal(calls,1);
 const next=await service.call('cloud_version',{action:'candidate_preview',operationId});loseVersion=true;await assert.rejects(service.call('cloud_version',{action:'receive',operationId,id:next.id,fingerprint:next.fingerprint,confirm:true}),/OUTCOME_UNKNOWN/);
 for(const action of ['runtime_restart_preview','runtime_repair_preview'])await assert.rejects(service.call('cloud_runtime',{action,operationId}),/VERSION_RECOVERY_REQUIRED/);assert.equal(calls,2);
 assert((await service.call('cloud_runtime',{action:'runtime_record',operationId})).cached);assert.equal(calls,2);
});

test('public rules route holds restart, repair and version mutation while original artifact outcome is unknown',async t=>{
 const f=await fixture(t),pkg=JSON.parse(await fs.readFile(f.source+'/package.json'));
 pkg.files.push('package-lock.json','runtime-package.json','runtime-lock.json','runtime-im-package.json','runtime-im-lock.json');await fs.writeFile(f.source+'/package.json',JSON.stringify(pkg));
 await fs.writeFile(f.source+'/package-lock.json',JSON.stringify({version:pkg.version,packages:{'':{version:pkg.version}}}));for(const n of ['runtime-package.json','runtime-lock.json','runtime-im-package.json','runtime-im-lock.json'])await fs.writeFile(f.source+'/'+n,'{}');
 const compat=JSON.parse(await fs.readFile(f.source+'/compatibility.json'));compat.onboardingPluginVersion=1;compat.onboardingPluginVersionRequests=1;compat.onboardingPluginVersionArtifacts=1;await fs.writeFile(f.source+'/compatibility.json',JSON.stringify(compat));
 f.p.sourceManifestHash=(await cloudPackage(f.source)).manifestHash;const {fingerprint,...body}=f.p;f.p.fingerprint=digest(body);
 const staged=await f.service.stage({id:f.p.id,fingerprint:f.p.fingerprint,confirm:true}),operationId=staged.operationId,runtimeId=randomUUID();
 f.records.set('dsh-task-gateway/onboarding-runtime-v1-'+operationId,{kind:'grant',payload:{owner:'dsh-dual-host-onboarding',schema:1,operationId,state:'observed',remote:{runtimeId,state:'host_stopped'}}});
 for(const n of ['package.json','package-lock.json','compatibility.json']){const p=JSON.parse(await fs.readFile(f.source+'/'+n));p.version='0.0.2';if(p.packages)p.packages[''].version='0.0.2';await fs.writeFile(f.source+'/'+n,JSON.stringify(p));}
 const home=f.root+'/home',dsh=home+'/dsh',local=dsh+'/dual-host-onboarding';await fs.mkdir(local+'/cloud/'+operationId,{recursive:true});await fs.copyFile(f.root+'/local/cloud/'+operationId+'/package.json',local+'/cloud/'+operationId+'/package.json');
 let calls=0,drop=true;const artifactId=randomUUID(),planHash=digest('rules-plan');
 const base={contract:1,operationId,runtimeId,scope:'stopped_owned_rules_and_skills_only',initialization:false,hostStarted:false,activationVerified:false,pluginBinaryChanged:false,credentialsChanged:false};
 const remote=async(b,c,input)=>{calls++;const q=JSON.parse(input);
  if(q.versionAction==='rules_preview')return JSON.stringify({ok:true,value:{...base,id:artifactId,fingerprint:planHash,expiresAt:Date.now()+300000,targetVersion:'0.0.2',planReady:true,canApply:true,conflicts:[],changes:[]}});
  if(q.versionAction==='rules_apply'){assert.equal(f.records.get('dsh-task-gateway/onboarding-runtime-artifacts-v1-'+operationId).payload.requests.at(-1).state,'requested');if(drop){drop=false;throw Error('lost own rules response');}}
  assert.equal(q.args.id,artifactId);return JSON.stringify({ok:true,value:{...base,id:artifactId,version:'0.0.2',state:'committed',recoveryRequired:false}});
 };
 // A record-only call needs no new binding. Sending resolves the exact original
 // saved binding through the existing cloud-operation history seam.
 const op=f.records.get(KEY).payload;f.records.set('dsh-task-gateway/onboarding-cloud-operation-v1-'+operationId,{kind:'grant',payload:{owner:'dsh-dual-host-onboarding',schema:1,operation:op,binding:f.b}});
 f.options.credentials().describeRecord=async()=>({writable:true});
 const {createOnboardingService}=await import('../bundle/onboarding-host.js');const service=createOnboardingService({},{onboarding:{persistence:{enabled:true,isolatedRoot:f.root},cloud:{enabled:true}}},{home,env:{DSH_HOME:dsh,DSH_AGENTS_HOME:home+'/agents',DSH_ONBOARDING_ISOLATED_ROOT:f.root},credentials:f.options.credentials(),source:f.source,ssh:{execute:remote}});t.after(()=>service.dispose());

 assert((await service.call('cloud_version',{action:'rules_record',operationId})).supported);assert.equal(calls,0);
 const plan=await service.call('cloud_version',{action:'rules_preview',operationId});assert.equal(calls,1);
 await assert.rejects(service.call('cloud_version',{action:'rules_apply',operationId,id:plan.id,fingerprint:plan.fingerprint,confirm:true}),/OUTCOME_UNKNOWN/);
 for(const action of ['runtime_restart_preview','runtime_repair_preview'])await assert.rejects(service.call('cloud_runtime',{action,operationId}),/VERSION_RECOVERY_REQUIRED/);
 await assert.rejects(service.call('cloud_version',{action:'candidate_preview',operationId}),/VERSION_RECOVERY_REQUIRED/);assert.equal(calls,2);
 assert((await service.call('cloud_version',{action:'rules_record',operationId})).pending);assert.equal(calls,2);
 assert.equal((await service.call('cloud_version',{action:'rules_status',operationId,id:plan.id})).state,'committed');assert.equal(calls,3);
 assert(!(await service.call('cloud_version',{action:'rules_record',operationId})).pending);
});

test('cloud operation routes normal activation separately and blocks verification with unresolved own work',async t=>{
 const f=await fixture(t),compat=JSON.parse(await fs.readFile(f.source+'/compatibility.json'));Object.assign(compat,{onboardingPluginVersion:1,onboardingPluginVersionRequests:1,onboardingPluginVersionArtifacts:1,onboardingVersionActivation:1});await fs.writeFile(f.source+'/compatibility.json',JSON.stringify(compat));
 f.p.sourceManifestHash=(await cloudPackage(f.source)).manifestHash;const {fingerprint,...body}=f.p;f.p.fingerprint=digest(body);const staged=await f.service.stage({id:f.p.id,fingerprint:f.p.fingerprint,confirm:true}),operationId=staged.operationId,runtimeId=randomUUID();
 const key='dsh-task-gateway/onboarding-runtime-v1-'+operationId,runtime={kind:'grant',payload:{owner:'dsh-dual-host-onboarding',schema:1,operationId,state:'observed',remote:{runtimeId,state:'host_ready'}}};f.records.set(key,runtime);
 let calls=0;const service=createCloudOperations({...f.options,runtimeEnabled:()=>true,ssh:{...f.options.ssh,execute:async()=>{calls++;throw Error('should not contact');}}});
 const r=await service.versionAction({action:'activation_record',operationId});assert(r.supported&&r.cached&&r.historical&&!r.activationVerified);assert.equal(calls,0);
 runtime.payload.state='requested';await assert.rejects(service.versionAction({action:'activation_verify',operationId,id:randomUUID()}),/RECONCILE_REQUIRED/);assert.equal(calls,0);
 runtime.payload.state='observed';await assert.rejects(service.versionAction({action:'activation_verify',operationId,id:randomUUID()}),/TRANSACTION_UNKNOWN/);assert.equal(calls,0);
 assert((await service.versionAction({action:'activation_record',operationId})).supported);
});
