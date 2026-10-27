import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {Gateway} from '../bundle/index.js';
import {createOnboardingFileTransfer} from '../bundle/onboarding-file-transfer.js';
import {createOnboardingService} from '../bundle/onboarding-host.js';
const hash=b=>createHash('sha256').update(b).digest('hex'),confirm=p=>({id:p.id,fingerprint:p.fingerprint,confirm:true}),max=2097152;
async function fixture(t,role='cloud',namespaceId=null){
 const parent=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'s57-migration-'))),id=randomUUID(),root=path.join(parent,id),a=path.join(parent,'old-source'),b=path.join(parent,'new-source');for(const p of [root,root+'/state',a,b])fs.mkdirSync(p,{mode:0o700});
 const records=new Map();let clock=10000,writes=0,fault=null,tail=Promise.resolve();
 const credentials={readRecord:async k=>structuredClone(records.get(k)),modifyRecord(k,fn){const promise=tail.then(()=>{const old=records.get(k),next=fn(structuredClone(old));if(next===undefined)return;
  const finish=old?.payload?.schema===2&&next.payload.schema===1;
  if(finish&&fault==='beforeFinalize')throw Error('SYNTHETIC_FINALIZE_LOSS');
  records.set(k,structuredClone(next));writes++;
  if(next.payload.schema===2&&fault==='afterIntent'||finish&&fault==='afterFinalize')throw Error('SYNTHETIC_REPLY_LOSS');});tail=promise.catch(()=>{});return promise;}};
 const g=new Gateway({on(){},effect(){},agents:{list:()=>[]},agentPresets:{}},{role,stateDir:root+'/state',namespace:'managed-'+(namespaceId??id),port:0,entryMode:'native',peerEnabled:false,legacyFeishu:false},{now:()=>clock,secrets:{localToken:'l'.repeat(32),cloudToken:'c'.repeat(32)}}),deps={g,root,credentials:()=>credentials,now:()=>clock};let manager=createOnboardingFileTransfer(deps);
 t.after(async()=>{await manager.close();await g.close();fs.rmSync(parent,{recursive:true,force:true});});
 return {id,parent,root,a,b,g,records,deps,get m(){return manager;},writes:()=>writes,setFault:v=>fault=v,advance:()=>clock+=300001,
  enable:async(roots=[a],size=max)=>manager.apply(confirm(await manager.preview({enabled:true,sendRoots:roots,maxBytes:size}))),
  disable:async()=>{const s=await manager.status({});return manager.apply(confirm(await manager.preview({enabled:false,sendRoots:s.sendRoots,maxBytes:s.maxBytes})));},
  prepare:async()=>{await manager.apply(confirm(await manager.preview({enabled:true,sendRoots:[a],maxBytes:max})));const s=await manager.status({});await manager.apply(confirm(await manager.preview({enabled:false,sendRoots:s.sendRoots,maxBytes:s.maxBytes})));},
  plan:async(size=max)=>manager.migrationPreview({sendRoots:[b],maxBytes:size}),
  restart:async()=>{await manager.close();manager=createOnboardingFileTransfer(deps);await manager.start();},
  owner:()=>g.db.prepare('SELECT config FROM peer_file_owner WHERE id=1').get().config,
  queue:()=>g.db.prepare('SELECT * FROM peer_file_out ORDER BY id').all()};
}
test('scope migration preview is read-only and confirmation remains disabled until separate enable',async t=>{
 const f=await fixture(t);await f.prepare();const before=f.writes(),owner=f.owner(),p=await f.plan();assert.equal(p.kind,'scope_migration');assert.equal(p.writes,0);assert(p.holdsPendingTransfers&&p.requiresSeparateEnable&&p.preservesFiles);assert.equal(f.writes(),before);assert.equal(f.owner(),owner);assert(!f.g.db.prepare("SELECT name FROM sqlite_master WHERE name='peer_file_migration'").get());
 const done=await f.m.apply(confirm(p));assert.equal(done.revision,3);assert.equal(done.state,'disabled');assert.deepEqual(done.sendRoots,[f.b]);assert(!f.g.files);await f.restart();assert.equal((await f.m.status({})).state,'disabled');await f.enable([f.b]);assert((await f.m.status({})).active);
});
test('active, missing, unchanged, unsafe and unexpected migration inputs never grant',async t=>{
 const f=await fixture(t);await assert.rejects(f.plan(),/NOT_CONFIGURED/);await f.enable();await assert.rejects(f.plan(),/MIGRATION_DISABLE_REQUIRED/);await f.disable();const writes=f.writes();await assert.rejects(f.m.migrationPreview({sendRoots:[f.a],maxBytes:max}),/MIGRATION_NO_CHANGE/);await assert.rejects(f.m.migrationPreview({sendRoots:['/'],maxBytes:max}),/SOURCE_DENIED/);await assert.rejects(f.m.migrationPreview({sendRoots:[f.b],maxBytes:max,enabled:true}),/ARGUMENTS/);assert.equal(f.writes(),writes);
});
test('removed source is not reread; old snapshots are held, never replayed under the new grant',async t=>{
 const f=await fixture(t);await f.enable();const task='task-'+randomUUID(),id='file-'+hash('held'),file=f.a+'/old.txt';fs.writeFileSync(file,'original');await f.g.files.enqueue({id,task_id:task,file});const blob=f.root+'/state/peer-files/send/cloud/'+id+'.blob';await f.disable();fs.rmSync(f.a,{recursive:true});const p=await f.plan();assert.equal(p.migration.snapshot.held.outgoing,1);await f.m.apply(confirm(p));assert.equal(f.queue()[0].state,'needs_review');assert.equal(f.queue()[0].error,'PEER_FILE_SCOPE_CHANGED');assert.equal(fs.readFileSync(blob,'utf8'),'original');await f.enable([f.b]);
 await assert.rejects(f.g.files.enqueue({id:'file-'+hash('new-old'),task_id:task,file}),/SOURCE_DENIED/);assert.equal((await f.g.files.enqueue({id,task_id:task,file})).state,'needs_review');
 const fresh=f.b+'/new.txt';fs.writeFileSync(fresh,'new');assert.equal((await f.g.files.enqueue({id:'file-'+hash('fresh'),task_id:task,file:fresh})).state,'queued');
});
test('lost persistent-intent response resumes exactly once on restart without enabling',async t=>{
 const f=await fixture(t);await f.prepare();const old=f.owner(),p=await f.plan();f.setFault('afterIntent');await assert.rejects(f.m.apply(confirm(p)),/SYNTHETIC_REPLY_LOSS/);assert.equal(f.owner(),old);assert.equal((await f.m.status({})).error,'ONBOARDING_FILES_MIGRATION_PENDING');f.setFault(null);await f.restart();const r=await f.m.status({});assert.equal(r.revision,3);assert.equal(r.state,'disabled');assert(!f.g.files);const writes=f.writes();await f.restart();assert.equal(f.writes(),writes);assert.equal(f.g.db.prepare('SELECT count(*) n FROM peer_file_migration').get().n,1);
});
test('crash after DB commit recovers matching receipt instead of applying queue changes twice',async t=>{
 const f=await fixture(t);await f.prepare();const p=await f.plan();f.setFault('beforeFinalize');const r=await f.m.apply(confirm(p));assert.equal(r.error,'ONBOARDING_FILES_MIGRATION_PENDING');const owner=f.owner();assert(owner.includes(f.b));assert.equal(f.g.db.prepare('SELECT count(*) n FROM peer_file_migration').get().n,1);f.setFault(null);const result=await f.m.migrationRecover({operation:p.id,confirm:true});assert.equal(result.state,'disabled');assert.equal(f.owner(),owner);const writes=f.writes();assert((await f.m.migrationRecover({operation:p.id,confirm:true})).notReapplied);assert.equal(f.writes(),writes);
});
test('lost finalize reply is reconciled from same completed authorization without redoing migration',async t=>{
 const f=await fixture(t);await f.prepare();const p=await f.plan();f.setFault('afterFinalize');await f.m.apply(confirm(p));f.setFault(null);const writes=f.writes();const r=await f.m.migrationRecover({operation:p.id,confirm:true});assert(r.notReapplied);assert.equal(r.state,'disabled');assert.equal(f.writes(),writes);
});
test('replacement target before confirm refuses before credential or DB write',async t=>{
 const f=await fixture(t);await f.prepare();const p=await f.plan(),owner=f.owner(),writes=f.writes();fs.renameSync(f.b,f.b+'-old');fs.mkdirSync(f.b,{mode:0o700});await assert.rejects(f.m.apply(confirm(p)),/SOURCE_CHANGED/);assert.equal(f.writes(),writes);assert.equal(f.owner(),owner);
});
test('replacement target after intent is not adopted by restart; original identity can recover',async t=>{
 const f=await fixture(t);await f.prepare();const p=await f.plan(),owner=f.owner();f.setFault('afterIntent');await assert.rejects(f.m.apply(confirm(p)));f.setFault(null);fs.renameSync(f.b,f.b+'-original');fs.mkdirSync(f.b,{mode:0o700});await f.restart();assert.equal((await f.m.status({})).state,'needs_review');assert.equal(f.owner(),owner);assert(!f.g.files);fs.rmdirSync(f.b);fs.renameSync(f.b+'-original',f.b);await f.m.migrationRecover({operation:p.id,confirm:true});assert.equal((await f.m.status({})).state,'disabled');
});
test('pending intent blocks enabling, fencing or replacement preview and wrong recovery operation',async t=>{
 const f=await fixture(t);await f.prepare();const p=await f.plan();f.setFault('afterIntent');await assert.rejects(f.m.apply(confirm(p)));f.setFault(null);await assert.rejects(f.enable([f.b]),/MIGRATION_PENDING/);await assert.rejects(f.plan(),/MIGRATION_PENDING/);await assert.rejects(f.m.fence({operation:randomUUID(),expectedRevision:3,confirm:true}),/MIGRATION_PENDING/);await assert.rejects(f.m.migrationRecover({operation:randomUUID(),confirm:true}),/CONFLICT/);assert((await f.m.apply(confirm(p))).notReapplied);assert(!f.g.files);
});
test('queue or owner drift is preserved as review rather than overwritten',async t=>{
 for(const drift of ['queue','owner']){const f=await fixture(t);await f.prepare();const p=await f.plan();if(drift==='owner')f.g.db.prepare('UPDATE peer_file_owner SET config=?').run('FOREIGN_OWNER');else f.g.db.prepare("INSERT INTO peer_file_out VALUES(?,?,?,'queued',NULL,0,0)").run('file-'+hash('concurrent'),'{}','CONCURRENT_USER_DATA');
  const owner=f.owner(),r=await f.m.apply(confirm(p));assert.equal(r.state,'needs_review');assert.equal(f.owner(),owner);assert(!f.g.files);assert(!f.g.db.prepare("SELECT name FROM sqlite_master WHERE name='peer_file_migration'").get());if(drift==='queue')assert.equal(f.queue()[0].state,'queued');}
});
test('SQLite failure rolls back owner, holds and receipt together; explicit recovery preserves bytes',async t=>{
 const f=await fixture(t);await f.enable();const id='file-'+hash('atomic'),task_id='task-'+randomUUID(),file=f.a+'/safe.txt';fs.writeFileSync(file,'KEEP');await f.g.files.enqueue({id,task_id,file});await f.disable();const p=await f.plan(),owner=f.owner();f.g.db.exec("CREATE TRIGGER s57_fail_owner BEFORE UPDATE ON peer_file_owner BEGIN SELECT RAISE(ABORT,'SYNTHETIC_ABORT'); END");
 assert.equal((await f.m.apply(confirm(p))).state,'needs_review');assert.equal(f.owner(),owner);assert.equal(f.queue()[0].state,'queued');assert(!f.g.db.prepare("SELECT name FROM sqlite_master WHERE name='peer_file_migration'").get());f.g.db.exec('DROP TRIGGER s57_fail_owner');await f.m.migrationRecover({operation:p.id,confirm:true});assert.equal(f.queue()[0].state,'needs_review');assert.equal(fs.readFileSync(file,'utf8'),'KEEP');
});
test('new owner without exact migration receipt is not accepted as completion',async t=>{
 const f=await fixture(t);await f.prepare();const p=await f.plan();f.setFault('beforeFinalize');await f.m.apply(confirm(p));f.setFault(null);f.g.db.prepare('DELETE FROM peer_file_migration').run();const owner=f.owner();await assert.rejects(f.m.migrationRecover({operation:p.id,confirm:true}),/MIGRATION_OWNER_REVIEW/);assert.equal(f.owner(),owner);assert.equal((await f.m.status({})).state,'needs_review');
});
test('in-flight incoming/broker records are held; completed records remain completed',async t=>{
 const f=await fixture(t);await f.prepare();const id='file-'+hash('partial'),done='file-'+hash('complete');for(const [key,state] of [[id,'receiving'],[done,'received']]){f.g.db.prepare('INSERT INTO peer_file_in(id,meta,state) VALUES(?,?,?)').run(key,'{}',state);f.g.db.prepare('INSERT INTO peer_file_broker VALUES(?,?,?,?)').run(key,'local','{}',state==='receiving'?'available':state);}const p=await f.plan();assert.deepEqual(p.migration.snapshot.held,{outgoing:0,incoming:1,broker:1});await f.m.apply(confirm(p));assert.equal(f.g.db.prepare('SELECT state FROM peer_file_in WHERE id=?').get(id).state,'needs_review');assert.equal(f.g.db.prepare('SELECT state FROM peer_file_broker WHERE id=?').get(id).state,'needs_review');assert.equal(f.g.db.prepare('SELECT state FROM peer_file_in WHERE id=?').get(done).state,'received');
});
test('real peer protocol still sends in both directions after migration; old completed files survive a lower cap',async t=>{
 const cloud=await fixture(t),local=await fixture(t,'local',cloud.id);await cloud.enable();await local.enable();local.g.link.transport=async(method,args)=>method==='negotiate'?{hello:cloud.g.hello()}:{result:await cloud.g.call(method,args,'local'),observation:cloud.g.observation()};const task=(await cloud.g.submit({task_key:'s57-migration-wire',source:'native-cloud',ingress_id:randomUUID(),goal:'byte transport'})).task_id;
 const deliver=async(sender,receiver,name,bytes,dir)=>{const file=dir+'/'+name;fs.writeFileSync(file,bytes);await sender.g.files.enqueue({id:'file-'+hash(name),task_id:task,file});for(let i=0;i<8;i++){local.advance();cloud.advance();await local.g.files.sync();await cloud.g.files.sync();}const got=(await receiver.g.files.list(task)).received.find(x=>x.name===name);assert.equal(got.state,'received');assert.equal(got.availability,'available');assert.equal(hash(fs.readFileSync(got.path)),hash(bytes));return got;};
 const old=await deliver(local,cloud,'old-large.bin',Buffer.alloc(4096,0x64),local.a);
 for(const f of [local,cloud]){await f.disable();await f.m.apply(confirm(await f.plan(1024)));await f.restart();assert(!f.g.files);await f.enable([f.b],1024);}
 assert.equal((await cloud.g.files.list(task)).received.find(x=>x.transfer_id===old.transfer_id).availability,'available');
 await deliver(local,cloud,'new-local.txt',Buffer.from('本地新范围'),local.b);await deliver(cloud,local,'new-cloud.txt',Buffer.from('云端新范围'),cloud.b);
 const large=cloud.b+'/denied.bin';fs.writeFileSync(large,Buffer.alloc(2048));await assert.rejects(cloud.g.files.enqueue({id:'file-'+hash('over-new-cap'),task_id:task,file:large}),/TOO_LARGE/);assert(!cloud.g.scheduler&&!cloud.g.development);
});
test('public Host exposes migration separately without changing existing file or native capabilities',async t=>{
 const f=await fixture(t);await f.prepare();const service=createOnboardingService({}, {onboarding:{role:'cloud'}},{home:f.parent,env:{},taskRuntime:{files:f.m,status:async()=>({configured:true}),available:()=>true}}),d=await service.call('describe',{});assert.equal(d.capabilities.managedFileTransferContract,2);assert.equal(d.capabilities.managedFileScopeMigrationContract,1);const p=await service.call('file_transfer_migrationPreview',{sendRoots:[f.b],maxBytes:1024});assert.equal((await service.call('file_transfer_apply',confirm(p))).state,'disabled');assert((await service.call('file_transfer_migrationRecover',{operation:p.id,confirm:true})).notReapplied);
});
