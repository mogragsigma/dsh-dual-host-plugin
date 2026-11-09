import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,symlinkSync,unlinkSync,existsSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {fixture} from './helpers/continuity-fixture.mjs';
import {CLOUD_TASK_POLICY,taskChannel} from '../bundle/managed-cloud-policy.js';
import {makeEnvelope} from '../bundle/task-envelope.js';
import {ManagedEndpoint} from '../bundle/managed-endpoint.js';
const policy={provider:'fixture',model:'fixture'},binding=r=>({task_id:r.task_id,claim:r.claim,instance_id:r.instance});
function setup(t){const f=fixture(t,{managedExecution:{enabled:true}});f.g.ctx.llm.resolveCallConfig=async p=>Object.keys(p).length?p:policy;return f;}
async function create(f,name='task',extra={}){
 const role=extra.channel==='cloud-im'?'cloud':'local',a=f.agent('entry-'+name,'请处理 '+name+'，不要增加权限，不提交、不发布。');
 const envelope=makeEnvelope(a,role,{goal:name,target:'cloud',intent:'register',continuity:1,notification_contract:1,execution_policy:CLOUD_TASK_POLICY,channel:extra.channel??'local-dsh'});
 const task=await f.g.call('accept',{goal:envelope.goal,task_key:envelope.task_key,ingress_id:envelope.ingress_id,source:'native-'+role},role);
 const cwd=join(f.dir,name);mkdirSync(cwd);return {id:task.id,cwd:realpathSync(cwd),envelope};
}
async function queue(f,c,extra={}){return f.g.call('execution_start',{task_id:c.id,expected_revision:1,role:'cloud',cwd:c.cwd,...extra},'local');}
function begin(f){const r=f.g.execution.claim('cloud',{instance_id:'endpoint',development_contract:1,autonomy_contract:1}).item;return r&&f.g.execution.begin('cloud',binding(r)).item;}
function finish(f,r,extra={}){const v=f.g.execution.validate('cloud',binding(r));return f.g.execution.finish('cloud',{...binding(r),outcome:'ready',summary:'实际完成',session_id:'managed-'+r.task_id,drained:true,completion:{input_cursor:v.input_cursor,control_version:v.control_version,round:r.runs},...extra});}
function endpoint(f){
 const ctx=f.g.ctx,hooks=new Map(),tools=new Map();ctx.on=(n,h)=>{hooks.set(n,h);return ()=>{};};ctx.sessions={flush:async()=>true};ctx.workspaceRegistry={};ctx.tools={register:d=>{tools.set(d.name,d);return ()=>{};}};
 const ep=new ManagedEndpoint(f.g,{lockPort:31568});return {ep,hooks,tools};
}
function bind(ep,r){const agent={id:'managed-'+r.task_id,status:'idle',ctx:{},session:{}};const b={item:r,agent,tools:0,controller:new AbortController(),validUntil:performance.now()+30000};ep.active.set(r.task_id,b);ep.db.prepare("INSERT INTO managed_endpoint_runs(claim,item,state,safe_checkpoint) VALUES (?,?,'running',1)").run(r.claim,JSON.stringify(r));ep.development.begin(b);return b;}
const agreement={delivery:'workspace',checks:[{name:'fixture',command:'fixture-check',inputs:['input.txt']}],artifacts:['result.txt']};
async function prepared(t){const f=setup(t),c=await create(f);writeFileSync(join(c.cwd,'input.txt'),'input');writeFileSync(join(c.cwd,'result.txt'),'result');await queue(f,c,{development:agreement});const r=begin(f),e=endpoint(f),b=bind(e.ep,r);await e.ep.context(b,{});const token=e.ep.development.before(b,{name:'bash',arguments:{command:'fixture-check'}},c.cwd);e.ep.development.after(b,token,{exit_code:0});return {...f,...e,b,c,r};}

