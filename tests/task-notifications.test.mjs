import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {Gateway} from '../bundle/index.js';
import {makeEnvelope} from '../bundle/task-envelope.js';
import {NotificationEndpoint} from '../bundle/notification-endpoint.js';
import {targets} from '../bundle/notification-contract.js';
import {registerNativeTools} from '../bundle/native-tools.js';
const hash=s=>createHash('sha256').update(s).digest('hex');
const pins={botId:'bot_opaque',targetId:'alias_opaque',expectedFingerprint:'a'.repeat(64),expectedTargetDigest:'b'.repeat(64),conversationId:'oc_opaque'};
const config=[{...pins,host:'cloud',alias:'cloud-notices',label:'云端通知群'},{...pins,host:'local',alias:'local-notices',label:'本地通知群'}];
const p={provider:'task-selected',model:'not-a-real-model',reasoningEffort:'high'};
async function fixture(t,options={}){
 const root=mkdtempSync(tmpdir()+'/notify-test-');writeFileSync(root+'/tokens.json',JSON.stringify({localToken:'l'.repeat(32),cloudToken:'c'.repeat(32)}),{mode:0o600});let now=Date.now(),sequence=0,service,calls=[];
 const ctx={on(){},effect(){},agents:{list:()=>[],get(){}},agentPresets:{composedPreset:a=>a.preset},get:n=>n==='dshIm'?service:null};
 const cloud=new Gateway(ctx,{role:'cloud',entryMode:'native',namespace:'notify-test',stateDir:root+'/cloud',tokenFile:root+'/tokens.json',port:0,notificationTargets:options.config??config,notificationFeishu:options.direct??[],scheduler:{lockPort:0,intervalMs:60000},recovery:{sendTimeoutMs:30,maxAttempts:3,baseMs:10,maxMs:100}},{now:()=>now,notificationFeishu:options.directIo,scheduler:{allowEphemeralLock:true,now:()=>now}});
 const success=async(...a)=>{calls.push(a);return {sent:true,receipt:{version:1,messageId:'om_'+calls.length,conversationId:pins.conversationId}};};service={contractVersion:1,receiptVersion:1,sendChecked:success};
 const source=(text,role='cloud')=>[{role,session_id:'fixture-entry',message_id:'message-'+(++sequence),text,sha256:hash(text)}];
 const create=async(title='通知测试任务')=>{const message={id:'create-'+(++sequence),role:'user',source:{kind:'user'},content:[{type:'text',text:'运营方零模型夹具，不是业务执行'}]},agent={id:'entry',session:{deriveMessages:()=>[message]}};const e=makeEnvelope(agent,'cloud',{title,notification_contract:1,goal:'零模型夹具',target:'cloud',intent:'plan',model_policy:p});return cloud.call('accept',{...e,source:'native-cloud'});};
 const bind=(task,key='cloud:cloud-notices',policy={events:['result','attention']})=>{const label=(options.config??config).find(x=>x.host+':'+x.alias===key).label;const quote='请把此任务的通知发到'+label;return cloud.call('notification_bind',{task_id:task.id,expected_revision:cloud.catalog.head(task.id).spec_revision,expected_binding_revision:cloud.notifications.status(task.id).binding?.revision??0,action:'set',target_key:key,policy,authorization_quote:quote,sources:source(quote),event_id:'bind-'+(++sequence)});};
 const enqueue=task=>cloud.scheduler.jobs.enqueue({task_id:task.id,trigger_id:'test-job-'+(++sequence),goal:cloud.catalog.head(task.id).goal,policy:p,max_runs:3});
 const finish=(job,result={outcome:'done',summary:'运营方构造的完成结果，无模型调用'})=>{const j=cloud.scheduler.jobs.claim(new Set(['plan']),new Set(['plan']));assert.equal(j.id,job.id);cloud.scheduler.jobs.finish(j,result);return j;};
 const disable=task=>cloud.call('notification_bind',{task_id:task.id,expected_revision:cloud.catalog.head(task.id).spec_revision,expected_binding_revision:cloud.notifications.status(task.id).binding.revision,action:'disable',authorization_quote:'停止通知',sources:source('停止通知'),event_id:'disable-'+(++sequence)});
 t.after(async()=>{await cloud.close();rmSync(root,{recursive:true,force:true});});
 return {root,cloud,ctx,p,create,source,bind,enqueue,finish,disable,calls,success,setService:v=>service=v,setSend:f=>service.sendChecked=f,advance:ms=>now+=ms,status:task=>cloud.notifications.status(task.id),tick:()=>cloud.notifications.tick(),get now(){return now;}};
}
test('targets are explicit configured metadata, no IDs/routes/credentials exposed and no delivery grant',async t=>{
 const f=await fixture(t),d=await f.cloud.call('notification_targets',{});assert.equal(d.items.length,2);assert.equal(d.no_default_recipient,true);assert.equal(d.items[0].consent,false);assert(!JSON.stringify(d).includes(pins.botId));assert(!JSON.stringify(d).includes(pins.conversationId));assert.equal(f.calls.length,0);
 assert.throws(()=>targets([...config,config[0]]),/AMBIGUOUS/);assert.throws(()=>targets([{...config[0],credential:'forbidden'}]),/CONFIG_INVALID/);
});
test('new managed tasks never leak job notices to the old fixed destination without task consent',async t=>{
 const f=await fixture(t),task=await f.create(),j=f.enqueue(task),run=f.finish(j);
 // No rollback reader can drain a new-contract completion into the legacy fixed target.
 assert.equal(f.cloud.scheduler.jobs.db.prepare('SELECT count(*) n FROM job_notifications').get().n,0);await f.tick();
 assert.equal(f.calls.length,0);assert.equal(f.status(task).deliveries.length,0);assert(f.status(task).events.every(e=>e.disposition==='no_authorized_target'));
 assert.equal(f.cloud.notifications.ownsLegacyNotice('job-result:'+run.run_id),true);assert.equal(f.cloud.notifications.ownsLegacyNotice('arbitrary'),false);
});
test('binding requires source provenance, named target and matching task/binding revisions; replay is idempotent',async t=>{
 const f=await fixture(t),task=await f.create(),quote='结果请发到云端通知群',a={task_id:task.id,expected_revision:1,expected_binding_revision:0,action:'set',target_key:'cloud:cloud-notices',policy:{events:['result']},authorization_quote:quote,sources:f.source(quote),event_id:'one-binding'};
 for(const change of [{sources:f.source('没有这句话')},{sources:f.source(quote,'local')},{target_key:'made-up'},{expected_revision:2},{expected_binding_revision:5},{policy:{events:['progress']}}])await assert.rejects(f.cloud.call('notification_bind',{...a,...change}),/NOTIFICATION_/);
 const b=await f.cloud.call('notification_bind',a);assert.deepEqual(await f.cloud.call('notification_bind',a),b);await assert.rejects(f.cloud.call('notification_bind',{...a,policy:{events:['attention']}}),/EVENT_CONFLICT/);assert.equal(f.calls.length,0);
});
test('binding after completion does not replay old events or acquire old unfinished legacy notices',async t=>{
 const f=await fixture(t),task=await f.create(),j=f.enqueue(task);f.finish(j);await f.bind(task);await f.tick();assert.equal(f.calls.length,0);assert.equal(f.status(task).deliveries.length,0);assert(f.status(task).events.every(e=>e.disposition==='before_authorization'));
});
test('completion uses requested model/high and immutable summary, platform receipt is not read or approval',async t=>{
 const f=await fixture(t),task=await f.create();await f.bind(task);f.finish(f.enqueue(task));await f.tick();await f.tick();
 assert.equal(f.calls.length,1);const [bot,target,body,opts]=f.calls[0];assert.equal(bot,pins.botId);assert.equal(target,pins.targetId);assert.equal(opts.expectedFingerprint,pins.expectedFingerprint);assert.equal(opts.expectedTargetDigest,pins.expectedTargetDigest);assert.equal(opts.receipt,true);assert.match(body,/本批次完成/);assert.match(body,/not-a-real-model \/ high/);assert.match(body,/不表示整个长期目标已完成/);assert(!body.includes('几分钟'));
 const row=f.status(task).deliveries[0];assert.equal(row.state,'accepted');assert.equal(row.message_id,'om_1');assert.equal(f.cloud.store.snapshot().intents.length,0);assert.equal(f.cloud.approvals.list(task.id).length,0);
});
test('private-like configured acceptance mode records weaker SDK proof without fabricating message IDs',async t=>{
 const f=await fixture(t,{config:config.map(x=>({...x,receipt_mode:'acceptance'}))}),task=await f.create();await f.bind(task);f.setSend(async(...a)=>{f.calls.push(a);return {sent:true};});f.finish(f.enqueue(task));await f.tick();
 assert.equal(f.calls[0][3].receipt,false);assert.equal(f.status(task).deliveries[0].state,'accepted');assert.equal(f.status(task).deliveries[0].message_id,null);
 assert.equal(JSON.parse(f.cloud.db.prepare('SELECT result FROM task_notifications').get().result).proof,'sdk_accepted');
});
test('no service or unimplemented channel retains a bounded diagnosed queue; never calls unchecked send',async t=>{
 const f=await fixture(t),task=await f.create();await f.bind(task);f.finish(f.enqueue(task));f.setService({send(){throw Error('must not fallback');}});await f.tick();assert.equal(f.calls.length,0);assert.equal(f.status(task).deliveries[0].error,'NOTIFICATION_CAPABILITY_UNAVAILABLE');
 f.setService({contractVersion:1,receiptVersion:1,sendChecked:async()=>{throw Object.assign(Error('secret provider details'),{code:'capability-unavailable'});}});
 for(let i=0;i<3;i++){f.advance(11000);await f.tick();}
 assert.equal(f.status(task).deliveries[0].state,'needs_review');assert.equal(f.cloud.db.prepare('SELECT attempts FROM notification_inbox').get().attempts,3);assert(!JSON.stringify(f.status(task)).includes('secret'));
});
test('progress snapshots coalesce, obey interval, and queued old progress is cancelled by terminal result',async t=>{
 const f=await fixture(t),task=await f.create();await f.bind(task,'cloud:cloud-notices',{events:['progress','result'],progress_interval_seconds:60});const j=f.enqueue(task);
 f.cloud.notifications.collect();let run=f.cloud.scheduler.jobs.claim(new Set(['plan']),new Set(['plan']));f.cloud.notifications.collect();await f.tick();assert.equal(f.calls.length,1);assert.match(f.calls[0][2],/本批次开始/);
 f.cloud.scheduler.jobs.finish(run,{outcome:'checkpoint',summary:'first checkpoint',delay_seconds:1});await f.tick();assert.equal(f.calls.length,1);
 f.advance(2000);run=f.cloud.scheduler.jobs.claim(new Set(['plan']),new Set(['plan']));f.cloud.scheduler.jobs.finish(run,{outcome:'done',summary:'final snapshot'});await f.tick();assert.equal(f.calls.length,2);assert.match(f.calls[1][2],/final snapshot/);f.advance(60000);await f.tick();assert.equal(f.calls.length,2);assert(f.status(task).deliveries.some(d=>d.error==='NOTIFICATION_SUPERSEDED_SNAPSHOT'));
});
test('revoke before authorization prevents send, but revoke during SDK cannot recall real acceptance',async t=>{
 const f=await fixture(t),task=await f.create();await f.bind(task);f.finish(f.enqueue(task));f.cloud.notifications.collect();const e=f.cloud.notifications.lease('cloud').items[0];await f.disable(task);
 const r=await f.cloud.notifications.endpoint.execute(e,a=>f.cloud.call('notification_validate',a));assert.equal(r.state,'cancelled');assert.equal(f.calls.length,0);
 await f.bind(task);f.finish(f.enqueue(task));let resolve,started;const startedP=new Promise(r=>started=r);f.setSend(async(...a)=>{f.calls.push(a);started();return new Promise(r=>resolve=r);});const running=f.tick();await startedP;await f.disable(task);resolve({sent:true,receipt:{version:1,messageId:'om_late',conversationId:pins.conversationId}});await running;
 assert.equal(f.status(task).deliveries[0].state,'accepted');assert.equal(f.status(task).binding.state,'disabled');
});
test('route edits, task revision changes and forged role/lease fail closed',async t=>{
 const f=await fixture(t),task=await f.create();await f.bind(task);f.finish(f.enqueue(task));f.cloud.notifications.collect();const e=f.cloud.notifications.lease('local');assert.equal(e.items.length,0);const m=f.cloud.notifications.lease('cloud').items[0];
 assert.throws(()=>f.cloud.notifications.authorize('local',{id:m.id,lease:m.lease}),/LEASE_MISMATCH/);assert.throws(()=>f.cloud.notifications.authorize('cloud',{id:m.id,lease:'forged'}),/LEASE_MISMATCH/);
 f.cloud.notifications.endpoint.targets.set(m.target_key,{...f.cloud.notifications.endpoint.targets.get(m.target_key),route_hash:'c'.repeat(64)});await f.tick();assert.equal(f.calls.length,0);assert.equal(f.status(task).deliveries[0].error,'NOTIFICATION_ROUTE_CHANGED');
 await f.bind(task);const j=f.enqueue(task);f.finish(j);f.cloud.notifications.collect();f.cloud.catalog.amend('cloud',{task_id:task.id,expected_revision:1,summary:'新修订',intent:'plan',model_policy:p,sources:f.source('修改任务'),event_id:'amend'},()=>{});await f.tick();assert.equal(f.status(task).binding.effective,false);assert.equal(f.calls.length,0);
});
test('timeout, malformed receipt and unknown provider errors never retry or reinterpret a late success',async t=>{
 for(const kind of ['timeout','bad','throw']){const f=await fixture(t),task=await f.create();await f.bind(task);f.finish(f.enqueue(task));let resolve;f.setSend(async(...a)=>{f.calls.push(a);if(kind==='timeout')return new Promise(r=>resolve=r);if(kind==='bad')return {sent:true};throw Error('secret');});await f.tick();assert.equal(f.status(task).deliveries[0].state,'needs_review');
  resolve?.({sent:true,receipt:{version:1,messageId:'om_late',conversationId:pins.conversationId}});await new Promise(r=>setImmediate(r));f.advance(600000);await f.tick();assert.equal(f.calls.length,1);assert.equal(f.status(task).deliveries[0].message_id,null);
 }
});
test('durable local SDK intent is quarantined after restart; saved success replays without a second send',async t=>{
 const f=await fixture(t),task=await f.create();await f.bind(task);f.finish(f.enqueue(task));f.cloud.notifications.collect();const m=f.cloud.notifications.lease('cloud').items[0];
 const r=await f.cloud.notifications.endpoint.execute(m,a=>f.cloud.call('notification_validate',a));assert.equal(r.state,'accepted');const endpoint=new NotificationEndpoint(f.cloud,config);assert.deepEqual(await endpoint.execute(m,()=>{throw Error('no new permit');}),r);assert.equal(f.calls.length,1);
 f.cloud.db.prepare("UPDATE notification_inbox SET state='sending',result=NULL WHERE id=?").run(m.id);const restarted=new NotificationEndpoint(f.cloud,config);const unknown=await restarted.execute(m,()=>{throw Error('no retry');});assert.equal(unknown.error,'NOTIFICATION_SEND_RESULT_UNKNOWN');assert.equal(f.calls.length,1);
});
test('real authenticated local/cloud RPC resumes after offline and lost acknowledgement without duplicate SDK sends',async t=>{
 const f=await fixture(t);await f.cloud.start();await f.cloud.pending;clearTimeout(f.cloud.timer);clearInterval(f.cloud.scheduler.timer);
 const local=new Gateway(f.ctx,{role:'local',entryMode:'native',namespace:'notify-test',stateDir:f.root+'/local',tokenFile:f.root+'/tokens.json',port:0,notificationTargets:config,coordinatorUrl:'http://127.0.0.1:'+f.cloud.server.address().port},{now:()=>f.now});t.after(()=>local.close());
 const task=await f.create();await f.bind(task,'local:local-notices');f.finish(f.enqueue(task));await f.tick();assert.equal(f.calls.length,0);assert.equal(f.status(task).deliveries[0].state,'queued');
 const remote=local.remoteTransport.bind(local);let offline=true,lostAck=true;
 local.remoteTransport=async(method,...a)=>{if(offline)throw Error('COORDINATOR_UNAVAILABLE');if(method==='notification_ack'&&lostAck){lostAck=false;throw Error('COORDINATOR_UNAVAILABLE');}return remote(method,...a);};
 await local.notifications.tick();assert.equal(f.calls.length,0);offline=false;await local.notifications.tick();assert.equal(f.calls.length,1);assert.equal(f.status(task).deliveries[0].state,'dispatching');
 await local.notifications.tick();assert.equal(f.calls.length,1);assert.equal(f.status(task).deliveries[0].state,'accepted');assert.equal(local.notifications.lastError,null);
});
test('native notification tools capture direct user provenance and do not expose dispatcher/recovery APIs',async t=>{
 const f=await fixture(t),task=await f.create(),names=new Map(),quote='完成后发到云端通知群',agent={id:'native',ctx:{preset:'standard'},session:{deriveMessages:()=>[{id:'m',role:'user',source:{kind:'user'},content:[{type:'text',text:quote}]}]}};f.ctx.agents.get=id=>id===agent.id?agent:null;
 registerNativeTools({taskGateway:f.cloud,tools:{register:d=>names.set(d.name,d)}});assert(names.has('task_notification_bind'));assert(![...names.keys()].some(x=>/notification_(pull|ack|validate|retry)/.test(x)));
 const result=await names.get('task_notification_bind').execute({task_id:task.id,expected_revision:1,expected_binding_revision:0,action:'set',target_key:'cloud:cloud-notices',authorization_quote:quote,policy:{events:['result']}},{agent,callId:'one'});assert.equal(result.receipt_classification.kind,'notification');assert.equal(result.state,'enabled');
});

