import test from 'node:test';import assert from 'node:assert/strict';
import {chmodSync,linkSync,renameSync,mkdirSync,symlinkSync,readFileSync} from 'node:fs';
import {fixture} from './delivery-receipt-fixture.mjs';
import {DeliveryProcessReceipts,validateReceiptBinding} from '../bundle/delivery-process-receipts.js';
test('receipt descriptor is persisted before process start and bound to one operation/epoch/intent',async t=>{
 const f=await fixture(t);assert.equal(f.j.operation(f.op).state,'intent');assert.deepEqual(f.receipts.binding(f.op).b,f.binding);
 assert.throws(()=>f.receipts.prepare(f.op));assert.throws(()=>validateReceiptBinding({...f.binding,epoch:f.binding.epoch+1}),/BINDING_INVALID/);
 assert.equal(f.j.db.prepare('SELECT count(*) n FROM delivery_process_receipts').get().n,1);
});
test('valid receipt closes only the operation; keeps resource busy until separate readback',async t=>{
 const f=await fixture(t);f.ready();const proof=f.receipts.inspect(f.op),count=f.j.db.prepare('SELECT total_changes() n').get().n;
 assert.equal(proof.state,'terminal_verified');assert.equal(f.j.db.prepare('SELECT total_changes() n').get().n,count);
 const r=f.receipts.reconcile(f.op,proof.fingerprint);assert.equal(r.task_released,false);assert.equal(f.j.operation(f.op).state,'closed');assert.equal(f.store.task(f.task.id).busy,1);
 const event=JSON.parse(f.j.db.prepare("SELECT data FROM delivery_events WHERE action_id=? AND type='operation_drained' ORDER BY seq DESC LIMIT 1").get(f.a.id).data);
 assert.equal(event.evidence.receipt_sha256,proof.receipt_sha256);assert.equal(event.evidence.binding_hash,f.binding.binding_hash);
 assert.equal(f.receipts.reconcile(f.op,proof.fingerprint).retry_authorized,false);
});
test('missing receipt never closes an operation even if supervisor is gone',async t=>{
 const f=await fixture(t);f.j.spawned(f.op,54321);f.j.recover();assert.throws(()=>f.receipts.inspect(f.op));assert.equal(f.j.unfinished(f.a.id),true);assert.equal(f.store.task(f.task.id).busy,1);
});
test('valid terminal receipt still waits for its exact supervisor to exit',async t=>{
 const f=await fixture(t);f.ready();f.control.live=true;const p=f.receipts.inspect(f.op);assert.equal(p.state,'supervisor_live');
 assert.throws(()=>f.receipts.reconcile(f.op,p.fingerprint),/EVIDENCE_CHANGED/);assert.equal(f.j.unfinished(f.a.id),true);
});
for(const field of ['binding_hash','boot_id','operation_id','pid','start_ticks','kind','extra','nonce','drained','reaped','stdout'])test('rejects altered terminal evidence '+field,async t=>{
 const f=await fixture(t);f.ready();const r=f.report();
 if(field==='nonce')r.report.nonce='b'.repeat(64);else if(field==='drained')r.report.drained=false;else if(field==='reaped')r.report.reaped=0;
 else if(field==='stdout')r.report.stdout='unexpected';else r[field]=field==='pid'?123:'invalid';f.write(r);
 assert.throws(()=>f.receipts.inspect(f.op));assert.equal(f.j.unfinished(f.a.id),true);
});
test('changed evidence after inspection cannot be consumed under an older fingerprint',async t=>{
 const f=await fixture(t);f.ready();const p=f.receipts.inspect(f.op),r=f.report();r.report.code=1;f.write(r);
 assert.throws(()=>f.receipts.reconcile(f.op,p.fingerprint),/EVIDENCE_CHANGED/);assert.equal(f.j.unfinished(f.a.id),true);
});
for(const kind of ['permissions','hardlink','symlink','directory-replaced'])test('rejects untrusted file identity '+kind,async t=>{
 const f=await fixture(t);f.ready();
 if(kind==='permissions')chmodSync(f.file,0o644);
 if(kind==='hardlink')linkSync(f.file,f.file+'.linked');
 if(kind==='symlink'){renameSync(f.file,f.file+'.original');symlinkSync(f.file+'.original',f.file);}
 if(kind==='directory-replaced'){renameSync(f.directory,f.directory+'.original');mkdirSync(f.directory,{mode:0o700});}
 assert.throws(()=>f.receipts.inspect(f.op));assert.equal(f.j.unfinished(f.a.id),true);
});
test('reopen uses exact original receipt directory and journal, never a replacement directory',async t=>{
 const f=await fixture(t);f.ready();const next=new DeliveryProcessReceipts({journal:f.j,directory:f.directory,enabled:true},f.io);
 assert.deepEqual(next.inspect(f.op),f.receipts.inspect(f.op));assert.throws(()=>new DeliveryProcessReceipts({journal:f.j,directory:f.directory,enabled:false}),/DISABLED/);
 assert(!readFileSync(f.file,'utf8').includes('synthetic-key'));
});
test('reconciliation requires current held generation, not just a valid process receipt',async t=>{
 const f=await fixture(t);f.ready();const p=f.receipts.inspect(f.op);f.j.db.prepare('UPDATE tasks SET epoch=epoch+1 WHERE id=?').run(f.task.id);
 assert.throws(()=>f.receipts.reconcile(f.op,p.fingerprint));assert.equal(f.j.unfinished(f.a.id),true);
});

test('workspace revision drift prevents adopting even an intact old terminal receipt',async t=>{
 const f=await fixture(t);f.ready();const p=f.receipts.inspect(f.op);f.j.db.prepare('UPDATE tasks SET revision=revision+1 WHERE id=?').run(f.task.id);
 assert.throws(()=>f.receipts.reconcile(f.op,p.fingerprint),/TASK_REVISION_CHANGED/);assert.equal(f.j.unfinished(f.a.id),true);
});
