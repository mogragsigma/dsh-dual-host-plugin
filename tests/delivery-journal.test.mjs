import {baseline} from './delivery-fixture.mjs';
// All authorization/readback/workspace evidence below is synthetic. No Git writes or real approval.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Coordinator} from '../bundle/store.js';
import {DeliveryJournal} from '../bundle/delivery-journal.js';
import {DevelopmentGate} from '../bundle/development-gate.js';
import {compileCommit} from '../bundle/delivery-object-plan.js';
import {digest,canonical} from '../bundle/approval-ledger.js';
import {createHash} from 'node:crypto';
const bytes=Buffer.from('synthetic'),sha=createHash('sha256').update(bytes).digest('hex'),resource='https://gitee.com/test-fixture/example';
const compiled=()=>compileCommit({parent:'1'.repeat(40),branch:'dsh-task/test',baseline:[],files:[{path:'a',bytes,mode:0o644}],changes:[{path:'a',action:'create',before_sha256:null,after_sha256:sha}],
 tested_content:{kind:'file_sha256',sha256:sha},author:{name:'Test',email:'test@example.invalid'},committer:{name:'Test',email:'test@example.invalid'},when:1000,message:'no actual commit'});
const identity=()=>({root:'/nonexistent/synthetic-only',directory:{device:'1',inode:'2'},git_directory:{device:'1',inode:'3'},url:resource,branch:'dsh-task/test',base_sha:'1'.repeat(40)});
function fixture(t,options={}){
 const root=mkdtempSync(join(tmpdir(),'delivery-journal-')),store=new Coordinator(root);t.after(()=>{try{store.db.close();}catch{}rmSync(root,{recursive:true,force:true});});
 const control={owner:true,authority:'c'.repeat(64),authorized:true,ready:true,proof:true,observeCalls:0};
 const adapters={enabled:true,exclusive:()=>control.owner,
  authorize:({approval_id,intent})=>control.authorized?{kind:'delivery-execution-v1',scope:'commit',execution:true,approval_id,task_id:intent.task_id,task_revision:intent.task_revision,intent_fingerprint:intent.fingerprint,authority_hash:control.authority}:null,
  preflight:intent=>control.ready?{intent_fingerprint:intent.fingerprint,drained:true,manifest_sha256:intent.plan.manifest_sha256,workspace_identity:intent.workspace_identity,branch:intent.plan.branch,parent:intent.plan.parent,baseline:baseline(intent)}:null,
  observe:intent=>{control.observeCalls++;return control.proof?{kind:'commit-readback-v1',intent_fingerprint:intent.fingerprint,drained:true,object_exists:true,head_oid:intent.plan.computed_commit_oid,ref_oid:intent.plan.computed_commit_oid,commit_oid:intent.plan.computed_commit_oid,tree_oid:intent.plan.tree_oid,index_tree_oid:intent.plan.tree_oid,branch:intent.plan.branch,parent:intent.plan.parent,manifest_sha256:intent.plan.manifest_sha256,workspace_identity:intent.workspace_identity}:null;}};
 const journal=new DeliveryJournal({store,...adapters,...options});let n=0;
 const request=()=>{n++;const task=store.accept('cloud',{task_key:'fixture-'+n,ingress_id:'ingress-'+n,source:'unit'});return {task_id:task.id,resource,workspace_identity:identity(),...compiled(),event_id:'delivery-event-'+n,approval_id:'synthetic-approval-'+n};};
 return {root,store,control,adapters,journal,request};
}
const admitted=x=>{const q=x.journal.enqueue(x.request()),a=x.journal.acquire(q.id);assert.equal(a.acquired,true);return a;};
test('disabled and missing trusted adapters fail closed',t=>{
 const x=fixture(t,{enabled:false});assert.throws(()=>x.journal.enqueue(x.request()),/DISABLED/);
 const j=new DeliveryJournal({store:x.store,enabled:true});assert.throws(()=>j.enqueue(x.request()),/ADAPTER_REQUIRED/);
});
test('prepare is read-only, computed intent is not execution authority',t=>{
 const x=fixture(t),p=x.journal.prepare(x.request());assert.equal(p.plan.persisted,false);assert.equal(p.plan.grants_execution,false);assert.equal(x.store.db.prepare('SELECT count(*) n FROM delivery_actions').get().n,0);
});
for(const evidence of ['preview','wrong-scope','mismatched-intent','async'])test('denies '+evidence+' approval',t=>{
 const x=fixture(t),adapter=x.journal.authorize;x.journal.authorize=req=>{const a=adapter(req);if(evidence==='preview')a.kind='commit-preview-v1';if(evidence==='wrong-scope')a.scope='push';if(evidence==='mismatched-intent')a.intent_fingerprint='0'.repeat(64);return evidence==='async'?Promise.resolve(a):a;};
 assert.throws(()=>x.journal.enqueue(x.request()),/APPROVAL_REQUIRED|ASYNC_ADAPTER_DENIED/);assert.equal(x.store.db.prepare('SELECT count(*) n FROM delivery_actions').get().n,0);
});
test('event replay returns same action; differing approval or content conflicts',t=>{
 const x=fixture(t),r=x.request(),a=x.journal.enqueue(r);assert.equal(x.journal.enqueue(r).id,a.id);
 assert.throws(()=>x.journal.enqueue({...r,approval_id:'another'}),/EVENT_CONFLICT/);
 const c=compiled();c.plan.message='changed\n';const {fingerprint,...b}=c.plan;c.plan.fingerprint=digest(b);
 assert.throws(()=>x.journal.enqueue({...r,...c}),/PLAN_CHANGED/);
});
test('workspace identity must match canonical repository, branch and parent',t=>{
 const x=fixture(t),r=x.request();assert.throws(()=>x.journal.enqueue({...r,workspace_identity:{...r.workspace_identity,branch:'main'}}),/WORKSPACE_BINDING/);
 assert.throws(()=>x.journal.enqueue({...r,resource:resource+'.git'}),/RESOURCE/);
});
test('owner and preflight required; no task acquisition on failed check',t=>{
 const x=fixture(t),r=x.request(),q=x.journal.enqueue(r);x.control.owner=false;assert.throws(()=>x.journal.acquire(q.id),/EXCLUSIVE_OWNER_REQUIRED/);
 x.control.owner=true;x.control.ready=false;assert.throws(()=>x.journal.acquire(q.id),/PREFLIGHT_REQUIRED/);assert.equal(x.store.task(r.task_id).busy,0);assert.equal(x.journal.view(q.id).state,'queued');
});
test('task revision and changed authority invalidate acquire',t=>{
 const x=fixture(t),r=x.request(),q=x.journal.enqueue(r);x.store.db.prepare('UPDATE tasks SET revision=revision+1 WHERE id=?').run(r.task_id);assert.throws(()=>x.journal.acquire(q.id),/TASK_REVISION_CHANGED/);
 const r2=x.request(),q2=x.journal.enqueue(r2);x.control.authority='b'.repeat(64);assert.throws(()=>x.journal.acquire(q2.id),/APPROVAL_CHANGED/);
});
test('dispatch is durable once only; fresh permission and content required',t=>{
 const x=fixture(t),a=admitted(x);x.control.authorized=false;assert.throws(()=>x.journal.markDispatched(a.id,a.epoch),/APPROVAL_REQUIRED/);assert.equal(x.journal.view(a.id).dispatched,false);
 x.control.authorized=true;x.control.ready=false;assert.throws(()=>x.journal.markDispatched(a.id,a.epoch),/PREFLIGHT_REQUIRED/);x.control.ready=true;
 x.journal.markDispatched(a.id,a.epoch);assert.equal(x.journal.view(a.id).dispatched,true);assert.throws(()=>x.journal.markDispatched(a.id,a.epoch),/ALREADY_DISPATCHED/);
});
test('readback-only completion is distinct from remote acceptance; replay does not observe twice',t=>{
 const x=fixture(t),a=admitted(x);assert.throws(()=>x.journal.finish(a.id,a.epoch),/NOT_DISPATCHED/);x.journal.markDispatched(a.id,a.epoch);
 x.control.authorized=false; // A subsequent revocation cannot erase a real effect; only observe, never dispatch again.
 const r=x.journal.finish(a.id,a.epoch);assert.equal(r.state,'completed');assert.equal(r.result.remote_acceptance,'not_observed');assert.equal(x.store.task(a.task_id).busy,0);
 assert.equal(x.journal.finish(a.id,a.epoch).replayed,true);assert.equal(x.control.observeCalls,1);
});
test('caller supplied success is ignored; unknown readback retains resource and fence',t=>{
 const x=fixture(t),a=admitted(x);x.journal.markDispatched(a.id,a.epoch);x.control.proof=false;
 const r=x.journal.finish(a.id,a.epoch,{approved:true,success:true});assert.equal(r.state,'needs_review');assert.equal(x.store.task(a.task_id).busy,1);
 const q=x.journal.enqueue(x.request());assert.equal(x.journal.waiting(q.id),'delivery_resource_review');assert.throws(()=>x.journal.markDispatched(a.id,a.epoch),/STALE_FENCE/);
 x.control.proof=true;assert.equal(x.journal.finish(a.id,a.epoch).state,'completed');assert.equal(x.journal.waiting(q.id),null);
});
for(const field of ['commit_oid','head_oid','ref_oid','object_exists','tree_oid','index_tree_oid','manifest_sha256','workspace_identity','drained'])test('readback rejects mismatched '+field,t=>{
 const x=fixture(t),a=admitted(x),observe=x.journal.observe;x.journal.observe=i=>({...observe(i),[field]:field==='drained'?false:'mismatch'});
 x.journal.markDispatched(a.id,a.epoch);assert.equal(x.journal.finish(a.id,a.epoch).state,'needs_review');assert.equal(x.store.task(a.task_id).busy,1);
});
test('observer throws without leaking error text, holds unknown state',t=>{
 const x=fixture(t),a=admitted(x);x.journal.markDispatched(a.id,a.epoch);x.journal.observe=()=>{throw Error('credential-text-not-to-log');};
 assert.equal(x.journal.finish(a.id,a.epoch).error,'READBACK_UNKNOWN');assert.ok(!JSON.stringify(x.store.db.prepare('SELECT * FROM delivery_events').all()).includes('credential-text'));
});
test('stale epoch and foreign task owner cannot dispatch or release',t=>{
 const x=fixture(t),a=admitted(x);assert.throws(()=>x.journal.markDispatched(a.id,a.epoch+1),/STALE_FENCE/);
 x.store.db.prepare("UPDATE tasks SET owner='local',epoch=epoch+1 WHERE id=?").run(a.task_id);
 assert.throws(()=>x.journal.markDispatched(a.id,a.epoch),/STALE_FENCE/);assert.throws(()=>x.journal.finish(a.id,a.epoch),/STALE_FENCE/);assert.equal(x.store.task(a.task_id).busy,1);
});
test('recovery without exclusive owner is denied; active before-dispatch never auto-requeues',t=>{
 const x=fixture(t),a=admitted(x);x.control.owner=false;assert.throws(()=>x.journal.recover(),/EXCLUSIVE_OWNER_REQUIRED/);x.control.owner=true;
 assert.deepEqual(x.journal.recover(),{needs_review:[a.id],retried:0});assert.equal(x.journal.view(a.id).dispatched,false);assert.equal(x.store.task(a.task_id).busy,1);assert.deepEqual(x.journal.recover(),{needs_review:[],retried:0});
});
test('real child exit after durable dispatch recovers same row without replay or Git effects',t=>{
 const x=fixture(t),a=admitted(x);x.store.db.close();
 const child=spawnSync(process.execPath,[fileURLToPath(new URL('./delivery-journal-crash-child.mjs',import.meta.url)),x.root,a.id,String(a.epoch)],{encoding:'utf8',timeout:10000,env:{PATH:'/usr/bin:/bin'}});assert.equal(child.status,29,child.stderr);
 const store=new Coordinator(x.root);t.after(()=>store.db.close());const j=new DeliveryJournal({store,...x.adapters});assert.equal(j.view(a.id).dispatched,true);
 assert.deepEqual(j.recover(),{needs_review:[a.id],retried:0});assert.equal(store.task(a.task_id).busy,1);assert.equal(store.db.prepare("SELECT count(*) n FROM delivery_events WHERE type='dispatched'").get().n,1);
});
test('cancellation only queued; active and unknown cannot release via cancel',t=>{
 const x=fixture(t),q=x.journal.enqueue(x.request());assert.equal(x.journal.cancelQueued(q.id,'user_cancelled').state,'cancelled');
 const a=admitted(x);assert.throws(()=>x.journal.cancelQueued(a.id,'user_cancelled'),/NOT_QUEUED/);x.journal.markUnknown(a.id,a.epoch);assert.throws(()=>x.journal.cancelQueued(a.id,'superseded'),/NOT_QUEUED/);
});
function development(x){
 const gate=new DevelopmentGate({store:x.store,ledger:{}});let n=0;
 const enqueue=(state='queued')=>{n++;const r=x.request(),id='dev-'+n;
  x.store.db.prepare('INSERT INTO development_requests(id,task_id,resource,state,created) VALUES (?,?,?,?,?)').run(id,r.task_id,resource,state,0);return id;};
 return {gate,enqueue};
}
test('development still operates without journal table; no forced dependency',t=>{
 const x=fixture(t);x.store.db.exec('DROP TABLE delivery_actions; DROP TABLE delivery_events;');const d=development(x),q=d.enqueue();assert.equal(d.gate.waiting(q),null);
});
test('cross-kind FIFO D1 -> C1 -> D2 -> C2 -> D3 without clock dependence',t=>{
 const x=fixture(t),d=development(x),d1=d.enqueue(),c1=x.journal.enqueue(x.request()),d2=d.enqueue(),c2=x.journal.enqueue(x.request()),d3=d.enqueue();
 assert.equal(d.gate.waiting(d1),null);assert.equal(x.journal.waiting(c1.id),'development_fifo');assert.equal(d.gate.waiting(d2),'delivery_fifo');
 x.store.db.prepare("UPDATE development_requests SET state='completed' WHERE id=?").run(d1);assert.equal(x.journal.waiting(c1.id),null);
 x.journal.cancelQueued(c1.id,'user_cancelled');assert.equal(d.gate.waiting(d2),null);assert.equal(x.journal.waiting(c2.id),'development_fifo');assert.equal(d.gate.waiting(d3),'delivery_fifo');
 x.store.db.prepare("UPDATE development_requests SET state='completed' WHERE id=?").run(d2);assert.equal(x.journal.waiting(c2.id),null);
 x.journal.cancelQueued(c2.id,'user_cancelled');assert.equal(d.gate.waiting(d3),null);
});
test('FIFO delivery first and development created after journal',t=>{
 const x=fixture(t),c=x.journal.enqueue(x.request()),d=development(x),q=d.enqueue();assert.equal(x.journal.waiting(c.id),null);assert.equal(d.gate.waiting(q),'delivery_fifo');
 const a=x.journal.acquire(c.id);assert.equal(d.gate.waiting(q),'delivery_resource_busy');x.journal.markUnknown(a.id,a.epoch);assert.equal(d.gate.waiting(q),'delivery_resource_review');
});
test('development active or unknown holds delivery even if task differs',t=>{
 const x=fixture(t),d=development(x),q=d.enqueue('active'),c=x.journal.enqueue(x.request());assert.equal(x.journal.waiting(c.id),'development_resource_busy');
 x.store.db.prepare("UPDATE development_requests SET state='needs_review' WHERE id=?").run(q);assert.equal(x.journal.waiting(c.id),'development_resource_review');
});
test('two journal instances share FIFO and durable acquisition; second cannot acquire same resource',t=>{
 const x=fixture(t),a=x.journal.enqueue(x.request()),b=x.journal.enqueue(x.request()),second=new DeliveryJournal({store:x.store,...x.adapters});
 assert.equal(second.acquire(b.id).reason,'delivery_fifo');assert.equal(x.journal.acquire(a.id).acquired,true);assert.equal(second.acquire(b.id).reason,'delivery_resource_busy');
});
test('stored intent corruption is rejected before dispatch or observation',t=>{
 const x=fixture(t),a=admitted(x),r=x.journal.row(a.id),i=JSON.parse(r.intent);i.plan.computed_commit_oid='f'.repeat(40);
 x.store.db.prepare('UPDATE delivery_actions SET intent=? WHERE id=?').run(canonical(i),a.id);
 assert.throws(()=>x.journal.markDispatched(a.id,a.epoch),/INTENT_CHANGED/);assert.equal(x.control.observeCalls,0);assert.equal(x.store.task(a.task_id).busy,1);
});
test('a different resource is independent; same task busy still blocks any delivery',t=>{
 const x=fixture(t),a=admitted(x),r=x.request(),other=resource+'-other';r.resource=other;r.workspace_identity.url=other;const q=x.journal.enqueue(r);assert.equal(x.journal.waiting(q.id),null);
 const same={...x.request(),task_id:a.task_id,resource:other,workspace_identity:{...identity(),url:other}};const b=x.journal.enqueue(same);assert.equal(x.journal.waiting(b.id),'task_busy');
});
test('fresh database connection sees durable owner and does not race same-resource admission',t=>{
 const x=fixture(t),a=x.journal.enqueue(x.request()),b=x.journal.enqueue(x.request()),secondStore=new Coordinator(x.root);t.after(()=>secondStore.db.close());
 const second=new DeliveryJournal({store:secondStore,...x.adapters});assert.equal(x.journal.acquire(a.id).acquired,true);assert.equal(second.acquire(b.id).reason,'delivery_resource_busy');
});
test('async or absent observer is not accepted as successful readback',t=>{
 const x=fixture(t),a=admitted(x);x.journal.markDispatched(a.id,a.epoch);x.journal.observe=()=>Promise.resolve({success:true});assert.equal(x.journal.finish(a.id,a.epoch).error,'READBACK_UNKNOWN');
});
test('actual DevelopmentGate acquisition uses cross-kind waiting, without invoking Git adapter',t=>{
 const x=fixture(t),c=x.journal.enqueue(x.request()),d=development(x),q=d.enqueue(),w={identity,check:()=>({hash:'f'.repeat(64)})};
 x.store.db.prepare("UPDATE development_requests SET policy='{}',authority_hash=?,workspace_identity=?,node='local' WHERE id=?").run('h',canonical(identity()),q);
 d.gate.authority=()=>({hash:'h',workspace:w,spec:{kind:'workspace-v1'}}); // private synthetic adapter, no actual approval.
 assert.equal(d.gate.acquire(q).reason,'delivery_fifo');x.journal.cancelQueued(c.id,'user_cancelled');assert.equal(d.gate.acquire(q).acquired,true);
});
test('unclosed development operation blocks even if its request says completed',t=>{
 const x=fixture(t),d=development(x),q=d.enqueue('completed'),c=x.journal.enqueue(x.request());
 x.store.db.prepare("INSERT INTO development_operations(id,request_id,epoch,kind,state,started) VALUES ('unknown-child',?,1,'test','spawned',0)").run(q);
 assert.equal(x.journal.waiting(c.id),'development_resource_draining');assert.equal(x.journal.acquire(c.id).acquired,false);
 x.store.db.prepare("UPDATE development_operations SET state='closed' WHERE id='unknown-child'").run();assert.equal(x.journal.waiting(c.id),null);
});
test('one execution approval cannot enqueue multiple events, even after cancellation',t=>{
 const x=fixture(t),r=x.request(),q=x.journal.enqueue(r);x.journal.cancelQueued(q.id,'user_cancelled');assert.throws(()=>x.journal.enqueue({...r,event_id:'new-event'}),/APPROVAL_ALREADY_USED/);
});
test('dispatch refuses a changed pre-acquisition snapshot',t=>{
 const x=fixture(t),a=admitted(x),old=x.journal.preflight;x.journal.preflight=i=>{const r=old(i),{fingerprint,...s}=r.baseline;s.metadata.index_sha256='9'.repeat(64);r.baseline={...s,fingerprint:digest(s)};return r;};
 assert.throws(()=>x.journal.markDispatched(a.id,a.epoch),/BEFORE_SNAPSHOT_CHANGED/);assert.equal(x.journal.view(a.id).dispatched,false);
});
test('trusted no-effect readback releases only reviewed action, keeps history and denies retry',t=>{
 const x=fixture(t),a=admitted(x);x.journal.markDispatched(a.id,a.epoch);assert.throws(()=>x.journal.settleUnapplied(a.id,a.epoch),/STALE_FENCE/);x.journal.markUnknown(a.id,a.epoch);
 assert.equal(x.journal.settleUnapplied(a.id,a.epoch,{unchanged:true}).state,'needs_review'); // no adapter, ignored caller proof.
 x.journal.observeUnapplied=(i,s)=>({kind:'commit-not-applied-v1',intent_fingerprint:i.fingerprint,baseline_fingerprint:s.fingerprint,drained:true,unchanged:true,object_presence_unchanged:true});
 const result=x.journal.settleUnapplied(a.id,a.epoch);assert.equal(result.state,'not_applied');assert.equal(result.result.retry_authorized,false);assert.equal(x.store.task(a.task_id).busy,0);
 assert.equal(x.journal.settleUnapplied(a.id,a.epoch).replayed,true);assert.equal(x.store.db.prepare("SELECT count(*) n FROM delivery_events WHERE type='dispatched'").get().n,1);assert.throws(()=>x.journal.acquire(a.id),/NOT_QUEUED/);
});
for(const field of ['drained','unchanged','object_presence_unchanged','baseline_fingerprint'])test('no-effect '+field+' mismatch keeps resource fenced',t=>{
 const x=fixture(t),a=admitted(x);x.journal.markUnknown(a.id,a.epoch);
 x.journal.observeUnapplied=(i,s)=>({...{kind:'commit-not-applied-v1',intent_fingerprint:i.fingerprint,baseline_fingerprint:s.fingerprint,drained:true,unchanged:true,object_presence_unchanged:true},[field]:false});
 assert.equal(x.journal.settleUnapplied(a.id,a.epoch).state,'needs_review');assert.equal(x.store.task(a.task_id).busy,1);
});
test('legacy active row with no before-snapshot cannot silently adopt current state',t=>{
 const x=fixture(t),a=admitted(x);x.journal.markUnknown(a.id,a.epoch);x.store.db.prepare('UPDATE delivery_actions SET before_snapshot=NULL WHERE id=?').run(a.id);assert.throws(()=>x.journal.settleUnapplied(a.id,a.epoch),/BEFORE_SNAPSHOT_REQUIRED/);assert.equal(x.store.task(a.task_id).busy,1);
});
test('legacy schema migration adds NULL baseline without adopting current repository state',t=>{
 const x=fixture(t),a=admitted(x);x.store.db.exec('ALTER TABLE delivery_actions DROP COLUMN before_snapshot');
 const j=new DeliveryJournal({store:x.store,...x.adapters});assert.equal(j.row(a.id).before_snapshot,null);j.recover();assert.throws(()=>j.settleUnapplied(a.id,a.epoch),/BEFORE_SNAPSHOT_REQUIRED/);assert.equal(x.store.task(a.task_id).busy,1);
});
test('duplicate historical execution approvals fail migration without deleting rows',t=>{
 const x=fixture(t),q=x.journal.enqueue(x.request()),r=x.journal.row(q.id);x.store.db.exec('DROP INDEX delivery_approval_once');
 x.store.db.prepare(`INSERT INTO delivery_actions(id,event_id,fingerprint,task_id,approval_id,authority_hash,resource,intent,development_cutoff,state,created)
  VALUES ('duplicate','duplicate',?,?,?,?,?,?,?,'queued',0)`).run(r.fingerprint,r.task_id,r.approval_id,r.authority_hash,r.resource,r.intent,r.development_cutoff);
 assert.throws(()=>new DeliveryJournal({store:x.store,...x.adapters}),/UNIQUE/);assert.equal(x.store.db.prepare('SELECT count(*) n FROM delivery_actions').get().n,2);
});
test('operation intent survives recovery and cannot be bypassed by successful observer',t=>{
 const x=fixture(t),a=admitted(x);x.journal.markDispatched(a.id,a.epoch);const op=x.journal.startOperation(a.id,a.epoch,'object',{oid:'synthetic'});x.journal.spawned(op,12345);
 x.journal.recover();assert.equal(x.journal.finish(a.id,a.epoch).error,'DRAIN_REQUIRED');assert.equal(x.journal.settleUnapplied(a.id,a.epoch).error,'DRAIN_REQUIRED');assert.equal(x.store.task(a.task_id).busy,1);
 x.journal.closed(op,{code:0,signal:null});assert.equal(x.journal.finish(a.id,a.epoch).state,'completed');
});
test('operation events are monotonic, reject conflicting close and duplicate spawn',t=>{
 const x=fixture(t),a=admitted(x);x.journal.markDispatched(a.id,a.epoch);const op=x.journal.startOperation(a.id,a.epoch,'reference');x.journal.spawned(op,1001);
 assert.throws(()=>x.journal.startOperation(a.id,a.epoch,'index'),/DRAIN_REQUIRED/);assert.throws(()=>x.journal.spawned(op,1002),/SPAWN_INVALID/);
 x.journal.closed(op,{code:0});x.journal.closed(op,{code:0});assert.throws(()=>x.journal.closed(op,{code:1}),/CLOSE_CONFLICT/);
});
test('revocation blocks every new effect but allows only closed-operation cleanup',t=>{
 const x=fixture(t),a=admitted(x);x.journal.markDispatched(a.id,a.epoch);x.control.authorized=false;
 assert.throws(()=>x.journal.startOperation(a.id,a.epoch,'object'),/APPROVAL_REQUIRED/);const op=x.journal.startOperation(a.id,a.epoch,'unlock');x.journal.closed(op,{code:0});
 assert.throws(()=>x.journal.startOperation(a.id,a.epoch,'shell'),/OPERATION_KIND/);
});
