import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {TaskJobs} from '../bundle/task-jobs.js';
import {TaskWorkflows,workflowGraph} from '../bundle/task-workflows.js';
import {TaskScheduler} from '../bundle/task-scheduler.js';
import {makeEnvelope,selectedHumanContext} from '../bundle/task-envelope.js';
import {errorInfo} from '../bundle/link-contract.js';
const START=Date.parse('2026-10-18T08:00:00Z'),caps=new Set(['plan']);
const policy={provider:'per-task',model:'explicit-task-model',reasoningEffort:'medium'};
const agent={id:'entry',session:{deriveMessages:()=>[{id:'human-1',role:'user',source:{kind:'user'},content:[{type:'text',text:'分解为资料分析和汇总，使用所选模型，只读，最多四批，明天结束。'}]}]}};
const source=selectedHumanContext(agent,'cloud'),goal=makeEnvelope(agent,'cloud',{goal:'only read',target:'cloud',intent:'plan',model_policy:policy}).goal;
const nodes=[{key:'analysis',title:'资料分析',instruction:'仅分析用户给的资料',depends_on:[],max_runs:3},{key:'summary',title:'汇总成果',instruction:'汇总前置成果，不重复分析',depends_on:['analysis'],max_runs:2}];
const args=(overrides={})=>({task_id:'parent',revision:1,event_id:'create',goal,policy,source,nodes,max_total_runs:4,end_at:START+86400000,...overrides});
function fixture(t,io={}){const root=mkdtempSync(tmpdir()+'/workflow-');let now=START,jobs=new TaskJobs(root,()=>now),w=new TaskWorkflows(jobs,io);t.after(()=>{jobs.close();rmSync(root,{recursive:true,force:true});});return {get jobs(){return jobs;},get w(){return w;},advance:n=>now+=n,reopen(){jobs.close();jobs=new TaskJobs(root,()=>now);w=new TaskWorkflows(jobs,io);},claim(){return jobs.claim(caps,caps,j=>w.canClaim(j));},done(){const j=this.claim();assert.ok(j);jobs.finish(j,{outcome:'done',summary:'completed '+w.owner(j.id).key});return j;}};}
test('graph rejects cycles, missing/self dependencies, duplicate keys, hidden tools and excess children',()=>{
 for(const graph of [[...nodes,{...nodes[0]}],[{...nodes[0],depends_on:['analysis']}],[{...nodes[0],depends_on:['missing']}],[{...nodes[0],depends_on:['summary']},nodes[1]],[{...nodes[0],command:'write'}],Array.from({length:7},(_,i)=>({...nodes[0],key:'n'+i}))])assert.throws(()=>workflowGraph(graph),/WORKFLOW_GRAPH_INVALID/);
 assert.deepEqual(workflowGraph(nodes),nodes);
});
test('actual independent jobs share parent model/source; dependency result is preserved, no parent worker needed',t=>{
 const f=fixture(t),w=f.w.create(args());assert.equal(w.nodes[0].job_id,null);f.w.tick();const a=f.done();assert.equal(f.w.owner(a.id).key,'analysis');assert.equal(a.version,'0.17.1');
 const b=f.claim();assert.equal(f.w.owner(b.id).key,'summary');assert.notEqual(a.session_id,b.session_id);assert.deepEqual(JSON.parse(b.policy),policy);assert.equal(b.task_id,a.task_id);
 const context=f.w.context(b.id);assert.equal(context.parent_task_id,'parent');assert.equal(context.dependencies[0].checkpoint.summary,'completed analysis');assert.deepEqual(context.activation_source,source);assert.equal(context.development,false);
 f.jobs.finish(b,{outcome:'done',summary:'summary done'});f.w.tick();assert.equal(f.w.get(w.id).status,'completed');assert.deepEqual(f.w.view(f.w.get(w.id)).budget,{used_runs:2,max_runs:4,end_at:START+86400000});
});
test('repeated creation cannot multiply jobs/budgets; same revision or reused direct source needs a new explicit revision/request',t=>{
 const f=fixture(t),w=f.w.create(args());assert.equal(f.w.create(args()).id,w.id);assert.throws(()=>f.w.create(args({max_total_runs:5})),/EVENT_CONFLICT/);
 assert.throws(()=>f.w.create(args({event_id:'different-call'})),/REVISION_ALREADY_USED/);
 f.w.control({id:w.id,action:'cancel',event_id:'cancel',actor:'user'});
 assert.throws(()=>f.w.create(args({event_id:'different-call',revision:2})),/SOURCE_ALREADY_USED/);
});
for(const point of ['afterPrepared','afterEnqueued'])test('crash '+point+' recovers original child IDs and idempotent jobs',t=>{
 let stop=true;const f=fixture(t,{[point](){if(stop){stop=false;throw Error('stop');}}});
 if(point==='afterPrepared')assert.throws(()=>f.w.create(args()),/stop/);else{f.w.create(args());assert.throws(()=>f.w.tick(),/stop/);}
 f.reopen();f.w.tick();f.w.tick();assert.equal(f.jobs.db.prepare('SELECT count(*) n FROM jobs').get().n,2);assert.equal(f.w.list('parent').length,1);f.done();f.done();f.w.tick();assert.equal(f.w.list('parent')[0].status,'completed');
});
test('shared budget includes interruptions and checkpoints, cannot multiply per child maxima',t=>{
 const f=fixture(t),w=f.w.create(args({max_total_runs:2}));f.w.tick();const first=f.claim();f.jobs.finish(first,{outcome:'checkpoint',summary:'partial',delay_seconds:1});f.advance(1000);const second=f.claim();assert.equal(second.id,first.id);f.jobs.finish(second,{outcome:'done',summary:'analysis done'});
 assert.equal(f.claim(),null);f.w.tick();const state=f.w.list('parent')[0];assert.equal(state.status,'needs_review');assert.equal(state.waiting_reason,'shared_budget_exhausted');assert.equal(state.budget.used_runs,2);assert.equal(state.nodes[1].attempts,0);
 assert.throws(()=>f.w.control({id:w.id,action:'resume',event_id:'blind-retry',actor:'user'}),/CONTROL_NOT_ALLOWED/);
});
test('waiting input and pause resume retain child question and shared budget over restart',t=>{
 const f=fixture(t),w=f.w.create(args());f.w.tick();const j=f.claim();f.jobs.finish(j,{outcome:'input',summary:'need data',question:'请选择输入资料'});assert.equal(f.jobs.get(j.id).version,'0.17.1');
 f.w.control({id:w.id,action:'pause',event_id:'pause',actor:'user'});f.reopen();f.jobs.recover(caps);f.w.tick();assert.equal(f.claim(),null);
 f.w.control({id:w.id,action:'resume',event_id:'resume',actor:'user'});assert.equal(f.jobs.get(j.id).status,'waiting_input');assert.equal(f.claim(),null);
 f.jobs.answer({id:j.id,question_run_id:j.run_id,event_id:'answer',source});const done=f.done();assert.equal(done.id,j.id);assert.equal(done.attempts,2);f.done();f.w.tick();assert.equal(f.w.list('parent')[0].budget.used_runs,3);
});
test('last permitted run can finish, but a later child cannot claim a reserved shared slot',t=>{
 const f=fixture(t);f.w.create(args({max_total_runs:2}));f.w.tick();f.done();const j=f.claim();assert.equal(j.attempts,1);f.w.tick();f.w.assertRunning(j);f.jobs.finish(j,{outcome:'done',summary:'last allowed result'});f.w.tick();assert.equal(f.w.list('parent')[0].status,'completed');
});
test('failure or proposal cannot release dependent work and cannot be resumed as approval',t=>{
 const f=fixture(t),w=f.w.create(args());f.w.tick();const j=f.claim();f.jobs.finish(j,{outcome:'proposal',summary:'proposal only',proposal:'may need development later'});assert.equal(f.claim(),null);f.w.tick();assert.equal(f.w.get(w.id).status,'needs_review');assert.equal(f.jobs.get(j.id).status,'waiting_approval');assert.equal(f.w.list('parent')[0].nodes[1].attempts,0);
});
test('deadline fences running worker and preserves review evidence, never resets remaining children',t=>{
 const f=fixture(t),w=f.w.create(args());f.w.tick();const j=f.claim();f.advance(86400000);assert.throws(()=>f.w.assertRunning(j),/EXECUTION_NOT_ALLOWED/);f.w.tick();assert.equal(f.w.get(w.id).status,'needs_review');assert.equal(f.jobs.get(j.id).status,'paused');assert.equal(f.claim(),null);
});
test('paused/cancelled workflow before materialization fences newly recovered child jobs',t=>{
 const f=fixture(t),w=f.w.create(args());f.w.control({id:w.id,action:'pause',event_id:'pause',actor:'user'});f.reopen();f.w.tick();assert.equal(f.claim(),null);assert(f.w.list('parent')[0].nodes.every(n=>n.status==='paused'));
 f.w.control({id:w.id,action:'cancel',event_id:'cancel',actor:'user'});f.reopen();f.w.tick();assert(f.w.list('parent')[0].nodes.every(n=>n.status==='cancelled'));assert.equal(f.w.list('parent')[0].budget.used_runs,0);
});
test('partially delivered pause is durable, cannot be overtaken, resumes only controller-owned children',t=>{
 let fail=true,f;f=fixture(t,{control:a=>{if(fail){fail=false;throw Error('stop');}return f.jobs.control(a);}});const w=f.w.create(args());f.w.tick();
 assert.throws(()=>f.w.control({id:w.id,action:'pause',event_id:'pause',actor:'user'}),/stop/);assert.throws(()=>f.w.control({id:w.id,action:'resume',event_id:'early',actor:'user'}),/CONTROL_PENDING/);assert.equal(f.claim(),null);f.reopen();f.w.tick();assert.deepEqual(f.w.control({id:w.id,action:'pause',event_id:'pause',actor:'user'}),{id:w.id,status:'paused'});
 f.w.control({id:w.id,action:'resume',event_id:'resume',actor:'user'});const child=f.w.list('parent')[0].nodes[0].job_id;f.jobs.control({id:child,action:'pause',event_id:'individual',actor:'user'});f.w.control({id:w.id,action:'pause',event_id:'all-pause',actor:'user'});f.w.control({id:w.id,action:'resume',event_id:'all-resume',actor:'user'});assert.equal(f.jobs.get(child).status,'paused');
});
test('interrupted child consumes a run across restart, never starts a new workflow or duplicate job',t=>{
 const f=fixture(t);f.w.create(args());f.w.tick();const j=f.claim();f.reopen();f.jobs.recover(caps);f.w.tick();const retry=f.claim();assert.equal(retry.id,j.id);assert.notEqual(retry.session_id,j.session_id);assert.equal(retry.attempts,2);assert.equal(f.w.list('parent')[0].budget.used_runs,2);
});
test('orphan lineage version fails closed even if otherwise a plan job',t=>{
 const f=fixture(t),j=f.jobs.enqueue({task_id:'orphan',trigger_id:'orphan',goal,policy,version:'0.17.1'});assert.equal(f.claim(),null);assert.throws(()=>f.w.assertRunning(j),/LINEAGE_INVALID/);
});
test('scheduler actually drains children on group pause; same task cannot overlap even after fast resume',async t=>{
 const root=mkdtempSync(tmpdir()+'/workflow-scheduler-'),s=new TaskScheduler({on(){}},{stateDir:root,lockPort:0,intervalMs:60000,maxConcurrent:2},{allowEphemeralLock:true,now:()=>START});let release,started=0;
 t.after(async()=>{release?.();await s.close();rmSync(root,{recursive:true,force:true});});
 s.executors.set('plan',{replaySafe:true,run:async(_j,signal)=>{started++;await new Promise(r=>{release=r;signal.addEventListener('abort',()=>{}, {once:true});});return {outcome:'done',summary:'fixture'};}});await s.start();const w=s.workflows.create(args());s.tick();await new Promise(r=>setImmediate(r));assert.equal(started,1);
 s.workflows.control({id:w.id,action:'pause',event_id:'pause',actor:'user'});assert.equal(s.active.size,1);s.workflows.control({id:w.id,action:'resume',event_id:'resume',actor:'user'});s.tick();assert.equal(started,1);release();await Promise.all([...s.active.values()].map(x=>x.run));assert.equal(s.active.size,0);s.tick();await new Promise(r=>setImmediate(r));assert.equal(started,2);release();await Promise.all([...s.active.values()].map(x=>x.run));
});
test('deterministic schedule/workflow refusals are not transient retry instructions',()=>{
 for(const code of ['SCHEDULER_RULE_INVALID','SCHEDULER_INPUT_BUDGET_EXHAUSTED','SCHEDULER_CONTROL_NOT_ALLOWED','SCHEDULER_SIGNAL_NOT_ACCEPTED','SCHEDULER_INPUT_STALE','SCHEDULER_CONTROL_PENDING','WORKFLOW_GRAPH_INVALID','WORKFLOW_REVISION_ALREADY_USED','WORKFLOW_DEADLINE_REACHED','WORKFLOW_TASK_BUSY','WORKFLOW_NATIVE_TASK_REQUIRED','SCHEDULER_NATIVE_TASK_REQUIRED','TASK_REGISTER_ONLY']){const e=errorInfo(code);assert.equal(e.code,code);assert.equal(e.category,'validation_or_review',code);assert.equal(e.retry,'operator_review');}
 for(const code of ['SCHEDULER_UNAVAILABLE','SCHEDULER_TICK_FAILED'])assert.equal(errorInfo(code).category,'transient');
});
