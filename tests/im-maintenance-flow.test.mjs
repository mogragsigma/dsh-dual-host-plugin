import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createImMaintenanceFlow,imMaintenanceActions} from '../ui-source/onboarding/im-maintenance-flow.js';
import {createOnboardingImMaintenance} from '../bundle/onboarding-im-maintenance.js';
const KEY='dsh-task-gateway/onboarding-im-maintenance-v1';
function fixture(contract=1,allow=true){
 const records=new Map(),calls=[],effects=[];let time=1000,stored=null,lose=false,before=false,down=false,patch={},slow=null,unknown=false,state='connected';
 const credentials={readRecord:async k=>structuredClone(records.get(k)),modifyRecord:async(k,fn)=>records.set(k,structuredClone(fn(structuredClone(records.get(k)))))},im={contractVersion:1};
 const service=createOnboardingImMaintenance({credentials:()=>credentials,im:()=>im,now:()=>time,processIdentity:{capture:async()=>null,observe:async()=>({state:'exited'})}});
 const rows=()=>[{botId:'isolated-bot',name:'独立测试机器人',channel:'feishu',configured:true,connected:state==='connected',state,configHash:'a'.repeat(64)}];
 const transport={call:async(action,id)=>{if(down)throw Error('SECRET');if(action!=='status'){assert.equal(id,'isolated-bot');effects.push(action);state=action==='disconnect'?'disconnected':'connected';if(unknown)throw Error('SECRET');}return rows();}};
 const request=async(method,args)=>{calls.push({method,args});if(slow)await slow;const mutation=['im_maintenance_apply','im_maintenance_reconcileApply'].includes(method);if(mutation&&before)throw Error('ONBOARDING_TRANSPORT_INTERRUPTED');const result=await service[method.slice(15)](args,transport);if(mutation&&lose)throw Error('ONBOARDING_TRANSPORT_INTERRUPTED');return {...result,...patch};};
 const storage={getItem:()=>stored,setItem:(_,v)=>{stored=v;}},make=()=>createImMaintenanceFlow(request,()=>{},contract,storage,()=>time,allow);let flow=make();
 return {calls,effects,service,request,storage,records,make,get:()=>flow.get(),act:(...a)=>flow.act(...a),select:id=>flow.select(id),gates:()=>imMaintenanceActions(flow.get(),contract,time,allow),cancel:()=>flow.cancel(),reopen:()=>flow=make(),advance:n=>time+=n,lose:v=>lose=v,before:v=>before=v,down:v=>down=v,patch:v=>patch=v,slow:v=>slow=v,unknown:v=>unknown=v,stored:v=>stored=v,state:v=>state=v};
}
async function prepare(f){await f.act('refresh');f.select('isolated-bot');assert(await f.act('disconnect'));}
test('mount/reopen/select/preview do not operate; consent is boolean and not persisted',async()=>{
 const f=fixture();assert.equal(f.calls.length,0);assert(!await f.act('disconnect'));await prepare(f);assert(!await f.act('confirm'));assert(!await f.act('confirm','yes'));assert.deepEqual(f.effects,[]);f.reopen();assert.equal(f.get().plan,null);assert.equal(f.get().selected,'');assert.deepEqual(f.effects,[]);
});
test('disconnect and reconnect each require separate preview and consent; query stores no approval',async()=>{
 const f=fixture();await prepare(f);const id=f.get().plan.id;assert(await f.act('confirm',true));assert.deepEqual(JSON.parse(f.storage.getItem()),{operationId:id});assert(!await f.act('confirm',true));assert(await f.act('reconnect'));assert(await f.act('confirm',true));assert.deepEqual(f.effects,['disconnect','reconnect']);assert(!f.storage.getItem().includes('fingerprint'));
});
test('lost action response resolves on manual query after reopening, never repeated mutation',async()=>{
 const f=fixture();await prepare(f);f.lose(true);assert(!await f.act('confirm',true));assert(f.get().uncertain);f.reopen();f.lose(false);assert(await f.act('refresh'));assert(!f.get().uncertain);assert.equal(f.get().receipt.phase,'acknowledged');assert.deepEqual(f.effects,['disconnect']);
});
test('missing receipt never turns an unknown send into success',async()=>{
 const f=fixture();await prepare(f);f.before(true);await f.act('confirm',true);f.before(false);const p=await f.service.preview({action:'disconnect',botId:'isolated-bot'},{call:async()=>[{botId:'isolated-bot',name:'独立测试机器人',channel:'feishu',configured:true,connected:true,state:'connected',configHash:'a'.repeat(64)}]});assert(p);f.reopen();await f.act('refresh');assert(f.get().uncertain);assert.equal(f.get().receipt,null);assert(!f.gates().disconnect);
});
test('unknown native result needs separately confirmed ledger review; lost review ack uses decision identity',async()=>{
 const f=fixture();await prepare(f);f.unknown(true);assert(await f.act('confirm',true));assert.equal(f.get().receipt.phase,'needs_review');assert(!f.gates().review);await f.act('refresh');assert(f.gates().review);assert(!f.gates().reconnect);assert(await f.act('review'));const decision=f.get().plan.id;f.lose(true);assert(!await f.act('confirm',true));f.reopen();f.lose(false);assert(await f.act('refresh'));assert(!f.get().uncertain);assert.equal(f.get().receipt.review.id,decision);assert.deepEqual(f.effects,['disconnect']);
});
test('uncommitted review decision stays uncertain even if current connection has expected state',async()=>{
 const f=fixture();await prepare(f);f.unknown(true);await f.act('confirm',true);await f.act('refresh');await f.act('review');f.before(true);await f.act('confirm',true);f.before(false);f.reopen();await f.act('refresh');assert(f.get().uncertain);assert.equal(f.get().receipt.phase,'needs_review');assert(!f.gates().review);assert.deepEqual(f.effects,['disconnect']);
});
test('inventory unavailable retains ledger, never inferred empty/idle and never allows changes',async()=>{
 const f=fixture();await prepare(f);await f.act('confirm',true);f.down(true);assert(await f.act('refresh'));assert.equal(f.get().current.inventoryState,'unavailable');assert.equal(f.get().receipt.phase,'acknowledged');assert(!f.gates().reconnect);assert(!await f.act('reconnect'));
});
test('historical disconnect is distinct from latest reconnect and actual connected state',async()=>{
 const f=fixture();await prepare(f);const id=f.get().plan.id;await f.act('confirm',true);await f.act('reconnect');await f.act('confirm',true);f.stored(JSON.stringify({operationId:id}));f.reopen();await f.act('refresh');assert.equal(f.get().receipt.id,id);assert.notEqual(f.get().current.receipt.id,id);assert.equal(f.get().current.bots[0].state,'connected');assert.equal(f.get().receipt.observedState,'disconnected');
});
test('expiry, old query contract and read-only availability gate prevent mutation',async()=>{
 const f=fixture();await prepare(f);f.advance(300001);assert(!await f.act('confirm',true));assert.deepEqual(f.effects,[]);const old=fixture(0);assert(!await old.act('refresh'));assert.equal(old.calls.length,0);const readonly=fixture(1,false);await readonly.act('refresh');readonly.select('isolated-bot');assert(!await readonly.act('disconnect'));
});
test('bad status and expanded or wrong-bot plans fail closed',async()=>{
 for(const patch of [{scope:'whole_host'},{hostStopAuthorized:true},{pluginSwitchAuthorized:true},{queryContract:0},{automaticDisconnect:true},{lossless:true},{receipt:{id:randomUUID()}}]){const f=fixture();f.patch(patch);assert(!await f.act('refresh'));assert(!f.get().fresh);}
 for(const patch of [{scope:'whole_host'},{botId:'wrong-bot'},{configHash:'b'.repeat(64)},{revision:50},{instanceId:randomUUID()},{mayAbortInFlight:false}]){const f=fixture();await f.act('refresh');f.select('isolated-bot');f.patch(patch);assert(!await f.act('disconnect'));assert.equal(f.get().plan,null);assert.deepEqual(f.effects,[]);}
});
test('unknown or mismatched mutation response persists uncertainty for manual query',async()=>{
 const f=fixture();await prepare(f);f.patch({scope:'whole_host'});assert(!await f.act('confirm',true));assert(f.get().uncertain);f.patch({});await f.act('refresh');assert(!f.get().uncertain);assert.deepEqual(f.effects,['disconnect']);
});
test('storage corruption, unavailable or failed persistence never authorize a connection change',async()=>{
 for(const raw of ['bad','{"operationId":"bad"}',JSON.stringify({operationId:randomUUID(),decisionId:12})]){const f=fixture();f.stored(raw);f.reopen();await f.act('refresh');f.select('isolated-bot');assert(f.get().storageError);assert(!await f.act('disconnect'));assert.equal(f.storage.getItem(),raw);}
 const f=fixture();await prepare(f);f.storage.setItem=()=>{throw Error('SECRET');};assert(!await f.act('confirm',true));assert.deepEqual(f.effects,[]);assert.equal(f.get().error,'ONBOARDING_IM_MAINTENANCE_REFERENCE_UNAVAILABLE');
});
test('double click, select and cancel while sending cannot duplicate a change',async()=>{
 const f=fixture();await prepare(f);let done;f.slow(new Promise(r=>done=r));const first=f.act('confirm',true);assert(!await f.act('confirm',true));f.select('another');f.cancel();done();await first;assert.deepEqual(f.effects,['disconnect']);assert.equal(f.get().selected,'isolated-bot');
});
test('UI retains shared visual controls, manual refresh and explicit lossy/current/history boundaries',async()=>{
 const ui=await fs.readFile(new URL('../ui-source/onboarding/im-maintenance.jsx',import.meta.url),'utf8'),client=await fs.readFile(new URL('../ui-source/workbench-client.js',import.meta.url),'utf8'),app=await fs.readFile(new URL('../ui-source/onboarding/app.jsx',import.meta.url),'utf8');
 for(const text of ['setInterval','setTimeout','<button'])assert(!ui.includes(text));for(const text of ['待确认 IM 维护计划','IM 当前连接观察','IM 历史回执','Host 重启可能自动重连','不自动断开','不通过本页远程切换另一端'])assert(ui.includes(text));assert(client.includes('imMaintenanceQueryContract===1'));assert(app.includes('<ImMaintenance request={request}'));assert(app.includes('className="maintenance-panels"'));const help=await fs.readFile(new URL('../ui-source/onboarding/field-help.js',import.meta.url),'utf8');assert(help.includes("'本次维护的机器人':field('conditional'"));assert(app.includes('imMaintenanceContract===1||selfDisableContract===1||selfRemoveContract===1||selfStopContract===1)&&<Button'));
});
