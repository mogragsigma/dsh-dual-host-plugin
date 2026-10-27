import {ApprovalAuth} from './fixtures/legacy-approval-auth.mjs';
import {softwareAuthenticator} from './fixtures/passkey.mjs';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import test from 'node:test';import assert from 'node:assert/strict';
import {setup} from './delivery-push-approval-fixture.mjs';
import {deliveryReference,deliveryLabel} from '../bundle/delivery-contract.js';
test('push preparation is idempotent, opaque and never queues a side effect',async t=>{
 const f=await setup(t),a=f.stage();assert.equal(a.reference.kind,'push-execution-reference-v1');assert.deepEqual(f.stage().reference,a.reference);
 assert.equal(f.j.db.prepare('SELECT count(*) n FROM delivery_actions').get().n,1);
 const r=f.request(a.reference);assert.equal(r.proposal.delivery.repository_id,101);assert.equal(r.execution,'requires_delivery_runtime_gate');
 assert.throws(()=>f.push.authorize({approval_id:r.id,intent:f.pi()}),/EXECUTION_APPROVAL_REQUIRED/);
});
test('completed commit approval is not push authority; independent human proof grants only push',async t=>{
 const f=await setup(t);assert.throws(()=>f.push.authorize({approval_id:f.original.r.id,intent:f.pi()}),/EXECUTION_APPROVAL_REQUIRED/);
 const p=await f.prompt();await f.decide(p.prompt);const a=f.push.authorize({approval_id:p.r.id,intent:f.pi()});assert.equal(a.scope,'push');assert.equal(a.execution,true);
 assert.equal(f.ledger.view(f.original.r.id).state,'superseded');assert.equal(f.ledger.view(p.r.id).state,'approved');
 assert.throws(()=>f.push.authorize({approval_id:p.r.id,intent:f.intent()}),/EXECUTION_APPROVAL_REQUIRED/);
 const q=f.j.enqueue({...f.input,event_id:'push-queue',approval_id:p.r.id});assert.equal(q.state,'queued');assert.equal(q.dispatched,false);
});
test('proposal and authoritative receipt distinguish push, local commit and runtime adoption',async t=>{
 const f=await setup(t),p=await f.prompt();const text=JSON.parse(p.prompt.body.content).text;
 for(const term of ['限定推送授权','准备时确认该分支不存在','最多发送一次','不包含新建提交','运行环境已经采用'])assert(text.includes(term),term);
 await f.decide(p.prompt);await f.chat.tick();const receipts=[...f.messages.values()].map(m=>JSON.parse(m.body.content).text).filter(x=>x.includes('审批账本回执')&&x.includes('限定推送范围'));
 assert.equal(receipts.length,1);assert(receipts[0].includes('没有开发修改、再次提交'));assert(!receipts[0].includes('未因此获得推送'));
});
for(const scopes of [['commit'],['push','commit'],['publish'],['develop']])test('push reference rejects cross or mixed scope '+scopes,async t=>{
 const f=await setup(t);assert.throws(()=>f.request(f.stage().reference,{scopes}),/DELIVERY_SCOPE_DENIED/);
});
test('delayed approval does not pretend historical remote baseline is fresh',async t=>{
 const f=await setup(t),ref=f.stage().reference;f.time(60000);const r=f.request(ref);assert.equal(r.state,'pending');
 assert(deliveryLabel(r.proposal.delivery).includes('执行前重新核对'));
});
for(const text of ['先等等','不批准此方案','可以，不过请改成另一个分支'])test('semantic nonapproval cannot authorize push: '+text,async t=>{
 const f=await setup(t),p=await f.prompt();await f.decide(p.prompt,text);assert.notEqual(f.ledger.view(p.r.id).state,'approved');
 assert.throws(()=>f.push.authorize({approval_id:p.r.id,intent:f.pi()}),/EXECUTION_APPROVAL_REQUIRED/);
});
for(const change of ['repository','revision','source-event','source-result','proof','disabled-identity'])test('push authority fails closed after '+change,async t=>{
 const f=await setup(t),p=await f.prompt();await f.decide(p.prompt);const i=f.pi(),db=f.j.db;
 if(change==='repository')f.control.repository=false;
 if(change==='revision')db.prepare('UPDATE tasks SET revision=revision+1 WHERE id=?').run(f.task.id);
 if(change==='source-event')db.prepare("DELETE FROM delivery_events WHERE action_id=? AND type='readback_completed'").run(f.source.id);
 if(change==='source-result')db.prepare("UPDATE delivery_actions SET result='{}' WHERE id=?").run(f.source.id);
 if(change==='proof')db.prepare("UPDATE approval_chat_proofs SET proof='{}' WHERE challenge_id=(SELECT challenge_id FROM approval_decisions WHERE request_id=?)").run(p.r.id);
 if(change==='disabled-identity')db.exec('UPDATE approval_chat_bindings SET disabled=1');
 assert.throws(()=>f.push.authorize({approval_id:p.r.id,intent:i}));
});
test('opaque references reject injected scope, objects or alternative plan ids',()=>{
 const r={kind:'push-execution-reference-v1',plan_id:'push-plan-11111111-1111-1111-1111-111111111111',fingerprint:'a'.repeat(64)};
 assert.deepEqual(deliveryReference(r),r);
 for(const patch of [{approved:true},{plan_id:r.plan_id.replace('push','commit')},{objects:[]}])assert.throws(()=>deliveryReference({...r,...patch}),/INVALID_APPROVAL_REFERENCE/);
});

