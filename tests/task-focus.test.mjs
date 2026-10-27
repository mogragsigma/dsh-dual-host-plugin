import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';
import {taskAttention,decisionSelection} from '../ui-source/task-focus.mjs';
const now=Date.now(),pending={id:'a',spec_revision:2,state:'pending',expires:now+86400000,summary:'当前方案'};
const item=extra=>({task_id:'task',spec_revision:2,display_state:'registered',approvals:[],jobs:[],...extra});
test('only a current unexpired proposal becomes actionable, never old or expired history',()=>{
 const i=item({approvals:[pending,{...pending,id:'old',spec_revision:1},{...pending,id:'exp',expires:now},{...pending,id:'superseded',state:'superseded'},{...pending,id:'revoked',state:'revoked'}]});
 assert.deepEqual(taskAttention(i,now).map(x=>x.id),['a']);assert.equal(taskAttention(i,now)[0].action,'decision');
});
test('summary list uses its single approval without needing full detail',()=>{
 const i=item({approval:pending});delete i.approvals;assert.equal(taskAttention(i,now)[0].kind,'approval');
});
for(const state of ['pending','held','clarification_required'])test('current '+state+' proposal remains identifiable',()=>{assert.equal(taskAttention(item({approvals:[{...pending,state}]}),now)[0].action,'decision');});
for(const state of ['changes_requested','confirmation_review'])test(state+' cannot render an approve shortcut',()=>{assert.notEqual(taskAttention(item({approvals:[{...pending,state}]}),now)[0].action,'decision');});
test('failed output is review, not approval, and historical failure remains distinguishable',()=>{
 const entries=taskAttention(item({jobs:[{id:'j',spec_revision:2,status:'needs_review',error:'WORKER_REPORT_REQUIRED'},{id:'old-j',spec_revision:1,status:'interrupted'}]}),now);
 assert.equal(entries[0].kind,'review');assert.match(entries[0].description,/不是待审批/);assert.equal(entries[1].historical,true);
});
test('normal waiting time and queue do not become human approval',()=>{
 for(const state of ['scheduled_time','worker_busy','waiting_dependency','same_task_busy','completed','cancelled','paused'])assert.deepEqual(taskAttention(item({display_state:state,jobs:[{id:'j',status:'queued',reason:state,spec_revision:2}]}),now),[]);
});
test('waiting input uses actual question, not a scheme approval',()=>{const a=taskAttention(item({jobs:[{id:'j',status:'waiting_input',spec_revision:2,input_question:'比较哪些产品？'}]}),now)[0];assert.equal(a.action,'answer');assert.equal(a.description,'比较哪些产品？');});
test('closed notification review is not reopened by projection',()=>{
 const deliveries=[{id:'open',state:'needs_review'},{id:'closed',state:'needs_review',review:{state:'closed'}}];assert.deepEqual(taskAttention(item({notifications:{deliveries}}),now).map(x=>x.id),['open']);
});
test('unknown delivery evidence is review, not an empty success',()=>{const a=taskAttention(item({display_state:'delivery_state_unavailable'}),now)[0];assert.equal(a.kind,'review');assert.equal(a.action,'inspect');});
test('projection is pure and accepts no write/delegation callback',()=>{const i=item({approvals:[pending]});const saved=JSON.stringify(i);taskAttention(i,now);assert.equal(JSON.stringify(i),saved);});
test('approve shortcut retains all entered conditions for the server',()=>{
 const i=item({approvals:[pending]}),a=taskAttention(i,now)[0],s=decisionSelection(i,a,'同意，但报告改成两段','approve',now);
 assert.equal(s.text,'同意，但报告改成两段');assert.equal(s.shortcut,'approve');assert.equal(s.expected_revision,2);assert.equal(s.request_id,'a');
});
test('no blank or oversized free-form decision and no stale scheme selection',()=>{
 const i=item({approvals:[pending]}),a=taskAttention(i,now)[0];assert.throws(()=>decisionSelection(i,a,'',null,now),/TEXT_REQUIRED/);assert.throws(()=>decisionSelection(i,a,'a'.repeat(2001),null,now),/TEXT_REQUIRED/);assert.throws(()=>decisionSelection({...i,spec_revision:3},a,'同意',null,now),/SNAPSHOT_CHANGED/);assert.throws(()=>decisionSelection(i,a,'同意',null,pending.expires),/SNAPSHOT_CHANGED/);
});
function driver(){
 const state=[],refs=[],deps=[];let cursor=0,effects=[],exports;
 const React={createElement:(tag,props,...children)=>({tag,props:props??{},children}),useId:()=>`field-${cursor++}`,useRef(v){const i=cursor++;return refs[i]??=( {current:v});},useState(v){const i=cursor++;if(!(i in state))state[i]=v;return [state[i],n=>state[i]=typeof n==='function'?n(state[i]):n];},useEffect(fn,d){const i=cursor++;if(!deps[i]||d.some((x,j)=>x!==deps[i][j])){deps[i]=d;effects.push(fn);}}};
 const code=readFileSync(new URL('../bundle/workbench-client.js',import.meta.url),'utf8').replace("return {name:'task-workbench',inject:['connection','slots','layout','uiWorkspace','sessions'],apply};",'return {TaskDecisionBox};');
 vm.runInNewContext(code,{window:{__ModuleLoader__:{load:m=>exports=m.factory(()=>React)}}});
 const render=props=>{cursor=0;let r=exports.TaskDecisionBox(props);if(effects.length){effects.splice(0).forEach(f=>f());cursor=0;r=exports.TaskDecisionBox(props);}return r;};
 const nodes=t=>typeof t==='object'&&t?[t,...t.children.flat(Infinity).flatMap(nodes)]:[];
 const text=t=>typeof t==='string'?t:t?.children?.flat(Infinity).map(text).join('')??'';
 return {render,nodes,text,find:(t,label)=>nodes(t).find(x=>x.tag==='button'&&text(x)===label)};
}
const props=()=>{const i=item({approvals:[pending]});return {item:i,entry:taskAttention(i,now)[0],fresh:true};};
test('live UI with no trusted adapter never enables a decision button',()=>{
 const d=driver(),tree=d.render(props());assert(d.nodes(tree).filter(n=>n.tag==='button').every(n=>n.props.disabled));assert(d.text(tree).includes('审批接线尚未启用'));
});
test('stale snapshot disables submission while preserving the text draft',()=>{
 const d=driver(),p={...props(),adapter:async()=>({recorded:true,state:'approved'})};let t=d.render(p);d.nodes(t).find(n=>n.tag==='textarea').props.onChange({target:{value:'先等等'}});t=d.render({...p,fresh:false});assert.equal(d.nodes(t).find(n=>n.tag==='textarea').props.value,'先等等');assert(d.nodes(t).filter(n=>n.tag==='button').every(n=>n.props.disabled));
});
test('double gesture submits once, conditions are not discarded, recorded result shown separately from execution',async()=>{
 let done,calls=[];const adapter=a=>{calls.push(a);return new Promise(r=>done=r);};adapter.preview=true;const d=driver(),p={...props(),adapter};let t=d.render(p);d.nodes(t).find(n=>n.tag==='textarea').props.onChange({target:{value:'同意，但修改报告'}});t=d.render(p);const click=d.find(t,'同意原方案').props.onClick,first=click();await click();assert.equal(calls.length,1);assert.equal(calls[0].text,'同意，但修改报告');done({recorded:true,state:'changes_requested',message:'旧方案不执行'});await first;t=d.render(p);assert(d.text(t).includes('模拟结果 · 需修改后重新送审'));assert.equal(d.nodes(t).find(n=>n.tag==='textarea').props.value,'');
});
test('late response from a changed task version cannot become the visible result',async()=>{
 let done;const d=driver(),p={...props(),adapter:()=>new Promise(r=>done=r)};const first=d.find(d.render(p),'同意原方案').props.onClick();d.render({...p,item:{...p.item,spec_revision:3}});done({recorded:true,state:'approved'});await first;assert(!d.text(d.render({...p,item:{...p.item,spec_revision:3}})).includes('批准已记账'));
});
test('uncertain failure keeps draft and never triggers an automatic retry',async()=>{
 let calls=0;const d=driver(),p={...props(),adapter:async()=>{calls++;throw Error('offline');}};let t=d.render(p);d.nodes(t).find(n=>n.tag==='textarea').props.onChange({target:{value:'暂缓'}});t=d.render(p);await d.find(t,'提交意见').props.onClick();t=d.render(p);assert.equal(calls,1);assert.equal(d.nodes(t).find(n=>n.tag==='textarea').props.value,'暂缓');assert(d.text(t).includes('不要重复批准'));
});
test('diagnostic content is lazy and production mounting supplies no mock adapter',()=>{
 const source=readFileSync(new URL('../ui-source/workbench-client.js',import.meta.url),'utf8'),view=readFileSync(new URL('../ui-source/task-focus-view.js',import.meta.url),'utf8');
 assert(view.includes('open?children:null'));assert(!source.includes('decide.preview'));assert(!source.includes('setInterval'));assert(!source.includes("call('approval_decide'"));
 assert(source.includes("h(TaskDiagnostics,{key:'diagnostics-'+item.task_id,item}"));assert(source.includes('h(TaskAttention,'));
});

