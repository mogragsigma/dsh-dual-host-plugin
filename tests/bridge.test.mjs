import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SourceTextModule,SyntheticModule} from 'node:vm';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {botIdentity,routeDecision,mayDispatch} from '../bundle/feishu-policy.js';
import * as durableInbox from '../bundle/durable-inbox.js';

const root = path.resolve(import.meta.dirname, '..');
const TEXT_TEST = JSON.stringify({text: 'test'});

const envelope = (opts = {}) => ({
  sender: {sender_type: 'user', sender_id: {open_id: 'ou_human'}},
  message: {
    message_id: crypto.randomUUID(), chat_id: 'oc_test', chat_type: 'group',
    message_type: 'text', content: TEXT_TEST, mentions: [], ...opts,
  },
});
const response = {code: 0, bot: {open_id: 'ou_self', app_name: 'same-name'}};

function synthetic(obj) {
  return new SyntheticModule(Object.keys(obj), function () {
    for (const [k, v] of Object.entries(obj)) this.setExport(k, v);
  });
}

async function fixture(side, reply = response, config = {}, extra = {}) {
  const home = extra.home ?? fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bridge-'));
  let handlers, channel;
  const deliveries = [], warnings = [], sends = [];
  let time = 100000, requests = 0, unregistered = 0, closed = 0;
  const effects = [];
  const z = {object: () => ({}), array: () => ({default: () => ({})}), string: () => ({default: () => ({})}), boolean: () => ({default: () => ({})}), number: () => ({default: () => ({})})};
  const source = fs.readFileSync(path.join(root, 'tests/fixtures', side + '-v050.js'), 'utf8');
  const mod = new SourceTextModule(source);
  await mod.link(async spec => {
    if (spec === '@deepseek-ai/schemastery') return synthetic({default: z});
    if (spec === '@larksuiteoapi/node-sdk') return synthetic({});
    if (spec === './dsh-feishu-policy.js') return synthetic({botIdentity, routeDecision, mayDispatch});
    if (spec === './dsh-durable-inbox.js') return synthetic({
      DurableInbox: durableInbox.DurableInbox,
      openDurableInbox: durableInbox.openDurableInbox,
      fingerprintOf: durableInbox.fingerprintOf,
      DEFAULTS: durableInbox.DEFAULTS,
    });
    if (spec === './web-rpc.js') return synthetic({installFeishuWebRpc: () => () => {}});
    if (spec === './provision.js') return synthetic({createFeishuProvisionSession: () => ({cancel() {}})});
    return synthetic(await import(spec));
  });
  await mod.evaluate();
  const ctx = {
    effect(f) { effects.push(f()); },
    logger: () => ({warn: (...a) => warnings.push(a), info() {}, error() {}, debug() {}}),
    get: n => n === 'im' ? {
      registerChannel: c => { channel = c; return () => unregistered++; },
      dispatchInbound: async m => deliveries.push(m),
    } : config.ingress,
  };
  const sdk = {
    Client: class { im={message:{create:async x=>{sends.push(x);return extra.sendResult??{code:0,data:{message_id:'om_test'}};}}}; async request() { requests++; return typeof reply === 'function' ? reply() : reply; } },
    EventDispatcher: class { register(h) { handlers = h; } },
    WSClient: class { start() { return Promise.resolve(); } close() { closed++; } },
  };
  const internals = {
    sdk, home, exposeInbox: true, now: () => time,
    inboxOpts: {pumpIntervalMs: 0, now: () => time, ...(extra.inboxOpts ?? {})},
  };
  const dispose = mod.namespace.apply(ctx, {appId: 'test', appSecret: 'test', durableInboxPumpMs: 0, ...config}, internals);
  return {
    send: async d => { await handlers['im.message.receive_v1'](d); },
    deliveries, warnings, channel, sends,
    requests: () => requests,
    lifecycle: () => ({unregistered, closed}),
    disposeEffects: async () => { for (const f of effects) await f(); },
    tick: n => { time += n; },
    close: async () => { await dispose(); if (!extra.keepHome) fs.rmSync(home, {recursive: true, force: true}); },
    home,
    inbox: () => channel.dshInbox,
    stats: () => channel.status.inbox,
  };
}

const taskText = t => JSON.stringify({text: t});