test('O01/O02 three channels share cloud authority, no approval credentials or grants',async t=>{
 const f=setup(t);for(const channel of ['local-dsh','local-im','cloud-im']){const c=await create(f,channel,{channel}),q=await queue(f,c);assert.equal(q.role,'cloud');assert.equal(q.state,'queued');assert.equal(q.budget.mode,'unlimited');assert.equal(q.budget.max_requests,null);assert.equal(q.budget.end_at,null);}
 assert.equal(f.g.store.db.prepare('SELECT count(*) n FROM approval_requests').get().n,0);
 assert.equal(f.g.store.db.prepare('SELECT count(*) n FROM approval_credentials').get().n,0);
 assert.equal(f.sideEffects.agents,0);assert.equal(f.g.execution.slots.snapshot().local_limit,0);assert.equal(f.g.execution.claim('local',{instance_id:'mac'}).item,null);
});
test('O01 native cloud chat cannot create a fourth channel; lookup is not personal authentication',async()=>{
 await assert.rejects(taskChannel({},'cloud',{id:'normal'}),/CHANNEL_UNSUPPORTED/);
 assert.equal(await taskChannel({},'local',{id:'normal'}),'local-dsh');
 const ctx={get:()=>({describeConversation:async()=>({channel:'feishu',botId:'fixture',lastSpeaker:'not-used-as-proof'})})};
 assert.equal(await taskChannel(ctx,'cloud',{id:'im'}),'cloud-im');assert.equal(await taskChannel(ctx,'local',{id:'im'}),'local-im');
});
test('O01 no reverse local execution and no fallback to old six-call batch',async t=>{
 const f=setup(t),c=await create(f);await assert.rejects(queue(f,c,{role:'local'}),/CLOUD_ONLY/);
 for(const method of ['schedule','workflow_create','trigger_create','a2a_create','approval_request'])await assert.rejects(f.g.call(method,{task_id:c.id}),/DIRECT_PATH_REQUIRED|ADAPTER_UNAVAILABLE/);
 assert.equal(f.g.execution.get(c.id),undefined);
});
test('O03 negative restrictions are original task text, never reinterpreted as approval',async t=>{
 const f=setup(t),c=await create(f);await queue(f,c);const r=begin(f);f.g.continuity.receive('local',f.input(c.id,f.source('不要增加权限，仍然不要发布。','local')));
 const inputs=f.g.execution.inputs('cloud',binding(r));assert.match(inputs.items[0].source.text,/不要增加权限/);assert.equal(inputs.items[0].applied,false);finish(f,r);assert.equal(f.g.execution.view(c.id).state,'idle');
});
test('O04 unlimited actual dispatch ledger exceeds 200 root/child/compaction and search two',async t=>{
 const f=setup(t),c=await create(f);await queue(f,c,{search:{scope:'用户任务',model_policy:{provider:'deepseek-official',model:'fixture',reasoningEffort:'disabled'}}});const r=begin(f);
 for(let i=0;i<241;i++)f.g.execution.reserve('cloud',{...binding(r),policy,purpose:['root','child','compaction','retry'][i%4]});
 for(let i=0;i<4;i++)f.g.execution.reserve('cloud',{...binding(r),channel:'search',policy:r.spec.search.model_policy,purpose:'managed-search'});
 const b=f.g.execution.budgets.view(c.id);assert.equal(b.used,245);assert.equal(b.search_used,4);assert.equal(b.max_requests,null);assert(!('max_requests' in r.spec.search));
 assert.throws(()=>f.g.execution.reserve('cloud',{...binding(r),policy:{provider:'other',model:'other'},purpose:'root'}),/MODEL_CHANGED/);
});
test('O06 no fixed 300s activity deadline or two-hour permission TTL; heartbeat remains technical',async t=>{
 const f=setup(t),c=await create(f);await queue(f,c);const r=begin(f);for(let i=0;i<400;i++){f.advance(20000);assert.equal(f.g.execution.validate('cloud',binding(r)).valid,true);}assert(!('active_timeout_ms' in r.spec));finish(f,r);
});
test('O06 explicit business deadline, stopped state and real expired lease still fence',async t=>{
 const f=setup(t),c=await create(f);await queue(f,c,{end_at:f.g.now()+60000});const r=begin(f);f.advance(20000);f.g.execution.validate('cloud',binding(r));f.advance(40001);assert.throws(()=>f.g.execution.validate('cloud',binding(r)),/BUSINESS_DEADLINE/);
 const d=await create(f,'lease');await queue(f,d);const rr=begin(f);f.advance(30001);assert.throws(()=>f.g.execution.validate('cloud',binding(rr)),/LEASE_ENDED/);
});
test('O06 removed time/count knobs cannot silently become huge numeric limits',async t=>{
 const f=setup(t),c=await create(f);for(const [k,v] of Object.entries({max_requests:100000,active_timeout_ms:300000,ttl_seconds:7200}))await assert.rejects(queue(f,c,{[k]:v}),/RETIRED_LIMIT/);
});
test('O07/O08 necessary original selection exceeds old six/12k bounds without unrelated chat',async t=>{
 const f=setup(t),a=f.agent();const messages=Array.from({length:12},(_,i)=>({id:'m'+i,role:'user',source:{kind:'user'},content:[{type:'text',text:i===5?'无关聊天':'必要原文'+i+'x'.repeat(3000)}]}));a.session.deriveMessages=()=>messages;
 const args={goal:'完整交办',target:'cloud',intent:'register',continuity:1,execution_policy:CLOUD_TASK_POLICY,channel:'local-dsh'};
 assert.throws(()=>makeEnvelope(a,'local',args),/CONTEXT_SELECTION_REQUIRED/);
 const envelope=makeEnvelope(a,'local',{...args,context_message_ids:messages.filter(x=>x.id!=='m5').map(x=>x.id)});const parsed=JSON.parse(envelope.goal);assert.equal(parsed.task_context.sources.length,11);assert(envelope.goal.length>12000);assert(!envelope.goal.includes('无关聊天'));
 await f.g.call('accept',{goal:envelope.goal,task_key:envelope.task_key,ingress_id:envelope.ingress_id,source:'native-local'},'local');
});
test('O08 missing source/reference rejects rather than inventing context',t=>{
 const f=setup(t),a=f.agent();const args={goal:'g',target:'cloud',intent:'register',continuity:1,execution_policy:CLOUD_TASK_POLICY,channel:'local-dsh'};
 assert.throws(()=>makeEnvelope(a,'local',{...args,context_message_ids:['missing']}),/CONTEXT_SELECTION_INVALID/);
 assert.throws(()=>makeEnvelope(a,'local',{...args,references:[{kind:'file-reference',title:'missing',uri:'/not-mentioned',host:'cloud'}]}),/REFERENCE_NOT_IN_USER_CONTEXT/);
});
test('O09 different entry session follows same task once; ACK is not implementation',async t=>{
 const f=setup(t),c=await create(f);await queue(f,c);const s=f.source('补充输出格式','cloud','im-new-message','different-session');const a=f.input(c.id,s);assert.deepEqual(f.g.continuity.receive('cloud',a),f.g.continuity.receive('cloud',a));assert.equal(f.g.continuity.read(c.id).items.length,1);assert.equal(f.g.continuity.read(c.id).items[0].applied,false);
});
test('O11 one durable completion intent automatically snapshots artifacts with zero model dispatch',async t=>{
 const f=await prepared(t);assert.equal(f.ep.db.prepare('SELECT count(*) n FROM managed_endpoint_artifacts').get().n,0);
 await f.ep.closeout.intent(f.b,{summary:'完成真实检查',review:'工作者自检'});const outcome=await f.ep.closeout.finish(f.b);
 assert.equal(outcome.outcome,'ready');assert.equal(f.ep.db.prepare('SELECT count(*) n FROM managed_endpoint_artifacts').get().n,1);assert.equal(f.sideEffects.model,0);
 finish(f,f.r,outcome);assert.equal(f.g.execution.view(f.c.id).state,'idle');
});
test('O10 new input after intent blocks stale ready at endpoint AND authority boundary',async t=>{
 const f=await prepared(t);await f.ep.closeout.intent(f.b,{summary:'完成',review:'自检'});f.g.continuity.receive('cloud',f.input(f.c.id));await assert.rejects(f.ep.closeout.finish(f.b),/COMPLETION_STALE/);
 assert.throws(()=>finish(f,f.r),/COMPLETION_STALE/);
});
test('O10 stop after intent cannot revive task or deliver old ready',async t=>{
 const f=await prepared(t);await f.ep.closeout.intent(f.b,{summary:'完成',review:'自检'});f.g.continuity.control('cloud',f.control(f.c.id,'stop'));await assert.rejects(f.ep.closeout.finish(f.b),/TASK_STOPPED/);f.g.execution.finish('cloud',{...binding(f.r),outcome:'stopped',summary:'已停止',session_id:f.b.agent.id,drained:true});assert.equal(f.g.execution.view(f.c.id).state,'fenced');assert.equal(begin(f),null);
});
test('O11 no intent means files are not guessed complete',async t=>{const f=await prepared(t);await assert.rejects(f.ep.closeout.finish(f.b),/COMPLETION_INTENT_REQUIRED/);});
test('O12 snapshot interruption resumes same immutable artifact without model/duplicate registration',async t=>{
 const f=await prepared(t);await f.ep.closeout.intent(f.b,{summary:'完成',review:'自检'});const artifact=f.ep.artifact.bind(f.ep);let once=true;f.ep.artifact=async(...a)=>{const r=await artifact(...a);if(once){once=false;throw Error('TASK_EXECUTION_TRANSPORT_UNAVAILABLE');}return r;};
 await assert.rejects(f.ep.closeout.finish(f.b),/TRANSPORT/);const out=await f.ep.closeout.finish(f.b);assert.equal(out.outcome,'ready');assert.equal(f.ep.db.prepare('SELECT count(*) n FROM managed_endpoint_artifacts').get().n,1);assert.equal(f.sideEffects.model,0);
});
test('O12 restart recovers durable intent on original claim without creating agent',async t=>{
 const f=await prepared(t);await f.ep.closeout.intent(f.b,{summary:'完成',review:'自检'});f.ep.active.clear();f.ep.db.prepare("INSERT INTO managed_sessions VALUES (?, 'cloud', ?, ?, 'running', 1, NULL)").run(f.c.id,f.b.agent.id,f.c.cwd);
 f.ep.db.prepare("UPDATE managed_endpoint_runs SET state='uncertain' WHERE claim=?").run(f.r.claim);f.advance(60000);await f.ep.recover();const r=f.ep.db.prepare('SELECT * FROM managed_endpoint_runs').get();assert.equal(r.state,'result');assert.equal(JSON.parse(r.payload).outcome,'ready');await f.ep.flush();assert.equal(f.g.execution.view(f.c.id).state,'idle');assert.equal(f.sideEffects.model,0);assert.equal(f.sideEffects.agents,0);
});
test('O13 host receipt/report writes do not stale related checks; input mutation does',async t=>{
 const f=await prepared(t);writeFileSync(join(f.c.cwd,'receipt.json'),'{}');assert.equal(f.ep.development.ready(f.b,'checked').checks[0].state,'passed');writeFileSync(join(f.c.cwd,'input.txt'),'changed');assert.throws(()=>f.ep.development.ready(f.b,'checked'),/CHECKS_NOT_CURRENT/);
});
test('O14 unrelated symlink does not break closeout; artifact symlink stays unsafe; no user cleanup',async t=>{
 const f=await prepared(t);symlinkSync('/not-a-real-target',join(f.c.cwd,'unrelated-link'));assert.equal(f.ep.development.ready(f.b,'checked').checks[0].state,'passed');
 unlinkSync(join(f.c.cwd,'result.txt'));symlinkSync(join(f.c.cwd,'input.txt'),join(f.c.cwd,'result.txt'));await assert.rejects(f.ep.closeout.intent(f.b,{summary:'done',review:'checked'}),/ARTIFACT_PATH_UNSAFE/);assert(existsSync(join(f.c.cwd,'input.txt')));assert(readFileSync(join(f.c.cwd,'input.txt'),'utf8')==='input');
});
test('O02 cloud native tools no longer use plugin command/path allowlist; ordinary DSH unaffected',async t=>{
 const f=setup(t),c=await create(f);await queue(f,c);const r=begin(f),{ep,hooks}=endpoint(f),b=bind(ep,r);let called=0;
 await hooks.get('tools/execute')({agent:b.agent,name:'native_custom_tool',arguments:{path:'/account/other-business-file'}},async()=>{called++;return {ok:true};});
 await hooks.get('tools/execute')({agent:{id:'ordinary'},name:'bash',arguments:{command:'no real command executed'}},async()=>{called++;return {};});assert.equal(called,2);
});
test('O15 local link is not required for already-owned cloud execution',async t=>{
 const f=setup(t),c=await create(f);await queue(f,c);const r=begin(f);f.g.link={close:async()=>{}};assert.equal(f.g.execution.validate('cloud',binding(r)).valid,true);finish(f,r);assert.equal(f.g.execution.view(c.id).state,'idle');
});
test('O16 capacity stays 3+1, new task no extra priority; same cwd stays serialized',async t=>{
 const f=setup(t),old=await create(f,'old');await queue(f,old);finish(f,begin(f));
 for(let i=0;i<3;i++){await queue(f,await create(f,'normal'+i));assert(begin(f));}await queue(f,await create(f,'queued'));assert.equal(begin(f),null);
 f.g.continuity.receive('local',f.input(old.id,f.source('再补充','local')));assert.equal(begin(f).task_id,old.id);assert.equal(f.g.execution.slots.snapshot().held,4);assert.equal(begin(f),null);
});

