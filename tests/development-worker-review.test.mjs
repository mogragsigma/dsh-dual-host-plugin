import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {writeFileSync} from 'node:fs';
import {setup,plan,fakeCommands} from './workspace-fixture.mjs';
import {proposal} from './approval-fixture.mjs';
import {TaskJobs} from '../bundle/task-jobs.js';
import {DevelopmentRuntime} from '../bundle/development-runtime.js';
import {DevelopmentWorkerReview} from '../bundle/development-worker-review.js';
async function interrupted(t,{max=8,unsettled=false,priorCommand=false,commands=fakeCommands}={}){
 const spec=plan();spec.max_model_requests=max;const f=await setup(t,{selectedSpec:spec}),jobs=new TaskJobs(join(f.dir,'jobs'),f.ledger.now);t.after(()=>jobs.close());
 const g={c:{role:'cloud',stateDir:f.dir},ctx:{on(){}},store:f.store,catalog:f.catalog,approvals:f.ledger,repositories:f.repos,scheduler:{jobs},now:f.ledger.now};
 const runtime=new DevelopmentRuntime(g,{enabled:true,bindings:f.bindings});runtime.workspaceEnabled=true;runtime.gate.commands=commands;
 let exclusive=true;const assertExclusive=()=>{if(!exclusive)throw Error('DEVELOPMENT_REVIEW_EXCLUSIVE_REQUIRED');};
 runtime.workerReview=new DevelopmentWorkerReview(runtime,{assertExclusive});
 const scheduled=await runtime.schedule({task_id:f.task.id,approval_id:f.req.id,model_policy:proposal.model_policy},{workspace:true});
 const claim=()=>jobs.claim(new Set(['development']),new Set(),j=>runtime.canClaim(j)),job=claim(),gate=runtime.gate,r=runtime.requestFor(job);
 const model=()=>runtime.modelBudget.reserve(r.id,job,{purpose:'worker',...proposal.model_policy,maxTokens:2048});const first=model();runtime.modelBudget.settle(first.id,'succeeded');
 gate.admitWriteCall(r.id,'cloud',r.epoch,'first-write');if(!unsettled)gate.write(r.id,'cloud',r.epoch,{call_id:'first-write',path:'docs/report.md',content:'preserve this applied file',expected_hash:r.expected_hash});
 if(priorCommand)await gate.command(r.id,'cloud',r.epoch,{command_id:'build',call_id:'before-crash-build'});
 const pending=max>1?model():null;const hash=gate.row(r.id).expected_hash;
 jobs.recover(new Set());runtime.recover();
 const args=()=>({job_id:job.id,run_id:job.run_id,event_id:'one-review',proof_hash:runtime.workerReview.evidence(job.id).proof_hash,note:'Synthetic explicit operator resume, not a new approval'});
 return {...f,g,jobs,job,gate,r,hash,runtime,claim,args,pending,assertExclusive,exclusive:v=>exclusive=v};
}
test('workspace recovery preserves manifest/effects/budgets and requires separate resume',async t=>{
 const f=await interrupted(t),a=f.args(),r=f.runtime.workerReview.review(a);
 assert.equal(r.status,'paused');assert.equal(r.attempts_retained,1);assert.equal(r.max_runs,2);assert.equal(r.grants_execution,false);assert.equal(r.budget_reset,false);assert.equal(r.starts_worker,false);
 assert.equal(f.gate.row(f.r.id).expected_hash,f.hash);assert.equal(f.gate.row(f.r.id).state,'queued');assert.equal(f.jobs.get(f.job.id).attempts,1);assert.equal(f.claim(),null);
 assert.deepEqual(f.runtime.modelBudget.view(f.r.id).states,{succeeded:1,unknown:1});assert.equal(f.runtime.modelBudget.view(f.r.id).used,2);
 assert.throws(()=>f.gate.write(f.r.id,'cloud',f.r.epoch,{call_id:'old',path:'docs/report.md',content:'overwrite',expected_hash:f.hash}),/STALE_FENCE/);
 assert.deepEqual(f.runtime.workerReview.review(a),{...r,replayed:true});assert.throws(()=>f.runtime.workerReview.review({...a,note:'altered'}),/CONFLICT/);
 f.jobs.control({id:f.job.id,action:'resume',event_id:'resume',actor:'synthetic-operator'});const j=f.claim();assert.equal(j.id,f.job.id);assert.equal(j.attempts,2);assert.notEqual(j.session_id,f.job.session_id);assert.notEqual(j.claim,f.job.claim);
 const request=f.runtime.requestFor(j);assert.equal(request.id,f.r.id);assert.equal(request.epoch,f.r.epoch+2);assert.equal(request.expected_hash,f.hash);
 assert.equal(f.gate.read(request.id,'cloud',request.epoch,'docs/report.md').content,'preserve this applied file');
 const checkpoint=f.runtime.workerReview.checkpoint(j);assert(checkpoint.resumed);assert.equal(checkpoint.write_budget.calls_used,1);assert.equal(checkpoint.model_budget.used,2);
 const res=f.runtime.modelBudget.reserve(request.id,j,{purpose:'worker',...proposal.model_policy,maxTokens:2048});assert.equal(res.used,3);
 for(const command_id of ['build','test'])await f.gate.command(request.id,'cloud',request.epoch,{command_id,call_id:'resumed-'+command_id});
 f.runtime.modelBudget.settle(res.id,'succeeded');f.jobs.finish(j,{outcome:'done',summary:'Unit recovery complete'});f.runtime.finished(j);assert.equal(f.gate.row(request.id).state,'completed');
 assert.equal(f.gate.progress(request.id).write_budget.intents_used,1);
});
test('reviewed but paused job survives restart without automatic execution or budget refill',async t=>{
 const f=await interrupted(t),a=f.args();f.runtime.workerReview.review(a);f.jobs.recover(new Set());f.runtime.recover();
 const review=new DevelopmentWorkerReview(f.runtime,{assertExclusive:f.assertExclusive});assert.equal(review.review(a).replayed,true);
 assert.equal(f.jobs.get(f.job.id).status,'paused');assert.equal(f.jobs.get(f.job.id).max_runs,2);assert.equal(f.claim(),null);assert.equal(f.runtime.modelBudget.view(f.r.id).used,2);
});
test('cross-database crash after durable pause is recoverable once using original event',async t=>{
 const f=await interrupted(t),a=f.args(),tx=f.jobs.tx.bind(f.jobs);let fail=true;
 f.jobs.tx=fn=>{const r=tx(fn);if(fail){fail=false;throw Error('injected after job commit');}return r;};
 assert.throws(()=>f.runtime.workerReview.review(a),/injected/);assert.equal(f.jobs.get(f.job.id).status,'paused');assert.equal(f.gate.row(f.r.id).state,'needs_review');assert(f.store.task(f.task.id).blocked);
 f.jobs.tx=tx;f.runtime.recover();assert.equal(f.jobs.get(f.job.id).status,'needs_review');
 const recovered=new DevelopmentWorkerReview(f.runtime,{assertExclusive:f.assertExclusive});const r=recovered.review(a);assert.equal(r.status,'paused');assert.equal(r.max_runs,2);assert.equal(f.runtime.modelBudget.view(f.r.id).used,2);
 assert.equal(f.jobs.db.prepare("SELECT count(*) n FROM job_events WHERE type='workspace_review_paused'").get().n,1);
});
test('stale evidence, wrong run, old version and altered policy cannot recover',async t=>{
 for(const variant of ['proof','run','version','policy'])await t.test(variant,async t=>{
  const f=await interrupted(t),a=f.args();if(variant==='proof')a.proof_hash='0'.repeat(64);if(variant==='run')a.run_id='other';
  if(variant==='version')f.jobs.db.prepare("UPDATE jobs SET version='0.21.0'").run();if(variant==='policy')f.jobs.db.prepare("UPDATE jobs SET policy='{}'").run();
  assert.throws(()=>f.runtime.workerReview.review(a));assert.equal(f.gate.row(f.r.id).state,'needs_review');assert.equal(f.jobs.get(f.job.id).max_runs,1);
 });
});
test('active same-task agent, missing owner and unresolved operations stay fenced',async t=>{
 const f=await interrupted(t),a=f.args();f.exclusive(false);assert.throws(()=>f.runtime.workerReview.review(a),/EXCLUSIVE/);f.exclusive(true);
 f.runtime.worker.active.set('a',{job:f.job});assert.throws(()=>f.runtime.workerReview.review(a),/REVIEW_STATE/);f.runtime.worker.active.clear();
 f.gate.inflight.add(f.r.id);assert.throws(()=>f.runtime.workerReview.review(a),/REVIEW_STATE/);f.gate.inflight.clear();
 f.gate.db.prepare("INSERT INTO development_operations VALUES ('unknown',?,?, 'command','intent',NULL,1,NULL,NULL,NULL)").run(f.r.id,f.r.epoch);
 assert.throws(()=>f.runtime.workerReview.review(a),/EFFECTS_UNRESOLVED/);
});
test('unsettled write tool call cannot be mistaken for zero effects',async t=>{const f=await interrupted(t,{unsettled:true});assert.throws(()=>f.args(),/EFFECTS_UNRESOLVED/);});
test('model exhaustion and expired approval prohibit resumption without resetting history',async t=>{
 const f=await interrupted(t,{max:1});assert.throws(()=>f.args(),/MODEL_BUDGET/);assert.equal(f.jobs.get(f.job.id).max_runs,1);
 const g=await interrupted(t);g.time(25*3600*1000);assert.throws(()=>g.args(),/APPROVAL/);assert.equal(g.jobs.get(g.job.id).max_runs,1);
});
test('physical file drift or pending competing I/O cannot be accepted through recovery',async t=>{
 const f=await interrupted(t),a=f.args();writeFileSync(join(f.root,'docs/report.md'),'unapproved change');assert.throws(()=>f.runtime.workerReview.review(a),/FILE_CONFLICT/);assert(f.store.task(f.task.id).blocked);
});
test('cancel after prepared job transition cannot be resurrected by repeating review',async t=>{
 const f=await interrupted(t),a=f.args(),tx=f.jobs.tx.bind(f.jobs);f.jobs.tx=fn=>{const r=tx(fn);throw Error('crash');};assert.throws(()=>f.runtime.workerReview.review(a));f.jobs.tx=tx;
 f.jobs.control({id:f.job.id,action:'cancel',event_id:'cancel',actor:'operator'});assert.throws(()=>f.runtime.workerReview.review(a),/REVIEW_STATE/);assert.equal(f.jobs.get(f.job.id).status,'cancelled');
});
test('recovered queued request does not adopt arbitrary dirty files on claim',async t=>{
 const f=await interrupted(t);f.runtime.workerReview.review(f.args());writeFileSync(join(f.root,'docs/report.md'),'external drift');
 f.jobs.control({id:f.job.id,action:'resume',event_id:'resume',actor:'operator'});assert.equal(f.claim(),null);assert.equal(f.jobs.get(f.job.id).status,'needs_review');assert.equal(f.jobs.get(f.job.id).attempts,1);
});
test('a completed flag without the matching operation/intent is not drain evidence',async t=>{
 const f=await interrupted(t);f.gate.db.prepare("INSERT INTO development_commands VALUES('fabricated',?,'build','fake','missing','completed',?,1)").run(f.r.id,JSON.stringify({drained:true,passed:true}));
 assert.throws(()=>f.args(),/EVIDENCE_REQUIRED/);assert.equal(f.jobs.get(f.job.id).max_runs,1);
});

test('matching completed commands survive worker review as history without a rerun',async t=>{
 const f=await interrupted(t,{priorCommand:true});f.runtime.workerReview.review(f.args());const history=f.runtime.workerReview.checkpoint(f.job);
 assert.equal(history.command_budget.used,1);assert.equal(history.previous_commands[0].passed,true);assert.equal(history.previous_commands[0].current_manifest,true);assert.equal(f.jobs.get(f.job.id).status,'paused');
});
