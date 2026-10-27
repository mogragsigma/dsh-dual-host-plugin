import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';
import {createReclaimFlow,reclaimUiActions} from '../ui-source/onboarding/runtime-reclaim-flow.js';
function fixture(){
 let clock=1000,sequence=0,loss=false,absent=false,hidden=false;const calls=[],record={operationId:'op',supported:true,pending:false,blocked:false,plans:[],requests:[]},uninstall={operationId:'op',pending:false,requests:[{receipt:{state:'committed'}}]},others={operationId:'op',pending:false};
 async function request(method,x){assert.equal(method,'cloud_version');calls.push(x.action);if(x.action==='record'||x.action==='rules_record')return {...others};if(x.action==='uninstall_record')return structuredClone(uninstall);const n=x.action.slice(8);
  if(n==='record')return structuredClone(hidden?{...record,requests:[],pending:false,blocked:false}:record);
  if(n==='preview'||n==='recover_preview'){const p={id:'plan-'+(++sequence),fingerprint:'fp',kind:n==='preview'?'apply':'recover',targetId:x.id??'plan-'+sequence,expiresAt:clock+300000};record.plans.push(p);return {...p,transactionId:p.targetId};}
  if(n==='apply'||n==='recover'){const p=record.plans.find(p=>p.id===x.id);assert(x.confirm);const r={key:n+':'+p.id,action:n,planId:p.id,targetId:p.targetId,state:'observed',receipt:{state:'committed'},observedAbsent:false};record.requests.push(r);record.blocked=true;if(loss){r.state='requested';r.receipt=null;record.pending=true;throw Error('lost');}record.pending=false;return r.receipt;}
  if(n==='status'){const r=record.requests.at(-1);if(absent){r.observedAbsent=true;return {state:'reclamation_outcome_unknown',observedState:'not_requested'};}r.state='observed';r.receipt={state:'deleting',recoveryRequired:true};return r.receipt;}
  throw Error(n);
 }
 let mutations=0;const flow=createReclaimFlow(request,()=>{},{operationId:'op',now:()=>clock,onMutation:()=>mutations++});
 return {flow,record,uninstall,others,calls,request,get mutations(){return mutations;},setClock:n=>clock=n,setLoss:x=>loss=x,setAbsent:x=>absent=x,setHidden:x=>hidden=x,load:()=>flow.act('load'),act:n=>flow.act(n,{stopped:true}),confirm:()=>flow.act('confirm',{stopped:true,confirmed:true})};
}
test('reclamation opening reads only local four ledgers, no target query',async()=>{const f=fixture();await f.load();assert.deepEqual(f.calls,['reclaim_record','uninstall_record','record','rules_record']);assert.equal(f.mutations,0);});
test('completed uninstall and fresh stop observation are both required',async()=>{const f=fixture();await f.load();assert(!await f.flow.act('preview'));f.uninstall.requests=[];await f.load();assert(!await f.act('preview'));assert.equal(f.mutations,0);});
test('pending other maintenance blocks a new reclamation preview',async()=>{const f=fixture();f.others.pending=true;await f.load();assert(!await f.act('preview'));});
test('preview is not consent; cancel and expiry cannot execute',async()=>{const f=fixture();await f.load();await f.act('preview');assert(!await f.act('confirm'));f.flow.cancel();assert(!await f.confirm());await f.act('preview');f.setClock(301001);assert(!await f.confirm());assert.equal(f.mutations,0);});
test('completed reclaim blocks new deletion and keeps manual query available',async()=>{const f=fixture();await f.load();await f.act('preview');assert(await f.confirm());const a=reclaimUiActions(f.flow.snapshot(),{stopped:true},1000);assert(!a.preview&&!a.recover_preview&&a.status);assert.equal(f.mutations,1);});
test('lost reply requires query, then a separate recovery preview and confirmation',async()=>{const f=fixture();await f.load();await f.act('preview');f.setLoss(true);assert(!await f.confirm());assert(!await f.act('recover_preview'));assert(await f.act('status'));assert(await f.act('recover_preview'));assert.equal(f.mutations,1);f.setLoss(false);assert(await f.confirm());assert.equal(f.mutations,2);});
test('no target intent observation remains unknown but enables separately confirmed recovery',async()=>{const f=fixture();await f.load();await f.act('preview');f.setLoss(true);await f.confirm();f.setAbsent(true);await f.act('status');assert.equal(f.flow.snapshot().observation.value.state,'reclamation_outcome_unknown');assert(f.record.pending);assert(await f.act('recover_preview'));assert.equal(f.mutations,1);});
test('lost request cannot be hidden by a subsequently missing local record',async()=>{const f=fixture();await f.load();await f.act('preview');f.setLoss(true);await f.confirm();f.setHidden(true);await f.load();assert(f.flow.snapshot().uncertain);assert(!await f.act('preview'));});
test('closing and reopening never reuses approval or resends a request',async()=>{const f=fixture();await f.load();await f.act('preview');f.flow.dispose();assert(!await f.confirm());const next=createReclaimFlow(f.request,()=>{},{operationId:'op',now:()=>1000});await next.act('load');assert(!next.snapshot().plan);assert(!await next.act('confirm',{stopped:true,confirmed:true}));assert(!f.calls.includes('reclaim_apply'));});
test('loading a foreign operation never enables confirmation',async()=>{const f=fixture();f.uninstall.operationId='other';assert(!await f.load());assert(!await f.act('preview'));});
test('reclamation UI uses scoped shared controls, irreversible consent, and no periodic refresh',async()=>{
 const ui=await fs.readFile(new URL('../ui-source/onboarding/runtime-reclaim.jsx',import.meta.url),'utf8'),cloud=await fs.readFile(new URL('../ui-source/onboarding/cloud-installation.jsx',import.meta.url),'utf8'),built=await fs.readFile(new URL('../bundle/workbench-client.js',import.meta.url),'utf8');
 const decoded=built.replace(/\\u([0-9a-f]{4})/gi,(_,x)=>String.fromCharCode(parseInt(x,16)));
 for(const text of ['确认永久回收运行时','删除不可逆','查询原回收','预览原回收恢复']){assert(ui.includes(text));assert(decoded.includes(text));}
 assert(cloud.includes('<RuntimeReclaim'));assert(!/setInterval|localStorage|sessionStorage/.test(ui));assert(ui.includes('CheckRow')&&ui.includes('version-maintenance-body'));assert(ui.includes('stoppedUntil>Date.now()'));
});

