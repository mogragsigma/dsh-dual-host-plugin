import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';

// Execute the shipped component with a small deterministic hook driver. Browser
// layout and native-service acceptance remain separate from these state tests.
async function manager(request){
 const states=[],cleanups=[];let cursor=0,first=true;
 const React={Component:class{},createContext:()=>({}),forwardRef:fn=>fn,memo:fn=>fn,createElement:(type,props,...children)=>({type,props:props??{},children}),useState(initial){const i=cursor++;if(!(i in states))states[i]=initial;return [states[i],value=>{states[i]=value;}];},useEffect(fn){if(first){const close=fn();if(close)cleanups.push(close);}}};
 const context=vm.createContext({React});vm.runInContext(await fs.readFile(new URL('../ui-source/onboarding.generated.js',import.meta.url),'utf8'),context);
 const entry={entryId:randomUUID(),target:{root:'/owned/test-cloud'},url:'http://127.0.0.1:12345/?workbench_ticket=SYNTHETIC#dsh-setup-im'};
 let back=0;
 const render=()=>{cursor=0;const tree=context.DSHOnboarding.CloudImManager({entry,request,onBack:()=>back++});first=false;return tree;};
 const nodes=tree=>!tree||typeof tree!=='object'?[]:[tree,...tree.children.flat(Infinity).flatMap(nodes)];
 const text=tree=>typeof tree==='string'?tree:tree&&typeof tree==='object'?tree.children.flat(Infinity).map(text).join(''):'';
 const click=async(label)=>{const tree=render(),button=nodes(tree).find(n=>n.props.onClick&&text(n)===label);assert(button,'missing '+label);assert(!button.props.disabled);await button.props.onClick();};
 return {entry,render,nodes,text,click,back:()=>back,dispose:()=>cleanups.forEach(f=>f())};
}

test('carrier UI only checks on explicit click; failure clears the old observation, never reconnects',async()=>{
 const calls=[];let fail=false;const m=await manager(async(method,args)=>{calls.push(method);assert.equal(method,'cloud_web_status');if(fail)throw Error('PRIVATE_REMOTE_DETAIL');return {contract:1,entryId:args.entryId,state:'open',scope:'local_owned_carrier_only',observedAt:1000};});
 m.render();assert.deepEqual(calls,[]);await m.click('手动核对承载连接');assert(m.text(m.render()).includes('不证明云端页面或机器人在线'));
 fail=true;await m.click('手动核对承载连接');const view=m.text(m.render());assert(view.includes('不沿用旧结论'));assert(!view.includes('承载进程仍在运行'));assert(!view.includes('PRIVATE'));assert.deepEqual(calls,['cloud_web_status','cloud_web_status']);
});

test('closed carrier keeps iframe until explicit close; close never dispatches remote restart or binding',async()=>{
 const calls=[];const m=await manager(async(method,args)=>{calls.push(method);return method==='cloud_web_status'?{contract:1,entryId:args.entryId,state:'closed',scope:'local_owned_carrier_only',observedAt:1000,transport:{reason:'PROCESS_EXIT',exitCode:255}}:{state:'closed'};});
 await m.click('手动核对承载连接');assert(m.text(m.render()).includes('本次承载连接已关闭'));assert(m.nodes(m.render()).some(n=>n.type==='iframe'));assert(m.text(m.render()).includes('先保留未保存内容'));
 await m.click('关闭云端入口，返回导览');assert.equal(m.back(),1);assert.deepEqual(calls,['cloud_web_status','cloud_web_close']);
});

test('entry mismatch or unsupported status cannot become an online claim',async()=>{
 const m=await manager(async()=>({contract:1,entryId:randomUUID(),state:'open',scope:'local_owned_carrier_only',observedAt:1000}));await m.click('手动核对承载连接');assert(m.text(m.render()).includes('未能核对本次承载连接'));assert(!m.text(m.render()).includes('承载进程仍在运行'));
});

test('shipped native IM navigation survives reload without invoking any business RPC',async()=>{
 const source=await fs.readFile(new URL('../ui-source/workbench-client.js',import.meta.url),'utf8');
 const start=source.indexOf('  async function navigate(){'),end=source.indexOf('  const timer=setTimeout(navigate,0);',start);assert(start>0&&end>start);
 const location={hash:'#dsh-setup-im',pathname:'/',search:''};let panels=0,notifications=0;
 const context=vm.createContext({location,history:{replaceState(){assert.fail('IM landing must not consume its navigation marker');}},ctx:{layout:{selectPanel:()=>panels++}},boardPanel:'own-board',disposed:false,setupImRequested:false,setupImListeners:new Set([()=>notifications++]),call(){assert.fail('navigation must not run configuration');}});
 vm.runInContext(source.slice(start,end),context);await context.navigate();assert.equal(location.hash,'#dsh-setup-im');assert(context.setupImRequested);assert.equal(panels,1);
 context.setupImRequested=false;await context.navigate();assert(context.setupImRequested);assert.equal(panels,2);assert.equal(notifications,2);
 const back=source.match(/onBack:\(\)=>\{(if\(location\.hash==='#dsh-setup-im'\)[^}]+setImOpen\(false\);)\}/);assert(back);
 context.history.replaceState=(_s,_t,url)=>{assert.equal(url,'/');location.hash='';};context.setImOpen=value=>assert.equal(value,false);
 vm.runInContext(back[1],context);assert.equal(location.hash,'');assert.equal(context.setupImRequested,false);
});

test('admission wording does not claim current default config bytes are unchanged',async()=>{
 const source=await fs.readFile(new URL('../ui-source/onboarding/cloud-installation.jsx',import.meta.url),'utf8');assert(!source.includes('官方默认配置保持不变'));assert(source.includes('启动时配置基线已核验；后续修改需另行核对'));
});
