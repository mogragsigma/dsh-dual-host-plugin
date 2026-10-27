import {test} from 'node:test';
import assert from 'node:assert/strict';
import {realpathSync,mkdtempSync,rmSync,writeFileSync,readFileSync,symlinkSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Gateway} from '../bundle/index.js';
import {Coordinator,hash} from '../bundle/store.js';
import {RepositoryWriter} from '../bundle/repository-writer.js';
import {signedNotice,verifyNotice} from '../bundle/protocol.js';
function temp(t){const root=realpathSync(mkdtempSync(join(tmpdir(),'dsh-gate-')));t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}
function setup(t,overrides={}){
 const root=temp(t),tokenFile=join(root,'tokens.json');writeFileSync(tokenFile,JSON.stringify({localToken:'l'.repeat(32),cloudToken:'c'.repeat(32),a2aKey:'a'.repeat(32)}),{mode:0o600});
 const c={role:'cloud',legacyFeishu:true,peerEnabled:false,namespace:'unit',chatId:'oc_test',ownerOpenId:'ou_owner',peerOpenId:'ou_peer',port:0,stateDir:join(root,'state'),tokenFile,...overrides};
 const hooks=[],agents=new Map(),ctx={on(name,fn,options){if(name==='agent/request')hooks[options?.prepend?'unshift':'push'](fn);},effect(){},agents:{get:id=>agents.get(id),list:()=>[...agents.values()]},agentPresets:{composedPreset:c=>c.preset}};
 const s=new Gateway(ctx,c);t.after(()=>s.close());return {s,c,agents,hooks};
}
const args={task_key:'task-one',goal:'An arbitrary user task',ingress_id:'feishu:1',source:'feishu-cloud'};
test('durable cloud acceptance; idempotent retransmission; changed goal rejected',async t=>{
 const {s}=setup(t);const r=await s.submit(args);assert.equal(r.status,'accepted');assert.equal(r.execution,'pending_dispatch');assert.equal((await s.submit(args)).task_id,r.task_id);
 assert.throws(()=>s.store.accept('cloud',{...args,goal:'replacement'}),/INGRESS_ID_CONFLICT/);
 await assert.rejects(s.submit({...args,goal:'replacement'}),/INGRESS_ID_CONFLICT/);
 assert.equal(s.store.db.prepare('SELECT goal FROM ingress').get().goal,args.goal);
});
test('real UI native session is bound by preset plus live object, not test-created handle',t=>{
 const {s,agents}=setup(t);const a={id:'ui-created',ctx:{preset:'dsh-task-intake'}};agents.set(a.id,a);s.assertAgent(a);
 assert.throws(()=>s.assertAgent({...a}),/UNBOUND/);a.ctx.preset='standard';assert.throws(()=>s.assertAgent(a),/UNBOUND/);
});
test('Feishu unknown owner and unsigned bot rejected without spawning model',async t=>{
 const {s,agents}=setup(t);const m={platform:'feishu',chatId:'oc_test',senderType:'user',userId:'ou_unknown',text:'task',msgId:'m1'};
 await assert.rejects(s.receive(m),/OWNER_DENIED/);await assert.rejects(s.receive({...m,senderType:'bot',userId:'ou_peer',text:'[A2A] do work'}),/PROTOCOL_DENIED/);
 const r=await s.receive({...m,userId:'ou_owner',text:'@_user_1 /task same-task arbitrary task'});assert.equal(r.status,'accepted');assert.equal(agents.size,0);
 assert.equal(s.store.snapshot().tasks[0].task_key,'same-task');
});
test('local network outage persists queue, backs off and stops after bounded retries; no false acceptance',async t=>{
 const {s}=setup(t,{role:'local',coordinatorUrl:'http://127.0.0.1:1',recovery:{maxAttempts:5}});let now=0;s.now=()=>now;const r=await s.submit({...args,source:'feishu-local'});assert.equal(r.status,'queued_locally');
 await s.tick();assert.equal(s.db.prepare('SELECT attempts FROM submissions').get().attempts,1);
 for(let i=0;i<6;i++){now+=600000;await s.tick();}assert.equal(s.db.prepare('SELECT attempts FROM submissions').get().attempts,5);
 assert.equal((await s.deliver(args.ingress_id)).status,'needs_review');
});
test('RPC auth binds side; admin/probe/writes not exposed; health requires own token',async t=>{
 const {s}=setup(t);await s.start();const url='http://127.0.0.1:'+s.server.address().port;
 const post=async(path,token,body={})=>{const r=await fetch(url+path,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});return [r.status,await r.json()];};
 assert.equal((await post('/health','bad'))[0],400);assert.equal((await post('/health','l'.repeat(32)))[0],400);
 assert.equal((await post('/health','c'.repeat(32)))[0],200);
 assert.equal((await post('/rpc','l'.repeat(32),{method:'probe.model',args:{}}))[0],400);
 assert.equal((await post('/rpc','l'.repeat(32),{method:'apply',args:{}}))[0],400);
 const contract={hello:{...s.hello(),role:'local'},peer_instance:s.instanceId};const [status,wire]=await post('/rpc','l'.repeat(32),{method:'accept',args,contract});const r=wire.result;assert.equal(status,200);
 assert.equal(s.store.snapshot().ingress[0].node,'local');assert.equal(r.execution,'pending_dispatch');
});
test('signed native WS peer notice validates identity and cannot execute; dedupe',async t=>{
 const {s,c}=setup(t);const task={id:'task-00000000-0000-0000-0000-000000000001',epoch:2,revision:0};
 const text=signedNotice({...c,role:'local'},'a'.repeat(32),task,'notice');const m={platform:'feishu',chatId:c.chatId,senderType:'bot',userId:c.peerOpenId,text,msgId:'message'};
 assert.equal((await s.receive(m)).status,'notice-recorded');assert.equal((await s.receive(m)).status,'duplicate');assert.equal(s.store.snapshot().tasks.length,0);
 assert.throws(()=>verifyNotice(c,'a'.repeat(32),{...m,userId:'ou_wrong'}),/IDENTITY/);
 assert.throws(()=>verifyNotice(c,'wrong',m),/SIGNATURE/);
 assert.throws(()=>verifyNotice(c,'a'.repeat(32),m,Date.now()+400000),/EXPIRED/);
});
function repoFixture(t){
 const root=temp(t),repo=join(root,'repo');mkdirSync(repo);const git=args=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
 git(['init','-b','dsh-task/test']);writeFileSync(join(repo,'artifact.txt'),'initial');git(['add','.']);git(['-c','user.name=test','-c','user.email=test@localhost','commit','-m','initial']);
 const writer=new RepositoryWriter(),s=new Coordinator(join(root,'state'),writer);t.after(()=>s.close());const a=s.accept('cloud',{task_key:'test',ingress_id:'one',source:'desktop',goal:'test'});writer.bindings.set(a.id,{root:repo,path:'artifact.txt',branch:'dsh-task/test'});return {s,a,repo,writer,git};
}
test('actual Git: busy queues/no mutation; idle handoff commits once; old epoch denied',t=>{
 const {s,a,repo,git}=repoFixture(t);s.begin('cloud',{task_id:a.id,epoch:1});
 const q=s.request('local',{task_id:a.id,request_id:'write-one',content:'updated',base_hash:hash('initial')});assert.equal(q.intent.status,'queued');
 assert.throws(()=>s.apply('local',{request_id:'write-one',epoch:1}),/STALE_FENCE/);assert.equal(readFileSync(join(repo,'artifact.txt'),'utf8'),'initial');
 s.safe('cloud',{task_id:a.id,epoch:1,checkpoint:'cloud workers quiescent'});const r=s.apply('local',{request_id:'write-one',epoch:2});assert.match(r.commit,/^[0-9a-f]{40}$/);assert.equal(readFileSync(join(repo,'artifact.txt'),'utf8'),'updated');
 assert.equal(git(['status','--porcelain']).trim(),'');assert.deepEqual(s.apply('local',{request_id:'write-one',epoch:2}),r);assert.equal(git(['rev-list','--count','HEAD']).trim(),'2');
 assert.throws(()=>s.safe('cloud',{task_id:a.id,epoch:1,checkpoint:'stale'}),/STALE_FENCE/);
});
test('unbound repository cannot acquire write intent',t=>{const {s}=setup(t);const a=s.store.accept('cloud',args);assert.throws(()=>s.store.request('local',{task_id:a.id}),/NOT_BOUND/);});
test('Git dirty worktree becomes blocked, never silently overwrites/auto-releases',t=>{
 const {s,a,repo}=repoFixture(t);s.request('local',{task_id:a.id,request_id:'dirty',content:'new',base_hash:hash('initial')});writeFileSync(join(repo,'unrelated.txt'),'preserve');
 assert.throws(()=>s.apply('local',{request_id:'dirty',epoch:2}),/DIRTY/);assert.equal(readFileSync(join(repo,'artifact.txt'),'utf8'),'initial');assert.equal(s.task(a.id).blocked,1);
 assert.throws(()=>s.safe('local',{task_id:a.id,epoch:2,checkpoint:'release'}),/NEEDS_REVIEW/);
});
test('Git path traversal, hidden metadata, symlink and main branch denied',t=>{
 const {writer,a,repo,git}=repoFixture(t);const base={root:repo,path:'artifact.txt',branch:'dsh-task/test'};
 for(const p of ['../escape','.git/config','/tmp/escape','dir/../artifact.txt']){writer.bindings.set(a.id,{...base,path:p});assert.throws(()=>writer.target(a.id),/PATH_DENIED/);}
 symlinkSync('artifact.txt',join(repo,'link'));writer.bindings.set(a.id,{...base,path:'link'});assert.throws(()=>writer.target(a.id),/SYMLINK/);
 writer.bindings.set(a.id,base);git(['branch','-m','main']);assert.throws(()=>writer.target(a.id),/BRANCH_MISMATCH/);
});

