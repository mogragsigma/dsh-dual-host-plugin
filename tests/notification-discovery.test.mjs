import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {Gateway} from '../bundle/index.js';
import {NotificationDiscovery} from '../bundle/notification-discovery.js';
import {TaskNotifications} from '../bundle/task-notifications.js';
import {digest} from '../bundle/notification-contract.js';
import {createHash} from 'node:crypto';
const sha=x=>createHash('sha256').update(x).digest('hex');
async function setup(t,role='cloud'){
 const root=mkdtempSync(tmpdir()+'/notify-discovery-');writeFileSync(root+'/tokens.json',JSON.stringify({localToken:'l'.repeat(32),cloudToken:'c'.repeat(32)}),{mode:0o600});let now=Date.now(),version=1;
 let bot={botId:'private_bot_001',channel:'feishu'},account={version:1,botId:bot.botId,channel:bot.channel,account:{fingerprint:'a'.repeat(64),name:'测试机器人'},connected:true,capabilities:['proactive-text-checked','proactive-receipt-checked']},target={targetId:'private_target_001',name:'测试通知群',kind:'group',route:{chatId:'private_chat_001'}};
 const calls=[],service={contractVersion:1,receiptVersion:1,listBots:async()=>{calls.push('list');return [bot];},describeBot:async()=>{calls.push('describe');return structuredClone(account);},listTargets:async()=>{calls.push('targets');return {botId:bot.botId,channel:bot.channel,targets:[structuredClone(target)]};},sendChecked(){throw Error('No sends allowed');},createTarget(){throw Error('No IM writes');},updateTarget(){throw Error('No IM writes');}};
 const ctx={on(){},effect(){},agents:{list:()=>[],get(){}},get:n=>n==='dshIm'?service:null};
 const g=new Gateway(ctx,{role,entryMode:'native',namespace:'discover-test',stateDir:root+'/'+role,tokenFile:root+'/tokens.json',port:0},{now:()=>now});t.after(async()=>{await g.close();rmSync(root,{recursive:true,force:true});});
 const source=(text,node=role)=>[{role:node,session_id:'synthetic-entry',message_id:'synthetic-'+version++,text,sha256:sha(text)}];
 const args=item=>{const q='请添加'+item.label+'为本项目通知目标';return {host:role,candidate_id:item.candidate_id,label:item.label,authorization_quote:q,sources:source(q),event_id:'target-'+version++};};
 return {g,service,calls,bot,account,target,source,args,advance:ms=>now+=ms,scan:()=>g.call('notification_discover',{host:role})};
}
test('discovery only calls public reads; redacts native IDs, routes and fingerprints; does not imply consent',async t=>{
 const f=await setup(t),r=await f.scan();assert.equal(r.items.length,1);assert(r.items[0].eligible);assert.equal(r.grants_delivery,false);assert.equal(r.items[0].receipt_mode,'message');assert.equal(r.images,false);assert.equal(r.files,false);
 for(const secret of ['private_bot','private_chat','private_target','a'.repeat(64)])assert(!JSON.stringify(r).includes(secret));assert.deepEqual(f.calls,['list','describe','targets']);assert.equal(f.g.notifications.inventory().items.length,0);
});
test('capability is per account and target, not the IM package advertised channel count',async t=>{
 const f=await setup(t);f.account.capabilities=[];let r=await f.scan();assert.equal(r.items[0].eligible,false);assert.equal(r.state,'partial');
 f.service.describeBot=async()=>{throw Object.assign(Error('sensitive SDK error'),{code:'capability-unavailable'});};r=await f.scan();assert.equal(r.state,'partial');assert.equal(r.accounts[0].error,'NOTIFICATION_CAPABILITY_UNAVAILABLE');assert(!JSON.stringify(r).includes('sensitive'));
 f.service.contractVersion=2;r=await f.scan();assert.equal(r.state,'unavailable');
});
test('private targets expose weak acceptance and never manufacture receipt support',async t=>{
 const f=await setup(t);Object.assign(f.target,{name:'测试私聊',kind:'user',route:{openId:'private_open_id'}});const r=await f.scan();assert.equal(r.items[0].receipt_mode,'acceptance');assert(r.items[0].eligible);
});
test('discovery candidate cannot survive expiry, refresh, route/account changes or service replacement',async t=>{
 const f=await setup(t),d=f.g.notifications.discovery;let r=await f.scan(),id=r.items[0].candidate_id;
 f.advance(300001);await assert.rejects(d.resolve(id,'测试通知群'),/EXPIRED/);r=await f.scan();id=r.items[0].candidate_id;await f.scan();await assert.rejects(d.resolve(id,'测试通知群'),/EXPIRED/);
 r=await f.scan();f.target.route.chatId='changed';await assert.rejects(d.resolve(r.items[0].candidate_id,'测试通知群'),/CHANGED/);
 r=await f.scan();f.account.account.fingerprint='b'.repeat(64);await assert.rejects(d.resolve(r.items[0].candidate_id,'测试通知群'),/CHANGED/);
 r=await f.scan();d.service=()=>({...f.service});await assert.rejects(d.resolve(r.items[0].candidate_id,'测试通知群'),/EXPIRED/);
});
test('route digest follows official sorted kind/route contract and saved target is re-read before adding',async t=>{
 const f=await setup(t),r=await f.scan(),a=f.args(r.items[0]);const v=await f.g.call('notification_target_add',a);assert.equal(v.delivery_consent,false);assert.equal(v.publication,'cloud_saved');
 const entry=f.g.notifications.config.get(v.key);assert.equal(entry.route.expectedTargetDigest,digest({kind:'group',route:{chatId:'private_chat_001'}}));assert.equal(f.calls.filter(x=>x==='describe').length,2);assert.equal(f.calls.filter(x=>x==='targets').length,2);
 const replay=await f.g.call('notification_target_add',a);assert.deepEqual(replay,v);assert.equal(f.calls.length,5);assert.equal(f.g.db.prepare('SELECT count(*) n FROM notification_bindings').get().n,0);
});
test('adding requires exact fresh candidate, direct source, selected name, and idempotent event',async t=>{
 const f=await setup(t),r=await f.scan(),a=f.args(r.items[0]);
 for(const change of [{sources:f.source('未要求添加目标')},{sources:f.source(a.authorization_quote,'local')},{label:'别的群'},{candidate_id:'guessed'},{route:{chatId:'forged'}}])await assert.rejects(f.g.call('notification_target_add',{...a,...change}),/NOTIFICATION_/);
 await f.g.call('notification_target_add',a);await assert.rejects(f.g.call('notification_target_add',{...a,authorization_quote:'测试通知群',sources:f.source('测试通知群')}),/EVENT_CONFLICT/);
 assert.equal(f.g.db.prepare('SELECT count(*) n FROM notification_registered_targets').get().n,1);
});
test('own target registry survives restart without rereading or mutating upstream IM state',async t=>{
 const f=await setup(t),r=await f.scan(),v=await f.g.call('notification_target_add',f.args(r.items[0])),calls=f.calls.length;
 await f.g.notifications.close();f.g.notifications=new TaskNotifications(f.g,[]);assert(f.g.notifications.config.has(v.key));assert(f.g.notifications.endpoint.targets.has(v.key));assert.equal(f.calls.length,calls);
});
test('local discovery stays on local Host and target publication persists through offline/lost ack',async t=>{
 const local=await setup(t,'local'),cloud=await setup(t),r=await local.scan();assert.equal(r.host,'local');const a=local.args(r.items[0]),v=await local.g.call('notification_target_add',a);assert.equal(v.publication,'pending');assert(local.g.notifications.endpoint.targets.has(v.key));assert.equal(cloud.g.notifications.inventory().items.length,0);
 let offline=true,lostAck=true;const call=local.g.call.bind(local.g);local.g.call=async(method,args,...rest)=>{if(method!=='notification_target_publish')return call(method,args,...rest);if(offline)throw Error('COORDINATOR_UNAVAILABLE');const v=await cloud.g.call(method,args,'local');if(lostAck){lostAck=false;throw Error('COORDINATOR_UNAVAILABLE');}return v;};
 await local.g.notifications.registry.sync();assert.equal(local.g.notifications.registry.publication(v.key).state,'pending');offline=false;local.advance(300001);await local.g.notifications.registry.sync();assert(cloud.g.notifications.config.has(v.key));assert(!cloud.g.notifications.endpoint.targets.has(v.key));
 local.advance(300001);await local.g.notifications.registry.sync();assert.equal(local.g.notifications.registry.publication(v.key).state,'published');assert.equal(cloud.g.db.prepare('SELECT count(*) n FROM notification_registered_targets').get().n,1);assert.equal(cloud.g.db.prepare('SELECT count(*) n FROM notification_bindings').get().n,0);
});
test('cloud cannot discover an offline local Host or accept forged cloud routes from local publication',async t=>{
 const f=await setup(t);await assert.rejects(f.g.call('notification_discover',{host:'local'}),/WRONG_HOST/);
 const r=await f.scan(),a=f.args(r.items[0]),definition=await f.g.notifications.discovery.resolve(a.candidate_id,a.label);await assert.rejects(f.g.call('notification_target_publish',{definition,label:a.label,authorization_quote:a.authorization_quote,sources:f.source(a.authorization_quote,'local'),event_id:'forged'},'local'),/ROLE_DENIED/);
});
test('duplicate human target labels cannot silently select or replace another destination',async t=>{
 const f=await setup(t);let r=await f.scan();await f.g.call('notification_target_add',f.args(r.items[0]));f.target.route.chatId='another-route';r=await f.scan();await assert.rejects(f.g.call('notification_target_add',f.args(r.items[0])),/AMBIGUOUS/);assert.equal(f.g.notifications.config.size,1);assert.equal(f.g.db.prepare('SELECT count(*) n FROM notification_registered_targets').get().n,1);
});
test('hanging public reads retain concurrency slots after observation timeout',async()=>{
 const d=new NotificationDiscovery({c:{role:'local'},now:Date.now},()=>null);const pending=[];for(let i=0;i<8;i++)pending.push(d.query(()=>new Promise(()=>{})).catch(e=>e.message));await assert.rejects(d.query(()=>{throw Error('must not call');}),/BUSY/);await Promise.all(pending);assert.equal(d.inflight,8);await assert.rejects(d.query(()=>null),/BUSY/);
});


test('official same-Host array contract supports discovery and pinned revalidation',async t=>{const f=await setup(t);f.service.listTargets=async()=>[structuredClone(f.target)];const r=await f.scan();assert.equal(r.state,'available');assert.equal(r.items.length,1);assert(r.items[0].eligible);const d=f.g.notifications.discovery;assert.equal((await d.resolve(r.items[0].candidate_id,'测试通知群')).botId,f.bot.botId);f.target.route.chatId='changed';await assert.rejects(d.resolve(r.items[0].candidate_id,'测试通知群'),/CHANGED/);});
test('array normalization does not weaken account or old envelope validation',async t=>{const f=await setup(t);f.service.listTargets=async()=>({botId:'wrong',channel:'feishu',targets:[f.target]});assert.equal((await f.scan()).items.length,0);f.service.listTargets=async()=>[f.target];f.account.botId='wrong';assert.equal((await f.scan()).items.length,0);});
