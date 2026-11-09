import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {ManagedSlots,ManagedBudget,ManagedSessions,resolveManagedModel,ARCHIVE_IDLE_MS} from '../bundle/managed-runtime.js';

function db(t){const d=new DatabaseSync(':memory:');t.after(()=>d.close());return d;}
test('three ordinary reservations and one existing-task human follow-up; no preemption',t=>{
 const slots=new ManagedSlots(db(t));
 for(let i=0;i<3;i++)assert.equal(slots.reserve({task_id:'ordinary-'+i,role:'cloud'}).reserved,true);
 assert.deepEqual(slots.reserve({task_id:'new-person-task',role:'cloud'}),{reserved:false,reason:'worker_busy'});
 assert.equal(slots.reserve({task_id:'followup',role:'cloud',humanFollowup:true}).extra_slot,true);
 assert.equal(slots.reserve({task_id:'another-followup',role:'cloud',humanFollowup:true}).reserved,false);
 assert.equal(slots.snapshot().held,4);
});
test('under three, human follow-up uses an ordinary slot; same-task cannot double start',t=>{
 const s=new ManagedSlots(db(t)),r=s.reserve({task_id:'t',role:'local',humanFollowup:true});
 assert.equal(r.extra_slot,false);assert.equal(s.reserve({task_id:'t',role:'cloud',humanFollowup:true}).reason,'task_running');
});
test('resources remain exclusive across hosts and human priority',t=>{
 const s=new ManagedSlots(db(t));s.reserve({task_id:'a',role:'local',resources:['repo:copy1']});
 assert.equal(s.reserve({task_id:'b',role:'cloud',resources:['repo:copy1'],humanFollowup:true}).reason,'resource_busy');
 assert(s.reserve({task_id:'c',role:'cloud',resources:['repo:copy2']}).reserved);
});
test('expiry/reconstruction never frees undrained peer ownership',t=>{
 const d=db(t),s=new ManagedSlots(d,()=>1),r=s.reserve({task_id:'a',role:'local'}),restored=new ManagedSlots(d,()=>1e15);
 assert.equal(restored.list().length,1);assert.throws(()=>restored.release('a','forged',{drained:true}),/STALE_SLOT/);
 assert.throws(()=>restored.release('a',r.claim),/DRAIN_REQUIRED/);assert.equal(restored.list().length,1);
 restored.release('a',r.claim,{drained:true});assert.equal(restored.list().length,0);
});
test('invalid slot data cannot leave ownership',t=>{
 const s=new ManagedSlots(db(t));for(const a of [{task_id:'',role:'local'},{task_id:'a',role:'im'},{task_id:'a',role:'cloud',resources:['x','x']},{task_id:'a',role:'cloud',humanFollowup:'true'}])assert.throws(()=>s.reserve(a),/SLOT_INVALID/);
 assert.equal(s.list().length,0);
});
const policy={provider:'synthetic',model:'model'};
test('persistent task budget permits more than six calls; all purposes share it',t=>{
 const d=db(t),b=new ManagedBudget(d,()=>1);b.bind('task',policy,{maxRequests:8,endAt:100});
 for(const purpose of ['root','root','child','compaction','retry','search','child','root'])b.reserve('task',policy,purpose);
 const restarted=new ManagedBudget(d,()=>2);assert.equal(restarted.view('task').used,8);
 assert.throws(()=>restarted.reserve('task',policy,'root'),/BUDGET_EXHAUSTED/);
 assert.equal(restarted.bind('task',policy,{maxRequests:8,endAt:100}).used,8);
});
test('retry cannot reset request budget, deadline or model',t=>{
 const b=new ManagedBudget(db(t),()=>1);b.bind('t',policy,{maxRequests:8,endAt:100});
 for(const change of [{maxRequests:9,endAt:100},{maxRequests:8,endAt:101}])assert.throws(()=>b.bind('t',policy,change),/BUDGET_CHANGED/);
 assert.throws(()=>b.reserve('t',{...policy,model:'other'},'root'),/MODEL_CHANGED/);assert.equal(b.view('t').used,0);
});
test('deadline denies before dispatch and explicit reasoning cannot change',t=>{
 let now=1;const b=new ManagedBudget(db(t),()=>now),p={...policy,reasoningEffort:'high'};
 b.bind('t',p,{maxRequests:100,endAt:100});assert.throws(()=>b.reserve('t',policy,'child'),/MODEL_CHANGED/);
 now=100;assert.throws(()=>b.reserve('t',p,'root'),/DEADLINE/);assert.equal(b.view('t').used,0);
});
test('model precedence uses exact target native route without forced high',async()=>{
 const seen=[],ctx={llm:{resolveCallConfig:async p=>{seen.push(p);return {provider:'native',model:'default',...p};}}};
 assert.deepEqual(await resolveManagedModel(ctx),{provider:'native',model:'default'});
 assert.deepEqual(await resolveManagedModel(ctx,undefined,policy),policy);
 const p={...policy,model:'explicit',reasoningEffort:'low'};assert.deepEqual(await resolveManagedModel(ctx,p,policy),p);assert.equal(seen.length,3);
 await assert.rejects(resolveManagedModel({llm:{resolveCallConfig:async()=>policy}},{...policy,model:'wrong'}),/MODEL_CHANGED/);
});