test('new process reopens push plan and trusted decision with identical authority and no effects',async t=>{
 const f=await setup(t),p=await f.prompt();await f.decide(p.prompt);const expected=f.push.authorize({approval_id:p.r.id,intent:f.pi()});
 const child=spawnSync(process.execPath,[fileURLToPath(new URL('./delivery-approval-reopen.mjs',import.meta.url)),f.dir,p.r.id,String(f.ledger.now())],{encoding:'utf8',timeout:10000,env:{PATH:'/usr/bin:/bin'}});
 assert.equal(child.status,0,child.stderr);const out=JSON.parse(child.stdout);assert.deepEqual(out.authority,expected);assert.equal(out.actions,1);assert.equal(out.operations,0);
});

test('optional web confirmation reuses consumed proof; altered challenge fails closed for push',async t=>{
 const f=await setup(t),r=f.request(),auth=new ApprovalAuth(f.ledger,{origin:'http://localhost:19468',rpID:'localhost'}),key=softwareAuthenticator();
 const ticket=auth.issueEnrollment('Synthetic push approver'),e=await auth.begin('enroll',{ticket});await auth.finish('enroll',{challenge_id:e.challenge_id,response:key.response(e.options,{register:true})});
 const q=await auth.begin('decision',{request_id:r.id,action:'approve'});await auth.finish('decision',{challenge_id:q.challenge_id,response:key.response(q.options)});
 assert.equal(f.push.authorize({approval_id:r.id,intent:f.pi()}).scope,'push');
 f.j.db.prepare('UPDATE approval_challenges SET used=0 WHERE id=?').run(q.challenge_id);assert.throws(()=>f.push.authorize({approval_id:r.id,intent:f.pi()}),/PROOF_REQUIRED/);
});
test('generic push scope without precise plan remains record-only',async t=>{
 const f=await setup(t),r=f.request(undefined,{delivery:undefined});assert.equal(r.execution,'disabled');
 const p=await f.prompt(r);await f.decide(p.prompt);assert.equal(f.ledger.view(r.id).state,'approved');
 assert.throws(()=>f.push.authorize({approval_id:r.id,intent:f.pi()}),/EXECUTION_APPROVAL_REQUIRED/);
});
