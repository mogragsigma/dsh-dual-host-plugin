import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {Gateway} from '../bundle/index.js';
import {makeEnvelope} from '../bundle/task-envelope.js';
import {createOnboardingNotificationDefaults} from '../bundle/onboarding-notification-defaults.js';
import {createOnboardingService} from '../bundle/onboarding-host.js';
import {createOnboardingActivity} from '../bundle/onboarding-activity.js';
import {defaultPolicy} from '../bundle/notification-defaults.js';
const p={provider:'test-only',model:'not-a-real-model',reasoningEffort:'high'};
const pins={botId:'bot-test',targetId:'target-test',expectedFingerprint:'a'.repeat(64),expectedTargetDigest:'b'.repeat(64),conversationId:'oc-test',receipt_mode:'message'};
const definition=host=>({...pins,host,alias:'discovered-unit',label:(host==='local'?'本地':'云端')+'测试对话'});
const policy=(host='local')=>({contract:1,owner:randomUUID(),revision:1,operation:randomUUID(),enabled:true,definition:definition(host),approvedAt:Date.now()});
async function fixture(t){
 const root=mkdtempSync(tmpdir()+'/notify-default-');writeFileSync(root+'/tokens.json',JSON.stringify({localToken:'l'.repeat(32),cloudToken:'c'.repeat(32)}),{mode:0o600});let now=Date.now(),seq=0;const sends=[];
 const ctx={on(){},effect(){},agents:{list:()=>[],get(){}},agentPresets:{composedPreset:a=>a.preset},get:n=>n==='dshIm'?{contractVersion:1,receiptVersion:1,sendChecked:async(...a)=>{sends.push(a);return {sent:true,receipt:{version:1,messageId:'om_'+sends.length,conversationId:pins.conversationId}};}}:null};
 const c=new Gateway(ctx,{role:'cloud',entryMode:'native',namespace:'defaults-unit',stateDir:root+'/cloud',tokenFile:root+'/tokens.json',port:0,scheduler:{lockPort:0,intervalMs:60000}},{now:()=>now,scheduler:{allowEphemeralLock:true,now:()=>now}});
 const create=async()=>{const m={id:'create-'+(++seq),role:'user',source:{kind:'user'},content:[{type:'text',text:'零模型单元夹具'}]},a={id:'test',session:{deriveMessages:()=>[m]}};const e=makeEnvelope(a,'cloud',{title:'测试定时任务',notification_contract:1,goal:'fixture',target:'cloud',intent:'plan',model_policy:p});return c.call('accept',{...e,source:'native-cloud'});};
 const source=text=>[{role:'cloud',session_id:'test',message_id:'message-'+(++seq),text,sha256:createHash('sha256').update(text).digest('hex')}];
 const schedule=(task,delay=1)=>c.call('schedule',{task_id:task.id,policy:p,delay_seconds:delay,max_runs:1});
 const finish=()=>{now+=2000;const j=c.scheduler.jobs.claim(new Set(['plan']),new Set(['plan']));assert(j);c.scheduler.jobs.finish(j,{outcome:'done',summary:'零模型测试完成'});c.notifications.collect();return j;};
 const bind=(task,action='disable',key)=>{const quote=action==='disable'?'停止此任务通知':'发到'+definition('cloud').label;return c.call('notification_bind',{task_id:task.id,expected_revision:1,expected_binding_revision:c.notifications.status(task.id).binding?.revision??0,action,authorization_quote:quote,sources:source(quote),event_id:'binding-'+(++seq),...(key?{target_key:key,policy:{events:['result']}}:{})});};
 const publish=a=>c.call('notification_default_publish',a,'local');
 t.after(async()=>{await c.close();rmSync(root,{recursive:true,force:true});});
 return {root,ctx,c,create,schedule,finish,bind,publish,sends,status:task=>c.notifications.status(task.id),advance:ms=>now+=ms,now:()=>now};
}
test('default contract allows either endpoint, rejects malformed consent and implicit role fallback',()=>{
 for(const host of ['local','cloud'])assert.equal(defaultPolicy(policy(host)).definition.host,host);
 for(const change of [{revision:0},{operation:'not-a-uuid'},{enabled:false},{development:true},{definition:{...definition('local'),host:'unknown'}}])assert.throws(()=>defaultPolicy({...policy(),...change}),/NOTIFICATION_/);
});
test('missing default never sends; enabling it cannot backfill or adopt an older task',async t=>{
 const f=await fixture(t),old=await f.create();await f.publish(policy());await f.schedule(old);f.finish();assert.equal(f.status(old).binding,null);assert.equal(f.status(old).deliveries.length,0);
});
test('both chosen endpoints inherit only new scheduled tasks; immediate tasks do not inherit',async t=>{
 for(const host of ['local','cloud']){const f=await fixture(t);await f.publish(policy(host));const immediate=await f.create();await f.schedule(immediate,0);assert.equal(f.status(immediate).binding,null);f.finish();const timed=await f.create();await f.schedule(timed);f.finish();assert.equal(f.status(timed).binding.target.host,host);assert.equal(f.status(timed).deliveries.length,1);await f.c.notifications.tick();assert.equal(f.sends.length,host==='cloud'?1:0);}
});
test('explicit task opt-out before scheduling prevents inheritance',async t=>{
 const f=await fixture(t);await f.publish(policy());const task=await f.create();await f.bind(task);await f.schedule(task);f.finish();assert.equal(f.status(task).binding.state,'disabled');assert.equal(f.status(task).deliveries.length,0);
});
test('changing the default cancels inherited queues but never redirects old tasks or explicit overrides',async t=>{
 const f=await fixture(t),first=policy();await f.publish(first);const old=await f.create();await f.schedule(old);f.finish();
 const next={...first,revision:2,operation:randomUUID(),definition:definition('cloud')};await f.publish(next);assert.equal(f.status(old).binding.effective,false);assert.equal(f.status(old).deliveries[0].state,'cancelled');assert.equal(f.status(old).binding.target.host,'local');
 const task=await f.create();await f.bind(task,'set','cloud:discovered-unit');await f.schedule(task);f.finish();await f.publish({...next,revision:3,operation:randomUUID(),enabled:false,definition:null});assert.equal(f.status(task).binding.effective,true);await f.c.notifications.tick();assert.equal(f.sends.length,1);
});
test('publication is idempotent, monotonic and authenticated; restart preserves consent and inheritance',async t=>{
 const f=await fixture(t),a=policy();const first=await f.publish(a);assert.deepEqual(await f.publish(a),first);
 await assert.rejects(f.c.call('notification_default_publish',a,'cloud'),/ROLE_DENIED/);
 await assert.rejects(f.publish({...a,definition:definition('cloud')}),/CONFLICT/);await assert.rejects(f.publish({...a,owner:randomUUID(),revision:2}),/CONFLICT/);
 const task=await f.create();await f.schedule(task);const {TaskNotifications}=await import('../bundle/task-notifications.js');f.c.notifications=new TaskNotifications(f.c);assert.equal(f.c.notifications.defaults.view().operation,a.operation);assert.equal(f.status(task).binding.effective,true);f.finish();assert.equal(f.status(task).deliveries.length,1);
});
test('real paired RPC: local offline queues; lost acknowledgement and restart do not send twice',async t=>{
 const f=await fixture(t);await f.c.start();await f.c.pending;clearTimeout(f.c.timer);clearInterval(f.c.scheduler.timer);
 const local=new Gateway(f.ctx,{role:'local',entryMode:'native',namespace:'defaults-unit',stateDir:f.root+'/local',tokenFile:f.root+'/tokens.json',port:0,coordinatorUrl:'http://127.0.0.1:'+f.c.server.address().port},{now:f.now});t.after(()=>local.close());
 const a=policy();await local.notifications.defaults.sync(a);const task=await f.create();await f.schedule(task);f.finish();assert.equal(f.status(task).deliveries[0].state,'queued');assert.equal(f.sends.length,0);
 const rpc=local.remoteTransport.bind(local);let offline=true,lost=true;local.remoteTransport=async(method,...args)=>{if(offline)throw Error('COORDINATOR_UNAVAILABLE');if(method==='notification_ack'&&lost){lost=false;throw Error('COORDINATOR_UNAVAILABLE');}return rpc(method,...args);};
 await local.notifications.tick();assert.equal(f.sends.length,0);offline=false;await local.notifications.tick();assert.equal(f.sends.length,1);assert.equal(f.status(task).deliveries[0].state,'dispatching');
 const {TaskNotifications}=await import('../bundle/task-notifications.js');local.notifications=new TaskNotifications(local);await local.notifications.tick();assert.equal(f.sends.length,1);assert.equal(f.status(task).deliveries[0].state,'accepted');
});
function setup(){
 let stored=null,now=Date.now(),gateway=null;const reads=[],account={version:1,botId:'private-bot',channel:'feishu',account:{name:'自定义机器人名称',fingerprint:'a'.repeat(64)},connected:true,capabilities:['proactive-text-checked']};
 const target={targetId:'private-target',kind:'user',name:'已保存私聊',route:{openId:'private-open'}};
 const im={contractVersion:1,listBots:async()=>[{botId:account.botId,channel:'feishu'}],describeBot:async()=>structuredClone(account),listTargets:async()=>[structuredClone(target)],sendChecked(){throw Error('must not send');}};
 const credentials={readRecord:async()=>structuredClone(stored),modifyRecord:async(k,fn)=>{reads.push(k);stored=structuredClone(fn(structuredClone(stored)));}};
 const options={state:{available:()=>true},credentials:()=>credentials,im:()=>im,gateway:()=>gateway,role:'local',remoteEnabled:()=>false,now:()=>now};
 let service=createOnboardingNotificationDefaults(options);
 return {account,target,credentials,options,get service(){return service;},get stored(){return stored;},restart(){service=createOnboardingNotificationDefaults(options);},advance:ms=>now+=ms,setGateway:g=>gateway=g,async plan(){const r=await service.scan({host:'local'});assert(!JSON.stringify(r).includes('private-open'));return service.preview({enabled:true,host:'local',candidate_id:r.items[0].candidate_id,label:r.items[0].label});},apply:p=>service.apply({id:p.id,fingerprint:p.fingerprint,confirm:true})};
}
test('guide saves only after explicit confirmation; before pairing state is pending, not active',async()=>{
 const f=setup(),p=await f.plan();assert.equal(f.stored,null);assert(!JSON.stringify(p).includes('private-bot'));await assert.rejects(f.service.apply({id:p.id,fingerprint:p.fingerprint,confirm:false}),/CONFIRMATION/);const r=await f.apply(p);assert.equal(r.publication.state,'pending_pair_or_sync');assert.equal(r.enabled,true);assert.equal(r.writeAuthorized,false);await assert.rejects(f.apply(p),/EXPIRED/);f.restart();assert.equal((await f.service.status({})).revision,1);
});
test('guide expiry, account/target drift and concurrent record changes fail closed',async()=>{
 const f=setup();let p=await f.plan();f.advance(300001);await assert.rejects(f.apply(p),/EXPIRED/);p=await f.plan();f.account.account.fingerprint='c'.repeat(64);await assert.rejects(f.apply(p),/CHANGED/);assert.equal(f.stored,null);p=await f.plan();f.target.route.openId='other';await assert.rejects(f.apply(p),/CHANGED/);assert.equal(f.stored,null);
});
test('guide resumes same saved publication after peer is restored; revocation blocks stale sends',async()=>{
 const f=setup();await f.apply(await f.plan());const sent=[];f.setGateway({notifications:{defaults:{sync:async p=>sent.push(structuredClone(p))}}});const r=await f.service.sync({});assert.equal(r.publication.state,'active');assert.equal(sent.length,1);f.restart();await f.service.sync({});assert.equal(sent.length,2);assert.deepEqual(sent[0],sent[1]);const plan=await f.service.preview({enabled:false});await f.apply(plan);assert.equal(sent[2].enabled,false);assert.equal((await f.service.status({})).enabled,false);
});
test('unknown credential save is not replayed, status reconciles durable operation',async()=>{
 const f=setup(),p=await f.plan(),save=f.credentials.modifyRecord;f.credentials.modifyRecord=async(...a)=>{await save(...a);throw Error('unknown write');};await assert.rejects(f.apply(p),/unknown write/);await assert.rejects(f.apply(p),/EXPIRED/);assert.equal((await f.service.status({})).operation,p.id);
});