test('state transitions cannot leave ghost panels through duplicate sibling React keys',()=>{
 const s=readFileSync(new URL('../ui-source/workbench-client.js',import.meta.url),'utf8');
 for(const [component,prefix] of [['ArtifactFiles','artifacts'],['TaskAttention','attention'],['TaskDiagnostics','diagnostics'],['Collaboration','collaboration'],['Notifications','notifications']])assert(s.includes("h("+component+",{key:'"+prefix+"-'+item.task_id,"));
});

test('waiting approval without current evidence never displays a clean inbox or a guessed approve button',()=>{
 const a=taskAttention(item({display_state:'waiting_approval'}),now);assert.equal(a.length,1);assert.equal(a[0].id,'missing-proposal');assert.equal(a[0].action,'inspect');
});


test('preview approval hold never claims that a worker batch was paused',()=>{
 const s=readFileSync(new URL('../ui-source/preview/task-focus-preview.jsx',import.meta.url),'utf8');
 assert(s.includes("state==='held'?'held'"));assert(!s.includes("state==='held'?'paused'"));
});


test('owned rule and Skill templates keep preview separate from authority and are not Mac bound',()=>{
 const rules=readFileSync(new URL('../bundle/global-rules/AGENTS.md',import.meta.url),'utf8'),skill=readFileSync(new URL('../bundle/skills/task-sidebar/SKILL.md',import.meta.url),'utf8');
 assert(rules.includes('身份验证不绑定 Mac'));assert(rules.includes('候选模拟输入／回执不授予权限'));
 assert(skill.includes('只读查询身份接线状态，不产生决定'));assert(skill.includes('不要求新账户或通行密钥'));assert(skill.includes('预览下载是合成文件'));
});


