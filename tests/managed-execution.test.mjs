import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {fixture} from './helpers/continuity-fixture.mjs';
const policy={provider:'fixture',model:'fixture'};
function setup(t){const f=fixture(t,{managedExecution:{enabled:true}});f.g.ctx.llm.resolveCallConfig=async p=>Object.keys(p).length?p:policy;return f;}
async function contract(f,name,role='cloud',extra={}){
 const id=await f.create(name),cwd=join(f.dir,name);mkdirSync(cwd);
 const proposal=await f.g.call('execution_prepare',{task_id:id,expected_revision:1,role,cwd:realpathSync(cwd),scope:'实现本任务，不推送，不改系统',model_policy:policy,event_id:'plan-'+id,...extra});
 assert.equal(proposal.state,'pending');
 f.g.continuity.decide('cloud',{request_id:proposal.id,expected_revision:1,proposal_hash:proposal.proposal_hash,expected_decision_id:null,action:'approve',source:f.source('同意','cloud','approve-'+id)});
 const queued=await f.g.call('execution_enqueue',{task_id:id,approval_id:proposal.id});return {id,cwd,proposal,queued};
}
const own=r=>({task_id:r.task_id,claim:r.claim,instance_id:r.instance});
function start(f,role='cloud',instance='worker'){const r=f.g.execution.claim(role,{instance_id:instance}).item;return r?f.g.execution.begin(role,own(r)).item:null;}
function finish(f,r,extra={}){return f.g.execution.finish(r.role,{...own(r),session_id:'managed-'+r.task_id,drained:true,outcome:'ready',summary:'已生成任务成果，未对外交付',...extra});}

