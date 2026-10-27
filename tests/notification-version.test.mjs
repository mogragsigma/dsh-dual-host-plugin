import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {makeEnvelope,parseEnvelope,selectedHumanContext} from '../bundle/task-envelope.js';
import {TaskJobs} from '../bundle/task-jobs.js';
import {TaskTriggers} from '../bundle/task-triggers.js';
import {TaskWorkflows} from '../bundle/task-workflows.js';
import {TaskJobs as OldJobs} from './fixtures/alpha4/task-jobs.js';
import {TaskTriggers as OldTriggers} from './fixtures/alpha4/task-triggers.js';
import {TaskWorkflows as OldWorkflows} from './fixtures/alpha4/task-workflows.js';
import {parseEnvelope as oldParse} from './fixtures/alpha4/task-envelope.js';
import {queueDiagnostics} from '../bundle/diagnostics.js';
import {requireCapability} from '../bundle/link-contract.js';
const p={provider:'any-task-provider',model:'explicit-model',reasoningEffort:'high'},caps=new Set(['plan']);
const agent={id:'fixture',session:{deriveMessages:()=>[{id:'m',role:'user',source:{kind:'user'},content:[{type:'text',text:'只读任务，通知契约夹具，不调用模型'}]}]}};
const goal=makeEnvelope(agent,'cloud',{title:'通知契约',goal:'无模型',target:'cloud',intent:'plan',model_policy:p,notification_contract:1}).goal,source=selectedHumanContext(agent,'cloud');
test('notification executor is mandatory; old native parser cannot silently execute it with old fixed-destination semantics',()=>{
 assert.equal(parseEnvelope(goal).notification_contract,1);assert.throws(()=>oldParse(goal),/INVALID_TASK_ENVELOPE/);
 for(const o of [{executor:'independent-readonly-worker'},{notification_contract:2}])assert.throws(()=>parseEnvelope(JSON.stringify({...JSON.parse(goal),...o})),/INVALID_TASK_ENVELOPE/);
 const hello=role=>({schema:1,protocol:{min:1,max:1},plugin_version:'0.19.0-alpha.1',role,namespace:'fixture',instance_id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',capabilities:{intake:1,notifications:1,catalog:1}}),l=hello('local'),c=hello('cloud');assert.doesNotThrow(()=>requireCapability('accept',l,c,{goal}));delete c.capabilities.notifications;
 assert.throws(()=>requireCapability('accept',l,c,{goal}),/CAPABILITY_VERSION/);assert.throws(()=>requireCapability('task_amend',l,c,{notification_contract:1}),/CAPABILITY_VERSION/);
});
for(const [kind,requested,expected] of [['plan','0.5.0','0.19.0'],['plan','0.17.1','0.19.1'],['development','0.5.0','0.19.2']])test('real prior consumer holds notification '+kind+' '+expected+' without leaking a job notice',()=>{
 const root=mkdtempSync(tmpdir()+'/notification-version-');let jobs=new TaskJobs(root);
 try{
  const j=jobs.enqueue({task_id:'task',trigger_id:'request',kind,goal,policy:p,version:requested,max_runs:1});assert.equal(j.version,expected);
  if(kind==='development'){
   assert.equal(j.status,'waiting_approval');
   // Synthetic fixture only: exercise the old consumer's boundary AFTER a simulated approval.
   // An untouched waiting_approval row is already held and is not scanned by claim().
   jobs.db.prepare("UPDATE jobs SET status='queued',approved_by='synthetic-test-only' WHERE id=?").run(j.id);
  }
  jobs.close();jobs=new OldJobs(root);jobs.recover(new Set(['plan','development']));assert.equal(jobs.claim(new Set(['plan','development']),caps),null);assert.equal(jobs.get(j.id).status,'needs_review');assert.equal(jobs.get(j.id).attempts,0);assert.equal(jobs.db.prepare('SELECT count(*) n FROM job_notifications').get().n,0);
 }finally{jobs.close();rmSync(root,{recursive:true,force:true});}
});
for(const family of ['trigger','workflow'])test('old '+family+' ignores pending notification jobs and unrelated tasks continue',()=>{
 const root=mkdtempSync(tmpdir()+'/notification-prepared-'),now=Date.now();let jobs=new TaskJobs(root,()=>now);
 try{
  const owner=family==='trigger'?new TaskTriggers(jobs,{afterPrepared(){throw Error('stop fixture');}}):new TaskWorkflows(jobs,{afterPrepared(){throw Error('stop fixture');}}),a={task_id:'notified',revision:1,event_id:'prepare',goal,policy:p,source};
  if(family==='trigger'){owner.create({...a,timing:{rule:{kind:'once',at:now},end_at:now+60000,max_occurrences:1,max_runs:1}});assert.throws(()=>owner.tick(),/stop fixture/);}else assert.throws(()=>owner.create({...a,nodes:[{key:'child',title:'child',instruction:'fixture',depends_on:[],max_runs:1}],max_total_runs:1,end_at:now+60000}),/stop fixture/);
  assert.equal(owner.list('notified')[0].status,'active-notify');assert.equal(queueDiagnostics({now:()=>now,scheduler:{jobs}})[family==='trigger'?'schedules':'workflows'].pending,1);jobs.close();jobs=new OldJobs(root,()=>now);const older=family==='trigger'?new OldTriggers(jobs):new OldWorkflows(jobs);assert.doesNotThrow(()=>older.tick());assert.equal(jobs.list('notified').length,0);
  const legacy=jobs.enqueue({task_id:'independent',trigger_id:'legacy',goal:'legacy independent',policy:p});assert.equal(jobs.claim(caps,caps).id,legacy.id);
  jobs.close();jobs=new TaskJobs(root,()=>now);const fresh=family==='trigger'?new TaskTriggers(jobs):new TaskWorkflows(jobs);fresh.tick();assert.equal(jobs.list('notified').length,1);assert.equal(jobs.get(jobs.list('notified')[0].id).version,family==='trigger'?'0.19.0':'0.19.1');
 }finally{jobs.close();rmSync(root,{recursive:true,force:true});}
});
