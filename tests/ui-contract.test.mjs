import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {workbenchAppearance,workbenchSnapshot,installWorkbench} from '../bundle/workbench-host.js';
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
test('fixed appearance asset matches accepted reference; caller cannot choose file or remote URL',async()=>{
 const a=await workbenchAppearance(),b=await workbenchAppearance();assert.equal(a,b);
 const png=readFileSync(new URL('../bundle/workbench-assets/whale-ui-states.png',import.meta.url));
 assert.equal(a.mascot,'data:image/png;base64,'+png.toString('base64'));
 // The committed source-export baseline removed only provenance metadata.
 // Keep the historical reference unchanged; validate the exact current export bytes.
 const baseline=JSON.parse(read('../docs/source-bundle-alpha32-11.json'));
 assert.equal(createHash('sha256').update(png).digest('hex'),baseline.manifest['workbench-assets/whale-ui-states.png']);
 for(const args of [{path:'/etc/passwd'},{url:'https://example.invalid/image'},{token:'x'},[],null])assert.throws(()=>workbenchAppearance(args),/INVALID_WORKBENCH_APPEARANCE/);
});
test('appearance is a native authenticated RPC branch, not a peer/model tool or file server',async()=>{
 let route;const g={c:{role:'local'}},sub={connection:{fetch:{register:r=>{route=r;}}},effect(){}};
 installWorkbench({inject:(_n,f)=>f(sub)},g,{enabled:true});
 const invoke=payload=>route.fetch(new Request('http://127.0.0.1/api/task-workbench/control',{method:'POST',body:JSON.stringify({type:'client-request',rpcId:'test',method:'task-workbench/control',payload})}));
 const r=await invoke({method:'appearance',args:{}});assert.equal(r.headers.get('Cache-Control'),'no-store');assert((await r.json()).result.ok);
 const e=await invoke({method:'appearance',args:{path:'x'}});assert.equal((await e.json()).result.error.code,'INVALID_WORKBENCH_APPEARANCE');
 assert(!read('../bundle/link-contract.js').includes('appearance'));assert(!read('../bundle/native-tools.js').includes('appearance'));
});
test('workbench status is read-only even when a legacy row has no catalog migration',()=>{
 let migrations=0;
 const g={c:{role:'cloud'},hello:()=>({plugin_version:'test'}),now:()=>1,instanceId:'i',catalog:{head:()=>{migrations++;throw Error('must not migrate');}},board:{head:()=>({title:'历史任务名称'})},scheduler:{jobs:{db:{prepare:()=>({all:()=>[{id:'run',policy:'{}',checkpoint:'{}'}]})}}}};
 assert.equal(workbenchSnapshot(g).runs[0].title,'历史任务名称');assert.equal(migrations,0);
});
test('UI has no interval polling, unscoped body mutation, worker controls, or mock task imports',()=>{
 const s=read('../ui-source/workbench-client.js');assert(!s.includes('setInterval'));assert(!s.includes('document.body'));assert(!s.includes('tasks=['));
 assert(!s.includes("call('approve'"));assert(!s.includes("call('job_control'"));assert(s.includes('暂无已登记成果'));assert(s.includes('URL.revokeObjectURL'));
 assert.equal((s.match(/name:'sidebar.panellist',id:/g)??[]).length,1);
});
test('package includes self-owned assets and uses the same client on both Hosts',()=>{
 const p=JSON.parse(read('../bundle/package.json'));assert(p.files.includes('workbench-assets'));assert.equal(p.exports['./client'],'./workbench-client.js');
 const rules=read('../bundle/global-rules/AGENTS.md');assert(rules.includes('大肥鱼bot'));assert(rules.includes('手动刷新'));
 for(const n of ['task-sidebar','task-workbench'])assert(read('../bundle/skills/'+n+'/SKILL.md').includes('双端工作台'));
});