test('one task-level proposal, no IM prerequisites; cloud cwd is not file sandbox',async t=>{
 const f=setup(t),c=await contract(f,'one');assert.equal(c.proposal.proposal.model_policy.reasoningEffort,undefined);
 assert.equal(c.queued.filesystem,'host-account');assert.equal(c.queued.state,'queued');assert.equal(f.sideEffects.agents,0);
 assert.equal(f.g.store.db.prepare('SELECT count(*) n FROM approval_credentials').get().n,0);
 const r=start(f);assert.equal(r.role,'cloud');assert.equal(r.spec.active_timeout_ms,3600000);assert.equal(r.budget.max_requests,200);
 assert(!('maxTokens' in r.policy));assert.equal(f.g.execution.slots.snapshot().held,1);finish(f,r);assert.equal(f.g.execution.slots.snapshot().held,0);
});
test('unapproved proposal cannot execute; legacy cannot enter new contract',async t=>{
 const f=setup(t),id=await f.create('pending');const p=await f.g.call('execution_prepare',{task_id:id,expected_revision:1,role:'cloud',cwd:realpathSync(f.dir),scope:'只分析',event_id:'pending'});
 await assert.rejects(f.g.call('execution_enqueue',{task_id:id,approval_id:p.id}),/APPROVAL_REQUIRED/);assert.equal(f.g.execution.slots.snapshot().held,0);
 assert.equal(f.g.ctx.agents.list().length,1);assert.equal(f.sideEffects.agents,0);
});
test('cloud 3+1 with independent local capacity, only existing-task human gets +1',async t=>{
 const f=setup(t),old=await contract(f,'old'),first=start(f);finish(f,first);
 for(let i=0;i<3;i++){await contract(f,'ordinary-'+i);assert(start(f));}
 const fourth=await contract(f,'new-person');assert.equal(start(f),null);
 f.g.continuity.receive('cloud',f.input(old.id,f.source('请补充测试结果')));
 const follow=start(f);assert.equal(follow.task_id,old.id);assert.equal(f.g.execution.slots.snapshot().held,4);
 assert.equal(start(f),null);assert.equal(f.g.execution.view(fourth.id).state,'queued');assert.equal(f.sideEffects.agents,0);
});
test('reference-only input cannot earn human slot or wake idle execution',async t=>{
 const f=setup(t),c=await contract(f,'ref'),r=start(f);finish(f,r);
 f.g.continuity.receive('cloud',f.input(c.id,f.source('仅供参考'),{mode:'reference'}));assert.equal(f.g.execution.get(c.id).state,'idle');assert.equal(start(f),null);
});
test('task-level budget counts >6 root/child/compaction requests without reset',async t=>{
 const f=setup(t);await contract(f,'budget','cloud',{max_requests:8});const r=start(f);
 for(let i=0;i<8;i++)f.g.execution.reserve('cloud',{...own(r),policy,purpose:i%2?'child':'compaction'});
 assert.throws(()=>f.g.execution.reserve('cloud',{...own(r),policy,purpose:'root'}),/BUDGET_EXHAUSTED/);
 finish(f,r);f.g.continuity.receive('cloud',f.input(r.task_id));const again=start(f);assert(again);
 assert.throws(()=>f.g.execution.reserve('cloud',{...own(again),policy,purpose:'root'}),/BUDGET_EXHAUSTED/);
});
test('pause fences active execution, no user session restore; stopped task never revives',async t=>{
 const f=setup(t),c=await contract(f,'control'),r=start(f);
 f.g.continuity.control('cloud',f.control(c.id,'pause'));assert.equal(f.g.continuity.controlStatus(c.id).execution_settled,false);
 assert.throws(()=>f.g.execution.validate('cloud',own(r)),/TASK_PAUSED/);
 assert.throws(()=>f.g.continuity.control('cloud',f.control(c.id,'resume')),/NOT_QUIESCENT/);
 finish(f,r,{outcome:'stopped'});assert.equal(f.g.continuity.controlStatus(c.id).execution_settled,true);
 f.g.continuity.control('cloud',f.control(c.id,'stop'));f.g.continuity.receive('cloud',f.input(c.id));assert.equal(start(f),null);
});
test('expired claims reclaim only never-started work, unknown running ownership remains',async t=>{
 const f=setup(t);const c=await contract(f,'claim');const r=f.g.execution.claim('cloud',{instance_id:'one'}).item;
 f.advance();f.g.execution.reconcile();assert.equal(f.g.execution.get(c.id).state,'queued');assert.equal(f.g.execution.slots.snapshot().held,0);
 const running=start(f);f.advance();f.g.execution.reconcile();assert.equal(f.g.execution.slots.snapshot().held,1);
 assert.throws(()=>f.g.execution.validate('cloud',own(running)),/LEASE_ENDED/);assert.equal(start(f),null);
 assert.throws(()=>f.g.execution.finish('local',{...own(running),drained:true}),/CLAIM_DENIED/);
});
test('result requires real drain; repeated exact receipt is idempotent, changed receipt rejects',async t=>{
 const f=setup(t);await contract(f,'receipt');const r=start(f);
 assert.throws(()=>finish(f,r,{drained:false}),/DRAIN_REQUIRED/);assert.equal(f.g.execution.slots.snapshot().held,1);
 assert.deepEqual(finish(f,r),finish(f,r));assert.throws(()=>finish(f,r,{summary:'other'}),/RECEIPT_CONFLICT/);
});
test('periodic cycles reuse contract budget and only next due, no missed-round burst',async t=>{
 const f=setup(t);await contract(f,'period','cloud',{period_seconds:60});let r=start(f);finish(f,r);
 assert.equal(start(f),null);f.advance();r=start(f);assert(r);finish(f,r);assert.equal(f.g.execution.get(r.task_id).runs,2);assert.equal(start(f),null);
});
test('new execution cannot fall back to old plan scheduler or old A2A',async t=>{
 const f=setup(t),c=await contract(f,'contract');
 await assert.rejects(f.g.call('schedule',{task_id:c.id,expected_revision:1,policy}),/CONTRACT_ALREADY_EXISTS/);
 await assert.rejects(f.g.call('a2a_create',{task_id:c.id}),/ADAPTER_UNAVAILABLE|CONTRACT_ALREADY_EXISTS/);
});
test('proposal revocation fences current task despite unchanged IM bot permissions',async t=>{
 const f=setup(t),c=await contract(f,'revoke'),r=start(f),p=f.g.approvals.view(c.proposal.id);
 f.g.continuity.decide('cloud',{request_id:p.id,expected_revision:1,proposal_hash:p.proposal_hash,expected_decision_id:p.decision_id,action:'revoke',source:f.source('撤销授权')});
 assert.throws(()=>f.g.execution.validate('cloud',own(r)),/AUTHORITY_CHANGED/);assert.equal(finish(f,r).state,'fenced');
});

