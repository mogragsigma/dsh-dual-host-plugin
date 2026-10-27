import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {WorkbenchProxy} from '../bundle/workbench-proxy.js';
import {Workbench,installWorkbench,workbenchSnapshot} from '../bundle/workbench-host.js';
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',r));
async function fixture(t){
 const calls=[],server=createServer((req,res)=>{calls.push({url:req.url,headers:req.headers});if(req.url==='/?token=test-launch'){res.writeHead(303,{'set-cookie':'native=proof; HttpOnly; SameSite=Strict; Path=/','location':'./'});res.end();}else if(req.url==='/redirect'){res.writeHead(302,{location:'https://evil.invalid/?token=leak'});res.end();}else{res.writeHead(req.headers.cookie==='native=proof'?200:401);res.end('native');}});
 const sockets=new Set();server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
 await listen(server);const p=new WorkbenchProxy({port:0,upstreamPort:server.address().port});await p.start();t.after(async()=>{await p.close();for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));});return {p,calls,server};
}
function get(p,path='/',headers={},method='GET'){return new Promise((resolve,reject)=>{const r=request(p.origin+path,{headers,method},res=>{let data='';res.on('data',x=>data+=x);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,data}));});r.on('error',reject);r.end();});}
test('one-use ticket only authenticates native root; browser never gets launch token',async t=>{
 const {p,calls}=await fixture(t),url=new URL(p.issue('test-launch'));assert(!url.href.includes('test-launch'));
 const r=await get(p,url.pathname+url.search);assert.equal(r.status,303);assert.equal(r.headers.location,'./');assert(!JSON.stringify(r).includes('test-launch'));
 assert.equal(calls[0].url,'/?token=test-launch');assert.equal((await get(p,url.pathname+url.search)).status,403);
 assert.equal((await get(p)).status,401);assert.equal((await get(p,'/',{cookie:'native=proof'})).status,200);
 assert.equal((await get(p,url.pathname+url.search,{cookie:'native=proof'})).status,200);assert.equal((await get(p,url.pathname+url.search,{cookie:'native=forged'})).status,401);
});
test('expiry, replay, bounded tickets and close revoke all unopened launch credentials',async t=>{
 const {p}=await fixture(t);let now=0;p.now=()=>now;const u=new URL(p.issue('test-launch'));now=15001;
 assert.equal((await get(p,u.pathname+u.search)).status,403);
 for(let i=0;i<16;i++)p.issue('test-launch');assert.throws(()=>p.issue('test-launch'),/TOO_MANY/);await p.close();assert.equal(p.tickets.size,0);assert.throws(()=>p.issue('x'),/UNAVAILABLE/);
});
for(const [label,path,headers,method] of [
 ['foreign Host','/',{host:'evil.invalid'},'GET'],['foreign Origin','/',{origin:'https://evil.invalid'},'GET'],['opaque Origin','/',{origin:'null'},'GET'],['cross-site','/',{'sec-fetch-site':'cross-site'},'GET'],['raw launch token','/?token=attacker',{},'GET'],['network path','//evil.invalid/',{},'GET'],['ticket on API','/api/x?workbench_ticket=x',{},'GET'],['ticket with extra query','/?workbench_ticket=x&anything=1',{},'GET'],['ticket POST','/?workbench_ticket=x',{},'POST'],
])test('proxy rejects '+label+' before upstream',async t=>{const {p,calls}=await fixture(t);assert.equal((await get(p,path,headers,method)).status,403);assert.equal(calls.length,0);});
test('preserves Cookie and same-authority Origin; strips spoofed forwarding/proxy credentials',async t=>{const {p,calls}=await fixture(t);const u=new URL(p.issue('test-launch'));await get(p,u.pathname+u.search);calls.length=0;assert.equal((await get(p,'/api/test',{cookie:'local-dsh=DO_NOT_FORWARD; native=proof; unrelated=PRIVATE',origin:p.origin,forwarded:'host=evil','x-forwarded-host':'evil','proxy-authorization':'secret'},'POST')).status,200);assert.equal(calls[0].headers.origin,p.origin);assert.equal(calls[0].headers.host,new URL(p.origin).host);assert.equal(calls[0].headers.cookie,'native=proof');for(const n of ['forwarded','x-forwarded-host','proxy-authorization'])assert.equal(calls[0].headers[n],undefined);});
test('redirect never leaks token or redirects to a different origin',async t=>{const {p}=await fixture(t);assert.equal((await get(p,'/redirect')).status,502);});
test('upstream failure is explicit, not successful login or replay',async t=>{const {p,server}=await fixture(t);await new Promise(r=>server.close(r));const r=await get(p);assert.equal(r.status,502);});
test('native WebSocket upgrade keeps authentication and propagates rejection',async t=>{
 const {p,server}=await fixture(t);const u=new URL(p.issue('test-launch'));await get(p,u.pathname+u.search);let accepted=0;
 server.on('upgrade',(req,socket)=>{if(req.headers.cookie!=='native=proof'){socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');return;}accepted++;socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');socket.on('data',x=>socket.write(x));});
 const connect=(cookie,path='/api/remote.mux')=>new Promise((resolve,reject)=>{const r=request(p.origin+path,{headers:{connection:'Upgrade',upgrade:'websocket',origin:p.origin,...cookie?{cookie}:{} }});r.on('response',res=>{res.resume();resolve(res.statusCode);});r.on('upgrade',(_res,s)=>{s.once('data',b=>{assert.equal(b.toString(),'echo');s.destroy();resolve(101);});s.write('echo');});r.on('error',reject);r.end();});
 assert.equal(await connect(),401);assert.equal(await connect('native=proof'),101);assert.equal(await connect('native=proof','/other'),403);assert.equal(accepted,1);
});
test('disabled workbench adds no capability, route, or listener',()=>{let used=false;installWorkbench({inject:()=>{used=true;}},{},undefined);assert(!used);});
test('bootstrap uses live public connection token and validates linked worker',async()=>{
 let token='first';const g={c:{role:'cloud'},instanceId:'instance',scheduler:{jobs:{db:{prepare:()=>({get:id=>id==='known'})}}}};
 const ctx={get:n=>n==='webServer'?{host:'127.0.0.1',protocol:'http:',getOrigin:()=> 'http://127.0.0.1:19387'}:{authenticatedUrl:u=>u+'/?token='+token}};
 const wb=new Workbench(ctx,g,{});assert((await wb.call('workbench_bootstrap',{})).url.endsWith('first'));token='second';assert((await wb.call('workbench_bootstrap',{})).url.endsWith('second'));
 await assert.rejects(wb.call('workbench_bootstrap',{session_id:'unknown'}),/NOT_FOUND/);await assert.rejects(wb.call('workbench_bootstrap',{url:'http://evil'}),/METHOD_DENIED/);
});
test('cloud refuses non-loopback or non-Web carrier',async()=>{for(const server of [null,{host:'0.0.0.0'}, {host:'127.0.0.1',protocol:'https:'}]){const w=new Workbench({get:n=>n==='webServer'?server:{authenticatedUrl:()=>''}},{c:{role:'cloud'}},{});await assert.rejects(w.call('workbench_bootstrap',{}),/UNAVAILABLE/);}});
test('snapshot never pretends requested model is observed dispatch',()=>{const g={c:{role:'cloud'},hello:()=>({plugin_version:'test'}),now:()=>1,instanceId:'i',catalog:{head:()=>({title:'Example'})},scheduler:{jobs:{db:{prepare:()=>({all:()=>[{id:'run',policy:'{"model":"glm-5.3"}',checkpoint:'{"summary":"saved"}'}]})}}}};const s=workbenchSnapshot(g);assert.equal(s.runs[0].requested_model.model,'glm-5.3');assert.equal(s.runs[0].actual_model,null);assert.equal(s.development_enabled,false);});
test('client registers own public slots; unwraps RPC, never replaces native navigation',async()=>{
 let module,body,select=null;const slots=[],effects=[],calls=[];const fakeReact={createElement:()=>null,forwardRef:f=>f,createContext:()=>({}),Component:class {}};const context={window:{__ModuleLoader__:{load:x=>{module=x.factory(()=>fakeReact);}},addEventListener(){},removeEventListener(){}},document:{createElement:()=>({remove(){}}),head:{append(){}}},location:{hash:''},history:{},URL,setTimeout:()=>0,clearTimeout};vm.runInNewContext(readFileSync(new URL('../bundle/workbench-client.js',import.meta.url),'utf8'),context);
 const ctx={inject(){},connection:{rpc:{call:async(...a)=>{calls.push(a);return {ok:true,value:{role:'cloud'}};}}},effect:f=>effects.push(f()),get:()=>null,uiWorkspace:{openSession(){throw Error('unexpected');}},layout:{selectPanel:x=>select=x},slots:{inject:(_n,fn)=>fn(),register:(r)=>{slots.push(r);if(r.name==='main')body=r.inject();return()=>{};}}};module.apply(ctx);assert.deepEqual(slots.map(r=>r.name),['main','main','sidebar.panellist']);await body.open();assert.equal(select,null);assert.equal(calls[0][0],'/api');ctx.connection.rpc.call=async()=>({ok:false,error:{code:'CAPABILITY_UNAVAILABLE'}});await assert.rejects(body.call('status',{}),/CAPABILITY_UNAVAILABLE/);for(const f of effects)f();
});

