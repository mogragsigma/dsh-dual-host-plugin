import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {DurableInbox, fingerprintOf} from '../bundle/durable-inbox.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-inbox-'));
const msg = (msgId, text = 'hello') => ({platform: 'feishu', chatId: 'oc_test', userId: 'ou_human', senderType: 'user', text, msgId, chatType: 'group'});

test('put dedupes identical content, rejects same ID with different content, throws on persistence failure', async () => {
  const dir = tmp();
  const inbox = new DurableInbox({file: path.join(dir, 'in.sqlite'), legacyFeishu:true,peerEnabled:false,namespace: 'app1', getService: () => null, pumpIntervalMs: 0});
  const a = inbox.put(msg('m1'));
  assert.equal(a.duplicate, false);
  const b = inbox.put(msg('m1'));
  assert.equal(b.duplicate, true);
  assert.equal(b.status, a.status);
  assert.throws(() => inbox.put(msg('m1', 'different text')), /INGRESS_ID_CONFLICT/);
  assert.throws(() => inbox.put({platform: 'feishu', msgId: '', text: 'x'}), /INBOX_MSGID_REQUIRED/);
  // fail closed on write error: put must throw, not silently succeed
  inbox.closed = true; // simulate unusable store
  assert.throws(() => inbox.put(msg('m2')), /INBOX_CLOSED/);
  inbox.closed = false;
  await inbox.close();
  fs.rmSync(dir, {recursive: true, force: true});
});

test('missing service keeps rows queued without burning attempts; recovery consumes exactly once', async () => {
  const dir = tmp();
  let service = null;
  const received = [];
  const inbox = new DurableInbox({file: path.join(dir, 'in.sqlite'), legacyFeishu:true,peerEnabled:false,namespace: 'app1', getService: () => service, pumpIntervalMs: 0, baseBackoffMs: 1});
  inbox.put(msg('m1'));
  await inbox.pump(); // service absent
  assert.equal(inbox.stats().counts.queued, 1);
  service = {receive: async m => { received.push(m.msgId); }};
  await inbox.pump();
  await inbox.pump();
  assert.deepEqual(received, ['m1']);
  assert.equal(inbox.stats().counts.done, 1);
  assert.equal(inbox.stats().counts.queued, 0);
  await inbox.close();
  fs.rmSync(dir, {recursive: true, force: true});
});

test('transient failure backs off exponentially (injected clock) and stays bounded', async () => {
  const dir = tmp();
  let time = 1000;
  let attemptsLeft = 3;
  const inbox = new DurableInbox({file: path.join(dir, 'in.sqlite'), legacyFeishu:true,peerEnabled:false,namespace: 'app1', getService: () => ({receive: async () => { if (attemptsLeft-- > 0) throw Error('NETWORK_DOWN'); }}), pumpIntervalMs: 0, baseBackoffMs: 100, now: () => time});
  inbox.put(msg('m1'));
  await inbox.pump();
  assert.equal(inbox.stats().counts.queued, 1);
  time += 201; // past 100*2^1 backoff
  await inbox.pump();
  assert.equal(inbox.stats().counts.queued, 1);
  time += 401;
  await inbox.pump();
  time += 801;
  await inbox.pump();
  assert.equal(inbox.stats().counts.done, 1);
  await inbox.close();
  fs.rmSync(dir, {recursive: true, force: true});
});

test('permanent identity/protocol failures go to needs_review and never retry unboundedly', async () => {
  const dir = tmp();
  let calls = 0;
  const inbox = new DurableInbox({file: path.join(dir, 'in.sqlite'), legacyFeishu:true,peerEnabled:false,namespace: 'app1', getService: () => ({receive: async () => { calls++; throw Error('OWNER_DENIED'); }}), pumpIntervalMs: 0, baseBackoffMs: 0, now: () => 0});
  inbox.put(msg('m1'));
  for (let i = 0; i < 5; i++) { await inbox.pump(); }
  assert.equal(calls, 1); // exactly one attempt, then parked
  assert.equal(inbox.stats().counts.needs_review, 1);
  const st = inbox.retryFailed('m1');
  assert.equal(st.status, 'queued');
  await inbox.pump();
  assert.equal(calls, 2);
  assert.equal(inbox.stats().counts.needs_review, 1);
  await inbox.close();
  fs.rmSync(dir, {recursive: true, force: true});
});

