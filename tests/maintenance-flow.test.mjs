import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createMaintenanceFlow,maintenanceActions} from '../ui-source/onboarding/maintenance-flow.js';
const id='11111111-1111-4111-8111-111111111111';
function fixture(caps={contract:2,mutation:true}){
 let clock=100,fail=null,lost=false,current={state:'inspected',installedVersion:'old'},receipt=null,stored=null,slow=null;
 const calls=[],storage={getItem:()=>stored,setItem:(k,v)=>stored=v};
 const request=async(method,args)=>{calls.push({method,args});if(slow)await slow;if(fail===method)throw Error('ONBOARDING_UNAVAILABLE');
  if(method==='maintenance_status'){if(args.id){if(!receipt)throw Error('ONBOARDING_MAINTENANCE_OPERATION_NOT_FOUND');return receipt;}return current;}
  if(method==='maintenance_preview')return {id,contract:2,action:args.action,fingerprint:'abc',canApply:true,mutationAvailable:true,expiresAt:clock+300000};
  if(method==='maintenance_recoveryPreview')return {id,fingerprint:'recovery',action:current.state==='committed'?'finalize_receipt':'rollback_incomplete_changes',confirmRequired:true,expiresAt:clock+300000};
  receipt={id,action:'upgrade',state:method==='maintenance_recover'?'rolled_back':'committed'};if(lost)throw Error('ONBOARDING_TRANSPORT_INTERRUPTED');return receipt;
 };
 const make=()=>createMaintenanceFlow(request,()=>{},caps,storage,()=>clock);let flow=make();
 return {calls,storage,get:()=>flow.get(),act:(...a)=>flow.act(...a),gates:()=>maintenanceActions(flow.get(),caps,clock),setCurrent:x=>current=x,fail:x=>fail=x,lose:x=>lost=x,tick:n=>clock+=n,hold:p=>slow=p,reopen:()=>flow=make()};
}
test('mount/reopen never reads or writes; manual inspect then preview is not approval',async()=>{
 const f=fixture();assert.equal(f.calls.length,0);assert(!f.gates().preview);await f.act('refresh');await f.act('upgrade');assert.equal(await f.act('apply'),false);assert.equal(await f.act('apply','yes'),false);assert(!f.calls.some(c=>c.method==='maintenance_apply'));f.reopen();assert.equal(f.get().plan,null);
});
test('explicit apply once; manual receipt query recovers a lost response without resending',async()=>{
 const f=fixture();await f.act('refresh');await f.act('upgrade');f.lose(true);assert.equal(await f.act('apply',true),false);assert(f.get().uncertain);assert(!f.gates().preview);f.reopen();assert(f.get().uncertain);assert.equal(f.get().plan,null);f.lose(false);await f.act('refresh');assert.equal(f.get().receipt.state,'committed');assert(!f.get().uncertain);assert.equal(f.calls.filter(c=>c.method==='maintenance_apply').length,1);
 assert.deepEqual(JSON.parse(f.storage.getItem()),{id});
});
test('unknown request with no journal remains unknown after manual inspection',async()=>{
 const f=fixture();await f.act('refresh');await f.act('upgrade');f.fail('maintenance_apply');await f.act('apply',true);f.fail(null);await f.act('refresh');assert(f.get().uncertain);assert.equal(f.get().error,'ONBOARDING_MAINTENANCE_OPERATION_NOT_FOUND');assert(!f.gates().preview);
});
test('expired preview cannot dispatch, even if the UI has not re-rendered',async()=>{
 const f=fixture();await f.act('refresh');await f.act('uninstall');f.tick(300001);assert.equal(await f.act('apply',true),false);assert(!f.calls.some(c=>c.method==='maintenance_apply'));
});
test('manual refresh invalidates earlier confirmation plans even if refresh fails',async()=>{
 const f=fixture();await f.act('refresh');await f.act('upgrade');f.fail('maintenance_status');await f.act('refresh');assert.equal(f.get().plan,null);assert(!f.gates().apply);
});
test('mutation-disabled and older contracts never submit even if a server advertises a mutable plan',async()=>{
 for(const caps of [{contract:1,mutation:true},{contract:2,mutation:false}]){const f=fixture(caps);await f.act('refresh');await f.act('upgrade');assert.equal(await f.act('apply',true),false);f.setCurrent({id,state:'needs_review',canRecover:true});await f.act('refresh');assert.equal(await f.act('recovery_preview'),false);}
});
test('recovery must first show an independently confirmed plan; committed cleanup is not rollback',async()=>{
 for(const state of ['committed','applying']){const f=fixture();f.setCurrent({id,state,canRecover:true});await f.act('refresh');assert(!f.gates().preview);assert.equal(await f.act('recover',true),false);await f.act('recovery_preview');assert.equal(f.get().recovery.action,state==='committed'?'finalize_receipt':'rollback_incomplete_changes');assert.equal(await f.act('recover'),false);assert(await f.act('recover',true));assert.equal(f.calls.filter(c=>c.method==='maintenance_recover').length,1);}
});
test('missing first journal cannot offer automatic recovery',async()=>{
 const f=fixture();f.setCurrent({id,state:'needs_review',canRecover:false,error:'ONBOARDING_MAINTENANCE_INCOMPLETE_JOURNAL'});await f.act('refresh');assert(!f.gates().recover);assert(!f.gates().preview);assert.equal(await f.act('recover',true),false);
});
test('overlapping clicks cannot send two apply calls',async()=>{
 const f=fixture();await f.act('refresh');await f.act('upgrade');let resolve;f.hold(new Promise(r=>resolve=r));const p=f.act('apply',true);assert.equal(await f.act('apply',true),false);resolve();await p;assert.equal(f.calls.filter(c=>c.method==='maintenance_apply').length,1);
});
test('query reference storage failure prevents mutation dispatch',async()=>{
 const f=fixture();await f.act('refresh');await f.act('upgrade');f.storage.setItem=()=>{throw Error('private-detail');};assert.equal(await f.act('apply',true),false);assert(!f.calls.some(c=>c.method==='maintenance_apply'));assert(!f.get().error.includes('private-detail'));
});
test('current inspection and historical receipt remain distinct after reopen',async()=>{
 const f=fixture();f.setCurrent({state:'needs_review',lastReceipt:{id,state:'committed',action:'upgrade'}});await f.act('refresh');assert.equal(f.get().current.state,'needs_review');assert.equal(f.get().receipt.state,'committed');
});
test('UI is connected to explicit negotiated capability and existing component styles',async()=>{
 const ui=await fs.readFile(new URL('../ui-source/onboarding/maintenance.jsx',import.meta.url),'utf8'),client=await fs.readFile(new URL('../ui-source/workbench-client.js',import.meta.url),'utf8');
 assert(!ui.includes('setInterval'));assert(!ui.includes('setTimeout'));assert(!ui.includes('<button'));
 for(const label of ['待确认计划','持久回执','手动核对维护状态与回执','插件本体','另一端需分别进入并确认'])assert(ui.includes(label));
 assert(client.includes('rulesMaintenancePreviewContract'));assert(client.includes('rulesMaintenanceMutation'));
});