test('planning UI is read-only, labels budget as consumption and distinguishes unavailable/history from empty',()=>{
 const s=read('../ui-source/workbench-client.js'),css=read('../ui-source/overrides.css');
 for(const text of ['计划与子任务','不是完成百分比','没有持久计划或子任务图','子任务依赖列表'])assert(s.includes(text));
 assert(s.includes('p.available'));assert(s.includes('spec_revision'));assert(!s.includes("call('workflow_control'"));assert(!s.includes("call('trigger_control'"));
 assert(css.includes('meter::-webkit-meter-optimum-value'));assert(css.includes('meter::-moz-meter-bar'));
 assert(read('../bundle/skills/task-sidebar/SKILL.md').includes('共享批次已用不是完成百分比'));
});

test('notification UI distinguishes queue, uncertain delivery and weak acceptance; discovery is manual read-only',()=>{
 const s=read('../ui-source/workbench-client.js'),css=read('../ui-source/overrides.css');
 for(const label of ['任务通知与回执','通知投递时间线','接口接受不代表已读','没有平台消息号','发现可用通知目标','当前不能添加为受检通知目标'])assert(s.includes(label));
 assert(s.includes("request('notification-discover',args)"));assert(!s.includes("request('notification_target_add'"));assert(!s.includes("call('notification_bind'"));assert(!s.includes('setInterval'));assert(css.includes('.dtu .notification-card'));
});

test('A2A surfaces preserve manual read-only controls, source ownership and budget semantics',()=>{
 const s=read('../ui-source/workbench-client.js');for(const label of ['双端协作','双端关联答复时间线','模型派发预留','流结束也不代表任务或工具成功','本地执行会话请在本地工作台查看','迟到答复'])assert(s.includes(label));
 assert(!s.includes('setInterval'));for(const method of ['a2a_start','a2a_control','a2a_authorize'])assert(!s.includes(`call('${method}'`));assert(s.includes('busy||!fresh'));assert(s.includes('!workspaceFresh'));assert(s.includes('spec_revision!==item.spec_revision'));
});

test('development UI separates local receipts, cloud authority and handoff without mutation controls or fake disabled copy',()=>{
 const s=read('../ui-source/workbench-client.js');for(const label of ['受管写入与交接','受管写入事件时间线','本端回执 · 不替代云端账本','持权不表示模型正在执行','同一审批累计记录','执行能力待核验','查看关联任务'])assert(s.includes(label));
 for(const method of ['development_bridge_review','development_bridge_write','development_bridge_acquire'])assert(!s.includes(`call('${method}'`));
 assert(!s.includes('setInterval'));assert(!s.includes('手动刷新 · 开发写入关闭'));assert(!s.includes('未检出／未开放写入'));assert(s.includes('data?.development'));assert(s.includes('!fresh'));assert(read('../ui-source/overrides.css').includes('.dtu .development-facts'));
});

test('failure attention is read-only historical evidence, not an approval or a success result',()=>{
 const s=read('../ui-source/workbench-client.js');for(const text of ['需要你处理','停止时账本','历史停止记录 · 不代表当前状态','批准验收命令'])assert(s.includes(text));
 assert(!s.includes("call('development_resume'"));assert(!s.includes('setInterval'));assert(s.includes('r.attention.historical'));assert(s.includes('r.test.matches_file'));
});

test('delivery actions keep a manual historical timeline and never substitute computed OID for readback',()=>{
 const s=read('../ui-source/workbench-client.js');
 for(const text of ['交付动作与回读','交付动作时间线','计算提交号不是已创建提交','没有可展示的完整提交回读证据','精确提交授权方案（批准不代表已执行）'])assert(s.includes(text));
 assert(!s.includes("request('delivery_schedule'"));assert(!s.includes("call('delivery_schedule'"));assert(!s.includes('setInterval'));
 assert(s.includes('a.commit_oid?'));assert(s.includes('value?.available'));assert(s.includes('a.revision_matches===false'));
});

test('delivery summary uses visible warning labels and the unmounted native browser offers an actionable existing-session route',()=>{
 const s=readFileSync(new URL('../bundle/workbench-client.js',import.meta.url),'utf8');
 for(const label of ['交付结果待核对','交付操作待排空','交付已持权 · 不证明完成','交付等待领取／资源','交付账本暂不可读','请先从左侧打开一个已有会话'])assert(s.includes(label));
 assert(s.includes("'delivery_review','delivery_draining','delivery_state_unavailable'].includes(state)"));assert(!s.includes('setInterval'));
});
