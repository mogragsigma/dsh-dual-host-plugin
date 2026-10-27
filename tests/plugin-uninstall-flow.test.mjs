import test from 'node:test';import assert from 'node:assert/strict';
import {createUninstallFlow,uninstallUiActions} from '../ui-source/onboarding/plugin-uninstall-flow.js';
function fixture(){
 let clock=1000,seq=0,loss=false,hidden=false,badLoad=false,mutations=0;const calls=[],u={operationId:'op',supported:true,pending:false,blocked:false,plans:[],requests:[]};
 const others={operationId:'op',pending:false};
 async function request(method,x){assert.equal(method,'cloud_version');calls.push(x.action);if(x.action==='record'||x.action==='rules_record')return {...others};const n=x.action.slice(10);
  if(n==='record'){if(badLoad)throw Error('failed');return structuredClone(hidden?{...u,requests:[],pending:false,blocked:false}:u);}
  if(n==='preview'||n==='recover_preview'){const p={id:'plan-'+(++seq),fingerprint:'fp-'+seq,expiresAt:clock+300000,version:'1.0.1',kind:n==='preview'?'apply':'recover',targetId:x.id??'plan-'+seq};u.plans.push(p);return {...p};}
  if(n==='apply'||n==='recover'){const p=u.plans.find(p=>p.id===x.id);assert(p&&x.confirm);const receipt={state:n==='apply'?'committed':'rolled_back',recoveryRequired:false},r={key:n+':'+p.id,action:n,planId:p.id,targetId:p.targetId,state:'observed',receipt};u.requests.push(r);u.blocked=n==='apply';if(loss){r.state='requested';r.receipt=null;u.pending=true;u.blocked=true;throw Error('lost');}return receipt;}
  if(n==='status'){const r=u.requests.find(r=>r.targetId===x.id);if(!r)throw Error('ONBOARDING_CLOUD_UNINSTALL_NOT_FOUND');r.state='observed';r.receipt={state:'committed',recoveryRequired:false};u.pending=false;u.blocked=true;return r.receipt;}
  throw Error(n);
 }
 const flow=createUninstallFlow(request,()=>{},{operationId:'op',now:()=>clock,onMutation:()=>mutations++});
 return {flow,u,others,calls,get mutations(){return mutations;},setClock:x=>clock=x,setLoss:x=>loss=x,setHidden:x=>hidden=x,setBadLoad:x=>badLoad=x,load:()=>flow.act('load'),act:n=>flow.act(n,{stopped:true}),confirm:()=>flow.act('confirm',{stopped:true,confirmed:true})};
}
test('opening uninstall reads local histories only',async()=>{const f=fixture();await f.load();assert.deepEqual(f.calls,['uninstall_record','record','rules_record']);assert.equal(f.mutations,0);});
test('uninstall requires fresh stop and explicit confirmation; cancel grants nothing',async()=>{const f=fixture();await f.load();assert(!await f.flow.act('preview'));await f.act('preview');assert(!await f.act('confirm'));f.flow.cancel();assert(!await f.confirm());assert.equal(f.mutations,0);});
test('uninstall plan expiry does not renew approval',async()=>{const f=fixture();await f.load();await f.act('preview');f.setClock(301001);assert(!await f.confirm());assert.equal(f.mutations,0);});
test('uninstall completion disables new preview and keeps receipt query enabled',async()=>{const f=fixture();await f.load();await f.act('preview');assert(await f.confirm());const a=uninstallUiActions(f.flow.snapshot(),{stopped:true},1000);assert(!a.preview&&a.status&&!a.recover_preview);assert.equal(f.mutations,1);});
test('lost uninstall cannot be resubmitted after local reload; original query settles it',async()=>{const f=fixture();await f.load();await f.act('preview');f.setLoss(true);assert(!await f.confirm());await f.load();assert(!await f.act('preview'));assert(!await f.confirm());f.setLoss(false);await f.act('status');assert(!f.flow.snapshot().uncertain);assert.equal(f.mutations,1);});
test('missing local request on re-read does not clear browser uncertainty',async()=>{const f=fixture();await f.load();await f.act('preview');f.setLoss(true);await f.confirm();f.setHidden(true);await f.load();assert(f.flow.snapshot().uncertain);assert(!await f.act('preview'));});
test('failed reload after mutation remains uncertain until durable record is observed',async()=>{const f=fixture();await f.load();await f.act('preview');f.setBadLoad(true);assert(!await f.confirm());assert(f.flow.snapshot().uncertain);f.setBadLoad(false);await f.load();assert(!f.flow.snapshot().uncertain);});
test('failed record read and other maintenance block new uninstall plans',async()=>{const f=fixture();await f.load();f.others.pending=true;await f.load();assert(!await f.act('preview'));f.setBadLoad(true);await f.load();assert(!f.flow.snapshot().loaded);});
test('known intermediate state allows recovery only after fresh stop; unknown recovery does not',()=>{
 const s={loaded:true,id:'x',record:{supported:true,blocked:true,pending:true,requests:[{targetId:'x',state:'observed',receipt:{state:'capturing',recoveryRequired:true}}]}};
 assert(uninstallUiActions(s,{stopped:true},1000).recover_preview);assert(!uninstallUiActions(s,{stopped:false},1000).recover_preview);s.record.requests.push({targetId:'x',state:'requested',receipt:null});assert(!uninstallUiActions(s,{stopped:true},1000).recover_preview);
});
test('uninstall reopen never reuses an in-memory confirmation or triggers effects',async()=>{const f=fixture();await f.load();await f.act('preview');f.flow.dispose();const n=f.calls.length;assert(!await f.confirm());f.flow.resume();assert.equal(f.calls.length,n);await f.load();assert.equal(f.flow.snapshot().plan,null);});
test('uninstall refuses mismatched operation history',async()=>{const f=fixture();f.others.operationId='different';assert(!await f.load());assert.equal(f.flow.snapshot().error,'ONBOARDING_CLOUD_HANDOFF_TARGET_CHANGED');});
test('version and uninstall sibling panels have distinct stable React keys',async()=>{
 const fs=await import('node:fs/promises'),s=await fs.readFile(new URL('../ui-source/onboarding/cloud-installation.jsx',import.meta.url),'utf8');
 assert(s.includes("<PluginVersionMaintenance key={'version:'+s.source.operationId}"));assert(s.includes("<PluginUninstall key={'uninstall:'+s.source.operationId}"));
});
