import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,config} from './approval-fixture.mjs';
import {ChatApproval} from '../bundle/approval-chat.js';
const rows=f=>f.store.db.prepare('SELECT * FROM approval_receipts ORDER BY created,decision_id').all();
const queue=async f=>{const {r,prompt}=await f.start();f.chat.receipts.closed=true;f.reply(prompt);await f.chat.tick();return {r,prompt};};
const resume=async f=>{await f.chat.close();const c=new ChatApproval(f.ledger,config,{source:f.source});return c;};
test('approval and durable receipt intent commit atomically; receipt is exact ledger snapshot not model prose',async t=>{
 const f=fixture(t),{r}=await queue(f);assert.equal(rows(f).length,1);assert.equal(rows(f)[0].state,'queued');const c=await resume(f);await c.tick();await c.close();const out=rows(f)[0];assert.equal(out.state,'sent');assert.equal(out.snapshot_state,'approved');assert.match(out.text,/非模型回复/);assert.match(out.text,/未启动开发、未写仓库/);assert.match(out.text,/glm-5.3/);assert.equal(c.delivery(r.id).receipts[0].transport,'provider_verified_not_read');assert.equal(f.ledger.check(r.id,'develop').executable,false);
});
test('failed receipt insertion rolls back proof and decision together',async t=>{
 const f=fixture(t),{r,prompt}=await f.start();f.store.db.exec("CREATE TRIGGER abort_receipt BEFORE INSERT ON approval_receipts BEGIN SELECT RAISE(ABORT,'fixture'); END;");f.reply(prompt);await f.chat.tick();assert.equal(f.ledger.view(r.id).state,'pending');for(const table of ['approval_chat_proofs','approval_decisions','approval_receipts'])assert.equal(f.store.db.prepare('SELECT count(*) n FROM '+table).get().n,0);
});
test('duplicate polling and restart deliver only one receipt per decision',async t=>{
 const f=fixture(t),{r,prompt}=await f.start();f.reply(prompt);await f.chat.tick();const count=f.counts().sendCount;for(let i=0;i<3;i++){f.time(10000);await f.chat.tick();}const c=await resume(f);await c.tick();await c.close();assert.equal(f.counts().sendCount,count);assert.equal(rows(f).length,1);assert.equal(c.delivery(r.id).receipts[0].state,'sent');
});
test('verified rejection still sends receipt after request observation becomes inactive',async t=>{
 const f=fixture(t),{r,prompt}=await f.start();f.chat.receipts.closed=true;f.reply(prompt,'不批准此方案');await f.chat.tick();const c=await resume(f);await c.tick();await c.close();assert.equal(f.ledger.view(r.id).state,'rejected');assert.equal(rows(f)[0].state,'sent');assert.match(rows(f)[0].text,/已拒绝/);
});
test('queued approval followed by revoke never emits a currently-approved claim',async t=>{
 const f=fixture(t),{r,prompt}=await queue(f);f.reply(prompt,'撤销此方案');await f.chat.tick();assert.equal(rows(f).length,2);const c=await resume(f);await c.tick();await c.close();assert.equal(f.ledger.view(r.id).state,'revoked');for(const row of rows(f)){assert.equal(row.snapshot_state,'revoked');assert.match(row.text,/有效状态：已撤销/);assert.equal(row.state,'sent');}
});
for(const state of ['expired','superseded','stale_revision'])test('delayed receipt recomputes effective '+state,async t=>{
 const f=fixture(t),{r}=await queue(f);if(state==='expired')f.time(86400000);if(state==='superseded')f.req('next');if(state==='stale_revision')f.store.db.prepare('UPDATE approval_requests SET task_hash=? WHERE id=?').run('changed',r.id);const c=await resume(f);await c.tick();await c.close();assert.equal(rows(f)[0].snapshot_state,state);assert.equal(rows(f)[0].state,'sent');
});
test('preflight outage retries with bounded backoff without submission and recovers',async t=>{
 const f=fixture(t);await queue(f);f.failRead(true);const c=await resume(f);await c.tick();assert.equal(rows(f)[0].state,'queued');assert.equal(f.counts().sendCount,1);await c.tick();assert.equal(rows(f)[0].attempts,1);f.failRead(false);f.time(10000);await c.tick();await c.close();assert.equal(rows(f)[0].state,'sent');assert.equal(f.counts().sendCount,2);
});
test('unknown POST outcome never retries even after restart and UUID deduplication window',async t=>{
 const f=fixture(t);await queue(f);f.failSend(true);const c=await resume(f);await c.tick();await c.close();assert.equal(rows(f)[0].state,'needs_review');const count=f.counts().sendCount;f.failSend(false);f.time(86400000);const d=new ChatApproval(f.ledger,config,{source:f.source});await d.tick();await d.close();assert.equal(f.counts().sendCount,count);
});
test('known provider ID survives GET outage and restart, verification is read-only',async t=>{
 const f=fixture(t);await queue(f);const get=f.source.get;f.source.get=async id=>{if(id!=='om_prompt1')throw Error('CHAT_PROVIDER_UNAVAILABLE');return get(id);};const c=await resume(f);await c.tick();await c.close();assert.equal(rows(f)[0].state,'verifying');assert.ok(rows(f)[0].message_id);f.source.get=get;f.time(10000);const d=new ChatApproval(f.ledger,config,{source:f.source});await d.tick();await d.close();assert.equal(rows(f)[0].state,'sent');assert.equal(f.counts().sendCount,2);
});
test('crash with unknown submitted message becomes needs_review, never queued',async t=>{
 const f=fixture(t);await queue(f);f.store.db.exec("UPDATE approval_receipts SET state='sending'");const c=await resume(f);await c.tick();await c.close();assert.equal(rows(f)[0].state,'needs_review');assert.equal(f.counts().sendCount,1);
});
test('receipt content mismatch does not undo approval or fabricate transport success',async t=>{
 const f=fixture(t),{r}=await queue(f);const send=f.source.send;f.source.send=async(...args)=>{const id=await send(...args);f.messages.get(id).body.content=JSON.stringify({text:'模型说成功'});return id;};const c=await resume(f);await c.tick();await c.close();assert.equal(rows(f)[0].last_error,'CHAT_RECEIPT_CONTENT_MISMATCH');assert.equal(rows(f)[0].state,'needs_review');assert.equal(f.ledger.view(r.id).state,'approved');
});
test('binding change cannot reroute prior receipts to another user',async t=>{
 const f=fixture(t);await queue(f);await f.chat.close();const c=new ChatApproval(f.ledger,{...config,approverOpenId:'ou_another12345'},{source:f.source});await c.tick();await c.close();assert.equal(f.counts().sendCount,1);assert.equal(rows(f)[0].state,'queued');
});
test('v0.9.1 committed decision with no receipt is backfilled once',async t=>{
 const f=fixture(t);await queue(f);f.store.db.exec('DELETE FROM approval_receipts');const c=await resume(f);assert.equal(rows(f).length,1);await c.tick();await c.close();const d=new ChatApproval(f.ledger,config,{source:f.source});await d.tick();await d.close();assert.equal(f.counts().sendCount,2);assert.equal(rows(f).length,1);
});
test('close during receipt preflight preserves queue and prevents late POST',async t=>{
 const f=fixture(t);await queue(f);const c=await resume(f);let release;const blocked=new Promise(resolve=>release=resolve);f.source.verifyBot=async()=>blocked;const running=c.receipts.cycle();const close=c.close();release();await running;await close;assert.equal(rows(f)[0].state,'queued');assert.equal(f.counts().sendCount,1);
});
test('eight safe preflight failures need review rather than retry forever',async t=>{
 const f=fixture(t);await queue(f);f.failRead(true);const c=await resume(f);for(let i=0;i<9;i++){f.time(400000);await c.receipts.cycle();}await c.close();assert.equal(rows(f)[0].attempts,8);assert.equal(rows(f)[0].state,'needs_review');assert.equal(f.counts().sendCount,1);
});
