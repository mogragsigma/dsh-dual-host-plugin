import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {makeEnvelope,selectedHumanContext} from '../bundle/task-envelope.js';
for(const phase of ['prepare','enqueue'])test('actual process SIGKILL at '+phase+' restarts one persisted child graph, not duplicate jobs',async t=>{
 const dir=mkdtempSync(tmpdir()+'/trigger-kill-'),now=Date.now(),policy={provider:'fixture-only',model:'not-a-real-model'},agent={id:'s',session:{deriveMessages:()=>[{id:'m',role:'user',source:{kind:'user'},content:[{type:'text',text:'显式只读计划，夹具不调用模型'}]}]}};
 let child;t.after(async()=>{if(child&&!child.killed){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}rmSync(dir,{recursive:true,force:true});});
 const start=async cut=>{child=fork(new URL('./workflow-process-child.mjs',import.meta.url),[dir,String(now),cut],{stdio:['ignore','ignore','ignore','ipc']});assert.equal((await once(child,'message'))[0].ready,true);};
 const send=async body=>{const message=once(child,'message');child.send(body);return (await message)[0];};
 await start(phase);const args={task_id:'t1',revision:1,event_id:'once',goal:makeEnvelope(agent,'cloud',{goal:'fixture',intent:'plan',target:'cloud',model_policy:policy}).goal,policy,source:selectedHumanContext(agent,'cloud'),nodes:[{key:'analysis',title:'分析',instruction:'只读分析',depends_on:[],max_runs:2},{key:'summary',title:'总结',instruction:'汇总前置结果',depends_on:['analysis'],max_runs:2}],end_at:now+86400000,max_total_runs:3};
 assert.equal((await send({op:'create',args})).error,'fixture_cut');const exited=once(child,'exit');child.kill('SIGKILL');await exited;
 await start('none');const restored=await send({op:'tick'});assert.equal(restored.ok,true);assert.equal(restored.workflows[0].nodes.length,2);assert.equal(restored.jobs.length,2);assert.equal(restored.jobs[0].attempts,0);assert.equal(restored.jobs[0].version,'0.17.1');
 const repeated=await send({op:'tick'});assert.equal(repeated.jobs[0].id,restored.jobs[0].id);
});
