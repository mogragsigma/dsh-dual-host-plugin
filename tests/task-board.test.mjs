import {test} from 'node:test';import assert from 'node:assert/strict';
import {TaskBoard,queueReason,installTaskBoard} from '../bundle/task-board.js';
import {fixture} from './approval-fixture.mjs';
import {RepositoryCatalog} from '../bundle/repository-catalog.js';
import {TaskJobs} from '../bundle/task-jobs.js';
import {CAPABILITIES,requireCapability} from '../bundle/link-contract.js';
function setup(t){const f=fixture(t),jobs=new TaskJobs(f.dir+'/jobs');t.after(()=>jobs.close());const g={c:{role:'cloud'},store:f.store,catalog:f.catalog,approvals:f.ledger,repositories:new RepositoryCatalog(f.store,f.catalog,null),scheduler:{jobs,active:new Map()},now:()=>1792300000000,instanceId:'test',hello:()=>({plugin_version:'0.13.0'}),inboundSnapshot:()=>({state:'unknown'})};return {...f,g,board:new TaskBoard({get:()=>null},g)};}
function dbRows(db){return db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>[name,db.prepare(`SELECT * FROM ${name}`).all()]);}
test('list/detail are pure reads, include unbound and unindexed legacy tasks without migration',async t=>{const f=setup(t),legacy=f.store.accept('local',{task_key:'old',goal:'旧任务无需仓库',ingress_id:'old',source:'native-local'}),before=JSON.stringify(dbRows(f.store.db));const list=await f.board.call('board_list',{});assert.equal(list.total,2);assert(list.items.every(t=>t.repository.state==='unbound'));assert(list.items.some(x=>x.task_id===legacy.id&&x.legacy));const d=await f.board.call('board_detail',{task_id:legacy.id});assert.equal(d.item.runs.length,0);assert.equal(d.item.artifacts.state,'not_registered');assert.equal(JSON.stringify(dbRows(f.store.db)),before);});
test('search uses names and bounded pagination, rejects arbitrary file/session arguments',async t=>{const f=setup(t);assert.equal((await f.board.call('board_list',{query:'聊天审批'})).total,1);assert.equal((await f.board.call('board_list',{query:'不存在'})).total,0);for(const a of [{limit:51},{after:-1},{session_id:'secret'},{query:3}])await assert.rejects(f.board.call('board_list',a),/INVALID/);await assert.rejects(f.board.call('board_detail',{task_id:f.task.id,path:'/secret'}),/INVALID/);});
test('approval effective state and receipt are independent; private identity evidence is absent',async t=>{const f=setup(t),{r,prompt}=await f.start();f.reply(prompt);await f.chat.tick();await f.chat.tick();const before=JSON.stringify(dbRows(f.store.db)),d=await f.board.call('board_detail',{task_id:f.task.id}),a=d.item.approvals[0];assert.equal(a.state,'approved');assert.equal(a.execution_enabled,false);assert(a.receipt);assert(!JSON.stringify(d).includes('ou_owner'));assert(!JSON.stringify(d).includes('proof_hash'));assert.equal(JSON.stringify(dbRows(f.store.db)),before);f.time(86400001);const expired=(await f.board.call('board_detail',{task_id:f.task.id})).item.approvals[0];assert.equal(expired.state,'expired');assert.equal(expired.recorded_state,'approved');});
test('model evidence is limited to task-owned runs, excludes inherited contexts and does not imply success',async t=>{const f=setup(t),j=f.g.scheduler.jobs.enqueue({task_id:f.task.id,trigger_id:'test',goal:'x',policy:{model:'requested'}});f.g.scheduler.jobs.db.prepare("INSERT INTO runs VALUES ('r',?,'claim','owned','failed',1,2,NULL)").run(j.id);let reads=0;f.board.ctx={get:()=>({readSession:async id=>{assert.equal(id,'owned');reads++;return {inheritedEventCount:1,events:[{type:'request/context',data:{model:'inherited'}},{type:'request/context',seq:2,time:3,data:{model:'actual',provider:'observed',apiKey:'SECRET'}},{type:'user/message',data:{text:'SECRET'}}]};}})};const d=await f.board.call('board_detail',{task_id:f.task.id});assert.equal(d.item.jobs[0].requested_model.model,'requested');assert.equal(d.item.runs[0].actual_models.items[0].model,'actual');assert.equal(d.item.runs[0].actual_models.proves_completion,false);assert.equal(d.item.runs[0].actual_models.proves_dispatch,false);assert.equal(d.item.runs[0].actual_models.durability,'not_attested');assert(!JSON.stringify(d).includes('SECRET'));await f.board.call('board_detail',{task_id:f.task.id});assert.equal(reads,1);});
test('missing model evidence is explicit and malformed logs do not fail the task board',async t=>{const f=setup(t);assert.equal((await f.board.models({})).state,'unavailable');f.board.ctx={get:()=>({readSession:async()=>{throw Error('secret');}})};assert.equal((await f.board.models({id:'r'})).state,'unavailable');});
test('queue reasons distinguish due time, active worker, blocked task and pause draining',t=>{const f=setup(t),g=f.g,j={id:'j',kind:'plan',status:'queued',due:g.now()+1};assert.equal(queueReason(j,g,{}),'scheduled_time');j.due=0;assert.equal(queueReason(j,g,{}),'awaiting_scheduler');g.scheduler.active.set('other',{});assert.equal(queueReason(j,g,{}),'worker_busy');assert.equal(queueReason(j,g,{busy:true}),'task_busy');assert.equal(queueReason(j,g,{blocked:true}),'task_blocked');g.scheduler.active.set('j',{});j.status='paused';assert.equal(queueReason(j,g,{}),'draining');});
test('UI endpoint denies writes and returns no-store; capability rejects older peer',async t=>{const f=setup(t);let route;const sub={get:()=>null,effect(){},connection:{fetch:{register:r=>route=r}}};installTaskBoard({inject:(_deps,fn)=>fn(sub)},f.g);const r=await route.fetch(new Request('http://localhost/api/task-board/control',{method:'POST',body:JSON.stringify({type:'client-request',rpcId:'1',method:'task-board/control',payload:{method:'approve',args:{}}})}));assert.equal(r.headers.get('cache-control'),'no-store');const failure=(await r.json()).result.error;assert.equal(failure.code,'METHOD_DENIED');assert.equal(typeof failure.message,'string');assert.equal(failure.details.viewer.role,'cloud');const own={schema:1,protocol:{min:1,max:1},plugin_version:'0.13.0',role:'local',namespace:'test',instance_id:'00000000-0000-0000-0000-000000000000',capabilities:CAPABILITIES};const remote={...own,role:'cloud',capabilities:{catalog:1}};assert.throws(()=>requireCapability('board_list',own,remote),/CAPABILITY_UNAVAILABLE/);});
test('an unfinished old batch is not hidden behind fifty completed newer batches',async t=>{const f=setup(t),db=f.g.scheduler.jobs.db;for(let i=0;i<55;i++){const j=f.g.scheduler.jobs.enqueue({task_id:f.task.id,trigger_id:'job-'+i,goal:'x'});db.prepare('UPDATE jobs SET status=?,created=? WHERE id=?').run(i===0?'needs_review':'completed',i,j.id);}const item=(await f.board.call('board_list',{})).items[0];assert.equal(item.jobs_total,55);assert.equal(item.jobs.length,50);assert.equal(item.jobs[0].status,'needs_review');});
test('malformed historical envelope remains displayable rather than hiding every task',async t=>{const f=setup(t);f.store.accept('local',{task_key:'bad',goal:JSON.stringify({schema:'dsh-native-task-v1',invalid:true}),ingress_id:'bad',source:'old'});assert.equal((await f.board.call('board_list',{})).total,2);});
test('pending local ingress is not claimed as a cloud task and errors do not echo raw traces',async()=>{const {DatabaseSync}=await import('node:sqlite'),{boardPending}=await import('../bundle/task-board.js');const db=new DatabaseSync(':memory:');try{db.exec('CREATE TABLE submissions(id,payload,status,attempts,next_attempt_at,last_error)');db.prepare('INSERT INTO submissions VALUES (?,?,?,?,?,?)').run('i',JSON.stringify({goal:'本地未受理任务'}),'needs_review',3,0,'SECRET raw trace');const [p]=boardPending({db});assert.equal(p.title,'本地未受理任务');assert.equal(p.authority,'entry_only_not_cloud_task');assert.equal(p.error,'TRANSIENT_FAILURE');assert(!JSON.stringify(p).includes('SECRET'));}finally{db.close();}});
test('known worker and recovery reasons survive redaction rather than becoming generic transient failures',async t=>{const f=setup(t),j=f.g.scheduler.jobs.enqueue({task_id:f.task.id,trigger_id:'budget',goal:'x'});for(const error of ['RUN_BUDGET_EXHAUSTED','HOST_RESTARTED','WORKER_MODEL_QUOTA','DEVELOPMENT_ADAPTER_NOT_ENABLED']){f.g.scheduler.jobs.db.prepare("UPDATE jobs SET status='needs_review',error=? WHERE id=?").run(error,j.id);assert.equal((await f.board.call('board_detail',{task_id:f.task.id})).item.jobs[0].error,error);}});

