import {compilePush} from '../bundle/delivery-push-plan.js';
// Real ledger and semantic confirmation verifier. Provider, filesystem, Git and
// scheduler ownership are synthetic. These tests authorize no real commit.
import test from 'node:test';import assert from 'node:assert/strict';
import {fixture} from './delivery-approval-fixture.mjs';
import {DeliveryRuntime} from '../bundle/delivery-runtime.js';
import {compileCommit} from '../bundle/delivery-object-plan.js';
import {baseline} from './delivery-fixture.mjs';
import {deliveryActions} from '../bundle/delivery-state.js';
import {digest} from '../bundle/approval-ledger.js';
function setup(t,{execute=true}={}){
 const f=fixture(t),control={effects:0,read:0,hold:null,broken:false};let rt;
 const scheduler={started:true,closed:false,lock:{listening:true},active:new Map()};
 const binding={root:f.identity.root,url:f.identity.url,base_sha:f.identity.base_sha,branch:f.identity.branch};
 const g={c:{role:'cloud'},closed:false,store:f.store,catalog:f.catalog,approvals:f.ledger,delivery:f.preview,now:f.ledger.now,scheduler,
  development:{gate:{bindings:{[f.task.id]:binding},inflight:new Set(),row:id=>f.store.db.prepare('SELECT * FROM development_requests WHERE id=?').get(id)}}};
 const reader={compile(input){control.read++;const bytes=Buffer.from('synthetic report\n');return {...compileCommit({...input,baseline:[],files:[{path:'report.md',mode:0o644,bytes}]}),workspace_identity:f.identity};},
  preflight:i=>({intent_fingerprint:i.fingerprint,drained:true,manifest_sha256:i.plan.manifest_sha256,workspace_identity:i.workspace_identity,branch:i.plan.branch,parent:i.plan.parent,baseline:baseline(i)}),
  observe:i=>({kind:'commit-readback-v1',intent_fingerprint:i.fingerprint,drained:true,object_exists:true,head_oid:i.plan.computed_commit_oid,ref_oid:i.plan.computed_commit_oid,commit_oid:i.plan.computed_commit_oid,tree_oid:i.plan.tree_oid,index_tree_oid:i.plan.tree_oid,branch:i.plan.branch,parent:i.plan.parent,manifest_sha256:i.plan.manifest_sha256,workspace_identity:i.workspace_identity})};
 const io={reader:()=>reader,commit:()=>({async execute(id,epoch,objects,{signal}){
  control.effects++;const j=rt.journal;j.markDispatched(id,epoch);
  if(control.hold)await control.hold(signal);if(control.broken||signal.aborted)throw Error('simulated unknown outcome');
  return j.finish(id,epoch);
 }})};
 const config={enabled:true,execute,author:f.compiled.plan.author,committer:f.compiled.plan.committer};
 rt=new DeliveryRuntime(g,config,io);g.deliveryRuntime=rt;rt.start();
 const args={task_id:f.task.id,preview_id:f.p.id,fingerprint:f.p.fingerprint,commit_message:'runtime metadata',event_id:'prepare'};
 const schedule=id=>rt.schedule('cloud',{task_id:f.task.id,approval_id:id,event_id:'schedule'});
 const approved=async()=>{const x=await f.start();await f.decide(x.prompt);return x.r.id;};
 return {...f,g,rt,config,io,reader,control,args,schedule,approved};
}
test('stage compiles server-side once, persists exact objects, replays without reading workspace',t=>{
 const f=setup(t),a=f.rt.stage('local',f.args),s=f.rt.approval.stored(f.task.id,a.reference.plan_id,a.reference.fingerprint);
 assert.equal(s.intent.plan.author.email,'fixture@example.invalid');assert.equal(s.intent.plan.when,Math.floor(f.g.now()/1000));
 assert(f.rt.approval.objects(s).length>0);assert.equal(f.rt.stage('local',f.args).replayed,true);assert.equal(f.control.read,1);
 assert.throws(()=>f.rt.stage('local',{...f.args,commit_message:'changed'}),/EVENT_CONFLICT/);assert.equal(f.control.effects,0);
});
test('stage rejects caller objects, identity, model or approval flags',t=>{
 const f=setup(t);for(const key of ['objects','author','approved','root','model'])assert.throws(()=>f.rt.stage('cloud',{...f.args,[key]:true}),/INVALID_STAGE/);
});
test('runtime requires cloud scheduler, operator identities and explicit enable',t=>{
 const f=setup(t);for(const c of [{...f.config,enabled:false},{...f.config,author:undefined},{...f.config,execute:'yes'},{...f.config,automatic:true}])assert.throws(()=>new DeliveryRuntime(f.g,c),/DELIVERY_RUNTIME/);
 assert.throws(()=>new DeliveryRuntime({...f.g,c:{role:'local'}},f.config),/DISABLED/);
});
test('default execution off permits metadata staging but neither schedule nor tick writes',async t=>{
 const f=setup(t,{execute:false});f.rt.stage('cloud',f.args);const id=await f.approved();assert.throws(()=>f.schedule(id),/EXECUTION_DISABLED/);f.rt.tick();assert.equal(f.control.effects,0);
});
test('approval alone never schedules; explicit schedule returns before an independent executor runs',async t=>{
 const f=setup(t),id=await f.approved();f.rt.tick();assert.equal(f.control.effects,0);
 const q=f.schedule(id);assert.equal(q.action.state,'queued');assert.equal(f.control.effects,0);
 f.rt.tick();assert(f.rt.pending);assert.equal(f.control.effects,0);await f.rt.pending;
 assert.equal(f.rt.journal.row(q.action.id).state,'completed');assert.equal(f.control.effects,1);
 f.rt.tick();assert.equal(f.control.effects,1);assert.equal(f.schedule(id).action.state,'completed');
});
test('busy task queues without filesystem inspection, then acquires only after idle',async t=>{
 const f=setup(t),id=await f.approved();f.store.db.prepare('UPDATE tasks SET busy=1 WHERE id=?').run(f.task.id);
 f.reader.compile=()=>{throw Error('queue may not read files');};f.reader.preflight=()=>{throw Error('busy may not preflight');};
 const q=f.schedule(id);f.rt.tick();assert.equal(f.rt.journal.row(q.action.id).state,'queued');assert.equal(f.control.effects,0);
 assert.equal(deliveryActions(f.g,f.task.id).items[0].waiting_reason,'task_busy');
});
for(const type of ['active-session','a2a','lost-owner','unclosed-operation'])test('runtime holds '+type+' without claiming or executing',async t=>{
 const f=setup(t),id=await f.approved(),q=f.schedule(id);
 if(type==='active-session')f.g.scheduler.active.set('x',{task_id:f.task.id});
 if(type==='a2a')f.g.a2a={busy:()=>true};
 if(type==='lost-owner')f.g.scheduler.lock.listening=false;
 if(type==='unclosed-operation')f.store.db.prepare("INSERT INTO delivery_operations(id,action_id,epoch,kind,detail,state,started) VALUES ('op',?,1,'object','{}','intent',1)").run(q.action.id);
 f.rt.tick();assert.equal(f.control.effects,0);assert.equal(f.rt.journal.row(q.action.id).state,'queued');
});
test('rejection/modification before scheduling does not create an action',async t=>{
 const f=setup(t),x=await f.start();await f.decide(x.prompt,'同意，但是请改为两段');assert.throws(()=>f.schedule(x.r.id),/APPROVAL/);assert.equal(f.store.db.prepare('SELECT count(*) n FROM delivery_actions').get().n,0);
});
test('revoked approval after queue cancels admission without retry or effects',async t=>{
 const f=setup(t),x=await f.start();await f.decide(x.prompt);const q=f.schedule(x.r.id);await f.decide(x.prompt,'先暂停');f.rt.tick();
 assert.equal(f.rt.journal.row(q.action.id).state,'cancelled');assert.equal(f.control.effects,0);
});
test('persisted object corruption fails before queue admission',async t=>{
 const f=setup(t),id=await f.approved();f.store.db.prepare("UPDATE delivery_plan_objects SET bytes=x'00'").run();assert.throws(()=>f.schedule(id),/DELIVERY/);assert.equal(f.control.effects,0);
});
test('restart marks active action review, never infers drain or retries it',async t=>{
 const f=setup(t),id=await f.approved(),q=f.schedule(id);f.rt.journal.acquire(q.action.id);
 const next=new DeliveryRuntime(f.g,f.config,f.io);next.start();next.tick();assert.equal(next.journal.row(q.action.id).state,'needs_review');assert.equal(f.store.task(f.task.id).busy,1);assert.equal(f.control.effects,0);
});
test('shutdown aborts and waits for the independent action; uncertain effect stays held',async t=>{
 const f=setup(t),id=await f.approved(),q=f.schedule(id);let entered;
 const ready=new Promise(r=>entered=r);f.control.hold=signal=>new Promise(resolve=>{signal.addEventListener('abort',resolve,{once:true});entered();});
 f.rt.tick();await ready;assert(f.rt.pending);await f.rt.close();assert.equal(f.rt.journal.row(q.action.id).state,'needs_review');assert.equal(f.store.task(f.task.id).busy,1);
 f.rt.tick();assert.equal(f.control.effects,1);
});
test('completed readback is historical; status never reads files or exposes stored bytes/author/paths',async t=>{
 const f=setup(t),id=await f.approved(),q=f.schedule(id);f.rt.tick();await f.rt.pending;
 f.g.catalog.head=()=>{throw Error('migration forbidden');};f.reader.observe=()=>{throw Error('filesystem forbidden');};
 const before=f.store.db.prepare('SELECT total_changes() n').get().n,s=deliveryActions(f.g,f.task.id),after=f.store.db.prepare('SELECT total_changes() n').get().n;
 assert.equal(before,after);assert.equal(s.items[0].commit_oid,f.compiled.plan.computed_commit_oid);assert.equal(s.filesystem_checked_now,false);
 for(const secret of ['fixture@example.invalid',f.identity.root,'synthetic report'])assert(!JSON.stringify(s).includes(secret));
 f.store.db.prepare('UPDATE tasks SET revision=revision+1 WHERE id=?').run(f.task.id);assert.equal(deliveryActions(f.g,f.task.id).items[0].revision_matches,false);
 f.store.db.prepare("DELETE FROM delivery_events WHERE action_id=? AND type='readback_completed'").run(q.action.id);
 assert.equal(deliveryActions(f.g,f.task.id).items[0].state,'evidence_invalid');assert.equal(deliveryActions(f.g,f.task.id).items[0].commit_oid,null);
});
test('computed OID and dispatch intent never imply complete commit',async t=>{
 const f=setup(t),id=await f.approved(),q=f.schedule(id);const j=f.rt.journal,a=j.acquire(q.action.id);j.markDispatched(a.id,a.epoch);j.markUnknown(a.id,a.epoch);
 const s=deliveryActions(f.g,f.task.id).items[0];assert(s.computed_commit_oid);assert.equal(s.commit_oid,null);assert.equal(s.state,'needs_review');
});
test('corrupt row is explicitly unknown without leaking raw error',async t=>{
 const f=setup(t),id=await f.approved(),q=f.schedule(id);f.store.db.prepare("UPDATE delivery_actions SET intent='broken',error='secret-token' WHERE id=?").run(q.action.id);
 const s=deliveryActions(f.g,f.task.id);assert.equal(s.items[0].state,'evidence_invalid');assert(!JSON.stringify(s).includes('secret-token'));
});