test('O05 missing/malformed usage remains unknown; native 429/auth errors propagate without route fallback',async t=>{
 const f=setup(t),c=await create(f);await queue(f,c);const r=begin(f),{ep,hooks}=endpoint(f),b=bind(ep,r);ep.checkpoint=async()=>true;let called=0;
 f.g.ctx.agents.get=id=>id===b.agent.id?b.agent:undefined;
 for(const status of [429,401]){const err=Object.assign(Error('provider error'),{status});const stream=hooks.get('llm/stream')({sessionId:b.agent.id,...policy,purpose:'root'},()=>{called++;return (async function*(){throw err;})();});f.g.ctx.agents.get=id=>id===b.agent.id?b.agent:undefined;
 await assert.rejects(async()=>{for await(const _ of stream){}},e=>e===err);assert.equal(b.error,status===429?'MODEL_RATE_LIMITED':'MODEL_AUTHENTICATION_FAILED');}
 assert.equal(called,2);assert.equal(f.g.execution.budgets.view(c.id).used,2);assert.equal(f.g.execution.budgets.usage(c.id,'missing',null).status,'unknown');assert.equal(f.g.execution.budgets.view(c.id).usage_status,'unknown-unless-native-reported');
});
test('O17 synthetic historical 36/12 failures, approvals and totals are retained, not migrated or resumed',async t=>{
 const f=setup(t);const history=[];
 for(const used of [36,12]){const id=await f.create('history'+used),cwd=join(f.dir,'history'+used);mkdirSync(cwd);const p=await f.g.call('execution_prepare',{task_id:id,expected_revision:1,role:'cloud',cwd:realpathSync(cwd),scope:'历史',model_policy:policy,max_requests:used,event_id:'legacy'+used});f.g.continuity.decide('cloud',{request_id:p.id,expected_revision:1,proposal_hash:p.proposal_hash,expected_decision_id:null,action:'approve',source:f.source('同意','cloud','approve'+used)});await f.g.call('execution_enqueue',{task_id:id,approval_id:p.id});const r=begin(f);for(let i=0;i<used;i++)f.g.execution.reserve('cloud',{...binding(r),policy,purpose:'old'});finish(f,r,{outcome:'failed',summary:'保留失败'});history.push({id,row:f.g.execution.get(id),budget:f.g.execution.budgets.view(id),approval:f.g.approvals.view(p.id)});}
 await queue(f,await create(f,'new'));assert(begin(f));for(const h of history){assert.deepEqual(f.g.execution.get(h.id),h.row);assert.deepEqual(f.g.execution.budgets.view(h.id),h.budget);assert.deepEqual(f.g.approvals.view(h.approval.id),h.approval);assert.equal(h.row.state,'needs_review');}
});
test('O08/O10 root must read all original pages; cannot skip followup cursor',async t=>{
 const f=await prepared(t);f.b.originalComplete=false;await assert.rejects(f.ep.closeout.intent(f.b,{summary:'done',review:'self'}),/ORIGINAL_CONTEXT_NOT_COVERED/);assert.throws(()=>f.g.execution.inputs('cloud',{...binding(f.r),after:100}),/INPUT_CURSOR_GAP/);
});
test('O16 periodic rounds reuse authority without TTL, distinct same-byte artifacts per round',async t=>{
 const f=await prepared(t);const spec=JSON.parse(f.g.execution.get(f.c.id).spec);spec.period_seconds=60;f.g.store.db.prepare('UPDATE managed_executions SET spec=? WHERE task_id=?').run(JSON.stringify(spec),f.c.id);f.b.item.spec=spec;
 await f.ep.closeout.intent(f.b,{summary:'round1',review:'checked'});const one=await f.ep.closeout.finish(f.b);finish(f,f.r,one);f.ep.active.clear();assert.equal(begin(f),null);f.advance(60001);const r=begin(f),b=bind(f.ep,r);await f.ep.context(b,{});await f.ep.closeout.intent(b,{summary:'round2',review:'checked'});const two=await f.ep.closeout.finish(b);finish(f,r,two);
 const rows=f.ep.db.prepare('SELECT record FROM managed_endpoint_artifacts').all().map(x=>JSON.parse(x.record));assert.equal(rows.length,2);assert.equal(rows[0].sha256,rows[1].sha256);assert.notEqual(rows[0].id,rows[1].id);
});