function sessions(t){
 const d=db(t),stored=new Map(),live=new Map(),archives=new Set(),calls={create:0,resume:0,archive:0,unarchive:0,dispose:0,flush:0};
 let now=100,allowed=true,background=false,flush=true,failDispose=false;
 const create=async(o,resume=false)=>{
  calls[resume?'resume':'create']++;const id=resume?o.resumeSessionId:o.sessionId;
  if(resume&&!stored.has(id))throw Error('SESSION_MISSING');
  const session=resume?stored.get(id):{id,header:{cwd:o.meta.cwd},messages:[]};stored.set(id,session);
  const agent={id,session,status:'idle'};const commit=await o.setup?.({},agent);commit?.commit?.();live.set(id,agent);
  return {agent,dispose:async()=>{calls.dispose++;if(failDispose)throw Error('DISPOSE_FAILED');live.delete(id);}};
 };
 const ctx={agents:{get:id=>live.get(id),withoutInitiator:f=>f(),create:o=>create(o),resume:o=>create(o,true)},
  workspaceRegistry:{archiveSession:async id=>{calls.archive++;if(!stored.has(id))throw Error('SESSION_MISSING');if(live.has(id))throw Error('SESSION_ACTIVE');archives.add(id);},unarchiveSession:async id=>{calls.unarchive++;archives.delete(id);}},
  sessions:{flush:async()=>{calls.flush++;if(flush instanceof Error)throw flush;return flush;}}};
 const s=new ManagedSessions(ctx,d,{now:()=>now,canResume:()=>allowed,canArchive:()=>true,hasBackground:async()=>background});
 const open=()=>s.open({task_id:'task',role:'cloud',workspace:'/isolated/task',agentOptions:policy});
 return {s,open,ctx,stored,live,archives,calls,time:x=>now+=x,allow:x=>allowed=x,background:x=>background=x,flush:x=>flush=x,disposeFails:()=>failDispose=true};
}
test('queued tasks do not allocate sessions; ownership is per-task, not conversation',t=>{
 const f=sessions(t);assert.equal(f.calls.create,0);assert.equal(f.s.get('task'),undefined);assert.equal(f.s.owned('ordinary-dsh-entry'),undefined);
});
test('idle/reopen preserves same session and native transcript, not a fresh batch',async t=>{
 const f=sessions(t),a=await f.open();a.agent.session.messages.push('first result');const id=a.agent.id;await f.s.idle('task');
 const b=await f.open();assert.equal(b.agent.id,id);assert.deepEqual(b.agent.session.messages,['first result']);
 assert.equal(f.calls.create,1);assert.equal(f.calls.resume,1);await f.s.idle('task');
});
test('effective idle seven days archives only owned idle session; automatic resume same ID',async t=>{
 const f=sessions(t),h=await f.open(),id=h.agent.id;await f.s.idle('task');
 f.time(ARCHIVE_IDLE_MS-1);assert.deepEqual(await f.s.archiveIdle(),[]);f.time(1);
 assert.deepEqual(await f.s.archiveIdle(),[{task_id:'task',archived:true}]);assert(f.archives.has(id));
 const restored=await f.open();assert.equal(restored.agent.id,id);assert(!f.archives.has(id));await f.s.idle('task');
});
test('effective activity resets idle timestamp; query does not',async t=>{
 const f=sessions(t),h=await f.open();await f.s.idle('task');f.time(ARCHIVE_IDLE_MS-1);f.s.touch(h.agent.id);f.time(2);
 assert.deepEqual(await f.s.archiveIdle(),[]);const before=f.s.get('task').last_used;f.s.get('task');assert.equal(f.s.get('task').last_used,before);
});
test('running worker or background work refuses archive',async t=>{
 const f=sessions(t);await f.open();f.time(ARCHIVE_IDLE_MS);assert.deepEqual(await f.s.archiveIdle(),[]);
 f.background(true);await assert.rejects(f.s.idle('task'),/SESSION_BUSY/);assert.equal(f.s.get('task').state,'uncertain');
 assert.deepEqual(await f.s.archiveIdle(),[]);
});
test('pause/stop gate prevents unarchive and resume without user session operations',async t=>{
 const f=sessions(t);await f.open();await f.s.idle('task');f.time(ARCHIVE_IDLE_MS);await f.s.archiveIdle();f.allow(false);
 await assert.rejects(f.open(),/EXECUTION_FENCED/);assert.equal(f.calls.unarchive,0);assert.equal(f.calls.resume,0);
 f.allow(true);await f.open();await f.s.idle('task');assert.equal(f.calls.resume,1);
});
test('native unarchive success is not proof of persistence; missing never recreated',async t=>{
 const f=sessions(t),h=await f.open();await f.s.idle('task');f.time(ARCHIVE_IDLE_MS);await f.s.archiveIdle();f.stored.delete(h.agent.id);
 await assert.rejects(f.open(),/SESSION_MISSING/);assert.equal(f.calls.create,1);assert.equal(f.s.get('task').state,'uncertain');
 await assert.rejects(f.open(),/RECONCILE_REQUIRED/);assert.equal(f.calls.create,1);
});
test('manual idle archive is transparently restored; changed workspace is rejected',async t=>{
 const f=sessions(t),h=await f.open();await f.s.idle('task');f.archives.add(h.agent.id);
 await assert.rejects(f.s.open({task_id:'task',role:'cloud',workspace:'/wrong'}),/BINDING_CHANGED/);
 assert.equal(f.calls.resume,0);assert.equal(f.s.get('task').state,'idle');
 const restored=await f.open();assert.equal(restored.agent.id,h.agent.id);assert(!f.archives.has(h.agent.id));await f.s.idle('task');
});
test('flush failure keeps session uncertain and never archiveable',async t=>{
 const f=sessions(t);await f.open();f.flush(Error('DISK_FAILED'));await assert.rejects(f.s.idle('task'),/DISK_FAILED/);
 f.time(ARCHIVE_IDLE_MS);assert.deepEqual(await f.s.archiveIdle(),[]);assert.equal(f.calls.dispose,0);
});
test('missing persistence listener is not durability proof',async t=>{
 const f=sessions(t);await f.open();f.flush(false);await assert.rejects(f.s.idle('task'),/PERSISTENCE_UNAVAILABLE/);
 assert.equal(f.s.get('task').state,'uncertain');
});
test('disposer failure retains ownership; no double open or archive',async t=>{
 const f=sessions(t);await f.open();f.disposeFails();await assert.rejects(f.s.idle('task'),/DISPOSE_FAILED/);
 await assert.rejects(f.open(),/SESSION_BUSY/);f.time(ARCHIVE_IDLE_MS);assert.deepEqual(await f.s.archiveIdle(),[]);
});
test('archive never auto deletes, even after years',async t=>{
 const f=sessions(t),h=await f.open();await f.s.idle('task');f.time(3650*86400000);await f.s.archiveIdle();
 assert(f.stored.has(h.agent.id));f.time(3650*86400000);assert.deepEqual(await f.s.archiveIdle(),[]);assert(f.stored.has(h.agent.id));
});
test('revocation during async setup is checked at native publication',async t=>{
 const f=sessions(t);
 await assert.rejects(f.s.open({task_id:'task',role:'local',workspace:'/isolated/task',setup:async()=>{f.allow(false);}}),/EXECUTION_FENCED/);
 assert.equal(f.live.size,0);assert.equal(f.s.get('task').state,'uncertain');
});
test('consumer setup publication gate is preserved',async t=>{
 const f=sessions(t);
 await assert.rejects(f.s.open({task_id:'task',role:'local',workspace:'/isolated/task',setup:async()=>({commit:()=>{throw Error('CONSUMER_FENCED');}})}),/CONSUMER_FENCED/);
 assert.equal(f.live.size,0);
});
test('missing archive APIs reject before creating session ownership',async t=>{
 const f=sessions(t);delete f.ctx.workspaceRegistry;await assert.rejects(f.open(),/ARCHIVE_API_UNAVAILABLE/);
 assert.equal(f.s.get('task'),undefined);assert.equal(f.calls.create,0);
});

