// DSH 0.4.0 durable inbox: persistent, at-least-once message intake queue.
// Node built-in SQLite only (WAL + synchronous FULL, busy_timeout). No third-party deps.
// The inbox owns its lifecycle independent of the Gateway plugin: enqueueing
// works even when the receiving service is absent, and a bounded serial pump
// consumes later with exponential backoff. Delivery is at-least-once; the
// downstream (Gateway receive) is idempotent on msgId, so a crash between
// receive-success and mark-done may replay, which is safe. This is NOT
// exactly-once and messages never received by the SDK cannot be recovered.
// Do not log message text here: rows persist content only inside the DB file,
// and persisted last_error values are stable codes only, never raw text.

import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync,lstatSync,existsSync,openSync,closeSync,fchmodSync,constants} from 'node:fs';
import {dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

// Fixed-field normalization shared by fingerprinting and storage: bounded
// strings, no NUL, msgId required. Prevents unbounded/odd objects in the row.
const FIELDS = [['platform',32],['chatId',128],['userId',128],['senderType',32],['text',20000],['msgId',256],['chatType',16]];

export function normalizeMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) throw Error('INVALID_MESSAGE');
  const out = {};
  for (const [key, max] of FIELDS) {
    const v = message[key];
    if (v === undefined || v === null) { out[key] = ''; continue; }
    if (typeof v !== 'string' && typeof v !== 'number') throw Error('INVALID_MESSAGE');
    const s = String(v);
    if (s.length > max || s.includes('\u0000')) throw Error('INVALID_MESSAGE');
    out[key] = s;
  }
  if (!out.msgId) throw Error('INBOX_MSGID_REQUIRED');
  return out;
}

export const fingerprintOf = msg => createHash('sha256').update(JSON.stringify(Object.values(normalizeMessage(msg)))).digest('hex');

// Stable permanent verdict codes, aligned with bundle/protocol.js and
// bundle/index.js (Gateway). These are protocol/identity outcomes: retrying
// cannot change them and could bypass fail-closed identity checks.
export const PERMANENT = new Set([
  'PEER_IDENTITY_DENIED','PROTOCOL_DENIED','BAD_ENVELOPE','BAD_SIGNATURE',
  'ENVELOPE_POLICY_DENIED','ENVELOPE_EXPIRED','A2A_ID_CONFLICT',
  'INGRESS_ID_CONFLICT','OWNER_DENIED','CHAT_DENIED','INVALID_SUBMISSION','INVALID_INGRESS','INVALID_COMMAND',
]);

// Classify a delivery failure to a stable, safe code. SyntaxError (malformed
// JSON) is quarantined permanently; unknown errors are transient and stored
// only as UNKNOWN_TRANSIENT, never as arbitrary external text.
export function classifyFailure(err) {
  if (err instanceof SyntaxError) return {permanent: true, code: 'BAD_ENVELOPE'};
  const m = typeof err?.message === 'string' ? err.message : '';
  if (PERMANENT.has(m)) return {permanent: true, code: m};
  return {permanent: false, code: m === 'DELIVERY_TIMEOUT' ? m : 'UNKNOWN_TRANSIENT'};
}

const intOpt = (v, name, min, max) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw Error(`INVALID_${name}`);
  return n;
};

export const DEFAULTS = {
  leaseMs: 120000,          // claim lease for idempotent delivery only (not a task write lock)
  deliveryTimeoutMs: 60000, // bounded receive timeout; must be < leaseMs
  baseBackoffMs: 2000,      // exponential backoff base for transient failures
  maxBackoffMs: 3600000,
  maxAttempts: 16,          // transient retries before needs_review (bounded, no infinite loop)
  pumpIntervalMs: 3000,     // auto pump cadence; 0 disables auto pump (manual only)
  batchSize: 8,             // bounded serial pump: at most this many deliveries per pass
};