test('current incomplete transaction outranks a browser reference to a previous successful action',async()=>{
 const f=fixture();await f.act('refresh');await f.act('upgrade');await f.act('apply',true);
 const current={id:'22222222-2222-4222-8222-222222222222',state:'applying',action:'uninstall',canRecover:true};f.setCurrent(current);f.reopen();const n=f.calls.length;
 await f.act('refresh');assert.equal(f.get().receipt.id,current.id);assert.equal(f.get().receipt.action,'uninstall');assert(f.get().uncertain);assert(f.gates().recover);assert(!f.gates().preview);
 assert.deepEqual(f.calls.slice(n),[{method:'maintenance_status',args:{}}]);
});
test('committed transaction pending cleanup is not hidden by an older rolled-back receipt',async()=>{
 const f=fixture();await f.act('refresh');await f.act('upgrade');await f.act('apply',true);
 const current={id:'22222222-2222-4222-8222-222222222222',state:'committed',action:'uninstall',canRecover:true,recoveryAction:'finalize_receipt'};f.setCurrent(current);await f.act('refresh');assert.equal(f.get().receipt.id,current.id);assert(!f.get().uncertain);assert(f.gates().recover);assert(!f.gates().preview);
});
test('incomplete first journal remains visible even with a stale browser receipt reference',async()=>{
 const f=fixture();f.storage.setItem('',JSON.stringify({id}));f.reopen();const current={id:'22222222-2222-4222-8222-222222222222',state:'needs_review',error:'ONBOARDING_MAINTENANCE_INCOMPLETE_JOURNAL',canRecover:false};f.setCurrent(current);await f.act('refresh');assert.equal(f.get().receipt.id,current.id);assert(!f.get().error);assert(!f.gates().preview);assert(!f.gates().recover);
});
test('recovery confirmation shows original operation and affected owned files',async()=>{
 const ui=await fs.readFile(new URL('../ui-source/onboarding/maintenance.jsx',import.meta.url),'utf8');assert(ui.includes('当前事务'));assert(ui.includes('原事务涉及'));assert(ui.includes('state.current.files.map'));assert(ui.includes('label="原操作"'));
});
