import {fixture} from './continuity-fixture.mjs';
import {mkdirSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
export const policy={provider:'fixture',model:'fixture'};
export const targets=[{host:'cloud',alias:'r4-notices',label:'验收通知',botId:'synthetic_bot',targetId:'synthetic_target',expectedFingerprint:'a'.repeat(64),expectedTargetDigest:'b'.repeat(64),conversationId:'synthetic_chat'}];
export function setup(t,options={}){const f=fixture(t,{managedExecution:{enabled:true},observation:{enabled:true,intervalMs:1000,windowMs:2000},notificationTargets:targets,...options});f.g.ctx.llm.resolveCallConfig=async p=>Object.keys(p).length?p:policy;return f;}
export async function contract(f,name,extra={}){
 const id=await f.create(name),cwd=join(f.dir,name);mkdirSync(cwd);
 const proposal=await f.g.call('execution_prepare',{task_id:id,expected_revision:1,role:'cloud',cwd:realpathSync(cwd),scope:'只操作隔离合成数据',model_policy:policy,event_id:'plan-'+id,...extra});
 f.g.continuity.decide('cloud',{request_id:proposal.id,expected_revision:1,proposal_hash:proposal.proposal_hash,expected_decision_id:null,action:'approve',source:f.source('同意','cloud','approve-'+id)});
 await f.g.call('execution_enqueue',{task_id:id,approval_id:proposal.id});return id;
}
export const own=r=>({task_id:r.task_id,claim:r.claim,instance_id:r.instance});
export function start(f){const r=f.g.execution.claim('cloud',{instance_id:'observer-test'}).item;return r?f.g.execution.begin('cloud',own(r)).item:null;}
export function finish(f,r,extra={}){return f.g.execution.finish('cloud',{...own(r),session_id:'managed-'+r.task_id,drained:true,outcome:'ready',summary:'隔离成果；未交付',...extra});}
export function sample(f,r,extra={}){return f.g.execution.validate('cloud',{...own(r),observation:{active:false,tools:0,background:false,activity:0,...extra}});}
export function update(f,id,values){const keys=Object.keys(values);f.g.store.db.prepare(`UPDATE managed_executions SET ${keys.map(k=>k+'=?').join(',')} WHERE task_id=?`).run(...Object.values(values),id);}
export async function bind(f,id){const quote='请把此任务的通知发到验收通知';return f.g.call('notification_bind',{task_id:id,expected_revision:1,expected_binding_revision:f.g.notifications.status(id).binding?.revision??0,action:'set',target_key:'cloud:r4-notices',policy:{events:['result','attention']},authorization_quote:quote,sources:[f.source(quote)],event_id:'bind-'+id+'-'+f.g.now()});}
export const notices=f=>f.g.db.prepare('SELECT * FROM task_notifications').all();
export const observe=f=>f.g.observer.tick();
