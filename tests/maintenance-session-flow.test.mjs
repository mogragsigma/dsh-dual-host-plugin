import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createMaintenanceSessionFlow,maintenanceSessionActions} from '../ui-source/onboarding/maintenance-session-flow.js';
const id='11111111-1111-4111-8111-111111111111',host='22222222-2222-4222-8222-222222222222',planId='33333333-3333-4333-8333-333333333333',other='44444444-4444-4444-8444-444444444444';
function fixture(contract=2){
 let time=100,stored=null,lost=false,fail=null,slow=null,pchange={},current={contract:2,instanceId:host,scope:'coordinated_components_only',persisted:true,revision:0,state:'open',receipt:null,operationInFlight:false,hostStopAuthorized:false,pluginSwitchAuthorized:false,live:{operationId:null}},history=[];
 const calls=[],storage={getItem:()=>stored,setItem:(k,v)=>{stored=v;}};
 const request=async(method,args)=>{
  calls.push({method,args});if(slow)await slow;if(fail===method)throw Error('ONBOARDING_TRANSPORT_INTERRUPTED');
  if(method==='maintenance_record_status')return args.operationId?{...current,requestedOperationId:args.operationId,requestedReceipt:history.find(x=>x.id===args.operationId)??null}:current;
  const actions={preview:'acquire',releasePreview:'release',recoveryPreview:'record_observation',retirementPreview:'retire_previous_instance'},action=actions[method.slice(19)];
  if(action)return {id:action==='acquire'?id:planId,operationId:current.receipt?.id,instanceId:host,action,fingerprint:'f'.repeat(64),canApply:true,expiresAt:time+300000,revision:current.revision,scope:['record_observation','retire_previous_instance'].includes(action)?'ledger_only':'coordinated_components_only',componentActions:0,signals:0,hostStopAuthorized:false,pluginSwitchAuthorized:false,...pchange};
  const receipt={id,instanceId:host,state:method.endsWith('retirementApply')?'retired':method.endsWith('releaseApply')?'released':'held',updatedAt:time};history=history.filter(x=>x.id!==id).concat(receipt);current={...current,revision:current.revision+1,receipt,state:receipt.state==='held'?'held':'open',live:{operationId:receipt.state==='held'?id:null}};
  if(lost)throw Error('ONBOARDING_TRANSPORT_INTERRUPTED');return current;
 };
 const make=()=>createMaintenanceSessionFlow(request,()=>{},contract,storage,()=>time);let flow=make();
 return {calls,storage,get:()=>flow.get(),act:(...a)=>flow.act(...a),gates:()=>maintenanceSessionActions(flow.get(),contract,time),reopen:()=>flow=make(),cancel:()=>flow.cancel(),advance:n=>{time+=n;},lose:x=>lost=x,fail:x=>fail=x,changePlan:x=>pchange=x,hold:x=>slow=x,current:x=>{current={...current,...x};if(x.receipt)history.push(x.receipt);}};
}
async function plan(f){await f.act('refresh');await f.act('acquire');}
test('session mount/reopen is inert; a preview cannot substitute for explicit consent',async()=>{
 const f=fixture();assert.equal(f.calls.length,0);assert.equal(await f.act('acquire'),false);await plan(f);assert.equal(await f.act('confirm'),false);assert.equal(await f.act('confirm','yes'),false);f.reopen();assert.equal(f.get().plan,null);assert.equal(f.calls.length,2);
});
test('acquire then separately preview and confirm release; browser stores only a query reference',async()=>{
 const f=fixture();await plan(f);assert(await f.act('confirm',true));assert(f.gates().release);assert.equal(await f.act('confirm',true),false);await f.act('release');assert(await f.act('confirm',true));assert.equal(f.get().current.state,'open');assert.deepEqual(JSON.parse(f.storage.getItem()),{operationId:id});assert(!f.storage.getItem().includes('fingerprint'));
});
test('lost acknowledgement is resolved with a manual read, never repeated mutation',async()=>{
 const f=fixture();await plan(f);f.lose(true);assert.equal(await f.act('confirm',true),false);assert(f.get().uncertain);assert(!f.gates().acquire);f.reopen();assert.equal(f.get().plan,null);f.lose(false);assert(await f.act('refresh'));assert.equal(f.get().current.state,'held');assert(!f.get().uncertain);assert.equal(f.calls.filter(x=>x.method==='maintenance_record_apply').length,1);
});
test('missing receipt remains unknown; timeout does not grant a new acquisition',async()=>{
 const f=fixture();await plan(f);f.fail('maintenance_record_apply');await f.act('confirm',true);f.fail(null);f.reopen();await f.act('refresh');assert(f.get().uncertain);assert.equal(f.get().receipt,null);assert(!f.gates().acquire);
});
test('older query receipt cannot hide the currently active operation',async()=>{
 const f=fixture();await plan(f);await f.act('confirm',true);await f.act('release');await f.act('confirm',true);f.current({state:'interrupted',receipt:{id:other,instanceId:other,state:'held'}});f.reopen();await f.act('refresh');assert.equal(f.get().receipt.id,id);assert.equal(f.get().current.receipt.id,other);assert(f.gates().retire_previous_instance);assert(!f.gates().acquire);
});
test('old-instance retirement needs its own preview and confirmation; no inferred release',async()=>{
 const f=fixture();f.current({state:'interrupted',receipt:{id,instanceId:other,state:'held'}});await f.act('refresh');assert.equal(await f.act('release'),false);assert.equal(await f.act('confirm',true),false);await f.act('retire_previous_instance');assert.equal(await f.act('confirm'),false);assert(await f.act('confirm',true));assert.equal(f.get().receipt.state,'retired');assert(!f.calls.some(x=>x.method.includes('release')));
});
test('same-instance reconciliation remains a separate ledger-only action',async()=>{
 const f=fixture();f.current({state:'needs_review',receipt:{id,instanceId:host,state:'acquire_intent'}});await f.act('refresh');assert(f.gates().record_observation);await f.act('record_observation');await f.act('confirm',true);assert.equal(f.calls.at(-1).method,'maintenance_record_recover');
});
test('expiry is checked at dispatch, not just when the button last rendered',async()=>{
 const f=fixture();await plan(f);f.advance(300001);assert.equal(await f.act('confirm',true),false);assert(!f.calls.some(x=>x.method==='maintenance_record_apply'));
});
test('manual refresh failure invalidates the prior plan and observation',async()=>{
 const f=fixture();await plan(f);f.fail('maintenance_record_status');await f.act('refresh');assert.equal(f.get().plan,null);assert(!f.get().fresh);assert.equal(await f.act('acquire'),false);
});
test('unsupported contract, busy state and denied plan do not submit',async()=>{
 const old=fixture(1);assert.equal(await old.act('refresh'),false);assert.equal(old.calls.length,0);const f=fixture();f.current({operationInFlight:true});await f.act('refresh');assert(!f.gates().acquire);f.current({operationInFlight:false});f.changePlan({canApply:false});await plan(f);assert.equal(await f.act('confirm',true),false);
});
test('plan mismatches and expanded authority fail closed',async()=>{
 for(const patch of [{scope:'whole_host'},{hostStopAuthorized:true},{pluginSwitchAuthorized:true},{instanceId:other},{revision:9},{fingerprint:'abc'},{action:'release'}]){const f=fixture();f.changePlan(patch);await plan(f);assert.equal(f.get().error,'ONBOARDING_TRANSPORT_RESPONSE_INVALID');assert.equal(await f.act('confirm',true),false);}
 const f=fixture();f.current({state:'interrupted',receipt:{id,instanceId:other,state:'held'}});await f.act('refresh');f.changePlan({signals:1});await f.act('retire_previous_instance');assert.equal(f.get().error,'ONBOARDING_TRANSPORT_RESPONSE_INVALID');
});
test('storage failure blocks dispatch, cancellation discards approval, double-click does not duplicate',async()=>{
 const f=fixture();await plan(f);f.storage.setItem=()=>{throw Error('private text');};assert.equal(await f.act('confirm',true),false);assert.equal(f.get().error,'ONBOARDING_MAINTENANCE_REFERENCE_UNAVAILABLE');assert(!f.calls.some(x=>x.method==='maintenance_record_apply'));
 const g=fixture();await plan(g);g.cancel();assert.equal(await g.act('confirm',true),false);await plan(g);let resolve;g.hold(new Promise(r=>resolve=r));const p=g.act('confirm',true);assert.equal(await g.act('confirm',true),false);resolve();await p;assert.equal(g.calls.filter(x=>x.method==='maintenance_record_apply').length,1);
});
test('UI uses shared approved controls, distinct current/history text and negotiated capabilities',async()=>{
 const ui=await fs.readFile(new URL('../ui-source/onboarding/maintenance-session.jsx',import.meta.url),'utf8'),client=await fs.readFile(new URL('../ui-source/workbench-client.js',import.meta.url),'utf8'),app=await fs.readFile(new URL('../ui-source/onboarding/app.jsx',import.meta.url),'utf8');
 assert(ui.includes("held:'该记录当时已取得组件锁'"));assert(ui.includes('historyStates[r.state]'));assert(!ui.includes('setInterval'));assert(!ui.includes('setTimeout'));assert(!ui.includes('<button'));for(const text of ['当前观察','查询到的记录','第三方 IM','不授权停机','手动核对会话与回执'])assert(ui.includes(text));
 assert(client.includes('maintenanceRecordQueryContract===1'));assert(app.includes('<MaintenanceSession request={request} contract={maintenanceSessionContract}/>'));
});

