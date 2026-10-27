import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {FileRoot} from '../bundle/peer-file-fs.js';
import {createOnboardingService} from '../bundle/onboarding-host.js';
import {fixture,held,enqueue,hash,confirm,max} from './helpers/file-review-fixture.mjs';
const preview=(f,item,decision='resume')=>f.m.queueReviewPreview({item,decision});
const receipt=(f,p)=>f.m.queueReviewStatus({operation:p.id,fingerprint:p.fingerprint});
const item=(queue,id,origin='')=>({queue,id,origin});
test('queue list and preview are readonly; resume uses immutable snapshot, not removed source; preserves budget and remains disabled',async t=>{
 const f=await held(t),before=f.queue()[0],revision=(await f.m.status({})).revision,writes=f.writes();fs.rmSync(f.a,{recursive:true});
 const listed=await f.m.queueList({});assert.equal(listed.items[0].name,'safe.txt');assert.equal(listed.items[0].from,'cloud');assert.equal(listed.items[0].recoveryCheck,'requires_byte_validation');assert.equal(listed.items[0].attempts,3);
 const p=await preview(f,f.sent.item);assert.equal(p.kind,'queue_review');assert(p.review.snapshotOnly&&p.review.requiresSeparateEnable);assert.equal(p.writes,0);assert.deepEqual(f.queue()[0],before);assert.equal(f.writes(),writes);
 const r=await f.m.queueReviewApply(confirm(p));assert.equal(r.decision,'resume');assert.equal(r.stateAtDecision,'queued');assert.equal(f.queue()[0].attempts,3);assert.equal(f.queue()[0].next_at,1234);assert.equal((await f.m.status({})).revision,revision);assert(!f.g.files);assert.equal(fs.readFileSync(f.sent.blob,'utf8'),'immutable');assert.equal(f.writes(),writes);
 await f.restart();assert(!f.g.files);assert.equal((await receipt(f,p)).receipt.operation,p.id);assert((await f.m.queueReviewApply(confirm(p))).notReapplied);assert.equal(f.g.db.prepare('SELECT count(*) n FROM peer_file_review').get().n,1);
});
test('retention keeps corrupt/legacy records and all files; no receipt invents delivery',async t=>{
 const f=await held(t);f.g.db.prepare('DELETE FROM peer_file_hold').run();fs.writeFileSync(f.sent.blob,'CHANGED');assert.equal((await f.m.queueList({})).items[0].recoveryCheck,'ONBOARDING_FILES_QUEUE_HISTORY_MISSING');await assert.rejects(preview(f,f.sent.item),/HISTORY_MISSING/);
 const before=f.queue()[0],p=await preview(f,f.sent.item,'retain'),r=await f.m.queueReviewApply(confirm(p));assert.equal(r.stateAtDecision,'needs_review');assert.deepEqual(f.queue()[0],before);assert((await f.m.queueList({})).items[0].retained);assert.equal(fs.readFileSync(f.sent.blob,'utf8'),'CHANGED');assert(!f.g.files);
});
test('active, unconfigured, unexpected and unconfirmed queue review calls never reopen',async t=>{
 const f=await fixture(t);await assert.rejects(f.m.queueList({}),/NOT_CONFIGURED/);await f.enable();const sent=await enqueue(f);await assert.rejects(preview(f,sent.item),/QUEUE_DISABLE_REQUIRED/);await f.disable();await f.migrate();await assert.rejects(preview(f,{...sent.item,origin:'cloud'}),/ARGUMENTS/);await assert.rejects(f.m.queueReviewPreview({item:sent.item,decision:'resume',force:true}),/ARGUMENTS/);const p=await preview(f,sent.item);await assert.rejects(f.m.queueReviewApply({...confirm(p),confirm:false}),/CONFIRMATION/);assert.equal(f.queue()[0].state,'needs_review');
});
test('oversize and exhausted records can be retained but cannot be resumed by resetting budget or changing ID',async t=>{
 for(const kind of ['size','attempts']){const f=await fixture(t);await f.enable();const sent=await enqueue(f);if(kind==='attempts')f.g.db.prepare('UPDATE peer_file_out SET attempts=16').run();await f.disable();await f.migrate(kind==='size'?1:max);
  await assert.rejects(preview(f,sent.item),kind==='size'?/SIZE_LIMIT/:/RETRY_BUDGET/);assert.equal(f.queue()[0].id,sent.id);await f.m.queueReviewApply(confirm(await preview(f,sent.item,'retain')));assert.equal(f.queue()[0].state,'needs_review');}
});
test('queue, hold, snapshot or owner drift after preview refuses atomically and preserves evidence',async t=>{
 for(const drift of ['queue','hold','snapshot','owner']){const f=await held(t),p=await preview(f,f.sent.item);
  if(drift==='queue')f.g.db.prepare('UPDATE peer_file_out SET next_at=555').run();if(drift==='hold')f.g.db.prepare("UPDATE peer_file_hold SET operation='foreign'").run();if(drift==='snapshot')fs.writeFileSync(f.sent.blob,'CHANGED');if(drift==='owner')f.g.db.prepare("UPDATE peer_file_owner SET config='foreign'").run();
  const before=f.queue()[0];await assert.rejects(f.m.queueReviewApply(confirm(p)));assert.deepEqual(f.queue()[0],before);assert(!f.g.db.prepare("SELECT name FROM sqlite_master WHERE name='peer_file_review'").get());assert(!f.g.files);}
});
test('expired preview and changed grant revision cannot authorize a queue update',async t=>{
 for(const drift of ['expiry','grant']){const f=await held(t),p=await preview(f,f.sent.item);if(drift==='expiry')f.advance();else await f.m.fence({operation:randomUUID(),expectedRevision:p.expectedRevision,confirm:true});await assert.rejects(f.m.queueReviewApply(confirm(p)),drift==='expiry'?/PLAN_EXPIRED/:/CONFLICT/);assert.equal(f.queue()[0].state,'needs_review');}
});
test('SQLite abort rolls back queue and receipt together; new explicit preview can recover',async t=>{
 const f=await held(t);f.g.db.exec("CREATE TRIGGER fail_review BEFORE UPDATE ON peer_file_out BEGIN SELECT RAISE(ABORT,'SYNTHETIC_FAIL'); END");const p=await preview(f,f.sent.item);await assert.rejects(f.m.queueReviewApply(confirm(p)),/SYNTHETIC_FAIL/);assert.equal(f.queue()[0].state,'needs_review');assert.equal((await receipt(f,p)).receipt,null);f.g.db.exec('DROP TRIGGER fail_review');const next=await preview(f,f.sent.item);assert.equal((await f.m.queueReviewApply(confirm(next))).stateAtDecision,'queued');
});
test('lost response is read from durable receipt after restart; replay never resets advanced state',async t=>{
 const f=await held(t),p=await preview(f,f.sent.item);await f.m.queueReviewApply(confirm(p));f.g.db.prepare("UPDATE peer_file_out SET state='received',attempts=4,next_at=9999").run();await f.restart();assert.equal((await receipt(f,p)).receipt.stateAtDecision,'queued');assert((await f.m.queueReviewApply(confirm(p))).notReapplied);assert.equal(f.queue()[0].state,'received');assert.equal(f.queue()[0].attempts,4);await assert.rejects(f.m.queueReviewStatus({operation:p.id,fingerprint:'e'.repeat(64)}),/RECEIPT_CONFLICT/);
});
function seed(f,state,collision=false){
 const data=Buffer.from('incoming saved bytes'),id='file-'+hash(state+collision),m={v:1,namespace:f.g.c.namespace,id,task_id:'task-'+randomUUID(),from:'local',to:'cloud',name:'received.txt',size:data.length,sha256:hash(data),created_at:1};
 f.g.db.prepare('INSERT INTO peer_file_in(id,meta,state,attempts,next_at) VALUES(?,?,?,2,321)').run(id,JSON.stringify(m),state);
 const spool=new FileRoot(f.root+'/state/peer-files');spool.publish(['receive','local',id+'.part'],data,m.sha256);spool.publish(['broker','local',id+'.blob'],data,m.sha256);f.g.db.prepare("INSERT INTO peer_file_broker VALUES(?,'local',?,'available')").run(id,JSON.stringify(m));
 let destination;if(collision||state==='publishing')destination=new FileRoot(f.root+'/files/inbox').publish([m.task_id,id,m.name],data,m.sha256);return {id,m,data,destination};
}
test('publishing provenance permits only exact crash recovery; receiving provenance rejects even identical destination',async t=>{
 for(const phase of ['publishing','receiving']){const f=await fixture(t);await f.enable();const s=seed(f,phase,true);await f.disable();await f.migrate();
  if(phase==='receiving'){await assert.rejects(preview(f,item('incoming',s.id)),/DESTINATION_EXISTS/);assert(fs.readFileSync(s.destination).equals(s.data));continue;}
  await f.m.queueReviewApply(confirm(await preview(f,item('incoming',s.id))));await f.m.queueReviewApply(confirm(await preview(f,item('broker',s.id,'local'))));await f.enable([f.b]);await f.g.files.sync();const r=(await f.g.files.list(s.m.task_id)).received[0];assert.equal(r.state,'received');assert.equal(r.availability,'available');assert(fs.readFileSync(s.destination).equals(s.data));assert.equal(f.g.db.prepare('SELECT attempts FROM peer_file_in WHERE id=?').get(s.id).attempts,2);
 }
});
test('partial file corruption, replaced snapshot links and metadata drift never authorize recovery',async t=>{
 for(const mode of ['partial','link','metadata']){const f=await held(t);
  if(mode==='link'){fs.renameSync(f.sent.blob,f.sent.blob+'.original');fs.symlinkSync(f.sent.blob+'.original',f.sent.blob);}
  if(mode==='metadata')f.g.db.prepare("UPDATE peer_file_out SET meta='{}'").run();
  if(mode==='partial')fs.writeFileSync(f.sent.blob,'short');await assert.rejects(preview(f,f.sent.item));assert.equal(f.queue()[0].state,'needs_review');assert(!f.g.files);
 }
});
test('real protocol waits for independent peer review without spending retry attempts, then delivers original bytes and ID',async t=>{
 const cloud=await fixture(t),local=await fixture(t,'local',cloud.id);await cloud.enable();await local.enable();local.g.link.transport=async(method,args)=>method==='negotiate'?{hello:cloud.g.hello()}:{result:await cloud.g.call(method,args,'local'),observation:cloud.g.observation()};const task=(await cloud.g.submit({task_key:'s57-review-wire',source:'native-cloud',ingress_id:randomUUID(),goal:'immutable byte transfer'})).task_id;
 const sent=await enqueue(local,'large.bin',Buffer.alloc(300000,0x64),task);await local.g.files.sync();assert.equal(cloud.g.db.prepare('SELECT state FROM peer_file_broker WHERE id=?').get(sent.id).state,'receiving');
 for(const f of [local,cloud]){await f.disable();await f.migrate();}
 await local.m.queueReviewApply(confirm(await preview(local,sent.item)));await local.enable([local.b]);await cloud.enable([cloud.b]);const attempts=local.queue()[0].attempts;for(let i=0;i<3;i++){local.advance();await local.g.files.sync();}assert.equal(local.queue()[0].state,'queued');assert.equal(local.queue()[0].attempts,attempts);assert.equal(local.queue()[0].error,'PEER_FILE_PEER_REVIEW_REQUIRED');assert.equal(cloud.g.db.prepare('SELECT state FROM peer_file_broker WHERE id=?').get(sent.id).state,'needs_review');
 await cloud.disable();await cloud.m.queueReviewApply(confirm(await preview(cloud,item('broker',sent.id,'local'))));await cloud.enable([cloud.b]);fs.writeFileSync(sent.file,'source changed');
 for(let i=0;i<8;i++){local.advance();cloud.advance();await local.g.files.sync();await cloud.g.files.sync();}
 const got=(await cloud.g.files.list(task)).received[0];assert.equal(got.transfer_id,sent.id);assert.equal(got.state,'received');assert.equal(got.sha256,hash(Buffer.alloc(300000,0x64)));assert.equal(hash(fs.readFileSync(got.path)),got.sha256);assert.equal(local.queue()[0].attempts,attempts);assert(!cloud.g.scheduler&&!cloud.g.development);
});
test('public Host dispatch exposes scoped review without enabling transfer or native execution',async t=>{
 const f=await held(t),service=createOnboardingService({}, {onboarding:{role:'cloud'}},{home:f.parent,env:{},taskRuntime:{files:f.m,status:async()=>({configured:true}),available:()=>true}});
 assert.equal((await service.call('describe',{})).capabilities.managedFileQueueReviewContract,2);assert.equal((await service.call('file_transfer_queueList',{})).items.length,1);const p=await service.call('file_transfer_queueReviewPreview',{item:f.sent.item,decision:'retain'});const r=await service.call('file_transfer_queueReviewApply',confirm(p));assert.equal(r.decision,'retain');assert.equal((await service.call('file_transfer_queueReviewStatus',{operation:p.id,fingerprint:p.fingerprint})).receipt.operation,p.id);assert(!f.g.files);
});
test('an already held legacy record is not given fabricated history by a later scope migration',async t=>{
 const f=await fixture(t);await f.enable();const sent=await enqueue(f);f.g.db.prepare("UPDATE peer_file_out SET state='needs_review',error='PEER_FILE_UNAVAILABLE',attempts=16").run();await f.disable();await f.migrate();assert.equal(f.g.db.prepare('SELECT count(*) n FROM peer_file_hold').get().n,0);await assert.rejects(preview(f,sent.item),/HISTORY_MISSING/);assert.equal(f.queue()[0].attempts,16);
});
test('journal insert failure does not leave a resumed queue without its receipt',async t=>{
 const f=await held(t);await f.m.queueReviewApply(confirm(await preview(f,f.sent.item,'retain')));f.g.db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON peer_file_review BEGIN SELECT RAISE(ABORT,'SYNTHETIC_RECEIPT_FAIL'); END");const p=await preview(f,f.sent.item);await assert.rejects(f.m.queueReviewApply(confirm(p)),/SYNTHETIC_RECEIPT_FAIL/);assert.equal(f.queue()[0].state,'needs_review');assert.equal((await receipt(f,p)).receipt,null);
});
test('corrupt receipt and deleted provenance do not become successful recovery claims',async t=>{
 const f=await held(t),p=await preview(f,f.sent.item,'retain');await f.m.queueReviewApply(confirm(p));f.g.db.prepare("UPDATE peer_file_review SET receipt='{}'").run();await assert.rejects(receipt(f,p),/RECEIPT_REVIEW/);f.g.db.prepare('DELETE FROM peer_file_migration').run();await assert.rejects(preview(f,f.sent.item),/HISTORY_MISSING/);
});
test('zero-byte snapshots recover without inventing payload; completed records are absent from held list',async t=>{
 const f=await fixture(t);await f.enable();const sent=await enqueue(f,'empty.txt','');await f.disable();await f.migrate();const p=await preview(f,sent.item);assert.equal(p.review.size,0);await f.m.queueReviewApply(confirm(p));assert.equal((await f.m.queueList({})).items.length,0);assert.equal(fs.readFileSync(sent.blob).length,0);
});
test('reverse cloud-to-local partial receipt stays held until local approval; cloud approval never substitutes',async t=>{
 const cloud=await fixture(t),local=await fixture(t,'local',cloud.id);await cloud.enable();await local.enable();local.g.link.transport=async(method,args)=>method==='negotiate'?{hello:cloud.g.hello()}:{result:await cloud.g.call(method,args,'local'),observation:cloud.g.observation()};const task=(await cloud.g.submit({task_key:'s57-review-reverse',source:'native-cloud',ingress_id:randomUUID(),goal:'reverse partial bytes'})).task_id;
 const bytes=Buffer.alloc(300000,0x61),sent=await enqueue(cloud,'reverse.bin',bytes,task);for(let i=0;i<2;i++){cloud.advance();await cloud.g.files.sync();}await local.g.files.sync();assert.equal(local.g.db.prepare('SELECT state FROM peer_file_in WHERE id=?').get(sent.id).state,'receiving');
 for(const f of [local,cloud]){await f.disable();await f.migrate();}
 for(const entry of [sent.item,item('broker',sent.id,'cloud')])await cloud.m.queueReviewApply(confirm(await preview(cloud,entry)));await cloud.enable([cloud.b]);await local.enable([local.b]);for(let i=0;i<3;i++){cloud.advance();local.advance();await cloud.g.files.sync();await local.g.files.sync();}
 assert.equal(local.g.db.prepare('SELECT state FROM peer_file_in WHERE id=?').get(sent.id).state,'needs_review');assert.equal(cloud.queue()[0].state,'broker_saved');
 await local.disable();await local.m.queueReviewApply(confirm(await preview(local,item('incoming',sent.id))));await local.restart();assert(!local.g.files);await local.enable([local.b]);for(let i=0;i<4;i++){cloud.advance();local.advance();await local.g.files.sync();await cloud.g.files.sync();}
 const got=(await local.g.files.list(task)).received[0];assert.equal(got.transfer_id,sent.id);assert.equal(got.state,'received');assert.equal(got.availability,'available');assert.equal(hash(fs.readFileSync(got.path)),hash(bytes));assert.equal(cloud.queue()[0].state,'received');
});
test('native close is a durable no-replay barrier without enabling, stopping or changing a queue',async t=>{
 const f=await held(t),p=await preview(f,f.sent.item);const a={operation:p.id,fingerprint:p.fingerprint,confirm:true};const out=await f.m.queueReviewClose(a);assert.equal(out.contract,2);assert(out.closed);assert.equal(out.receipt,null);assert.equal(f.queue()[0].state,'needs_review');await f.restart();assert((await receipt(f,p)).closed);await assert.rejects(f.m.queueReviewApply(confirm(p)),/QUEUE_CLOSED/);assert((await f.m.queueReviewClose(a)).closed);await assert.rejects(f.m.queueReviewClose({...a,fingerprint:'e'.repeat(64)}),/RECEIPT_CONFLICT/);
});
test('native close cannot undo a committed decision and reports the original receipt',async t=>{
 const f=await held(t),p=await preview(f,f.sent.item);const r=await f.m.queueReviewApply(confirm(p));const s=await f.m.queueReviewClose({operation:p.id,fingerprint:p.fingerprint,confirm:true});assert(!s.closed);assert.deepEqual(s.receipt,r);assert.equal(f.queue()[0].state,'queued');
});