for (const side of ['local', 'cloud']) {
  test(side + ': actual v050 handler rejects unmentioned, @other, same-name spoof, unknown sender; accepts ID self and p2p; dedupes', async () => {
    const f = await fixture(side);
    try {
      await f.send(envelope());
      await f.send(envelope({mentions: [{id: {open_id: 'ou_other'}, name: 'same-name'}]}));
      await f.send(envelope({mentions: [{id: {user_id: 'ou_self'}}]}));
      const u = envelope({mentions: [{id: 'ou_self'}]});
      u.sender.sender_type = 'unknown';
      await f.send(u);
      assert.equal(f.deliveries.length, 0);
      // nothing reached the durable inbox either (no @ gate, no enqueue)
      assert.equal(f.stats().counts.queued + f.stats().counts.done + f.stats().counts.needs_review, 0);
      const hit = envelope({mentions: [{id: 'ou_self'}]});
      await f.send(hit);
      await f.send(hit);
      await f.send(envelope({chat_type: 'p2p'}));
      assert.equal(f.deliveries.length, 2);
      assert.equal(f.channel.status.identityReady, true);
    } finally { await f.close(); }
  });

  test(side + ': startup waits for lookup, no fail-open window', async () => {
    let resolve;
    const p = new Promise(r => resolve = r);
    const f = await fixture(side, () => p);
    try {
      const pending = f.send(envelope());
      await Promise.resolve();
      assert.equal(f.deliveries.length, 0);
      resolve(response);
      await pending;
      assert.equal(f.deliveries.length, 0);
    } finally { await f.close(); }
  });

  test(side + ': lookup failure denied; throttled retry recovers', async () => {
    let fail = true;
    const f = await fixture(side, () => fail ? Promise.reject(Error('offline')) : response);
    try {
      await f.send(envelope({mentions: [{id: 'ou_self'}]}));
      assert.equal(f.deliveries.length, 0);
      assert.equal(f.requests(), 1);
      fail = false;
      f.tick(30001);
      await f.send(envelope({mentions: [{id: 'ou_self'}]}));
      assert.equal(f.deliveries.length, 1);
      assert.equal(f.requests(), 2);
    } finally { await f.close(); }
  });

  test(side + ': legacy bot prefix retained, ordinary bot ignored', async () => {
    const f = await fixture(side);
    try {
      const d = envelope();
      d.sender.sender_type = 'bot';
      await f.send(d);
      assert.equal(f.deliveries.length, 0);
      d.message.content = taskText('[A2A] test');
      await f.send(d);
      assert.equal(f.deliveries.length, 1);
      assert.equal(f.stats().counts.done + f.stats().counts.queued, 0);
    } finally { await f.close(); }
  });

  test(side + ': Cordis effect owns channel disposal exactly once (incl. durable inbox)', async () => {
    const f = await fixture(side);
    try {
      await Promise.resolve();
      await f.disposeEffects();
      await f.disposeEffects();
      assert.equal(f.lifecycle().unregistered, 1);
      assert.equal(f.lifecycle().closed, 1);
      assert.throws(() => f.inbox().put({msgId: 'x'}), /INBOX_CLOSED/);
    } finally { await f.close(); }
  });

  test(side + ': managed group preserves normal mentioned chat outside /task', async () => {
    const f = await fixture(side, response, {managedChatIds: ['oc_test'], ingress: {receive() { throw Error('Should not run'); }}});
    try {
      await f.send(envelope({mentions: [{id: 'ou_self'}], content: taskText('ordinary question')}));
      assert.equal(f.deliveries.length, 1);
      assert.equal(f.warnings.length, 0);
      assert.equal(f.stats().counts.queued, 0);
    } finally { await f.close(); }
  });

  test(side + ': managed /task persists first, then async durable consumption; never falls back', async () => {
    const received = [];
    const config = {managedChatIds: ['oc_test'], ingress: {receive: async m => received.push(m)}};
    const f = await fixture(side, response, config);
    try {
      const msg = envelope({mentions: [{id: 'ou_self'}], content: taskText('/task test goal')});
      await f.send(msg);
      assert.equal(received.length, 0); // callback returned right after the durable put
      assert.equal(f.stats().counts.queued, 1); // no Gateway wait, no fallback
      await f.inbox().pump();
      assert.equal(received.length, 1);
      assert.equal(received[0].msgId, msg.message.message_id);
      assert.equal(f.deliveries.length, 0);
      assert.equal(f.stats().counts.done, 1);
      assert.equal(f.stats().counts.queued, 0);
      await f.inbox().pump(); // replay of a done row is a no-op
      assert.equal(received.length, 1);
      config.ingress.receive = async () => { throw Error('offline'); };
      await f.send(envelope({mentions: [{id: 'ou_self'}], content: taskText('/task other goal')}));
      await f.inbox().pump();
      assert.equal(f.deliveries.length, 0); // transient failure stays queued, no legacy route
      assert.equal(f.stats().counts.queued, 1);
    } finally { await f.close(); }
  });

  test(side + ': absent service still persists; service restored later auto-consumes', async () => {
    const config = {managedChatIds: ['oc_test'], ingress: null};
    const f = await fixture(side, response, config);
    try {
      const msg = envelope({mentions: [{id: 'ou_self'}], content: taskText('/task durable goal')});
      await f.send(msg);
      await f.inbox().pump();
      assert.equal(f.stats().counts.queued, 1); // Gateway missing: kept, not swallowed
      const received = [];
      config.ingress = {receive: async m => received.push(m.msgId)};
      await f.inbox().pump();
      assert.deepEqual(received, [msg.message.message_id]);
      assert.equal(f.stats().counts.done, 1);
      assert.equal(f.deliveries.length, 0);
    } finally { await f.close(); }
  });

  test(side + ': restart recovery keeps the queue and dedupes on msgId', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bridge-restart-'));
    try {
      const f1 = await fixture(side, response, {managedChatIds: ['oc_test'], ingress: null}, {home, keepHome: true});
      const msg = envelope({mentions: [{id: 'ou_self'}], content: taskText('/task restart goal')});
      await f1.send(msg);
      await f1.inbox().pump();
      assert.equal(f1.stats().counts.queued, 1);
      await f1.close();
      const received = [];
      const f2 = await fixture(side, response, {managedChatIds: ['oc_test'], ingress: {receive: async m => received.push(m.msgId)}}, {home, keepHome: true});
      await f2.send(msg); // same content: duplicate, not re-enqueued
      assert.equal(f2.stats().counts.queued, 1);
      await f2.inbox().pump();
      assert.deepEqual(received, [msg.message.message_id]);
      assert.equal(f2.stats().counts.done, 1);
      assert.equal(f2.deliveries.length, 0);
      await f2.close();
    } finally { fs.rmSync(home, {recursive: true, force: true}); }
  });

  test(side + ': outbound UUID and remote message ID survive; API error is not success', async () => {
    const f=await fixture(side);try {
      const result=await f.channel.send({chatId:'oc_test',text:'test',uuid:'u-1'});
      assert.equal(result.messageId,'om_test');assert.equal(f.sends[0].data.uuid,'u-1');
      const status=JSON.parse(JSON.stringify(f.channel.status));assert.equal(status.inbox.counts.queued,0);
    }finally{await f.close();}
    const bad=await fixture(side,response,{}, {sendResult:{code:10000,msg:'private remote text'}});
    try{await assert.rejects(bad.channel.send({chatId:'oc_test',text:'test'}),/FEISHU_SEND_UNCONFIRMED/);}finally{await bad.close();}
  });

  test(side + ': put failure is never acknowledged as success (fail closed)', async () => {
    const f = await fixture(side, response, {managedChatIds: ['oc_test'], ingress: {receive() { throw Error('Should not run'); }}});
    try {
      await f.inbox().close(); // simulate an unusable store
      await assert.rejects(f.send(envelope({mentions: [{id: 'ou_self'}], content: taskText('/task failing goal')})), /INBOX_CLOSED/);
      assert.equal(f.warnings.length, 1); // put failure surfaced, not swallowed
      assert.equal(f.deliveries.length, 0); // and no legacy fallback either
    } finally { await f.close(); }
  });
}

test('body shape and supported headers wrapper; reject malformed/failed identity', () => {
  assert.equal(botIdentity(response), 'ou_self');
  assert.equal(botIdentity({data: response, headers: {}}), 'ou_self');
  for (const r of [null, {}, {code: 42, bot: response.bot}, {code: 0, bot: {open_id: 'user_id'}}, {data: {bot: response.bot}}]) assert.equal(botIdentity(r), '');
});
for(const side of ['local','cloud'])test(side+': run/status/approval/pause commands are durable, never handed to legacy model',async()=>{
 const received=[],f=await fixture(side,response,{managedChatIds:['oc_test'],ingress:{receive:async m=>received.push(m)}});
 try{for(const text of ['/run demo p m','/status demo','/approve job digest','/pause job','/resume job','/cancel job','/task'])await f.send(envelope({mentions:[{id:'ou_self'}],content:taskText(text)}));
  assert.equal(f.deliveries.length,0);assert.equal(f.stats().counts.queued,7);await f.inbox().pump();assert.equal(received.length,7);
 }finally{await f.close();}
});
