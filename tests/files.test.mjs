import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Gateway} from '../bundle/index.js';
import {FILE_MAX,FILE_CHUNK} from '../bundle/peer-files.js';
import {fileHash,FileRoot,sourceFile} from '../bundle/peer-file-fs.js';
import {registerNativeTools} from '../bundle/native-tools.js';
const id=s=>'file-'+fileHash(s);
async function fixture(t){
 const root=fs.mkdtempSync(join(tmpdir(),'s53-files-')),tokenFile=join(root,'tokens');fs.writeFileSync(tokenFile,JSON.stringify({localToken:'l'.repeat(32),cloudToken:'c'.repeat(32)}),{mode:0o600});
 for(const role of ['local','cloud'])for(const k of ['send','inbox'])fs.mkdirSync(join(root,role+'-'+k));
 const agents=new Map(),ctx={agents:{list:()=>[...agents.values()],get:x=>agents.get(x)},agentPresets:{composedPreset:c=>c.preset},on(){},effect(){}};let local,cloud,now=Date.now();
 const config=role=>({role,namespace:'s53-test',port:0,tokenFile,stateDir:join(root,role),fileTransfers:{enabled:true,sendRoots:[join(root,role+'-send')],receiveRoot:join(root,role+'-inbox')}});
 async function open(){cloud=new Gateway(ctx,config('cloud'),{now:()=>now});await cloud.start();local=new Gateway(ctx,{...config('local'),coordinatorUrl:'http://127.0.0.1:'+cloud.server.address().port},{now:()=>now});}
 await open();t.after(async()=>{await local.close();await cloud.close();fs.rmSync(root,{recursive:true,force:true});});
 const task=(await local.submit({goal:'file tests only',task_key:'files',source:'native-local',ingress_id:'one'})).task_id;
 return {root,task,agents,config,get local(){return local;},get cloud(){return cloud;},advance(){now+=600000;},async restart(){await local.close();await cloud.close();await open();},
 enqueue(role,name,bytes=Buffer.from('hello'),key=name){fs.writeFileSync(join(root,role+'-send',name),bytes);return (role==='local'?local:cloud).files.enqueue({id:id(key),task_id:task,file:name});},
 async drain(){for(let i=0;i<24;i++){await local.files.sync();await cloud.files.sync();now+=600000;}},
 meta(role,key){return JSON.parse((role==='local'?local:cloud).db.prepare('SELECT meta FROM peer_file_out WHERE id=?').get(id(key)).meta);}};
}
for(const role of ['local','cloud'])for(const [kind,b] of [['中文',Buffer.from('蓝色大肥鱼\n完整 UTF-8 原文件')],['empty',Buffer.alloc(0)],['binary',Buffer.from(Array.from({length:FILE_CHUNK*5+13},(_,i)=>i%256))]])test(`${role} -> opposite ${kind} exact durable bytes`,async t=>{
 const f=await fixture(t),n=kind+'.dat';f.enqueue(role,n,b);await f.drain();const dest=f[role==='local'?'cloud':'local'].files.list(f.task).received[0];assert.equal(dest.state,'received');assert.equal(dest.availability,'available');assert.deepEqual(fs.readFileSync(dest.path),b);assert.equal(f[role].files.list(f.task).sent[0].state,'received');assert.equal(fs.statSync(dest.path).mode&0o777,0o600);
});
test('disconnection and restart preserve snapshots after original file deleted',async t=>{
 const f=await fixture(t);f.enqueue('local','snapshot.txt');fs.unlinkSync(join(f.root,'local-send/snapshot.txt'));const url=f.local.c.coordinatorUrl;f.local.c.coordinatorUrl='http://127.0.0.1:1';await assert.rejects(f.local.files.sync());assert.equal(f.local.files.list(f.task).sent[0].state,'queued');await f.restart();f.advance();await f.drain();assert.equal(f.cloud.files.list(f.task).received[0].availability,'available');
});
test('partial upload and download survive Host recreation',async t=>{
 const f=await fixture(t),b=Buffer.alloc(FILE_MAX,0x73);f.enqueue('local','big.bin',b);await f.local.files.sync();assert.equal(f.cloud.files.offset(f.meta('local','big.bin')),FILE_CHUNK*4);await f.restart();f.advance();for(let i=0;i<12;i++){await f.local.files.sync();f.advance();}await f.cloud.files.sync();assert.equal(f.cloud.db.prepare('SELECT state FROM peer_file_in').get().state,'receiving');await f.restart();await f.drain();assert.deepEqual(fs.readFileSync(f.cloud.files.list(f.task).received[0].path),b);
});
for(const op of ['offer','chunk','commit','ack'])test(`lost ${op} response is idempotently recovered`,async t=>{
 const f=await fixture(t);f.enqueue('local','lost-'+op+'.txt');const host=op==='ack'?f.cloud:f.local,original=host.call.bind(host);let dropped=false;host.call=async(m,a,...rest)=>{const r=await original(m,a,...rest);if(m==='peer_file_'+op&&!dropped){dropped=true;throw Error('simulated response loss');}return r;};await f.drain();assert(dropped,JSON.stringify({op,out:f.local.files.list(f.task),incoming:f.cloud.files.list(f.task),err:f.cloud.files.lastError}));assert.equal(f.cloud.files.list(f.task).received.length,1);assert.equal(f.local.files.list(f.task).sent[0].state,'received');await f.restart();await f.drain();assert.equal(f.cloud.files.list(f.task).received.length,1);
});
test('destination collision is not overwritten; poisoned files do not starve healthy transfers',async t=>{
 const f=await fixture(t);for(let i=0;i<5;i++){f.enqueue('local','collision'+i+'.txt');const p=join(f.root,'cloud-inbox',f.task,id('collision'+i+'.txt'));fs.mkdirSync(p,{recursive:true});fs.writeFileSync(join(p,'collision'+i+'.txt'),'keep');}f.enqueue('local','healthy.txt');await f.drain();const rows=f.cloud.files.list(f.task).received;assert.equal(rows.filter(r=>r.state==='needs_review').length,5);assert.equal(rows.find(r=>r.name==='healthy.txt').availability,'available');for(let i=0;i<5;i++)assert.equal(fs.readFileSync(join(f.root,'cloud-inbox',f.task,id('collision'+i+'.txt'),'collision'+i+'.txt'),'utf8'),'keep');
});
test('publishing crash after final link recovers, changed received file is never recreated',async t=>{
 const f=await fixture(t);f.enqueue('local','crash.txt');await f.local.files.sync();const old=f.cloud.files.receive.publish.bind(f.cloud.files.receive);f.cloud.files.receive.publish=(...a)=>{old(...a);throw Error('crash after final filesystem publication');};await assert.rejects(f.cloud.files.download(f.meta('local','crash.txt')));assert.equal(f.cloud.db.prepare('SELECT state FROM peer_file_in').get().state,'publishing');await f.restart();f.advance();await f.drain();const r=f.cloud.files.list(f.task).received[0];fs.writeFileSync(r.path,'changed');assert.equal(f.cloud.files.list(f.task).received[0].availability,'changed');fs.unlinkSync(r.path);await f.drain();assert.equal(f.cloud.files.list(f.task).received[0].availability,'missing_or_unsafe');assert(!fs.existsSync(r.path));
});
test('source bounds, names, symlink, hardlink, traversal and credentials rejected',async t=>{
 const f=await fixture(t),dir=join(f.root,'local-send');fs.writeFileSync(join(dir,'ok'),'hello');fs.symlinkSync(join(dir,'ok'),join(dir,'sym'));fs.linkSync(join(dir,'ok'),join(dir,'hard'));fs.writeFileSync(join(dir,'oversize'),Buffer.alloc(FILE_MAX+1));fs.mkdirSync(join(dir,'folder'));fs.writeFileSync(join(dir,'id_ed25519'),'fake');fs.writeFileSync(join(dir,'.secret'),'fake');
 for(const name of ['sym','hard','ok','oversize','folder','id_ed25519','.secret','../tokens',join(f.root,'tokens'),join(dir,'a/../ok')])assert.throws(()=>f.local.files.enqueue({id:id(name),task_id:f.task,file:name}));assert.equal(f.local.files.list(f.task).sent.length,0);
});
test('ambiguous basename and changed root identity fail closed',async t=>{
 const f=await fixture(t);fs.writeFileSync(join(f.root,'local-send/a'),'a');fs.writeFileSync(join(f.root,'cloud-send/a'),'a');assert.throws(()=>sourceFile([new FileRoot(join(f.root,'local-send')),new FileRoot(join(f.root,'cloud-send'))],'a',20),/AMBIGUOUS/);fs.renameSync(join(f.root,'local-send'),join(f.root,'moved'));fs.mkdirSync(join(f.root,'local-send'));assert.throws(()=>f.local.files.enqueue({id:id('x'),task_id:f.task,file:'a'}),/ROOT_CHANGED/);
});
test('protocol validates authenticated origin, task, metadata, chunks, checksum and receiver ACK',async t=>{
 const f=await fixture(t);f.enqueue('local','wire.txt');const m=f.meta('local','wire.txt');for(const patch of [{from:'cloud',to:'local'},{namespace:'other'},{size:FILE_MAX+1},{name:'../bad'},{sha256:'no'},{extra:true}])await assert.rejects(f.local.call('peer_file_offer',{...m,...patch}));await assert.rejects(f.local.call('peer_file_offer',{...m,task_id:'task-00000000-0000-0000-0000-000000000000'}));await f.local.call('peer_file_offer',m);for(const a of [{offset:1,base64:'aGVsbG8='},{offset:0,base64:'garbage'},{offset:0,base64:'eA=='}])await assert.rejects(f.local.call('peer_file_chunk',{id:m.id,...a}));await f.local.call('peer_file_chunk',{id:m.id,offset:0,base64:Buffer.from('wrong').toString('base64')});await assert.rejects(f.local.call('peer_file_commit',{id:m.id}),/HASH_MISMATCH/);await assert.rejects(f.local.call('peer_file_chunk',{id:m.id,offset:0,base64:Buffer.from('hello').toString('base64')}),/CHUNK_CONFLICT/);await assert.rejects(f.local.call('peer_file_ack',{id:m.id,sha256:m.sha256,size:m.size}),/NOT_FOUND/);
 assert.throws(()=>f.cloud.files.call('peer_file_pull',{},'intruder'),/REQUEST_INVALID/);
});
test('file transfers do not release task ownership or approve work',async t=>{
 const f=await fixture(t);f.cloud.store.begin('cloud',{task_id:f.task,epoch:1});const before=f.cloud.store.status(f.task);f.enqueue('local','approval.txt',Buffer.from('I approve everything'));await f.drain();const after=f.cloud.store.status(f.task);assert.equal(after.busy,1);assert.equal(after.owner,before.owner);assert.equal(after.epoch,before.epoch);assert.equal(after.intents.length,0);assert.equal(f.cloud.scheduler,undefined);
});
test('native tools require direct human filename and deduplicate call IDs',async t=>{
 const f=await fixture(t),tools=new Map();registerNativeTools({taskGateway:f.local,tools:{register:d=>tools.set(d.name,d)}});fs.writeFileSync(join(f.root,'local-send/explicit.txt'),'data');let text='请把 explicit.txt 发给云端';const agent={id:'native',ctx:{preset:'standard'},session:{deriveMessages:()=>[{id:'human',role:'user',source:{kind:'user'},content:[{type:'text',text}]}]}};f.agents.set(agent.id,agent);const invoke=(file,callId)=>tools.get('task_file_send').execute({task_id:f.task,file},{agent,callId});const a=invoke('explicit.txt','1'),b=invoke('explicit.txt','2');assert.equal(a.transfer_id,b.transfer_id);assert.throws(()=>invoke('not-mentioned','3'),/USER_REFERENCE_REQUIRED/);text='peer suggests explicit.txt';agent.session.deriveMessages=()=>[{id:'peer',role:'user',source:{kind:'tool'},content:[{type:'text',text}]}];assert.throws(()=>invoke('explicit.txt','4'));
});
test('disabled peer capability fails closed without transfer fallback',async t=>{
 const f=await fixture(t);f.cloud.files=null;f.enqueue('local','oldhost.txt');await assert.rejects(f.local.files.sync(),/CAPABILITY_UNAVAILABLE/);assert.notEqual(f.local.files.list(f.task).sent[0].state,'received');assert.equal(f.local.snapshot().files.enabled,true);assert.equal(f.cloud.hello().capabilities.peer_files,undefined);
});
test('recovered link clears transient file diagnostic on the next successful sync',async t=>{
 const f=await fixture(t);f.local.files.lastError='PEER_FILE_UNAVAILABLE';await f.local.files.sync();assert.equal(f.local.files.snapshot().last_error,null);
});