test('paused active task resumes automatically after drain with same session and budget',async t=>{
 const f=setup(t);await contract(f,'resume');const r=start(f);f.g.execution.reserve('cloud',{...own(r),policy,purpose:'root'});
 f.g.continuity.control('cloud',f.control(r.task_id,'pause'));finish(f,r,{outcome:'stopped'});
 f.g.continuity.control('cloud',f.control(r.task_id,'resume'));const resumed=start(f);
 assert(resumed);assert.equal(resumed.session_id,'managed-'+r.task_id);assert.equal(resumed.budget.used,1);assert.equal(resumed.runs,2);
});
test('periodic pause/resume skips missed rounds and waits for next interval',async t=>{
 const f=setup(t);await contract(f,'resume-period','cloud',{period_seconds:60});const r=start(f);finish(f,r);
 f.g.continuity.control('cloud',f.control(r.task_id,'pause'));f.advance();f.g.continuity.control('cloud',f.control(r.task_id,'resume'));
 assert.equal(start(f),null);f.advance();assert(start(f));
});
test('waiting for exception does not get periodic rerun until human input',async t=>{
 const f=setup(t);await contract(f,'exception','cloud',{period_seconds:60});const r=start(f);finish(f,r,{outcome:'waiting'});
 f.advance();assert.equal(start(f),null);f.g.continuity.receive('cloud',f.input(r.task_id));assert(start(f));
});
test('lease expired last run does not poison next run active-duration accounting',async t=>{
 const f=setup(t);await contract(f,'next');const r=start(f);finish(f,r);f.advance();
 f.g.continuity.receive('cloud',f.input(r.task_id));assert(start(f));
});
test('receipt replay by wrong endpoint role rejects even with identical payload',async t=>{
 const f=setup(t);await contract(f,'receipt-role');const r=start(f);finish(f,r);
 assert.throws(()=>f.g.execution.finish('local',{...own(r),session_id:'managed-'+r.task_id,drained:true,outcome:'ready',summary:'已生成任务成果，未对外交付'}),/CLAIM_DENIED/);
});
test('running followup signals pending input without marking read, actual context marks delivery',async t=>{
 const f=setup(t);await contract(f,'hint');const r=start(f);f.g.continuity.receive('cloud',f.input(r.task_id));
 assert(f.g.execution.validate('cloud',own(r)).pending_input>0);assert.equal(f.g.continuity.read(r.task_id).items[0].state,'saved');
 const read=f.g.execution.inputs('cloud',own(r));assert.equal(read.items[0].state,'delivered');assert.equal(f.g.execution.validate('cloud',own(r)).pending_input,null);
});
test('maintenance cannot claim idle while managed work owns a slot',async t=>{
 const f=setup(t);await contract(f,'hold');const r=start(f);assert.equal(f.g.maintenance.status().canHold,false);finish(f,r);assert.equal(f.g.maintenance.status().canHold,true);
});
test('explicit native stop-and-archive becomes task pause, not silent auto revival',async t=>{
 const f=setup(t);await contract(f,'explicit-stop');const r=start(f);assert.equal(f.g.execution.suspend('cloud',own(r)).paused,true);
 assert.equal(f.g.continuity.state(r.task_id).state,'paused');finish(f,r,{outcome:'stopped'});assert.equal(start(f),null);
 assert.equal(f.g.execution.suspend('cloud',own(r)).historical_receipt,true);
 f.g.continuity.control('cloud',f.control(r.task_id,'resume'));assert(start(f));
});
import {TaskBoard} from '../bundle/task-board.js';
import {taskResults} from '../bundle/task-results.js';
test('task-level board and results expose managed progress without session operations',async t=>{
 const f=setup(t);await contract(f,'view');const r=start(f);const board=new TaskBoard({get:()=>null},f.g);f.g.board=board;
 assert.equal(board.summary(r.task_id).display_state,'running');finish(f,r);
 const result=await taskResults(f.g,{task_id:r.task_id});assert.equal(result.items[0].managed_execution.report.outcome,'ready');assert.equal(result.grants_execution,false);
 assert.equal(f.g.execution.get(r.task_id).runs,1);
});

