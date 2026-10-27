import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {makeEnvelope,selectedHumanContext} from '../bundle/task-envelope.js';
for(const phase of ['prepare','enqueue'])test('actual process SIGKILL at '+phase+' restarts one persisted occurrence, not duplicate jobs',async t=>{
 const dir=mkdtempSync(tmpdir()+'/trigger-kill-'),now=Date.now(),policy={provider:'fixture-only',model:'not-a-real-model'},agent={id:'s',session:{deriveMessages:()=>[{id:'m',role:'user',source:{kind:'user'},content:[{type:'text',text:'显式只读计划，夹具不调用模型'}]}]}};
 let child;t.after(async()=>{if(child&&!child.killed){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}rmSync(dir,{recursive:true,force:true});});
 const start=async cut=>{child=fork(new URL('./trigger-process-child.mjs',import.meta.url),[dir,String(now),cut],{stdio:['ignore','ignore','ignore','ipc']});assert.equal((await once(child,'message'))[0].ready,true);};
 const send=async body=>{const message=once(child,'message');child.send(body);return (await message)[0];};
 await start(phase);const args={task_id:'t1',revision:1,event_id:'once',goal:makeEnvelope(agent,'cloud',{goal:'fixture',intent:'plan',target:'cloud',model_policy:policy}).goal,policy,source:selectedHumanContext(agent,'cloud'),timing:{rule:{kind:'once',at:now},end_at:now+86400000,max_occurrences:1,max_runs:2}};
 assert.equal((await send({op:'create',args})).error,'fixture_cut');const exited=once(child,'exit');child.kill('SIGKILL');await exited;
 await start('none');const restored=await send({op:'tick'});assert.equal(restored.ok,true);assert.equal(restored.schedules[0].emitted,1);assert.equal(restored.jobs.length,1);assert.equal(restored.jobs[0].attempts,0);assert.equal(restored.jobs[0].version,'0.17.0');
 const repeated=await send({op:'tick'});assert.equal(repeated.jobs[0].id,restored.jobs[0].id);
});
