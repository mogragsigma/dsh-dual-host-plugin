import test from 'node:test';import assert from 'node:assert/strict';
import {fixture} from './delivery-recovery-fixture.mjs';
import {digest} from '../bundle/approval-ledger.js';
import {classifyDelivery} from '../bundle/delivery-recovery.js';
test('inspection is read-only and unchanged drained action can settle without retry authorization',t=>{
 const f=fixture(t),db=f.store.db,n=db.prepare('SELECT count(*) n FROM delivery_events').get().n;
 const v=f.inspect();assert.equal(v.evidence.classification,'no_effect');assert.deepEqual(v.evidence.allowed,['settle_not_applied']);assert.equal(v.evidence.grants_execution,false);
 assert.equal(db.prepare('SELECT count(*) n FROM delivery_events').get().n,n);assert.equal(db.prepare('SELECT count(*) n FROM delivery_recoveries').get().n,0);
 const result=f.apply('settle_not_applied');assert.equal(result.action.state,'not_applied');assert.equal(result.retry_authorized,false);assert.equal(f.store.task(f.action.task_id).busy,0);assert.equal(f.state.gitCalls,0);
});
test('owned lock cleanup is distinct from releasing task; fresh evidence required to settle',t=>{
 const f=fixture(t,{locks:true}),before=f.inspect();assert.deepEqual(before.evidence.allowed,['clean_owned_locks']);assert.equal(f.apply('clean_owned_locks','cleanup').released_task,false);assert.equal(f.releaseCount(),1);assert.equal(f.store.task(f.action.task_id).busy,1);
 assert.throws(()=>f.recovery.apply({id:f.action.id,epoch:f.action.epoch,event_id:'old-proof',decision:'settle_not_applied',evidence_fingerprint:before.fingerprint}),/STALE_EVIDENCE/);
 assert.equal(f.apply('settle_not_applied','settle').action.state,'not_applied');assert.equal(f.state.gitCalls,0);
});
for(const [phase,classification] of [['objects','objects_present_no_commit'],['reference','reference_applied_index_pending'],['complete','commit_complete'],['index','index_without_reference']])test('partial state '+phase+' is classified without repairing or rolling back',t=>{
 const f=fixture(t);f.phase(phase);const v=f.inspect();assert.equal(v.evidence.classification,classification);assert.equal(f.state.gitCalls,0);assert.equal(f.releaseCount(),0);
 if(phase==='complete')assert.equal(f.apply('settle_completed').action.state,'completed');
 else{assert.deepEqual(v.evidence.allowed,[]);assert.throws(()=>f.apply('settle_not_applied'),/DECISION_DENIED/);assert.throws(()=>f.apply('settle_completed'),/DECISION_DENIED/);assert.equal(f.store.task(f.action.task_id).busy,1);}
});
test('complete reference/index with owned locks requires cleanup and a second fresh readback',t=>{
 const f=fixture(t,{locks:true});f.phase('complete');assert.deepEqual(f.inspect().evidence.allowed,['clean_owned_locks']);f.apply('clean_owned_locks');assert.equal(f.store.task(f.action.task_id).busy,1);assert.equal(f.apply('settle_completed','finish').action.state,'completed');assert.equal(f.state.gitCalls,0);
});
test('objects-only cleanup does not label partial object writes as no effect',t=>{
 const f=fixture(t,{locks:true});f.phase('objects');assert.equal(f.apply('clean_owned_locks').released_task,false);assert.equal(f.inspect().evidence.classification,'objects_present_no_commit');assert.deepEqual(f.inspect().evidence.allowed,[]);assert.equal(f.store.task(f.action.task_id).busy,1);
});
for(const missing of ['external','operation'])test('unknown drain '+missing+' refuses file access, process probing and cleanup',t=>{
 const f=fixture(t,{locks:true});if(missing==='external')f.quiescent(false);else f.store.db.prepare("INSERT INTO delivery_operations(id,action_id,epoch,kind,state,pid,started,detail) VALUES ('unknown',?,?,'object','spawned',9999999,0,'{}')").run(f.action.id,f.action.epoch);
 f.set.scan=()=>{throw Error('should not read files');};assert.equal(f.inspect().evidence.classification,'drain_unknown');assert.throws(()=>f.apply('clean_owned_locks'),/DECISION_DENIED/);assert.equal(f.releaseCount(),0);assert.equal(f.store.task(f.action.task_id).busy,1);
});
test('unknown metadata or foreign lock stays fenced and hides raw errors',t=>{
 const f=fixture(t,{locks:true});f.set.scan=()=>{throw Error('secret path not to disclose');};const v=f.inspect();assert.equal(v.evidence.classification,'evidence_unknown');assert.equal(v.evidence.error,'DELIVERY_RECOVERY_EVIDENCE_UNKNOWN');assert(!JSON.stringify(v).includes('secret path'));assert.throws(()=>f.apply('clean_owned_locks'),/DECISION_DENIED/);
});
test('replay never re-executes cleanup; same event different intent conflicts',t=>{
 const f=fixture(t,{locks:true}),a={id:f.action.id,epoch:f.action.epoch,event_id:'once',decision:'clean_owned_locks',evidence_fingerprint:f.inspect().fingerprint};f.recovery.apply(a);const replay=f.recovery.apply(a);assert.equal(replay.replayed,true);assert.equal(replay.checked_now,false);assert.equal(f.releaseCount(),1);assert.throws(()=>f.recovery.apply({...a,decision:'settle_completed'}),/EVENT_CONFLICT/);
});
test('synchronous partial cleanup failure remains review; no automatic second unlink',t=>{
 const f=fixture(t,{locks:true});f.throwAfter(true);const a={id:f.action.id,epoch:f.action.epoch,event_id:'partial',decision:'clean_owned_locks',evidence_fingerprint:f.inspect().fingerprint};assert.equal(f.recovery.apply(a).state,'needs_review');assert.equal(f.j.unfinished(f.action.id),false);assert.equal(f.store.task(f.action.task_id).busy,1);assert.equal(f.recovery.apply(a).replayed,true);assert.equal(f.releaseCount(),1);
});
test('async cleanup substitute cannot be falsely recorded as drained',t=>{
 const f=fixture(t,{locks:true});f.set.release=()=>Promise.resolve();assert.equal(f.apply('clean_owned_locks').state,'needs_review');assert.equal(f.j.unfinished(f.action.id),true);assert.equal(f.inspect().evidence.classification,'drain_unknown');
});
test('changed owner, task revision, index record or lock epoch cannot be reconciled',t=>{
 const f=fixture(t);f.store.db.prepare("UPDATE tasks SET owner='local' WHERE id=?").run(f.action.task_id);assert.throws(f.inspect,/STALE_FENCE/);f.store.db.prepare("UPDATE tasks SET owner='cloud',revision=revision+1 WHERE id=?").run(f.action.task_id);assert.throws(f.inspect,/TASK_REVISION_CHANGED/);
 const g=fixture(t);g.j.event(g.action.id,'lock_owned',{epoch:g.action.epoch+1,name:'config.lock',identity:{device:'1',inode:'2'}});assert.throws(g.inspect,/LOCK_EPOCH_CHANGED/);
 const h=fixture(t);h.j.event(h.action.id,'index_planned',{epoch:h.action.epoch});assert.throws(h.inspect,/INDEX_RECORD_INVALID/);
});
test('readback changes after review cannot release task or mark complete',t=>{
 const f=fixture(t);f.phase('complete');f.j.observe=()=>{throw Error('changed');};const r=f.apply('settle_completed');assert.equal(r.state,'needs_review');assert.equal(r.released_task,false);assert.equal(f.store.task(f.action.task_id).busy,1);
});
test('configuration, ref disagreement, unknown object and checksum conflicts are not success',t=>{
 const f=fixture(t),i=f.intent,b=f.before;const mutate=fn=>{const s=structuredClone(b);fn(s);const {fingerprint,...body}=s;return {...body,fingerprint:digest(body)};};
 for(const [fn,code] of [[s=>s.metadata.config_sha256='f'.repeat(64),'metadata_conflict'],[s=>s.ref_oid='f'.repeat(40),'reference_conflict'],[s=>s.metadata.index_sha256='f'.repeat(64),'state_conflict']])assert.equal(classifyDelivery(i,b,mutate(fn)),code);
 assert.throws(()=>classifyDelivery(i,b,mutate(s=>s.objects_present=['f'.repeat(40)])),/SNAPSHOT_INVALID/);assert.throws(()=>classifyDelivery(i,b,{...b,fingerprint:'bad'}),/SNAPSHOT_INVALID/);
});
test('disabled recovery and arbitrary repair/reset methods are rejected',t=>{
 const f=fixture(t,{enabled:false});assert.throws(f.inspect,/DISABLED/);assert.throws(()=>f.apply('settle_completed'),/DISABLED/);
 const g=fixture(t);for(const decision of ['reset','resume','repair_index','delete_objects','force_unlock'])assert.throws(()=>g.recovery.apply({id:g.action.id,epoch:g.action.epoch,event_id:'no',decision,evidence_fingerprint:g.inspect().fingerprint}),/INVALID_REQUEST/);
});
test('revocation permits fact reconciliation but grants no further commit or retry',t=>{
 const f=fixture(t,{locks:true});f.phase('complete');f.state.authorized=false;assert.equal(f.apply('clean_owned_locks').released_task,false);const r=f.apply('settle_completed','fact-only');assert.equal(r.action.state,'completed');assert.equal(r.retry_authorized,false);assert.equal(f.state.gitCalls,0);
});
test('interrupted recovery intent replays as uncertainty, never another cleanup',t=>{
 const f=fixture(t,{locks:true}),a={id:f.action.id,epoch:f.action.epoch,event_id:'interrupted',decision:'clean_owned_locks',evidence_fingerprint:f.inspect().fingerprint};
 f.store.db.prepare("INSERT INTO delivery_recoveries VALUES (?,?,?,?,?,?,'intent',?,NULL)").run(a.event_id,digest(a),a.id,a.epoch,a.decision,a.evidence_fingerprint,0);
 const r=f.recovery.apply(a);assert.equal(r.state,'needs_review');assert.equal(r.replayed,true);assert.equal(r.checked_now,false);assert.equal(f.releaseCount(),0);assert.equal(f.store.task(f.action.task_id).busy,1);
});
test('external drain loss before cleanup records failure without task release',t=>{
 const f=fixture(t,{locks:true}),release=f.set.release;f.set.release=(...args)=>{f.quiescent(false);return release(...args);};const r=f.apply('clean_owned_locks');assert.equal(r.state,'needs_review');assert(f.locks().every(x=>x.state==='owned'));assert.equal(f.store.task(f.action.task_id).busy,1);
});
test('ownership evidence changing during readback invalidates the review',t=>{
 const f=fixture(t);f.recovery.makeReader=()=>({capture:i=>{f.j.event(f.action.id,'index_planned',{epoch:f.action.epoch});return f.reader.capture(i);}});const v=f.inspect();assert.equal(v.evidence.classification,'evidence_unknown');assert.deepEqual(v.evidence.allowed,[]);
});