test('missing unapplied proof is not displayed as confirmed no effect',async t=>{
 const f=setup(t),id=await f.approved(),q=f.schedule(id);f.store.db.prepare("UPDATE delivery_actions SET state='not_applied' WHERE id=?").run(q.action.id);
 assert.equal(deliveryActions(f.g,f.task.id).items[0].state,'evidence_invalid');
});
test('status projection is bounded and keeps unresolved entries ahead of history',async t=>{
 const f=setup(t),id=await f.approved(),q=f.schedule(id),db=f.store.db;
 for(let n=0;n<35;n++){
  const r=f.rt.journal.row(q.action.id),event_id='other-event-'+n,approval_id='other-approval-'+n,intent=JSON.parse(r.intent);
  db.prepare(`INSERT INTO delivery_actions(id,event_id,fingerprint,task_id,approval_id,authority_hash,resource,intent,development_cutoff,state,created) VALUES (?,?,?,?,?,?,?,?,?,'cancelled',?)`).run('history-'+n,event_id,digest({event_id,approval_id,intent}),r.task_id,approval_id,r.authority_hash,r.resource,r.intent,0,n);
 }
 for(let n=0;n<30;n++)f.rt.journal.event(q.action.id,'operation_intent',{secret:'never exposed'});
 const s=deliveryActions(f.g,f.task.id);assert.equal(s.total,36);assert.equal(s.items.length,20);assert.equal(s.items[0].id,q.action.id);assert.equal(s.items[0].timeline.length,12);assert(!JSON.stringify(s).includes('never exposed'));
});
test('invalid direct RPC scalar types are rejected before SQL lookup',t=>{
 const f=setup(t);for(const task_id of [null,{},[],1,'\n']){
  assert.throws(()=>f.rt.stage('cloud',{...f.args,task_id}),/INVALID_STAGE/);
  assert.throws(()=>f.rt.schedule('cloud',{task_id,approval_id:'missing',event_id:'x'}),/INVALID_SCHEDULE/);
 }
});