test('fresh guide status has no policy and no null receipt dereference',async()=>{const f=setup();const s=await f.service.status({});assert.equal(s.revision,0);assert.equal(s.publication.state,'not_configured');assert.equal(s.enabled,false);assert.equal(s.writeAuthorized,false);});

test('future and recurring triggers inherit the selected endpoint without changing execution or budgets',async t=>{
 for(const host of ['local','cloud']){
  const f=await fixture(t);await f.publish(policy(host));const task=await f.create(),quote='一分钟后开始只读任务';
  const timing={rule:{kind:'interval',start_at:f.now()+60000,every_seconds:3600},end_at:f.now()+86400000,max_occurrences:2,max_runs:1};
  const args={task_id:task.id,expected_revision:1,policy:p,timing,event_id:'trigger-default',sources:[{role:'cloud',session_id:'test',message_id:'trigger-source',text:quote,sha256:createHash('sha256').update(quote).digest('hex')}]};
  const first=await f.c.call('trigger_create',args);assert.equal(first.execution,'readonly');assert.equal(first.development,false);assert.deepEqual(first.timing,timing);
  assert.equal(f.status(task).binding.target.host,host);assert.equal(f.status(task).binding.source,'onboarding_default');assert.equal(f.status(task).deliveries.length,0);
  assert.equal((await f.c.call('trigger_create',args)).id,first.id);assert.equal(f.status(task).binding.revision,1);
  f.advance(60001);f.c.scheduler.triggers.tick();f.finish();assert.equal(f.status(task).deliveries.length,1);
  await f.c.notifications.tick();assert.equal(f.sends.length,host==='cloud'?1:0);
 }
});