test('progress cadence starts at actual dispatch, not a stale offline snapshot timestamp',async t=>{
 const f=await fixture(t),task=await f.create();await f.bind(task,'cloud:cloud-notices',{events:['progress'],progress_interval_seconds:60});const job=f.enqueue(task);f.cloud.notifications.collect();
 f.advance(600000);await f.tick();assert.equal(f.calls.length,1);
 const run=f.cloud.scheduler.jobs.claim(new Set(['plan']),new Set(['plan']));assert.equal(run.id,job.id);await f.tick();assert.equal(f.calls.length,1);
 f.advance(59000);await f.tick();assert.equal(f.calls.length,1);f.advance(1000);await f.tick();assert.equal(f.calls.length,2);
});
test('failure and completion never persist old fixed-target notices for new-contract jobs',async t=>{
 const f=await fixture(t),task=await f.create();await f.bind(task);const job=f.enqueue(task),run=f.cloud.scheduler.jobs.claim(new Set(['plan']),new Set(['plan']));assert.equal(run.id,job.id);
 f.cloud.scheduler.jobs.fail(run,'WORKER_FAILED');assert.equal(f.cloud.scheduler.jobs.db.prepare('SELECT count(*) n FROM job_notifications').get().n,0);await f.tick();assert.equal(f.calls.length,1);assert.match(f.calls[0][2],/需要|待核对/);
});
test('replayed acceptance repairs a missing tracking row without replaying historical events',async t=>{
 const f=await fixture(t),task=await f.create();const original=f.cloud.store.db.prepare('SELECT * FROM ingress WHERE task_id=?').get(task.id);
 f.cloud.db.prepare('DELETE FROM notification_tasks WHERE task_id=?').run(task.id);
 await f.cloud.call('accept',{ingress_id:original.id,task_key:f.cloud.store.task(task.id).task_key,goal:original.goal,source:'native-cloud'});
 assert.equal(f.status(task).managed,true);assert.equal(f.calls.length,0);
});


