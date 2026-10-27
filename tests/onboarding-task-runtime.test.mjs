import test from 'node:test';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {isManagedTaskRuntime,isManagedGatewayReceipt} from '../bundle/onboarding-task-runtime-contract.js';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,writeFile,symlink,realpath,stat,link} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createOnboardingTaskRuntime} from '../bundle/onboarding-task-runtime.js';
import {taskRuntimeLease} from '../bundle/onboarding-task-runtime-native.js';
import {createOnboardingService} from '../bundle/onboarding-host.js';
import {Gateway} from '../bundle/index.js';
function fixture(){
 const records=new Map();let calls=[],writes=0,lose=false,time=1700000000000,openingError=false,lock=false;
 const credentials={async readRecord(k){return structuredClone(records.get(k));},async describeRecord(){return {writable:true};},async modifyRecord(k,fn){const v=fn(structuredClone(records.get(k)));if(v!==undefined){records.set(k,v);writes++;}if(lose){lose=false;throw Error('LOST_RESPONSE');}}};
 const config={onboarding:{role:'cloud'}},state={available:()=>true};
 const adapter={async open(p,authorize){if(openingError)throw Error('START_FAILED');if(lock)throw Error('ONBOARDING_TASK_RUNTIME_ALREADY_RUNNING');lock=true;calls.push('open');let active=true;return {id:p.id,instanceId:randomUUID(),workerEnabled:p.workerEnabled===true,hold(){},port:12345,active:()=>active,async quiescent(){calls.push('quiescent');},async close(){calls.push('close');active=false;lock=false;},authorize};}};
 const deps={credentials:()=>credentials,state,adapter,config,now:()=>time};return {records,credentials,config,deps,manager:createOnboardingTaskRuntime(deps),calls,writes:()=>writes,lose:()=>{lose=true;},advance:n=>time+=n,error:v=>openingError=v};
}
const confirmation=p=>({id:p.id,fingerprint:p.fingerprint,confirm:true});
async function enable(m,enabled=true){return m.apply(confirmation(await m.preview({enabled})));}
test('fresh cloud guide status/preview does not persist or activate; no secrets returned',async()=>{
 const f=fixture();await f.manager.start();assert.equal((await f.manager.status()).state,'not_configured');const p=await f.manager.preview({enabled:true});assert.equal(f.writes(),0);assert.equal(f.calls.length,0);assert(!p.writeAuthorized&&!p.workerEnabled&&!p.peerEnabled);assert(!JSON.stringify(p).includes('Token'));
});
test('explicit enable starts intake and restart reuses original identity and authorization',async()=>{
 const f=fixture();const v=await enable(f.manager);assert(v.configured);assert.equal(v.state,'active');assert.equal(f.writes(),1);const record=[...f.records.values()][0].payload;assert(!JSON.stringify(v).includes(record.localToken));assert(!JSON.stringify(v).includes(record.cloudToken));await f.manager.close();const m=createOnboardingTaskRuntime(f.deps);await m.start();const next=await m.status();assert.equal(next.id,v.id);assert.equal(next.revision,v.revision);assert.equal(next.appliedOperation,v.appliedOperation);assert.notEqual(next.instanceId,v.instanceId);await m.close();
});
test('disable preserves tokens/identity and stops runtime; restart remains disabled',async()=>{
 const f=fixture();const a=await enable(f.manager);const before=[...f.records.values()][0].payload;const b=await enable(f.manager,false);assert.equal(b.state,'disabled');assert(!b.configured);const after=[...f.records.values()][0].payload;assert.equal(after.localToken,before.localToken);assert.equal(after.id,a.id);await f.manager.close();const m=createOnboardingTaskRuntime(f.deps);await m.start();assert.equal((await m.status()).state,'disabled');assert.equal(f.calls.filter(x=>x==='open').length,1);
});
test('expired or reused plan cannot repeat activation',async()=>{
 const f=fixture();let p=await f.manager.preview({enabled:true});f.advance(300001);await assert.rejects(f.manager.apply(confirmation(p)),/PLAN_EXPIRED/);p=await f.manager.preview({enabled:true});await f.manager.apply(confirmation(p));await assert.rejects(f.manager.apply(confirmation(p)),/PLAN_EXPIRED/);await f.manager.close();
});
test('lost CAS response persists intent, does not start blindly, restart can recover confirmed same grant',async()=>{
 const f=fixture(),p=await f.manager.preview({enabled:true});f.lose();await assert.rejects(f.manager.apply(confirmation(p)),/LOST_RESPONSE/);const s=await f.manager.status();assert.equal(s.state,'needs_review');assert.equal(s.appliedOperation,p.id);assert.equal(f.calls.length,0);await assert.rejects(f.manager.apply(confirmation(p)),/PLAN_EXPIRED/);await f.manager.close();const m=createOnboardingTaskRuntime(f.deps);await m.start();assert.equal((await m.status()).state,'active');await m.close();
});
test('startup failure is needs_review, status does not retry; explicit new enable can retry',async()=>{
 const f=fixture();f.error(true);const v=await enable(f.manager);assert.equal(v.state,'needs_review');assert.equal(v.error,'ONBOARDING_TASK_RUNTIME_START_REVIEW');assert.equal(f.calls.length,0);await f.manager.status();assert.equal(f.calls.length,0);f.error(false);assert.equal((await enable(f.manager)).state,'active');await f.manager.close();
});
test('competing tab CAS rejected; foreign/corrupt record never adopted',async()=>{
 const f=fixture(),m=createOnboardingTaskRuntime(f.deps),a=await f.manager.preview({enabled:true}),b=await m.preview({enabled:true});await f.manager.apply(confirmation(a));await assert.rejects(m.apply(confirmation(b)),/CONFLICT/);await f.manager.close();const key=[...f.records.keys()][0];f.records.set(key,{kind:'api-key',value:'untouched'});await assert.rejects(m.preview({enabled:true}),/RECORD_REVIEW/);assert.equal(f.records.get(key).value,'untouched');
});
test('static configured gateway or noncloud role cannot use managed activation',async()=>{
 for(const config of [{role:'cloud'},{onboarding:{role:'local'}},{},{stateDir:'/foreign',onboarding:{role:'cloud'}}]){const f=fixture(),m=createOnboardingTaskRuntime({...f.deps,config});assert.equal(m.available(),false);await assert.rejects(m.preview({enabled:true}),/UNAVAILABLE/);assert.equal(f.writes(),0);}
});
for(const args of [{enabled:true,port:123},{enabled:'true'},{role:'cloud'},{}])test('activation rejects untrusted config '+JSON.stringify(args),async()=>{await assert.rejects(fixture().manager.preview(args),/ARGUMENTS/);});
test('public service binds current runtime only and reports actual activation, never secrets',async()=>{
 const f=fixture();const runtime={credentials:f.credentials,taskRuntime:f.manager},s=createOnboardingService({},f.config,runtime);assert.equal((await s.call('describe',{})).configured,false);const p=await s.call('task_runtime_preview',{enabled:true});await s.call('task_runtime_apply',confirmation(p));assert.equal((await s.call('describe',{})).configured,true);assert.equal((await s.call('repository_registry_status',{})).runtimeConfigured,true);await enable(f.manager,false);assert.equal((await s.call('describe',{})).configured,false);await f.manager.close();
});
async function dirs(t){const home=await mkdtemp(path.join(await realpath(tmpdir()),'s56-task-runtime-'));t.after(()=>rm(home,{recursive:true,force:true}));const dsh=path.join(home,'.dsh');await mkdir(dsh,{mode:0o700});return {home,dsh,runtime:{home,env:{},platform:process.platform}};}
test('filesystem lease excludes second owner and releases without deleting state',async t=>{
 const f=await dirs(t),id=randomUUID();const a=await taskRuntimeLease({},f.runtime,id);await assert.rejects(taskRuntimeLease({},f.runtime,id),/ALREADY_RUNNING/);await writeFile(path.join(a.root,'history'),'keep',{mode:0o600});a.release();const b=await taskRuntimeLease({},f.runtime,id);assert.equal(await readFile(path.join(b.root,'history'),'utf8'),'keep');b.release();
});
test('unowned directory and symlink are rejected instead of adopted',async t=>{
 const f=await dirs(t),parent=path.join(f.dsh,'dual-host-task-runtime');await mkdir(parent,{mode:0o700});let id=randomUUID();await mkdir(path.join(parent,id),{mode:0o700});await assert.rejects(taskRuntimeLease({},f.runtime,id));id=randomUUID();await symlink(f.home,path.join(parent,id));await assert.rejects(taskRuntimeLease({},f.runtime,id),/PATH_REVIEW/);
});
test('actual Gateway intake has no worker/writer/peer and guard rejects disabled control',async t=>{
 const f=await dirs(t);let allowed=true;const g=new Gateway({on(){},effect(){},agents:{list:()=>[]}},{role:'cloud',stateDir:path.join(f.home,'state'),port:0,entryMode:'native',peerEnabled:false},{secrets:{localToken:'l'.repeat(64),cloudToken:'c'.repeat(64)},authorize:async()=>{if(!allowed)throw Error('ONBOARDING_TASK_RUNTIME_DISABLED');}});t.after(()=>g.close());await g.start();assert(!g.scheduler&&!g.development&&!g.deliveryRuntime&&!g.peer);assert.equal(g.server.address().address,'127.0.0.1');const before=g.store.db.prepare('SELECT count(*) AS n FROM tasks').get().n;allowed=false;await assert.rejects(g.call('accept',{goal:'no',task_key:'a',ingress_id:'b'}),/DISABLED/);await assert.rejects(g.submit({}),/DISABLED/);assert.equal(g.store.db.prepare('SELECT count(*) AS n FROM tasks').get().n,before);
});