test('failed mutation clears the old preview observation rather than saying nothing was deleted',async()=>{const f=fixture();await f.load();await f.act('preview');assert(f.flow.snapshot().observation);f.setLoss(true);await f.confirm();assert.equal(f.flow.snapshot().observation,null);assert(f.flow.snapshot().uncertain);});

test('no pending request or an execution-before-intent refusal does not offer remote recovery queries',async()=>{const f=fixture();await f.load();await f.act('preview');assert(!reclaimUiActions(f.flow.snapshot(),{stopped:true},1000).status);f.record.requests.push({targetId:f.record.plans[0].id,state:'observed',receipt:{state:'refused'}});await f.load();const a=reclaimUiActions(f.flow.snapshot(),{stopped:true},1000);assert(a.preview&&!a.status&&!a.recover_preview);});

test('active background receipt keeps manual query available but prohibits recovery',async()=>{
 const f=fixture();await f.load();await f.act('preview');f.setLoss(true);await f.confirm();await f.act('status');f.record.requests[0].receipt={state:'deleting',backgroundSupported:true,workerActive:true,executionState:'running',recoveryRequired:false};await f.load();const a=reclaimUiActions(f.flow.snapshot(),{stopped:true},1000);assert(a.status&&!a.preview&&!a.recover_preview&&!a.confirm);
});