test('maintenance recovery entry is present in early draft-error return and normal header',async()=>{
 const app=await fs.readFile(new URL('../ui-source/onboarding/app.jsx',import.meta.url),'utf8');
 const start=app.indexOf(' const maintenanceEntry='),end=app.indexOf(' if(persistenceEnabled&&!draftMeta.ready)return',start),entry=app.slice(start,end);
 assert(start>0);assert(entry.includes('(maintenanceSessionContract===2||imMaintenanceContract===1||selfDisableContract===1||selfRemoveContract===1||selfStopContract===1)&&<Button'));assert(entry.includes('maintenanceSessionContract===2&&<MaintenanceSession request={request} contract={maintenanceSessionContract}/>'));
 for(const text of ['disabled=','draftMeta','page===','request('])assert(!entry.includes(text));
 const early=app.slice(end,app.indexOf(' return <HelpProvider',end));assert(early.includes('{maintenanceEntry}'));assert(early.includes('<Modal modal={modal}'));assert(!early.includes('<fieldset'));assert(!early.includes('<Field '));
 const header=app.slice(app.indexOf('<div className="page-top-actions">'),app.indexOf('<div className="page-progress'));assert(header.includes('{maintenanceEntry}'));
 assert(app.includes('关闭（不释放组件锁）'));assert.equal(app.match(/<MaintenanceSession /g)?.length,1);
});