test('runtime composes the real commit adapter with trusted approval and synthetic Git IO',async t=>{
 const {DeliveryCommit}=await import('../bundle/delivery-commit.js');
 const f=setup(t),id=await f.approved(),q=f.schedule(id),j=f.rt.journal,intent=j.intent(j.row(q.action.id)),initial=baseline(intent);
 let locked=false,referenced=false,indexed=false;const present=new Set();let gitEffects=0;
 const reader={capture:()=>{const s={...initial,head_oid:referenced?intent.plan.computed_commit_oid:intent.plan.parent,ref_oid:referenced?intent.plan.computed_commit_oid:intent.plan.parent,
  index_tree_oid:indexed?intent.plan.tree_oid:initial.parent_tree_oid,metadata:{...initial.metadata},objects_present:[...present].sort()};delete s.fingerprint;return {...s,fingerprint:digest(s)};},observe:i=>{assert(!locked&&referenced&&indexed);return f.reader.observe(i);}};
 const {createHash}=await import('node:crypto');let indexHash;
 const capture=reader.capture;reader.capture=()=>{const s=capture();if(indexed){s.metadata.index_sha256=indexHash;delete s.fingerprint;s.fingerprint=digest(s);}return s;};
 const lease={open:()=>locked=true,assert:()=>assert(locked),proofs:()=>({}),installIndex:b=>{indexHash=createHash('sha256').update(b).digest('hex');indexed=true;},release:()=>locked=false,abandon(){}};
 f.io.commit=()=>new DeliveryCommit({journal:j,binding:f.rt.binding(f.task.id),enabled:true,externalDrained:()=>f.rt.drained(f.task.id)},
  {reader,makeLease:()=>lease,runGit:async(args,input,_signal,observer)=>{
   observer.onSpawn({pid:++gitEffects});let result='';if(args[0]==='hash-object'){const o=f.compiled.objects.find(o=>o.type===args[3]&&o.data.equals(input));assert(o);present.add(o.oid);result=o.oid+'\n';}else{assert.equal(args[0],'update-ref');referenced=true;}
   observer.onClose({code:0,signal:null});return result;
  }});
 f.rt.tick();await f.rt.pending;assert.equal(j.row(q.action.id).state,'completed');assert(gitEffects>0);assert.equal(j.unfinished(q.action.id),false);
 assert.equal(deliveryActions(f.g,f.task.id).items[0].commit_oid,intent.plan.computed_commit_oid);
});