test('SQLite databases are private from creation and lease rejects linked state',async t=>{
 const f=await dirs(t),id=randomUUID(),a=await taskRuntimeLease({},f.runtime,id);
 for(const n of ['state/gateway.sqlite','state/coordinator/tasks.sqlite'])assert.equal((await stat(path.join(a.root,n))).mode&0o777,0o600);
 a.release();const external=path.join(f.home,'external');await writeFile(external,'keep',{mode:0o600});await symlink(external,path.join(a.root,'state/linked'));await assert.rejects(taskRuntimeLease({},f.runtime,id),/PATH_REVIEW/);assert.equal(await readFile(external,'utf8'),'keep');
});
test('hardlink and traversal runtime identities are rejected',async t=>{
 const f=await dirs(t);await assert.rejects(taskRuntimeLease({},f.runtime,'../foreign'),/ARGUMENTS/);
 const id=randomUUID(),a=await taskRuntimeLease({},f.runtime,id);a.release();const ext=path.join(f.home,'external');await writeFile(ext,'keep',{mode:0o600});await link(ext,path.join(a.root,'linked'));await assert.rejects(taskRuntimeLease({},f.runtime,id),/PATH_REVIEW/);
});
test('cross-process lease blocks overlap and crash releases without deleting grant state',async t=>{
 const f=await dirs(t),id=randomUUID(),url=new URL('../bundle/onboarding-task-runtime-native.js',import.meta.url).href;
 const source=`import {taskRuntimeLease} from ${JSON.stringify(url)}; const lease=await taskRuntimeLease({},${JSON.stringify(f.runtime)},${JSON.stringify(id)});process.send('locked');setInterval(()=>{},60000);`;
 const child=spawn(process.execPath,['--input-type=module','-e',source],{stdio:['ignore','ignore','ignore','ipc'],env:{PATH:process.env.PATH,HOME:f.home}});t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
 await Promise.race([once(child,'message'),once(child,'exit').then(()=>{throw Error('CHILD_EXITED_BEFORE_LEASE');})]);
 await assert.rejects(taskRuntimeLease({},f.runtime,id),/ALREADY_RUNNING/);const ended=once(child,'exit');child.kill('SIGKILL');await ended;const next=await taskRuntimeLease({},f.runtime,id);assert.equal(JSON.parse(await readFile(path.join(next.root,'owner.json'))).id,id);next.release();
});
test('restart admission accepts owned intake-only receipt, never arbitrary gateway',async()=>{
 const f=fixture(),s=await enable(f.manager);assert(isManagedTaskRuntime(s));assert(isManagedGatewayReceipt({gatewayBound:true,runtimeScopeVerified:true,taskRuntime:s}));
 for(const change of [{workerEnabled:true},{writeAuthorized:true},{peerEnabled:true},{publishEnabled:true},{owned:false},{id:'bad'},{listen:'0.0.0.0'},{port:0},{state:'needs_review'},{configured:false},{role:'local'},{revision:0},{error:'error'}])assert(!isManagedTaskRuntime({...s,...change}));
 assert(!isManagedGatewayReceipt({gatewayBound:true,taskRuntime:s}));assert(!isManagedGatewayReceipt({gatewayBound:true,runtimeScopeVerified:true}));await f.manager.close();
});

