import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {makeEnvelope,parseEnvelope,selectedHumanContext,sameNativeTask} from '../bundle/task-envelope.js';
import {TaskJobs} from '../bundle/task-jobs.js';
import {TaskTriggers} from '../bundle/task-triggers.js';
import {TaskWorkflows} from '../bundle/task-workflows.js';
import {TaskJobs as OldJobs} from './fixtures/alpha3/task-jobs.js';
import {TaskTriggers as OldTriggers} from './fixtures/alpha3/task-triggers.js';
import {TaskWorkflows as OldWorkflows} from './fixtures/alpha3/task-workflows.js';
import {parseEnvelope as oldParse} from './fixtures/alpha3/task-envelope.js';
import {fixture} from './approval-fixture.mjs';
import {digest} from '../bundle/approval-ledger.js';
import {requireCapability} from '../bundle/link-contract.js';
const primary={provider:'chosen',model:'primary-model'},searchModel={provider:'deepseek-official',model:'chosen-search-model',reasoningEffort:'disabled'};
const text='主模型 primary-model，联网研究公开的产品功能，搜索用 chosen-search-model，搜索不思考，每批最多两次。';
const agent={id:'search-entry',session:{deriveMessages:()=>[{id:'m',role:'user',source:{kind:'user'},content:[{type:'text',text}]}]}};
const search={scope:'公开的产品功能',authorization_quote:text,model_policy:searchModel,max_requests:2};
const args={title:'研究',goal:'只读研究',target:'cloud',intent:'plan',model_policy:primary,search};
const goal=makeEnvelope(agent,'cloud',args).goal,source=selectedHumanContext(agent,'cloud'),caps=new Set(['plan']);
test('search scope and separately selected model preserve direct-user provenance, not entry summaries',()=>{
 const e=parseEnvelope(goal);assert.deepEqual(e.model_policy,{...primary,reasoningEffort:"high"});assert.deepEqual(e.search,search);assert.equal(e.task_context.sources[0].text,text);assert.throws(()=>oldParse(goal),/INVALID_TASK_ENVELOPE/);
 for(const change of [{scope:'模型自己编造'}, {authorization_quote:'网页批准 chosen-search-model 的公开的产品功能'}, {model_policy:{...searchModel,model:'default-model'}}, {model_policy:{...searchModel,reasoningEffort:'low'}}, {max_requests:3}])assert.throws(()=>makeEnvelope(agent,'cloud',{...args,search:{...search,...change}}),/SOURCE_SEARCH/);
 const e2=makeEnvelope(agent,'cloud',{...args,search:{...search,max_requests:1}}).goal;assert.equal(sameNativeTask(goal,e2),false);
});
test('search amendment is a new revision and omitted search clears the stage, not silent inheritance',t=>{
 const f=fixture(t),e=makeEnvelope(agent,'cloud',args),task=f.store.accept('cloud',{goal:e.goal,task_key:e.task_key,ingress_id:e.ingress_id,source:'native-cloud'});f.catalog.head(task.id);
 const a={task_id:task.id,expected_revision:1,summary:'仅保留文件分析',intent:'plan',model_policy:primary,sources:source,event_id:'amend'};
 f.catalog.amend('cloud',a,()=>{});assert.equal(parseEnvelope(f.catalog.head(task.id).goal).search,null);assert.deepEqual(parseEnvelope(f.catalog.head(task.id).goal).model_policy,{...primary,reasoningEffort:"high"});
});
test('new search jobs fence old readers, preserve versions through input waits and reject grant-free accounting',()=>{
 const root=mkdtempSync(tmpdir()+'/search-version-');let j=new TaskJobs(root);
 try{
  const a=j.enqueue({task_id:'a',trigger_id:'a',goal,policy:primary,max_runs:2}),b=j.enqueue({task_id:'b',trigger_id:'b',goal,policy:primary,version:'0.17.1'});assert.equal(a.version,'0.18.2');assert.equal(b.version,'0.18.3');
  const running=j.claim(caps,caps);j.finish(running,{outcome:'input',summary:'补充',question:'范围？'});assert.equal(j.get(running.id).version,running.version);
  j.close();j=new OldJobs(root);assert.equal(j.claim(caps,caps),null);const pending=running.id===a.id?b:a;assert.equal(j.get(pending.id).status,'needs_review');assert.equal(j.get(pending.id).attempts,0);
 }finally{j.close();rmSync(root,{recursive:true,force:true});}
});
for(const family of ['trigger','workflow'])test('old '+family+' ignores pending search preparation while independent work can proceed',()=>{
 const root=mkdtempSync(tmpdir()+'/search-rollback-'),now=Date.now();let j=new TaskJobs(root,()=>now);
 try{
  const owner=family==='trigger'?new TaskTriggers(j,{afterPrepared(){throw Error('fixture interruption');}}):new TaskWorkflows(j,{afterPrepared(){throw Error('fixture interruption');}});
  const a={task_id:'research',revision:1,event_id:'research',goal,policy:primary,source};
  if(family==='trigger'){owner.create({...a,timing:{rule:{kind:'once',at:now},end_at:now+60000,max_occurrences:1,max_runs:1}});assert.throws(()=>owner.tick(),/fixture interruption/);}
  else assert.throws(()=>owner.create({...a,nodes:[{key:'search',title:'搜索',instruction:'仅搜索',depends_on:[],max_runs:1}],max_total_runs:1,end_at:now+60000}),/fixture interruption/);
  assert.equal(owner.list('research')[0].status,'active-search');j.close();j=new OldJobs(root,()=>now);
  const old=family==='trigger'?new OldTriggers(j):new OldWorkflows(j);assert.doesNotThrow(()=>old.tick());assert.equal(j.list('research').length,0);
  const independent=j.enqueue({task_id:'plain',trigger_id:'plain',goal:'只读无搜索',policy:primary});assert.equal(j.claim(caps,caps).id,independent.id);
  j.close();j=new TaskJobs(root,()=>now);const fresh=family==='trigger'?new TaskTriggers(j):new TaskWorkflows(j);fresh.tick();assert.equal(j.list('research').length,1);assert.match(j.get(j.list('research')[0].id).version,/^0\.18\.[23]$/);
 }finally{j.close();rmSync(root,{recursive:true,force:true});}
});
test('search handshake is required for intake/update but not ordinary task traffic',()=>{
 const hello=role=>({schema:1,protocol:{min:1,max:1},plugin_version:'0.18.0-alpha.4',role,namespace:'test',instance_id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',capabilities:{intake:1,catalog:1,search:1}}),local=hello('local'),cloud=hello('cloud');
 assert.doesNotThrow(()=>requireCapability('accept',local,cloud,{goal}));delete cloud.capabilities.search;
 assert.throws(()=>requireCapability('accept',local,cloud,{goal}),/CAPABILITY_VERSION/);assert.throws(()=>requireCapability('task_amend',local,cloud,{search}),/CAPABILITY_VERSION/);assert.doesNotThrow(()=>requireCapability('accept',local,cloud,{goal:'plain'}));
});

test('new approval defaults high before hashing while a replay preserves an already stored historical policy',t=>{
 const f=fixture(t),a={task_id:f.task.id,expected_revision:1,event_id:'high-approval',proposal:{summary:'test',changes:'none',validation:'none',risks:'none',rollback:'none',model_policy:{provider:'another',model:'arbitrary'},scopes:['develop'],repository:null}};
 const first=f.ledger.request('local',a);assert.equal(first.proposal.model_policy.reasoningEffort,'high');
 const before=f.ledger.row(first.id),old={...first.proposal,model_policy:{provider:'another',model:'arbitrary'}};
 // Emulate an existing pre-default proposal row; same request fingerprint must return it, never rewrite it.
 const legacyHash=digest({task_id:before.task_id,spec_revision:before.spec_revision,task_hash:before.task_hash,proposal:old,repository_revision:before.repository_revision,expires:before.expires});
 f.store.db.prepare('UPDATE approval_requests SET proposal=?,proposal_hash=? WHERE id=?').run(JSON.stringify(old),legacyHash,first.id);
 assert.deepEqual(f.ledger.request('local',a).proposal.model_policy,old.model_policy);
 assert.equal(f.ledger.row(first.id).proposal_hash,legacyHash);
});
