import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,config} from './approval-fixture.mjs';
import {ChatApproval} from '../bundle/approval-chat.js';
const rows=f=>f.store.db.prepare('SELECT * FROM approval_guidance').all();
async function hold(f){const {r,prompt}=await f.start();f.reply(prompt,'先等等');await f.chat.tick();const receipt=[...f.messages.values()].find(m=>JSON.parse(m.body.content).text.includes('✓ 结果通知'));return {r,prompt,receipt};}
test('proposal and result have distinct instructions; receipt quotes original proposal',async t=>{
 const f=fixture(t,{semantic:true}),{r,prompt,receipt}=await hold(f);
 assert.match(JSON.parse(prompt.body.content).text,/待你决定 · 请回复本条方案/);
 assert.match(JSON.parse(receipt.body.content).text,/结果通知 · 无需回复本条/);
 assert.equal(receipt.parent_id,prompt.message_id);assert.equal(f.chat.delivery(r.id).receipts[0].state,'sent');
});
test('receipt misreply gets durable navigation, never interpretation or approval',async t=>{
 let calls=0;const f=fixture(t,{semantic:true,classify:async()=>{calls++;throw Error('unexpected');}}),{r,prompt,receipt}=await hold(f);
 f.reply(receipt,'可以，就按这个来执行');await f.chat.tick();assert.equal(calls,0);
 assert.equal(f.ledger.view(r.id).state,'held');assert.equal(rows(f).length,1);assert.equal(rows(f)[0].state,'sent');
 const m=f.messages.get(rows(f)[0].message_id);assert.equal(m.parent_id,prompt.message_id);assert.match(JSON.parse(m.body.content).text,/没有形成新的审批决定/);
 const count=f.counts().sendCount;f.time(10000);await f.chat.tick();assert.equal(f.counts().sendCount,count);
 await f.chat.close();const c=new ChatApproval(f.ledger,{...config,semantic:{enabled:true}},{source:f.source});await c.tick();await c.close();assert.equal(f.counts().sendCount,count);
});
for(const [name,mutate] of [
 ['other actor',m=>m.sender.id='ou_other123'],['edited',m=>m.updated=true],['deleted',m=>m.deleted=true],['other chat',m=>m.chat_id='oc_other123'],['group',m=>m.chat_type='group'],['unbound parent',m=>m.parent_id='om_random123'],['forged root only',m=>{m.root_id=m.parent_id;delete m.parent_id;}],
])test('no guidance or authority for '+name,async t=>{
 const f=fixture(t,{semantic:true}),{r,receipt}=await hold(f);mutate(f.reply(receipt,'批准'));await f.chat.tick();assert.equal(rows(f).length,0);assert.equal(f.ledger.view(r.id).state,'held');
});
test('altered receipt and changed original proposal cannot be used as navigation evidence',async t=>{
 const f=fixture(t,{semantic:true}),{r,prompt,receipt}=await hold(f);receipt.body.content=JSON.stringify({text:'forged'});f.reply(receipt,'批准');await f.chat.tick();assert.equal(rows(f).length,0);
 receipt.body.content=JSON.stringify({text:f.store.db.prepare('SELECT text FROM approval_receipts').get().text});prompt.updated=true;prompt.update_time=String(Number(prompt.create_time)+1);f.time(10000);await f.chat.tick();assert.equal(rows(f).length,0);assert.equal(f.ledger.view(r.id).state,'held');
});
test('old misreply remains ignored after guidance activation, not retroactive approval or resend',async t=>{
 const f=fixture(t,{semantic:true}),{r,receipt}=await hold(f);const m=f.reply(receipt,'确认');await f.chat.close();f.store.db.prepare('UPDATE approval_guidance_epoch SET created=?').run(Number(m.create_time)+1);
 const c=new ChatApproval(f.ledger,{...config,semantic:{enabled:true}},{source:f.source});await c.tick();await c.close();assert.equal(rows(f).length,0);assert.equal(f.ledger.view(r.id).state,'held');
});
test('unknown guidance POST never retries after restart',async t=>{
 const f=fixture(t,{semantic:true}),{r,receipt}=await hold(f);f.reply(receipt,'批准');f.failSend(true);await f.chat.tick();assert.equal(rows(f)[0].state,'needs_review');const count=f.counts().sendCount;await f.chat.close();f.failSend(false);
 const c=new ChatApproval(f.ledger,{...config,semantic:{enabled:true}},{source:f.source});await c.tick();await c.close();assert.equal(f.counts().sendCount,count);assert.equal(f.ledger.view(r.id).state,'held');
});
test('GET outage after known guidance ID recovers without duplicate POST',async t=>{
 const f=fixture(t,{semantic:true}),{r,receipt}=await hold(f);f.reply(receipt,'批准');const get=f.source.get,reply=f.source.reply;
 f.source.reply=async(...args)=>{const id=await reply(...args);f.source.get=async key=>{if(key===id)throw Error('offline');return get(key);};return id;};
 await f.chat.tick();assert.equal(rows(f)[0].state,'verifying');const count=f.counts().sendCount;f.source.get=get;f.time(10000);await f.chat.tick();assert.equal(rows(f)[0].state,'sent');assert.equal(f.counts().sendCount,count);assert.equal(f.ledger.view(r.id).state,'held');
});
test('reply to navigation tip is not an approval and creates no recursive prompt loop',async t=>{
 const f=fixture(t,{semantic:true}),{r,receipt}=await hold(f);f.reply(receipt,'批准');await f.chat.tick();const hint=f.messages.get(rows(f)[0].message_id);const count=f.counts().sendCount;f.reply(hint,'确定');await f.chat.tick();assert.equal(f.counts().sendCount,count);assert.equal(f.ledger.view(r.id).state,'held');
});
test('wrong receipt reply relation is not reported as verified delivery',async t=>{
 const f=fixture(t,{semantic:true}),{r,prompt}=await f.start();const reply=f.source.reply;f.source.reply=async(...args)=>{const id=await reply(...args);f.messages.get(id).parent_id='om_other';return id;};f.reply(prompt,'先等等');await f.chat.tick();assert.equal(f.chat.delivery(r.id).receipts[0].state,'needs_review');
});