test('queue state does not infer offline status and leased delivery has a distinct wait reason',async t=>{
 const f=await fixture(t),task=await f.create();await f.bind(task);f.finish(f.enqueue(task));f.cloud.notifications.collect();
 assert.equal(f.status(task).deliveries[0].waiting_reason,'NOTIFICATION_AWAITING_CLOUD_ENDPOINT');
 const e=f.cloud.notifications.lease('cloud').items[0];assert.equal(f.status(task).deliveries[0].waiting_reason,'NOTIFICATION_ENDPOINT_PROCESSING');
 f.cloud.notifications.authorize('cloud',{id:e.id,lease:e.lease});assert.equal(f.status(task).deliveries[0].waiting_reason,'NOTIFICATION_WAITING_FOR_RECEIPT');
});

test('unknown review is append-only, optimistic, direct-user scoped and never upgrades or resends evidence',async t=>{
 const f=await fixture(t),task=await f.create();await f.bind(task);f.setSend(async(...a)=>{f.calls.push(a);throw Error('unknown');});f.finish(f.enqueue(task));await f.tick();const d=f.status(task).deliveries[0];assert.equal(d.state,'needs_review');
 const original=f.cloud.db.prepare('SELECT * FROM task_notifications WHERE id=?').get(d.id),inbox=f.cloud.db.prepare('SELECT * FROM notification_inbox WHERE id=?').get(d.id);
 const quote='我在通知会话里没看到这条消息，请结案，不重发',a={event_id:'review-1',task_id:task.id,notification_id:d.id,expected_review_revision:0,observation:'not_seen',action:'close_without_resend',note:quote,sources:f.source(quote)};
 for(const change of [{sources:[]},{sources:f.source('other')},{sources:f.source(quote,'local')},{notification_id:'other'},{expected_review_revision:1},{action:'retry'},{proof:'provider_message'}])await assert.rejects(f.cloud.call('notification_reconcile',{...a,...change}),/NOTIFICATION_/);
 const review=await f.cloud.call('notification_reconcile',a);assert.equal(review.state,'closed');assert.equal(review.resend,false);assert.equal(review.proof,'direct_user_observation');assert.deepEqual(await f.cloud.call('notification_reconcile',a),review);
 await assert.rejects(f.cloud.call('notification_reconcile',{...a,action:'keep_open'}),/EVENT_CONFLICT/);
 assert.deepEqual(f.cloud.db.prepare('SELECT * FROM task_notifications WHERE id=?').get(d.id),original);assert.deepEqual(f.cloud.db.prepare('SELECT * FROM notification_inbox WHERE id=?').get(d.id),inbox);
 await f.tick();assert.equal(f.calls.length,1);assert.equal(f.status(task).deliveries[0].state,'needs_review');assert.equal(f.status(task).deliveries[0].review.state,'closed');assert.equal(f.status(task).deliveries[0].proof,null);
 const later='刚才找错会话，实际看到过，请保留核对记录';const r=await f.cloud.call('notification_reconcile',{...a,event_id:'review-2',expected_review_revision:1,observation:'seen',action:'keep_open',note:later,sources:f.source(later)});assert.equal(r.revision,2);assert.equal(f.cloud.db.prepare('SELECT count(*) n FROM notification_reviews').get().n,2);assert.equal(f.status(task).deliveries[0].review.state,'open');assert.equal(f.cloud.store.snapshot().intents.length,0);assert.equal(f.cloud.approvals.list(task.id).length,0);
 const {NotificationReview}=await import('../bundle/notification-review.js');f.cloud.notifications.review=new NotificationReview(f.cloud);assert.equal(f.status(task).deliveries[0].review.revision,2);
});
test('review cannot attach to another task, queued, in-flight, successful or cancelled deliveries',async t=>{
 const f=await fixture(t),task=await f.create(),other=await f.create();await f.bind(task);f.finish(f.enqueue(task));f.cloud.notifications.collect();const d=f.status(task).deliveries[0],q='无需重发，结案',a={event_id:'review',task_id:task.id,notification_id:d.id,expected_review_revision:0,observation:'not_checked',action:'close_without_resend',note:q,sources:f.source(q)};
 await assert.rejects(f.cloud.call('notification_reconcile',a),/NOT_ELIGIBLE/);
 const e=f.cloud.notifications.lease('cloud').items[0];f.cloud.notifications.authorize('cloud',{id:e.id,lease:e.lease});await assert.rejects(f.cloud.call('notification_reconcile',a),/NOT_ELIGIBLE/);
 await f.tick();await assert.rejects(f.cloud.call('notification_reconcile',a),/NOT_ELIGIBLE/);
 await assert.rejects(f.cloud.call('notification_reconcile',{...a,task_id:other.id}),/NOT_ELIGIBLE/);
});
test('closed unknowns release queue accounting without deleting evidence or resending; reopening counts again',async t=>{
 const f=await fixture(t),task=await f.create();await f.bind(task);f.setSend(async(...a)=>{f.calls.push(a);throw Error('unknown');});f.finish(f.enqueue(task));await f.tick();const d=f.status(task).deliveries[0];
 // Fill the ledger to its bounded unresolved limit, including one real synthetic unknown.
 const row=f.cloud.db.prepare('SELECT * FROM task_notifications WHERE id=?').get(d.id),keys=Object.keys(row),sql='INSERT INTO task_notifications('+keys.join(',')+') VALUES ('+keys.map(()=>'?').join(',')+')';
 for(let i=0;i<199;i++)f.cloud.db.prepare(sql).run(...keys.map(k=>k==='id'?'fill-'+i:row[k]));
 f.finish(f.enqueue(task));f.cloud.notifications.collect();assert.equal(f.status(task).events[0].disposition,'queue_limit');
 const q='本条无需重发，结案';await f.cloud.call('notification_reconcile',{event_id:'closed',task_id:task.id,notification_id:d.id,expected_review_revision:0,observation:'not_checked',action:'close_without_resend',note:q,sources:f.source(q)});
 f.finish(f.enqueue(task));f.cloud.notifications.collect();assert.equal(f.status(task).events[0].disposition,'queued');assert.equal(f.cloud.db.prepare('SELECT count(*) n FROM task_notifications').get().n,201);assert.equal(f.calls.length,1);
});