test('bounded queue scans advance past a full page of blocked actions',async t=>{
 const f=setup(t),id=await f.approved(),q=f.schedule(id),db=f.store.db,r=f.rt.journal.row(q.action.id);
 for(let n=0;n<55;n++)db.prepare(`INSERT INTO delivery_actions(id,event_id,fingerprint,task_id,approval_id,authority_hash,resource,intent,development_cutoff,state,created) VALUES (?,?,?,?,?,?,?,?,?,'queued',?)`).run('page-'+n,'event-'+n,'synthetic-only',r.task_id,'approval-'+n,r.authority_hash,r.resource,r.intent,0,n);
 const seen=[];f.rt.journal.waiting=id=>{seen.push(id);return 'task_busy';};f.rt.tick();assert.equal(seen.length,50);f.rt.tick();assert.equal(seen.length,56);assert(seen.includes('page-54'));assert.equal(f.control.effects,0);
});

test('commit runtime leaves unsupported queued push intact without reading files or executing',async t=>{
 const f=setup(t),approved=await f.approved(),q=f.schedule(approved);f.rt.tick();await f.rt.pending;
 const j=f.rt.journal,source=j.row(q.action.id),intent=j.intent(source),plan=compilePush({source_action_id:source.id,commit_intent:intent,commit_result:JSON.parse(source.result),repository_id:101,expected_remote_oid:null});
 j.pushEnabled=true;const authorize=j.authorize;j.authorize=({approval_id,intent:i})=>({kind:'delivery-execution-v1',execution:true,scope:'push',approval_id,task_id:i.task_id,task_revision:i.task_revision,intent_fingerprint:i.fingerprint,authority_hash:'a'.repeat(64)});
 const push=j.enqueue({task_id:f.task.id,resource:intent.resource,workspace_identity:intent.workspace_identity,plan,event_id:'push-event',approval_id:'synthetic-push-only'});
 j.authorize=authorize;j.pushEnabled=false;f.reader.preflight=()=>{throw Error('unsupported push must not inspect Git');};
 f.rt.tick();assert.equal(j.view(push.id).state,'queued');assert.equal(f.control.effects,1);assert.equal(f.store.task(f.task.id).busy,0);
});