test('cloud choice uses its own saved IM target and pinned Host, never the local bot as fallback',async()=>{
 const f=setup(),cloud=createOnboardingNotificationDefaults({...f.options,role:'cloud'});
 const target={operationId:randomUUID(),installationId:randomUUID(),runtimeId:randomUUID(),manifestHash:'d'.repeat(64),root:'/isolated-test-host',role:'cloud',hostVersion:'0.2.1-rc.3'};
 const calls=[];let changed=false;
 const local=createOnboardingNotificationDefaults({...f.options,im:()=>{throw Error('must not inspect local bot');},remoteEnabled:()=>true,remote:async(method,a,pinned)=>{
  calls.push({method,pinned});
  return {target:{...target,...(changed?{runtimeId:randomUUID()}:{})},value:method==='notification_defaults_discover'?await cloud.scan(a):await cloud.candidate(a)};
 }});
 const rows=await local.scan({host:'cloud'});assert.equal(rows.host,'cloud');
 const input={enabled:true,host:'cloud',candidate_id:rows.items[0].candidate_id,label:rows.items[0].label};
 const plan=await local.preview(input);assert.equal(plan.target.host,'cloud');assert.deepEqual(calls[1].pinned,target);
 changed=true;await assert.rejects(local.apply({id:plan.id,fingerprint:plan.fingerprint,confirm:true}),/CANDIDATE_CHANGED/);assert.equal(f.stored,null);
 changed=false;const again=await local.preview(input);await local.apply({id:again.id,fingerprint:again.fingerprint,confirm:true});assert.equal(f.stored.payload.policy.definition.host,'cloud');
 assert(calls.every(c=>c.method.startsWith('notification_defaults_')));
 const unavailable=createOnboardingNotificationDefaults({...f.options,remoteEnabled:()=>false});await assert.rejects(unavailable.scan({host:'cloud'}),/PEER_UNAVAILABLE/);
});

