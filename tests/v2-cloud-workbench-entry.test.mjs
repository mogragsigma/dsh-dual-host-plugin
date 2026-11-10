import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// Exercise the generated UI's actual handlers without a Host or browser network.
function mount(props={}){
 const slots=[];let cursor=0;
 const React={Component:class {},createContext:()=>({}),forwardRef:f=>f,useEffect(){},useState(initial){const n=cursor++;if(!(n in slots))slots[n]=typeof initial==='function'?initial():initial;return [slots[n],v=>{slots[n]=typeof v==='function'?v(slots[n]):v;}];},useRef(initial){const n=cursor++;return slots[n]??={current:initial};},createElement:(type,props,...children)=>({type,props:{...props,children:children.length===1?children[0]:children}})};
 const scope={React};vm.runInNewContext(readFileSync(new URL('../ui-source/workbench-v2.generated.js',import.meta.url),'utf8'),scope);
 function render(){cursor=0;const outer=scope.DSHWorkbenchV2.Workbench(props),body=outer.props.children;return body.type(body.props);}
 function find(node,predicate){if(!node||typeof node!=='object')return null;if(Array.isArray(node)){for(const x of node){const v=find(x,predicate);if(v)return v;}return null;}return predicate(node)?node:find(node.props?.children,predicate);}
 const root=()=>render(),page=host=>find(render(),x=>typeof x.props?.render==='function').props.render({kind:'host',host},true);
 const button=(host,label)=>find(page(host),x=>x.props?.children===label&&typeof x.props?.onClick==='function');
 return {root,page,button,find};
}

test('cloud native entry sits beside task projection and never creates a task',async()=>{
 const calls=[],ui=mount({open:async(...args)=>calls.push(args)});
 assert(ui.button('cloud','查看云端任务'));
 const entry=ui.button('cloud','打开云端工作台');assert(entry);assert.equal(entry.props['data-guide'],'cloud-workbench');
 assert.match(entry.props['data-guide-text'],/不会创建任务/);
 assert.equal(ui.button('local','打开云端工作台'),null);
 await entry.props.onClick();assert.deepEqual(calls,[[]]);
 ui.button('cloud','查看云端任务').props.onClick();assert.equal(calls.length,1);
});

test('pending native open disables the button and guards repeated invocation',async()=>{
 let done,calls=0;const ui=mount({open:()=>{calls++;return new Promise(r=>done=r);}});
 const click=ui.button('cloud','打开云端工作台').props.onClick,pending=click();await click();
 assert.equal(calls,1);const busy=ui.button('cloud','正在打开…');assert.equal(busy.props.disabled,true);assert.equal(busy.props['aria-busy'],true);
 done();await pending;assert.equal(ui.button('cloud','打开云端工作台').props.disabled,false);
});

test('failure is explicit and sanitized, with no automatic retry',async()=>{
 let calls=0;const ui=mount({open:async()=>{calls++;throw Error('private-token-must-not-render');}});
 await ui.button('cloud','打开云端工作台').props.onClick();
 const error=ui.find(ui.root(),x=>x.props?.role==='alert');assert.match(error.props.children,/双端连接/);assert.match(error.props.children,/没有创建或重试任务/);assert(!error.props.children.includes('private-token'));
 assert.equal(calls,1);assert.equal(ui.button('cloud','打开云端工作台').props.disabled,false);
});

test('adapter navigation error remains visible after a main-panel remount',()=>{
 const ui=mount({navigationError:()=> '原生浏览器面板未能打开；没有创建或重试任务。'});
 assert.match(ui.find(ui.root(),x=>x.props?.role==='alert').props.children,/原生浏览器/);
});

test('unwired preview fails explicitly rather than claiming successful navigation',async()=>{
 const ui=mount();await ui.button('cloud','打开云端工作台').props.onClick();
 assert.match(ui.find(ui.root(),x=>x.props?.role==='alert').props.children,/未能打开云端工作台/);
});
