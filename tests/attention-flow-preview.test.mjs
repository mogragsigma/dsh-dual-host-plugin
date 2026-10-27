import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {createFlow,advanceFlow,flowView,flowKinds,flowCue} from '../ui-source/preview/attention-flow.mjs';
const next=(f,action,text='')=>advanceFlow(f,{action,text,expectedVersion:f.version});
test('recovery goes through check, suggestion, opinion, separate confirmation and result',()=>{
 let f=createFlow('recovery');assert.equal(flowView(f).owner,'系统处理');assert(!flowView(f).actions.some(a=>a.id==='continue'));
 f=next(f,'inspect');assert.equal(f.phase,'recommendation');assert(flowView(f).facts.some(s=>s.includes('1/1')));
 f=next(f,'revise','只用已有资料，报告分成两段');assert.equal(f.phase,'recommendation');assert.equal(f.planVersion,2);
 f=next(f,'continue');assert.equal(f.phase,'queued');assert.equal(flowCue(f),'系统处理');
 f=next(f,'progress');assert.equal(f.phase,'running');f=next(f,'finish');assert.equal(f.phase,'completed');
 assert.equal(f.opinion,'只用已有资料，报告分成两段');assert.equal(flowView(f).actions.length,0);assert.equal(f.history.length,5);
});
test('typed conditions are not dropped by the continue button',()=>{
 let f=next(createFlow('recovery'),'inspect');f=next(f,'continue','可以，但不要重新检索');assert.equal(f.phase,'recommendation');assert.equal(f.opinion,'可以，但不要重新检索');assert.equal(f.planVersion,2);
});
test('cancel is confirm, in-flight check, then ended: never an instant false success',()=>{
 let f=createFlow('recovery');f=next(f,'end');assert.equal(f.phase,'ending');f=next(f,'back');assert.equal(f.phase,'checking');
 f=next(f,'end');f=next(f,'confirm_end');assert.equal(f.phase,'ending_check');assert(!flowView(f).terminal);f=next(f,'end_result');assert.equal(f.phase,'ended');assert.match(flowView(f).description,/未把失败改成成功/);
});
test('running flow also checks termination instead of claiming immediate stop',()=>{
 let f=next(next(next(createFlow('recovery'),'inspect'),'continue'),'progress');f=next(f,'end');f=next(f,'confirm_end');assert.equal(f.phase,'ending_check');
});
test('defer preserves suggestion and can resume deciding or end',()=>{
 let f=next(createFlow('recovery'),'inspect');f=next(f,'revise','仅生成摘要');f=next(f,'hold');assert.equal(f.phase,'held');assert.equal(f.opinion,'仅生成摘要');f=next(f,'reopen');assert.equal(f.phase,'recommendation');
});
for(const kind of ['input','amendment'])test(kind+' requires content and a separately accepted current suggestion',()=>{
 let f=createFlow(kind,'已有意见');assert.throws(()=>next(f,'revise'),/PREVIEW_TEXT/);f=next(f,'revise','仅分析国内产品');assert.equal(f.phase,'recommendation');f=next(f,'continue');assert.equal(f.phase,'queued');
});
test('configuration is maintenance, not repeated approval',()=>{
 let f=createFlow('capability');assert(!flowView(f).actions.some(a=>a.id==='continue'));f=next(f,'requirements');f=next(f,'maintain','帮我核对配置');assert.equal(f.phase,'maintenance_pending');assert.equal(flowCue(f),'等待维护端处理');f=next(f,'maintenance_result');f=next(f,'new_plan');assert.equal(f.phase,'recommendation');
});
test('missing evidence never creates a retry button before maintenance',()=>{
 let f=createFlow('unknown');f=next(f,'inspect');assert.equal(f.phase,'maintenance');assert(!flowView(f).actions.some(a=>a.id==='continue'));f=next(f,'maintain');f=next(f,'maintenance_result');assert.equal(f.phase,'maintenance_done');
});
test('notification seen is a human statement, not a delivery resend',()=>{
 const f=next(createFlow('notification'),'seen');assert.equal(f.phase,'resolved');assert.match(flowView(f).description,/没有再次发送/);
});
test('notification not seen leads to maintenance, not a retry or task cancellation',()=>{
 let f=next(createFlow('notification'),'unseen');assert.equal(f.phase,'maintenance');f=next(f,'maintain');f=next(f,'maintenance_result');assert.equal(f.phase,'resolved');assert.match(flowView(f).facts[0],/不取消任务/);
});
test('ending notification follow-up never claims the task is stopped',()=>{
 let f=next(createFlow('notification'),'end');assert.match(flowView(f).title,/通知/);f=next(f,'confirm_end');f=next(f,'end_result');assert.match(flowView(f).description,/任务、成果和原投递记录保持不变/);
});
test('stale version, invalid action and oversized opinion fail without mutation',()=>{
 const f=createFlow('recovery'),old=JSON.stringify(f);assert.throws(()=>advanceFlow(f,{action:'inspect',expectedVersion:0}),/PREVIEW_CHANGED/);assert.throws(()=>next(f,'continue'),/PREVIEW_ACTION/);assert.throws(()=>next(f,'end','x'.repeat(2001)),/PREVIEW_TEXT/);assert.equal(JSON.stringify(f),old);
});
test('every reachable nonterminal preview state has a finite route to an explicit terminal result',()=>{
 for(const kind of flowKinds){
  const seen=new Map(),edges=new Map(),todo=[createFlow(kind)];
  while(todo.length){const f=todo.shift();if(seen.has(f.phase))continue;seen.set(f.phase,f);const v=flowView(f);assert(v.title&&v.description&&v.owner,kind+':'+f.phase);assert(v.terminal||v.actions.length>0,kind+':'+f.phase);
   const out=[];for(const a of v.actions){const n=next(f,a.id,a.requiresText?'补充要求':'');out.push(n.phase);if(!seen.has(n.phase))todo.push(n);}edges.set(f.phase,out);
  }
  for(const phase of seen.keys()){const visited=new Set(),q=[phase];let exits=false;while(q.length){const p=q.shift();if(visited.has(p))continue;visited.add(p);if(flowView(seen.get(p)).terminal){exits=true;break;}q.push(...edges.get(p));}assert(exits,kind+':'+phase+' has no exit');}
 }
});
test('preview engine has no runtime, storage, network, timer or model call dependency',()=>{
 const s=readFileSync(new URL('../ui-source/preview/attention-flow.mjs',import.meta.url),'utf8');assert(!/import |fetch\(|setInterval|setTimeout|localStorage|sessionStorage|process\.|require\(/.test(s));
 const main=readFileSync(new URL('../ui-source/workbench-client.js',import.meta.url),'utf8');assert(!main.includes('attention-flow.mjs'));assert(!main.includes('InterventionPanel'));assert(main.includes('attentionPreview?.render?.'));assert(!main.includes('attentionPreview:'));assert(!main.includes('setInterval'));
 const build=readFileSync(new URL('../scripts/build-task-focus-preview.mjs',import.meta.url),'utf8');assert(build.includes('href="./app.css"'));
});

test('history keeps the suggestion version that was actually shown',()=>{
 let f=next(createFlow('recovery'),'inspect');f=next(f,'revise','改为摘要');assert.equal(f.history[0].result,'处理建议 · 第 1 版');assert.equal(f.history[1].result,'处理建议 · 第 2 版');
});