test('A2A UI opens only owning Host and never retries rejected local navigation through cloud',async()=>{
 let module,body;const calls=[],opened=[];
 vm.runInNewContext(readFileSync(new URL('../bundle/workbench-client.js',import.meta.url),'utf8'),{window:{__ModuleLoader__:{load:x=>module=x.factory(()=>({createElement:()=>null,forwardRef:f=>f,createContext:()=>({}),Component:class {}}))},addEventListener(){},removeEventListener(){}},document:{createElement:()=>({remove(){}}),head:{append(){}}},location:{hash:''},history:{},URL,setTimeout:()=>0,clearTimeout});
 const ctx={inject(){},effect:f=>f(),get:()=>null,connection:{rpc:{call:async(_p,_m,p)=>{calls.push(p);if(p.method==='a2a-session')return {ok:true,value:{session_id:p.args.session_id}};throw Error('UNEXPECTED');}}},sessions:{refresh:async()=>{}},uiWorkspace:{openSession:id=>opened.push(id)},layout:{selectPanel(){}},slots:{inject:(_n,fn)=>fn(),register:r=>{if(r.name==='main')body=r.inject();return()=>{};}}};module.apply(ctx);
 const r={to:'local',task_id:'task',id:'r',session_id:'a2a-12345678-1234-1234-1234-123456789abc'};await body.openA2A(r,'local');assert.deepEqual(opened,[r.session_id]);assert.equal(calls.length,1);assert.equal(calls[0].method,'a2a-session');assert.equal(calls[0].args.task_id,'task');
 await assert.rejects(body.openA2A(r,'cloud'),/WRONG_HOST/);assert.equal(calls.length,1);
 ctx.connection.rpc.call=async(_p,_m,p)=>{calls.push(p);return {ok:false,error:{code:'WORKBENCH_SESSION_NOT_FOUND'}};};await assert.rejects(body.openA2A(r,'local'),/NOT_FOUND/);assert.equal(calls.length,2);assert(calls.every(x=>x.method==='a2a-session'));
 ctx.connection.rpc.call=async(_p,_m,p)=>{calls.push(p);return {ok:false,error:{code:'WORKBENCH_TUNNEL_UNAVAILABLE'}};};await assert.rejects(body.openA2A({...r,to:'cloud'},'local'),/TUNNEL/);assert.equal(calls.at(-1).method,'open');assert.equal(calls.at(-1).args.a2a.task_id,'task');assert.equal(calls.at(-1).args.a2a.request_id,'r');
});
test('proxy accepts validated A2A session namespace but rejects arbitrary navigation strings',async t=>{const {p}=await fixture(t),id='a2a-12345678-1234-1234-1234-123456789abc';assert.equal(new URL(p.issue('test-launch',id)).hash,'#dsh-worker='+id);for(const s of ['native-secret','a2a-x',id+'?token=bad'])assert.throws(()=>p.issue('test-launch',s),/INVALID_WORKBENCH_SESSION/);});

