import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createOnboardingTaskRuntime} from '../bundle/onboarding-task-runtime.js';
import {nativeTaskRuntimeAdapter} from '../bundle/onboarding-task-runtime-native.js';
import {peerBindingKey} from '../bundle/onboarding-peer-binding.js';
import {createOnboardingState} from '../bundle/onboarding-state.js';
import {createOnboardingRepository} from '../bundle/onboarding-repository.js';
import {createOnboardingRepositories} from '../bundle/onboarding-repositories.js';
import {createOnboardingService} from '../bundle/onboarding-host.js';
import {isManagedTaskRuntime,cloudTaskRuntimeStatus} from '../bundle/onboarding-task-runtime-contract.js';
import {DirectLink,VERSION,CAPABILITIES} from '../bundle/link-contract.js';
import {PeerMailbox} from '../bundle/peer-mailbox.js';
const KEY='dsh-task-gateway/onboarding-peer-binding-v1';
const confirm=p=>({id:p.id,fingerprint:p.fingerprint,confirm:true});
const frame={method:'negotiate',args:{}};
function credentials(){const records=new Map();let writes=0,lose=false;return {records,writes:()=>writes,lose:()=>lose=true,readRecord:async k=>structuredClone(records.get(k)),describeRecord:async()=>({writable:true}),async modifyRecord(k,fn){const v=fn(structuredClone(records.get(k)));if(v!==undefined){records.set(k,structuredClone(v));writes++;}if(lose){lose=false;throw Error('LOST_REPLY');}}};}
function fixture(t){
 const c=credentials(),localId=randomUUID(),opens=[];let time=1700000000000,pendingForward=null,failOpen=false;
 const adapter={async open(p){if(failOpen)throw Error('OPEN_FAILED');let active=true;const h={id:p.id,instanceId:randomUUID(),pairingKey:peerBindingKey(p.pairing),port:12345,hold(){},active:()=>active,quiescent:async()=>{},close:async()=>{active=false;},forward:async f=>pendingForward?pendingForward:({ok:true,value:f})};opens.push(h);return h;}};
 const deps={state:{available:()=>true},credentials:()=>c,config:{onboarding:{role:'cloud'}},adapter,platform:'linux',now:()=>time};let manager=createOnboardingTaskRuntime(deps);t.after(()=>manager.close());
 return {c,localId,opens,get m(){return manager;},advance:n=>time+=n,fail:v=>failOpen=v,hold:p=>pendingForward=p,async restart(){await manager.close();manager=createOnboardingTaskRuntime(deps);await manager.start();},async enable(){return manager.apply(confirm(await manager.preview({enabled:true})));},async bind(enabled=true){return manager.pairing.apply(confirm(await manager.pairing.preview({enabled,localId})));}};
}
const envelope=(s,f=frame)=>({id:s.id,localId:s.localId,revision:s.revision,frame:f});
test('pairing is separate explicit consent, preview/read do not write, no tokens in receipts',async t=>{
 const f=fixture(t);assert(!(await f.m.pairing.status()).enabled);await assert.rejects(f.m.pairing.preview({enabled:true,localId:f.localId}),/RUNTIME_NOT_READY/);
 await f.enable();const before=f.c.writes(),p=await f.m.pairing.preview({enabled:true,localId:f.localId});assert.equal(f.c.writes(),before);assert.equal(f.opens.length,1);
 const s=await f.m.pairing.apply(confirm(p));assert(s.enabled&&s.mounted);assert.equal(s.revision,1);assert.equal(f.opens.length,2);assert(!s.workerEnabled&&!s.writeAuthorized&&!s.publishEnabled);
 const runtime=await f.m.status();assert(isManagedTaskRuntime(runtime));assert.equal(cloudTaskRuntimeStatus(runtime),runtime);
 const grant=f.c.records.get('dsh-task-gateway/onboarding-task-runtime-v1').payload;for(const secret of [grant.localToken,grant.cloudToken])assert(!JSON.stringify({p,s,runtime}).includes(secret));
 const writes=f.c.writes();await f.m.pairing.apply(confirm(p));assert.equal(f.c.writes(),writes);assert.equal(f.opens.length,2);
});
test('restart restores same peer grant and namespace, not a new authorization or worker',async t=>{
 const f=fixture(t);await f.enable();const p=await f.bind(),r=await f.m.status(),writes=f.c.writes();await f.restart();const next=await f.m.status();assert.deepEqual(next.pairing,p);assert.notEqual(next.instanceId,r.instanceId);assert.equal(f.c.writes(),writes);assert(!next.workerEnabled&&!next.writeAuthorized);
});
test('stop intake requires explicit peer revocation; a disabled pair stays disabled after restart',async t=>{
 const f=fixture(t);await f.enable();await f.bind();await assert.rejects(f.m.preview({enabled:false}),/PAIR_REVOKE_REQUIRED/);const s=await f.bind(false);assert(!s.enabled&&!s.mounted);const p=await f.m.preview({enabled:false});await f.m.apply(confirm(p));await f.restart();assert.equal((await f.m.status()).state,'disabled');assert(!(await f.m.pairing.status()).enabled);
});
test('one controller cannot be replaced even after disable, preventing historical mailbox disclosure',async t=>{
 const f=fixture(t);await f.enable();await f.bind();await f.bind(false);await assert.rejects(f.m.pairing.preview({enabled:true,localId:randomUUID()}),/OWNER_MISMATCH/);assert.equal((await f.m.pairing.status()).localId,f.localId);
});
test('unknown first bind can be fenced as a disabled tombstone, late confirm rejected',async t=>{
 const f=fixture(t);await f.enable();const p=await f.m.pairing.preview({enabled:true,localId:f.localId});const s=await f.m.pairing.fence({operation:randomUUID(),expectedRevision:0,id:p.pairId,localId:p.localId,runtimeId:p.runtimeId,confirm:true});assert(!s.enabled&&!s.mounted);assert.equal(s.revision,1);await assert.rejects(f.m.pairing.apply(confirm(p)),/CONFLICT/);assert.equal(f.opens.length,1);
});
test('fence preserves active pair, rejects old frames and blocks late revoke',async t=>{
 const f=fixture(t);await f.enable();const s=await f.bind(),before=await f.m.status(),p=await f.m.pairing.preview({enabled:false,localId:f.localId});const next=await f.m.pairing.fence({operation:randomUUID(),expectedRevision:s.revision,id:s.id,localId:s.localId,runtimeId:s.runtimeId,confirm:true});assert(next.enabled&&next.mounted);assert.equal((await f.m.status()).instanceId,before.instanceId);await assert.rejects(f.m.pairing.forward(envelope(s)),/AUTH_DENIED/);await assert.rejects(f.m.pairing.apply(confirm(p)),/CONFLICT/);assert.equal((await f.m.pairing.forward(envelope(next))).ok,true);
});
test('lost binding write is reconciled without resending; same grant mounts on restart',async t=>{
 const f=fixture(t);await f.enable();const p=await f.m.pairing.preview({enabled:true,localId:f.localId});f.c.lose();await assert.rejects(f.m.pairing.apply(confirm(p)),/LOST_REPLY/);const s=await f.m.pairing.status();assert(s.enabled&&!s.mounted);assert.equal(s.appliedOperation,p.id);const writes=f.c.writes();assert(!(await f.m.pairing.apply(confirm(p))).mounted);assert.equal(f.c.writes(),writes);await f.restart();assert((await f.m.pairing.status()).mounted);assert.equal(f.c.writes(),writes);
});
test('mount failure keeps grant but never claims mounted success; status never retries',async t=>{
 const f=fixture(t);await f.enable();f.fail(true);const s=await f.bind();assert(s.enabled&&!s.mounted);assert.equal((await f.m.status()).state,'needs_review');const count=f.opens.length;await f.m.pairing.status();assert.equal(f.opens.length,count);f.fail(false);await f.restart();assert((await f.m.pairing.status()).mounted);
});
test('in-flight frame blocks mutation; auth and admission share the runtime mutex',async t=>{
 const f=fixture(t);await f.enable();const s=await f.bind();let resolve;f.hold(new Promise(r=>resolve=r));const send=f.m.pairing.forward(envelope(s));await new Promise(r=>setImmediate(r));await assert.rejects(f.m.pairing.preview({enabled:false,localId:f.localId}),/BUSY/);await assert.rejects(f.m.pairing.fence({operation:randomUUID(),expectedRevision:s.revision,id:s.id,localId:s.localId,runtimeId:s.runtimeId,confirm:true}),/BUSY/);resolve({ok:true,value:{}});await send;assert(!(await f.bind(false)).enabled);
});
test('foreign/malformed records, expired plans and injected forward fields are refused',async t=>{
 const f=fixture(t);await f.enable();let p=await f.m.pairing.preview({enabled:true,localId:f.localId});f.advance(300001);await assert.rejects(f.m.pairing.apply(confirm(p)),/PLAN_EXPIRED/);const s=await f.bind();
 for(const changes of [{localId:randomUUID()},{id:randomUUID()},{revision:99}])await assert.rejects(f.m.pairing.forward({...envelope(s),...changes}),/AUTH_DENIED/);
 for(const changes of [{url:'http://invalid'},{frame:{method:'exec',args:{}}},{frame:{method:'catalog',args:{text:'x'.repeat(131073)}}},{frame:{method:'catalog',args:{},role:'cloud'}}])await assert.rejects(f.m.pairing.forward({...envelope(s),...changes}),/ARGUMENTS|FRAME_INVALID/);
 f.c.records.set(KEY,{kind:'api-key',value:'KEEP'});await assert.rejects(f.m.pairing.status(),/RECORD_REVIEW/);assert.equal(f.c.records.get(KEY).value,'KEEP');
});
test('public own RPC advertises and exposes separate pairing, never arbitrary transport',async t=>{
 const f=fixture(t),rpc=createOnboardingService({}, {onboarding:{role:'cloud'}},{credentials:f.c,taskRuntime:f.m});assert.equal((await rpc.call('describe',{})).capabilities.managedPeerBindingContract,1);await f.enable();const p=await rpc.call('task_pair_preview',{enabled:true,localId:f.localId});const s=await rpc.call('task_pair_apply',confirm(p));assert((await rpc.call('task_pair_forward',envelope(s))).ok);await assert.rejects(rpc.call('task_pair_forward',{...envelope(s),token:'NO'}),/ARGUMENTS/);
});