// Public projections of real candidate stores; no model, IM or repository side effects.
import {TaskTriggers} from '../bundle/task-triggers.js';
import {TaskWorkflows} from '../bundle/task-workflows.js';
import {makeEnvelope,selectedHumanContext} from '../bundle/task-envelope.js';
function planned(t){
 const f=setup(t),g=f.g;g.scheduler.triggers=new TaskTriggers(g.scheduler.jobs);g.scheduler.workflows=new TaskWorkflows(g.scheduler.jobs);
 const p={provider:'per-task',model:'task-selected'},sourceAgent={id:'planning-source',session:{deriveMessages:()=>[{id:'planning-m1',role:'user',source:{kind:'user'},content:[{type:'text',text:'SOURCE_PRIVATE fixture explicitly plans a bounded read-only task'}]}]}};
 const e=makeEnvelope(sourceAgent,'cloud',{goal:'INSTRUCTION_PRIVATE interpretation',title:'计划视图夹具',target:'cloud',intent:'plan',model_policy:p});
 const task=g.store.accept('cloud',{goal:e.goal,task_key:e.task_key,source:'native-cloud',ingress_id:e.ingress_id});g.catalog.head(task.id);
 const args={task_id:task.id,revision:1,goal:e.goal,policy:p,source:selectedHumanContext(sourceAgent,'cloud'),event_id:'planning-fixture'};
 return {...f,task,args,p};
}
test('future/event schedules with no jobs have visible wait state; both databases remain byte-equivalent rows',async t=>{
 const f=planned(t),now=Date.now(),s=f.g.scheduler.triggers.create({...f.args,timing:{rule:{kind:'once',at:now+3600000},end_at:now+86400000,max_occurrences:1,max_runs:2}});
 const before=[dbRows(f.g.store.db),dbRows(f.g.scheduler.jobs.db)];const d=(await f.board.call('board_detail',{task_id:f.task.id})).item;
 assert.equal(d.display_state,'waiting_time');assert.equal(d.jobs.length,0);assert.equal(d.planning.schedules[0].budget.max_runs,2);assert.equal(d.planning.schedules[0].rule.kind,'once');assert(!JSON.stringify(d).includes('SOURCE_PRIVATE'));assert(!JSON.stringify(d).includes('INSTRUCTION_PRIVATE'));assert.deepEqual([dbRows(f.g.store.db),dbRows(f.g.scheduler.jobs.db)],before);
 f.g.scheduler.jobs.db.prepare("UPDATE task_schedules SET timing=? WHERE id=?").run(JSON.stringify({rule:{kind:'event',name:'资料就绪'},end_at:now+86400000,max_occurrences:1,max_runs:2}),s.id);assert.equal((await f.board.call('board_list',{})).items.find(x=>x.task_id===f.task.id).display_state,'waiting_event');
});
const childGraph=[{key:'analysis',title:'资料分析',instruction:'NODE_INSTRUCTION_PRIVATE',depends_on:[],max_runs:3},{key:'summary',title:'汇总说明',instruction:'NODE_INSTRUCTION_PRIVATE second',depends_on:['analysis'],max_runs:2}];
test('child titles, exact dependency state and shared budget render without exposing activation text or node instructions',async t=>{
 const f=planned(t),s=f.g.scheduler,w=s.workflows.create({...f.args,nodes:childGraph,max_total_runs:4,end_at:Date.now()+86400000});s.workflows.tick();const j=s.jobs.claim(new Set(['plan']),new Set(['plan']),j=>s.workflows.canClaim(j));s.jobs.finish(j,{outcome:'input',summary:'checkpoint',question:'覆盖几周？'});
 const before=[dbRows(f.g.store.db),dbRows(s.jobs.db)],d=(await f.board.call('board_detail',{task_id:f.task.id})).item,graph=d.planning.workflows[0];
 assert.equal(d.display_state,'waiting_input');assert.equal(graph.budget.used_runs,1);assert.equal(graph.budget.max_runs,4);assert.equal(graph.nodes[1].state,'waiting_dependency');assert.equal(graph.nodes[1].dependencies[0].title,'资料分析');assert.equal(graph.nodes[1].dependencies[0].status,'waiting_input');assert.equal(graph.nodes[0].question,'覆盖几周？');assert.equal(d.jobs.find(x=>x.id===j.id).lineage.title,'资料分析');assert.equal(d.runs[0].lineage.title,'资料分析');assert.deepEqual(graph.model_policy.model,f.p.model);
 for(const secret of ['SOURCE_PRIVATE','INSTRUCTION_PRIVATE','NODE_INSTRUCTION_PRIVATE'])assert(!JSON.stringify(d).includes(secret));assert.deepEqual([dbRows(f.g.store.db),dbRows(s.jobs.db)],before);
});
test('deadline, shared exhaustion and pending control remain observations, not UI-driven scheduler writes',async t=>{
 const f=planned(t),s=f.g.scheduler,w=s.workflows.create({...f.args,nodes:childGraph,max_total_runs:2,end_at:Date.now()+86400000});s.workflows.tick();s.jobs.db.prepare("UPDATE jobs SET status='completed',attempts=2 WHERE id=?").run(s.workflows.nodes(w.id)[0].job_id);
 const view=async()=>(await f.board.call('board_detail',{task_id:f.task.id})).item;assert.equal((await view()).display_state,'shared_budget_exhausted');assert.equal(s.workflows.get(w.id).status,'active');
 s.jobs.db.prepare('UPDATE task_workflows SET end_at=1 WHERE id=?').run(w.id);assert.equal((await view()).display_state,'deadline_reached');assert.equal(s.workflows.get(w.id).status,'active');
 s.jobs.db.prepare('INSERT INTO workflow_controls VALUES (?,?,?)').run('pending','f',JSON.stringify({id:w.id,phase:'prepared'}));assert.equal((await view()).display_state,'workflow_control_pending');assert.equal(s.workflows.pending(w.id),true);
});
test('historical completed graph does not make a newly amended register-only revision look completed',async t=>{
 const f=planned(t),s=f.g.scheduler,w=s.workflows.create({...f.args,nodes:childGraph,max_total_runs:2,end_at:Date.now()+86400000});s.workflows.tick();s.jobs.db.prepare("UPDATE jobs SET status='completed',attempts=1 WHERE task_id=?").run(f.task.id);s.workflows.tick();assert.equal(s.workflows.get(w.id).status,'completed');
 const a={id:'new-session',session:{deriveMessages:()=>[{id:'new-m',role:'user',source:{kind:'user'},content:[{type:'text',text:'修改目标，仅登记，不开始。'}]}]}};
 f.catalog.amend('cloud',{task_id:f.task.id,expected_revision:1,event_id:'amend',summary:'仅登记新目标',intent:'register',sources:selectedHumanContext(a,'cloud')},()=>{});
 const d=(await f.board.call('board_detail',{task_id:f.task.id})).item;assert.equal(d.spec_revision,2);assert.equal(d.planning.workflows[0].spec_revision,1);assert.equal(d.display_state,'registered');
});
test('resource reason uses actual configured capacity and holds same task until teardown',t=>{
 const f=planned(t),g=f.g,j={id:'pending',task_id:f.task.id,kind:'plan',status:'queued',due:0};g.scheduler.maxConcurrent=2;g.scheduler.active.set('other',{task_id:'other'});assert.equal(queueReason(j,g,{}),'awaiting_scheduler');g.scheduler.active.set('same',{task_id:f.task.id});assert.equal(queueReason(j,g,{}),'same_task_busy');g.scheduler.active.delete('same');g.scheduler.active.set('other2',{task_id:'other2'});assert.equal(queueReason(j,g,{}),'worker_busy');
});
test('old stores show unavailable planning, and malformed child ownership never discloses another task question',async t=>{
 const old=setup(t),d=(await old.board.call('board_detail',{task_id:old.task.id})).item;assert.deepEqual(d.planning.available,{schedules:false,workflows:false});
 const f=planned(t),s=f.g.scheduler,w=s.workflows.create({...f.args,nodes:childGraph,max_total_runs:3,end_at:Date.now()+86400000});s.workflows.tick();
 const n=s.workflows.nodes(w.id)[0];s.jobs.db.prepare('UPDATE jobs SET task_id=?,checkpoint=? WHERE id=?').run('wrong-task',JSON.stringify({question:'OTHER_TASK_SECRET'}),n.job_id);const view=(await f.board.call('board_detail',{task_id:f.task.id})).item;assert(!JSON.stringify(view).includes('OTHER_TASK_SECRET'));assert.equal(view.planning.workflows[0].nodes[0].status,'unavailable');assert.equal(view.display_state,'lineage_unavailable');
});
test('planning projection is bounded and prioritizes unresolved historical graphs',async t=>{
 const f=planned(t),s=f.g.scheduler,w=s.workflows.create({...f.args,nodes:childGraph,max_total_runs:3,end_at:Date.now()+86400000});s.workflows.tick();s.jobs.db.prepare("UPDATE task_workflows SET status='needs_review' WHERE id=?").run(w.id);
 for(let i=2;i<=25;i++)s.jobs.db.prepare("INSERT INTO task_workflows SELECT ?,?,fingerprint,task_id,?,goal,policy,source,'completed',max_runs,end_at,reason,created+? FROM task_workflows WHERE id=?").run('old-'+i,'old-event-'+i,i,i,w.id);
 const p=(await f.board.call('board_detail',{task_id:f.task.id})).item.planning;assert.equal(p.workflows_total,25);assert.equal(p.workflows.length,20);assert.equal(p.workflows[0].id,w.id);assert.equal(p.workflows[0].state,'workflow_needs_review');
});


