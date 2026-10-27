import test from 'node:test';import assert from 'node:assert/strict';
import {fixture} from './delivery-approval-fixture.mjs';
import {canonical,digest} from '../bundle/approval-ledger.js';
import {DeliveryApproval} from '../bundle/delivery-approval.js';
import {deliveryReference,deliveryLabel} from '../bundle/delivery-contract.js';
import {renderChatProposal} from '../bundle/approval-chat.js';
import {renderReceipt} from '../bundle/approval-receipts.js';
import {ApprovalAuth} from './fixtures/legacy-approval-auth.mjs';
import {softwareAuthenticator} from './fixtures/passkey.mjs';
test('disabled private bridge cannot stage or authorize; arbitrary objects never become an opaque proposal',t=>{
 const f=fixture(t,{enabled:false});assert.throws(f.stage,/DISABLED/);assert.throws(()=>f.authority('x'),/DISABLED/);
 for(const extra of [{approved:true},{plan:{}},{scopes:['push']},{commit_message:'override'}])assert.throws(()=>deliveryReference({kind:'commit-execution-reference-v1',plan_id:'commit-plan-'+'a'.repeat(36),fingerprint:'b'.repeat(64),...extra}),/INVALID/);
});
test('staging is durable idempotent read-only metadata, not an approval or queued action',t=>{
 const f=fixture(t),a=f.stage();assert.equal(a.grants_execution,false);assert.deepEqual(f.stage().reference,a.reference);assert.equal(f.stage().replayed,true);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM delivery_actions').get().n,0);assert.equal(f.store.task(f.task.id).busy,0);
 assert.throws(()=>f.bridge.stage({...f.input,fingerprint:'0'.repeat(64)}),/EVENT_CONFLICT/);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM approval_requests').get().n,1);
});
test('staging requires live private preflight and exact preview file scope and identity',t=>{
 const f=fixture(t);f.control.ready=false;assert.throws(f.stage,/PREFLIGHT_REQUIRED/);assert.equal(f.store.db.prepare('SELECT count(*) n FROM delivery_approval_plans').get().n,0);
 f.control.ready=true;assert.throws(()=>f.bridge.stage({...f.input,workspace_identity:{...f.identity,directory:{device:'1',inode:'999'}}}),/PREVIEW_MISMATCH/);
 const p=structuredClone(f.p);p.files[0].path='another';const {fingerprint,...b}=p;p.fingerprint=digest(b);f.store.db.prepare('UPDATE delivery_previews SET snapshot=?').run(canonical(p));assert.throws(()=>f.bridge.stage({...f.input,fingerprint:p.fingerprint}),/PREVIEW_MISMATCH/);
});
test('pending request binds exact intent metadata but cannot authorize dispatch',t=>{
 const f=fixture(t),r=f.request(),p=r.proposal.delivery;assert.equal(p.kind,'commit-execution-v1');assert.equal(p.computed_commit_oid,f.compiled.plan.computed_commit_oid);assert.equal(p.max_commits,1);assert.equal(p.signed,false);assert.equal(p.hooks,false);assert.equal(p.filters,false);assert.equal(p.push,false);
 assert.equal(r.execution,'requires_delivery_runtime_gate');assert.equal(f.ledger.check(r.id,'commit').executable,false);assert.throws(()=>f.authority(r.id),/EXECUTION_APPROVAL_REQUIRED/);
 assert.throws(()=>f.journal.enqueue({...f.input,approval_id:r.id}),/EXECUTION_APPROVAL_REQUIRED/);
});
test('real ledger plus synthetic provider reply yields intent-bound authority, not Git execution',async t=>{
 const f=fixture(t),{r,prompt}=await f.start();assert.match(JSON.parse(prompt.body.content).text,/限定提交授权/);await f.decide(prompt);
 const a=f.authority(r.id);assert.equal(a.kind,'delivery-execution-v1');assert.equal(a.scope,'commit');assert.equal(a.intent_fingerprint,f.intent().fingerprint);assert.equal(a.execution,true);
 const before=f.control.inspections;assert.deepEqual(f.authority(r.id),a);assert.equal(f.control.inspections,before); // No hidden filesystem refresh while busy.
 const q=f.journal.enqueue({...f.input,approval_id:r.id}),acquired=f.journal.acquire(q.id);assert(acquired.acquired);assert.deepEqual(f.authority(r.id),a);assert.equal(f.journal.view(q.id).dispatched,false);
 assert.throws(()=>f.journal.enqueue({...f.input,event_id:'duplicate-different-event',approval_id:r.id}),/APPROVAL_ALREADY_USED/);
 for(const s of ['push','publish','deploy','develop'])assert.equal(f.ledger.check(r.id,s).approval_valid,false);
});
for(const [reply,state] of [['先等等','held'],['不批准','rejected'],['可以，不过请改成两段','changes_requested'],['确定吗？','clarification_required']])test('natural language '+state+' cannot authorize old commit plan',async t=>{
 const f=fixture(t),{r,prompt}=await f.start();await f.decide(prompt,reply);assert.equal(f.ledger.view(r.id).state,state);assert.throws(()=>f.authority(r.id),/EXECUTION_APPROVAL_REQUIRED/);assert.equal(f.store.db.prepare('SELECT count(*) n FROM delivery_actions').get().n,0);
});
test('hold then unconditional approval is allowed; later amendment freezes queued authority',async t=>{
 const f=fixture(t),{r,prompt}=await f.start();await f.decide(prompt,'先等等');await f.decide(prompt,'确认');const q=f.journal.enqueue({...f.input,approval_id:r.id});await f.decide(prompt,'同意但是改成两段');assert.equal(f.ledger.view(r.id).state,'changes_requested');assert.throws(()=>f.journal.acquire(q.id),/EXECUTION_APPROVAL_REQUIRED/);assert.equal(f.journal.view(q.id).state,'queued');assert.equal(f.store.task(f.task.id).busy,0);
});
for(const kind of ['expiry','task-spec','workspace-revision','task-block','repository','source-test','source-operation','identity','proof','route','proposal'])test('fresh authority rejects changed '+kind,async t=>{
 const f=fixture(t),{r,prompt}=await f.start();await f.decide(prompt);assert(f.authority(r.id));const db=f.store.db;
 if(kind==='expiry')f.time(86400000);
 if(kind==='task-spec')db.prepare('UPDATE task_catalog SET spec_revision=2 WHERE task_id=?').run(f.task.id);
 if(kind==='workspace-revision')db.prepare('UPDATE tasks SET revision=revision+1 WHERE id=?').run(f.task.id);
 if(kind==='task-block')db.prepare('UPDATE tasks SET blocked=1 WHERE id=?').run(f.task.id);
 if(kind==='repository')f.control.repository=false;
 if(kind==='source-test')db.prepare("UPDATE development_requests SET test_result='{}'").run();
 if(kind==='source-operation')db.prepare("INSERT INTO development_operations(id,request_id,epoch,kind,state,started) VALUES ('late','synthetic-development',1,'test','intent',0)").run();
 if(kind==='identity')db.prepare('UPDATE approval_chat_bindings SET disabled=1').run();
 if(kind==='proof')db.prepare("UPDATE approval_chat_proofs SET proof='{}'").run();
 if(kind==='route')db.prepare("UPDATE approval_chat_deliveries SET state='needs_review' WHERE request_id=?").run(r.id);
 if(kind==='proposal'){const p=JSON.parse(f.ledger.row(r.id).proposal);p.delivery.commit_message='changed';db.prepare('UPDATE approval_requests SET proposal=? WHERE id=?').run(canonical(p),r.id);}
 assert.throws(()=>f.authority(r.id));
});
for(const [field,value] of [['parent','f'.repeat(40)],['branch','dsh-task/another'],['message','changed\n'],['when',2000],['author',{name:'Other',email:'other@example.invalid'}]])test('cannot reuse approval for changed '+field,async t=>{
 const f=fixture(t),{r,prompt}=await f.start();await f.decide(prompt);const intent=f.intent();intent.plan[field]=value;const {fingerprint,...b}=intent.plan;intent.plan.fingerprint=digest(b);const {fingerprint:_,...body}=intent;intent.fingerprint=digest(body);assert.throws(()=>f.bridge.authorize({approval_id:r.id,intent}),/INTENT_CHANGED/);
});
test('unthreaded or foreign provider actor does not approve commit',async t=>{
 const f=fixture(t),{r,prompt}=await f.start();await f.decide(prompt,'确定',{parent_id:undefined});await f.decide(prompt,'确定',{sender:{sender_type:'user',id_type:'open_id',id:'ou_foreign'}});assert.equal(f.ledger.view(r.id).state,'pending');assert.throws(()=>f.authority(r.id),/EXECUTION_APPROVAL_REQUIRED/);
});
test('restart private bridge keeps exact authority; revocation blocks subsequent journal operations',async t=>{
 const f=fixture(t),{r,prompt}=await f.start();await f.decide(prompt);const a=f.authority(r.id);
 const next=new DeliveryApproval({ledger:f.ledger,preview:f.preview,journal:f.journal,enabled:true});f.ledger.delivery=next;assert.deepEqual(next.authorize({approval_id:r.id,intent:f.intent()}),a);
 const q=f.journal.enqueue({...f.input,approval_id:r.id}),active=f.journal.acquire(q.id);f.journal.markDispatched(q.id,active.epoch);await f.decide(prompt,'撤销批准');assert.equal(f.ledger.view(r.id).state,'revoked');assert.throws(()=>f.journal.startOperation(q.id,active.epoch,'object'),/EXECUTION_APPROVAL_REQUIRED/);assert.equal(f.store.task(f.task.id).busy,1);
});
test('old commit-preview-v1 approval stays record-only even with bridge installed',async t=>{
 const f=fixture(t),reference={preview_id:f.p.id,fingerprint:f.p.fingerprint,commit_message:'old preview'};
 const r=f.request(reference),p=r.proposal.delivery;assert.equal(p.kind,'commit-preview-v1');assert.equal(r.execution,'disabled');f.chat.queue(r.id);await f.chat.tick();const route=f.store.db.prepare('SELECT message_id FROM approval_chat_deliveries WHERE request_id=?').get(r.id);await f.decide(f.messages.get(route.message_id));assert.equal(f.ledger.view(r.id).state,'approved');assert.throws(()=>f.authority(r.id),/EXECUTION_APPROVAL_REQUIRED/);
});
test('consumed WebAuthn challenge can authorize; altered challenge cannot',async t=>{
 const f=fixture(t),r=f.request(),auth=new ApprovalAuth(f.ledger,{origin:'http://localhost:19468',rpID:'localhost'}),key=softwareAuthenticator();
 const ticket=auth.issueEnrollment('Synthetic approver'),e=await auth.begin('enroll',{ticket});await auth.finish('enroll',{challenge_id:e.challenge_id,response:key.response(e.options,{register:true})});
 const q=await auth.begin('decision',{request_id:r.id,action:'approve'});await auth.finish('decision',{challenge_id:q.challenge_id,response:key.response(q.options)});assert(f.authority(r.id));
 f.store.db.prepare('UPDATE approval_challenges SET used=0 WHERE id=?').run(q.challenge_id);assert.throws(()=>f.authority(r.id),/PROOF_REQUIRED/);
});
test('proposal and authoritative receipt distinguish grant from execution and disclose unsigned/no-hooks limits',async t=>{
 const f=fixture(t),{r,prompt}=await f.start();await f.decide(prompt);const v=f.ledger.view(r.id),d=f.store.db.prepare('SELECT * FROM approval_decisions WHERE id=?').get(f.ledger.row(r.id).decision_id);
 const label=deliveryLabel(v.proposal.delivery),chat=renderChatProposal(v,true),receipt=renderReceipt(v,d,f.ledger.now());
 for(const term of ['尚不证明落盘','不生成签名','hooks','filters','不包含推送'])assert(label.includes(term));assert.match(chat,/限定提交授权/);assert.match(receipt,/已批准限定提交范围/);assert.match(receipt,/是否已排队、提交或部分生效必须查看/);assert(!receipt.includes('未写仓库、未提交'));
});

