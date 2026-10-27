import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGatewayMaintenance} from '../bundle/gateway-maintenance.js';
import {Gateway} from '../bundle/index.js';
import {createOnboardingService} from '../bundle/onboarding-host.js';
import {fileHash} from '../bundle/peer-file-fs.js';
import {errorInfo} from '../bundle/link-contract.js';
const confirmation=p=>({id:p.id,fingerprint:p.fingerprint,confirm:true});
const acquire=m=>m.apply(confirmation(m.preview({})));
const release=(m,s)=>m.release({operationId:s.operationId,instanceId:s.instanceId,confirm:true});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const turn=()=>new Promise(r=>setImmediate(r));
function unit(){const g={instanceId:'fixture',closed:false,deliveries:new Map()};let time=1000;return {g,m:createGatewayMaintenance(g,{now:()=>time}),advance:()=>time+=300001};}
test('preview is readonly and no caller arguments, queue content or stop grants escape',()=>{
 const {m}=unit(),p=m.preview({});assert(p.canApply);assert.equal(m.status().state,'open');assert(!p.hostStopAuthorized&&!p.pluginSwitchAuthorized);assert.equal(m.status().persisted,false);assert.throws(()=>m.status({extra:true}),/ARGUMENTS/);
});
test('tracked sync values/throws and rejected async work release their activity count',async()=>{
 const {m}=unit();assert.equal(m.run('sync',()=>4),4);assert.throws(()=>m.run('throw',()=>{throw Error('expected');}),/expected/);await assert.rejects(m.run('async',()=>Promise.reject(Error('expected'))));assert.equal(m.status().counts.requests,0);
});
test('late activity blocks an old plan without cancelling it or consuming its work',async()=>{
 const {m}=unit(),p=m.preview({}),d=deferred();const running=m.run('await',()=>d.promise);assert.equal(m.status().counts.requests,1);assert.throws(()=>m.apply(confirmation(p)),/BUSY/);assert.equal(m.status().state,'open');d.resolve('original');assert.equal(await running,'original');assert(m.preview({}).canApply);
});
test('same lease is idempotent, release is identity-bound, and old approval cannot relock',()=>{
 const {m}=unit(),p=m.preview({}),s=m.apply(confirmation(p));assert(m.apply(confirmation(p)).notResent);assert.throws(()=>m.run('new',()=>0),/PROTOCOL_MAINTENANCE_ACTIVE/);assert.throws(()=>release(m,{...s,instanceId:'other'}),/INSTANCE_CHANGED/);assert.throws(()=>release(m,{...s,operationId:'other'}),/OPERATION_CHANGED/);assert.equal(release(m,s).state,'open');assert(release(m,s).notResent);assert.throws(()=>m.apply(confirmation(p)),/RELEASED/);
});
test('expiry, closed gateway and changed process invalidate maintenance authority',()=>{
 const f=unit(),p=f.m.preview({});f.advance();assert.throws(()=>f.m.apply(confirmation(p)),/PLAN_EXPIRED/);const s=acquire(f.m),fresh=createGatewayMaintenance(f.g);assert.throws(()=>release(fresh,s),/INSTANCE_CHANGED/);f.g.closed=true;assert.throws(()=>f.m.status(),/CLOSED/);
});
test('closure proof requires the original clean finish, empty counters and storage closure',()=>{
 const {g,m}=unit(),held=acquire(m);assert.equal(m.closureStatus().state,'not_closed');g.closed=true;
 assert.equal(m.closureStatus().state,'unverified');let closed=0;
 m.completeClosure(()=>{closed++;assert.equal(m.closureStatus().state,'unverified');},true);
 const proof=m.closureStatus();assert.equal(proof.state,'closed');assert.equal(proof.instanceId,held.instanceId);assert.equal(proof.operationId,held.operationId);assert.equal(closed,1);
 assert(Object.values(proof.counts).every(n=>n===0));assert(!proof.hostStopAuthorized&&!proof.pluginSwitchAuthorized);assert(m.blocked);
 assert.throws(()=>m.completeClosure(()=>closed++,true),/ALREADY_RECORDED/);assert.equal(closed,1);
});
test('remaining work, listener, failed settlement or storage errors never produce closure proof',()=>{
 for(const kind of ['active','listener','rejected','storage','async_storage','still_open']){
  const {g,m}=unit();let done;if(kind==='active')done=m.enter('inflight');if(kind==='listener')g.server={listening:true};if(kind!=='still_open')g.closed=true;
  if(kind==='storage')assert.throws(()=>m.completeClosure(()=>{throw Error('DISK_FAILED');},true),/DISK_FAILED/);
  else if(kind==='async_storage')assert.throws(()=>m.completeClosure(()=>Promise.resolve(),true),/ASYNC_STORAGE/);
  else m.completeClosure(()=>{},kind!=='rejected');
  assert.notEqual(m.closureStatus().state,'closed',kind);done?.();assert.notEqual(m.closureStatus().state,'closed',kind);
 }
});
test('background execution, undrained endpoint and live file engine are not mistaken for idle',()=>{
 for(const [key,value] of [['scheduler',{active:new Map([['run',{}]])}],['files',{pending:Promise.resolve()}],['deliveryRuntime',{pending:null,preparations:new Map([['task',{}]])}],['development',{gate:{inflight:new Map([['operation',{}]])}}],['developmentPeer',{pending:new Set([1])}],['a2aEndpoint',{undrained:true}],['chatApproval',{running:Promise.resolve()}],['artifacts',{pending:new Set([1])}]]){
  const f=unit();f.g[key]=value;const p=f.m.preview({});assert(!p.canApply,key);assert.throws(()=>f.m.apply(confirmation(p)),/BUSY/);
 }
});
async function fixture(t,{scheduler=false}={}){
 const root=fs.mkdtempSync(join(tmpdir(),'s58-maintenance-'));
 for(const role of ['local','cloud'])for(const n of ['send','inbox'])fs.mkdirSync(join(root,role+'-'+n));
 const ctx={agents:{list:()=>[],get:()=>undefined},agentPresets:{composedPreset:()=> 'standard'},on(){},effect(){}};
 let now=Date.now();const secrets={localToken:'l'.repeat(32),cloudToken:'c'.repeat(32)};
 const conf=role=>({role,namespace:'s58-maintenance',port:0,entryMode:'native',stateDir:join(root,role),fileTransfers:{enabled:true,sendRoots:[join(root,role+'-send')],receiveRoot:join(root,role+'-inbox')}});
 const cloud=new Gateway(ctx,{...conf('cloud'),...(scheduler?{scheduler:{lockPort:0,intervalMs:60000,timeoutMs:10000}}:{})},{secrets,now:()=>now,scheduler:{allowEphemeralLock:true}});
 let local;t.after(async()=>{await local?.close();await cloud.close();fs.rmSync(root,{recursive:true,force:true});});
 await cloud.start();clearTimeout(cloud.timer);if(cloud.scheduler)clearInterval(cloud.scheduler.timer);await cloud.pending;
 local=new Gateway(ctx,{...conf('local'),coordinatorUrl:'http://127.0.0.1:'+cloud.server.address().port},{secrets,now:()=>now});
 const task=(await local.submit({goal:'maintenance fixture',task_key:'maintenance',source:'native-local',ingress_id:'first'})).task_id;
 return {root,cloud,local,task,advance:()=>now+=600000,
  enqueue(role,name,bytes=Buffer.from('original file')){fs.writeFileSync(join(root,role+'-send',name),bytes);return (role==='local'?local:cloud).files.enqueue({id:'file-'+fileHash(name),task_id:task,file:name});},
  async drain(){for(let n=0;n<4;n++){await local.files.sync();await cloud.files.sync();now+=600000;}}};
}
test('actual closed Gateway retains immutable closure identity after its databases close',async t=>{
 const f=await fixture(t),s=acquire(f.cloud.maintenance);await f.cloud.close();const proof=f.cloud.maintenance.closureStatus();
 assert.equal(proof.state,'closed');assert.equal(proof.operationId,s.operationId);assert.equal(proof.instanceId,s.instanceId);assert.throws(()=>f.cloud.maintenance.status(),/CLOSED/);
 assert.deepEqual(f.cloud.maintenance.closureStatus(),proof);assert(!f.cloud.server.listening);assert.throws(()=>f.cloud.store.db.prepare('SELECT 1'));
});
test('actual Gateway records no closure proof while original request remains unsettled',async t=>{
 const f=await fixture(t),d=deferred();f.cloud.pending=d.promise;const close=f.cloud.close();assert.equal(f.cloud.maintenance.closureStatus().state,'unverified');
 await turn();assert.equal(f.cloud.maintenance.closureStatus().state,'unverified');d.resolve();await close;assert.equal(f.cloud.maintenance.closureStatus().state,'closed');
});
test('actual cloud HTTP RPC refuses new work while held; health remains readable and queue stays intact',async t=>{
 const f=await fixture(t),s=acquire(f.cloud.maintenance);
 const a={goal:'queued while remote maintained',task_key:'held',source:'native-local',ingress_id:'held'};
 const result=await f.local.submit(a);assert.equal(result.status,'queued_locally');
 const before=f.local.db.prepare('SELECT status,attempts,last_error FROM submissions WHERE id=?').get('held');assert.equal(before.attempts,0);assert.equal(before.last_error,'PROTOCOL_MAINTENANCE_ACTIVE');assert.equal(before.status,'queued');
 const response=await fetch('http://127.0.0.1:'+f.cloud.server.address().port+'/health',{method:'POST',headers:{Authorization:'Bearer '+'c'.repeat(32)}});assert(response.ok);await response.arrayBuffer();
 assert.equal(f.cloud.store.db.prepare('SELECT count(*) n FROM tasks').get().n,1);release(f.cloud.maintenance,s);f.advance();await f.local.tick();assert.equal(f.local.db.prepare('SELECT status FROM submissions WHERE id=?').get('held').status,'accepted');
 assert.equal(f.cloud.store.db.prepare('SELECT count(*) n FROM tasks').get().n,2);
});
test('pending authorization is counted before its await and cannot be cut off by maintenance',async t=>{
 const f=await fixture(t),p=f.cloud.maintenance.preview({}),d=deferred();f.cloud.io.authorize=()=>d.promise;
 const call=f.cloud.call('diagnostics',{});assert.equal(f.cloud.maintenance.status().counts.requests,1);assert.throws(()=>f.cloud.maintenance.apply(confirmation(p)),/BUSY/);d.resolve();await call;delete f.cloud.io.authorize;assert.equal(f.cloud.maintenance.status().counts.requests,0);
});
test('local file queue does not run or change while held, resumes original snapshot after release',async t=>{
 const f=await fixture(t);f.enqueue('local','one.txt');const before=f.local.db.prepare('SELECT * FROM peer_file_out').all(),s=acquire(f.local.maintenance);
 assert.throws(()=>f.enqueue('local','two.txt'),/MAINTENANCE_ACTIVE/);await f.local.tick();await f.local.files.sync();assert.deepEqual(f.local.db.prepare('SELECT * FROM peer_file_out').all(),before);
 release(f.local.maintenance,s);await f.drain();assert.equal(f.cloud.files.list(f.task).received.length,1);assert.equal(f.cloud.files.list(f.task).received[0].availability,'available');
});
test('remote maintenance is a wait, not a file retry-budget loss or permanent failure',async t=>{
 const f=await fixture(t);f.enqueue('local','held.txt');const s=acquire(f.cloud.maintenance);
 for(let n=0;n<3;n++){await assert.rejects(f.local.files.sync(),/MAINTENANCE_ACTIVE/);f.advance();}
 const row=f.local.db.prepare('SELECT state,attempts,error FROM peer_file_out').get();assert.equal(row.state,'queued');assert.equal(row.attempts,0);assert.equal(row.error,'PEER_FILE_MAINTENANCE_WAIT');
 release(f.cloud.maintenance,s);await f.drain();assert.equal(f.local.files.list(f.task).sent[0].state,'received');
 assert.equal(errorInfo('PROTOCOL_MAINTENANCE_ACTIVE').category,'maintenance');
});
test('maintenance between download chunks retains partial bytes and does not consume retry budget',async t=>{
 const f=await fixture(t),bytes=Buffer.alloc(48*1024*3+7,91);f.enqueue('cloud','partial.dat',bytes);await f.cloud.files.sync();
 const original=f.local.call.bind(f.local);let held;
 f.local.call=async(method,args,...rest)=>{const value=await original(method,args,...rest);if(method==='peer_file_read'&&!held)held=acquire(f.cloud.maintenance);return value;};
 await f.local.files.sync();f.local.call=original;assert(held);
 const row=f.local.db.prepare('SELECT state,attempts,error FROM peer_file_in').get();assert.equal(row.state,'receiving');assert.equal(row.attempts,0);assert.equal(row.error,'PEER_FILE_MAINTENANCE_WAIT');
 release(f.cloud.maintenance,held);f.advance();await f.drain();const received=f.local.files.list(f.task).received[0];assert.equal(received.availability,'available');assert.deepEqual(fs.readFileSync(received.path),bytes);
});
test('existing task ownership prevents an idle claim without silently releasing the owner',async t=>{
 const f=await fixture(t);f.cloud.store.begin('cloud',{task_id:f.task,epoch:1});const p=f.cloud.maintenance.preview({});assert(!p.canApply);assert.equal(p.counts.taskOwnership,1);assert.throws(()=>f.cloud.maintenance.apply(confirmation(p)),/BUSY/);assert.equal(f.cloud.store.status(f.task).busy,1);
});
test('real scheduler preserves queued jobs while held and refuses maintenance during active work',async t=>{
 const f=await fixture(t,{scheduler:true}),d=deferred();let runs=0,aborted=false;
 f.cloud.scheduler.register('test.checkpoint',{replaySafe:true,async run(job,signal){runs++;signal.addEventListener('abort',()=>aborted=true);await d.promise;return {outcome:'done',summary:'fixture completed'};}});
 t.after(()=>d.resolve());const job=f.cloud.scheduler.jobs.enqueue({task_id:f.task,trigger_id:'queued',kind:'test.checkpoint',goal:'no model test'}),s=acquire(f.cloud.maintenance);
 f.cloud.scheduler.tick();assert.equal(runs,0);assert.equal(f.cloud.scheduler.jobs.get(job.id).attempts,0);release(f.cloud.maintenance,s);
 f.cloud.scheduler.tick();await turn();assert.equal(runs,1);const p=f.cloud.maintenance.preview({});assert(!p.canApply);assert.throws(()=>f.cloud.maintenance.apply(confirmation(p)),/BUSY/);assert(!aborted);
 d.resolve();await Promise.all([...f.cloud.scheduler.active.values()].map(x=>x.run));assert.equal(f.cloud.scheduler.jobs.get(job.id).status,'completed');assert.equal(f.cloud.scheduler.jobs.get(job.id).attempts,1);assert(!aborted);
});
test('public onboarding control is mounted-only, fences config operations, and releases without starting jobs',async t=>{
 const f=await fixture(t),service=createOnboardingService({}, {},{gateway:f.cloud}),absent=createOnboardingService({}, {});
 assert.equal((await service.call('describe',{})).capabilities.gatewayMaintenanceHoldContract,1);assert.equal((await absent.call('describe',{})).capabilities.gatewayMaintenanceHoldContract,0);
 const p=await service.call('gateway_hold_preview',{}),s=await service.call('gateway_hold_apply',confirmation(p));assert.equal(s.scope,'own_gateway_only');await assert.rejects(service.call('draft_save',{}),/GATEWAY_HOLD_ACTIVE/);assert.equal((await service.call('gateway_hold_status',{})).state,'held');
 await service.call('gateway_hold_release',{operationId:s.operationId,instanceId:s.instanceId,confirm:true});assert.equal(f.cloud.maintenance.status().state,'open');await assert.rejects(absent.call('gateway_hold_status',{}),/UNAVAILABLE/);
});
