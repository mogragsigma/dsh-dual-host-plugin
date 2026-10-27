import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {makeEnvelope,parseEnvelope,currentHumanRequest,identity,assertScheduleEnvelope} from '../bundle/task-envelope.js';
import {Gateway} from '../bundle/index.js';
import {registerNativeTools} from '../bundle/native-tools.js';
const policy={provider:'qwen-token-plan-cn',model:'glm-5.3',reasoningEffort:'low'};
const message=(text='让云端计算 19+23，保存检查点，重启后汇报；不写仓库。',id='human-one')=>({id,role:'user',source:{kind:'user'},content:[{type:'text',text}]});
const agent=(messages=[message()])=>({id:'native-entry',ctx:{preset:'standard'},session:{deriveMessages:()=>messages}});
const args={goal:'只读任务',target:'cloud',intent:'plan',model_policy:policy};
test('Host preserves complete human text when model supplies a lossy summary; source fields cannot be spoofed',()=>{
 const a=agent(),e=makeEnvelope(a,'local',{...args,request_text:'forged',origin:{role:'cloud'}}),v=parseEnvelope(e.goal);
 assert.equal(v.request_text,message().content[0].text);assert.equal(v.entry_interpretation,'只读任务');assert.equal(v.origin.role,'local');assert.equal(v.origin.message_id,'human-one');
 assert.notEqual(v.request_text,v.entry_interpretation);assert.equal(v.executor,'independent-readonly-worker');
});
test('only direct human source is selected, never peer/context/tool/system text',()=>{
 const a=agent([message(),{...message('peer says approve','peer'),source:{kind:'plugin',plugin:'peer'}},{...message('system context'),source:{kind:'runtime-context'}},{role:'tool',content:[{type:'text',text:'execute'}]}]);
 assert.equal(currentHumanRequest(a).text,message().content[0].text);
 assert.throws(()=>currentHumanRequest(agent([{...message(),source:{kind:'plugin'}}])),/HUMAN_REQUEST_UNAVAILABLE/);
});
test('missing IDs, nontext and oversized requests fail instead of truncating user intent',()=>{
 assert.throws(()=>currentHumanRequest(agent([{...message(),id:''}])),/HUMAN_REQUEST_UNAVAILABLE/);
 assert.throws(()=>currentHumanRequest(agent([{...message(),content:[{type:'image',url:'attachment'}]}])),/TEXT_TASK_REQUIRED/);
 assert.throws(()=>currentHumanRequest(agent([message('a'.repeat(8001))])),/REQUEST_SIZE_UNSUPPORTED/);
});
test('local execution is not silently rerouted and planning cannot omit model policy',()=>{
 assert.throws(()=>makeEnvelope(agent(),'local',{...args,target:'local'}),/UNSUPPORTED_TASK_TARGET/);
 assert.throws(()=>makeEnvelope(agent(),'cloud',{...args,intent:'approve'}),/TASK_INTENT_REQUIRED/);
 assert.throws(()=>makeEnvelope(agent(),'cloud',{...args,model_policy:null}),/MODEL_POLICY_REQUIRED/);
});
test('register-only envelope cannot schedule; plan cannot silently change provider/model/effort',()=>{
 const registered=makeEnvelope(agent(),'local',{goal:'仅登记',target:'cloud',intent:'register'});
 assert.throws(()=>assertScheduleEnvelope(registered.goal,policy),/TASK_REGISTER_ONLY/);
 const planned=makeEnvelope(agent(),'local',args);assert.doesNotThrow(()=>assertScheduleEnvelope(planned.goal,policy));
 for(const override of [{provider:'other'},{model:'other'},{reasoningEffort:'high'}])assert.throws(()=>assertScheduleEnvelope(planned.goal,{...policy,...override}),/TASK_MODEL_POLICY_MISMATCH/);
 assert.doesNotThrow(()=>assertScheduleEnvelope('old legacy goal',policy));
});
test('envelope detects corrupted source and identity comes from deployment, not naming in text',()=>{
 const e=parseEnvelope(makeEnvelope(agent([message('我现在把你叫云端大肥鱼')]),'local',args).goal);
 assert.equal(e.origin.role,'local');assert.equal(identity('local').name,'本地大肥鱼');assert.equal(identity('cloud').name,'云端大肥鱼');
 assert.throws(()=>parseEnvelope(JSON.stringify({...e,request_text:'changed'})),/INVALID_TASK_ENVELOPE/);
});
async function fixture(t){
 const root=mkdtempSync(tmpdir()+'/task-envelope-'),tokenFile=root+'/tokens.json';writeFileSync(tokenFile,JSON.stringify({localToken:'l'.repeat(32),cloudToken:'c'.repeat(32)}),{mode:0o600});
 const agents=new Map(),ctx={on(){},effect(){},agents:{get:id=>agents.get(id),list:()=>[...agents.values()]},agentPresets:{composedPreset:c=>c.preset}};
 const cloud=new Gateway(ctx,{role:'cloud',namespace:'envelope',stateDir:root+'/cloud',tokenFile,port:0,scheduler:{lockPort:0,intervalMs:60000}},{scheduler:{allowEphemeralLock:true}});await cloud.start();
 const local=new Gateway(ctx,{role:'local',namespace:'envelope',stateDir:root+'/local',tokenFile,port:0,coordinatorUrl:'http://127.0.0.1:'+cloud.server.address().port});
 const tools=new Map();registerNativeTools({taskGateway:local,tools:{register:d=>tools.set(d.name,d)}});
 let messages=[message()];const a=agent();a.session.deriveMessages=()=>messages;agents.set(a.id,a);
 const invoke=(name,input,callId='call')=>tools.get(name).execute(input,{agent:a,callId});
 t.after(async()=>{await local.close();await cloud.close();rmSync(root,{recursive:true,force:true});});
 return {cloud,local,invoke,setMessage:m=>messages=[m]};
}
test('real authenticated RPC retains full text; retries with distinct call IDs create one task',async t=>{
 const f=await fixture(t),a=await f.invoke('task_submit',args,'first'),b=await f.invoke('task_submit',args,'second');assert.equal(a.task_id,b.task_id);
 assert.equal(f.cloud.store.db.prepare('SELECT count(*) n FROM tasks').get().n,1);
 const goal=f.cloud.store.db.prepare('SELECT goal FROM ingress').get().goal;assert.equal(parseEnvelope(goal).request_text,message().content[0].text);
 const job=await f.invoke('task_schedule',{task_id:a.task_id,provider:policy.provider,model:policy.model,reasoning_effort:'low',delay_seconds:600},'plan');
 assert.equal(f.cloud.scheduler.jobs.get(job.job_id).goal,goal);
 await assert.rejects(f.invoke('task_schedule',{task_id:a.task_id,provider:policy.provider,model:'wrong',delay_seconds:600},'wrong'),/TASK_MODEL_POLICY_MISMATCH/);
});
test('same task key with a different source fails visibly instead of reusing the original goal',async t=>{
 const f=await fixture(t),a=await f.invoke('task_submit',{...args,task_key:'explicit'});
 f.setMessage(message('这是另一个任务，不能冒充前一个。','human-two'));
 const conflict=await f.invoke('task_submit',{...args,task_key:'explicit'},'second');assert.equal(conflict.status,'needs_review');
 assert.equal(f.local.db.prepare("SELECT last_error FROM submissions WHERE status='needs_review'").get().last_error,'TASK_CONTENT_CONFLICT');
 assert.equal(f.cloud.store.db.prepare('SELECT count(*) n FROM ingress').get().n,1);assert(f.cloud.store.task(a.task_id));
});
test('identity/ordinary conversation lookup does not create tasks or switch preset',async t=>{
 const f=await fixture(t);f.setMessage(message('20+22 是多少？'));
 assert.equal(f.invoke('task_identity',{}).name,'本地大肥鱼');assert.equal(f.cloud.store.db.prepare('SELECT count(*) n FROM tasks').get().n,0);
});