test('browser failure survives main-panel remount, remains sanitized and never retries execution',async()=>{
 let module,body;const calls=[],panels=[];let fail=true;
 vm.runInNewContext(readFileSync(new URL('../bundle/workbench-client.js',import.meta.url),'utf8'),{window:{__ModuleLoader__:{load:x=>module=x.factory(()=>({createElement:()=>null,forwardRef:f=>f,createContext:()=>({}),Component:class {}}))},addEventListener(){},removeEventListener(){}},document:{createElement:()=>({remove(){}}),head:{append(){}}},location:{hash:''},history:{},URL,requestAnimationFrame:f=>f(),setTimeout:()=>0,clearTimeout});
 const right={openTab:async()=>{if(fail)throw Error('sidebarRight: no tab type is registered as "browser"');}};
 const ctx={inject(){},effect:f=>f(),get:()=>right,connection:{rpc:{call:async(_p,_m,p)=>{calls.push(p);return {ok:true,value:{role:'local',url:'http://127.0.0.1:49999/?workbench_ticket=SECRET'}};}}},layout:{selectPanel:p=>panels.push(p)},slots:{inject:(_n,f)=>f(),register:r=>{if(r.name==='main')body=r.inject();return()=>{};}}};module.apply(ctx);
 const mountedProps=body;assert.equal(mountedProps.navigationError(),null);
 await assert.rejects(body.open(),/no tab type/);assert.match(mountedProps.navigationError(),/尚未启用原生浏览器/);assert(!mountedProps.navigationError().includes('SECRET'));assert.equal(calls.length,1);assert.equal(panels[0],null);assert(panels[1]);
 right.openTab=async()=>{throw Error('sidebarRight: no session surface is mounted');};await assert.rejects(body.open(),/no session surface/);assert.match(mountedProps.navigationError(),/当前没有原生会话容器/);assert.match(mountedProps.navigationError(),/已有会话/);assert.match(mountedProps.navigationError(),/未新建或重试任务/);
 right.openTab=async()=>{throw Error('credential SECRET unexpected');};await assert.rejects(body.open(),/SECRET/);assert(!mountedProps.navigationError().includes('SECRET'));
 right.openTab=async()=>{};await body.open();assert.equal(mountedProps.navigationError(),null);assert.equal(calls.length,4);assert(calls.every(p=>p.method==='open'));
});