test('O10 input arriving after materialization before finish ACK settles stale receipt, does not jam scheduler',async t=>{
 const f=await prepared(t);await f.ep.closeout.intent(f.b,{summary:'done',review:'checked'});const outcome=await f.ep.closeout.finish(f.b),payload={...binding(f.r),...outcome,session_id:f.b.agent.id,drained:true};
 f.ep.db.prepare("UPDATE managed_endpoint_runs SET state='result',payload=? WHERE claim=?").run(JSON.stringify(payload),f.r.claim);f.ep.active.clear();f.g.continuity.receive('cloud',f.input(f.c.id));assert.equal(await f.ep.flush(),false);assert.equal(await f.ep.flush(),true);assert.equal(f.g.execution.view(f.c.id).state,'queued');assert.equal(f.g.execution.slots.snapshot().held,0);assert.equal(f.g.execution.view(f.c.id).report.outcome,'waiting');
});
test('O16 one cwd is still serialized with full cloud account permissions',async t=>{
 const f=setup(t),a=await create(f,'same-a'),b=await create(f,'same-b');await queue(f,a);await queue(f,b,{cwd:a.cwd});assert(begin(f));assert.equal(begin(f),null);assert.equal(f.g.execution.slots.snapshot().held,1);
});

test('O14 file changed between intent validation and actual snapshot cannot falsely complete',async t=>{
 const f=await prepared(t);await f.ep.closeout.intent(f.b,{summary:'done',review:'checked'});const artifact=f.ep.artifact.bind(f.ep);f.ep.artifact=async(...a)=>{writeFileSync(join(f.c.cwd,'result.txt'),'replacement');return artifact(...a);};await assert.rejects(f.ep.closeout.finish(f.b),/COMPLETION_ARTIFACT_CHANGED/);assert.equal(f.g.execution.view(f.c.id).state,'running');
});