test('too many transient attempts parks in needs_review instead of looping forever', async () => {
  const dir = tmp();
  let time = 0;
  let calls = 0;
  const inbox = new DurableInbox({file: path.join(dir, 'in.sqlite'), legacyFeishu:true,peerEnabled:false,namespace: 'app1', getService: () => ({receive: async () => { calls++; throw Error('TIMEOUT'); }}), pumpIntervalMs: 0, baseBackoffMs: 1, maxAttempts: 3, now: () => time});
  inbox.put(msg('m1'));
  for (let i = 0; i < 10; i++) { time += 1000; await inbox.pump(); }
  assert.equal(calls, 3); // maxAttempts caps delivery attempts
  assert.equal(inbox.stats().counts.needs_review, 1);
  await inbox.close();
  fs.rmSync(dir, {recursive: true, force: true});
});

test('restart recovery: an active lease is not stolen at startup; an expired lease replays (at-least-once)', async () => {
  const dir = tmp();
  const file = path.join(dir, 'in.sqlite');
  let time = 0;
  const first = new DurableInbox({file, legacyFeishu:true,peerEnabled:false,namespace: 'app1', getService: () => ({receive: async () => { throw Error('NETWORK_DOWN'); }}), pumpIntervalMs: 0, baseBackoffMs: 1, now: () => time});
  first.put(msg('m1'));
  time += 10;
  await first.pump(); // fails, back to queued
  await first.close();
  // simulate a crash mid-delivery: row stuck in processing with an active lease
  const raw = new DurableInbox({file, legacyFeishu:true,peerEnabled:false,namespace: 'app1', getService: () => null, pumpIntervalMs: 0, now: () => time});
  raw.db.prepare("UPDATE inbox SET status='processing',claim_token='crashed-owner',lease_until=?,next_attempt_at=0 WHERE msg_id='m1'").run(time + 5000);
  await raw.close();
  const received = [];
  const second = new DurableInbox({file, legacyFeishu:true,peerEnabled:false,namespace: 'app1', getService: () => ({receive: async m => received.push(m.msgId)}), pumpIntervalMs: 0, now: () => time});
  await second.pump();
  assert.deepEqual(received, []); // fresh instance must NOT steal the active lease
  time += 5001; // lease expires
  await second.pump();
  assert.deepEqual(received, ['m1']); // replay after lease expiry (at-least-once)
  assert.equal(second.stats().counts.done, 1);
  await second.close();
  fs.rmSync(dir, {recursive: true, force: true});
});

test('receive succeeded but marking crashed: replay is idempotent at the data layer', async () => {
  const dir = tmp();
  const file = path.join(dir, 'in.sqlite');
  const received = [];
  const svc = {receive: async m => { received.push(m.msgId); }};
  const inbox = new DurableInbox({file, legacyFeishu:true,peerEnabled:false,namespace: 'app1', getService: () => svc, pumpIntervalMs: 0, baseBackoffMs: 1, now: () => 0});
  inbox.put(msg('m1'));
  // crash simulation: consume the claim, deliver, then never mark done
  const claim = inbox.claimNext();
  assert.ok(claim);
  await svc.receive(claim.message);
  const again = inbox.claimNext();
  assert.equal(again, null); // lease still active, no second claim
  // manual mark failure (simulating process death before the done update)
  inbox.db.prepare("UPDATE inbox SET lease_until=0 WHERE msg_id='m1'").run();
  const replay = inbox.claimNext();
  assert.ok(replay);
  await svc.receive(replay.message);
  const done = inbox.db.prepare("UPDATE inbox SET status='done',claim_token=NULL,lease_until=NULL WHERE msg_id=? AND claim_token=?").run('m1', replay.token);
  assert.equal(done.changes, 1);
  // downstream saw m1 twice; it must dedupe on msgId — inbox guarantees at-least-once only
  assert.deepEqual(received, ['m1', 'm1']);
  await inbox.close();
  fs.rmSync(dir, {recursive: true, force: true});
});

