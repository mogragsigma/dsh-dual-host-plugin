import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOnboardingImMaintenance} from '../bundle/onboarding-im-maintenance.js';
import {nativeImMaintenanceTransport,projectMaintenanceBots} from '../bundle/onboarding-im-maintenance-native.js';
import {createOnboardingService} from '../bundle/onboarding-host.js';
import {createOnboardingActivity} from '../bundle/onboarding-activity.js';
const KEY='dsh-task-gateway/onboarding-im-maintenance-v1';
const confirm=p=>({id:p.id,fingerprint:p.fingerprint,confirm:true,acknowledgeLoss:true});
function store(){const records=new Map();let writes=0,before=null,after=null,tail=Promise.resolve();const credentials={async readRecord(k){return structuredClone(records.get(k));},async describeRecord(){return {writable:true};},modifyRecord(k,fn){const job=tail.then(async()=>{const v=fn(structuredClone(records.get(k)));await before?.(v);records.set(k,structuredClone(v));writes++;await after?.(v);});tail=job.catch(()=>{});return job;}};return {credentials,records,writes:()=>writes,setBefore:f=>{before=f;},setAfter:f=>{after=f;}};}
function fixture(s=store(),proof){let time=1000,provider=s.credentials,im={contractVersion:1},state='connected',calls=[],throwAction=false,wait=null,config='a'.repeat(64);const rows=()=>[{botId:'test-bot',channel:'feishu',name:'隔离测试机器人',configured:true,connected:state==='connected',state,configHash:config}];const transport={async call(action,id){if(action==='status')return rows();assert.equal(id,'test-bot');assert.equal(s.records.get(KEY)?.payload.entries.at(-1).phase,'intent');calls.push(action);state=action==='disconnect'?'disconnected':'connected';await wait?.();if(throwAction)throw Error('SENSITIVE_UPSTREAM_ERROR');return rows();}};const options={credentials:()=>provider,im:()=>im,now:()=>time,processIdentity:proof??{capture:async()=>null,observe:async()=>({state:'unknown'})}},own=createOnboardingImMaintenance(options);return {...s,store:s,options,own,transport,calls,rows,advance:n=>time+=n,changeProvider:p=>provider=p,changeIm:()=>im={contractVersion:1},state:s=>state=s,config:s=>config=s,throwAction:()=>throwAction=true,setWait:f=>wait=f};}
const preview=(f,action='disconnect')=>f.own.preview({action,botId:'test-bot'},f.transport);
const apply=(f,p)=>f.own.apply(confirm(p),f.transport);
test('default inventory and preview never disconnect, write credentials or promise lossless drain',async()=>{
 const f=fixture(),s=await f.own.status({},f.transport),p=await preview(f);assert.equal(f.writes(),0);assert.deepEqual(f.calls,[]);assert.equal(s.automaticDisconnect,false);assert.equal(s.lossless,false);assert(s.restartMayReconnect&&p.restartMayReconnect&&p.mayAbortInFlight);assert(!s.hostStopAuthorized&&!s.pluginSwitchAuthorized);
});
test('explicit lossy disconnect persists intent before effect, keeps configuration, then separately approves reconnect',async()=>{
 const f=fixture(),p=await preview(f);await assert.rejects(f.own.apply({...confirm(p),acknowledgeLoss:false},f.transport),/CONFIRMATION_REQUIRED/);const d=await apply(f,p);assert.equal(d.receipt.phase,'acknowledged');assert.equal(d.receipt.observedState,'disconnected');assert.deepEqual(f.calls,['disconnect']);const q=await preview(f,'reconnect');assert.notEqual(p.id,q.id);assert.equal((await apply(f,q)).receipt.phase,'acknowledged');assert.deepEqual(f.calls,['disconnect','reconnect']);assert.equal(f.records.get(KEY).payload.entries.length,2);
});
test('no arbitrary connect, legacy disconnect or unsupported channel fallback',async()=>{
 const f=fixture();f.state('disconnected');await assert.rejects(preview(f,'reconnect'),/OWN_DISCONNECT_REQUIRED/);for(const action of ['delete','connection.disconnect','pause','dingtalk'])await assert.rejects(preview(f,action),/ARGUMENTS/);assert.deepEqual(f.calls,[]);
});
test('expired or changed bot/state/provider/config never executes saved plan',async()=>{
 for(const mode of ['expiry','state','config','provider']){const f=fixture(),p=await preview(f);if(mode==='expiry')f.advance(300001);if(mode==='state')f.state('disconnected');if(mode==='config')f.config('b'.repeat(64));if(mode==='provider')f.changeIm();await assert.rejects(apply(f,p),/PLAN_EXPIRED|OBSERVATION_CHANGED|PROVIDER_CHANGED/);assert.deepEqual(f.calls,[]);assert.equal(f.writes(),0);}
});
test('unknown action response does not retry; explicit review records present observation, never claims completion',async()=>{
 const f=fixture();f.throwAction();const r=await apply(f,await preview(f));assert.equal(r.receipt.phase,'needs_review');assert.deepEqual(f.calls,['disconnect']);await assert.rejects(preview(f,'reconnect'),/RECOVERY_REQUIRED/);const p=await f.own.reconcilePreview({},f.transport),v=await f.own.reconcileApply(confirm(p),f.transport);assert.equal(v.receipt.phase,'reviewed');assert.equal(v.priorEffectVerified,false);assert.equal(v.componentActions,0);assert.deepEqual(f.calls,['disconnect']);assert(!JSON.stringify(v).includes('SENSITIVE_UPSTREAM'));
});
test('failed intent write cannot call IM; lost intent acknowledgement cannot replay',async()=>{
 for(const late of [false,true]){const f=fixture();(late?f.setAfter:f.setBefore)(()=>{throw Error('WRITE_FAILURE');});const p=await preview(f);await assert.rejects(apply(f,p),/WRITE_FAILURE/);assert.deepEqual(f.calls,[]);await assert.rejects(apply(f,p),/PLAN_EXPIRED/);assert.equal(f.writes(),late?1:0);}
});
test('lost terminal receipt acknowledgement is queryable and not resent',async()=>{
 const f=fixture();f.setAfter(r=>{if(r.payload.entries.at(-1).phase==='acknowledged')throw Error('ACK_LOST');});const p=await preview(f);await assert.rejects(apply(f,p),/ACK_LOST/);assert.equal((await f.own.status({},f.transport)).receipt.phase,'acknowledged');await assert.rejects(apply(f,p),/PLAN_EXPIRED/);assert.deepEqual(f.calls,['disconnect']);
});
test('busy native request cannot be reviewed or repeated while in flight',async()=>{
 const f=fixture();let started,done;const seen=new Promise(r=>started=r),wait=new Promise(r=>done=r);f.setWait(()=>{started();return wait;});const work=apply(f,await preview(f));await seen;assert((await f.own.status({},f.transport)).operationInFlight);await assert.rejects(f.own.reconcilePreview({},f.transport),/BUSY/);await assert.rejects(preview(f),/BUSY/);done();await work;assert.deepEqual(f.calls,['disconnect']);
});
test('rebind while effect is pending retains original intent, no terminal receipt on replacement storage',async()=>{
 const f=fixture();let started,done;const seen=new Promise(r=>started=r),wait=new Promise(r=>done=r);f.setWait(()=>{started();return wait;});const work=apply(f,await preview(f));await seen;f.changeIm();done();await assert.rejects(work,/PROVIDER_CHANGED/);assert.equal(f.records.get(KEY).payload.entries[0].phase,'intent');assert.deepEqual(f.calls,['disconnect']);
});
test('restart only reads durable state; upstream automatic reconnect is reported, not silently undone',async()=>{
 const f=fixture();await apply(f,await preview(f));f.state('connected');const g=createOnboardingImMaintenance(f.options),writes=f.writes();const s=await g.status({},f.transport);assert.equal(s.receipt.observedState,'disconnected');assert.equal(s.bots[0].state,'connected');assert(s.restartMayReconnect);assert.equal(f.writes(),writes);assert.deepEqual(f.calls,['disconnect']);await assert.rejects(g.preview({action:'reconnect',botId:'test-bot'},f.transport),/STATE_REVIEW/);
});
test('prior instance unfinished intent cannot be reviewed until original process termination is proved',async()=>{
 const f=fixture();f.setAfter(()=>{throw Error('ACK_LOST');});await assert.rejects(apply(f,await preview(f)),/ACK_LOST/);f.setAfter(null);const g=createOnboardingImMaintenance(f.options);await assert.rejects(g.reconcilePreview({},f.transport),/ORIGINAL_IN_FLIGHT_UNVERIFIED/);assert.deepEqual(f.calls,[]);
});
test('proven terminated original intent review makes no native operation, and rechecks proof at apply',async()=>{
 const f=fixture();f.setAfter(()=>{throw Error('ACK_LOST');});await assert.rejects(apply(f,await preview(f)),/ACK_LOST/);f.setAfter(null);let exit=true;const g=createOnboardingImMaintenance({...f.options,processIdentity:{capture:async()=>null,observe:async()=>({state:exit?'exited':'alive'})}});const p=await g.reconcilePreview({},f.transport);exit=false;await assert.rejects(g.reconcileApply(confirm(p),f.transport),/ORIGINAL_IN_FLIGHT_UNVERIFIED/);exit=true;const q=await g.reconcilePreview({},f.transport);assert.equal((await g.reconcileApply(confirm(q),f.transport)).componentActions,0);assert.deepEqual(f.calls,[]);
});
test('current observation drift prevents ledger-only review',async()=>{
 const f=fixture();f.throwAction();await apply(f,await preview(f));const p=await f.own.reconcilePreview({},f.transport);f.state('connected');await assert.rejects(f.own.reconcileApply(confirm(p),f.transport),/OBSERVATION_CHANGED/);assert.equal(f.records.get(KEY).payload.entries[0].phase,'needs_review');
});
test('concurrent owners use CAS and cannot invoke two transitions from one ledger revision',async()=>{
 const f=fixture(),g=fixture(f.store),p=await preview(f),q=await preview(g);const a=await Promise.allSettled([apply(f,p),apply(g,q)]);assert.equal(a.filter(x=>x.status==='fulfilled').length,1);assert.equal(f.calls.length+g.calls.length,1);
});
test('malformed or foreign credentials are neither exposed nor overwritten',async()=>{
 const f=fixture();f.records.set(KEY,{kind:'api-key',key:'SECRET'});await assert.rejects(f.own.status({},f.transport),/LEDGER_REVIEW/);assert.equal(f.writes(),0);assert.deepEqual(f.calls,[]);
});
test('real service dispatch remains usable while own startup fenced; missing authenticated carrier fails closed',async()=>{
 const f=fixture(),activity=createOnboardingActivity(),svc=createOnboardingService({}, {},{credentials:f.credentials,im:{contractVersion:1},activity,home:'/no-real-home',env:{PATH:''}});
 activity.setAdmission('fenced');assert.equal((await svc.call('im_maintenance_status',{})).inventoryState,'unavailable');await assert.rejects(svc.call('im_maintenance_preview',{action:'disconnect',botId:'test-bot'}),/TRANSPORT_REQUIRED/);const p=await svc.call('im_maintenance_preview',{action:'disconnect',botId:'test-bot'},{imTransport:f.transport});const v=await svc.call('im_maintenance_apply',confirm(p),{imTransport:f.transport});assert.equal(v.receipt.phase,'acknowledged');assert.equal(activity.status().admission,'fenced');await svc.dispose();
});
function publicStatus(connected=true){return {schemaVersion:2,bots:[{botId:'test-bot',configured:true,connected,state:connected?'connected':'disconnected',bot:{name:'测试'},model:{provider:'synthetic'}}]};}
test('public adapter rejects schema 1, contradictory states and duplicate IDs; projection discards unknown fields',()=>{
 const s=publicStatus();s.bots[0].unknown='DO_NOT_RETURN';assert(!JSON.stringify(projectMaintenanceBots(s)).includes('DO_NOT_RETURN'));for(const value of [{...s,schemaVersion:1},{...s,bots:[...s.bots,...s.bots]},{...s,bots:[{...s.bots[0],connected:false}]}])assert.throws(()=>projectMaintenanceBots(value),/TRANSPORT_REVIEW/);
});
test('adapter retains remote Host/Origin policy, uses public carrier and never legacy/delete/test endpoints',async()=>{
 const requests=[],peer={},connection={browserPeer:peer,createSharedFetchHandler(c){assert.equal(c,'/api');return {async fetch(req,p){assert.equal(p,peer);const b=await req.json();requests.push({headers:Object.fromEntries(req.headers),body:b,url:req.url});return Response.json({type:'server-response',rpcId:b.rpcId,result:{ok:true,value:publicStatus(b.payload.method!=='bot.disconnect')}});}};}};
 const t=nativeImMaintenanceTransport(connection,new Request('https://test-host.example/api/task-onboarding/control',{method:'POST',headers:{Host:'test-host.example',Origin:'https://test-host.example',Cookie:'SHOULD_NOT_COPY'}}));await t.call('status');await t.call('disconnect','test-bot');await t.call('reconnect','test-bot');assert.deepEqual(requests.map(x=>x.body.payload.method),['connection.status','bot.disconnect','bot.reconnect']);for(const r of requests){assert.equal(r.headers.host,'test-host.example');assert.equal(r.headers.origin,'https://test-host.example');assert(!r.headers.cookie);assert.equal(r.url,'https://test-host.example/api/dsh-im/feishu');}assert.deepEqual(requests.at(-1).body.payload.payload,{botId:'test-bot'});await assert.rejects(t.call('delete','test-bot'),/TRANSPORT_REVIEW/);
});
test('transport errors, correlation mismatch or denial never become success',async()=>{
 for(const reply of [new Response('forbidden',{status:403}),Response.json({type:'server-response',rpcId:randomUUID(),result:{ok:true,value:publicStatus()}})]){const t=nativeImMaintenanceTransport({browserPeer:{},createSharedFetchHandler:()=>({fetch:async()=>reply})},new Request('http://localhost/api/task-onboarding/control'));await assert.rejects(t.call('status'),/TRANSPORT_REVIEW/);}
});

