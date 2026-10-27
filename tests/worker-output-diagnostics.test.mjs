import test from 'node:test';
import assert from 'node:assert/strict';
import {errorInfo} from '../bundle/link-contract.js';
import {TaskBoard} from '../bundle/task-board.js';
import {TaskNotifications} from '../bundle/task-notifications.js';

const code='WORKER_MODEL_OUTPUT_LIMIT';
test('known output exhaustion is an operator-review diagnostic, never a retry hint',()=>{
 assert.deepEqual(errorInfo(Error(code)),{code,category:'validation_or_review',retry:'operator_review',does_not_grant_authority:true});
 assert.equal(errorInfo(code+' private provider body').code,'TRANSIENT_FAILURE');
});
test('task board retains the precise stored output-limit failure without mutating the job',()=>{
 const row={id:'job',task_id:'task',status:'needs_review',kind:'plan',goal:'plain fixture',policy:'{}',checkpoint:'{}',error:code,attempts:1,max_runs:1};
 const before=JSON.stringify(row),g={store:{task:()=>({})},scheduler:{active:new Map(),jobs:{db:{prepare:()=>({all:()=>[row],get:()=>undefined})}}}};
 const [view]=TaskBoard.prototype.jobs.call({g},'task');
 assert.equal(view.error,code);assert.equal(view.status,'needs_review');assert.equal(view.attempts,1);assert.equal(view.max_runs,1);assert.equal(JSON.stringify(row),before);
});
test('failure notification explains output exhaustion without promising completion or a retry',()=>{
 const job={task_id:'fixture',policy:JSON.stringify({provider:'chosen',model:'chosen',reasoningEffort:'high'})};
 const g={catalog:{head:()=>({title:'零模型错误说明夹具'})}};
 const text=TaskNotifications.prototype.render.call({g},job,{type:'failed',at:1000,data:JSON.stringify({code})},'本批次失败／待核对');
 assert.match(text,/错误：WORKER_MODEL_OUTPUT_LIMIT/);assert.match(text,/含思考/);assert.match(text,/未自动重试、增加预算或更换模型/);assert.doesNotMatch(text,/成果介绍：|本批次完成/);
});