test('authenticated board discovery only forwards public read and never exposes add/bind methods',async t=>{
 const f=setup(t);let route,calls=[];f.g.call=async(method,args)=>{calls.push([method,args]);return {host:'cloud',items:[],grants_delivery:false};};
 installTaskBoard({inject:(_deps,fn)=>fn({get:()=>null,effect(){},connection:{fetch:{register:r=>route=r}}})},f.g);
 const request=async(method,args)=>(await route.fetch(new Request('http://localhost/api/task-board/control',{method:'POST',body:JSON.stringify({type:'client-request',rpcId:'discovery',method:'task-board/control',payload:{method,args}})}))).json();
 const r=await request('notification-discover',{host:'cloud'});assert(r.result.ok);assert.equal(r.result.value.grants_delivery,false);assert.equal(r.result.value.viewer_role,'cloud');
 for(const method of ['notification_target_add','notification_bind','sendChecked'])assert.equal((await request(method,{})).result.error.code,'METHOD_DENIED');
 assert.deepEqual(calls,[['notification_discover',{host:'cloud'}]]);
});

test('enabled development queue reports real resource conditions, not the old disabled placeholder',t=>{
 const f=setup(t),g=f.g,j={id:'dev',kind:'development',version:'0.21.0',status:'queued',due:0};
 assert.equal(queueReason(j,g,{}),'development_disabled');g.development={requestFor:()=>({id:'r'}),gate:{waiting:()=> 'development_resource_busy'}};
 assert.equal(queueReason(j,g,{}),'development_resource_busy');g.development.gate.waiting=()=>null;assert.equal(queueReason(j,g,{}),'awaiting_scheduler');
 assert.equal(queueReason({...j,version:'0.19.2'},g,{}),'development_version_review');
 g.development.requestFor=()=>{throw Error('unbound');};assert.equal(queueReason(j,g,{}),'development_review');
});

 test('workspace queue version projects actual wait without granting execution',t=>{
 const {g}=setup(t),j={id:'workspace',kind:'development',version:'0.22.0',status:'queued',due:0};
 let reads=0;g.development={requestFor:()=>{reads++;return {id:'r'};},gate:{waiting:()=> 'development_fifo'}};
 assert.equal(queueReason(j,g,{}),'development_fifo');assert.equal(reads,1);
 g.development.gate.waiting=()=>null;assert.equal(queueReason(j,g,{}),'awaiting_scheduler');
 assert.equal(queueReason({...j,version:'0.23.0'},g,{}),'development_version_review');
 });
