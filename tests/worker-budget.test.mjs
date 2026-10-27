import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {makeEnvelope} from '../bundle/task-envelope.js';
import {TaskJobs} from '../bundle/task-jobs.js';
import {TaskJobs as OldJobs} from './fixtures/task-jobs-v017.js';
const policy={provider:'chosen-route',model:'chosen-model',reasoningEffort:'low'},caps=new Set(['plan']);
const request=(purpose='worker',extra={})=>({purpose,...policy,reasoningEffort:purpose==='search'?'disabled':'low',maxTokens:2048,...extra});
function fixture(t,old=false){
 const root=mkdtempSync(tmpdir()+'/dsh-model-budget-');let jobs=new (old?OldJobs:TaskJobs)(root);
 const text='搜索 chosen-model 的公开资料，用 chosen-model 搜索，关闭搜索思考，每批最多两次。',agent={id:'entry',session:{deriveMessages:()=>[{id:'m',role:'user',source:{kind:'user'},content:[{type:'text',text}]}]}};
 const goal=old?'read only':makeEnvelope(agent,'cloud',{goal:'只读',target:'cloud',intent:'plan',model_policy:policy,search:{scope:'公开资料',authorization_quote:text,model_policy:{...policy,reasoningEffort:'disabled'},max_requests:2}}).goal;
 jobs.enqueue({task_id:'budget',trigger_id:'only',goal,policy,max_runs:2});const job=jobs.claim(caps,caps);
 t.after(()=>{jobs.close();rmSync(root,{recursive:true,force:true});});
 return {job,get jobs(){return jobs;},reopen(){jobs.close();jobs=new TaskJobs(root);return jobs;}};
}
test('main and auxiliary dispatch reservations share six durable slots, not separate free budgets',t=>{
 const f=fixture(t);for(let i=0;i<6;i++){const r=f.jobs.reserveModelRequest(f.job,request(i>=4?'search':'worker'));assert.equal(r.used,i+1);assert.equal(r.limit,6);assert.equal(r.state,'reserved_not_proof_of_provider_success');}
 assert.throws(()=>f.jobs.reserveModelRequest(f.job,request()),/REQUEST_BUDGET/);
 f.reopen();assert.throws(()=>f.jobs.reserveModelRequest(f.job,request('search')),/REQUEST_BUDGET/);
 assert.equal(f.jobs.db.prepare('SELECT count(*) n FROM worker_model_reservations').get().n,6);
});
test('failed and uncertain dispatch reservations remain consumed after closing the database',t=>{
 const f=fixture(t),first=f.jobs.reserveModelRequest(f.job,request());f.reopen();
 const next=f.jobs.reserveModelRequest(f.job,request('search'));assert.equal(next.used,2);assert.notEqual(next.id,first.id);
 assert.equal(f.jobs.db.prepare('SELECT sum(max_tokens) n FROM worker_model_reservations').get().n,4096);
});
test('no forged run, stale claim, changed task model, credentials or inflated token budget may reserve',t=>{
 const f=fixture(t);
 for(const r of [request('title'),request('worker',{maxTokens:4096}),request('worker',{apiKey:'must-not-be-stored'}),request('worker',{reasoningEffort:{}})])assert.throws(()=>f.jobs.reserveModelRequest(f.job,r),/RESERVATION_INVALID/);
 for(const r of [request('worker',{model:'other'}),request('search',{provider:'other'}),request('worker',{reasoningEffort:'high'}),request('search',{reasoningEffort:'low'})])assert.throws(()=>f.jobs.reserveModelRequest(f.job,r),/ROUTE_MISMATCH/);
 assert.throws(()=>f.jobs.reserveModelRequest({...f.job,run_id:'other'},request()),/RUN_MISMATCH/);
 assert.equal(f.jobs.db.prepare('SELECT count(*) n FROM worker_model_reservations').get().n,0);
 f.jobs.control({id:f.job.id,action:'pause',event_id:'pause',actor:'test'});
 assert.throws(()=>f.jobs.reserveModelRequest(f.job,request()),/STALE_JOB_CLAIM/);
});
test('only an authorized next batch gets its own budget; earlier run and reservations remain auditable',t=>{
 const f=fixture(t);for(let i=0;i<6;i++)f.jobs.reserveModelRequest(f.job,request());f.jobs.finish(f.job,{outcome:'checkpoint',summary:'wait',delay_seconds:1});
 f.jobs.db.prepare('UPDATE jobs SET due=0 WHERE id=?').run(f.job.id);const second=f.jobs.claim(caps,caps);
 assert.equal(second.attempts,2);assert.notEqual(second.run_id,f.job.run_id);assert.throws(()=>f.jobs.reserveModelRequest(f.job,request()),/STALE_JOB_CLAIM/);
 assert.equal(f.jobs.reserveModelRequest(second,request()).used,1);
 f.jobs.finish(second,{outcome:'checkpoint',summary:'no new budget',delay_seconds:1});
 assert.equal(f.jobs.get(second.id).status,'needs_review');assert.equal(f.jobs.db.prepare('SELECT count(*) n FROM worker_model_reservations').get().n,7);
});
test('additive migration preserves old jobs, attempts, checkpoints, runs and task policy without fabricated history',t=>{
 const f=fixture(t,true),before=f.jobs.get(f.job.id),run=f.jobs.db.prepare('SELECT * FROM runs WHERE id=?').get(f.job.run_id);f.reopen();
 assert.deepEqual(f.jobs.get(f.job.id),before);assert.deepEqual(f.jobs.db.prepare('SELECT * FROM runs WHERE id=?').get(f.job.run_id),run);
 assert.equal(f.jobs.db.prepare('SELECT count(*) n FROM worker_model_reservations').get().n,0);
 // A live old worker must be drained before switching. An old run is not retroactively certified.
 f.jobs.recover(caps);assert.throws(()=>f.jobs.reserveModelRequest(f.job,request()),/STALE_JOB_CLAIM/);
});