test('concurrent claim: only one CAS winner delivers; namespaces are isolated', async () => {
  const dir = tmp();
  const inbox = new DurableInbox({file: path.join(dir, 'in.sqlite'), legacyFeishu:true,peerEnabled:false,namespace: 'app1', getService: () => ({receive: async () => {}}), pumpIntervalMs: 0, now: () => 0});
  inbox.put(msg('m1'));
  const claims = [inbox.claimNext(), inbox.claimNext()];
  assert.ok(claims[0]);
  assert.equal(claims[1], null); // second claim loses the CAS race
  // different namespaces (app IDs) keep independent rows even for the same msgId
  const other = new DurableInbox({file: path.join(dir, 'in2.sqlite'), legacyFeishu:true,peerEnabled:false,namespace: 'app2', getService: () => ({receive: async () => {}}), pumpIntervalMs: 0, now: () => 0});
  other.put(msg('m1'));
  assert.notEqual(inbox.put(msg('m9')).id, other.put(msg('m9')).id);
  await other.close();
  await inbox.close();
  fs.rmSync(dir, {recursive: true, force: true});
});

test('auto pump can be disabled and close is idempotent, stops timers and awaits inflight', async () => {
  const dir = tmp();
  let releaseGate;
  const gate = new Promise(r => releaseGate = r);
  const inbox = new DurableInbox({file: path.join(dir, 'in.sqlite'), legacyFeishu:true,peerEnabled:false,namespace: 'app1', getService: () => ({receive: async () => { await gate; }}), pumpIntervalMs: 10});
  inbox.put(msg('m1'));
  const pumping = inbox.pump(); // one delivery is now inflight, blocked on the gate
  const closing = inbox.close(); // must wait for the inflight delivery
  await new Promise(r => setImmediate(r));
  releaseGate();
  await pumping;
  await closing;
  await inbox.close(); // repeat close is safe
  assert.throws(() => inbox.put(msg('m2')), /INBOX_CLOSED/); // no operation after close
  await inbox.pump(); // no-op after close
  assert.throws(() => inbox.stats(), /INBOX_CLOSED/);
  fs.rmSync(dir, {recursive: true, force: true});
});

test('fingerprint is stable for the same normalized message and differs otherwise', () => {
  assert.equal(fingerprintOf(msg('m1')), fingerprintOf(msg('m1')));
  assert.notEqual(fingerprintOf(msg('m1')), fingerprintOf(msg('m1', 'other')));
  assert.notEqual(fingerprintOf(msg('m1')), fingerprintOf(msg('m2')));
});

test('same SQLite file isolates namespaces and colon message IDs; malformed inputs rejected',async t=>{
 const dir=tmp();t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const a=new DurableInbox({file:path.join(dir,'shared.sqlite'),legacyFeishu:true,peerEnabled:false,namespace:'app1',getService:()=>({receive(){throw Error('BAD_SIGNATURE');}}),pumpIntervalMs:0});
 const b=new DurableInbox({file:path.join(dir,'shared.sqlite'),legacyFeishu:true,peerEnabled:false,namespace:'app2',getService:()=>null,pumpIntervalMs:0});
 t.after(async()=>{await a.close();await b.close();});
 a.put(msg('message:one'));b.put(msg('message:one'));await a.pump();
 assert.equal(a.stats().counts.needs_review,1);assert.equal(b.stats().counts.queued,1);
 assert.throws(()=>b.retryFailed('app1:message:one'),/NOT_FOUND/);
 a.retryFailed('message:one');assert.equal(a.stats().counts.queued,1);
 for(const m of [msg(''),msg('x\0y'),msg('x','a'.repeat(20001)),{...msg('x'),text:{evil:true}}])assert.throws(()=>a.put(m));
 for(const f of ['shared.sqlite','shared.sqlite-wal','shared.sqlite-shm'])if(fs.existsSync(path.join(dir,f)))assert.equal(fs.statSync(path.join(dir,f)).mode&0o777,0o600);
});