test('a peer without notification-default capability cannot acknowledge a saved choice',async t=>{
 const f=await fixture(t);await f.c.start();await f.c.pending;clearTimeout(f.c.timer);clearInterval(f.c.scheduler.timer);
 const local=new Gateway(f.ctx,{role:'local',entryMode:'native',namespace:'defaults-unit',stateDir:f.root+'/old-peer',tokenFile:f.root+'/tokens.json',port:0,coordinatorUrl:'http://127.0.0.1:'+f.c.server.address().port},{now:f.now});t.after(()=>local.close());
 const hello=f.c.hello.bind(f.c);f.c.hello=()=>{const h=hello();delete h.capabilities.notification_defaults;return h;};
 await assert.rejects(local.notifications.defaults.sync(policy()),/CAPABILITY_UNAVAILABLE/);assert.equal(f.c.notifications.defaults.view().enabled,false);
});

test('configured existing Host discovers cloud over its paired protocol without provisioning or managed archive',async t=>{
 const f=await fixture(t),ui=setup();f.ctx.get=name=>name==='dshIm'?ui.options.im():null;
 await f.c.start();await f.c.pending;clearTimeout(f.c.timer);clearInterval(f.c.scheduler.timer);
 const local=new Gateway(f.ctx,{role:'local',entryMode:'native',namespace:'defaults-unit',stateDir:f.root+'/existing-local',tokenFile:f.root+'/tokens.json',port:0,coordinatorUrl:'http://127.0.0.1:'+f.c.server.address().port},{now:f.now});t.after(()=>local.close());
 const service=createOnboardingNotificationDefaults({...ui.options,gateway:()=>local,remoteEnabled:()=>false,remote:()=>{throw Error('must not provision or read another Host');},im:()=>{throw Error('must not select local target');}});
 const rows=await service.scan({host:'cloud'}),input={enabled:true,host:'cloud',candidate_id:rows.items[0].candidate_id,label:rows.items[0].label};
 assert.equal(rows.host,'cloud');const plan=await service.preview(input);assert.equal(plan.target.host,'cloud');
 const r=await service.apply({id:plan.id,fingerprint:plan.fingerprint,confirm:true});assert.equal(r.publication.state,'active');assert.equal(f.c.notifications.defaults.current().definition.host,'cloud');
 assert.equal(f.c.scheduler.jobs.db.prepare('SELECT count(*) n FROM jobs').get().n,0);assert.equal(f.c.notifications.defaults.view().writeAuthorized,false);
});

