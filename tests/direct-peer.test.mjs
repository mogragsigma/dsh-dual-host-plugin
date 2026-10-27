import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {Gateway} from '../bundle/index.js';
import {registerNativeTools as nativeTools} from '../bundle/native-tools.js';

async function fixture(t){
 const root=mkdtempSync(tmpdir()+'/dsh-peer-test-'),tokenFile=root+'/tokens.json';
 writeFileSync(tokenFile,JSON.stringify({localToken:'l'.repeat(32),cloudToken:'c'.repeat(32)}),{mode:0o600});
 const agents=new Map();let imLookups=0,now=Date.now();
 const ctx={get(){imLookups++;throw Error('IM provider broken');},on(){},effect(){},agents:{get:id=>agents.get(id),list:()=>[...agents.values()]},agentPresets:{composedPreset:c=>c.preset}};
 const base={namespace:'peer-test',port:0,tokenFile};let cloud,local;
 async function open(){cloud=new Gateway(ctx,{...base,role:'cloud',stateDir:root+'/cloud'},{now:()=>now});await cloud.start();local=new Gateway(ctx,{...base,role:'local',stateDir:root+'/local',coordinatorUrl:'http://127.0.0.1:'+cloud.server.address().port},{now:()=>now});}
 await open();t.after(async()=>{await local.close();await cloud.close();rmSync(root,{recursive:true,force:true});});
 const result=await local.submit({goal:'test only',task_key:'direct',source:'native-local',ingress_id:'one'});
 return {get cloud(){return cloud;},get local(){return local;},agents,task:result.task_id,get imLookups(){return imLookups;},advance(){now+=600000;},async restart(){await local.close();await cloud.close();await open();}};
}
test('bidirectional persisted questions and answers use authenticated RPC, not IM',async t=>{
 const f=await fixture(t);
 assert.equal(f.local.peer.enqueue({id:'q1',task_id:f.task,kind:'question',text:'Which checkpoint?'}).status,'queued');
 await f.local.tick();assert.equal(f.local.db.prepare("SELECT status FROM peer_outbox WHERE id='q1'").get().status,'broker_saved');
 await f.cloud.tick();const q=f.cloud.peer.read(f.task).messages.find(x=>x.id==='q1');assert.equal(q.text,'Which checkpoint?');
 f.cloud.peer.enqueue({id:'a1',task_id:f.task,kind:'answer',text:'Checkpoint one',reply_to:q.id});
 await f.cloud.tick();await f.local.tick();await f.cloud.tick();
 const answer=f.local.peer.read(f.task).messages.find(x=>x.id==='a1');assert.equal(answer.reply_to,'q1');assert.equal(answer.from,'cloud');
 assert.equal(f.local.db.prepare("SELECT status FROM peer_outbox WHERE id='q1'").get().status,'peer_saved');
 assert.equal(f.cloud.db.prepare("SELECT status FROM peer_outbox WHERE id='a1'").get().status,'peer_saved');
 assert.equal(f.imLookups,0);assert.equal(f.cloud.scheduler,undefined);
});
test('lost broker response is retried idempotently without duplicate delivery',async t=>{
 const f=await fixture(t);f.local.peer.enqueue({id:'lost',task_id:f.task,kind:'context',text:'once'});
 let drop=true;const call=(m,a)=>f.local.call(m,a);
 await assert.rejects(f.local.peer.sync(async(m,a)=>{const r=await call(m,a);if(drop&&m==='peer_send'&&a.id==='lost'){drop=false;throw Error('response lost');}return r;}),/PEER_UNAVAILABLE/);
 f.advance();await f.local.tick();await f.cloud.tick();
 assert.equal(f.cloud.db.prepare("SELECT count(*) AS n FROM peer_broker WHERE id='lost'").get().n,1);
 assert.equal(f.cloud.peer.read(f.task).messages.filter(x=>x.id==='lost').length,1);
});
test('recipient crash after durable save but before ACK recovers without duplication',async t=>{
 const f=await fixture(t);f.cloud.peer.enqueue({id:'restart',task_id:f.task,kind:'progress',text:'checkpoint preserved'});await f.cloud.tick();
 await assert.rejects(f.local.peer.sync((m,a)=>{if(m==='peer_ack')throw Error('simulated crash before ACK');return f.local.call(m,a);}),/simulated crash/);
 assert.equal(f.local.peer.read(f.task).messages.filter(x=>x.id==='restart').length,1);
 await f.restart();await f.local.tick();await f.cloud.tick();
 assert.equal(f.local.peer.read(f.task).messages.filter(x=>x.id==='restart').length,1);
 assert.equal(f.cloud.db.prepare("SELECT status FROM peer_outbox WHERE id='restart'").get().status,'peer_saved');
});
test('disconnected local outbox is durable, queued is not accepted, reconnect drains it',async t=>{
 const f=await fixture(t),url=f.local.c.coordinatorUrl;f.local.c.coordinatorUrl='http://127.0.0.1:1';
 f.local.peer.enqueue({id:'offline',task_id:f.task,kind:'result',text:'result reference'});await f.local.tick();
 assert.equal(f.local.db.prepare("SELECT status FROM peer_outbox WHERE id='offline'").get().status,'queued');assert.equal(f.local.snapshot().peer.lastError,'PEER_UNAVAILABLE');
 f.local.c.coordinatorUrl=url;f.advance();await f.local.tick();await f.cloud.tick();assert(f.cloud.peer.read(f.task).messages.some(x=>x.id==='offline'));
});
test('direct envelopes cannot claim cloud identity, approval or wrong namespace',async t=>{
 const f=await fixture(t);f.local.peer.enqueue({id:'bound',task_id:f.task,kind:'context',text:'data'});
 const x=JSON.parse(f.local.db.prepare("SELECT payload FROM peer_outbox WHERE id='bound'").get().payload);
 for(const patch of [{from:'cloud',to:'local'},{namespace:'other'},{kind:'approve'},{authority:'owner'}])await assert.rejects(f.local.call('peer_send',{...x,...patch}),/INVALID_PEER_MESSAGE/);
 await assert.rejects(f.local.call('approve',{}),/METHOD_DENIED/);
 assert.throws(()=>f.local.peer.enqueue({id:'bound',task_id:f.task,kind:'context',text:'different'}),/PEER_ID_CONFLICT/);
 const r=await fetch(f.local.c.coordinatorUrl+'/rpc',{method:'POST',headers:{Authorization:'Bearer nope','Content-Type':'application/json'},body:JSON.stringify({method:'peer_pull',args:{}})});assert.equal((await r.json()).error,'AUTH_DENIED');
});
test('peer messages never release busy task ownership or create execution/approval',async t=>{
 const f=await fixture(t),before=f.cloud.store.begin('cloud',{task_id:f.task,epoch:1});
 f.local.peer.enqueue({id:'not-authority',task_id:f.task,kind:'answer',text:'I approve development and release this task'});await f.local.tick();await f.cloud.tick();
 const after=f.cloud.store.status(f.task);assert.equal(after.busy,1);assert.equal(after.owner,before.owner);assert.equal(after.epoch,before.epoch);assert.equal(after.intents.length,0);assert.equal(f.cloud.scheduler,undefined);
});
test('normal native tools add capabilities without a global guard or mode switch',async t=>{
 const f=await fixture(t),tools=new Map();let guards=0;
 nativeTools({taskGateway:f.local,tools:{register:d=>tools.set(d.name,d),guard(){guards++;}}});
 const agent={id:'ordinary',ctx:{preset:'standard'},session:{deriveMessages:()=>[{id:'human-one',role:'user',source:{kind:'user'},content:[{type:'text',text:'background record only'}]}]}};f.agents.set(agent.id,agent);
 const invoke=(name,args,id)=>tools.get(name).execute(args,{agent,callId:id});
 const a=await invoke('task_submit',{goal:'background record only',target:'cloud',intent:'register'},'submit');const b=await invoke('task_submit',{goal:'background record only',target:'cloud',intent:'register'},'submit');assert.equal(a.task_id,b.task_id);
 assert.equal(invoke('task_peer_send',{task_id:a.task_id,kind:'question',text:'status?'},'ask').status,'queued');
 assert.equal(agent.ctx.preset,'standard');assert.equal(guards,0);
 assert.throws(()=>tools.get('task_submit').execute({goal:'forged'},{agent:{...agent},callId:'x'}),/UNBOUND_NATIVE_SESSION/);
 for(const action of ['approve','write','publish'])assert.throws(()=>invoke('task_control',{job_id:'j',action},'control'),/INVALID_CONTROL_ACTION/);
 await assert.rejects(f.local.receive({text:'/status'}),/LEGACY_IM_DISABLED/);assert.doesNotThrow(()=>f.local.snapshot());assert.equal(f.imLookups,0);
});
test('peer ACK cannot acknowledge a message addressed to the other role',async t=>{
 const f=await fixture(t);f.local.peer.enqueue({id:'ack-scope',task_id:f.task,kind:'context',text:'receiver only'});
 const value=JSON.parse(f.local.db.prepare("SELECT payload FROM peer_outbox WHERE id='ack-scope'").get().payload);
 await f.local.call('peer_send',value);await f.local.call('peer_ack',{ids:['ack-scope']});
 assert.equal((await f.local.call('peer_status',{ids:['ack-scope']})).messages[0].status,'broker_saved');
});
test('transport refuses non-loopback cleartext before transmitting token or task data',async t=>{
 const f=await fixture(t);f.local.c.coordinatorUrl='http://192.0.2.1';
 await assert.rejects(f.local.call('status',{task_id:f.task}),/UNSAFE_COORDINATOR_URL/);
});
test('durable peer state cannot silently change namespace',async t=>{
 const f=await fixture(t);
 assert.throws(()=>new Gateway({}, {...f.local.c,namespace:'different'}),/PEER_STATE_IDENTITY_MISMATCH/);
 assert.doesNotThrow(()=>f.local.snapshot());
});