test('renewed approval changes same-task model/budget without resetting history or session',async t=>{
 const f=setup(t),c=await contract(f,'amend'),r=start(f);f.g.execution.reserve('cloud',{...own(r),policy,purpose:'root'});finish(f,r);
 const p=await f.g.call('execution_prepare',{task_id:c.id,expected_revision:1,role:'cloud',cwd:realpathSync(c.cwd),scope:'新增相关测试，不发布',model_policy:{...policy,model:'new-model'},max_requests:300,event_id:'amend-contract'});
 assert.equal(start(f),null);
 await assert.rejects(f.g.call('execution_enqueue',{task_id:c.id,approval_id:p.id}),/APPROVAL_REQUIRED/);
 f.g.continuity.decide('cloud',{request_id:p.id,expected_revision:1,proposal_hash:p.proposal_hash,expected_decision_id:null,action:'approve',source:f.source('同意新额度和模型')});
 await f.g.call('execution_enqueue',{task_id:c.id,approval_id:p.id});const n=start(f);
 assert.equal(n.task_id,r.task_id);assert.equal(n.session_id,'managed-'+r.task_id);assert.equal(n.budget.used,1);assert.equal(n.budget.max_requests,300);assert.equal(n.policy.model,'new-model');assert.equal(n.runs,2);
 assert.throws(()=>f.g.execution.reserve('cloud',{...own(r),policy,purpose:'old'}),/CLAIM_DENIED/);
});
test('amendment cannot move existing session or overwrite an active contract',async t=>{
 const f=setup(t),c=await contract(f,'amend-fence'),r=start(f);
 const a={task_id:c.id,expected_revision:1,role:'cloud',cwd:c.cwd,scope:'调整',event_id:'amend-busy'};
 await assert.rejects(f.g.call('execution_prepare',a),/NOT_QUIESCENT/);finish(f,r);
 await assert.rejects(f.g.call('execution_prepare',{...a,cwd:realpathSync(f.dir)}),/SESSION_BINDING_CHANGED/);
 assert.equal(f.g.approvals.view(c.proposal.id).state,'approved');
});
test('verified interrupted run resumes same task, revoked and paused work never revives',async t=>{
 const f=setup(t);await contract(f,'recover');const r=start(f);f.g.execution.reserve('cloud',{...own(r),policy,purpose:'root'});
 finish(f,r,{outcome:'interrupted'});const n=start(f);assert(n);assert.equal(n.budget.used,1);assert.equal(n.session_id,'managed-'+r.task_id);
 f.g.continuity.control('cloud',f.control(r.task_id,'pause'));finish(f,n,{outcome:'interrupted'});assert.equal(start(f),null);assert.equal(f.g.execution.view(r.task_id).state,'fenced');
});

test('reclaimed never-started receipt settles without touching newer claim',async t=>{
 const f=setup(t);await contract(f,'unstarted');const old=f.g.execution.claim('cloud',{instance_id:'old'}).item;f.advance();const newer=start(f);assert.notEqual(newer.claim,old.claim);
 const result=finish(f,old,{outcome:'interrupted'});assert.equal(result.state,'reclaimed_before_start');assert.equal(f.g.execution.get(old.task_id).claim,newer.claim);assert.equal(f.g.execution.slots.snapshot().held,1);
 assert.throws(()=>f.g.execution.finish('local',{...own(old),session_id:'managed-'+old.task_id,drained:true,outcome:'interrupted',summary:'已生成任务成果，未对外交付'}),/CLAIM_DENIED/);
});

test('an interrupted unsafe run is not displayed as completed',async t=>{
 const f=setup(t);await contract(f,'unsafe-stop');const r=start(f);finish(f,r,{outcome:'stopped',error:'TASK_EXECUTION_DRAIN_INTERRUPTED'});
 f.g.board=new TaskBoard({get:()=>null},f.g);assert.equal(f.g.board.summary(r.task_id).display_state,'needs_review');assert.equal(start(f),null);
});

test('task revision amendment resumes only under renewed current-revision authority',async t=>{
 const f=setup(t),c=await contract(f,'revision'),r=start(f);finish(f,r);
 const update=await f.g.call('task_amend',{task_id:c.id,expected_revision:1,summary:'增加输出兼容性说明',sources:[f.source('还要补充兼容性说明')],intent:'register',event_id:'revision-2'});assert.equal(update.spec_revision,2);
 const p=await f.g.call('execution_prepare',{task_id:c.id,expected_revision:2,role:'cloud',cwd:c.cwd,scope:'原目标并增加兼容性说明',model_policy:policy,event_id:'revised-plan'});
 f.g.continuity.decide('cloud',{request_id:p.id,expected_revision:2,proposal_hash:p.proposal_hash,expected_decision_id:null,action:'approve',source:f.source('同意补充说明')});
 await f.g.call('execution_enqueue',{task_id:c.id,approval_id:p.id});const next=start(f);assert.equal(next.revision,2);assert.equal(next.session_id,'managed-'+c.id);assert.equal(JSON.parse(next.goal).task_context.sources.at(-1).text,'还要补充兼容性说明');
 f.g.continuity.receive('cloud',f.input(c.id));assert.equal(f.g.execution.inputs('cloud',own(next)).items.length,1);
});
