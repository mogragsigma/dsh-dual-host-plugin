import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request,Agent} from 'node:http';
import {createGatewayMaintenance} from '../bundle/gateway-maintenance.js';
import {WorkbenchProxy} from '../bundle/workbench-proxy.js';
import {createOnboardingCloudWeb} from '../bundle/onboarding-cloud-web.js';
import {randomUUID} from 'node:crypto';
const confirm=p=>({id:p.id,fingerprint:p.fingerprint,confirm:true});
const release=(gate,s)=>gate.release({operationId:s.operationId,instanceId:s.instanceId,confirm:true});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function until(fn){const deadline=Date.now()+3000;while(!fn()){assert(Date.now()<deadline,'activity did not settle');await new Promise(r=>setTimeout(r,5));}}
function get(url,options={}){return new Promise((resolve,reject)=>{const req=request(url,{agent:false,...options},res=>{let body='';res.on('data',b=>body+=b);res.on('end',()=>resolve({status:res.statusCode,body}));res.on('error',reject);});req.on('error',reject);req.setTimeout(3000,()=>req.destroy(Error('TEST_TIMEOUT')));req.end();});}
function ws(proxy,path='/api/remote.mux'){return new Promise((resolve,reject)=>{const req=request(proxy.origin+path,{agent:false,headers:{connection:'Upgrade',upgrade:'websocket',origin:proxy.origin}});req.on('response',res=>{res.resume();resolve({status:res.statusCode});});req.on('upgrade',(_res,socket)=>{socket.on('error',()=>{});resolve({status:101,socket});});req.on('error',reject);req.setTimeout(3000,()=>req.destroy(Error('TEST_TIMEOUT')));req.end();});}
async function fixture(t,handler){
 const calls=[],sockets=new Set(),gate=createGatewayMaintenance({instanceId:'proxy-fixture',closed:false});
 const server=createServer((req,res)=>{calls.push(req.url);if(handler)return handler(req,res);res.writeHead(200);res.end('original-response');});
 server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));s.on('error',()=>{});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const proxy=new WorkbenchProxy({port:0,upstreamPort:server.address().port,admit:label=>gate.enter(label)});await proxy.start();
 t.after(async()=>{await proxy.close();for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));});
 return {proxy,gate,server,calls,sockets};
}
test('held gateway rejects HTTP before consuming a ticket; same ticket works after explicit release',async t=>{
 const f=await fixture(t),url=f.proxy.issue('synthetic-private-token'),s=f.gate.apply(confirm(f.gate.preview({})));
 assert.equal((await get(url)).status,503);assert.equal(f.calls.length,0);assert.equal(f.proxy.tickets.size,1);assert.equal(f.gate.status().counts.requests,0);
 release(f.gate,s);assert.equal((await get(url)).status,200);assert.equal(f.calls.length,1);assert.equal(f.proxy.tickets.size,0);
 assert.equal((await get(url)).status,403);await until(()=>f.gate.status().counts.requests===0);
 assert(!JSON.stringify(f.gate.status()).includes('synthetic-private-token'));
});
test('HTTP streaming body is busy after headers, stale plan fails without cancelling original response',async t=>{
 const begun=deferred(),f=await fixture(t,(_req,res)=>{res.writeHead(200);res.write('first');begun.resolve(res);});
 const p=f.gate.preview({}),response=get(f.proxy.origin),res=await begun.promise;
 assert.equal(f.proxy.activity().http,1);assert.equal(f.gate.status().counts.proxyHttp,1);
 assert.throws(()=>f.gate.apply(confirm(p)),/BUSY/);assert(!res.destroyed);res.end('last');assert.equal((await response).body,'firstlast');
 await until(()=>f.gate.status().counts.requests===0);assert.deepEqual(f.proxy.activity(),{http:0,websocket:0});
});
test('HTTP client abort releases only after the upstream handle closes',async t=>{
 const begun=deferred(),f=await fixture(t,(_req,res)=>{res.writeHead(200);res.write('first');begun.resolve(res);});
 const req=request(f.proxy.origin,{agent:false});req.on('error',()=>{});req.end();const res=await begun.promise;
 assert.equal(f.gate.status().counts.proxyHttp,1);req.destroy();await until(()=>f.gate.status().counts.requests===0);await until(()=>res.destroyed);
});
test('pending WebSocket handshake and established socket both block gateway maintenance',async t=>{
 const f=await fixture(t),begun=deferred();f.server.on('upgrade',(_req,socket)=>begun.resolve(socket));
 const p=f.gate.preview({}),connection=ws(f.proxy),remote=await begun.promise;
 assert.equal(f.gate.status().counts.proxyWebsocket,1);assert.throws(()=>f.gate.apply(confirm(p)),/BUSY/);
 remote.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');remote.on('data',x=>remote.write(x));
 const result=await connection;assert.equal(result.status,101);assert.equal(f.proxy.activity().websocket,1);assert(!f.gate.preview({}).canApply);
 const echo=new Promise(r=>result.socket.once('data',b=>r(b.toString())));result.socket.write('untouched-stream');assert.equal(await echo,'untouched-stream');
 result.socket.destroy();await until(()=>f.gate.status().counts.requests===0);assert.equal(f.proxy.activity().websocket,0);
});
test('held gateway refuses WebSocket before forwarding; native route rejects still remain authoritative',async t=>{
 const f=await fixture(t);let calls=0;f.server.on('upgrade',(_req,socket)=>{calls++;socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');});
 const s=f.gate.apply(confirm(f.gate.preview({})));assert.equal((await ws(f.proxy)).status,503);assert.equal(calls,0);release(f.gate,s);
 assert.equal((await ws(f.proxy)).status,401);assert.equal(calls,1);await until(()=>f.gate.status().counts.requests===0);
 assert.equal((await ws(f.proxy,'/invalid')).status,403);assert.equal(calls,1);assert.equal(f.gate.status().counts.requests,0);
});
test('upstream connection failure and unsafe redirects leave no lingering activity',async t=>{
 const f=await fixture(t,(_req,res)=>{res.writeHead(303,{location:'https://untrusted.invalid/?token=private'});res.end();});
 assert.equal((await get(f.proxy.origin)).status,502);await until(()=>f.gate.status().counts.requests===0);
 await new Promise(r=>f.server.close(r));assert.equal((await get(f.proxy.origin)).status,502);await until(()=>f.gate.status().counts.requests===0);
 assert.deepEqual(f.proxy.activity(),{http:0,websocket:0});
});
test('idle keepalive connection does not falsely prevent gateway maintenance',async t=>{
 const f=await fixture(t),agent=new Agent({keepAlive:true});t.after(()=>agent.destroy());
 assert.equal((await get(f.proxy.origin,{agent})).status,200);await until(()=>f.gate.status().counts.requests===0);assert(f.proxy.sockets.size>0);
 const s=f.gate.apply(confirm(f.gate.preview({})));assert.equal(s.state,'held');assert.equal((await get(f.proxy.origin,{agent})).status,503);release(f.gate,s);
});
test('cloud onboarding carrier uses the same admission contract after its open RPC has returned',async t=>{
 const f=await fixture(t),gate=f.gate;let live=true;
 const web=createOnboardingCloudWeb({enabled:()=>true,admit:label=>gate.enter(label),remote:async()=>({target:{operationId:randomUUID(),installationId:randomUUID(),runtimeId:randomUUID(),manifestHash:'a'.repeat(64),root:'/owned/cloud',role:'cloud',hostVersion:'0.2.1-rc.2'},value:{port:f.server.address().port,token:'synthetic-onboarding-token',nativeNonce:randomUUID()},tunnel:{port:f.server.address().port,alive:()=>live,onClose:()=>()=>{},close:async()=>{live=false;}}})});t.after(()=>web.dispose());
 const opened=await web.open({}),s=gate.apply(confirm(gate.preview({})));assert.equal((await get(opened.url)).status,503);assert.equal(f.calls.length,0);
 release(gate,s);assert.equal((await get(opened.url)).status,200);await until(()=>gate.status().counts.requests===0);
 await web.close({entryId:opened.entryId});assert(!live);
});
test('remote WebSocket loss and explicit carrier teardown drain the original handles exactly once',async t=>{
 const f=await fixture(t),remotes=[];f.server.on('upgrade',(_req,socket)=>{remotes.push(socket);socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');});
 const first=await ws(f.proxy);assert.equal(first.status,101);remotes[0].destroy();await until(()=>f.gate.status().counts.requests===0);assert(first.socket.destroyed);
 const second=await ws(f.proxy);assert.equal(second.status,101);await f.proxy.close();await until(()=>f.gate.status().counts.requests===0);assert.deepEqual(f.proxy.activity(),{http:0,websocket:0});
 await f.proxy.close();assert.equal(f.gate.status().counts.requests,0);
});