test('paired discovery rejects restarted or replaced peer and missing capability instead of falling back',async t=>{
 const f=await fixture(t),ui=setup();f.ctx.get=name=>name==='dshIm'?ui.options.im():null;
 await f.c.start();await f.c.pending;clearTimeout(f.c.timer);clearInterval(f.c.scheduler.timer);
 const local=new Gateway(f.ctx,{role:'local',entryMode:'native',namespace:'defaults-unit',stateDir:f.root+'/peer-changes',tokenFile:f.root+'/tokens.json',port:0,coordinatorUrl:'http://127.0.0.1:'+f.c.server.address().port},{now:f.now});t.after(()=>local.close());
 let selected=local;const service=createOnboardingNotificationDefaults({...ui.options,gateway:()=>selected,remoteEnabled:()=>true,remote:()=>{throw Error('must not fall back');}});
 const rows=await service.scan({host:'cloud'}),input={enabled:true,host:'cloud',candidate_id:rows.items[0].candidate_id,label:rows.items[0].label};
 const plan=await service.preview(input);f.c.instanceId=randomUUID();await assert.rejects(service.apply({id:plan.id,fingerprint:plan.fingerprint,confirm:true}),/PROTOCOL_INSTANCE_CHANGED/);assert.equal(ui.stored,null);
 await service.scan({host:'cloud'});selected=null;await assert.rejects(service.preview(input),/CANDIDATE_CHANGED/);
 selected=local;const hello=f.c.hello.bind(f.c);f.c.hello=()=>{const h=hello();delete h.capabilities.notification_default_peer;return h;};await assert.rejects(service.scan({host:'cloud'}),/CAPABILITY_UNAVAILABLE/);
 await assert.rejects(f.c.call('notification_default_peer_discover',{host:'cloud'},'cloud'),/ROLE_DENIED/);
 assert.equal(f.c.notifications.defaults.view().enabled,false);
});


