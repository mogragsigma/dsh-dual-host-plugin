import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {spawnSync,execFileSync} from 'node:child_process';
import {hash} from '../bundle/store.js';
import {fileURLToPath} from 'node:url';
const operator=fileURLToPath(new URL('./handoff-operator.mjs',import.meta.url));
function fixture(t){
 const root=realpathSync(mkdtempSync(tmpdir()+'/dsh-handoff-v040-'));
 writeFileSync(root+'/ISOLATED_DSH_TEST','no remote; operator probe only');writeFileSync(root+'/bindings.json','{}');
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const git=args=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','-C',root,...args],{encoding:'utf8',env:{PATH:process.env.PATH,HOME:root,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'},stdio:['ignore','pipe','pipe']}).trim();
 git(['init','-q']);git(['checkout','-qb','dsh-task/regression']);
 // Keep operator data outside tracking via exact exclusions; only artifact is committed.
 writeFileSync(root+'/.git/info/exclude','ISOLATED_DSH_TEST\nbindings.json\nstate/\n');
 writeFileSync(root+'/artifact.txt','');git(['add','artifact.txt']);git(['-c','user.name=DSH Test','-c','user.email=test@localhost','commit','-qm','isolated base']);
 function call(method,args=[],extra={}){const p=spawnSync(process.execPath,[operator,root],{input:JSON.stringify({method,args,...extra}),encoding:'utf8',timeout:15000});if(extra.crashAfterGit){assert.equal(p.status,91);return;}assert.equal(p.status,0,p.stderr);return JSON.parse(p.stdout);}
 function ok(method,...args){const r=call(method,args);assert.equal(r.ok,true,JSON.stringify(r));return r.result;}
 const task=ok('accept','local',{task_key:'handoff-regression',ingress_id:'desktop:test',source:'desktop',goal:'isolated only'});
 writeFileSync(root+'/bindings.json',JSON.stringify({[task.id]:{root,path:'artifact.txt',branch:'dsh-task/regression'}}));
 return {root,git,call,ok,task,request:(node,id,content,base='')=>ok('request',node,{task_id:task.id,request_id:id,content,base_hash:hash(base)})};
}
test('cross-process cloud busy -> FIFO local write -> reverse cloud write; other task busy independent',t=>{
 const f=fixture(t),id=f.task.id,initial=f.git(['rev-parse','HEAD']);
 const other=f.ok('accept','cloud',{task_key:'other-busy',ingress_id:'other',source:'feishu-cloud',goal:'other task'});
 f.ok('begin','cloud',{task_id:other.id,epoch:1});f.ok('begin','cloud',{task_id:id,epoch:1});
 assert.equal(f.request('local','local-one','local').intent.status,'queued');
 assert.equal(f.request('cloud','cloud-two','cloud','local').intent.status,'queued');
 assert.equal(f.call('apply',['local',{request_id:'local-one',epoch:1}]).error,'STALE_FENCE');
 assert.equal(f.git(['rev-parse','HEAD']),initial);
 // Every call is a newly started OS process; busy queue and fencing survived exit.
 const local=f.ok('safe','cloud',{task_id:id,epoch:1,checkpoint:'cloud settled'});
 assert.equal(local.owner,'local');assert.equal(local.epoch,2);assert.equal(local.busy,1);
 assert.equal(f.call('safe',['local',{task_id:id,epoch:2,checkpoint:'premature'}]).error,'WRITES_NOT_QUIESCENT');
 const receipt=f.ok('apply','local',{request_id:'local-one',epoch:2});
 assert.deepEqual(f.ok('apply','local',{request_id:'local-one',epoch:2}),receipt);
 assert.equal(f.ok('status',id).revision,1);
 const cloud=f.ok('safe','local',{task_id:id,epoch:2,checkpoint:'local committed'});
 assert.equal(cloud.owner,'cloud');assert.equal(cloud.epoch,3);
 assert.equal(f.call('apply',['cloud',{request_id:'cloud-two',epoch:2}]).error,'STALE_FENCE');
 f.ok('apply','cloud',{request_id:'cloud-two',epoch:3});
 const idle=f.ok('safe','cloud',{task_id:id,epoch:3,checkpoint:'cloud committed'});
 assert.equal(idle.busy,0);assert.equal(f.ok('status',other.id).busy,1);
 assert.equal(readFileSync(f.root+'/artifact.txt','utf8'),'cloud');assert.equal(f.git(['rev-list','--count','HEAD']),'3');
 assert.equal(f.git(['remote']), '');assert.equal(f.git(['status','--porcelain']), '');
});
test('process crash after real Git commit leaves writing fenced; no retry effect or takeover',t=>{
 const f=fixture(t),id=f.task.id;
 f.request('local','crash-write','committed but unacknowledged');f.request('cloud','next','must not write');
 f.call('apply',['local',{request_id:'crash-write',epoch:2}],{crashAfterGit:true});
 const head=f.git(['rev-parse','HEAD']),state=f.ok('status',id);
 assert.equal(state.owner,'local');assert.equal(state.busy,1);assert.equal(state.revision,0);
 assert.equal(state.intents[0].status,'writing');assert.equal(state.intents[1].status,'queued');
 assert.equal(f.call('safe',['local',{task_id:id,epoch:2,checkpoint:'cannot guess'}]).error,'WRITES_NOT_QUIESCENT');
 assert.equal(f.call('safe',['cloud',{task_id:id,epoch:2,checkpoint:'cannot take over'}]).error,'STALE_FENCE');
 assert.equal(f.call('apply',['local',{request_id:'crash-write',epoch:2}]).error,'NOT_GRANTED');
 assert.equal(f.git(['rev-parse','HEAD']),head);assert.equal(f.git(['rev-list','--count','HEAD']),'2');
});
test('stale base fails closed without false idle or overwriting user files',t=>{
 const f=fixture(t),id=f.task.id;
 f.request('local','stale','new','not the actual base');
 assert.equal(f.call('apply',['local',{request_id:'stale',epoch:2}]).error,'BASE_HASH_CONFLICT');
 assert.equal(readFileSync(f.root+'/artifact.txt','utf8'),'');
 assert.equal(f.call('safe',['local',{task_id:id,epoch:2,checkpoint:'unsafe'}]).error,'WRITES_NOT_QUIESCENT');
});
test('dirty real Git repository is blocked and user file preserved',t=>{
 const f=fixture(t),id=f.task.id;
 f.request('local','dirty','must not write');writeFileSync(f.root+'/user-uncommitted.txt','keep me');
 assert.equal(f.call('apply',['local',{request_id:'dirty',epoch:2}]).error,'DIRTY_REPOSITORY');
 assert.equal(f.ok('status',id).blocked,1);
 assert.equal(f.call('safe',['local',{task_id:id,epoch:2,checkpoint:'not safe'}]).error,'NEEDS_REVIEW');
 assert.equal(readFileSync(f.root+'/user-uncommitted.txt','utf8'),'keep me');
 assert.equal(readFileSync(f.root+'/artifact.txt','utf8'),'');
});
