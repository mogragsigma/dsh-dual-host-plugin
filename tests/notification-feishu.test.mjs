import test from 'node:test';
import assert from 'node:assert/strict';
import {FeishuNotificationSender,feishuNotificationTarget} from '../bundle/notification-feishu.js';
import {targets} from '../bundle/notification-contract.js';
const c={provider:'feishu',appId:'cli_test1234',botOpenId:'ou_bot1234',approverOpenId:'ou_user1234',chatId:'oc_chat1234',appSecretEnv:'TEST_FEISHU_SECRET'};
const target=feishuNotificationTarget(c,{host:'cloud',alias:'direct-test',label:'测试私聊'}),route=targets([target])[0];
const opts={expectedFingerprint:target.expectedFingerprint,expectedTargetDigest:target.expectedTargetDigest,format:'plain',receipt:true,idempotencyKey:'a'.repeat(48)};
const ok=d=>new Response(JSON.stringify({code:0,...d}));
function fake({fault,afterRead}={}){let calls=[];const fetcher=async(url,args)=>{calls.push({url,args});assert(url.startsWith('https://open.feishu.cn/open-apis/'));assert.equal(args.redirect,'error');if(url.endsWith('/internal'))return ok({tenant_access_token:'test-secret-token',expire:7200});if(url.endsWith('/info'))return ok({bot:{open_id:fault==='bot'?'ou_other1234':c.botOpenId}});if(url.includes('/chats/')){await afterRead?.();return ok({data:{chat_mode:fault==='group'?'group':'p2p'}});}if(fault==='send')throw Error('private provider detail');if(fault==='chat')return ok({data:{message_id:'om_test1234',chat_id:'oc_wrong1234'}});return ok({data:{message_id:'om_test1234',chat_id:c.chatId}});};return {calls,s:new FeishuNotificationSender(c,{fetcher,env:{TEST_FEISHU_SECRET:'fixture'}})};}
test('official opt-in text verifies pinned bot and private conversation; no consumer or third-party calls',async()=>{
 const f=fake(),r=await f.s.sendChecked(target.botId,target.targetId,'只读验收',opts);assert.equal(r.receipt.messageId,'om_test1234');assert.equal(r.receipt.conversationId,c.chatId);assert.equal(f.calls.length,4);const payload=JSON.parse(f.calls[3].args.body);assert.equal(payload.msg_type,'text');assert.equal(payload.receive_id,c.chatId);assert.equal(payload.uuid,opts.idempotencyKey);assert.equal(route.route.transport,'feishu-openapi');
 const legacy=targets([{...target,transport:undefined}])[0];assert.notEqual(legacy.route_hash,route.route_hash);
});
test('direct route is not a fallback and requires explicit message receipts and immutable pins',async()=>{
 assert.throws(()=>targets([{...target,transport:'other'}]),/CONFIG_INVALID/);assert.throws(()=>targets([{...target,receipt_mode:'acceptance'}]),/CONFIG_INVALID/);
 for(const [bot,targetId,change] of [['wrong',target.targetId,{}],[target.botId,'wrong',{}],[target.botId,target.targetId,{expectedFingerprint:'b'.repeat(64)}],[target.botId,target.targetId,{expectedTargetDigest:'c'.repeat(64)}]]){const f=fake();await assert.rejects(f.s.sendChecked(bot,targetId,'x',{...opts,...change}),e=>['account-changed','target-changed'].includes(e.code));assert.equal(f.calls.length,0);}
});
for(const fault of ['bot','group'])test('read-only preflight rejects changed '+fault+' before sending',async()=>{const f=fake({fault});await assert.rejects(f.s.sendChecked(target.botId,target.targetId,'x',opts),e=>e.code==='account-changed');assert(f.calls.every(x=>!x.url.includes('/messages')));});
for(const fault of ['send','chat'])test('after send boundary '+fault+' cannot advertise a safe retry',async()=>{const f=fake({fault});await assert.rejects(f.s.sendChecked(target.botId,target.targetId,'x',opts),e=>!e.code);assert.equal(f.calls.filter(x=>x.url.includes('/messages')).length,1);});
test('abort during slow preflight cannot produce a late send after endpoint timeout',async()=>{const ctrl=new AbortController(),f=fake({afterRead:()=>ctrl.abort()});await assert.rejects(f.s.sendChecked(target.botId,target.targetId,'x',{...opts,signal:ctrl.signal}));assert.equal(f.calls.filter(x=>x.url.includes('/messages')).length,0);});
test('missing credentials fail before any network use, without exposing environment data',async()=>{const s=new FeishuNotificationSender(c,{env:{},fetcher:()=>{throw Error('must not run');}});await assert.rejects(s.sendChecked(target.botId,target.targetId,'x',opts),e=>e.code==='account-unverified'&&!e.message.includes('SECRET'));});