test('read-only worker requires explicit separate consent; never sets a model or write grant',async()=>{
 const f=fixture();await enable(f.manager);let s=await f.manager.status();assert(!s.workerDesiredEnabled&&!s.workerEnabled);
 const p=await f.manager.preview({enabled:true,workerEnabled:true});assert(p.workerEnabled);assert(!p.writeAuthorized&&!p.publishEnabled);assert(!JSON.stringify(p).includes('model'));
 s=await f.manager.apply(confirmation(p));assert(s.workerDesiredEnabled&&s.workerEnabled);assert(isManagedTaskRuntime(s));
 await f.manager.close();const n=createOnboardingTaskRuntime(f.deps);await n.start();s=await n.status();assert(s.workerEnabled);assert.equal(s.appliedOperation,p.id);
 const off=await enable(n);assert(off.configured&&!off.workerEnabled&&!off.workerDesiredEnabled);await n.close();
});
test('old schema intake authorization never gains worker permission during startup or fence',async()=>{
 const f=fixture();await enable(f.manager);await f.manager.close();const [k,r]=[...f.records][0];r.payload.schema=1;delete r.payload.workerEnabled;f.records.set(k,r);const n=createOnboardingTaskRuntime(f.deps);await n.start();const s=await n.status();assert(!s.workerEnabled&&!s.workerDesiredEnabled);
 const after=await n.fence({operation:randomUUID(),expectedRevision:s.revision,confirm:true});assert(!after.workerEnabled&&!after.workerDesiredEnabled);await n.close();
});
test('fence preserves explicit worker authorization without restarting it',async()=>{
 const f=fixture(),s=await f.manager.apply(confirmation(await f.manager.preview({enabled:true,workerEnabled:true})));const after=await f.manager.fence({operation:randomUUID(),expectedRevision:s.revision,confirm:true});assert(after.workerEnabled&&after.workerDesiredEnabled);assert.equal(after.instanceId,s.instanceId);await f.manager.close();
});
test('worker desired/live mismatch cannot be presented as an active authorized runtime',async()=>{
 const f=fixture(),bad=createOnboardingTaskRuntime({...f.deps,adapter:{async open(p){return {id:p.id,workerEnabled:false,active:()=>true,close:async()=>{}};}}});const p=await bad.preview({enabled:true,workerEnabled:true}),s=await bad.apply(confirmation(p));assert(s.workerDesiredEnabled&&!s.workerEnabled&&!s.configured);assert.equal(s.state,'needs_review');assert.equal(s.error,'ONBOARDING_TASK_RUNTIME_WORKER_START_REVIEW');await bad.close();
});
test('lost revoke response stops own runtime and does not execute under uncertain authorization',async()=>{
 const f=fixture();await f.manager.apply(confirmation(await f.manager.preview({enabled:true,workerEnabled:true})));const p=await f.manager.preview({enabled:true,workerEnabled:false});f.lose();await assert.rejects(f.manager.apply(confirmation(p)),/LOST_RESPONSE/);const s=await f.manager.status();assert(!s.configured&&!s.workerEnabled&&!s.workerDesiredEnabled);assert.equal(s.state,'needs_review');await f.manager.close();const n=createOnboardingTaskRuntime(f.deps);await n.start();assert(!(await n.status()).workerEnabled);await n.close();
});
test('worker permission cannot be enabled while intake is disabled or via extra fields',async()=>{
 for(const a of [{enabled:false,workerEnabled:true},{enabled:true,workerEnabled:'true'},{enabled:true,workerEnabled:true,development:true}])await assert.rejects(fixture().manager.preview(a),/ARGUMENTS/);
});
test('pair changes require worker disabled first; existing paired traffic is not reauthorized',async()=>{
 const f=fixture();await f.manager.apply(confirmation(await f.manager.preview({enabled:true,workerEnabled:true})));await assert.rejects(f.manager.pairing.preview({enabled:true,localId:randomUUID()}),/WORKER_DISABLE_REQUIRED/);await f.manager.close();
});
test('busy own admission hold rejects worker revocation before any credential mutation',async()=>{
 const f=fixture();let busy=false;const adapter={async open(p){return {id:p.id,instanceId:randomUUID(),port:12345,workerEnabled:p.workerEnabled,active:()=>true,quiescent:async()=>{},hold(){if(busy)throw Error('ONBOARDING_TASK_RUNTIME_BUSY');},close:async()=>{}};}};const m=createOnboardingTaskRuntime({...f.deps,adapter});await m.apply(confirmation(await m.preview({enabled:true,workerEnabled:true})));const p=await m.preview({enabled:true,workerEnabled:false}),writes=f.writes();busy=true;await assert.rejects(m.apply(confirmation(p)),/BUSY/);assert.equal(f.writes(),writes);assert((await m.status()).workerEnabled);await m.close();
});