// Small lifecycle harness; real product Gateway, SQLite, protocol and repository
// code below. This is integration testing, not an official Host GUI acceptance.
function lifecycle(){
 const services=new Map();function scope(){const owned=[],disposers=[],children=[];return {get:k=>services.get(k),on(){},inject(){},agents:{list:()=>[]},provide(k,v){services.set(k,v);owned.push([k,v]);},effect(f){disposers.push(f());},plugin(spec){const child=scope();children.push(child);const ready=spec.inject?.includes('taskGateway')?Promise.resolve():Promise.resolve(spec.apply(child));return {await:()=>ready,dispose:()=>child.dispose()};},async dispose(){for(const c of children)await c.dispose();for(const d of disposers.reverse())await d?.();for(const [k,v] of owned)if(services.get(k)===v)services.delete(k);}};}return scope();
}
test('real native adapter HTTP enforces peer role/namespace/instance and task capabilities; mailbox survives restart',async t=>{
 const home=await mkdtemp(path.join(await realpath(tmpdir()),'s56-peer-native-'));t.after(()=>rm(home,{recursive:true,force:true}));await mkdir(path.join(home,'.dsh'),{mode:0o700});
 const c=credentials(),ctx=lifecycle(),config={onboarding:{role:'cloud'}},runtime={home,env:{},platform:process.platform,credentials:c},state=createOnboardingState({},config,runtime);
 const repoSecret='SYNTHETIC_GITEE_TARGET_ONLY',reads=[];
 runtime.repositoryFetch=async(u,o)=>{assert(u.startsWith('https://gitee.com/api/v5/repos/fixture/results'));assert.equal(o.method,'GET');assert.equal(o.redirect,'error');assert.equal(o.headers.Authorization,'Bearer '+repoSecret);reads.push(u);return Response.json(u.includes('/branches/')?{name:'main',commit:{sha:'a'.repeat(40)}}:{id:27,full_name:'fixture/results',private:true,default_branch:'main'});};
 await state.put({slot:'gitee',secret:repoSecret,expectedRevision:0,operation:randomUUID(),confirm:true});
 const registry=createOnboardingRepositories({state,credentials:()=>c,config,runtime,repository:createOnboardingRepository({state,config,runtime})});await registry.apply(confirm(await registry.preview({url:'https://gitee.com/fixture/results',alias:'测试成果',authentication:'managed',enabled:true})));
 const deps={state,credentials:()=>c,config,adapter:nativeTaskRuntimeAdapter(ctx,config,runtime,state)};let m=createOnboardingTaskRuntime(deps);t.after(()=>m.close());
 await m.apply(confirm(await m.preview({enabled:true})));const localId=randomUUID(),p=await m.pairing.preview({enabled:true,localId}),s=await m.pairing.apply(confirm(p));assert(s.mounted);
 let hello={schema:1,protocol:{min:1,max:1},plugin_version:VERSION,role:'local',namespace:s.namespace,instance_id:randomUUID(),capabilities:CAPABILITIES};
 const transport=async(method,args,contract)=>{const r=await m.pairing.forward(envelope(s,{method,args,...(contract?{contract}:{})}));if(!r.ok)throw Error(r.error);return r.value;};
 const link=new DirectLink(()=>hello,transport);const h=await link.handshake();assert(h.capabilities.peer&&!h.capabilities.scheduler&&!h.capabilities.development&&!h.capabilities.delivery_push);
 const repositoryRead=await link.call('repository_resolve',{reference:'测试成果'});assert.equal(repositoryRead.result.repository_id,27);assert.equal(repositoryRead.result.access.write,'unknown');assert(!JSON.stringify(repositoryRead).includes(repoSecret));assert.equal(reads.length,4);
 const accepted=await link.call('accept',{source:'unit-test',goal:'Isolated register-only fixture',task_key:'pair-unit',ingress_id:'pair-unit'}),id=accepted.result.id;assert(id.startsWith('task-'));
 for(const method of ['schedule','development_schedule','delivery_schedule','delivery_push_schedule'])await assert.rejects(link.call(method,{task_id:id}),/CAPABILITY_UNAVAILABLE/);
 await assert.rejects(transport('catalog',{}),/PROTOCOL_NEGOTIATION_REQUIRED/);await assert.rejects(transport('catalog',{}, {hello,peer_instance:randomUUID()}),/PROTOCOL_INSTANCE_CHANGED/);
 const good=hello;hello={...good,namespace:'wrong'};await assert.rejects(link.handshake(),/NAMESPACE_MISMATCH/);hello={...good,role:'cloud'};await assert.rejects(link.handshake(),/ROLE_MISMATCH/);hello=good;
 let clock=1700000000000;const db=new DatabaseSync(path.join(home,'local-mailbox.sqlite'));t.after(()=>db.close());const local=new PeerMailbox(db,{role:'local',namespace:s.namespace,now:()=>clock});
 local.enqueue({id:'local-1',task_id:id,kind:'context',text:'Local context'});const call=async(method,args)=>(await link.call(method,args)).result;await local.sync(call);
 const cloud=ctx.get('taskGateway');await cloud.peer.sync((method,args)=>cloud.call(method,args,'cloud'));assert.equal(cloud.peer.read(id).messages.length,1);
 cloud.peer.enqueue({id:'cloud-1',task_id:id,kind:'result',text:'Cloud result'});await cloud.peer.sync((method,args)=>cloud.call(method,args,'cloud'));await local.sync(call);assert.equal(local.read(id).messages[0].text,'Cloud result');
 await m.close();local.enqueue({id:'local-offline',task_id:id,kind:'context',text:'Queued during restart'});await assert.rejects(local.sync(call));assert.equal(db.prepare("SELECT status FROM peer_outbox WHERE id='local-offline'").get().status,'queued');
 m=createOnboardingTaskRuntime(deps);await m.start();assert.deepEqual(await m.pairing.status(),s);clock+=600000;await local.sync(call);const restarted=ctx.get('taskGateway');await restarted.peer.sync((method,args)=>restarted.call(method,args,'cloud'));assert.equal(restarted.peer.read(id).messages.length,2);await local.sync(call);assert.equal(local.read(id).messages.length,1);assert(!restarted.scheduler&&!restarted.development&&!restarted.deliveryRuntime);
 await state.remove({slot:'gitee',expectedRevision:1,operation:randomUUID(),confirm:true});const before=reads.length;await assert.rejects(link.call('repository_resolve',{reference:'测试成果'}),/CREDENTIAL_REQUIRED/);assert.equal(reads.length,before);
});

test('failed mount can still be explicitly revoked without manufacturing a healthy process',async t=>{
 const f=fixture(t);await f.enable();f.fail(true);await f.bind();assert(!(await f.m.pairing.status()).mounted);const s=await f.bind(false);assert(!s.enabled&&!s.mounted);const p=await f.m.preview({enabled:false});assert.equal((await f.m.apply(confirm(p))).state,'disabled');
});
