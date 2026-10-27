// Actual self-owned Gateway + loopback transport + SQLite; no DSH process,
// model/provider network, repository filesystem or Git writes.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';
import {Gateway} from '../bundle/index.js';
import {CAPABILITIES,requireCapability,validateHello} from '../bundle/link-contract.js';
import {deliveryActions} from '../bundle/delivery-state.js';
async function setup(t,enabled=false,execute=false,push=false,pushExecute=false){
 const root=mkdtempSync(tmpdir()+'/delivery-gateway-'),tokenFile=root+'/tokens.json';
 writeFileSync(tokenFile,JSON.stringify({localToken:'l'.repeat(32),cloudToken:'c'.repeat(32)}),{mode:0o600});
 const ctx={get:()=>null,on(){},effect(){},agents:{get:()=>null,list:()=>[]},agentPresets:{composedPreset:()=> 'standard'}};
 const config={namespace:'delivery-runtime-test',role:'cloud',port:0,tokenFile,stateDir:root+'/cloud',peerEnabled:false,entryMode:'native',
  ...(enabled?{scheduler:{lockPort:0},development:{enabled:true,bindings:{}},delivery:{enabled:true,execute,...(push?{push:{enabled:true,execute:pushExecute,keyFile:'/synthetic-key',knownHostsFile:'/synthetic-known-hosts'}}:{}),author:{name:'Unit',email:'unit@example.invalid'},committer:{name:'Unit',email:'unit@example.invalid'}}}:{})};
 let cloud=new Gateway(ctx,config,{scheduler:{allowEphemeralLock:true},delivery:{push:()=>{throw Error('SYNTHETIC_NO_TRANSPORT');}}});await cloud.start();
 const local=new Gateway(ctx,{namespace:config.namespace,role:'local',port:0,tokenFile,stateDir:root+'/local',peerEnabled:false,entryMode:'native',coordinatorUrl:'http://127.0.0.1:'+cloud.server.address().port});
 t.after(async()=>{await local.close();await cloud.close();rmSync(root,{recursive:true,force:true});});
 return {get cloud(){return cloud;},local,async restart(){await cloud.close();cloud=new Gateway(ctx,config,{scheduler:{allowEphemeralLock:true},delivery:{push:()=>{throw Error('SYNTHETIC_NO_TRANSPORT');}}});await cloud.start();local.c.coordinatorUrl='http://127.0.0.1:'+cloud.server.address().port;}};
}
test('default Gateway does not construct or migrate execution ledger; legacy status stays available',async t=>{
 const f=await setup(t);assert(!f.cloud.deliveryRuntime);assert(!f.cloud.hello().capabilities.delivery_commit_plan);
 const before=f.cloud.store.db.prepare('SELECT total_changes() n').get().n;
 const s=deliveryActions(f.cloud,'unknown');assert.equal(s.available,false);assert.equal(f.cloud.store.db.prepare('SELECT total_changes() n').get().n,before);
 assert.equal(f.cloud.store.db.prepare("SELECT name FROM sqlite_master WHERE name='delivery_actions'").get(),undefined);
 await assert.rejects(f.local.call('delivery_prepare',{}),/CAPABILITY_UNAVAILABLE/);
});
test('real loopback negotiates staging only; execute remains off across same-state Gateway restart',async t=>{
 const f=await setup(t,true);assert(f.cloud.deliveryRuntime.started);assert.equal(f.cloud.hello().capabilities.delivery_commit_plan,1);assert(!f.cloud.hello().capabilities.delivery_commit);
 await assert.rejects(f.local.call('delivery_schedule',{}),/CAPABILITY_UNAVAILABLE/);
 await assert.rejects(f.local.call('delivery_prepare',{}),/INVALID_STAGE/);
 const task=f.cloud.store.accept('cloud',{task_key:'fixture',ingress_id:'fixture',source:'unit'});
 const s=await f.local.call('delivery_status',{task_id:task.id});assert.equal(s.execution.available,true);assert.equal(s.execution.total,0);assert.equal(s.execution.execution_enabled,false);
 await f.restart();assert.equal((await f.local.call('delivery_status',{task_id:task.id})).execution.execution_enabled,false);
 assert.equal(f.cloud.store.db.prepare('SELECT count(*) n FROM delivery_actions').get().n,0);
});
test('explicit enabled runtime advertises execution but rejects unbound schedule; no task appears',async t=>{
 const f=await setup(t,true,true);assert.equal(f.cloud.hello().capabilities.delivery_commit,1);
 await assert.rejects(f.local.call('delivery_schedule',{}),/INVALID_SCHEDULE/);assert.equal(f.cloud.store.db.prepare('SELECT count(*) n FROM delivery_actions').get().n,0);
});
test('old peer cannot accept new exact commit references, legacy preview and intake remain compatible',()=>{
 const base={schema:1,protocol:{min:1,max:1},plugin_version:'0.24.0-alpha.7',namespace:'unit',instance_id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'};
 const local={...base,role:'local',capabilities:{...CAPABILITIES}},cloud={...base,role:'cloud',capabilities:{...CAPABILITIES}};
 delete cloud.capabilities.delivery_commit_plan;delete cloud.capabilities.delivery_commit;
 assert.throws(()=>requireCapability('delivery_prepare',local,cloud),/CAPABILITY_UNAVAILABLE/);
 assert.throws(()=>requireCapability('delivery_schedule',local,cloud),/CAPABILITY_UNAVAILABLE/);
 assert.throws(()=>requireCapability('approval_request',local,cloud,{proposal:{delivery:{kind:'commit-execution-reference-v1'}}}),/CAPABILITY_VERSION_INCOMPATIBLE/);
 assert.doesNotThrow(()=>requireCapability('approval_request',local,cloud,{proposal:{delivery:{preview_id:'old'}}}));
 assert.doesNotThrow(()=>requireCapability('accept',local,cloud));
});

test('Gateway shutdown stops new scheduler claims while retaining owner for in-flight cleanup',async t=>{
 const f=await setup(t,true),task=f.cloud.store.accept('cloud',{task_key:'stop-fixture',ingress_id:'stop-fixture',source:'unit'});
 assert(f.cloud.scheduler.c.canClaim({kind:'plan',task_id:task.id}));f.cloud.closed=true;
 assert.equal(f.cloud.scheduler.c.canClaim({kind:'plan',task_id:task.id}),false);assert(f.cloud.scheduler.lock.listening);
});

test('loopback negotiates push staging separately; no execution until its own switch',async t=>{
 const f=await setup(t,true,false,true);assert.equal(f.cloud.hello().capabilities.delivery_push_plan,1);assert(!f.cloud.hello().capabilities.delivery_push);
 await assert.rejects(f.local.call('delivery_push_prepare',{}),/INVALID_PUSH_STAGE/);
 await assert.rejects(f.local.call('delivery_push_schedule',{}),/CAPABILITY_UNAVAILABLE/);
 await f.restart();assert.equal(f.cloud.hello().capabilities.delivery_push_plan,1);assert.equal(f.cloud.deliveryRuntime.status().push_enabled,false);
});
test('loopback push enabled cannot accept a commit approval or arbitrary input',async t=>{
 const f=await setup(t,true,false,true,true);assert.equal(f.cloud.hello().capabilities.delivery_push,1);assert(!f.cloud.hello().capabilities.delivery_commit);
 await assert.rejects(f.local.call('delivery_push_schedule',{}),/INVALID_PUSH_SCHEDULE/);
 assert.equal(f.cloud.store.db.prepare('SELECT count(*) n FROM delivery_actions').get().n,0);
});
test('old peer rejects push proposal and methods while native intake still works',()=>{
 const base={schema:1,protocol:{min:1,max:1},plugin_version:'0.24.0-alpha.10',namespace:'unit',instance_id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'};
 const own={...base,role:'local',capabilities:{...CAPABILITIES}},remote={...base,role:'cloud',capabilities:{...CAPABILITIES}};
 delete remote.capabilities.delivery_push_plan;delete remote.capabilities.delivery_push;
 for(const method of ['delivery_push_prepare','delivery_push_schedule'])assert.throws(()=>requireCapability(method,own,remote),/CAPABILITY_UNAVAILABLE/);
 assert.throws(()=>requireCapability('approval_request',own,remote,{proposal:{delivery:{kind:'push-execution-reference-v1'}}}),/CAPABILITY_VERSION_INCOMPATIBLE/);
 assert.doesNotThrow(()=>requireCapability('accept',own,remote));
 assert.doesNotThrow(()=>validateHello(own));
 const bounded={...own,capabilities:Object.fromEntries(Array.from({length:64},(_,i)=>['fixture_'+i,1]))};
 assert.doesNotThrow(()=>validateHello(bounded));
 assert.throws(()=>validateHello({...bounded,capabilities:{...bounded.capabilities,fixture_overflow:1}}),/PROTOCOL_DESCRIPTOR_INVALID/);
});

// Synthetic persisted delivery, with no worker job and execution disabled.
import {TaskBoard} from '../bundle/task-board.js';
import {DeliveryJournal} from '../bundle/delivery-journal.js';
import {digest} from '../bundle/approval-ledger.js';
import {deliveryDisplayState} from '../bundle/delivery-state.js';
async function boardFixture(t){
 const f=await setup(t),g=f.cloud,db=g.store.db;
 const task=g.store.accept('cloud',{task_key:'ui-delivery',goal:'任务摘要夹具',ingress_id:'ui-delivery',source:'unit'});g.catalog.head(task.id);
 const journal=new DeliveryJournal({store:g.store});assert.equal(journal.enabled,false);
 const board=new TaskBoard({get:()=>null},g);let seq=0;
 const add=(state,revision=task.revision)=>{
  const id='display-'+(++seq),p={kind:'commit-objects-v1',persisted:false,grants_execution:false,branch:'dsh-task/display',computed_commit_oid:'b'.repeat(40)};
  const body={kind:'commit-execution-intent-v1',task_id:task.id,task_revision:revision,resource:'https://gitee.com/test-fixture/ui-only',plan:{...p,fingerprint:digest(p)}};
  const intent={...body,fingerprint:digest(body)},approval_id='synthetic-no-approval-'+id,event_id=id;
  db.prepare('INSERT INTO delivery_actions(id,event_id,fingerprint,task_id,approval_id,authority_hash,resource,intent,development_cutoff,state,epoch,dispatched,created) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,event_id,digest({event_id,approval_id,intent}),task.id,approval_id,'synthetic',intent.resource,JSON.stringify(intent),0,state,1,state==='queued'?0:1,Date.now());return id;
 };
 return {g,db,task,board,add};
}
for(const [stored,expected] of [['needs_review','delivery_review'],['active','delivery_active'],['queued','delivery_queued'],['completed','delivery_review'],['unknown','delivery_review']])test('task list includes persisted '+stored+' delivery without a worker job',async t=>{
 const f=await boardFixture(t);f.add(stored);const before=f.db.prepare('SELECT total_changes() n').get().n;
 const list=await f.board.call('board_list',{}),detail=await f.board.call('board_detail',{task_id:f.task.id});
 assert.equal(list.items[0].display_state,expected);assert.equal(detail.item.display_state,expected);assert.equal(list.items[0].jobs.length,0);
 assert.equal(list.items[0].delivery_summary.grants_execution,false);assert.equal(detail.item.delivery.execution.execution_enabled,false);
 assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
});
test('old unresolved delivery is not hidden by a new task revision or over twenty newer queued records',async t=>{
 const f=await boardFixture(t),id=f.add('needs_review');for(let i=0;i<23;i++)f.add('queued');f.db.prepare('UPDATE tasks SET revision=revision+1 WHERE id=?').run(f.task.id);
 const a=deliveryActions(f.g,f.task.id);assert.equal(a.total,24);assert.equal(a.items.length,20);assert.equal(a.items[0].id,id);assert.equal(a.items[0].revision_matches,false);
 assert.equal(f.board.summary(f.task.id).display_state,'delivery_review');
});
test('missing delivery ledger stays compatible; malformed delivery ledger is not treated as empty',async t=>{
 const f=await setup(t),task=f.cloud.store.accept('cloud',{task_key:'old',ingress_id:'old',goal:'old',source:'unit'});f.cloud.catalog.head(task.id);
 const board=new TaskBoard({get:()=>null},f.cloud);assert.equal(board.summary(task.id).display_state,'registered');
 const j=new DeliveryJournal({store:f.cloud.store});f.cloud.store.db.exec('ALTER TABLE delivery_actions RENAME COLUMN intent TO invalid_intent');
 // No rows does not hit projection: insert an unresolved malformed row explicitly.
 f.cloud.store.db.prepare('INSERT INTO delivery_actions(id,event_id,fingerprint,task_id,approval_id,authority_hash,resource,invalid_intent,development_cutoff,state,created) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('bad','bad','bad',task.id,'bad','bad','bad','bad',0,'needs_review',1);
 assert.equal(board.summary(task.id).display_state,'delivery_review');assert.equal(j.enabled,false);
});
test('delivery summary does not promote completed delivery or ordinary queued work above running work',()=>{
 const project=(state,items)=>deliveryDisplayState(state,{available:true,items});
 assert.equal(project('registered',[{state:'completed'}]),'registered');assert.equal(project('a2a_running',[{state:'queued'}]),'a2a_running');
 assert.equal(project('registered',[{state:'active',unclosed_operations:1}]),'delivery_draining');
 assert.equal(deliveryDisplayState('completed',{available:false,error:'DELIVERY_STATE_UNAVAILABLE'}),'delivery_state_unavailable');
});

test('board preserves sanitized repository errors and never calls provider inspection while displaying',async t=>{
 const f=await boardFixture(t),snapshot={provider:'gitee',repository_id:123,url:'https://gitee.com/fixture/no-network',branch:'main',base_sha:'a'.repeat(40)};
 f.db.prepare('INSERT INTO repository_associations VALUES (?,1,?,?,?,?,?)').run(f.task.id,'changed',JSON.stringify(snapshot),digest(snapshot),1,'REPOSITORY_ACCESS_DENIED');
 let calls=0;f.g.repositories.provider.inspect=()=>{calls++;throw Error('NO_PROVIDER_IO_EXPECTED');};const before=f.db.prepare('SELECT total_changes() n').get().n;
 const d=await f.board.call('board_detail',{task_id:f.task.id});assert.equal(d.item.repository.error,'REPOSITORY_ACCESS_DENIED');assert.equal(d.item.repository.verification_fresh,false);assert.equal(calls,0);assert.equal(before,f.db.prepare('SELECT total_changes() n').get().n);
 f.db.prepare('UPDATE repository_associations SET last_error=? WHERE task_id=?').run('TOKEN_RAW_TRACE',f.task.id);assert.equal(f.board.repository(f.task.id).error,'TRANSIENT_FAILURE');
});