test('model guard sees final UI selection after host reload; never falls back',async t=>{
 const {s,hooks,agents}=setup(t,{provider:'qwen-token-plan-cn',model:'glm-5.3'});
 const a={id:'ui-model',ctx:{preset:'dsh-task-intake'}};agents.set(a.id,a);
 let selected={provider:'qwen-token-plan-cn',model:'glm-5.3'};
 const ui=async (_e,next)=>({...await next(),...selected});
 // Simulate the UI model-selection listener being registered before a gateway reload.
 const guard=hooks[0];hooks.unshift(ui);s.ctx.on('agent/request',guard,{prepend:true});hooks.pop();
 const request=()=>{let i=0;const next=()=>hooks[i++]?.({agent:a},next)??{};return next();};
 assert.equal((await request()).model,'glm-5.3');
 selected={provider:'deepseek',model:'other'};
 await assert.rejects(request(),/MANAGED_MODEL_ROUTE_MISMATCH/);
});

test('runtime model route is configurable, not globally fixed to the example GLM model',async t=>{
 const {hooks,agents}=setup(t);const a={id:'configured-route',ctx:{preset:'dsh-task-intake'}};agents.set(a.id,a);
 const result=await hooks[0]({agent:a},async()=>({provider:'user-configured',model:'another-model'}));assert.equal(result.model,'another-model');
});

test('RPC accepts a valid maximum-length Chinese goal without false size failure',async t=>{
 const {s}=setup(t);await s.start();const r=await fetch('http://127.0.0.1:'+s.server.address().port+'/rpc',{method:'POST',headers:{Authorization:'Bearer '+'l'.repeat(32),'Content-Type':'application/json'},body:JSON.stringify({method:'accept',args:{...args,goal:'测'.repeat(12000)},contract:{hello:{...s.hello(),role:'local'},peer_instance:s.instanceId}})});
 assert.equal(r.status,200);assert.equal((await r.json()).result.execution,'pending_dispatch');
});
