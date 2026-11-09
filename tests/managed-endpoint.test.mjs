import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {ManagedEndpoint} from '../bundle/managed-endpoint.js';
function endpoint(t){
 const db=new DatabaseSync(':memory:'),agents=new Map(),hooks=new Map(),jobs=new Map();t.after(()=>db.close());
 const ctx={on:(n,h)=>{hooks.set(n,h);return ()=>hooks.delete(n);},agents:{get:id=>agents.get(id),list:()=>[...agents.values()],isOwnedBy:(id,p)=>agents.get(id)?.parent===p.id},sessions:{flush:async()=>true},agentPresets:{},workspaceRegistry:{},tools:{register:()=>()=>{}},llm:{},get:n=>n==='jobs'?{list:id=>jobs.get(id)??[]}:undefined};
 const g={ctx,db,c:{role:'cloud'},now:()=>1,call:async()=>({})};
 const e=new ManagedEndpoint(g,{lockPort:31566});return {db,ctx,e,agents,hooks,jobs};
}
function interrupted(f,{safe=1}={}){
 const item={task_id:'t',claim:'c',instance:'i'};
 f.db.prepare("INSERT INTO managed_endpoint_runs(claim,item,state,safe_checkpoint) VALUES (?,?,'uncertain',?)").run('c',JSON.stringify(item),safe);
 f.db.prepare("INSERT INTO managed_sessions VALUES ('t','cloud','managed-t','/fixture','running',1,NULL)").run();return item;
}
test('checkpointed dead execution is reconciled to same-session interrupted receipt',async t=>{
 const f=endpoint(t);interrupted(f);await f.e.recover();
 const r=f.db.prepare('SELECT * FROM managed_endpoint_runs').get();assert.equal(r.state,'result');assert.equal(JSON.parse(r.payload).session_id,'managed-t');assert.equal(JSON.parse(r.payload).outcome,'interrupted');assert.equal(f.e.sessions.get('t').state,'idle');
});
test('unknown side effect never auto recovers or releases ownership',async t=>{
 const f=endpoint(t);interrupted(f,{safe:0});await f.e.recover();assert.equal(f.db.prepare('SELECT state FROM managed_endpoint_runs').get().state,'uncertain');assert.equal(f.e.sessions.get('t').state,'running');
});
test('live root, recorded child or surviving background prevents recovery',async t=>{
 const f=endpoint(t);interrupted(f);f.agents.set('managed-t',{id:'managed-t',status:'idle'});await f.e.recover();assert.equal(f.db.prepare('SELECT state FROM managed_endpoint_runs').get().state,'uncertain');
 f.agents.clear();f.jobs.set('managed-t',[{owner:'managed-t',status:'running'}]);await f.e.recover();assert.equal(f.db.prepare('SELECT state FROM managed_endpoint_runs').get().state,'uncertain');
 f.jobs.clear();f.db.prepare("INSERT INTO managed_endpoint_children VALUES ('child','t')").run();f.agents.set('child',{id:'child'});await f.e.recover();assert.equal(f.db.prepare('SELECT state FROM managed_endpoint_runs').get().state,'uncertain');
});
test('checkpoint requires durability and no concurrent dispatch across async flush',async t=>{
 const f=endpoint(t),item=interrupted(f,{safe:0}),agent={id:'managed-t',status:'running',session:{}};f.agents.set(agent.id,agent);const b={agent,item,tools:0};
 f.ctx.sessions.flush=async()=>false;await assert.rejects(f.e.checkpoint(b),/PERSISTENCE_UNAVAILABLE/);
 f.ctx.sessions.flush=async()=>{b.dispatchEpoch=1;return true;};assert.equal(await f.e.checkpoint(b),false);assert.equal(f.db.prepare('SELECT safe_checkpoint FROM managed_endpoint_runs').get().safe_checkpoint,0);
 f.ctx.sessions.flush=async()=>true;assert.equal(await f.e.checkpoint(b),true);
});
test('idle child remains owned for task-level tooling/model fencing',t=>{
 const f=endpoint(t),root={id:'managed-t',status:'running'},child={id:'child',parent:root.id,status:'idle'};f.agents.set(root.id,root);f.agents.set(child.id,child);
 const b={agent:root,item:{task_id:'t'}};f.e.active.set('t',b);assert.equal(f.e.binding(child),b);f.e.active.clear();assert(f.e.owned(child.id));
});

test('native search side channel cannot bypass task model/budget; ordinary DSH stays native',async t=>{
 const f=endpoint(t),agent={id:'managed-t',status:'running',ctx:{}},b={agent,item:{task_id:'t',claim:'c',instance:'i'}};f.agents.set(agent.id,agent);f.e.active.set('t',b);f.e.validate=async()=>({valid:true});let dispatched=0;
 await assert.rejects(f.hooks.get('tools/execute')({agent,name:'web_search',arguments:{query:'fixture'}},()=>{dispatched++;}),/SEARCH_MODEL_CONTRACT_REQUIRED/);
 assert.equal(dispatched,0);await f.hooks.get('tools/execute')({agent:{id:'ordinary'},name:'web_search',arguments:{query:'fixture'}},()=>{dispatched++;});assert.equal(dispatched,1);
});
