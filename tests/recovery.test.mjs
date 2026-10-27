import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {EventEmitter} from 'node:events';
import {Gateway} from '../bundle/index.js';
import {migrateRecovery,resolveOutbox} from '../bundle/recovery.js';
import {SshConnector} from '../bundle/ssh-connector.js';
function fixture(t,options={}){
 const dir=mkdtempSync(join(tmpdir(),'dsh-recovery-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const tokenFile=join(dir,'tokens.json');writeFileSync(tokenFile,JSON.stringify({localToken:'l'.repeat(32),cloudToken:'c'.repeat(32),a2aKey:'a'.repeat(32)}),{mode:0o600});
 let now=Date.now(),im=null;
 const c={role:'cloud',legacyFeishu:true,peerEnabled:false,namespace:'test',stateDir:dir,tokenFile,chatId:'oc_test',ownerOpenId:'ou_owner',peerOpenId:'ou_peer',port:0,recovery:{baseMs:1,maxMs:100,maxAttempts:3,sendTimeoutMs:10},...options};
 const ctx={get:()=>im,on(){},effect(){},agents:{list:()=>[]},agentPresets:{composedPreset:()=>null}};
 const g=new Gateway(ctx,c,{now:()=>now});t.after(()=>g.close());
 return {g,c,ctx,setIm:x=>{im=x;},advance:()=>{now+=200;}};
}
const args={task_key:'arbitrary-task',goal:'Do not execute',ingress_id:'feishu:m1',source:'feishu-cloud'};
const connected=(push)=>({getChannel:()=>({status:{connected:true}}),push});
test('concurrent same ingress is single-flight and successful acceptance atomically queues notice and receipt',async t=>{
 const {g}=fixture(t);let resolve,calls=0;g.call=()=>{calls++;return new Promise(r=>resolve=r);};
 const a=g.submit(args),b=g.submit(args);assert.equal(calls,1);resolve({id:'task-test',epoch:1,revision:0});
 assert.equal((await a).task_id,(await b).task_id);
 assert.equal(g.db.prepare('SELECT count(*) n FROM notices').get().n,1);
 assert.equal(g.db.prepare('SELECT count(*) n FROM receipts').get().n,1);
 assert.equal(g.snapshot().agents.length,0);
});
test('accept crash gap rolls back all local state and replay does not create a second coordinator task',async t=>{
 const {g}=fixture(t);const actual=g.receipt.bind(g);g.receipt=()=>{throw Error('DISK_FAILURE');};
 await assert.rejects(g.submit(args),/DISK_FAILURE/);
 assert.equal(g.db.prepare('SELECT status FROM submissions').get().status,'queued');assert.equal(g.db.prepare('SELECT count(*) n FROM notices').get().n,0);
 assert.equal(g.store.snapshot().tasks.length,1);
 g.receipt=actual;await g.deliver(args.ingress_id);
 assert.equal(g.store.snapshot().tasks.length,1);assert.equal(g.db.prepare('SELECT status FROM submissions').get().status,'accepted');
});
test('remote outage recovers to final task receipt, and permanent reject parks without retry',async t=>{
 const {g,advance}=fixture(t);const call=g.call.bind(g);g.call=async()=>{throw Error('offline token must not leak');};
 assert.equal((await g.submit(args)).status,'queued_locally');const before=g.db.prepare('SELECT attempts FROM submissions').get().attempts;await g.tick();assert.equal(g.db.prepare('SELECT attempts FROM submissions').get().attempts,before);
 g.call=call;advance();await g.tick();assert.equal(g.db.prepare('SELECT status FROM submissions').get().status,'accepted');
 assert.equal(g.db.prepare('SELECT status FROM receipts WHERE id=?').get('m1:queued').status,'superseded');assert.ok(g.db.prepare('SELECT text FROM receipts WHERE id=?').get('m1:accepted').text.includes('task-'));
 g.call=async()=>{throw Error('INGRESS_ID_CONFLICT');};assert.equal((await g.submit({...args,ingress_id:'feishu:m2'})).status,'needs_review');
 advance();await g.tick();assert.equal(g.db.prepare('SELECT attempts FROM submissions WHERE id=?').get('feishu:m2').attempts,1);
});
test('missing channel retries safely; concurrent ticks emit once with durable UUID and confirmed message ID',async t=>{
 const {g,setIm,advance}=fixture(t);await g.submit(args);await g.tick();assert.equal(g.db.prepare('SELECT status FROM receipts').get().status,'queued');
 let calls=0;setIm(connected(async(_p,_c,out)=>{calls++;assert.match(out.uuid,/^[0-9a-f-]{36}$/);return {messageId:'om_sent'};}));advance();await Promise.all([g.tick(),g.tick()]);
 assert.equal(calls,1);assert.equal(g.snapshot().receipts[0].message_id,'om_sent');await g.tick();assert.equal(calls,1);
});
test('ambiguous send and hung send quarantine, operator resolves exact row without automatic duplicate',async t=>{
 const {g,setIm}=fixture(t);await g.submit(args);let calls=0;setIm(connected(async()=>{calls++;throw Error('unknown external payload');}));await g.tick();await g.tick();assert.equal(calls,1);
 const row=g.db.prepare('SELECT * FROM receipts').get();assert.equal(row.status,'needs_review');
 assert.throws(()=>resolveOutbox(g.db,{table:'receipts',id:row.id,outcome:'retry'}),/REVIEW_REQUIRED/);
 resolveOutbox(g.db,{table:'receipts',id:row.id,outcome:'retry',acknowledgeDuplicateRisk:true});
 setIm(connected(()=>new Promise(()=>{})));await g.tick();assert.equal(g.snapshot().receipts[0].status,'needs_review');
 resolveOutbox(g.db,{table:'receipts',id:row.id,outcome:'sent',messageId:'om_verified',acknowledgeDuplicateRisk:true});assert.equal(g.snapshot().receipts[0].message_id,'om_verified');
});
test('v030 migration preserves payload and receipt, quarantines only uncertain legacy sending; migration repeat-safe',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec("CREATE TABLE submissions(id TEXT PRIMARY KEY,payload TEXT,attempts INTEGER,status TEXT); CREATE TABLE receipts(id TEXT PRIMARY KEY,text TEXT,status TEXT); CREATE TABLE notices(id TEXT PRIMARY KEY,text TEXT,status TEXT,created INTEGER); INSERT INTO submissions VALUES('s','original',5,'queued'); INSERT INTO receipts VALUES('r','original','sending');");
 migrateRecovery(db);migrateRecovery(db);assert.equal(db.prepare('SELECT payload FROM submissions').get().payload,'original');assert.equal(db.prepare('SELECT attempts FROM submissions').get().attempts,5);assert.equal(db.prepare('SELECT status FROM receipts').get().status,'needs_review');
});
test('expired notices are not resent or re-signed; active send leases are not stolen',async t=>{
 const {g,setIm}=fixture(t,{sendNotices:true});await g.submit(args);g.db.prepare('UPDATE notices SET created=0').run();let calls=0;setIm(connected(async()=>{calls++;return {messageId:'om_sent'};}));
 const r=g.db.prepare('SELECT id FROM receipts').get();g.db.prepare("UPDATE receipts SET status='sending',lease_until=? WHERE id=?").run(Date.now()+60000,r.id);
 await g.tick();assert.equal(calls,0);assert.equal(g.snapshot().notices[0].status,'expired');assert.equal(g.snapshot().receipts[0].status,'sending');
 g.db.prepare('UPDATE receipts SET lease_until=0').run();await g.tick();assert.equal(g.snapshot().receipts[0].status,'needs_review');
});
test('owned SSH reconnects after exit and never reconnects after close',async()=>{
 const children=[],argv=[];const spawn=(...a)=>{argv.push(a);const c=new EventEmitter();c.kill=()=>{setImmediate(()=>c.emit('close',0));return true;};children.push(c);return c;};
 const c=new SshConnector({forward:'127.0.0.1:1:127.0.0.1:2',target:'root@example.test',identityFile:'/not/read'},()=>{}, {spawn,baseMs:5,maxMs:10});
 c.start();children[0].emit('close',1);await new Promise(r=>setTimeout(r,20));assert.equal(children.length,2);assert.ok(argv[0][1].includes('StrictHostKeyChecking=yes'));
 await c.close();await new Promise(r=>setTimeout(r,20));assert.equal(children.length,2);
});

test('incomplete /task never creates a task; bounded deterministic format receipt and owner gate preserved',async t=>{
 const {g}=fixture(t);const msg={platform:'feishu',chatId:'oc_test',senderType:'user',userId:'ou_owner',text:'@_user_1 /task inbox-1016-a',msgId:'format-test'};
 for(let i=0;i<2;i++)await assert.rejects(g.receive(msg),/INVALID_COMMAND/);
 assert.equal(g.store.snapshot().tasks.length,0);assert.equal(g.db.prepare('SELECT count(*) n FROM submissions').get().n,0);assert.equal(g.db.prepare('SELECT count(*) n FROM receipts').get().n,1);
 await assert.rejects(g.receive({...msg,userId:'ou_wrong',msgId:'wrong-owner'}),/OWNER_DENIED/);assert.equal(g.db.prepare('SELECT count(*) n FROM receipts').get().n,1);
 await g.receive({...msg,msgId:'complete-test',text:'@_user_1 /task inbox-1016-a 仅登记恢复测试，不开始执行'});
 assert.equal(g.store.snapshot().tasks[0].task_key,'inbox-1016-a');
});
