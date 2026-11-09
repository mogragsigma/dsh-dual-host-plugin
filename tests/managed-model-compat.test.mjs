import test from 'node:test';
import assert from 'node:assert/strict';
import {selectManagedModel} from '../bundle/managed-runtime.js';
const first={provider:'fixture',model:'first',reasoningEffort:'low'};
test('new native selection remains preferred, including resumed agents',async()=>{
 const calls=[],agent={model:{select:p=>calls.push(p)}};
 await selectManagedModel(agent,first,()=>{throw Error('must not load fallback');});
 await selectManagedModel(agent,{provider:'fixture',model:'second'});
 assert.deepEqual(calls,[first,{provider:'fixture',model:'second'}]);
});
test('rc.5 public scoped selection updates route without duplicate listeners',async()=>{
 let ref,cleanup,installed=0,disposed=0;
 const agent={ctx:{effect:fn=>{cleanup=fn();}}};
 const load=async()=>({installModelSelection(ctx,s){assert.equal(ctx,agent.ctx);ref=s;installed++;return()=>disposed++;}});
 await selectManagedModel(agent,first,load);assert.deepEqual(ref.current,first);assert.notEqual(ref.current,first);
 ref.assembled={...first};await selectManagedModel(agent,{provider:'fixture',model:'second'},load);
 assert.deepEqual(ref.current,{provider:'fixture',model:'second'});assert.equal(ref.assembled.model,'first');assert.equal(installed,1);
 cleanup();assert.equal(disposed,1);await selectManagedModel(agent,first,load);assert.equal(installed,2);cleanup();
});
test('missing or incompatible public capability is rejected, never silently skipped',async()=>{
 for(const native of [{},{installModelSelection:()=>()=>{}}])await assert.rejects(selectManagedModel({ctx:{effect(){}}},first,async()=>native),/MODEL_SELECTION_UNAVAILABLE/);
 await assert.rejects(selectManagedModel({ctx:{}},first,async()=>({installModelSelection(a,b){}})),/MODEL_SELECTION_UNAVAILABLE/);
});
test('native selection failures propagate rather than selecting another billing route',async()=>{
 await assert.rejects(selectManagedModel({model:{select(){throw Error('denied');}}},first),/denied/);
 await assert.rejects(selectManagedModel({ctx:{effect(){}}},first,async()=>({installModelSelection(a,b){throw Error('unavailable');}})),/unavailable/);
});