test('actual onboarding activity admits default-sync before queued local notification drain and restart dedupe',async t=>{
 const f=await fixture(t);await f.c.start();await f.c.pending;clearTimeout(f.c.timer);clearInterval(f.c.scheduler.timer);
 const config={role:'local',entryMode:'native',namespace:'defaults-unit',stateDir:f.root+'/local',tokenFile:f.root+'/tokens.json',port:0,coordinatorUrl:'http://127.0.0.1:'+f.c.server.address().port};
 const local=new Gateway(f.ctx,config,{now:f.now});t.after(()=>local.close());const a=policy();
 const credentials={readRecord:async()=>({kind:'grant',payload:{owner:'dsh-dual-host-onboarding',policy:a}}),describeRecord:async()=>({writable:true}),modifyRecord:async()=>assert.fail('background sync must not rewrite consent')};
 const activity=createOnboardingActivity(),service=createOnboardingService({},config,{activity,credentials,gateway:local,home:f.root+'/home',env:{}});t.after(()=>service.dispose());
 local.notifications.defaultSource=()=>service.syncNotificationDefaults();
 await local.notifications.tick();assert.equal(local.notifications.lastError,null);assert.equal(activity.status().counts.notification_defaults_sync,0);
 const task=await f.create();await f.schedule(task);f.finish();assert.equal(f.status(task).deliveries[0].state,'queued');
 await local.notifications.tick();assert.equal(local.notifications.lastError,null);assert.equal(f.sends.length,1);assert.equal(f.status(task).deliveries[0].state,'accepted');
 const {TaskNotifications}=await import('../bundle/task-notifications.js');local.notifications=new TaskNotifications(local);local.notifications.defaultSource=()=>service.syncNotificationDefaults();
 await local.notifications.tick();assert.equal(f.sends.length,1);assert.equal(f.status(task).deliveries.length,1);
});

test('existing guide compares real local and cloud default views independent of key insertion order',async t=>{
 const {createExistingSetup}=await import('../bundle/onboarding-existing-setup.js');
 for(const host of ['local','cloud']){
  const f=await fixture(t),p=policy(host);await f.publish(p);
  let stored={kind:'grant',payload:{owner:'dsh-dual-host-onboarding',policy:p}};
  const credentials={readRecord:async()=>structuredClone(stored),modifyRecord:async()=>{throw Error('NO_CONFIRMATION_WRITE');}};
  const g={closed:false,c:{role:'local'},link:{call:async(method,args)=>({result:await f.c.call(method,args,'local'),observation:{authority:'cloud',freshness:'live_response',instance_id:f.c.instanceId}})}};
  const notifications=createOnboardingNotificationDefaults({state:{available:()=>true},credentials:()=>credentials,im:()=>null,gateway:()=>g,role:'local',remoteEnabled:()=>false});
  const service=createExistingSetup({gateway:()=>g,inspection:{available:()=>true},state:{available:()=>true},credentials:()=>credentials,notifications});
  t.after(()=>{service.dispose();notifications.dispose();});
  const a=await notifications.status({}),b=f.c.notifications.defaults.view();
  assert.deepEqual(a.target,b.target);assert.notEqual(JSON.stringify(a.target),JSON.stringify(b.target),'fixture must reproduce the real property-order difference');
  assert.equal((await service.notifications({})).synchronized,true);
  for(const change of [{revision:p.revision+1},{operation:randomUUID()},{definition:{...p.definition,host:host==='local'?'cloud':'local'}},{definition:{...p.definition,label:'different recipient'}}]){
   stored={kind:'grant',payload:{owner:'dsh-dual-host-onboarding',policy:{...p,...change}}};
   assert.equal((await service.notifications({})).synchronized,false,'real ledger drift must still fail');
  }
  assert.equal(f.sends.length,0);
 }
});
