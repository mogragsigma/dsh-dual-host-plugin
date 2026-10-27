import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,mkdtemp,mkdir,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {nativeLocalPairAdapter} from '../bundle/onboarding-local-pair-native.js';
import {nativeTaskRuntimeAdapter} from '../bundle/onboarding-task-runtime-native.js';
import {createOnboardingState} from '../bundle/onboarding-state.js';
import {createOnboardingLocalPair,localPairKey} from '../bundle/onboarding-local-pair.js';
import {createOnboardingTaskRuntime} from '../bundle/onboarding-task-runtime.js';
import {isManagedGatewayRuntime} from '../bundle/onboarding-task-runtime-contract.js';
import {peerBindingKey} from '../bundle/onboarding-peer-binding.js';
import {peerBindingPlan,peerBindingStatus} from '../bundle/onboarding-peer-contract.js';
import {digest} from '../bundle/onboarding-ssh.js';
const KEY='dsh-task-gateway/onboarding-local-pair-v1';
const confirm=p=>({id:p.id,fingerprint:p.fingerprint,confirm:true});
function credentials(){const records=new Map();let writes=0;return {records,writes:()=>writes,readRecord:async k=>structuredClone(records.get(k)),describeRecord:async()=>({writable:true}),async modifyRecord(k,fn){const v=fn(structuredClone(records.get(k)));if(v!==undefined){records.set(k,structuredClone(v));writes++;}}};}
async function fixture(t){
 const local=credentials(),cloud=credentials(),state={available:()=>true},calls=[],handles=[];let time=1700000000000,mode='normal',savedApply=null,mutate=null,failOpen=false;
 const target={operationId:randomUUID(),installationId:randomUUID(),runtimeId:randomUUID(),manifestHash:'a'.repeat(64),root:'/owned/isolated-target',role:'cloud',hostVersion:'0.2.1-rc.2'};
 const cloudDeps={state,credentials:()=>cloud,config:{onboarding:{role:'cloud'}},now:()=>time,adapter:{async open(p){let active=true;return {id:p.id,instanceId:randomUUID(),workerEnabled:p.workerEnabled===true,hold(){},pairingKey:peerBindingKey(p.pairing),port:12345,active:()=>active,quiescent:async()=>{},close:async()=>active=false,forward:async frame=>({ok:true,value:frame})};}}};let receiver=createOnboardingTaskRuntime(cloudDeps);await receiver.apply(confirm(await receiver.preview({enabled:true})));t.after(()=>receiver.close());
 const remote=async(method,args,boundTarget)=>{
  calls.push(method);if(boundTarget)assert.equal(digest(boundTarget),digest(target));const action=method.slice(10);assert(method.startsWith('task_pair_'));if(mode==='offline')throw Error('OFFLINE');if(args.targetHash)assert.equal(args.targetHash,digest(target));const {targetHash,...input}=args;
  if(action==='apply'){savedApply=input;if(mode==='unsent')throw Error('UNSENT');}if(action==='fence'&&mode==='late')await receiver.pairing.apply(savedApply);
  const value=await receiver.pairing[action](input);if(action==='apply'&&mode==='lost')throw Error('LOST_REPLY');return mutate?mutate({target,value}):{target,value};
 };
 const adapter={async open(p,authorize,transport){if(failOpen)throw Error('OPEN_FAILED');let active=true;const h={bindingKey:localPairKey(p),active:()=>active,quiescent:async()=>{},close:async()=>active=false,authorize,transport};handles.push(h);return h;}};
 const deps={state,credentials:()=>local,remote,enabled:()=>true,adapter,now:()=>time};let client=createOnboardingLocalPair(deps);t.after(()=>client.close());
 return {local,cloud,target,calls,handles,deps,get m(){return client;},get receiver(){return receiver;},setMode:v=>mode=v,setMutation:v=>mutate=v,error:v=>failOpen=v,advance:n=>time+=n,lateApply:()=>receiver.pairing.apply(savedApply),async bind(enabled=true){return client.apply(confirm(await client.preview({enabled})));},async restart(){await client.close();client=createOnboardingLocalPair(deps);await client.start();},async restartCloud(){await receiver.close();receiver=createOnboardingTaskRuntime(cloudDeps);await receiver.start();}};
}
test('empty start/mount is local-only and previews do not persist or launch a sender',async t=>{
 const f=await fixture(t);await f.m.start();assert.equal((await f.m.status({refresh:false})).operation.state,'not_started');assert.equal(f.calls.length,0);const p=await f.m.preview({enabled:true});assert(p.localId);assert.equal(f.local.writes(),0);assert.equal(f.cloud.writes(),1);assert.equal(f.handles.length,0);
});
test('explicit bound confirmation mounts local sender and keeps all role tokens out of views/remote args',async t=>{
 const f=await fixture(t),s=await f.bind();assert(s.localEnabled&&s.mounted);assert.equal(s.operation.state,'applied');assert(s.remote.mounted);assert(!s.workerEnabled&&!s.writeAuthorized&&!s.publishEnabled);
 const secret=f.local.records.get(KEY).payload.localToken,remote=f.cloud.records.get('dsh-task-gateway/onboarding-task-runtime-v1').payload;assert.notEqual(secret,remote.localToken);assert(!JSON.stringify(s).includes(secret));assert(!JSON.stringify(s).includes(remote.localToken));
 const frame=await f.handles.at(-1).transport('catalog',{}, {hello:{},peer_instance:randomUUID()});assert.equal(frame.method,'catalog');assert.equal(f.calls.at(-1),'task_pair_forward');
});
test('local restart restores only saved consent; remote restart preserves pair and no repeat apply',async t=>{
 const f=await fixture(t),s=await f.bind(),before=f.local.records.get(KEY),n=f.calls.length;await f.restart();assert.deepEqual(f.local.records.get(KEY),before);assert.equal(f.calls.length,n);assert((await f.m.status({refresh:false})).mounted);await f.restartCloud();const r=await f.m.status({refresh:true});assert.equal(r.localId,s.localId);assert.equal(r.remote.id,s.remote.id);assert.equal(r.remote.revision,s.remote.revision);assert.equal(f.calls.filter(x=>x==='task_pair_apply').length,1);
});
test('lost success across both restarts reconciles original approved grant without sending twice',async t=>{
 const f=await fixture(t),p=await f.m.preview({enabled:true});f.setMode('lost');const s=await f.m.apply(confirm(p));assert.equal(s.operation.state,'needs_review');assert(!s.localEnabled&&!s.mounted);await f.restart();await f.restartCloud();f.setMode('normal');assert.equal((await f.m.status({refresh:true})).operation.state,'applied');assert((await f.m.status({refresh:false})).mounted);const n=f.calls.length;assert((await f.m.apply(confirm(p))).notResent);assert.equal(f.calls.length,n);assert.equal(f.calls.filter(x=>x==='task_pair_apply').length,1);
});
test('unknown first approval can be fenced; closed request cannot mount local or late-activate cloud',async t=>{
 const f=await fixture(t),p=await f.m.preview({enabled:true});f.setMode('unsent');await f.m.apply(confirm(p));await assert.rejects(f.m.preview({enabled:true}),/RECOVERY_REQUIRED/);f.setMode('normal');const q=await f.m.recoveryPreview({}),s=await f.m.recoveryApply(confirm(q));assert.equal(s.operation.state,'closed');assert(!s.localEnabled&&!s.mounted&&!s.remote.enabled);await assert.rejects(f.lateApply(),/CONFLICT/);await f.restart();assert(!(await f.m.status({refresh:false})).mounted);assert((await f.m.recoveryApply(confirm(q))).notResent);
});
test('unknown revoke stops local immediately; closing does not pretend remote disabled or remount local',async t=>{
 const f=await fixture(t);await f.bind();const p=await f.m.preview({enabled:false});f.setMode('unsent');const s=await f.m.apply(confirm(p));assert(!s.mounted&&!s.localEnabled);await f.restart();assert(!(await f.m.status({refresh:false})).mounted);f.setMode('normal');const q=await f.m.recoveryPreview({}),r=await f.m.recoveryApply(confirm(q));assert.equal(r.operation.state,'closed');assert(r.remote.enabled);assert(!r.localEnabled&&!r.mounted);await assert.rejects(f.lateApply(),/CONFLICT/);assert((await f.bind(true)).mounted);
});
test('original confirmation winning a closure race is reported applied, never fictitiously revoked',async t=>{
 const f=await fixture(t),p=await f.m.preview({enabled:true});f.setMode('unsent');await f.m.apply(confirm(p));f.setMode('normal');const q=await f.m.recoveryPreview({});f.setMode('late');const s=await f.m.recoveryApply(confirm(q));assert.equal(s.operation.state,'applied');assert(s.mounted);assert.equal(s.remote.revision,1);
});
test('offline status preserves known transport consent and durable sender, not fake live health',async t=>{
 const f=await fixture(t);await f.bind();f.setMode('offline');const s=await f.m.status({refresh:true});assert(s.localEnabled&&s.mounted);assert.equal(s.remote,null);assert.equal(s.freshness,'check_failed');await assert.rejects(f.handles.at(-1).transport('catalog',{}),/OFFLINE/);f.setMode('normal');assert((await f.m.status({refresh:true})).remote.mounted);
});
test('receiver mutation invalidates old local grant; other controller cannot adopt old mailbox',async t=>{
 const f=await fixture(t),s=await f.bind();await f.receiver.pairing.fence({operation:randomUUID(),expectedRevision:s.remote.revision,id:s.remote.id,localId:s.remote.localId,runtimeId:s.remote.runtimeId,confirm:true});const r=await f.m.status({refresh:true});assert.equal(r.operation.state,'closed');assert(!r.localEnabled&&!r.mounted);
 const c=createOnboardingLocalPair({...f.deps,credentials:()=>credentials()});await assert.rejects(c.preview({enabled:true}),/OTHER_CONTROLLER/);await c.close();
});
test('expiry, missing confirmation and two local tabs cannot replace persisted send intent',async t=>{
 const f=await fixture(t),p=await f.m.preview({enabled:true});await assert.rejects(f.m.apply({...confirm(p),confirm:false}),/CONFIRMATION_REQUIRED/);f.advance(300001);await assert.rejects(f.m.apply(confirm(p)),/PLAN_EXPIRED/);
 const other=createOnboardingLocalPair(f.deps);t.after(()=>other.close());const a=await f.m.preview({enabled:true}),b=await other.preview({enabled:true});f.setMode('unsent');await f.m.apply(confirm(a));await assert.rejects(other.apply(confirm(b)),/LEDGER_CONFLICT/);assert.equal(f.calls.filter(x=>x==='task_pair_apply').length,1);
});
test('malformed/foreign records and arbitrary destinations are refused, not overwritten',async t=>{
 const f=await fixture(t);for(const a of [{enabled:true,url:'http://elsewhere'},{enabled:true,provider:'injected'}])await assert.rejects(f.m.preview(a),/ARGUMENTS/);f.local.records.set(KEY,{kind:'api-key',value:'KEEP'});await assert.rejects(f.m.status({refresh:false}),/LEDGER_REVIEW/);assert.equal(f.local.records.get(KEY).value,'KEEP');assert.equal(f.calls.length,0);
});
test('target replacement and overclaiming response never authorize a local sender',async t=>{
 for(const kind of ['target','secret','worker']){const f=await fixture(t),p=await f.m.preview({enabled:true});f.setMutation(r=>kind==='target'?{...r,target:{...r.target,runtimeId:randomUUID()}}:{...r,value:{...r.value,...(kind==='secret'?{token:'NO'}:{workerEnabled:true})}});const s=await f.m.apply(confirm(p));assert.equal(s.operation.state,'needs_review');assert(!s.mounted);}
});
test('local mount failure is not reported healthy; same recorded grant can mount on restart',async t=>{
 const f=await fixture(t);f.error(true);const s=await f.bind();assert(s.localEnabled&&!s.mounted);assert.equal(s.activationError,'ONBOARDING_LOCAL_PAIR_ACTIVATION_REVIEW');const n=f.calls.length;await f.m.status({refresh:false});assert.equal(f.calls.length,n);f.error(false);await f.restart();assert((await f.m.status({refresh:false})).mounted);
});
test('remote contract bounds and current cloud UI contract are not silently downgraded',async t=>{
 const f=await fixture(t),p=await f.receiver.pairing.preview({enabled:true,localId:randomUUID()});assert.equal(peerBindingPlan(p),p);assert.throws(()=>peerBindingPlan({...p,secret:'NO'}),/RESPONSE_REVIEW/);const s=await f.receiver.pairing.status();assert.equal(peerBindingStatus(s),s);assert.throws(()=>peerBindingStatus({...s,mounted:true}),/RESPONSE_REVIEW/);
 const ui=await readFile(new URL('../ui-source/onboarding/local-pair.jsx',import.meta.url),'utf8'),client=await readFile(new URL('../ui-source/workbench-client.js',import.meta.url),'utf8');assert(ui.includes("request('local_pair_status',{refresh:false})"));assert(!/setInterval|setTimeout/.test(ui));for(const text of ['connection-panel','connection-actions','CheckRow','手动刷新','不依赖 IM'])assert(ui.includes(text));assert(client.includes('[2,3,4].includes(x.capabilities?.managedTaskRuntimeContract)'));assert(client.includes('localPeerBinding'));
});