test('preview approval drafts survive task navigation and remain scoped to the exact proposal revision',()=>{
 const adapter=async()=>({recorded:true,state:'approved'});adapter.drafts=new Map();
 const p={...props(),adapter},d=driver();let t=d.render(p);d.nodes(t).find(n=>n.tag==='textarea').props.onChange({target:{value:'同意，但报告分两段'}});
 const back=driver();t=back.render(p);assert.equal(back.nodes(t).find(n=>n.tag==='textarea').props.value,'同意，但报告分两段');
 const changed=driver();t=changed.render({...p,item:{...p.item,spec_revision:3}});assert.equal(changed.nodes(t).find(n=>n.tag==='textarea').props.value,'');
 const other=driver();t=other.render({...p,item:{...p.item,task_id:'different'}});assert.equal(other.nodes(t).find(n=>n.tag==='textarea').props.value,'');
});
test('recorded live hold releases old local operation so the same proposal can be decided later',async()=>{
 let held=false,discarded=0;const adapter=async()=>({operation_id:'op',prepared:true,recorded:false,proposal:{scopes:[]},interpretation:{intent:'hold'},user_text:'先等等'});adapter.pending=()=>held;adapter.confirm=async()=>({recorded:true,state:'held',message:'已记账'});adapter.discard=()=>{held=false;discarded++;};
 const d=driver(),p={...props(),adapter,onRecorded:()=>{}};let t=d.render(p);await d.find(t,'暂缓').props.onClick();held=true;t=d.render(p);await d.find(t,'保存这次决定').props.onClick();assert.equal(discarded,1);assert.equal(held,false);
 const next={...p,entry:{...p.entry,approval:{...p.entry.approval,state:'held'}},item:{...p.item,approvals:[{...pending,state:'held'}]}};t=d.render(next);assert.equal(d.find(t,'同意原方案').props.disabled,false);
});
test('stale view permits receipt query but not a new decision',async()=>{let pendingState=false;const adapter=async()=>{pendingState=true;return {operation_id:'op',prepared:true,proposal:{scopes:[]},interpretation:{intent:'approve'}};};adapter.pending=()=>pendingState;adapter.confirm=()=>{};adapter.status=async()=>({recorded:false,prepared:true});const d=driver(),p={...props(),adapter};await d.find(d.render(p),'同意原方案').props.onClick();const t=d.render({...p,fresh:false});assert.equal(d.find(t,'保存这次决定').props.disabled,true);assert.equal(d.find(t,'查询本次处理结果').props.disabled,false);});

