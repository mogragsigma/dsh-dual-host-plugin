import test from 'node:test';
import assert from 'node:assert/strict';
import {FeishuApprovalSource} from '../bundle/approval-feishu.js';
import {fixture,config} from './approval-fixture.mjs';
test('official reply uses original parent, persistent UUID and main-chat quote; no user identity',async()=>{
 const source=new FeishuApprovalSource(config,{env:{TEST_APP_SECRET:'fixture'}});let sent;
 source.api=async(path,options)=>{sent={path,...JSON.parse(options.body)};return {data:{message_id:'om_reply123',chat_id:config.chatId}};};
 assert.equal(await source.reply('om_original123','结果通知','test-uuid'),'om_reply123');
 assert.deepEqual(sent,{path:'/im/v1/messages/om_original123/reply',msg_type:'text',content:JSON.stringify({text:'结果通知'}),reply_in_thread:false,uuid:'test-uuid'});
 await assert.rejects(source.reply('../../other','x','id'),/INVALID_PROVIDER_MESSAGE_ID/);
});
test('reply response for another chat is uncertain, not permission to resend',async()=>{
 const source=new FeishuApprovalSource(config,{env:{TEST_APP_SECRET:'fixture'}});source.api=async()=>({data:{message_id:'om_reply123',chat_id:'oc_other'}});
 await assert.rejects(source.reply('om_original123','x','id'),/CHAT_SEND_RESULT_UNKNOWN/);
});
test('queued navigation rechecks original proposal and stops on mutation',async t=>{
 const f=fixture(t,{semantic:true}),{r,prompt}=await f.start();f.reply(prompt,'先等等');await f.chat.tick();const receipt=[...f.messages.values()].find(m=>JSON.parse(m.body.content).text.includes('✓ 结果通知'));
 f.reply(receipt,'批准');await f.chat.guidance.observe([...f.messages.values()]);prompt.updated=true;prompt.update_time=String(Number(prompt.create_time)+1);const count=f.counts().sendCount;
 await f.chat.guidance.cycle();assert.equal(f.counts().sendCount,count);assert.equal(f.chat.guidance.status(r.id)[0].state,'needs_review');assert.equal(f.ledger.view(r.id).state,'held');
});
test('navigation queue close prevents late sends',async t=>{
 const f=fixture(t,{semantic:true}),{r,prompt}=await f.start();f.reply(prompt,'先等等');await f.chat.tick();const receipt=[...f.messages.values()].find(m=>JSON.parse(m.body.content).text.includes('✓ 结果通知'));
 f.reply(receipt,'批准');await f.chat.guidance.observe([...f.messages.values()]);let release;f.source.verifyBot=()=>new Promise(r=>release=r);const work=f.chat.guidance.cycle();const count=f.counts().sendCount;f.chat.guidance.close();release();await work;assert.equal(f.counts().sendCount,count);assert.equal(f.ledger.view(r.id).state,'held');
});