test('explicit direct endpoint never falls back to public IM or sends with absent credential binding',async t=>{
 const {feishuNotificationTarget}=await import('../bundle/notification-feishu.js');
 const c={provider:'feishu',appId:'cli_test1234',botOpenId:'ou_bot1234',approverOpenId:'ou_user1234',chatId:'oc_chat1234',appSecretEnv:'TEST_FEISHU_SECRET'},target=feishuNotificationTarget(c,{host:'cloud',alias:'cloud-notices',label:'云端通知群'});
 const f=await fixture(t,{config:[target]}),task=await f.create();await f.bind(task);f.finish(f.enqueue(task));await f.tick();assert.equal(f.calls.length,0);assert.equal(f.status(task).deliveries[0].state,'leased');assert.equal(f.status(task).deliveries[0].waiting_reason,'NOTIFICATION_CAPABILITY_UNAVAILABLE');
});
test('explicit direct endpoint pins route, calls official send once, and persists provider receipt',async t=>{
 const {feishuNotificationTarget}=await import('../bundle/notification-feishu.js');
 const c={provider:'feishu',appId:'cli_test1234',botOpenId:'ou_bot1234',approverOpenId:'ou_user1234',chatId:'oc_chat1234',appSecretEnv:'TEST_FEISHU_SECRET',alias:'cloud-notices'},target=feishuNotificationTarget(c,{host:'cloud',alias:c.alias,label:'云端通知群'});let sends=0;
 const fetcher=async(url,args)=>{const data=url.endsWith('/internal')?{tenant_access_token:'test',expire:7200}:url.endsWith('/info')?{bot:{open_id:c.botOpenId}}:url.includes('/chats/')?{data:{chat_mode:'p2p'}}:(sends++,{data:{message_id:'om_test1234',chat_id:c.chatId}});return new Response(JSON.stringify({code:0,...data}));};
 const f=await fixture(t,{config:[target],direct:[c],directIo:{fetcher,env:{TEST_FEISHU_SECRET:'fixture'}}}),task=await f.create();await f.bind(task);f.finish(f.enqueue(task));await f.tick();await f.tick();assert.equal(sends,1);assert.equal(f.calls.length,0);assert.equal(f.status(task).deliveries[0].message_id,'om_test1234');assert.equal(f.status(task).deliveries[0].proof,'provider_message');
});
