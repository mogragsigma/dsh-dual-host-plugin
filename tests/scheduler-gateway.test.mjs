import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {Gateway} from '../bundle/index.js';
import {signedNotice} from '../bundle/protocol.js';
const ctx=()=>({on(){},effect(){},agents:{list:()=>[],get:()=>undefined},agentPresets:{composedPreset:()=>undefined}});
function setup(t){const root=mkdtempSync(tmpdir()+'/dsh-job-gate-'),tokenFile=root+'/tokens.json';writeFileSync(tokenFile,JSON.stringify({localToken:'l'.repeat(32),cloudToken:'c'.repeat(32),a2aKey:'a'.repeat(32)}),{mode:0o600});const c={role:'cloud',legacyFeishu:true,peerEnabled:false,namespace:'unit',chatId:'oc_test',ownerOpenId:'ou_owner',peerOpenId:'ou_peer',stateDir:root+'/state',tokenFile,port:0,scheduler:{lockPort:0,intervalMs:60000}};const g=new Gateway(ctx(),c,{scheduler:{allowEphemeralLock:true}});t.after(async()=>{await g.close();rmSync(root,{recursive:true,force:true});});return {g,c};}
const message=(text,msgId='m1',userId='ou_owner')=>({platform:'feishu',chatId:'oc_test',senderType:'user',userId,text,msgId});
test('intake alone never activates worker; explicit model-bound schedule is durable/idempotent',async t=>{
 const {g}=setup(t);await g.receive(message('/task one only register'));assert.equal(g.scheduler.jobs.db.prepare('SELECT count(*) n FROM jobs').get().n,0);
 const r=await g.receive(message('/run one selected-provider selected-model 30','run1'));assert.equal(r.status,'queued');assert.equal((await g.receive(message('/run one selected-provider selected-model 30','run1'))).job_id,r.job_id);
 assert.deepEqual(r.model_policy,{provider:'selected-provider',model:'selected-model'});assert.equal(g.scheduler.active.size,0);
 await assert.rejects(g.receive(message('/run one wrong route 30','run1')),/INVALID_COMMAND/);
});
test('Feishu explicit reasoning parameter is persisted without changing global defaults',async t=>{
 const {g}=setup(t);await g.receive(message('/task reason only plan'));
 const r=await g.receive(message('/run reason chosen glm-5.3 0 low','reason'));
 assert.deepEqual(r.model_policy,{provider:'chosen',model:'glm-5.3',reasoningEffort:'low'});
 assert.deepEqual(JSON.parse(g.scheduler.jobs.get(r.job_id).policy),r.model_policy);
});
test('authenticated cloud owner can approve exact immutable proposal, no development enabled',async t=>{
 const {g}=setup(t);await g.receive(message('/task one task'));const r=await g.receive(message('/run one p m','run'));const j=g.scheduler.jobs.claim(new Set(['plan']),new Set(['plan']));const p=g.scheduler.jobs.finish(j,{outcome:'proposal',summary:'ready',proposal:'test scope'});
 await assert.rejects(g.receive(message('/approve '+j.id+' '+p.proposal_hash,'unknown','ou_attacker')),/OWNER_DENIED/);
 await assert.rejects(g.call('job_control',{job_id:j.id,action:'approve',event_id:'forged',proposal_hash:p.proposal_hash}),/METHOD_DENIED/);
 const a=await g.receive(message('/approve '+j.id+' '+p.proposal_hash,'approve'));assert.equal(a.status,'waiting_capability');assert.equal(g.scheduler.jobs.get(j.id).approved_by,'ou_owner');
 assert.deepEqual(await g.receive(message('/approve '+j.id+' '+p.proposal_hash,'approve')),a);assert.equal(g.scheduler.jobs.claim(new Set(['plan','development']),new Set()),null);
});
test('signed A2A is advisory and cannot approve; local bridge cannot impersonate cloud owner',async t=>{
 const {g,c}=setup(t);const a=await g.receive(message('/task one task'));const text=signedNotice({...c,role:'local'},'a'.repeat(32),{id:a.task_id,epoch:1,revision:0},'advisory');await g.receive({...message(text),senderType:'bot',userId:'ou_peer'});
 assert.equal(g.scheduler.jobs.db.prepare('SELECT count(*) n FROM controls').get().n,0);
 g.c.role='local';await assert.rejects(g.receive(message('/approve job-'+crypto.randomUUID()+' '+'0'.repeat(64),'localapprove')),/INVALID_COMMAND/);g.c.role='cloud';
});
test('public RPC rejects approval and arbitrary capabilities even with peer token',async t=>{
 const {g}=setup(t);await g.start();const url='http://127.0.0.1:'+g.server.address().port+'/rpc';
 for(const method of ['approve','register','worker_report']){const r=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+'l'.repeat(32),'Content-Type':'application/json'},body:JSON.stringify({method,args:{}})});assert.equal(r.status,400);}
 await assert.rejects(g.call('schedule',{task_id:'bad',kind:'development',policy:{provider:'p',model:'m'},trigger_id:'x'}),/TASK_NOT_FOUND/);
});
test('checkpoint notification moves idempotently into existing durable outbox without direct send',async t=>{
 const {g}=setup(t);await g.receive(message('/task one task'));await g.receive(message('/run one p m','run'));const j=g.scheduler.jobs.claim(new Set(['plan']),new Set(['plan']));g.scheduler.jobs.finish(j,{outcome:'proposal',summary:'ready',proposal:'scope'});
 await g.tick();const id='job-result:'+j.run_id;assert.equal(g.db.prepare('SELECT count(*) n FROM receipts WHERE id=?').get(id).n,1);
 g.scheduler.jobs.db.prepare('UPDATE job_notifications SET delivered=0 WHERE id=?').run(id);await g.tick();assert.equal(g.db.prepare('SELECT count(*) n FROM receipts WHERE id=?').get(id).n,1);
});
test('activation rechecks current task block rather than only enqueue-time authorization',async t=>{
 const {g}=setup(t);const task=await g.receive(message('/task one task'));const r=await g.receive(message('/run one p m','run'));
 g.store.db.prepare('UPDATE tasks SET blocked=1 WHERE id=?').run(task.task_id);await g.scheduler.start();g.scheduler.tick();await Promise.all([...g.scheduler.active.values()].map(x=>x.run));
 assert.equal(g.scheduler.jobs.get(r.job_id).status,'needs_review');assert.equal(g.scheduler.jobs.get(r.job_id).error,'TASK_BLOCKED');
});
