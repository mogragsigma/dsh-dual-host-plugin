import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOnboardingSelfStop} from '../bundle/onboarding-self-stop.js';
import {createOnboardingService} from '../bundle/onboarding-host.js';
import {createOnboardingActivity} from '../bundle/onboarding-activity.js';
import {createOnboardingAgentHold} from '../bundle/onboarding-agent-hold.js';
const KEY='dsh-task-gateway/self-stop-v1';
const confirm=p=>({id:p.id,fingerprint:p.fingerprint,confirm:true,acceptRisk:true});
const process={platform:'linux',host:'a'.repeat(64),boot:'6f82c81a-52f2-4f87-86cf-3d05297366a2',namespace:'pid:[1]',pid:10,start:'100'};
function storage(){let after,before;const rows=new Map();return {rows,setAfter:f=>after=f,setBefore:f=>before=f,credentials:{describeRecord:async()=>({writable:true}),readRecord:async k=>structuredClone(rows.get(k)),modifyRecord:async(k,fn)=>{const next=fn(structuredClone(rows.get(k)));await before?.(next);if(next!==undefined)rows.set(k,structuredClone(next));await after?.(next);}}};}
function fixture(store=storage()){
 let time=1000,calls=0,exit,credentialProvider=store.credentials,alive=true,afterExit;
 const id=randomUUID(),held={state:'held',operationInFlight:false,receipt:{id},admission:{local:'fenced',durable:{state:'fenced'}},live:{state:'held',operationId:id,instanceId:randomUUID(),components:{onboarding:{state:'held',instanceId:randomUUID(),operationId:randomUUID(),counts:{rpc:0,startup:0,model_attempt:0,workbench_http:0,workbench_websocket:0}},gateway:{state:'not_configured'},agents:{state:'held',instanceId:randomUUID(),operationId:randomUUID(),counts:{running:0,unsupported:0,pendingNextTurn:0,pendingNextStep:0,inboxUnknown:0},inboxState:'empty'}}}};
 const peers=Array.from({length:3},()=>({instanceId:randomUUID(),revision:0,pending:false,operationInFlight:false}));
 const own={state:'profile_bundle_observed',identityDigest:'b'.repeat(64),entry:{phase:'active',enabled:true},bundle:{enabled:true,version:'1.0.0'}};
 exit=code=>{assert.equal(code,0);assert.equal(store.rows.get(KEY).payload.entries.at(-1).state,'intent');calls++;afterExit?.();};
 const identity={capture:async()=>structuredClone(process),observe:async()=>({state:alive?'alive':'exited',reason:alive?'same_process':'absent',observer:{...process,pid:11,start:'200'},currentStart:alive?process.start:null})};
 const options={credentials:()=>credentialProvider,appExit:()=>exit,inspection:{status:async()=>structuredClone(own)},maintenance:{status:async()=>structuredClone(held),withHeld:async fn=>fn(structuredClone(held))},peers:async()=>structuredClone(peers),processIdentity:identity,now:()=>time};
 return {store,held,peers,own,identity,options,api:createOnboardingSelfStop(options),calls:()=>calls,replaceExit:e=>exit=e,replaceCredentials:c=>credentialProvider=c,advance:n=>time+=n,exited:()=>alive=false,afterExit:f=>afterExit=f};
}
test('public appExit only after separate consent and durable intent; never reports stopped',async()=>{
 const f=fixture(),p=await f.api.preview();assert(p.hostStopAuthorized);assert.equal(f.calls(),0);assert(!p.automaticStop&&!p.automaticRestart);assert(p.risks.includes('external_supervisor_may_restart'));
 for(const bad of [{...confirm(p),acceptRisk:false},{...confirm(p),confirm:false},{...confirm(p),pid:99}])await assert.rejects(f.api.apply(bad),/CONFIRMATION_REQUIRED/);
 const r=await f.api.apply(confirm(p));assert.equal(r.receipt.state,'intent');assert(r.exitRequested&&r.exitRequestReturned&&r.pending);assert(!r.hostStopped);assert.equal(f.calls(),1);
 assert((await f.api.apply(confirm(p))).notResent);assert.equal(f.calls(),1);await assert.rejects(f.api.preview(),/RECOVERY_REQUIRED/);await assert.rejects(f.api.assertNoPending(),/RECOVERY_REQUIRED/);
});
for(const defect of ['no_exit','wrong_owner','open_hold','open_admission','own_busy','native_busy','inbox_unknown','peer_pending','peer_busy','missing_process'])test('self stop preflight refuses '+defect,async()=>{
 const f=fixture();
 if(defect==='no_exit')f.replaceExit(null);if(defect==='wrong_owner')f.own.state='entry_only';if(defect==='open_hold')f.held.state='open';if(defect==='open_admission')f.held.admission.local='open';
 if(defect==='own_busy')f.held.live.components.onboarding.counts.rpc=1;if(defect==='native_busy')f.held.live.components.agents.counts.running=1;if(defect==='inbox_unknown')f.held.live.components.agents.inboxState='unknown';
 if(defect==='peer_pending')f.peers[2].pending=true;if(defect==='peer_busy')f.peers[0].operationInFlight=true;if(defect==='missing_process')f.identity.capture=async()=>null;
 await assert.rejects(f.api.preview());assert.equal(f.calls(),0);assert.equal(f.store.rows.size,0);
});
for(const change of ['expired','exit_replaced','peer_revision','native_birth','hold_replaced','version'])test('pre-intent change '+change+' is not dispatched',async()=>{
 const f=fixture(),p=await f.api.preview();if(change==='expired')f.advance(300001);if(change==='exit_replaced')f.replaceExit(()=>{});if(change==='peer_revision')f.peers[1].revision++;if(change==='native_birth')f.identity.capture=async()=>({...process,start:'101'});if(change==='hold_replaced')f.held.live.instanceId=randomUUID();if(change==='version')f.own.bundle.version='2.0.0';
 await assert.rejects(f.api.apply(confirm(p)));assert.equal(f.calls(),0);assert.equal(f.store.rows.size,0);
});
test('durable intent acknowledgement loss never causes an exit request or retry',async()=>{const f=fixture(),p=await f.api.preview();f.store.setAfter(()=>{throw Error('ACK_LOST');});await assert.rejects(f.api.apply(confirm(p)),/ACK_LOST/);assert.equal(f.calls(),0);assert((await f.api.status()).pending);assert((await f.api.apply(confirm(p))).notResent);});
test('failure before storing intent makes no request',async()=>{const f=fixture(),p=await f.api.preview();f.store.setBefore(()=>{throw Error('IO');});await assert.rejects(f.api.apply(confirm(p)),/IO/);assert.equal(f.calls(),0);assert.equal(f.store.rows.size,0);});
test('last post-intent change records not dispatched and never exits',async()=>{const f=fixture(),p=await f.api.preview();f.store.setAfter(next=>{if(next.payload.entries.at(-1).state==='intent')f.peers[2].revision++;});const r=await f.api.apply(confirm(p));assert.equal(r.receipt.state,'not_dispatched');assert.equal(f.calls(),0);assert(!r.pending);});
test('exit exception remains intent, scrubbed and unreplayable',async()=>{const f=fixture();f.replaceExit(()=>{throw Error('secret-token');});const p=await f.api.preview(),r=await f.api.apply(confirm(p));assert(r.pending&&!r.exitRequestReturned);assert(!JSON.stringify(r).includes('secret-token'));assert((await f.api.apply(confirm(p))).notResent);});
test('provider disposed by synchronous public exit does not write after disposal',async()=>{const f=fixture();f.afterExit(()=>f.api.dispose());const p=await f.api.preview(),r=await f.api.apply(confirm(p));assert(r.pending);assert.equal(f.calls(),1);assert.equal(f.store.rows.get(KEY).payload.revision,1);});
test('known exit proof is required; restart/reconcile never resends or opens admission',async()=>{
 const f=fixture(),p=await f.api.preview();await f.api.apply(confirm(p));await assert.rejects(f.api.reconcilePreview(),/ORIGINAL_PROCESS_UNRESOLVED/);f.exited();const next=createOnboardingSelfStop(f.options),q=await next.reconcilePreview();assert(q.ownerProcessExited&&!q.requestOutcomeProven);const r=await next.reconcileApply(confirm(q));assert.equal(r.receipt.state,'reconciled');assert(r.receipt.review.ownerProcessExited&&!r.receipt.review.requestOutcomeProven);assert.equal(f.calls(),1);assert.equal(f.held.admission.local,'fenced');assert.equal((await next.status({operationId:p.id})).requestedReceipt.id,p.id);assert((await next.apply(confirm(p))).notResent);
});
test('changed or foreign process proof cannot reconcile',async()=>{for(const proof of [{state:'unknown'},{state:'exited',reason:'absent',observer:{...process,host:'c'.repeat(64)},currentStart:null},{state:'exited',reason:'pid_reused',observer:{...process,pid:11},currentStart:process.start}]){const f=fixture(),p=await f.api.preview();await f.api.apply(confirm(p));f.identity.observe=async()=>proof;await assert.rejects(f.api.reconcilePreview(),/ORIGINAL_PROCESS_UNRESOLVED/);}});
test('changed proof after reconciliation preview is rejected',async()=>{const f=fixture(),p=await f.api.preview();await f.api.apply(confirm(p));f.exited();const q=await f.api.reconcilePreview();f.identity.observe=async()=>({state:'exited',reason:'pid_reused',observer:{...process,pid:11,start:'200'},currentStart:'201'});await assert.rejects(f.api.reconcileApply(confirm(q)),/OBSERVATION_CHANGED/);assert.equal((await f.api.status()).receipt.state,'intent');});
test('deleted, malformed or rolled-back ledger fails closed',async()=>{const f=fixture(),p=await f.api.preview();await f.api.apply(confirm(p));await f.api.status();const original=structuredClone(f.store.rows.get(KEY));for(const value of [undefined,{kind:'grant',payload:{...original.payload,schema:9}}, {kind:'grant',payload:{...original.payload,revision:0}}]){f.store.rows.set(KEY,value);await assert.rejects(f.api.status());}assert.equal(f.calls(),1);});
test('peer mutation guard rejects while stop is in flight',async()=>{const f=fixture();let entered,release;const wait=new Promise(r=>release=r),at=new Promise(r=>entered=r);f.options.inspection.status=async()=>{entered();await wait;return structuredClone(f.own);};const p=f.api.preview();await at;await assert.rejects(f.api.assertNoPending(),/BUSY/);release();await p;});
test('service wiring uses separate stop capability; pending stop blocks lifecycle and admission mutations',async t=>{
 const store=storage(),activity=createOnboardingActivity(),agents=createOnboardingAgentHold({agents:{list:()=>[]},on:()=>()=>{}}),NAME='@mogragsigma/dsh-dual-host-plugin',entryId='include:own';let calls=0;
 const manager={listPlugins:async()=>[{entryId,moduleName:NAME,enabled:true,fiberPhase:'active'}],listBundles:async()=>[{name:NAME,availability:'profile',enabled:true,installed:true,removable:true,version:'1.0.0',rows:[{entryId,moduleName:NAME}],overrides:[]}],setBundleEnabled:async()=>{throw Error('must not disable');},removeBundle:async()=>{throw Error('must not remove');}};
 const runtime={activity,agentHold:agents,credentials:store.credentials,pluginManager:manager,ownEntryId:entryId,appExit:code=>{assert.equal(code,0);calls++;}};
 const svc=createOnboardingService({}, {},runtime);t.after(()=>svc.dispose());assert.equal((await svc.call('describe',{})).capabilities.selfStopContract,1);
 const hold=await svc.call('maintenance_record_preview',{});await svc.call('maintenance_record_apply',{id:hold.id,fingerprint:hold.fingerprint,confirm:true});
 const p=await svc.call('self_stop_preview',{});await svc.call('self_stop_apply',confirm(p));assert.equal(calls,1);
 for(const method of ['self_disable_preview','self_remove_preview','maintenance_record_releasePreview','maintenance_record_resumePreview','im_maintenance_preview'])await assert.rejects(svc.call(method,{}),/SELF_STOP_RECOVERY_REQUIRED/);
 await assert.rejects(svc.call('detect',{}),/ONBOARDING_ACTIVITY_HELD/);assert((await svc.call('self_stop_status',{})).pending);runtime.appExit=undefined;assert.equal((await svc.call('describe',{})).capabilities.selfStopContract,0);assert.equal((await svc.call('describe',{})).capabilities.selfStopQueryContract,1);assert((await svc.call('self_stop_apply',confirm(p))).notResent);assert.equal(calls,1);
});