export class DurableInbox {
  constructor(opts = {}) {
    const o = {...DEFAULTS, ...opts};
    if (typeof o.file !== 'string' || !o.file) throw Error('INBOX_FILE_REQUIRED');
    if (typeof o.namespace !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(o.namespace)) throw Error('INBOX_NAMESPACE_REQUIRED');
    if (typeof o.getService !== 'function') throw Error('INBOX_SERVICE_PROVIDER_REQUIRED');
    if (typeof (o.now ?? Date.now) !== 'function') throw Error('INVALID_CLOCK');
    this.namespace = o.namespace;
    this.getService = o.getService;
    this.now = o.now ?? Date.now; // injectable clock for deterministic tests
    // Bounded, finite, positive-integer option validation.
    o.leaseMs = intOpt(o.leaseMs, 'LEASE_MS', 1000, 86400000);
    o.deliveryTimeoutMs = intOpt(o.deliveryTimeoutMs, 'DELIVERY_TIMEOUT_MS', 1, o.leaseMs - 1); // timeout < lease
    o.baseBackoffMs = intOpt(o.baseBackoffMs, 'BASE_BACKOFF_MS', 0, 86400000);
    o.maxBackoffMs = intOpt(o.maxBackoffMs, 'MAX_BACKOFF_MS', 1, 86400000);
    o.maxAttempts = intOpt(o.maxAttempts, 'MAX_ATTEMPTS', 1, 100);
    o.pumpIntervalMs = intOpt(o.pumpIntervalMs, 'PUMP_INTERVAL_MS', 0, 86400000); // 0 = manual only
    o.batchSize = intOpt(o.batchSize, 'BATCH_SIZE', 1, 1000);
    this.o = o;
    this.closed = false;
    this.closePromise = null;
    this.inflight = Promise.resolve();
    this.pumping = false;
    this.timer = null;
    mkdirSync(dirname(o.file), {recursive: true, mode: 0o700});
    // Refuse to open through symlinks or non-file entries (db, -wal, -shm).
    for (const p of [o.file, o.file + '-wal', o.file + '-shm']) {
      let st; try { st = lstatSync(p); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (st) {
        if (st.isSymbolicLink() || !st.isFile()) throw Error('INBOX_FILE_UNSAFE');
      }
    }
    const fd = openSync(o.file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try { fchmodSync(fd, 0o600); } finally { closeSync(fd); }
    this.db = new DatabaseSync(o.file);
    this.harden(); // tighten file mode before any content is written
    // Unique key = (namespace, msg_id): one app ID per namespace, and a repeat
    // msgId with different content is a conflict, identical content a no-op.
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
     CREATE TABLE IF NOT EXISTS inbox(
      namespace TEXT NOT NULL, msg_id TEXT NOT NULL,
      message TEXT NOT NULL, fingerprint TEXT NOT NULL,
      status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT, next_attempt_at INTEGER NOT NULL DEFAULT 0,
      claim_token TEXT, lease_until INTEGER, updated_at INTEGER NOT NULL,
      PRIMARY KEY(namespace,msg_id));
     CREATE INDEX IF NOT EXISTS inbox_due ON inbox(status,next_attempt_at);`);
    this.harden(); // WAL/SHM created by the pragma run get the same mode
    if (o.pumpIntervalMs) this.schedule();
  }

  harden() {
    for (const p of [this.o.file, this.o.file + '-wal', this.o.file + '-shm']) {
      if (existsSync(p) && lstatSync(p).isFile()) chmodSync(p, 0o600);
    }
  }

  // ── enqueue: persists first; returns only after durable put. ────────────
  // Throws on any storage/validation failure — never reports success without
  // persistence. INSERT ... ON CONFLICT makes concurrent puts race-safe: a
  // legitimate duplicate is a no-op, not a failure.
  put(message) {
    if (this.closed) throw Error('INBOX_CLOSED');
    const norm = normalizeMessage(message);
    const fp = fingerprintOf(norm);
    const res = this.db.prepare(
      'INSERT INTO inbox(namespace,msg_id,message,fingerprint,status,next_attempt_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(namespace,msg_id) DO NOTHING'
    ).run(this.namespace, norm.msgId, JSON.stringify(norm), fp, 'queued', this.now(), this.now());
    if (res.changes === 1) return {id: `${this.namespace}:${norm.msgId}`, status: 'queued', duplicate: false};
    const row = this.db.prepare('SELECT fingerprint,status FROM inbox WHERE namespace=? AND msg_id=?').get(this.namespace, norm.msgId);
    if (row.fingerprint !== fp) throw Error('INGRESS_ID_CONFLICT'); // same ID, different content
    return {id: `${this.namespace}:${norm.msgId}`, status: row.status, duplicate: true}; // same content: no re-enqueue
  }

  // ── claim/recover via CAS; a fresh instance must not steal active leases. ─
  claimNext() {
    if (this.closed) return null;
    const now = this.now();
    const token = randomUUID();
    // Only unclaimed rows or leases that expired (crash between receive and
    // mark) are claimable. Active leases stay with their current owner.
    const row = this.db.prepare(
      "SELECT msg_id,message,attempts FROM inbox WHERE namespace=? AND ((status='queued' AND next_attempt_at<=?) OR (status='processing' AND lease_until IS NOT NULL AND lease_until<=?)) ORDER BY next_attempt_at LIMIT 1"
    ).get(this.namespace, now, now);
    if (!row) return null;
    const res = this.db.prepare(
      "UPDATE inbox SET status='processing',claim_token=?,lease_until=?,updated_at=? WHERE namespace=? AND msg_id=? AND ((status='queued' AND next_attempt_at<=?) OR (status='processing' AND lease_until IS NOT NULL AND lease_until<=?))"
    ).run(token, now + this.o.leaseMs, now, this.namespace, row.msg_id, now, now);
    if (res.changes !== 1) return null; // lost the CAS race
    return {id: `${this.namespace}:${row.msg_id}`, token, message: JSON.parse(row.message), attempts: row.attempts};
  }

  // Bounded receive: a wedged service can never hang the pump or close().
  withTimeout(p) {
    const ms = this.o.deliveryTimeoutMs;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('DELIVERY_TIMEOUT')), ms);
    });
    return Promise.race([Promise.resolve(p), timeout]).finally(() => clearTimeout(timer));
  }

  // ── delivery of one claimed row ─────────────────────────────────────────
  async deliverOne() {
    if (this.closed) return false;
    const claim = this.claimNext();
    if (!claim) return false;
    let service;
    try { service = this.getService(); } catch { service = null; }
    if (!service?.receive) {
      this.release(claim, 'queued', 'INGRESS_UNAVAILABLE', 0); // wait; do not burn attempts on an absent service
      return false;
    }
    let err = null;
    try { await this.withTimeout(service.receive(claim.message)); }
    catch (e) { err = e; }
    // close() awaits this pass before closing SQLite. A settled delivery may
    // finish its CAS during graceful shutdown; a timeout's late result has no DB callback.
    if (!err) {
      // CAS on the claim token: an expired/overtaken lease must not be ACKed
      // by a late result. changes===0 means a new owner now owns the outcome.
      const done = this.db.prepare("UPDATE inbox SET status='done',claim_token=NULL,lease_until=NULL,last_error=NULL,updated_at=? WHERE namespace=? AND msg_id=? AND claim_token=?").run(this.now(), this.namespace, claim.message.msgId, claim.token);
      return done.changes === 1;
    }
    const {permanent, code} = classifyFailure(err);
    const stored = code; // never arbitrary message text
    if (permanent) {
      this.db.prepare("UPDATE inbox SET status='needs_review',claim_token=NULL,lease_until=NULL,last_error=?,updated_at=? WHERE namespace=? AND msg_id=? AND claim_token=?").run(stored, this.now(), this.namespace, claim.message.msgId, claim.token);
    } else {
      const attempts = claim.attempts + 1;
      const backoff = Math.min(this.o.baseBackoffMs * 2 ** Math.min(attempts, 30), this.o.maxBackoffMs);
      if (attempts >= this.o.maxAttempts) {
        this.db.prepare("UPDATE inbox SET status='needs_review',attempts=?,claim_token=NULL,lease_until=NULL,last_error=?,updated_at=? WHERE namespace=? AND msg_id=? AND claim_token=?").run(attempts, stored, this.now(), this.namespace, claim.message.msgId, claim.token);
      } else {
        this.db.prepare("UPDATE inbox SET status='queued',attempts=?,next_attempt_at=?,claim_token=NULL,lease_until=NULL,last_error=?,updated_at=? WHERE namespace=? AND msg_id=? AND claim_token=?").run(attempts, this.now() + backoff, stored, this.now(), this.namespace, claim.message.msgId, claim.token);
      }
    }
    return true; // failure recorded; keep pumping other rows
  }

  release(claim, status, lastError, backoffMs) {
    this.db.prepare("UPDATE inbox SET status=?,next_attempt_at=?,last_error=?,claim_token=NULL,lease_until=NULL,updated_at=? WHERE namespace=? AND msg_id=? AND claim_token=?")
      .run(status, this.now() + backoffMs, lastError, this.now(), this.namespace, claim.message.msgId, claim.token);
  }

  // ── serial bounded pump ─────────────────────────────────────────────────
  // Single-flight: re-entrant pump calls fold into the running pass.
  async pump() {
    if (this.closed) return;
    if (this.pumping) return this.inflight;
    this.pumping = true;
    this.inflight = (async () => {
      try {
        for (let i = 0; i < this.o.batchSize && !this.closed; i++) {
          const progressed = await this.deliverOne();
          if (!progressed) break;
        }
      } finally { this.pumping = false; }
    })();
    return this.inflight;
  }

  schedule() {
    if (this.closed || !this.o.pumpIntervalMs) return;
    this.timer = setTimeout(async () => {
      this.timer = null;
      try { await this.pump(); } catch { /* pump errors are recorded per-row */ }
      if (!this.closed) this.schedule();
    }, this.o.pumpIntervalMs);
    if (this.timer.unref) this.timer.unref(); // do not hold the process alive
  }

  // ── summaries and restricted data-layer ops ────────────────────────────
  // Safe for channel.status: no message content, no replay methods; after
  // close it reports closed instead of throwing.
  summary() {
    if (this.closed) return {namespace: this.namespace, closed: true};
    return {namespace: this.namespace, counts: this.counts()};
  }

  counts() {
    const rows = this.db.prepare('SELECT status,COUNT(*) AS n FROM inbox WHERE namespace=? GROUP BY status').all(this.namespace);
    const out = {};
    for (const r of rows) out[r.status] = r.n;
    for (const s of ['queued', 'processing', 'done', 'needs_review']) out[s] = out[s] ?? 0;
    return out;
  }

  // Restricted data-layer op; not exposed to ordinary models or the network.
  stats() {
    if (this.closed) throw Error('INBOX_CLOSED');
    return {namespace: this.namespace, counts: this.counts()};
  }

  // Accepts the raw msgId only (never a namespace-prefixed composite, so a
  // foreign namespace cannot be reached by collision).
  retryFailed(msgId) {
    if (this.closed) throw Error('INBOX_CLOSED');
    const id = String(msgId ?? '');
    const res = this.db.prepare(
      "UPDATE inbox SET status='queued',attempts=0,next_attempt_at=?,claim_token=NULL,lease_until=NULL,updated_at=? WHERE namespace=? AND msg_id=? AND status='needs_review'"
    ).run(this.now(), this.now(), this.namespace, id);
    if (res.changes !== 1) throw Error('RETRY_TARGET_NOT_FOUND');
    return {id: `${this.namespace}:${id}`, status: 'queued'};
  }

  // ── shutdown: stop timers, await inflight delivery, close DB; repeat-safe ─
  // All close() calls observe the same closePromise; the DB is closed in a
  // finally so cleanup happens even if the inflight pass rejects.
  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      try { await this.inflight; }
      finally { this.db.close(); }
    })();
    return this.closePromise;
  }
}

export function openDurableInbox(opts) { return new DurableInbox(opts); }