function lifecycle(){
 const services=new Map();function scope(){const owned=[],disposers=[],children=[];return {get:k=>services.get(k),on(){},inject(){},agents:{list:()=>[]},provide(k,v){services.set(k,v);owned.push([k,v]);},effect(f){disposers.push(f());},plugin(spec){const child=scope();children.push(child);const ready=spec.inject?.includes('taskGateway')?Promise.resolve():Promise.resolve(spec.apply(child));return {await:()=>ready,dispose:()=>child.dispose()};},async dispose(){for(const c of children)await c.dispose();for(const d of disposers.reverse())await d?.();for(const [k,v] of owned)if(services.get(k)===v)services.delete(k);}};}return scope();
}

test('both actual Gateway runtimes share a negotiated channel; local queue and native role survive restart',async t=>{
 const root=await mkdtemp(path.join(await realpath(tmpdir()),'s56-local-pair-native-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const contexts={local:lifecycle(),cloud:lifecycle()},stores={local:credentials(),cloud:credentials()},rt={},states={};
 for(const side of ['local','cloud']){const home=path.join(root,side);await mkdir(path.join(home,'.dsh'),{recursive:true,mode:0o700});rt[side]={home,env:{},platform:process.platform,credentials:stores[side]};states[side]=createOnboardingState({}, {},rt[side]);}
 const cloudConfig={onboarding:{role:'cloud'}},deps={state:states.cloud,credentials:()=>stores.cloud,config:cloudConfig,adapter:nativeTaskRuntimeAdapter(contexts.cloud,cloudConfig,rt.cloud,states.cloud)};let receiver=createOnboardingTaskRuntime(deps);t.after(()=>receiver.close());await receiver.apply(confirm(await receiver.preview({enabled:true})));
 const target={operationId:randomUUID(),installationId:randomUUID(),runtimeId:randomUUID(),manifestHash:'a'.repeat(64),root:'/isolated/target',role:'cloud',hostVersion:'0.2.1-rc.2'};let online=true;
 const remote=async(method,args,bound)=>{if(!online)throw Error('OFFLINE');if(bound)assert.deepEqual(bound,target);const {targetHash,...input}=args;return {target,value:await receiver.pairing[method.slice(10)](input)};};
 const localDeps={state:states.local,credentials:()=>stores.local,remote,enabled:()=>true,adapter:nativeLocalPairAdapter(contexts.local,{},rt.local)};let client=createOnboardingLocalPair(localDeps);t.after(()=>client.close());const s=await client.apply(confirm(await client.preview({enabled:true})));assert(s.mounted);let local=contexts.local.get('taskGateway'),cloud=contexts.cloud.get('taskGateway');assert.equal(local.c.role,'local');assert.equal(cloud.c.role,'cloud');
 const cloudState=await receiver.status({});assert(isManagedGatewayRuntime(cloud,cloudState));for(const patch of [{scheduler:{}},{development:{}},{deliveryRuntime:{}},{peer:null},{peer:{role:'local',namespace:cloud.peer.namespace}},{peer:{role:'cloud',namespace:'other'}}])assert(!isManagedGatewayRuntime({...cloud,...patch},cloudState));assert(!isManagedGatewayRuntime(cloud,{...cloudState,peerEnabled:false}));

 const accepted=await local.call('accept',{source:'integration',goal:'Only register',task_key:'local-native',ingress_id:'local-native'}),id=accepted.id;assert(id.startsWith('task-'));assert.equal(cloud.store.task(id).busy,0);await assert.rejects(local.call('schedule',{task_id:id}),/CAPABILITY_UNAVAILABLE/);
 local.peer.enqueue({id:'message-local',task_id:id,kind:'context',text:'local to cloud'});await local.tick();await cloud.tick();assert.equal(cloud.peer.read(id).messages.length,1);
 cloud.peer.enqueue({id:'message-cloud',task_id:id,kind:'result',text:'cloud to local'});await cloud.tick();await local.tick();assert.equal(local.peer.read(id).messages.length,1);
 online=false;local.peer.enqueue({id:'message-offline',task_id:id,kind:'context',text:'queued'});await local.tick();assert.equal(local.db.prepare("SELECT status FROM peer_outbox WHERE id='message-offline'").get().status,'queued');await client.close();await receiver.close();receiver=createOnboardingTaskRuntime(deps);await receiver.start();online=true;client=createOnboardingLocalPair(localDeps);await client.start();local=contexts.local.get('taskGateway');cloud=contexts.cloud.get('taskGateway');assert(local&&cloud);await local.tick();local.peer.now=()=>Date.now()+600000;await local.tick();await cloud.tick();assert.equal(cloud.peer.read(id).messages.length,2);await local.tick();assert.equal(local.peer.read(id).messages.length,1);assert(!cloud.scheduler&&!cloud.development&&!cloud.deliveryRuntime);
});


test('control drains active transport and rejects new frames until same-target reconciliation finishes',async t=>{
 const f=await fixture(t);await f.bind();const h=f.handles.at(-1);let release,draining=false;
 h.quiescent=async()=>{draining=true;await new Promise(r=>release=r);};const request=f.m.status({refresh:true});while(!draining)await new Promise(r=>setImmediate(r));
 await assert.rejects(h.transport('catalog',{}),/LOCAL_PAIR_BUSY/);assert((await f.m.status({refresh:false})).mounted);release();assert.equal((await request).freshness,'remote_checked');
 h.quiescent=async()=>{};assert.equal((await h.transport('catalog',{})).method,'catalog');
});
