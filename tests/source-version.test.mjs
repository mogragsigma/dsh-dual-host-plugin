import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {TaskJobs} from '../bundle/task-jobs.js';
import {TaskJobs as OldJobs} from './fixtures/task-jobs-v017.js';
import {TaskWorkflows} from '../bundle/task-workflows.js';
import {TaskTriggers} from '../bundle/task-triggers.js';
import {jobLineage} from '../bundle/task-board-planning.js';
import {makeEnvelope,selectedHumanContext} from '../bundle/task-envelope.js';
const caps=new Set(['plan']),policy={provider:'task-provider',model:'task-model'};
const agent={id:'entry',session:{deriveMessages:()=>[{id:'m',role:'user',source:{kind:'user'},content:[{type:'text',text:'只读分析 https://example.com/read，最多两批，不开发。'}]}]}};
const source=selectedHumanContext(agent,'cloud');
const goal=makeEnvelope(agent,'cloud',{goal:'只读分析',target:'cloud',intent:'plan',model_policy:policy,references:[{kind:'url',title:'明确资料',uri:'https://example.com/read'}]}).goal;
const input=(id,version='0.5.0')=>({task_id:id,trigger_id:id,goal,policy,max_runs:2,version});
for(const [requested,expected] of [['0.5.0','0.18.0'],['0.17.0','0.18.0'],['0.17.1','0.18.1']])test('new referenced job upgrades '+requested+' to '+expected+' and old real consumer refuses it',()=>{
 const root=mkdtempSync(tmpdir()+'/source-version-');let jobs=new TaskJobs(root);
 try{
  const a=jobs.enqueue(input('a',requested)),b=jobs.enqueue(input('b',requested));assert.equal(a.version,expected);assert.equal(jobs.enqueue(input('a',requested)).id,a.id);
  const running=jobs.claim(caps,caps);jobs.close();jobs=new OldJobs(root);jobs.recover(caps);assert.equal(jobs.claim(caps,caps),null);
  assert.equal(jobs.get(a.id).status,'needs_review');assert.equal(jobs.get(b.id).status,'needs_review');assert.equal(jobs.get(running.id).attempts,1);
  jobs.close();jobs=new TaskJobs(root);jobs.recover(caps);assert.equal(jobs.claim(caps,caps),null);assert.deepEqual(JSON.parse(jobs.get(running.id).policy),policy);
 }finally{jobs.close();rmSync(root,{recursive:true,force:true});}
});
test('legacy pending source jobs are held by new consumer, not silently granted upgraded read capability',()=>{
 const root=mkdtempSync(tmpdir()+'/source-old-');let jobs=new OldJobs(root);
 try{
  const a=jobs.enqueue(input('a','0.17.0')),b=jobs.enqueue(input('b','0.17.1'));const run=jobs.claim(caps,caps);jobs.close();jobs=new TaskJobs(root);jobs.recover(caps);assert.equal(jobs.claim(caps,caps),null);
  assert.equal(jobs.get(run.id).status,'needs_review');assert.equal(jobs.get(run.id).attempts,1);const pending=run.id===a.id?b:a;assert.equal(jobs.get(pending.id).error,'SOURCE_JOB_VERSION_REQUIRED');assert.equal(jobs.get(pending.id).attempts,0);
  assert.equal(jobs.enqueue(input('a','0.17.0')).id,a.id);assert.equal(jobs.get(a.id).version,'0.17.0');assert.throws(()=>jobs.enqueue({...input('a','0.17.0'),policy:{...policy,model:'other'}}),/TRIGGER_CONFLICT/);assert.equal(jobs.db.prepare('SELECT count(*) n FROM jobs').get().n,2);
 }finally{jobs.close();rmSync(root,{recursive:true,force:true});}
});
for(const family of ['trigger','workflow'])test('interrupted legacy '+family+' linking reconciles original job without blocking unrelated work',()=>{
 const root=mkdtempSync(tmpdir()+'/source-link-'),now=Date.now();let jobs=new OldJobs(root,()=>now);
 try{
  const io={afterEnqueued(){throw Error('fixture crash before link');}},owner=family==='trigger'?new TaskTriggers(jobs,io):new TaskWorkflows(jobs,io);
  const a={task_id:'legacy',revision:1,event_id:'old',goal,policy,source};
  if(family==='trigger')owner.create({...a,timing:{rule:{kind:'once',at:now},end_at:now+60000,max_occurrences:1,max_runs:1}});
  else owner.create({...a,nodes:[{key:'read',title:'读取',instruction:'只读资料',depends_on:[],max_runs:1}],max_total_runs:1,end_at:now+60000});
  assert.throws(()=>owner.tick(),/fixture crash/);const original=jobs.list('legacy')[0];assert(original);jobs.close();jobs=new TaskJobs(root,()=>now);
  const resumed=family==='trigger'?new TaskTriggers(jobs):new TaskWorkflows(jobs);assert.doesNotThrow(()=>resumed.tick());assert.equal(jobs.list('legacy').length,1);
  const other=jobs.enqueue({task_id:'other',trigger_id:'other',goal:'无资料的独立只读任务',policy});const run=jobs.claim(caps,caps,j=>resumed.canClaim(j));assert.equal(run.id,other.id);assert.equal(jobs.claim(caps,caps,j=>resumed.canClaim(j)),null);assert.equal(jobs.get(original.id).status,'needs_review');assert.equal(jobs.get(original.id).attempts,0);assert.equal(jobs.get(original.id).error,'SOURCE_JOB_VERSION_REQUIRED');
 }finally{jobs.close();rmSync(root,{recursive:true,force:true});}
});
test('source workflow keeps lineage fence, dependency gates and version when waiting for input',()=>{
 const root=mkdtempSync(tmpdir()+'/source-lineage-'),jobs=new TaskJobs(root),w=new TaskWorkflows(jobs);
 try{
  const graph=w.create({task_id:'parent',revision:1,event_id:'workflow',goal,policy,source,nodes:[{key:'read',title:'读取',instruction:'只读',depends_on:[],max_runs:2},{key:'report',title:'汇总',instruction:'汇总',depends_on:['read'],max_runs:1}],max_total_runs:3,end_at:Date.now()+3600000});w.tick();
  const j=jobs.claim(caps,caps,x=>w.canClaim(x));assert.equal(j.version,'0.18.1');assert.equal(jobLineage({scheduler:{jobs}},j).kind,'child');
  jobs.finish(j,{outcome:'input',summary:'需要补充',question:'资料范围？'});assert.equal(jobs.get(j.id).version,'0.18.1');assert.equal(jobs.claim(caps,caps,x=>w.canClaim(x)),null);
  const orphan=jobs.enqueue(input('orphan','0.17.1'));assert.equal(orphan.version,'0.18.1');assert.equal(w.canClaim(orphan),false);assert.throws(()=>w.assertRunning(orphan),/LINEAGE_INVALID/);assert.equal(jobLineage({scheduler:{jobs}},orphan).kind,'unavailable');
  assert.equal(w.view(w.get(graph.id)).budget.used_runs,1);
 }finally{jobs.close();rmSync(root,{recursive:true,force:true});}
});
