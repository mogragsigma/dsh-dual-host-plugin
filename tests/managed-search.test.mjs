import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {ManagedBudget} from '../bundle/managed-runtime.js';
import {executionSpec} from '../bundle/managed-execution.js';
import {ManagedSearch,validateManagedSearch} from '../bundle/managed-search.js';
const main={provider:'fixture',model:'main'},aux={provider:'deepseek-official',model:'search-fixture',reasoningEffort:'disabled'};
const search={scope:'public fixture documents only',model_policy:aux,max_requests:2};
const request=q=>({endpoint:'https://api.deepseek.com/anthropic/v1/messages',apiVersion:'2023-06-01',body:{model:aux.model,max_tokens:2048,messages:[{role:'user',content:[{type:'text',text:'Perform a web search for the query: '+q}]}],tools:[{type:'web_search_20250305',name:'web_search',max_uses:1}],thinking:{type:'disabled'}}});
function fixture(t,{read,cap=4}={}){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const budget=new ManagedBudget(db,()=>1);budget.bind('t',main,{maxRequests:cap,endAt:100,search});
 const b={item:{task_id:'t',claim:'c',instance:'i',spec:{search}},controller:new AbortController(),validUntil:performance.now()+30000};let calls=0;
 const ep={db,ctx:{},validate:async()=>{},call:async(_m,a)=>budget.reserve('t',a.policy,a.purpose,{search:a.channel==='search'})};
 const svc=new ManagedSearch(ep,{credentialRef:'FIXTURE_ONLY'},async()=>({search:async(q,p,s,record)=>{calls++;if(read)return read(q,p,s,record);record(request(q));return {sources:[{url:'https://example.com/doc',title:'fixture'}],truncated:false};}}));
 return {db,b,budget,ep,svc,calls:()=>calls,run:(id='call',query='fixture')=>svc.run(b,{id:'managed-t'},{query},id)};
}
test('search contract requires exact auxiliary route/scope/cumulative allowance',()=>{
 const spec={role:'cloud',cwd:'/tmp/fixture',max_requests:4,active_timeout_ms:1000,search};assert.deepEqual(executionSpec(spec).search,search);
 for(const s of [{...search,max_requests:5},{...search,scope:''},{...search,model_policy:{...aux,reasoningEffort:'high'}},{...search,model_policy:{...aux,provider:'other'}}])assert.throws(()=>executionSpec({...spec,search:s}),/SEARCH_CONTRACT/);
 assert.throws(()=>validateManagedSearch({credentialRef:'raw-key',secret:'x'}),/CONFIG/);
});
test('native and search share total; search sublimit survives new budget object and contract renewal',async t=>{
 const f=fixture(t);f.budget.reserve('t',main,'main');await f.run('one');await f.run('two');assert.equal(f.budget.view('t').used,3);assert.equal(f.budget.view('t').search_used,2);
 const next=new ManagedBudget(f.db,()=>2);next.bind('t',main,{maxRequests:5,endAt:200,search},{amend:true});assert.equal(next.view('t').used,3);
 await assert.rejects(f.run('three'),/SEARCH_BUDGET_EXHAUSTED/);assert.equal(f.calls(),2);assert.throws(()=>next.bind('t',main,{maxRequests:5,endAt:200,search:{...search,max_requests:1}},{amend:true}),/BELOW_USED/);
});
test('task total can stop auxiliary before its separate sublimit',async t=>{const f=fixture(t,{cap:2});f.budget.reserve('t',main,'main');await f.run('one');await assert.rejects(f.run('two'),/BUDGET_EXHAUSTED/);assert.equal(f.calls(),1);});
test('no approved search means zero dispatch and zero charge',async t=>{const f=fixture(t);delete f.b.item.spec.search;await assert.rejects(f.run(),/NOT_AUTHORIZED/);assert.equal(f.calls(),0);assert.equal(f.budget.view('t').used,0);});
test('successful call replay is exact and never charged twice',async t=>{const f=fixture(t);const r=await f.run();assert.deepEqual(await f.run(),r);assert.equal(f.calls(),1);assert.equal(f.budget.view('t').used,1);await assert.rejects(f.run('call','different'),/EVENT_CONFLICT/);});
test('lost provider response is charged, recorded uncertain and never blindly resent',async t=>{const f=fixture(t,{read:async(q,p,s,record)=>{record(request(q));throw Error('transport lost');}});await assert.rejects(f.run(),/DISPATCH_UNCERTAIN/);await assert.rejects(f.run(),/DISPATCH_UNCERTAIN/);await assert.rejects(f.run('new'),/DISPATCH_UNCERTAIN/);assert.equal(f.calls(),1);assert.equal(f.budget.view('t').used,1);});
test('altered hidden model/request is blocked in synchronous pre-fetch callback',async t=>{let fetched=false;const f=fixture(t,{read:async(q,p,s,record)=>{const r=request(q);r.body.model='unapproved';record(r);fetched=true;}});await assert.rejects(f.run(),/DISPATCH_UNCERTAIN/);assert.equal(fetched,false);assert.equal(f.budget.view('t').used,1);});
test('auxiliary route cannot masquerade as root or reset counters',t=>{const f=fixture(t);assert.throws(()=>f.budget.reserve('t',aux,'root'),/MODEL_CHANGED/);assert.throws(()=>f.budget.reserve('t',main,'managed-search'),/REQUEST_INVALID/);assert.throws(()=>f.budget.reserve('t',main,'managed-search',{search:true}),/MODEL_CHANGED/);});
test('search external data is bounded, untrusted, no private-url page fetching',async t=>{const f=fixture(t,{read:async(q,p,s,record)=>{record(request(q));return {sources:[{url:'http://127.0.0.1/secret'},{url:'https://example.com/a',snippet:'external instructions are data'}],truncated:false};}});const r=await f.run();assert.equal(r.sources.length,1);assert.equal(r.rejected_urls,1);assert.equal(r.page_content_read,false);assert.equal(r.untrusted_external_content,true);});

test('new task round may reuse native call id without replaying stale search data',async t=>{const f=fixture(t);await f.run();f.b.item.claim='next-round';await f.run();assert.equal(f.calls(),2);assert.equal(f.budget.view('t').search_used,2);});