test('permanent protocol verdicts and SyntaxError quarantined without storing external text',async t=>{
 const dir=tmp();t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let err;
 const a=new DurableInbox({file:path.join(dir,'in.sqlite'),legacyFeishu:true,peerEnabled:false,namespace:'app',getService:()=>({receive(){throw err;}}),pumpIntervalMs:0});t.after(()=>a.close());
 for(const [i,e] of [Error('BAD_SIGNATURE'),Error('ENVELOPE_EXPIRED'),new SyntaxError('secret payload')].entries()){err=e;a.put(msg('m'+i));await a.pump();}
 assert.equal(a.stats().counts.needs_review,3);
 err=Error('very private response');a.put(msg('transient'));await a.pump();
 assert.equal(a.db.prepare('SELECT last_error FROM inbox WHERE msg_id=?').get('transient').last_error,'UNKNOWN_TRANSIENT');
 assert.ok(!JSON.stringify(a.db.prepare('SELECT last_error FROM inbox').all()).includes('secret'));
});

test('hung delivery times out, close is single-flight, late result cannot acknowledge a newer claim',async t=>{
 const dir=tmp();t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let finish;
 const a=new DurableInbox({file:path.join(dir,'in.sqlite'),legacyFeishu:true,peerEnabled:false,namespace:'app',getService:()=>({receive:()=>new Promise(r=>finish=r)}),deliveryTimeoutMs:10,leaseMs:1000,pumpIntervalMs:0});
 a.put(msg('m'));await a.pump();assert.equal(a.stats().counts.queued,1);
 const before=a.db.prepare('SELECT status,attempts FROM inbox').get();finish();await new Promise(r=>setImmediate(r));
 assert.deepEqual(a.db.prepare('SELECT status,attempts FROM inbox').get(),before);
 const one=a.close(),two=a.close();assert.equal(one,two);await one;
 assert.equal(a.summary().closed,true);
});

test('SQLite write failure is thrown, and symlink DB files including dangling links are rejected',async t=>{
 const dir=tmp();t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const a=new DurableInbox({file:path.join(dir,'in.sqlite'),legacyFeishu:true,peerEnabled:false,namespace:'app',getService:()=>null,pumpIntervalMs:0});
 a.db.exec('PRAGMA query_only=ON');assert.throws(()=>a.put(msg('failed')),/readonly/i);assert.equal(a.stats().counts.queued,0);await a.close();
 fs.symlinkSync(path.join(dir,'missing'),path.join(dir,'link'));
 assert.throws(()=>new DurableInbox({file:path.join(dir,'link'),legacyFeishu:true,peerEnabled:false,namespace:'app',getService:()=>null}),/UNSAFE/);
});

test('real process SIGKILL after WAL put/claim recovers after lease; no cold-start lease theft',async t=>{
 const {spawn}=await import('node:child_process');
 const dir=tmp();t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'kill.sqlite');
 const source=`import {DurableInbox} from ${JSON.stringify(new URL('../bundle/durable-inbox.js',import.meta.url).href)};const a=new DurableInbox({file:process.argv[1],legacyFeishu:true,peerEnabled:false,namespace:'app',getService:()=>null,pumpIntervalMs:0,now:()=>0});a.put(${JSON.stringify(msg('killed'))});a.claimNext();process.stdout.write('persisted\\n');setInterval(()=>{},1000);`;
 const child=spawn(process.execPath,['--input-type=module','-e',source,file],{stdio:['ignore','pipe','ignore']});t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
 await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',code=>reject(Error('premature exit '+code)));});
 await new Promise(resolve=>{child.once('exit',resolve);child.kill('SIGKILL');});
 let now=1,calls=0;const a=new DurableInbox({file,legacyFeishu:true,peerEnabled:false,namespace:'app',getService:()=>({receive:async()=>{calls++;}}),pumpIntervalMs:0,now:()=>now});t.after(()=>a.close());
 await a.pump();assert.equal(calls,0);now=120001;await a.pump();assert.equal(calls,1);assert.equal(a.stats().counts.done,1);
});