test('native effect rechecks bot configuration after intent persistence; drift does not disconnect',async()=>{
 const f=fixture();f.setAfter(r=>{if(r.payload.entries.at(-1).phase==='intent')f.config('b'.repeat(64));});const v=await apply(f,await preview(f));assert.equal(v.receipt.phase,'needs_review');assert.deepEqual(f.calls,[]);
});
test('historical query keeps newest receipt separate and stays readable without IM transport',async()=>{
 const f=fixture(),p=await preview(f);await apply(f,p);const q=await preview(f,'reconnect');await apply(f,q);const writes=f.writes(),r=await f.own.status({operationId:p.id});assert.equal(r.queryContract,1);assert.equal(r.inventoryState,'unavailable');assert.equal(r.receipt.id,q.id);assert.equal(r.requestedReceipt.id,p.id);assert.equal(r.requestedReceipt.observedState,'disconnected');assert.equal(f.writes(),writes);
 assert.equal((await f.own.status({operationId:randomUUID()},f.transport)).requestedReceipt,null);await assert.rejects(f.own.status({operationId:'not-an-id'},f.transport),/ARGUMENTS/);
 const unavailable=createOnboardingImMaintenance({...f.options,im:()=>null});assert.equal((await unavailable.status({operationId:p.id})).requestedReceipt.id,p.id);await assert.rejects(unavailable.preview({action:'disconnect',botId:'test-bot'},f.transport),/UNAVAILABLE/);
});
test('schema 1 is read without mutation; next explicit action writes schema 2 without erasing history',async()=>{
 const f=fixture(),p=await preview(f);await apply(f,p);const raw=f.records.get(KEY);raw.payload.schema=1;for(const e of raw.payload.entries)delete e.review;const bytes=JSON.stringify(raw),writes=f.writes();const v=await f.own.status({operationId:p.id},f.transport);assert.equal(v.requestedReceipt.review,null);assert.equal(JSON.stringify(f.records.get(KEY)),bytes);assert.equal(f.writes(),writes);
 await apply(f,await preview(f,'reconnect'));assert.equal(f.records.get(KEY).payload.schema,2);assert.equal(f.records.get(KEY).payload.entries[0].id,p.id);assert.equal(f.records.get(KEY).payload.entries[0].review,null);
});
test('lost review acknowledgement can be resolved by exact durable decision id after restart',async()=>{
 const f=fixture();f.throwAction();const p=await preview(f);await apply(f,p);const review=await f.own.reconcilePreview({},f.transport);f.setAfter(r=>{if(r.payload.entries.at(-1).phase==='reviewed')throw Error('ACK_LOST');});await assert.rejects(f.own.reconcileApply(confirm(review),f.transport),/ACK_LOST/);const next=createOnboardingImMaintenance(f.options),v=await next.status({operationId:p.id});assert.equal(v.requestedReceipt.review.id,review.id);assert.equal(v.inventoryState,'unavailable');assert.deepEqual(f.calls,['disconnect']);
});
