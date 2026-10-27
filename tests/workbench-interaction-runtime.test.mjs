import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {Gateway} from '../bundle/index.js';
import {installWorkbench,officialDesktopCarrier,workbenchInteractionOrigin} from '../bundle/workbench-host.js';
import {CAPABILITIES,requireCapability,errorInfo} from '../bundle/link-contract.js';
import {makeEnvelope} from '../bundle/task-envelope.js';
import {proposal} from './approval-fixture.mjs';
const key='a'.repeat(64);
test('Desktop exception requires the official Electron Node Host, not a browser hint',()=>{
 const runtime={versions:{electron:'41.0.0'},env:{ELECTRON_RUN_AS_NODE:'1'},argv:['electron','/official/@deepseek-ai/dsh-desktop-host/lib/index.js']};
 assert(officialDesktopCarrier(runtime));assert(officialDesktopCarrier({...runtime,argv:['electron','C:\\official\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js']}));
 for(const changed of [{versions:{}},{env:{}},{argv:['node','/other/main.js']},{argv:['node','/fake@deepseek-ai/dsh-desktop-host/lib/index.js']}])assert.equal(officialDesktopCarrier({...runtime,...changed}),false);
});
for(const [label,headers,options,accepted] of [
 ['owned Desktop',{}, {desktop:true,serverOrigin:'http://127.0.0.1:19400'},true],
 ['Web missing origin',{}, {desktop:false,serverOrigin:'http://127.0.0.1:19400'},false],
 ['wrong Host',{}, {desktop:true,serverOrigin:'http://127.0.0.1:19401'},false],
 ['remote server',{}, {desktop:true,serverOrigin:'http://example.invalid:19400'},false],
 ['null origin',{origin:'null'}, {desktop:true,serverOrigin:'http://127.0.0.1:19400'},false],
 ['foreign origin',{origin:'https://wrong.invalid'}, {desktop:true,serverOrigin:'http://127.0.0.1:19400'},false],
 ['direct custom scheme',{origin:'dsh-app://app'}, {desktop:true,serverOrigin:'http://127.0.0.1:19400'},false],
 ['cross site',{'sec-fetch-site':'cross-site'}, {desktop:true,serverOrigin:'http://127.0.0.1:19400'},false],
 ['forged hint',{'x-dsh-desktop':'true'}, {desktop:false,serverOrigin:'http://127.0.0.1:19400'},false],
 ['no server',{}, {desktop:true},false]
])test('native interaction fence: '+label,()=>{const r=new Request('http://dsh.internal/api/task-workbench/control',{method:'POST',headers:{host:'127.0.0.1:19400',...headers}});assert.equal(workbenchInteractionOrigin(r,options),accepted);});
function route(g){let handler;installWorkbench({inject(_n,fn){fn({effect(){},connection:{fetch:{register:r=>handler=r.fetch}}});}},g,{enabled:true});return handler;}
function request(origin,method='describe',args={}){return new Request('http://dsh.internal/api/task-workbench/control',{method:'POST',headers:{host:'localhost:19400',...(origin===undefined?{}:{origin})},body:JSON.stringify({type:'client-request',rpcId:'interaction',method:'task-workbench/control',payload:{method:'approval-interaction-'+method,args}})});}
for(const origin of [undefined,'null','https://wrong.invalid','http://localhost:19401','file://localhost:19400'])test('browser origin guard rejects '+origin,async()=>{let calls=0,held=0;const h=route({c:{role:'local'},maintenance:{enter:()=>{held++;return()=>held--;}},call:()=>{calls++;return {};}});const r=await(await h(request(origin))).json();assert.equal(r.result.error.code,'APPROVAL_BROWSER_ORIGIN_REQUIRED');assert.equal(calls,0);assert.equal(held,0);});
test('verified native Host header, not internal URL, scopes the handler',async()=>{let got;const h=route({c:{role:'local'},call:async(m,a)=>{got={m,a};return {schema:1,execution_granted:false};}});const r=await(await h(request('http://localhost:19400'))).json();assert.equal(r.result.ok,true);assert.equal(got.m,'approval_interaction_describe');});
test('old peers cannot downgrade the new interaction into old identity methods',()=>{const hello=role=>({schema:1,protocol:{min:1,max:1},role,namespace:'x',plugin_version:'0.33.0-alpha.4',instance_id:'00000000-0000-0000-0000-000000000000',capabilities:{...CAPABILITIES}});const a=hello('local'),b=hello('cloud');delete b.capabilities.approval_interaction;for(const m of ['approval_interaction_prepare','approval_interaction_confirm','approval_interaction_identity_send'])assert.throws(()=>requireCapability(m,a,b),/CAPABILITY/);assert.doesNotThrow(()=>requireCapability('approval_status',a,b));});
test('paired real gateway + browser handler prepare to cloud, never grants without IM identity',async t=>{
 const dir=mkdtempSync(tmpdir()+'/workbench-interaction-'),secrets={localToken:'l'.repeat(32),cloudToken:'c'.repeat(32)},ctx={on(){},effect(){},agents:{get(){},list:()=>[]},agentPresets:{composedPreset:()=> 'standard'}};
 const cloud=new Gateway(ctx,{role:'cloud',entryMode:'native',namespace:'isolated-interaction',stateDir:dir+'/cloud',port:0,peerEnabled:false},{secrets});await cloud.start();
 const local=new Gateway(ctx,{role:'local',entryMode:'native',namespace:'isolated-interaction',stateDir:dir+'/local',port:0,peerEnabled:false,coordinatorUrl:'http://127.0.0.1:'+cloud.server.address().port},{secrets});t.after(async()=>{await local.close();await cloud.close();rmSync(dir,{recursive:true,force:true});});
 const e=makeEnvelope({id:'isolated',session:{deriveMessages:()=>[{id:'m',role:'user',source:{kind:'user'},content:[{type:'text',text:'只验收审批，不执行'}]}]}},'local',{goal:'只验收审批',target:'cloud',intent:'register'});
 const task=await local.submit({goal:e.goal,task_key:e.task_key,ingress_id:e.ingress_id,source:'native-local'});cloud.catalog.head(task.task_id);
 const r=cloud.approvals.request('local',{task_id:task.task_id,expected_revision:1,event_id:'isolated-proposal',proposal});const h=route(local),a={client_key:key,event_id:'isolated-operation',task_id:task.task_id,request_id:r.id,expected_revision:1,text:'可以，但报告改成两段'};
 const p=await(await h(request('http://localhost:19400','prepare',a))).json();assert.equal(p.result.value.interpretation.intent,'amend');assert.equal(p.result.value.prepared,true);
 const saved=await(await h(request('http://localhost:19400','confirm',{client_key:key,event_id:a.event_id}))).json();assert.equal(saved.result.error.code,'APPROVAL_IDENTITY_REQUIRED');assert.equal(cloud.store.db.prepare('SELECT count(*) n FROM approval_decisions').get().n,0);
 const status=await local.call('approval_interaction_status',{client_key:key,event_id:a.event_id});assert.equal(status.user_text,a.text);assert.equal(status.execution_granted,false);
});

test('changed or interrupted opinions require review, not transport retries',()=>{for(const code of ['APPROVAL_WORKBENCH_CHANGED','APPROVAL_OPERATION_NOT_READY','APPROVAL_IDENTITY_SOURCE_CHANGED','APPROVAL_INTERPRETATION_INTERRUPTED','APPROVAL_INTERPRETATION_UNAVAILABLE'])assert.equal(errorInfo(code).retry,'operator_review');});
test('intervention browser actions require exact current Host origin and route independently',async()=>{let got;const h=route({c:{role:'local'},call:async(m,a)=>{got={m,a};return {schema:1,grants_execution:false};}});const make=origin=>new Request('http://dsh.internal/api/task-workbench/control',{method:'POST',headers:{host:'localhost:19400',origin},body:JSON.stringify({type:'client-request',rpcId:'exception',method:'task-workbench/control',payload:{method:'intervention-action-inspect',args:{task_id:'t'}}})});const bad=await(await h(make('http://localhost:19401'))).json();assert.equal(bad.result.ok,false);assert.equal(got,undefined);const good=await(await h(make('http://localhost:19400'))).json();assert(good.result.ok);assert.equal(got.m,'intervention_action_inspect');});
