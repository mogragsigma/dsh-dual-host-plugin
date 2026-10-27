import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {Gateway} from '../bundle/index.js';
import {apply} from '../bundle/tools.js';
import {TaskScheduler} from '../bundle/task-scheduler.js';
async function fixture(t){
 const root=mkdtempSync(tmpdir()+'/dual-controls-'),tokenFile=root+'/tokens.json';writeFileSync(tokenFile,JSON.stringify({localToken:'l'.repeat(32),cloudToken:'c'.repeat(32),a2aKey:'a'.repeat(32)}),{mode:0o600});
 const agents=new Map(),ctx={on(){},effect(){},agents:{get:id=>agents.get(id),list:()=>[...agents.values()]},agentPresets:{composedPreset:c=>c.preset}};
 const base={legacyFeishu:true,peerEnabled:false,namespace:'unit',chatId:'oc_test',ownerOpenId:'ou_owner',peerOpenId:'ou_peer',port:0,tokenFile};
 const cloud=new Gateway(ctx,{...base,role:'cloud',stateDir:root+'/cloud',scheduler:{lockPort:0,intervalMs:60000}},{scheduler:{allowEphemeralLock:true}});await cloud.start();
 const local=new Gateway(ctx,{...base,role:'local',stateDir:root+'/local',coordinatorUrl:'http://127.0.0.1:'+cloud.server.address().port});
 const tools=new Map();let guard;apply({taskGateway:local,tools:{register:d=>tools.set(d.name,d),guard:f=>{guard=f;}}});
 const agent={id:'desktop',ctx:{preset:'dsh-task-intake'}};agents.set(agent.id,agent);
 const invoke=(name,args,id='call')=>tools.get(name).execute(args,{agent,callId:id});
 t.after(async()=>{await local.close();await cloud.close();rmSync(root,{recursive:true,force:true});});return {local,cloud,tools,agent,guard,invoke};
}
test('Desktop native tools forward exact model policy and pause/resume over real authenticated RPC',async t=>{
 const f=await fixture(t),task=await f.invoke('task_submit',{task_key:'entry',goal:'only plan'},'accept');
 const a={task_id:task.task_id,provider:'chosen',model:'glm-5.3',reasoning_effort:'low',delay_seconds:'600'};
 const job=await f.invoke('task_schedule',a,'schedule');assert.deepEqual(JSON.parse(f.cloud.scheduler.jobs.get(job.job_id).policy),{provider:'chosen',model:'glm-5.3',reasoningEffort:'low'});
 assert.equal((await f.invoke('task_schedule',a,'schedule')).job_id,job.job_id);
 assert.equal((await f.invoke('task_control',{job_id:job.job_id,action:'pause'},'pause')).status,'paused');assert.equal(f.cloud.scheduler.jobs.get(job.job_id).attempts,0);
 assert.equal((await f.invoke('task_control',{job_id:job.job_id,action:'resume'},'resume')).status,'queued');assert.equal(f.cloud.scheduler.jobs.get(job.job_id).attempts,0);
 assert.equal((await f.invoke('task_control',{job_id:job.job_id,action:'cancel'},'cancel')).status,'cancelled');
});
test('Desktop control does not expose approval/writes and rejects forged or unmanaged agents',async t=>{
 const f=await fixture(t);assert.equal(f.guard({name:'task_control'}),undefined);assert.ok(f.guard({name:'approve'}));assert.ok(f.guard({name:'shell'}));
 assert.deepEqual(f.tools.get('task_control').parameters.properties.action.enum,['pause','resume','cancel']);
 for(const action of ['approve','write','release'])assert.throws(()=>f.invoke('task_control',{job_id:'none',action}),/INVALID_CONTROL_ACTION/);
 assert.throws(()=>f.tools.get('task_control').execute({job_id:'none',action:'pause'},{agent:{...f.agent},callId:'x'}),/UNBOUND/);
 f.agent.ctx.preset='default';assert.throws(()=>f.invoke('task_control',{job_id:'none',action:'pause'}),/UNBOUND/);
});
test('local Feishu schedules one cloud job; cloud pause and local resume control the same identity',async t=>{
 const f=await fixture(t),msg=(text,msgId)=>({platform:'feishu',chatId:'oc_test',senderType:'user',userId:'ou_owner',text,msgId});
 await f.local.receive(msg('/task pair only read','a'));const job=await f.local.receive(msg('/run pair chosen model 600','b'));
 assert.equal((await f.cloud.receive(msg('/pause '+job.job_id,'c'))).status,'paused');
 assert.equal((await f.local.receive(msg('/resume '+job.job_id,'d'))).status,'queued');
 const status=await f.local.receive(msg('/status pair','e'));assert.equal(status.jobs.length,1);assert.equal(status.jobs[0].id,job.job_id);
 await assert.rejects(f.local.receive(msg('/approve '+job.job_id+' '+'0'.repeat(64),'x')),/INVALID_COMMAND/);
});
test('local control outage never claims success and does not mutate cloud state',async t=>{
 const f=await fixture(t),task=await f.invoke('task_submit',{task_key:'outage',goal:'only plan'},'task');const j=await f.invoke('task_schedule',{task_id:task.task_id,provider:'p',model:'m',delay_seconds:'600'},'schedule');
 f.local.c.coordinatorUrl='http://127.0.0.1:1';await assert.rejects(f.invoke('task_control',{job_id:j.job_id,action:'pause'},'pause'));assert.equal(f.cloud.scheduler.jobs.get(j.job_id).status,'queued');
});
test('replaying an old pause after resume cannot abort the new active run',async t=>{
 const root=mkdtempSync(tmpdir()+'/pause-replay-'),s=new TaskScheduler({on(){}},{stateDir:root,lockPort:0,intervalMs:60000},{allowEphemeralLock:true});t.after(async()=>{await s.close();rmSync(root,{recursive:true,force:true});});
 let resolve;s.register('test.checkpoint',{replaySafe:true,run:(_job,signal)=>new Promise(r=>{resolve=r;signal.addEventListener('abort',()=>r({outcome:'done',summary:'aborted'}),{once:true});})});
 await s.start();const j=s.jobs.enqueue({task_id:'t',trigger_id:'one',goal:'test',kind:'test.checkpoint'});
 const pause={id:j.id,action:'pause',actor:'owner',event_id:'pause-old'};s.control(pause);s.control({id:j.id,action:'resume',actor:'owner',event_id:'resume'});s.tick();await Promise.resolve();
 const active=s.active.get(j.id);assert.equal(s.jobs.get(j.id).status,'running');s.control(pause);assert.equal(active.controller.signal.aborted,false);assert.equal(s.jobs.get(j.id).status,'running');
 resolve({outcome:'done',summary:'new run survives'});await active.run;assert.equal(s.jobs.get(j.id).status,'completed');
});