test('O18 native task tool uses public IM session classification, no new identity/IM approval path',async t=>{
 const f=setup(t),agent=f.agent('im-entry','把这件工作交给云端，不提交、不发布。'),tool=f.tools.get('task_submit');
 await assert.rejects(tool.execute({goal:'native create',target:'cloud',intent:'register'},{agent,callId:'create'}),/CHANNEL_UNSUPPORTED/);
 f.g.ctx.get=n=>n==='dshIm'?{describeConversation:async()=>({channel:'feishu',botId:'existing-owner-admitted'})}:undefined;
 const saved=await tool.execute({goal:'native create',target:'cloud',intent:'register'},{agent,callId:'create'});assert.equal(saved.status,'accepted');assert.equal(JSON.parse(f.g.catalog.head(saved.task_id).goal).channel,'cloud-im');
 const cwd=realpathSync(f.dir),queued=await f.tools.get('task_execute').execute({task_id:saved.task_id,expected_revision:1,cwd,development:null},{agent,callId:'execute'});assert.equal(queued.state,'queued');assert.equal(f.g.store.db.prepare('SELECT count(*) n FROM approval_credentials').get().n,0);assert.equal(f.g.store.db.prepare('SELECT count(*) n FROM approval_requests').get().n,0);
 const identity=await f.tools.get('task_identity').execute({}, {agent,callId:'identity'});assert.equal(identity.worker_capability,'native-cloud-continuous');
});

