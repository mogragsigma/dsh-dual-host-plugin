import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Gateway} from '../bundle/index.js';
test('durable managed identity cannot mount entry tools before its live binding exists',()=>{
 const agent={id:'managed-creating',ctx:{}},normal={id:'ordinary',ctx:{}},child={id:'native-child',ctx:{}};
 const agents=new Map([agent,normal,child].map(a=>[a.id,a]));
 const g={ctx:{agents:{get:id=>agents.get(id)},agentPresets:{composedPreset:()=> 'standard'}},c:{},
  executionEndpoint:{owned:id=>id===agent.id,binding:a=>a===child?{item:{task_id:'t'}}:null}};
 assert.throws(()=>Gateway.prototype.assertNativeAgent.call(g,agent),/UNBOUND_NATIVE_SESSION/);
 assert.throws(()=>Gateway.prototype.assertNativeAgent.call(g,child),/UNBOUND_NATIVE_SESSION/);
 assert.doesNotThrow(()=>Gateway.prototype.assertNativeAgent.call(g,normal));
 g.executionEndpoint=null;assert.doesNotThrow(()=>Gateway.prototype.assertNativeAgent.call(g,normal));
});

test('ready-task changes stay in task followup across new entry sessions; file retrieval remains separate',()=>{
 const rules=fs.readFileSync(new URL('../bundle/native-rules/execution.md',import.meta.url),'utf8');
 const tools=fs.readFileSync(new URL('../bundle/task-continuity-tools.js',import.meta.url),'utf8');
 assert.match(rules,/idle\/ready、换会话或 IM \/new/);assert.match(rules,/入口不得用 edit\/write\/bash 代做任务变更/);
 assert.match(rules,/不改内容、不补检查/);assert.match(rules,/dsh_im_return_file 回当前聊天/);assert.match(rules,/它不是发送给对端 Host/);assert.match(tools,/Ready\/idle work can continue on the same task\/session/);assert.match(tools,/NEVER edit its files/);
});

test('current-IM retrieval does not inherit a historical transfer or require Git/notification registration',()=>{
 const rules=fs.readFileSync(new URL('../bundle/native-rules/execution.md',import.meta.url),'utf8');
 const tools=fs.readFileSync(new URL('../bundle/native-tools.js',import.meta.url),'utf8');
 assert(rules.indexOf('当前聊天取文件')<rules.indexOf('交办仅三通道'));
 assert.match(rules,/不需要 Git 仓库、成果登记或任务通知绑定/);
 assert.match(rules,/历史传输\/通知讨论不改变本轮明确收件人/);
 assert.match(rules,/不为取用先 cp、改名、压缩或创建成果/);
 assert.match(rules,/发生了复制或其他操作必须如实说明/);
 assert.match(tools,/NOT a current-IM-chat attachment tool/);
 assert.match(tools,/NOT for returning an existing file to the current IM chat/);
});
