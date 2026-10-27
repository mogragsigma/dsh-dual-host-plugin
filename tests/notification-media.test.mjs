import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,chmodSync,unlinkSync} from 'node:fs';
import {fixture,png} from './notification-media-fixture.mjs';
import {decodeImage,imageType} from '../bundle/artifact-media.js';
import {NotificationMediaEndpoint} from '../bundle/notification-media-endpoint.js';
import {Gateway} from '../bundle/index.js';
const lease=e=>({id:e.id,lease:e.lease});
test('explicit per-artifact consent, direct source, task ownership and optimistic revisions precede any upload',async t=>{
 const f=await fixture(t),task=await f.create(),a=f.report(task),other=await f.create();
 await assert.rejects(f.send(f.args(task,a)),/REVISION/);await f.bind(task);const args=f.args(task,a);
 for(const change of [{sources:[]},{sources:f.source(args.authorization_quote,'local')},{authorization_quote:'只发状态到媒体验收私聊'},{expected_revision:2},{expected_binding_revision:2},{task_id:other.id},{path:'/etc/passwd'},{mode:'html'}])await assert.rejects(f.send({...args,...change}));
 assert.equal(f.posts().length,0);await f.g.notifications.tick();assert.equal(f.posts().length,0);
 const r=await f.send(args);assert.equal(r.state,'media_queued');assert.equal(f.g.notifications.lease('cloud').items.length,0);
 assert.deepEqual(await f.send(args),r);const duplicate=await f.send({...args,event_id:'second'});assert.equal(duplicate.id,r.id);assert.equal(duplicate.already_requested,true);
 await assert.rejects(f.send({...args,mode:'image'}),/EVENT_CONFLICT/);assert.equal(f.posts().length,0);
});
test('file upload plus separate introduction/file uses pinned official API and persistent receipt, never read/approval',async t=>{
 const f=await fixture(t),{task,a,e}=await f.queued();await f.g.notifications.tick();
 const posts=f.posts();assert.equal(posts.length,3);assert(posts[0].args.body instanceof FormData);
 assert.equal(posts[0].args.body.get('file_type'),'stream');assert.equal(posts[0].args.body.get('file_name'),a.name);assert.equal(await posts[0].args.body.get('file').text(),'隔离成果正文\n');
 const intro=JSON.parse(posts[1].args.body),file=JSON.parse(posts[2].args.body);
 assert.equal(intro.msg_type,'text');assert.match(JSON.parse(intro.content).text,/不是附件发送成功回执/);assert.equal(file.msg_type,'file');assert.equal(JSON.parse(file.content).file_key,'file_fixture');assert.notEqual(intro.uuid,file.uuid);
 assert.equal(f.row(e.id).state,'accepted');const inbox=f.g.notifications.endpoint.media.row(e.id);assert(inbox.intro_message_id);assert(inbox.uploaded_key);
 const reopened=new NotificationMediaEndpoint(f.g.notifications.endpoint);assert.equal((await reopened.execute(e)).state,'accepted');assert.equal(f.posts().length,3);await reopened.close();
 assert.equal(f.g.approvals.list(task.id).length,0);assert.equal(f.g.store.snapshot().intents.length,0);
 const access=await f.g.call('notification_artifact_access',{task_id:task.id,notification_id:e.id});assert.equal(access.kind,'feishu_attachment');assert.equal(access.cannot_recall_uploaded_copy,true);
});
test('image registration retains exact bytes and sends a rich post with description and validated key',async t=>{
 const f=await fixture(t),{a,e}=await f.queued('png',png);await f.g.notifications.tick();assert.equal(f.row(e.id).state,'accepted');
 const posts=f.posts();assert.equal(posts.length,2);assert.equal(posts[0].args.body.get('image_type'),'message');assert.deepEqual(Buffer.from(await posts[0].args.body.get('image').arrayBuffer()),png);
 const message=JSON.parse(posts[1].args.body),content=JSON.parse(message.content);assert.equal(message.msg_type,'post');assert.equal(content.zh_cn.title,a.name);assert.equal(content.zh_cn.content[1][0].image_key,'img_fixture');
});
test('image validation rejects arbitrary bytes, URLs, malformed base64, bad dimensions and trailing payloads',()=>{
 assert.equal(imageType(png),'image/png');assert.deepEqual(decodeImage('png',png.toString('base64')),png);
 for(const b of [Buffer.from('<svg/>'),Buffer.from('https://example.test/x'),Buffer.concat([png,Buffer.from('extra')]),png.subarray(0,32),Buffer.from([255,216,255,255,255,255,217])])assert.throws(()=>imageType(b),/ARTIFACT_/);
 assert.throws(()=>decodeImage('png','xxx=bad'),/INVALID_IMAGE/);assert.throws(()=>decodeImage('png','x'.repeat(349529)),/INVALID_IMAGE/);assert.throws(()=>decodeImage('jpeg',png.toString('base64')),/INVALID_IMAGE/);
 const huge=Buffer.from(png);huge.writeUInt32BE(9000,16);assert.throws(()=>imageType(huge),/DIMENSIONS/);
});
for(const fault of ['changed','permissions','missing','revision'])test('stale source '+fault+' stops before any network mutation',async t=>{
 const f=await fixture(t),{task,a,e}=await f.queued(),path=f.g.artifacts.root+'/'+a.id+'.bin';
 if(fault==='changed')writeFileSync(path,'changed');if(fault==='permissions')chmodSync(path,0o644);if(fault==='missing')unlinkSync(path);if(fault==='revision')f.g.store.db.prepare('UPDATE task_catalog SET spec_revision=2 WHERE task_id=?').run(task.id);
 await f.g.notifications.tick();assert.equal(f.posts().length,0);assert(['needs_review','cancelled'].includes(f.row(e.id).state));
});
for(const at of ['preflight','upload','intro'])test('revocation at '+at+' prevents later mutations without claiming old upload recalled',async t=>{
 const f=await fixture(t),{task,e}=await f.queued();let done=false;
 f.hook(async u=>{if(!done&&((at==='preflight'&&u.includes('/chats/'))||(at==='upload'&&u.endsWith('/files'))||(at==='intro'&&u.includes('/messages?')))){done=true;await f.disable(task);}});
 await f.g.notifications.tick();assert.equal(f.row(e.id).state,'cancelled');assert.equal(f.posts().length,{preflight:0,upload:1,intro:2}[at]);if(at!=='preflight')assert.equal(f.g.notifications.endpoint.media.row(e.id).uploaded_key,'file_fixture');
});
for(const fault of ['upload','intro','send'])test('unknown '+fault+' is persisted; restart/late retry does not alter evidence or resend',async t=>{
 const f=await fixture(t),{e}=await f.queued();let messages=0;
 f.hook(u=>{if(u.includes('/messages?'))messages++;if(fault==='upload'&&u.endsWith('/files')||fault==='intro'&&messages===1||fault==='send'&&messages===2)throw Error('private secret error');});
 await f.g.notifications.tick();assert.equal(f.row(e.id).state,'needs_review');assert.equal(f.row(e.id).message_id,null);
 const ep=f.g.notifications.endpoint.media,original=ep.row(e.id),before=f.posts().length;
 const restarted=new NotificationMediaEndpoint(f.g.notifications.endpoint);assert.deepEqual(restarted.row(e.id),original);await restarted.execute(e);assert.equal(f.posts().length,before);
 assert.throws(()=>restarted.finish(e.id,{state:'accepted',proof:'provider_message',message_id:'om_late'}),/RECEIPT_CONFLICT/);await restarted.close();
});
for(const phase of ['uploading','introducing','sending'])test('crashed intent '+phase+' quarantines with no replay',async t=>{
 const f=await fixture(t),{e}=await f.queued();const ep=f.g.notifications.endpoint.media;ep.db.prepare("INSERT INTO notification_media_inbox(id,fingerprint,payload,phase,created) VALUES (?,?,?,?,?)").run(e.id,(await import('../bundle/notification-contract.js')).digest(e),JSON.stringify(e),phase,Date.now());
 const restarted=new NotificationMediaEndpoint(f.g.notifications.endpoint);const r=await restarted.execute(e);assert.equal(r.state,'needs_review');assert.equal(f.posts().length,0);await restarted.close();
});
test('late upload success after timeout never advances to message and original unknown stays immutable',async t=>{
 const f=await fixture(t),{e}=await f.queued();let release;f.hook(u=>u.endsWith('/files')?new Promise(r=>release=r):undefined);
 await f.g.notifications.tick();assert.equal(f.row(e.id).error,'NOTIFICATION_UPLOAD_RESULT_UNKNOWN');release();await new Promise(r=>setTimeout(r,20));assert.equal(f.posts().length,1);assert.equal(f.g.notifications.endpoint.media.row(e.id).uploaded_key,null);
});
test('role/lease mismatch and legacy wait cannot downgrade a media row into text delivery',async t=>{
 const f=await fixture(t),{e}=await f.queued();
 await assert.rejects(f.g.notifications.media.materialize('local',lease(e)),/LEASE_MISMATCH/);
 await assert.rejects(f.g.call('notification_media_materialize',{id:e.id,lease:'forged'}),/LEASE_MISMATCH/);
 await assert.rejects(f.g.call('notification_wait',{...lease(e),reason:'NOTIFICATION_BACKOFF',retry_after_ms:30000,safe_before_send:true}),/RECEIPT_INVALID/);
 assert.equal(f.row(e.id).state,'media_leased');assert.equal(f.g.notifications.lease('cloud').items.length,0);
});
test('authenticated dual Host delivery queues offline and lost ack is replayed without another upload/send',async t=>{
 const f=await fixture(t,{host:'local'});await f.g.start();await f.g.pending;clearTimeout(f.g.timer);clearInterval(f.g.scheduler.timer);
 const local=new Gateway(f.ctx,{...f.config,role:'local',stateDir:f.root+'/local',notificationFeishu:[f.c],coordinatorUrl:'http://127.0.0.1:'+f.g.server.address().port},{notificationFeishu:f.io});t.after(()=>local.close());
 const {e}=await f.queued();const remote=local.remoteTransport.bind(local);let offline=true,lost=true;
 local.remoteTransport=async(m,...a)=>{if(offline)throw Error('COORDINATOR_UNAVAILABLE');if(m==='notification_ack'&&lost){lost=false;throw Error('COORDINATOR_UNAVAILABLE');}return remote(m,...a);};
 await local.notifications.tick();assert.equal(f.posts().length,0);offline=false;await local.notifications.tick();assert.equal(f.posts().length,3);assert.equal(f.row(e.id).state,'media_dispatching');
 await local.notifications.tick();assert.equal(f.posts().length,3);assert.equal(f.row(e.id).state,'accepted');
});
test('unsupported or absent media adapter fails explicitly without public text fallback',async t=>{
 const f=await fixture(t),{e}=await f.queued();f.g.notifications.endpoint.direct.clear();await f.g.notifications.tick();assert.equal(f.posts().length,0);assert.equal(f.row(e.id).error,'NOTIFICATION_MEDIA_CAPABILITY_UNAVAILABLE');assert.equal(f.row(e.id).state,'media_leased');
});
test('Gitee page delivery verifies exact bound bytes and emits a fixed external page without upload',async t=>{
 const f=await fixture(t),task=await f.create(),commit='a'.repeat(40),repo={provider:'gitee',repository_id:13,url:'https://gitee.com/test/artifacts',branch:'main',base_sha:commit,private:true,workspace:null};
 f.g.store.db.prepare("INSERT INTO repository_associations VALUES (?,1,'bound',?,'fingerprint',?,NULL)").run(task.id,JSON.stringify(repo),Date.now());
 let unavailable=false;const bytes=Buffer.from('registered file');f.g.repositories.provider={file:async()=>{if(unavailable)throw Error('REPOSITORY_ACCESS_DENIED');return {bytes,blob_sha:'b'.repeat(40),url:repo.url+'/blob/'+commit+'/report.md'};}};
 const a=await f.g.artifacts.registerGitee('cloud',{task_id:task.id,expected_revision:1,expected_binding_revision:1,path:'report.md',event_id:'gitee',sources:f.source('登记 report.md')});
 await f.bind(task);const r=await f.send(f.args(task,a,'page'));await f.g.notifications.tick();assert.equal(f.row(r.id).state,'accepted');assert.equal(f.posts().length,1);assert.match(JSON.parse(f.posts()[0].args.body).content,/gitee.com/);
 const access=await f.g.call('notification_artifact_access',{task_id:task.id,notification_id:r.id});assert.equal(access.kind,'gitee');assert.equal(access.url,repo.url+'/blob/'+commit+'/report.md');
 unavailable=true;await assert.rejects(f.g.call('notification_artifact_access',{task_id:task.id,notification_id:r.id}),/ACCESS_DENIED/);assert.equal(f.posts().length,1);
});
test('live file message link is fixed official AppLink; revoked or changed messages do not expose a link',async t=>{
 const f=await fixture(t),{task,e}=await f.queued();await f.g.notifications.tick();const args={task_id:task.id,notification_id:e.id};
 const access=await f.g.call('notification_artifact_access',args);assert.equal(access.url,'https://applink.feishu.cn/client/chat/open?openChatId=oc_chat1234&position=123');assert.equal(access.message_state,'present_at_check');
 const sender=f.g.notifications.endpoint.direct.get('media'),prepare=sender.prepare.bind(sender);
 for(const changed of [{deleted:true},{chat_id:'oc_other1234'},{msg_type:'text'},{body:{content:'{"file_key":"file_wrong"}'}}]){
  sender.prepare=async(...a)=>{const source=await prepare(...a),get=source.get.bind(source);source.get=async id=>({...await get(id),...changed});return source;};
  await assert.rejects(f.g.call('notification_artifact_access',args),/MESSAGE_UNAVAILABLE/);
 }
 assert.equal(f.posts().length,3);sender.prepare=prepare;
 const other=await f.create();await assert.rejects(f.g.call('notification_artifact_access',{...args,task_id:other.id}),/NOT_ACCEPTED/);
});
test('persisted completed upload skips upload on safe resume; final result prevents further effects',async t=>{
 const f=await fixture(t),{e}=await f.queued(),ep=f.g.notifications.endpoint.media,{digest}=await import('../bundle/notification-contract.js');
 ep.db.prepare("INSERT INTO notification_media_inbox(id,fingerprint,payload,phase,uploaded_key,created) VALUES (?,?,?,'uploaded','file_fixture',?)").run(e.id,digest(e),JSON.stringify(e),Date.now());
 await f.g.notifications.tick();assert.equal(f.row(e.id).state,'accepted');assert.equal(f.posts().length,2);assert(f.posts().every(x=>x.url.includes('/messages?')));
});
test('media UI adds manual live entry verification, no upload controls or auto network polling',async()=>{
 const {readFileSync}=await import('node:fs'),s=readFileSync(new URL('../ui-source/workbench-client.js',import.meta.url),'utf8');
 assert(s.includes('核验手机成果入口'));assert(s.includes('safeNotificationURL'));assert(s.includes('fresh:detailFresh'));assert(!s.includes("request('notification_artifact_send'"));assert(!s.includes('setInterval'));
});
test('source changing during provider message read invalidates the entry after await',async t=>{
 const f=await fixture(t),{task,a,e}=await f.queued();await f.g.notifications.tick();
 f.hook(u=>{if(/\/messages\/om_/.test(u))writeFileSync(f.g.artifacts.root+'/'+a.id+'.bin','changed');});
 await assert.rejects(f.g.call('notification_artifact_access',{task_id:task.id,notification_id:e.id}),/ARTIFACT_/);
 assert.equal(f.posts().length,3);
});
test('media capability mismatch rejects new peer operations without legacy fallback',async t=>{
 const f=await fixture(t),{requireCapability}=await import('../bundle/link-contract.js'),own=f.g.hello(),peer={...own,role:'local',capabilities:{...own.capabilities}};delete peer.capabilities.notification_media;
 for(const method of ['notification_artifact_send','notification_media_pull','notification_media_materialize','notification_artifact_access'])assert.throws(()=>requireCapability(method,own,peer),/CAPABILITY_UNAVAILABLE/);
});
test('real Feishu rekey/normalized post behavior is accepted only when immutable content still matches',async t=>{
 for(const kind of ['file','image']){
  const f=await fixture(t),{task,e}=await f.queued(kind==='image'?'png':'markdown',kind==='image'?png:undefined);await f.g.notifications.tick();
  const sender=f.g.notifications.endpoint.direct.get('media'),prepare=sender.prepare.bind(sender);sender.prepare=async(...a)=>{const s=await prepare(...a),get=s.get.bind(s);s.get=async id=>{const m=await get(id),body=JSON.parse(m.body.content);if(kind==='file')body.file_key='file_rekeyed';else m.updated=true;return {...m,body:{content:JSON.stringify(body)}};};return s;};
  const access=await f.g.call('notification_artifact_access',{task_id:task.id,notification_id:e.id});assert.equal(access.message_state,'present_at_check');
  if(kind==='file')assert(f.calls.some(c=>c.url.includes('/resources/file_rekeyed?type=file')));assert.equal(f.posts().length,kind==='file'?3:2);
 }
});
test('remote file bytes changed despite matching name/receipt cannot yield a link',async t=>{
 const f=await fixture(t),{task,e}=await f.queued();await f.g.notifications.tick();const fetcher=f.io.fetcher;f.io.fetcher=(u,a)=>u.includes('/resources/')?new Response('different bytes'):fetcher(u,a);
 await assert.rejects(f.g.call('notification_artifact_access',{task_id:task.id,notification_id:e.id}),/ARTIFACT_CHANGED/);assert.equal(f.posts().length,3);
});
test('missing endpoint durable inbox cannot replay coordinator dispatching intent after storage loss',async t=>{
 const f=await fixture(t),{e}=await f.queued();await f.g.call('notification_media_materialize',{...lease(e),new_delivery:true});
 // This simulates loss of endpoint storage, not a user-authorized retry.
 assert.equal(f.row(e.id).state,'media_dispatching');assert.equal(f.g.notifications.endpoint.media.row(e.id),undefined);
 await f.g.notifications.tick();assert.equal(f.posts().length,0);assert.equal(f.row(e.id).state,'needs_review');assert.equal(f.row(e.id).error,'NOTIFICATION_ENDPOINT_STATE_LOST');
});