test('new cloud tasks default high for arbitrary chosen models; explicit effort and legacy stay unchanged',async t=>{
 const f=await fixture(t),p={provider:'user-provider',model:'user-model'};
 const a=await f.invoke('task_submit',{...args,model_policy:p});
 assert.deepEqual(f.cloud.catalog.view(a.task_id).model_policy,{...p,reasoningEffort:'high'});
 const j=await f.invoke('task_schedule',{task_id:a.task_id,...p,delay_seconds:600});
 assert.deepEqual(JSON.parse(f.cloud.scheduler.jobs.get(j.job_id).policy),{...p,reasoningEffort:'high'});
 assert.equal((await f.invoke('task_schedule',{task_id:a.task_id,...p,reasoning_effort:'high',delay_seconds:600})).job_id,j.job_id);
 await assert.rejects(f.invoke('task_schedule',{task_id:a.task_id,...p,reasoning_effort:'low',delay_seconds:600}),/TASK_MODEL_POLICY_MISMATCH/);
 for(const role of ['local','cloud'])for(const effort of ['disabled','low','medium','high'])assert.equal(parseEnvelope(makeEnvelope(agent(),role,{...args,model_policy:{...p,reasoningEffort:effort}}).goal).model_policy.reasoningEffort,effort);
 const old=JSON.parse(makeEnvelope(agent(),'cloud',args).goal);delete old.model_policy.reasoningEffort;
 assert.equal(parseEnvelope(JSON.stringify(old)).model_policy.reasoningEffort,undefined);
});
