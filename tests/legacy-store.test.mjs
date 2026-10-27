import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Coordinator,hash} from '../bundle/store.js';
const empty=hash('');
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'dsh-dual-'));let s=new Coordinator(dir);t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});return {get s(){return s;},reopen(){s.close();s=new Coordinator(dir);return s;}};}
const accept=(s,key='same-task',id='desktop')=>s.accept('local',{task_key:key,ingress_id:id,source:'desktop-native'});
const request=(s,node,id,t,content='local result',base_hash=empty)=>s.request(node,{task_id:t.id,request_id:id,content,base_hash});
test('three entrances join one key; duplicate message is idempotent; conflicting identity rejected',t=>{
 const {s}=fixture(t);const a=accept(s);
 assert.equal(s.accept('local',{task_key:'same-task',ingress_id:'feishu:1',source:'feishu-local'}).id,a.id);
 assert.equal(s.accept('cloud',{task_key:'same-task',ingress_id:'feishu:2',source:'feishu-cloud'}).id,a.id);
 assert.equal(accept(s).id,a.id);assert.equal(s.snapshot().tasks.length,1);assert.equal(s.snapshot().ingress.length,3);
 assert.throws(()=>accept(s,'other-task'),/INGRESS_ID_CONFLICT/);
});
test('busy cloud queues local write without touching file, then safely transfers with new fence',t=>{
 const {s}=fixture(t);const a=accept(s);s.begin('cloud',{task_id:a.id,epoch:a.epoch});
 const q=request(s,'local','q1',a);assert.equal(q.intent.status,'queued');
 assert.throws(()=>s.apply('local',{request_id:'q1',epoch:1}),/STALE_FENCE/);assert.equal(s.contents(a.id),'');
 const next=s.safe('cloud',{task_id:a.id,epoch:1,checkpoint:'all controlled writes settled'});
 assert.equal(next.owner,'local');assert.equal(next.epoch,2);assert.equal(next.busy,1);
 s.apply('local',{request_id:'q1',epoch:2});assert.equal(s.contents(a.id),'local result');
});
test('reverse handoff is symmetric; old owner and old epoch cannot write',t=>{
 const {s}=fixture(t);const a=accept(s);const q=request(s,'local','q1',a);s.apply('local',{request_id:'q1',epoch:q.task.epoch});
 request(s,'cloud','q2',a,'cloud result',hash('local result'));
 assert.throws(()=>s.apply('cloud',{request_id:'q2',epoch:2}),/STALE_FENCE/);
 const next=s.safe('local',{task_id:a.id,epoch:2,checkpoint:'local committed'});assert.equal(next.owner,'cloud');
 assert.throws(()=>s.apply('cloud',{request_id:'q2',epoch:2}),/STALE_FENCE/);
 s.apply('cloud',{request_id:'q2',epoch:3});assert.equal(s.contents(a.id),'cloud result');
});
test('FIFO grants one writer; another busy task does not block this task',t=>{
 const {s}=fixture(t);const other=accept(s,'other','other-source');s.begin('cloud',{task_id:other.id,epoch:1});
 const a=accept(s);const q=request(s,'local','one',a);assert.equal(q.intent.status,'granted');
 assert.equal(request(s,'cloud','two',a,'b',hash('local result')).intent.status,'queued');
 assert.equal(request(s,'local','three',a,'c',hash('b')).intent.status,'queued');
 s.apply('local',{request_id:'one',epoch:2});s.safe('local',{task_id:a.id,epoch:2,checkpoint:'one done'});
 assert.equal(s.intent('two').status,'granted');assert.equal(s.intent('three').status,'queued');assert.equal(s.task(other.id).busy,1);
});
test('granted/unresolved writes prevent safe-point release',t=>{
 const {s}=fixture(t);const a=accept(s);request(s,'local','one',a);
 assert.throws(()=>s.safe('local',{task_id:a.id,epoch:2,checkpoint:'not really done'}),/WRITES_NOT_QUIESCENT/);
 assert.equal(s.task(a.id).owner,'local');
});
test('local owner survives restart and disconnection without TTL takeover',t=>{
 const f=fixture(t);const a=accept(f.s);request(f.s,'local','one',a);request(f.s,'cloud','two',a);
 const s=f.reopen();assert.equal(s.task(a.id).owner,'local');assert.equal(s.task(a.id).epoch,2);assert.equal(s.intent('two').status,'queued');
 assert.throws(()=>s.safe('cloud',{task_id:a.id,epoch:2,checkpoint:'force'}),/STALE_FENCE/);
});
test('same write id replays receipt without second file effect; changed payload rejected',t=>{
 const {s}=fixture(t);const a=accept(s);request(s,'local','one',a);
 const receipt=s.apply('local',{request_id:'one',epoch:2});assert.deepEqual(s.apply('local',{request_id:'one',epoch:2}),receipt);
 assert.equal(s.task(a.id).revision,1);assert.throws(()=>request(s,'local','one',a,'changed'),/INTENT_ID_CONFLICT/);
});
test('stale baseline cannot overwrite newer bytes',t=>{
 const {s}=fixture(t);const a=accept(s);request(s,'local','one',a,'wrong','0'.repeat(64));
 assert.throws(()=>s.apply('local',{request_id:'one',epoch:2}),/BASE_HASH_CONFLICT/);assert.equal(s.contents(a.id),'');
});
test('ambiguous persisted writing blocks release after restart',t=>{
 const f=fixture(t);const a=accept(f.s);request(f.s,'local','one',a);
 f.s.db.prepare("UPDATE intents SET status='writing' WHERE id='one'").run();
 const s=f.reopen();assert.throws(()=>s.safe('local',{task_id:a.id,epoch:2,checkpoint:'guess'}),/WRITES_NOT_QUIESCENT/);
 assert.throws(()=>s.apply('local',{request_id:'one',epoch:2}),/NOT_GRANTED/);
});