test('local one is independent of cloud 3+1, human priority cannot expand local capacity',t=>{
 const s=new ManagedSlots(db(t));for(let i=0;i<3;i++)assert(s.reserve({task_id:'cloud'+i,role:'cloud'}).reserved);
 assert(s.reserve({task_id:'local',role:'local'}).reserved);
 assert(!s.reserve({task_id:'local2',role:'local',humanFollowup:true}).reserved);
 assert(s.reserve({task_id:'cloud-follow',role:'cloud',humanFollowup:true}).reserved);
 assert.deepEqual([s.snapshot().cloud_held,s.snapshot().local_held],[4,1]);
});
test('approved budget amendment preserves consumption and rejects below-used limits',t=>{
 const b=new ManagedBudget(db(t),()=>1);b.bind('t',policy,{maxRequests:2,endAt:100});b.reserve('t',policy,'root');
 assert.throws(()=>b.bind('t',policy,{maxRequests:0,endAt:100},{amend:true}),/BUDGET_INVALID/);
 b.bind('t',{...policy,model:'changed'},{maxRequests:3,endAt:200},{amend:true});assert.equal(b.view('t').used,1);
 assert.throws(()=>b.reserve('t',policy,'old'),/MODEL_CHANGED/);
 b.reserve('t',{...policy,model:'changed'},'root');
 assert.throws(()=>b.bind('t',policy,{maxRequests:1,endAt:200},{amend:true}),/BUDGET_BELOW_USED/);
});
