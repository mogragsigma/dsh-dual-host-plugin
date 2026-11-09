import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Gateway} from '../bundle/index.js';
import {FILE_CHUNK,PeerFiles} from '../bundle/peer-files.js';
import {fileHash,FileRoot,sourceFile} from '../bundle/peer-file-fs.js';
import {registerNativeTools} from '../bundle/native-tools.js';
const FILE_MAX=8*1024*1024; // Explicit legacy configured cap, no universal limit.
const id=s=>'file-'+fileHash(s);
async function fixture(t){
 const root=fs.mkdtempSync(join(tmpdir(),'s53-files-')),tokenFile=join(root,'tokens');fs.writeFileSync(tokenFile,JSON.stringify({localToken:'l'.repeat(32),cloudToken:'c'.repeat(32)}),{mode:0o600});
 for(const role of ['local','cloud'])for(const k of ['send','inbox'])fs.mkdirSync(join(root,role+'-'+k));
 const agents=new Map(),ctx={agents:{list:()=>[...agents.values()],get:x=>agents.get(x)},agentPresets:{composedPreset:c=>c.preset},on(){},effect(){}};let local,cloud,now=Date.now();
 const config=role=>({role,namespace:'s53-test',port:0,tokenFile,stateDir:join(root,role),fileTransfers:{enabled:true,maxBytes:FILE_MAX,sendRoots:[join(root,role+'-send')],receiveRoot:join(root,role+'-inbox')}});
 async function open(){cloud=new Gateway(ctx,config('cloud'),{now:()=>now});await cloud.start();local=new Gateway(ctx,{...config('local'),coordinatorUrl:'http://127.0.0.1:'+cloud.server.address().port},{now:()=>now});}
 await open();t.after(async()=>{await local.close();await cloud.close();fs.rmSync(root,{recursive:true,force:true});});
 const task=(await local.submit({goal:'file tests only',task_key:'files',source:'native-local',ingress_id:'one'})).task_id;
 return {root,task,agents,config,get local(){return local;},get cloud(){return cloud;},advance(){now+=600000;},async restart(){await local.close();await cloud.close();await open();},
 enqueue(role,name,bytes=Buffer.from('hello'),key=name){fs.writeFileSync(join(root,role+'-send',name),bytes);return (role==='local'?local:cloud).files.enqueue({id:id(key),task_id:task,file:name});},
 async drain(){for(let i=0;i<60;i++){await local.files.sync();await cloud.files.sync();now+=600000;}},
 meta(role,key){return JSON.parse((role==='local'?local:cloud).db.prepare('SELECT meta FROM peer_file_out WHERE id=?').get(id(key)).meta);}};
}

for(const role of ['local','cloud'])test(`large ${role} transfer, restart and original receipt`,async t=>{
 const f=await fixture(t),bytes=Buffer.alloc(3*1024*1024+17,0x61);f.enqueue(role,'中文大文件.bin',bytes);await f[role].files.sync();await f.restart();await f.drain();
 const target=f[role==='local'?'cloud':'local'].files.list(f.task).received[0];assert.equal(target.availability,'available');assert.equal(fileHash(fs.readFileSync(target.path)),fileHash(bytes));
 const receipt=f[role].files.list(f.task).sent[0];await f.restart();assert.deepEqual(f[role].files.list(f.task).sent[0],receipt);assert.equal(f[role==='local'?'cloud':'local'].files.list(f.task).received.length,1);
 fs.writeFileSync(target.path,'corrupted');assert.equal(f[role==='local'?'cloud':'local'].files.list(f.task).received[0].availability,'changed');
});
test('explicit prior cap remains a persisted contract, not silently expanded',async t=>{
 const f=await fixture(t);assert.equal(f.local.files.max,FILE_MAX);const config=f.config('local').fileTransfers;delete config.maxBytes;assert.equal(new PeerFiles(f.local,config).max,FILE_MAX);await f.restart();assert.equal(f.local.files.max,FILE_MAX);
 await assert.rejects(f.local.call('peer_file_offer',{...f.enqueue('local','sample.txt'),size:FILE_MAX+1}),/TOO_LARGE/);
});