test('new process reopens durable evidence and derives same authority without dispatch or new decision',async t=>{
 const f=fixture(t),{r,prompt}=await f.start();await f.decide(prompt);const expected=f.authority(r.id);
 const {spawnSync}=await import('node:child_process'),{fileURLToPath}=await import('node:url');
 const child=spawnSync(process.execPath,[fileURLToPath(new URL('./delivery-approval-reopen.mjs',import.meta.url)),f.dir,r.id,String(f.ledger.now())],{encoding:'utf8',timeout:10000,env:{PATH:'/usr/bin:/bin'}});
 assert.equal(child.status,0,child.stderr);const out=JSON.parse(child.stdout);assert.deepEqual(out.authority,expected);assert.equal(out.actions,0);assert.equal(out.operations,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM approval_decisions').get().n,1);
});
test('approval supersession and re-approval never silently replace a queued action authority',async t=>{
 const f=fixture(t),{r,prompt}=await f.start();await f.decide(prompt);const q=f.journal.enqueue({...f.input,approval_id:r.id});await f.decide(prompt,'先等等');await f.decide(prompt,'确定');
 assert.equal(f.ledger.view(r.id).state,'approved');assert.throws(()=>f.journal.acquire(q.id),/APPROVAL_CHANGED/);assert.equal(f.journal.view(q.id).state,'queued');
 f.request(f.stage().reference,'fresh-request','local');assert.equal(f.ledger.view(r.id).state,'superseded');assert.throws(()=>f.authority(r.id),/EXECUTION_APPROVAL_REQUIRED/);
});
test('decision copied from another request and altered staged snapshot cannot authorize',async t=>{
 const f=fixture(t),{r,prompt}=await f.start();await f.decide(prompt);const row=f.ledger.row(r.id),db=f.store.db;
 db.prepare('UPDATE approval_decisions SET request_id=? WHERE id=?').run('another',row.decision_id);assert.throws(()=>f.authority(r.id),/PROOF_REQUIRED/);db.prepare('UPDATE approval_decisions SET request_id=? WHERE id=?').run(r.id,row.decision_id);
 const plan=db.prepare('SELECT * FROM delivery_approval_plans').get(),snapshot=JSON.parse(plan.snapshot);snapshot.intent.workspace_identity.root='/different';db.prepare('UPDATE delivery_approval_plans SET snapshot=? WHERE id=?').run(canonical(snapshot),plan.id);assert.equal(f.ledger.view(r.id).state,'delivery_changed');assert.throws(()=>f.authority(r.id),/EXECUTION_APPROVAL_REQUIRED/);
});
test('unfinished semantic interpretation blocks authority even after a prior approval',async t=>{
 const f=fixture(t),{r,prompt}=await f.start();await f.decide(prompt);f.store.db.prepare("INSERT INTO approval_chat_evaluations(binding_hash,message_id,request_id,state,created) VALUES (?,?,?,'processing',?)").run(f.chat.bindingHash,'pending-reply',r.id,f.ledger.now());assert.equal(f.ledger.view(r.id).state,'confirmation_review');assert.throws(()=>f.authority(r.id),/EXECUTION_APPROVAL_REQUIRED/);
});
test('non-commit scopes cannot combine with or replace the execution reference',t=>{
 const f=fixture(t),r=f.request(),base={...r.proposal,repository:{binding_revision:1,fingerprint:f.repository.fingerprint},delivery:f.stage().reference};
 for(const scopes of [['push'],['commit','push'],['develop'],['publish'],['deploy']])assert.throws(()=>f.ledger.request('cloud',{task_id:f.task.id,expected_revision:1,event_id:scopes.join('-'),proposal:{...base,scopes}}),/DELIVERY_SCOPE_DENIED/);
});