test('read-only readiness remains reachable on a stale snapshot without enabling approval',async()=>{
 let calls=0;const adapter=async()=>{};adapter.readinessOnly=true;adapter.readiness=async()=>{calls++;return {state:'connection_pending',recorded:false,message:'等待接线'};};
 const d=driver(),p={...props(),fresh:false,adapter};const tree=d.render(p),button=d.find(tree,'查看当前处理方式');assert.equal(button.props.disabled,false);assert.equal(d.find(tree,'同意原方案'),undefined);await button.props.onClick();assert.equal(calls,1);
});

const observed=(overrides={})=>({id:'stable-item',source_id:'a',source_kind:'approval',source_revision:2,category:'decision',lifecycle:'open',owner:'user',reason:'请决定',title:'当前方案',...overrides});
const withLedger=(entries,extra={})=>item({approvals:[pending],interventions:{schema:1,initialized:true,items:entries,total:entries.length},...extra});
test('persistent item keeps source selection separate from stable intervention identity',()=>{
 const entry=taskAttention(withLedger([observed()]),now)[0];assert.equal(entry.intervention_id,'stable-item');assert.equal(entry.id,'a');assert.equal(entry.kind,'approval');
 assert.equal(decisionSelection(withLedger([observed()]),entry,'同意',null,now).request_id,'a');
});
for(const [name,override,extra] of [['missing source',{}, {approvals:[]}],['unverified',{lifecycle:'unverified'},{}],['old revision',{}, {spec_revision:3}],['expired source',{}, {approvals:[{...pending,expires:now}]}],['resolved source',{}, {approvals:[{...pending,state:'approved'}]}]])test('persisted '+name+' never renders an approval form',()=>{
 const entry=taskAttention(withLedger([observed(override)],extra),now)[0];assert.equal(entry.kind,'verification');assert.equal(entry.approval,null);assert.equal(entry.action,'inspect');assert.equal(entry.owner,'system');assert.match(entry.description,/刷新核对/);
});
test('ledger observations preserve owner, question and opinion instead of reclassifying everything as approval',()=>{
 const entries=taskAttention(withLedger([observed({source_kind:'job',category:'input',owner:'user',question:'整理哪些资料？'}),observed({source_kind:'job',category:'exception',owner:'system',user_opinion:'先不要重试'}),observed({source_kind:'job',category:'configuration',owner:'operator'})]),now);
 assert.deepEqual(entries.map(x=>x.owner),['user','system','operator']);assert.equal(entries[0].question,'整理哪些资料？');assert.equal(entries[1].feedback.user_text,'先不要重试');assert(entries.every(x=>x.kind!=='approval'));
});
test('resolved history is not active; an uninitialized ledger retains legacy fallback',()=>{
 assert.equal(taskAttention(withLedger([observed({lifecycle:'resolved'})]),now).length,0);
 const i=withLedger([]);i.interventions.initialized=false;assert.equal(taskAttention(i,now)[0].kind,'approval');
});
function interactionAdapter(identity={verified:false,state:'identity_required'}){let pending=false,calls=[];const a=async()=>{pending=true;return {operation_id:'op',prepared:true,recorded:false,interpretation:{intent:'approve'},user_text:'同意',proposal:{scopes:[]},identity};};a.pending=()=>pending;a.serverValidated=true;a.identity=async action=>{calls.push(action);return {verified:true,state:'active'};};a.confirm=async()=>({recorded:true,state:'approved'});a.discard=()=>pending=false;a.calls=calls;return a;}
test('real workbench review cannot save without existing identity; never sends IM automatically',async()=>{const adapter=interactionAdapter(),d=driver(),p={...props(),adapter};await d.find(d.render(p),'同意原方案').props.onClick();let t=d.render(p);assert.equal(d.find(t,'保存这次决定').props.disabled,true);assert.equal(d.nodes(t).find(n=>n.tag==='textarea').props.disabled,true);assert.deepEqual(adapter.calls,[]);await d.find(t,'我已回复，核对身份').props.onClick();t=d.render({...p,fresh:false});assert.equal(d.find(t,'保存这次决定').props.disabled,false);assert.deepEqual(adapter.calls,['check']);});
test('expired identity during save disables save and keeps opinion',async()=>{const adapter=interactionAdapter({verified:true,state:'active'}),d=driver(),p={...props(),adapter};adapter.confirm=async()=>{throw Error('APPROVAL_IDENTITY_REQUIRED');};let t=d.render(p);d.nodes(t).find(n=>n.tag==='textarea').props.onChange({target:{value:'就按这份方案执行'}});await d.find(d.render(p),'核对我的意见').props.onClick();await d.find(d.render(p),'保存这次决定').props.onClick();t=d.render(p);assert.equal(d.find(t,'保存这次决定').props.disabled,true);assert.equal(d.nodes(t).find(n=>n.tag==='textarea').props.value,'就按这份方案执行');});
test('unknown save cannot be changed into a second approval through return button',async()=>{const adapter=interactionAdapter({verified:true,state:'active'}),d=driver(),p={...props(),adapter};adapter.confirm=async()=>{throw Error('offline');};adapter.status=async()=>({});await d.find(d.render(p),'同意原方案').props.onClick();await d.find(d.render(p),'保存这次决定').props.onClick();const t=d.render(p);assert.equal(d.find(t,'保存这次决定').props.disabled,true);assert.equal(d.find(t,'返回修改').props.disabled,true);assert.equal(d.find(t,'查询本次处理结果').props.disabled,false);});
test('confirmed unreceived preparation has an explicit manual edit exit, preserving draft',async()=>{const adapter=interactionAdapter(),d=driver(),p={...props(),adapter};adapter.status=async()=>({recorded:false,prepared:false,operation_state:'not_received',state:'not_received',uncertain:false,message:'未收到意见核对'});let t=d.render(p);d.nodes(t).find(n=>n.tag==='textarea').props.onChange({target:{value:'先等等'}});await d.find(d.render(p),'核对我的意见').props.onClick();await d.find(d.render(p),'查询本次处理结果').props.onClick();await d.find(d.render(p),'返回修改意见').props.onClick();t=d.render(p);assert.equal(d.nodes(t).find(n=>n.tag==='textarea').props.value,'先等等');assert.equal(d.nodes(t).find(n=>n.tag==='textarea').props.disabled,false);});
