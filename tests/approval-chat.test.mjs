import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {Coordinator} from '../bundle/store.js';
import {TaskCatalog} from '../bundle/task-catalog.js';
import {ApprovalLedger} from '../bundle/approval-ledger.js';
import {ChatApproval,chatAction} from '../bundle/approval-chat.js';
import {FeishuApprovalSource,chatBinding} from '../bundle/approval-feishu.js';
import {makeEnvelope} from '../bundle/task-envelope.js';
const config={provider:'feishu',appId:'cli_test12345',botOpenId:'ou_bot12345',approverOpenId:'ou_owner12345',chatId:'oc_chat12345',appSecretEnv:'TEST_APP_SECRET'};
const proposal={summary:'隔离确认，非业务授权',changes:'不执行',validation:'只做记账',risks:'无仓库绑定',rollback:'撤销',model_policy:{provider:'chosen',model:'glm-5.3'},scopes:['develop'],repository:null};
function fixture(t){
 let now=1792300000000,seq=0;const dir=mkdtempSync(tmpdir()+'/chat-proof-'),store=new Coordinator(dir),catalog=new TaskCatalog(store),ledger=new ApprovalLedger(store,catalog,()=>now);
 const envelope=makeEnvelope({id:'native',session:{deriveMessages:()=>[{id:'m1',role:'user',source:{kind:'user'},content:[{type:'text',text:'隔离审批夹具，不授权真实任务'}]}]}},'local',{goal:'不执行',title:'聊天审批夹具',target:'cloud',intent:'register'});
 const task=store.accept('local',{goal:envelope.goal,task_key:envelope.task_key,source:'native-local',ingress_id:envelope.ingress_id});catalog.head(task.id);
 const req=(event='request')=>ledger.request('local',{task_id:task.id,expected_revision:1,event_id:event,proposal});
 const messages=new Map();let sendCount=0,verifyCount=0,getCount=0,failSend=false,failRead=false;
 const message=(id,text,fields={})=>({message_id:id,chat_id:config.chatId,chat_type:'p2p',msg_type:'text',deleted:false,updated:false,create_time:String(now),update_time:String(now),body:{content:JSON.stringify({text})},sender:{sender_type:'user',id_type:'open_id',id:config.approverOpenId},...fields});
 const source={verifyBot:async()=>{verifyCount++;if(failRead)throw Error('CHAT_PROVIDER_UNAVAILABLE');},send:async(text)=>{sendCount++;if(failSend)throw Error('unknown');const id='om_prompt'+(++seq);messages.set(id,message(id,text,{sender:{sender_type:'app',id_type:'app_id',id:config.appId}}));return id;},list:async()=>[...messages.values()],get:async id=>{getCount++;return structuredClone(messages.get(id));}};
 const chat=new ChatApproval(ledger,config,{source});t.after(async()=>{await chat.close();store.close();rmSync(dir,{recursive:true,force:true});});
 const start=async()=>{const r=req();chat.queue(r.id);await chat.tick();return {r,prompt:[...messages.values()][0]};};
 const reply=(prompt,text='确定',fields={})=>{now+=10000;const id='om_reply'+(++seq),m=message(id,text,{parent_id:prompt.message_id,...fields});messages.set(id,m);return m;};
 return {dir,store,catalog,ledger,task,req,chat,source,messages,start,reply,time:ms=>now+=ms,counts:()=>({sendCount,verifyCount,getCount}),failSend:v=>failSend=v,failRead:v=>failRead=v};
}
for(const command of ['确定','/yes'])test(`reply-bound ${command} records approval only, no execution; duplicate/restart are idempotent`,async t=>{
 const f=fixture(t),{r,prompt}=await f.start();f.reply(prompt,command);await f.chat.tick();const v=f.ledger.view(r.id);assert.equal(v.state,'approved');assert.equal(v.execution,'disabled');assert.equal(v.proposal.model_policy.model,'glm-5.3');assert.equal(f.ledger.check(r.id,'develop').executable,false);assert.equal(f.ledger.check(r.id,'push').approval_valid,false);assert.equal(f.counts().getCount,4);
 f.time(10000);await f.chat.tick();await f.chat.close();const resumed=new ChatApproval(f.ledger,config,{source:f.source});await resumed.tick();await resumed.close();assert.equal(f.store.db.prepare('SELECT count(*) n FROM approval_decisions').get().n,1);assert.equal(f.counts().sendCount,2);
});
const badCases={
 'unthreaded 确定':m=>delete m.parent_id,
 'wrong parent even with matching root':m=>{m.root_id=m.parent_id;m.parent_id='om_another';},
 'wrong user':m=>m.sender.id='ou_other12345',
 'bot impersonation':m=>m.sender.sender_type='app',
 'wrong ID namespace':m=>m.sender.id_type='user_id',
 'wrong chat':m=>m.chat_id='oc_other12345',
 'group not yet supported':m=>m.chat_type='group',
 'edited text':m=>m.updated=true,
 'deleted text':m=>m.deleted=true,
 'ambiguous timestamp':m=>m.update_time=String(Number(m.create_time)+1),
 'historical replay':m=>{m.create_time='1792200000000';m.update_time=m.create_time;},
 'future timestamp':m=>{m.create_time='1892300000000';m.update_time=m.create_time;},
 'forwarded body':m=>m.msg_type='merge_forward',
 'quoted command':m=>m.body.content=JSON.stringify({text:'他说“确定”'}),
 'extended command':m=>m.body.content=JSON.stringify({text:'/yes and publish'}),
};
for(const [name,mutate] of Object.entries(badCases))test('rejects '+name,async t=>{const f=fixture(t),{r,prompt}=await f.start(),m=f.reply(prompt);mutate(m);await f.chat.tick();assert.equal(f.ledger.view(r.id).state,'pending');assert.equal(f.store.db.prepare('SELECT count(*) n FROM approval_chat_proofs').get().n,0);});
for(const kind of ['text','actor','edited','deleted'])test('rejects altered provider proposal '+kind,async t=>{const f=fixture(t),{r,prompt}=await f.start();f.reply(prompt);if(kind==='text')prompt.body.content=JSON.stringify({text:'替换方案'});if(kind==='actor')prompt.sender.id='cli_other12345';if(kind==='edited')prompt.updated=true;if(kind==='deleted')prompt.deleted=true;await f.chat.tick();assert.equal(f.ledger.view(r.id).state,'pending');});
test('cannot approve superseded or expired request',async t=>{const f=fixture(t),{r,prompt}=await f.start();f.req('second');f.reply(prompt);await f.chat.tick();assert.equal(f.ledger.view(r.id).state,'superseded');const latest=f.ledger.list()[1]??f.ledger.list()[0];f.time(86400000);await f.chat.tick();assert.equal(f.store.db.prepare('SELECT count(*) n FROM approval_decisions').get().n,0);});
test('rechecks task revision after network read, transaction leaves no orphan proof',async t=>{const f=fixture(t),{r,prompt}=await f.start();f.reply(prompt);const get=f.source.get;f.source.get=async id=>{const out=await get(id);f.store.db.prepare('UPDATE approval_requests SET task_hash=? WHERE id=?').run('changed',r.id);return out;};await f.chat.tick();assert.equal(f.ledger.view(r.id).state,'stale_revision');assert.equal(f.store.db.prepare('SELECT count(*) n FROM approval_chat_proofs').get().n,0);});
test('provider outage leaves pending then restart restores observation without resend',async t=>{const f=fixture(t),{r,prompt}=await f.start();f.reply(prompt);f.failRead(true);await f.chat.tick();assert.equal(f.ledger.view(r.id).state,'pending');await f.chat.close();f.failRead(false);const resumed=new ChatApproval(f.ledger,config,{source:f.source});await resumed.tick();await resumed.close();assert.equal(f.ledger.view(r.id).state,'approved');assert.equal(f.counts().sendCount,2);});
test('unknown send outcome and sending-at-crash never retry automatically',async t=>{const f=fixture(t),r=f.req();f.chat.queue(r.id);f.failSend(true);await f.chat.tick();assert.equal(f.chat.delivery(r.id).state,'needs_review');f.time(10000);await f.chat.tick();assert.equal(f.counts().sendCount,1);f.store.db.prepare("UPDATE approval_chat_deliveries SET state='sending' WHERE request_id=?").run(r.id);const restarted=new ChatApproval(f.ledger,config,{source:f.source});assert.equal(restarted.delivery(r.id).state,'needs_review');await restarted.close();});
test('exact reply can reject or revoke; generic native tool words are not consumed',async t=>{const f=fixture(t),{r,prompt}=await f.start();for(const text of ['yes','同意','批准','拒绝','no','好','确定吧'])assert.equal(chatAction(text),null);f.reply(prompt);await f.chat.tick();f.reply(prompt,'撤销此方案');await f.chat.tick();assert.equal(f.ledger.view(r.id).state,'revoked');assert.equal(f.ledger.check(r.id,'develop').approval_valid,false);});
test('explicit rejection does not grant anything',async t=>{const f=fixture(t),{r,prompt}=await f.start();f.reply(prompt,'不批准此方案');await f.chat.tick();assert.equal(f.ledger.view(r.id).state,'rejected');});
test('changed or disabled approver binding revokes previous approvals; cannot silently reactivate',async t=>{const f=fixture(t),{r,prompt}=await f.start();f.reply(prompt);await f.chat.tick();const other=new ChatApproval(f.ledger,{...config,approverOpenId:'ou_newowner12345'},{source:f.source});await other.close();assert.equal(f.ledger.view(r.id).state,'identity_revoked');assert.throws(()=>new ChatApproval(f.ledger,config,{source:f.source}),/REACTIVATION_REQUIRES_REVIEW/);});
test('close while provider lookup pending prevents new approval',async t=>{const f=fixture(t),{r,prompt}=await f.start();f.reply(prompt);let release;const p=new Promise(resolve=>release=resolve),old=f.source.list;f.source.list=async()=>{await p;return old();};const tick=f.chat.tick(),closed=f.chat.close();release();await tick;await closed;assert.equal(f.ledger.view(r.id).state,'pending');});
test('two proposals require exact parent; no latest-task guessing',async t=>{const f=fixture(t),{r,prompt}=await f.start();const newer=f.req('newer');f.chat.queue(newer.id);f.time(10000);await f.chat.tick();f.reply(prompt);await f.chat.tick();assert.equal(f.ledger.view(newer.id).state,'pending');});
test('adapter pins HTTPS endpoint, uses no private IM API and handles split unicode safely',async()=>{
 const calls=[];const fetcher=async(url,opts)=>{calls.push({url,opts});const data=url.endsWith('/internal')?{code:0,tenant_access_token:'test-token',expire:7200}:url.endsWith('/info')?{code:0,bot:{open_id:config.botOpenId}}:url.includes('/chats/')?{code:0,data:{chat_mode:'p2p'}}:{code:0,data:{items:[{message_id:'om_test12345',body:{content:'确定'}}]}};
 const bytes=new TextEncoder().encode(JSON.stringify(data));return new Response(new ReadableStream({start(c){for(const byte of bytes)c.enqueue(Uint8Array.of(byte));c.close();}}));};
 const source=new FeishuApprovalSource(config,{fetcher,env:{TEST_APP_SECRET:'fixture'}});await source.verifyBot();assert.equal((await source.get('om_test12345')).body.content,'确定');assert(calls.every(x=>x.url.startsWith('https://open.feishu.cn/open-apis/')&&x.opts.redirect==='error'));assert.equal(calls.filter(x=>x.url.endsWith('/internal')).length,1);await assert.rejects(source.get('../../private'),/INVALID_PROVIDER_MESSAGE_ID/);
});
test('adapter rejects bot mismatch, missing credentials, unsafe config and paginated overflow',async()=>{
 assert.throws(()=>chatBinding({...config,appId:'../../other'}),/INVALID_CHAT/);assert.throws(()=>new FeishuApprovalSource(config,{env:{}}),/CREDENTIAL_UNAVAILABLE/);
 const source=new FeishuApprovalSource(config,{env:{TEST_APP_SECRET:'test'}});source.api=async path=>path.includes('/info')?{bot:{open_id:'ou_notours'}}:{data:{items:[],has_more:true,page_token:String(Math.random())}};await assert.rejects(source.verifyBot(),/CHAT_BOT_CHANGED/);await assert.rejects(source.list(1792300000000),/WINDOW_TOO_BUSY/);
});
test('provider automatic pre-publication update is pinned; any later update invalidates the proposal',async t=>{
 const f=fixture(t),oldSend=f.source.send;f.source.send=async(...args)=>{const id=await oldSend(...args),m=f.messages.get(id);m.updated=true;m.update_time=String(Number(m.create_time)+100);return id;};
 const {r,prompt}=await f.start();f.reply(prompt);await f.chat.tick();assert.equal(f.ledger.view(r.id).state,'approved');
});
test('same-text edit after pinned publication cannot be used as approval',async t=>{
 const f=fixture(t),{r,prompt}=await f.start();prompt.updated=true;prompt.update_time=String(Number(prompt.create_time)+100);f.reply(prompt);await f.chat.tick();assert.equal(f.ledger.view(r.id).state,'pending');
});
test('official individual GET may omit chat_type; route is independently verified via chat metadata',async t=>{
 const f=fixture(t),get=f.source.get;f.source.get=async id=>{const m=await get(id);delete m.chat_type;return m;};const {r,prompt}=await f.start();f.reply(prompt);await f.chat.tick();assert.equal(f.ledger.view(r.id).state,'approved');assert(f.counts().verifyCount>=2);
});
test('bot identity drift invalidates existing chat approvals, not just future messages',async t=>{
 const f=fixture(t),{r,prompt}=await f.start();f.reply(prompt);await f.chat.tick();f.time(10000);f.source.verifyBot=async()=>{throw Error('CHAT_BOT_CHANGED');};await f.chat.tick();assert.equal(f.ledger.view(r.id).state,'identity_revoked');assert.equal(f.chat.snapshot().bindingEnabled,false);
});
test('official adapter refuses non-private routes even if bot is correct',async()=>{
 const s=new FeishuApprovalSource(config,{env:{TEST_APP_SECRET:'test'}});s.api=async path=>path.endsWith('/info')?{bot:{open_id:config.botOpenId}}:{data:{chat_mode:'group'}};await assert.rejects(s.verifyBot(),/PRIVATE_ROUTE_REQUIRED/);
});
