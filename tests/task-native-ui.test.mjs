import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';
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

for(const native of [true,false])test('decision UI separates native and legacy authority: '+native,async()=>{
 const d=driver(),approval={id:'a',state:'pending',spec_revision:1,expires:Date.now()+86400000,...(native?{authorization_mode:'task-native'}:{})};
 const adapter=async()=>({prepared:true,operation_id:'op',identity:native?{required:false,policy:'task-native'}:{verified:false,state:'identity_required'},proposal:{scopes:['develop']},interpretation:{intent:'approve'},user_text:'同意'});
 adapter.identity=()=>{throw Error('NO_IM_UI_CALL');};adapter.confirm=async()=>({recorded:true,state:'approved',message:'已保存，未执行'});adapter.discard=()=>{};
 const p={item:{task_id:'t',spec_revision:1,approvals:[approval]},entry:{id:'a',approval},fresh:true,adapter};
 let tree=d.render(p);await d.find(tree,'同意原方案').props.onClick();tree=d.render(p);
 assert.equal(!!d.find(tree,'通过已绑定 IM 确认身份'),!native);assert.equal(d.find(tree,'保存这次决定').props.disabled,!native);
 if(native){await d.find(tree,'保存这次决定').props.onClick();assert(d.text(d.render(p)).includes('批准已记账'));}
});
