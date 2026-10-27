// Render the real component using a tiny virtual element adapter; this is NOT
// a screenshot, browser session, DSH integration or visual acceptance.
import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import vm from 'node:vm';
function component(){
 const source=readFileSync(new URL('../bundle/workbench-client.js',import.meta.url),'utf8');let exports;
 const replaced=source.replace("return {name:'task-workbench',inject:['connection','slots','layout','uiWorkspace','sessions'],apply};",'return {DeliveryActions};');assert.notEqual(replaced,source);
 const React={createElement:(tag,props,...children)=>typeof tag==='function'?tag({...props,children}):({tag,props,children})};
 vm.runInNewContext(replaced,{window:{__ModuleLoader__:{load:m=>{exports=m.factory(n=>{assert.equal(n,'react');return React;});}}}});
 return exports.DeliveryActions;
}
test('compiled action panel renders unknown ledger and empty ledger differently',()=>{
 const render=component(),a=JSON.stringify(render({fresh:true})),b=JSON.stringify(render({value:{available:true,execution_enabled:false,items:[],total:0},fresh:true}));
 assert(a.includes('不能据此断言没有提交'));assert(b.includes('尚无已登记交付动作'));assert(!a.includes('已记录本地提交'));
});
test('compiled panel shows calculated and observed IDs separately with historical timeline, no action button',()=>{
 const render=component(),value={available:true,execution_enabled:true,total:1,items:[{id:'unit',state:'completed',created:1,computed_commit_oid:'computed-unit',commit_oid:'verified-unit',commit_observed_at:2,revision_matches:false,timeline:[{seq:1,type:'readback_completed',at:2}]}]};
 const result=JSON.stringify(render({value,fresh:false}));
 for(const s of ['computed-unit','verified-unit','历史快照','工作区修订已变化','交付动作时间线','本地提交回读已记录','本动作不证明远端接收或环境采用'])assert(result.includes(s));
 assert(!result.includes('"tag":"button"'));assert(!result.includes('"tag":"a"'));
});
test('uncertain result with only calculated ID never renders a successful commit',()=>{
 const result=JSON.stringify(component()({value:{available:true,total:1,items:[{id:'unit',state:'needs_review',computed_commit_oid:'computed-unit',unclosed_operations:1,timeline:[]}]},fresh:true}));
 assert(result.includes('结果待核对'));assert(result.includes('没有可展示的完整提交回读证据'));assert(!result.includes('已记录本地提交'));
});
test('push history renders its remote ref separately from local commit and never claims adoption',()=>{
 const value={available:true,execution_enabled:true,total:1,items:[{id:'push',kind:'push',state:'completed',created:1,source_commit_oid:'source-oid',repository_url:'https://gitee.com/test-fixture/temporary',expected_remote_oid:null,remote_ref_oid:'remote-oid',remote_observed_at:2,remote_acceptance:'ref_observed',timeline:[{seq:1,type:'readback_completed',at:2}]}]};
 const r=JSON.stringify(component()({value,fresh:true}));
 for(const s of ['远端引用回读已记录','source-oid','remote-oid','分支须不存在','不代表发布或部署','环境采用：未核验'])assert(r.includes(s));
 for(const s of ['已记录本地提交','本地提交回读已记录','"tag":"button"'])assert(!r.includes(s));
});
test('queued push is not described as an enabled commit operation',()=>{
 const value={available:true,execution_enabled:true,total:1,items:[{id:'push',kind:'push',state:'queued',created:1,source_commit_oid:'source-oid',repository_url:'https://gitee.com/test-fixture/temporary',expected_remote_oid:'baseline',timeline:[]}]};
 const r=JSON.stringify(component()({value,fresh:true}));assert(r.includes('等待推送'));assert(r.includes('提交开关不能授权推送'));assert(r.includes('尚无远端引用匹配的完整回读证据'));
});

test('panel displays independent commit and push switches without granting execution',()=>{
 const render=component(),s=JSON.stringify(render({value:{available:true,execution_enabled:false,push_execution_enabled:true,items:[],total:0},fresh:true}));
 assert(s.includes('提交执行开关关闭'));assert(s.includes('推送开关已开启；仍需独立推送批准'));assert(!s.includes('"tag":"button"'));
});
