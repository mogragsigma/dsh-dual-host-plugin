import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOnboardingCloudWeb} from '../bundle/onboarding-cloud-web.js';
import {Workbench,workbenchBrowserHost} from '../bundle/workbench-host.js';
const sid='task-worker-'+randomUUID();
function fixture(){
 const target={operationId:randomUUID(),installationId:randomUUID(),runtimeId:randomUUID(),manifestHash:'a'.repeat(64),root:'/owned/cloud',role:'cloud',hostVersion:'0.2.1-rc.3'},instance=randomUUID();
 const managed={target,args:{session_id:sid},proof:{result:{url:'http://127.0.0.1:23456/?token=synthetic',instance_id:instance,session_id:sid},observation:{instance_id:instance}}};let closes=0,calls=0;const returned=structuredClone(target);
 const web=createOnboardingCloudWeb({enabled:()=>true,remote:async(action,args,t)=>{calls++;assert.equal(action,'web_access');assert.deepEqual(args,{});assert.deepEqual(t,target);return {target:returned,value:{port:23456,token:'synthetic',nativeNonce:randomUUID()},tunnel:{port:23457,alive:()=>true,onClose:()=>()=>{},close:async()=>closes++}};}});
 return {web,managed,returned,calls:()=>calls,closes:()=>closes};
}
test('managed task Workbench uses installer carrier with one-use session ticket and no native token',async t=>{
 const f=fixture();t.after(()=>f.web.dispose());const w=new Workbench({}, {c:{role:'local'},link:{call:async(m,a)=>{assert.equal(m,'workbench_bootstrap');assert.deepEqual(a,f.managed.args);return f.managed.proof;}}},{managedOpen:(args,proof)=>f.web.openWorkbench({target:f.managed.target,args,proof})});
 const result=await w.open({session_id:sid}),u=new URL(result.url);assert.equal(u.hostname,'127.0.0.1');assert.equal(u.hash,'#dsh-worker='+sid);assert.equal([...u.searchParams.keys()].join(),'workbench_ticket');assert(!JSON.stringify(result).includes('synthetic'));assert.equal(result.authenticated,false);assert.equal(f.calls(),1);await f.web.close({entryId:result.entryId});assert.equal(f.closes(),1);
});
for(const [name,change] of Object.entries({target:f=>f.returned.runtimeId=randomUUID(),token:f=>f.managed.proof.result.url='http://127.0.0.1:23456/?token=old',port:f=>f.managed.proof.result.url='http://127.0.0.1:23458/?token=synthetic',external:f=>f.managed.proof.result.url='https://evil.invalid/?token=synthetic',session:f=>f.managed.proof.result.session_id='task-worker-'+randomUUID(),instance:f=>f.managed.proof.observation.instance_id=randomUUID(),query:f=>f.managed.proof.result.url+='&extra=1'}))test('managed Workbench fails closed on '+name+' mismatch and closes original tunnel',async()=>{const f=fixture();change(f);await assert.rejects(f.web.openWorkbench(f.managed),/REVIEW|CHANGED/);assert.equal(f.calls(),1);assert.equal(f.closes(),1);await f.web.dispose();});
test('unowned session rejection occurs before any carrier allocation',async()=>{let opens=0;const w=new Workbench({}, {c:{role:'local'},link:{call:async()=>{throw Error('WORKBENCH_SESSION_NOT_FOUND');}}},{managedOpen:async()=>opens++});await assert.rejects(w.open({session_id:sid}),/SESSION_NOT_FOUND/);assert.equal(opens,0);});
test('public setup open still rejects caller-injected proof or session; internal capability not an RPC',async()=>{const f=fixture();await assert.rejects(f.web.open({session_id:sid}),/ARGUMENTS/);await assert.rejects(f.web.open(f.managed),/ARGUMENTS/);assert.equal(f.calls(),0);await f.web.dispose();});

test('managed local Web issues localhost entry only for exact loopback hint',async()=>{
 const f=fixture();f.managed.browserHost='localhost';const r=await f.web.openWorkbench(f.managed);assert.equal(new URL(r.url).hostname,'localhost');await f.web.dispose();
 const bad=fixture();bad.managed.browserHost='external.invalid';await assert.rejects(bad.web.openWorkbench(bad.managed),/ARGUMENTS/);assert.equal(bad.calls(),0);await bad.web.dispose();
});

test('official bridge internal URL never replaces authenticated local Host authority',()=>{
 for(const host of ['localhost:50647','LOCALHOST:50647','localhost'])assert.equal(workbenchBrowserHost(new Request('http://dsh.internal/api/task-workbench/control',{headers:{host}})),'localhost');
 for(const host of ['127.0.0.1:50647','localhost.evil.invalid','user@localhost','localhost/path','evil.invalid'])assert.equal(workbenchBrowserHost(new Request('http://dsh.internal/api/task-workbench/control',{headers:{host}})),'127.0.0.1');
 assert.equal(workbenchBrowserHost(new Request('http://dsh.internal/api/task-workbench/control')),'127.0.0.1');
});