test('resume UI is a separate explicit action; old contracts and unfinished receipts never expose it',async()=>{
 const f=fixture();await f.act('refresh');assert(!f.gates().resume_admission);
 f.current({admission:{contract:1,blocked:true},receipt:{id,instanceId:other,state:'held'},state:'interrupted'});await f.act('refresh');assert(!f.gates().resume_admission);assert(!f.gates().acquire);
 f.current({receipt:{id,instanceId:other,state:'retired'},state:'open'});await f.act('refresh');assert(f.gates().resume_admission);assert(!f.gates().acquire);assert.equal(await f.act('confirm',true),false);
});
for(const empty of [false,true])test(`resume lost-ack query binds the exact resume decision, not merely an old receipt; empty=${empty}`,async()=>{
 const calls=[];let stored=null,applied=false,lost=true;
 const receipt=empty?null:{id,instanceId:other,state:'retired'};
 const value=()=>({contract:2,instanceId:host,scope:'coordinated_components_only',persisted:true,revision:1,state:'open',receipt,operationInFlight:false,hostStopAuthorized:false,pluginSwitchAuthorized:false,live:{operationId:null},admission:{contract:1,blocked:!applied,durable:{decision:applied?{id:planId}:null}}});
 const request=async(method,args)=>{calls.push(method);
  if(method==='maintenance_record_status')return {...value(),...(args.operationId?{requestedOperationId:id,requestedReceipt:receipt}:{})};
  if(method==='maintenance_record_resumePreview')return {action:'resume_admission',id:planId,operationId:receipt?.id??null,instanceId:host,revision:1,scope:'own_execution_startup_only',canApply:true,expiresAt:300000,fingerprint:'f'.repeat(64),hostStopAuthorized:false,pluginSwitchAuthorized:false};
  assert.equal(method,'maintenance_record_resumeApply');assert(args.confirm);if(lost)throw Error('ONBOARDING_TRANSPORT_INTERRUPTED');applied=true;return value();
 };
 const storage={getItem:()=>stored,setItem:(_,v)=>stored=v};let flow=createMaintenanceSessionFlow(request,()=>{},2,storage,()=>100);
 await flow.act('refresh');assert(await flow.act('resume_admission'));assert.equal(await flow.act('confirm'),false);assert.equal(await flow.act('confirm',true),false);assert.deepEqual(JSON.parse(stored),{operationId:receipt?.id??null,decisionId:planId});
 flow=createMaintenanceSessionFlow(request,()=>{},2,storage,()=>100);await flow.act('refresh');assert(flow.get().uncertain);assert(!maintenanceSessionActions(flow.get(),2,100).resume_admission);
 applied=true;await flow.act('refresh');assert(!flow.get().uncertain);assert.equal(calls.filter(x=>x==='maintenance_record_resumeApply').length,1);
});
