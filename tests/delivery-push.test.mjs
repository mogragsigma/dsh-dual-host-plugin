// Real SQLite/fences with synthetic Git, provider, approval and process evidence.
// These tests never spawn Git, contact Gitee, or prove an actual push.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Coordinator} from '../bundle/store.js';
import {DeliveryJournal} from '../bundle/delivery-journal.js';
import {compileCommit} from '../bundle/delivery-object-plan.js';
import {compilePush,validatePushPlan,validatePushIntent,pushCommand,remoteReadCommand,parseRemoteRef} from '../bundle/delivery-push-plan.js';
import {deliveryActions} from '../bundle/delivery-state.js';
import {canonical,digest} from '../bundle/approval-ledger.js';
import {baseline} from './delivery-fixture.mjs';
import {createHash} from 'node:crypto';
const resource='https://gitee.com/test-fixture/temporary';
const now=100000;
const fingerprint=v=>{const {fingerprint,...b}=v;return {...b,fingerprint:digest(b)};};
function fixture(t,options={}){
 const root=mkdtempSync(join(tmpdir(),'delivery-push-')),store=new Coordinator(root);
 t.after(()=>{store.db.close();rmSync(root,{recursive:true,force:true});});
 const control={now,scope:'push',remote:'1'.repeat(40),ancestor:true,proof:true,owner:true,observed_at:now,authority:'b'.repeat(64)};
 const j=new DeliveryJournal({store,enabled:true,pushEnabled:true,exclusive:()=>control.owner,now:()=>control.now,
  authorize:({approval_id,intent:i})=>({kind:'delivery-execution-v1',execution:true,scope:i.kind==='push-execution-intent-v1'?control.scope:'commit',approval_id,task_id:i.task_id,task_revision:i.task_revision,intent_fingerprint:i.fingerprint,authority_hash:control.authority}),
  preflight:i=>{
   const p=i.plan;if(i.kind==='push-execution-intent-v1'){
    const b={kind:'push-state-v1',intent_fingerprint:i.fingerprint,workspace_identity:i.workspace_identity,repository_id:p.repository_id,url:p.url,ref:p.ref,remote_oid:control.remote,commit_oid:p.commit_oid,tree_oid:p.tree_oid,manifest_sha256:p.manifest_sha256,local_snapshot_sha256:'d'.repeat(64)};
    return {kind:'push-preflight-v1',intent_fingerprint:i.fingerprint,drained:true,local_commit_verified:true,fast_forward_verified:control.ancestor,observed_at:control.observed_at,baseline:{...b,fingerprint:digest(b)}};
   }
   return {intent_fingerprint:i.fingerprint,drained:true,manifest_sha256:p.manifest_sha256,workspace_identity:i.workspace_identity,branch:p.branch,parent:p.parent,baseline:baseline(i)};
  },observe:i=>{
   if(!control.proof)throw Error('never-output-secret');const p=i.plan;
   if(i.kind==='push-execution-intent-v1')return {kind:'push-readback-v1',intent_fingerprint:i.fingerprint,workspace_identity:i.workspace_identity,drained:true,repository_id:p.repository_id,url:p.url,ref:p.ref,ref_oid:control.remote,observed_at:control.observed_at};
   return {kind:'commit-readback-v1',intent_fingerprint:i.fingerprint,drained:true,object_exists:true,head_oid:p.computed_commit_oid,ref_oid:p.computed_commit_oid,commit_oid:p.computed_commit_oid,tree_oid:p.tree_oid,index_tree_oid:p.tree_oid,branch:p.branch,parent:p.parent,manifest_sha256:p.manifest_sha256,workspace_identity:i.workspace_identity};
  },...options});
 let n=0;
 function source(){
  n++;const task=store.accept('cloud',{task_key:'task-'+n,ingress_id:'ingress-'+n,source:'synthetic-test'});
  const bytes=Buffer.from('synthetic only '+n),sha=createHash('sha256').update(bytes).digest('hex');
  const compiled=compileCommit({parent:'1'.repeat(40),branch:'dsh-task/test-'+n,baseline:[],files:[{path:'a',bytes,mode:0o644}],changes:[{path:'a',action:'create',before_sha256:null,after_sha256:sha}],tested_content:{kind:'file_sha256',sha256:sha},author:{name:'Test',email:'test@example.invalid'},committer:{name:'Test',email:'test@example.invalid'},when:1000,message:'not actual Git'});
  const workspace_identity={root:'/nonexistent/push-fixture',directory:{device:'1',inode:'2'},git_directory:{device:'1',inode:'3'},url:resource,branch:compiled.plan.branch,base_sha:compiled.plan.parent};
  const request={task_id:task.id,resource,workspace_identity,...compiled,event_id:'commit-'+n,approval_id:'commit-approval-'+n};
  const q=j.enqueue(request),a=j.acquire(q.id);assert.equal(a.acquired,true);j.markDispatched(q.id,a.epoch);const result=j.finish(q.id,a.epoch);
  return {task,request,id:q.id,intent:j.intent(j.row(q.id)),result:result.result};
 }
 function request(s,expected_remote_oid='1'.repeat(40)){
  const plan=compilePush({source_action_id:s.id,commit_intent:s.intent,commit_result:s.result,repository_id:101,expected_remote_oid});
  return {task_id:s.task.id,resource,workspace_identity:s.intent.workspace_identity,plan,event_id:'push-'+s.id,approval_id:'push-approval-'+s.id};
 }
 return {j,store,control,source,request};
}
function admitted(x){const s=x.source(),r=x.request(s),q=x.j.enqueue(r),a=x.j.acquire(q.id);assert.equal(a.acquired,true);return {s,r,...a};}
test('push is disabled independently of commit execution',t=>{
 const x=fixture(t,{pushEnabled:false}),s=x.source();assert.throws(()=>x.j.enqueue(x.request(s)),/PUSH_DISABLED/);assert.equal(x.store.db.prepare('SELECT count(*) n FROM delivery_actions').get().n,1);
});
test('commit authority cannot authorize push; no implicit scope widening',t=>{
 const x=fixture(t),s=x.source();x.control.scope='commit';assert.throws(()=>x.j.enqueue(x.request(s)),/EXECUTION_APPROVAL_REQUIRED/);
});
test('exact push scope and source are durable; same event replays, new approval conflicts',t=>{
 const x=fixture(t),s=x.source(),r=x.request(s),q=x.j.enqueue(r);assert.equal(x.j.enqueue(r).id,q.id);assert.equal(q.kind,'push');assert.equal(q.computed_commit_oid,null);assert.equal(q.source_commit_oid,s.result.commit_oid);
 assert.throws(()=>x.j.enqueue({...r,approval_id:'different'}),/EVENT_CONFLICT/);
 assert.throws(()=>x.j.enqueue({...r,event_id:'different'}),/APPROVAL_ALREADY_USED/);
});
for(const change of ['source-review','source-undispatched','source-unclosed','source-event','source-result','workspace','revision','wrong-task'])test('rejects changed source: '+change,t=>{
 const x=fixture(t),s=x.source(),r=x.request(s),db=x.store.db;
 if(change==='source-review')db.prepare("UPDATE delivery_actions SET state='needs_review' WHERE id=?").run(s.id);
 if(change==='source-undispatched')db.prepare('UPDATE delivery_actions SET dispatched=0 WHERE id=?').run(s.id);
 if(change==='source-unclosed')db.prepare("INSERT INTO delivery_operations(id,action_id,epoch,kind,detail,state,started) VALUES ('fake',?,1,'object','{}','intent',0)").run(s.id);
 if(change==='source-event')db.prepare("DELETE FROM delivery_events WHERE action_id=? AND type='readback_completed'").run(s.id);
 if(change==='source-result')db.prepare("UPDATE delivery_actions SET result='{}' WHERE id=?").run(s.id);
 if(change==='workspace')r.workspace_identity={...r.workspace_identity,root:'/another'};
 if(change==='revision')db.prepare('UPDATE tasks SET revision=revision+1 WHERE id=?').run(s.task.id);
 if(change==='wrong-task')r.task_id=x.store.accept('cloud',{task_key:'other',ingress_id:'other',source:'test'}).id;
 assert.throws(()=>x.j.enqueue(r),/SOURCE_CHANGED|COMMIT_EVIDENCE_REQUIRED/);
});
test('source evidence is revalidated before acquisition, not just at enqueue',t=>{
 const x=fixture(t),s=x.source(),q=x.j.enqueue(x.request(s));x.store.db.prepare("DELETE FROM delivery_events WHERE action_id=? AND type='readback_completed'").run(s.id);
 assert.throws(()=>x.j.acquire(q.id),/SOURCE_CHANGED/);assert.equal(x.j.view(q.id).state,'queued');assert.equal(x.store.task(s.task.id).busy,0);
});
for(const change of ['stale','future','remote-moved','not-ancestor','approval-changed'])test('fresh preflight blocks '+change,t=>{
 const x=fixture(t),s=x.source(),q=x.j.enqueue(x.request(s));
 if(change==='stale')x.control.observed_at-=5001;if(change==='future')x.control.observed_at++;
 if(change==='remote-moved')x.control.remote='2'.repeat(40);if(change==='not-ancestor')x.control.ancestor=false;if(change==='approval-changed')x.control.authority='a'.repeat(64);
 assert.throws(()=>x.j.acquire(q.id),/PREFLIGHT_REQUIRED|APPROVAL_CHANGED/);assert.equal(x.store.task(s.task.id).busy,0);
});
test('new remote branch uses an explicit absent baseline, never a guessed tracking branch',t=>{
 const x=fixture(t),s=x.source(),r=x.request(s,null);x.control.remote=null;x.control.ancestor=false;
 const q=x.j.enqueue(r),a=x.j.acquire(q.id);assert.equal(a.acquired,true);x.j.markDispatched(q.id,a.epoch);
 assert.ok(pushCommand(r.plan).includes('--force-with-lease='+r.plan.ref+':'));
});
test('markDispatched rechecks baseline and persists before any push operation',t=>{
 const x=fixture(t),a=admitted(x);assert.throws(()=>x.j.startOperation(a.id,a.epoch,'push'),/NOT_DISPATCHED/);
 x.control.remote='3'.repeat(40);assert.throws(()=>x.j.markDispatched(a.id,a.epoch),/PREFLIGHT_REQUIRED/);assert.equal(x.j.view(a.id).dispatched,false);
 x.control.remote=a.r.plan.expected_remote_oid;x.j.markDispatched(a.id,a.epoch);assert.throws(()=>x.j.markDispatched(a.id,a.epoch),/ALREADY_DISPATCHED/);
});
test('operation kind cannot cross commit/push scopes',t=>{
 const x=fixture(t),a=admitted(x);x.j.markDispatched(a.id,a.epoch);
 for(const kind of ['object','reference','index','unlock','lock'])assert.throws(()=>x.j.startOperation(a.id,a.epoch,kind),/OPERATION_KIND/);
 const op=x.j.startOperation(a.id,a.epoch,'push');assert.throws(()=>x.j.startOperation(a.id,a.epoch,'push'),/PUSH_ALREADY_STARTED/);x.j.closed(op,{code:0});
 assert.throws(()=>x.j.startOperation(a.id,a.epoch,'push'),/PUSH_ALREADY_STARTED/);
});
test('shared resource FIFO holds later commits and pushes while remote outcome is unknown',t=>{
 const x=fixture(t),s1=x.source(),s2=x.source(),q1=x.j.enqueue(x.request(s1)),q2=x.j.enqueue(x.request(s2));
 assert.equal(x.j.waiting(q2.id),'delivery_fifo');const a=x.j.acquire(q1.id);x.j.markDispatched(q1.id,a.epoch);x.j.markUnknown(q1.id,a.epoch);
 assert.equal(x.j.waiting(q2.id),'delivery_resource_review');
 const commit=x.j.enqueue({...s2.request,event_id:'new-commit-event',approval_id:'new-commit-approval'});
 assert.equal(x.j.waiting(commit.id),'delivery_resource_review');assert.equal(x.store.task(s1.task.id).busy,1);
});
test('readback cannot complete while network child evidence remains open',t=>{
 const x=fixture(t),a=admitted(x);x.j.markDispatched(a.id,a.epoch);x.j.startOperation(a.id,a.epoch,'push');x.control.remote=a.r.plan.commit_oid;
 assert.equal(x.j.finish(a.id,a.epoch).state,'needs_review');assert.equal(x.store.task(a.task_id).busy,1);
});
test('only independently read remote target completes; no adoption, deployment or release claim',t=>{
 const x=fixture(t),a=admitted(x);x.j.markDispatched(a.id,a.epoch);const op=x.j.startOperation(a.id,a.epoch,'push');x.j.spawned(op,12345);x.j.closed(op,{code:0});
 assert.equal(x.j.finish(a.id,a.epoch,{success:true}).state,'needs_review');x.control.remote=a.r.plan.commit_oid;
 const r=x.j.finish(a.id,a.epoch);assert.equal(r.state,'completed');assert.equal(r.result.remote_acceptance,'ref_observed');assert.equal(r.result.runtime_adoption,'not_observed');assert.equal(r.result.publish,false);assert.equal(r.result.deploy,false);
 assert.equal(x.store.task(a.task_id).busy,0);assert.equal(x.j.finish(a.id,a.epoch).replayed,true);
});
test('unchanged ref cannot establish not-applied or authorize retry after dispatch',t=>{
 const x=fixture(t),a=admitted(x);x.j.markDispatched(a.id,a.epoch);x.j.markUnknown(a.id,a.epoch);
 assert.throws(()=>x.j.settleUnapplied(a.id,a.epoch),/PUSH_UNAPPLIED_NOT_PROVEN/);assert.equal(x.j.view(a.id).state,'needs_review');assert.equal(x.store.task(a.task_id).busy,1);
});
test('restart holds push once only; no acquisition, dispatch, unlock or retry',t=>{
 const x=fixture(t),a=admitted(x);x.j.markDispatched(a.id,a.epoch);const op=x.j.startOperation(a.id,a.epoch,'push');x.j.spawned(op,12345);
 assert.deepEqual(x.j.recover(),{needs_review:[a.id],retried:0});assert.equal(x.j.operation(op).state,'spawned');assert.equal(x.store.task(a.task_id).busy,1);assert.throws(()=>x.j.acquire(a.id),/NOT_QUEUED/);
});
for(const field of ['url','repository_id','ref','ref_oid','drained','workspace_identity','observed_at'])test('readback rejects mismatch '+field,t=>{
 const x=fixture(t),a=admitted(x),observe=x.j.observe;x.j.markDispatched(a.id,a.epoch);x.control.remote=a.r.plan.commit_oid;
 x.j.observe=i=>({...observe(i),[field]:field==='observed_at'?now-5001:'mismatch'});assert.equal(x.j.finish(a.id,a.epoch).state,'needs_review');
});
test('readback unavailable stays held and does not persist secret stderr',t=>{
 const x=fixture(t),a=admitted(x);x.j.markDispatched(a.id,a.epoch);x.control.proof=false;assert.equal(x.j.finish(a.id,a.epoch).error,'READBACK_UNKNOWN');
 assert.ok(!JSON.stringify(x.store.db.prepare('SELECT * FROM delivery_events').all()).includes('never-output-secret'));
});
test('persisted push projection is read-only, historical and cannot invent remote success',t=>{
 const x=fixture(t),a=admitted(x);x.j.markDispatched(a.id,a.epoch);x.control.remote=a.r.plan.commit_oid;x.j.finish(a.id,a.epoch);
 const read=()=>deliveryActions({store:x.store},a.task_id),item=()=>read().items.find(i=>i.id===a.id);
 x.store.db.exec('PRAGMA query_only = ON');const p=item();assert.equal(p.kind,'push');assert.equal(p.state,'completed');assert.equal(p.remote_ref_oid,a.r.plan.commit_oid);assert.equal(p.remote_acceptance,'ref_observed');assert.equal(p.historical,true);assert.equal(p.commit_oid,null);assert.equal(read().remote_checked_now,false);assert.ok(!JSON.stringify(p).includes('/nonexistent/'));
 x.store.db.exec('PRAGMA query_only = OFF');x.store.db.prepare("DELETE FROM delivery_events WHERE action_id=? AND type='readback_completed'").run(a.id);assert.equal(item().state,'evidence_invalid');assert.equal(item().remote_ref_oid,null);
});
for(const field of ['repository_id','url','branch','ref','format','commit_oid','parent_oid','tree_oid','expected_remote_oid','max_pushes','rewrite','delete','tags','publish','deploy','extra'])test('plan rejects invalid '+field,t=>{
 const x=fixture(t),s=x.source(),p=x.request(s).plan;
 const invalid={repository_id:0,url:'https://example.com/x/y',branch:'main',ref:'refs/tags/release',format:'sha256',commit_oid:'HEAD',parent_oid:'HEAD^',tree_oid:'abcd',expected_remote_oid:p.commit_oid,max_pushes:2,rewrite:true,delete:true,tags:true,publish:true,deploy:true,extra:true};
 assert.throws(()=>validatePushPlan(fingerprint({...p,[field]:invalid[field]})),/PLAN_INVALID|INVALID_REPOSITORY_URL/);
});
test('explicit command has exactly one SSH target, source OID and destination ref; no upstream changes',t=>{
 const x=fixture(t),p=x.request(x.source()).plan,args=pushCommand(p);
 assert.deepEqual(args,['push','--porcelain','--no-verify','--no-follow-tags','--signed=false','--recurse-submodules=no','--force-with-lease='+p.ref+':'+p.expected_remote_oid,'--','git@gitee.com:test-fixture/temporary.git',p.commit_oid+':'+p.ref]);
 assert.deepEqual(remoteReadCommand(p),['ls-remote','--refs','--exit-code','--','git@gitee.com:test-fixture/temporary.git',p.ref]);
});
test('remote ref parsing distinguishes absent ref from access failure, extra refs and malformed data',t=>{
 const x=fixture(t),p=x.request(x.source()).plan,line=p.commit_oid+'\t'+p.ref+'\n';
 assert.equal(parseRemoteRef(p,{code:0,stdout:line}),p.commit_oid);assert.equal(parseRemoteRef(p,{code:2,stdout:''}),null);
 for(const v of [{code:0,stdout:''},{code:128,stdout:''},{code:1,stdout:''},{code:2,stdout:line},{code:0,stdout:line+line},{code:0,stdout:line.replace(p.ref,'refs/heads/main')},{code:0,stdout:line.replace('\t',' ')},{code:0,stdout:'x'.repeat(1025)}])assert.throws(()=>parseRemoteRef(p,v),/REMOTE_UNKNOWN/);
});
test('push intent cannot smuggle another workspace or source commit with recomputed hash',t=>{
 const x=fixture(t),a=admitted(x),i=x.j.intent(x.j.row(a.id));
 assert.throws(()=>validatePushIntent(fingerprint({...i,workspace_identity:{...i.workspace_identity,branch:'main'}})),/IDENTITY_INVALID/);
});