test('C07 early manual candidate with description is reused by automatic closeout without duplicate or model',async t=>{const f=await prepared(t);const a=await f.ep.artifact(f.b,{path:'result.txt',stage:'candidate',description:'original file introduction'});await f.ep.closeout.intent(f.b,{summary:'done',review:'checked'});const r=await f.ep.closeout.finish(f.b);assert.equal(r.outcome,'ready');const records=f.g.store.db.prepare('SELECT record FROM task_artifacts WHERE task_id=?').all(f.c.id);assert.equal(records.length,1);assert.equal(JSON.parse(records[0].record).id,a.artifact.id);assert.equal(JSON.parse(records[0].record).description,'original file introduction');assert.equal(f.sideEffects.model,0);});
test('C08 lost candidate reply does not lose introduction; explicit changed metadata still conflicts',async t=>{const f=await prepared(t);await f.ep.artifact(f.b,{path:'result.txt',stage:'candidate',description:'retained'});f.ep.db.prepare('DELETE FROM managed_endpoint_artifacts WHERE task_id=?').run(f.c.id);await assert.rejects(f.ep.artifact(f.b,{path:'result.txt',stage:'candidate',description:'different'}),/ARTIFACT_EVENT_CONFLICT/);await f.ep.closeout.intent(f.b,{summary:'done',review:'checked'});assert.equal((await f.ep.closeout.finish(f.b)).outcome,'ready');assert.equal(f.g.store.db.prepare('SELECT count(*) n FROM task_artifacts WHERE task_id=?').get(f.c.id).n,1);assert.equal(f.ep.db.prepare('SELECT count(*) n FROM managed_endpoint_artifacts WHERE task_id=?').get(f.c.id).n,1);});
