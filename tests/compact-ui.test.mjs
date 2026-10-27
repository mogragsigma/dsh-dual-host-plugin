import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';
import {readFileSync,readdirSync} from 'node:fs';import {createHash} from 'node:crypto';
const source=readFileSync(new URL('../ui-source/workbench-client.js',import.meta.url),'utf8');
const client=readFileSync(new URL('../bundle/workbench-client.js',import.meta.url),'utf8');
function driver(){
 const states=[],deps=[];let cursor=0,effects=[],component;
 const React={createElement:(tag,props,...children)=>({tag,props:props??{},children}),useState(value){const i=cursor++;if(!(i in states))states[i]=value;return [states[i],v=>states[i]=v];},useEffect(fn,d){const i=cursor++;if(!deps[i]||d.some((v,j)=>v!==deps[i][j])){deps[i]=d;effects.push(fn);}}};
 const code=client.replace("return {name:'task-workbench',inject:['connection','slots','layout','uiWorkspace','sessions'],apply};",'return {PaginatedTimeline};');
 vm.runInNewContext(code,{window:{__ModuleLoader__:{load:m=>component=m.factory(()=>React).PaginatedTimeline}}});
 const render=items=>{cursor=0;let tree=component({items,render:x=>x,label:'测试',empty:'暂无'});if(effects.length){effects.splice(0).forEach(f=>f());cursor=0;tree=component({items,render:x=>x,label:'测试',empty:'暂无'});}return tree;};
 const nodes=t=>typeof t==='object'&&t?[t,...t.children.flat(Infinity).flatMap(nodes)]:[];
 const text=t=>typeof t==='string'||typeof t==='number'?String(t):t?.children?.flat(Infinity).map(text).join('')??'';
 const click=(tree,title)=>{const b=nodes(tree).find(n=>n.tag==='button'&&text(n)===title);assert(b);assert(!b.props.disabled);b.props.onClick();};
 const rows=t=>nodes(t).find(n=>n.tag==='ol').children.flat(Infinity);
 return {render,nodes,text,click,rows};
}
test('pagination renders five rows then bounded last page, no request interface exists',()=>{
 const d=driver(),items=Array.from({length:12},(_,i)=>'run'+i);let t=d.render(items);assert.deepEqual(d.rows(t),items.slice(0,5));assert(d.text(t).includes('已加载 12 条 · 1/3 页'));
 d.click(t,'下一页');t=d.render(items);assert.deepEqual(d.rows(t),items.slice(5,10));d.click(t,'下一页');t=d.render(items);assert.deepEqual(d.rows(t),items.slice(10));assert(d.nodes(t).find(n=>n.tag==='button'&&d.text(n)==='下一页').props.disabled);
 d.click(t,'上一页');assert(d.text(d.render(items)).includes('2/3 页'));
});
test('manual snapshot replacement resets pagination even when the new result shrinks',()=>{
 const d=driver(),items=Array.from({length:12},(_,i)=>i);let t=d.render(items);d.click(t,'下一页');t=d.render(items);d.click(t,'下一页');
 const small=[0,1];t=d.render(small);assert.deepEqual(d.rows(t),small);assert(d.text(t).includes('已加载 2 条 · 1/1 页'));
});
test('empty snapshot has a truthful zero and both page buttons disabled',()=>{
 const d=driver(),t=d.render([]);assert.equal(d.rows(t).length,0);assert(d.text(t).includes('已加载 0 条 · 1/1 页'));assert(d.text(t).includes('暂无'));assert(d.nodes(t).filter(n=>n.tag==='button').every(n=>n.props.disabled));
});
test('same snapshot identity preserves page across expiry and ordinary rerenders',()=>{
 const d=driver(),items=Array.from({length:9},(_,i)=>i);d.click(d.render(items),'下一页');assert(d.text(d.render(items)).includes('2/2 页'));assert(d.text(d.render(items)).includes('2/2 页'));
});
test('rename affects labels, not plugin identifiers or navigation contracts',()=>{
 assert(source.includes("label:'大肥鱼bot'"));assert(!source.includes('双端工作台'));for(const id of ['@mogragsigma/dsh-dual-host-plugin','dsh-cloud-workbench','dsh-dual-tasks','task-workbench/control'])assert(source.includes(id));
 assert(source.includes("'aria-label':compact?'双端任务侧栏':'大肥鱼bot'"));
});
test('static connection panels and hero are removed; inline help remains keyboard accessible',()=>{
 assert(!source.includes('你的云端，触手可及'));assert(!source.includes("className:'workspace-aside'"));assert(source.indexOf("button('连接与边界'")<source.indexOf('!compact?h(Menu'));
 for(const value of ["'aria-haspopup':'dialog'","'aria-controls':id","trigger.current?.focus()","普通批次","双端协作会话","最多读取最近 50 次"])assert(source.includes(value));
});
test('safety observations and original manual action branches remain exposed',()=>{
 for(const value of ['历史执行快照 · 会话导航停用','不自动重试任务','不视为对端空闲',"!workspaceFresh","!fresh","call('status',{})","request('list',{...args,limit:20})","function refresh(){setNavError('');list.load(filter);if(selected)detail.load(selected);if(workspaceRead.current)workspace.load({});}"])assert(source.includes(value));
 assert(!source.includes('setInterval'));assert(!source.includes("call('approve'"));
});
test('onboarding keeps validation and real confirmations, shrinks static descriptions only',()=>{
 const app=readFileSync(new URL('../ui-source/onboarding/app.jsx',import.meta.url),'utf8'),components=readFileSync(new URL('../ui-source/onboarding/components.jsx',import.meta.url),'utf8');
 assert(!app.includes('连接之前，先认识环境'));assert(app.includes('aria-valuenow={handled.length}'));assert(app.includes('disabled={!canNext||busy}'));assert(app.includes('我已阅读保护策略，仅查看下一页（不授权执行）'));assert(components.includes('RequirementBadge'));assert(components.includes('aria-required'));assert(components.includes('export function InfoHelp'));assert(components.includes('context-help-trigger'));
});
test('frozen runtime, rules, skills, assets and manifests are byte-for-byte unchanged except generated UI',{skip:JSON.parse(readFileSync(new URL('../bundle/package.json',import.meta.url),'utf8')).version!=='0.31.0-alpha.69'?'Historical S65 UI-only boundary; newer runtime candidates require their own manifest and tests.':false},()=>{
 const baseline=JSON.parse(readFileSync(new URL('../docs/candidate-bundle-alpha69.json',import.meta.url),'utf8')).files;
 let checked=0;for(const [p,hash] of Object.entries(baseline)){if(p==='workbench-client.js')continue;assert.equal(createHash('sha256').update(readFileSync(new URL('../bundle/'+p,import.meta.url))).digest('hex'),hash,p);checked++;}assert.equal(checked,244);
});

test('task help explains partial names without changing search dispatch or adding semantic search',()=>{
 for(const text of ['可输入部分任务名称','例如“模型”可找到“每周模型能力更新”','不做语义搜索或错字纠正','清空后再次查找显示全部任务'])assert(source.includes(text));
 assert(source.includes("function search(e){e.preventDefault();const f={query,after:0};setFilter(f);setSelected(null);detail.reset();list.load(f);}"));
 assert(source.includes("onChange:e=>setQuery(e.target.value)"));assert(source.includes('本页 0 条 / 共 ${data.total} 条'));
});
