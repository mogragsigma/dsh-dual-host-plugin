import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {connect} from 'node:net';
import {WorkbenchProxy} from '../bundle/workbench-proxy.js';

const largeCookies='other_loopback_session='+'x'.repeat(24*1024);
async function fixture(t){
 const calls=[],sockets=new Set();
 const server=createServer((req,res)=>{
  calls.push({url:req.url,headers:req.headers});
  if(req.url==='/?token=synthetic-test-token'){
   res.writeHead(303,{location:'./','set-cookie':'native_owned=proof; HttpOnly; SameSite=Strict; Path=/'});res.end();
  }else{res.writeHead(req.headers.cookie==='native_owned=proof'?200:401);res.end('native');}
 });
 server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const proxy=new WorkbenchProxy({port:0,upstreamPort:server.address().port});await proxy.start();
 t.after(async()=>{await proxy.close();for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));});
 return {proxy,server,calls};
}
function get(url,headers={}){return new Promise((resolve,reject)=>{
 const req=request(url,{headers,agent:false},res=>{let data='';res.on('data',x=>data+=x);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,data}));});
 req.on('error',reject);req.setTimeout(3000,()=>req.destroy(Error('TEST_TIMEOUT')));req.end();
});}
test('large loopback Cookie reaches the filter but never the native root or authenticated API',async t=>{
 const {proxy,calls}=await fixture(t),url=proxy.issue('synthetic-test-token');
 const r=await get(url,{cookie:largeCookies,authorization:'Bearer unrelated'});
 assert.equal(r.status,303);assert.equal(calls.length,1);assert.equal(calls[0].headers.cookie,undefined);assert.equal(calls[0].headers.authorization,undefined);
 assert.deepEqual(r.headers['set-cookie'],['native_owned=proof; HttpOnly; SameSite=Strict; Path=/']);
 assert.equal((await get(proxy.origin+'/api/test',{cookie:largeCookies+'; native_owned=proof',origin:proxy.origin})).status,200);
 assert.equal(calls.at(-1).headers.cookie,'native_owned=proof');
 assert.equal((await get(url,{cookie:largeCookies})).status,403);
 assert.equal((await get(url,{cookie:largeCookies+'; native_owned=proof'})).status,200);
 assert.equal(calls.at(-1).url,'/');
 assert.equal((await get(proxy.origin,{cookie:largeCookies+'; native_owned=forged'})).status,401);
});
test('the larger frontend bound does not relax Host, Origin or cross-site checks',async t=>{
 const {proxy,calls}=await fixture(t);
 for(const extra of [{host:'evil.invalid'},{origin:'https://evil.invalid'},{origin:'null'},{'sec-fetch-site':'cross-site'}]){
  assert.equal((await get(proxy.issue('synthetic-test-token'),{cookie:largeCookies,...extra})).status,403);
 }
 assert.equal(calls.length,0);
});
test('headers above 64 KiB reject visibly before ticket redemption or upstream access',async t=>{
 const {proxy,calls}=await fixture(t),url=proxy.issue('synthetic-test-token');
 const r=await get(url,{cookie:'oversized='+'x'.repeat(70*1024)});
 assert.equal(r.status,431);assert.match(r.data,/未转发到云端/);assert.match(r.data,/不要清理日常登录信息/);
 assert(!r.data.includes('synthetic-test-token'));assert(!r.data.includes('workbench_ticket'));assert.equal(calls.length,0);
 assert.equal(r.headers['cache-control'],'no-store');assert.equal(r.headers['set-cookie'],undefined);
 assert.equal((await get(url)).status,303);
});
test('large-cookie WebSocket retains native authentication and rejects invalid routes',async t=>{
 const {proxy,server}=await fixture(t);await get(proxy.issue('synthetic-test-token'));
 const seen=[];server.on('upgrade',(req,socket)=>{
  seen.push(req.headers);
  if(req.headers.cookie!=='native_owned=proof'){socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');return;}
  socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');socket.on('data',x=>socket.write(x));
 });
 const ws=(cookie,path='/api/remote.mux')=>new Promise((resolve,reject)=>{
  const req=request(proxy.origin+path,{agent:false,headers:{connection:'Upgrade',upgrade:'websocket',origin:proxy.origin,cookie}});
  req.on('response',r=>{r.resume();resolve(r.statusCode);});req.on('upgrade',(_r,s)=>{s.setTimeout(3000,()=>s.destroy(Error('TEST_TIMEOUT')));s.on('error',reject);s.once('data',b=>{assert.equal(b.toString(),'probe');s.destroy();resolve(101);});s.write('probe');});req.on('error',reject);req.end();
 });
 assert.equal(await ws(largeCookies),401);assert.equal(await ws(largeCookies+'; native_owned=proof'),101);assert.equal(seen.at(-1).cookie,'native_owned=proof');
 assert.equal(await ws(largeCookies+'; native_owned=proof','/other'),403);assert.equal(seen.length,2);
});
test('non-Cookie oversized headers remain bounded and malformed requests do not echo input',async t=>{
 const {proxy,calls}=await fixture(t);
 assert.equal((await get(proxy.origin,{'x-large':'x'.repeat(70*1024)})).status,431);
 const data=await new Promise((resolve,reject)=>{const socket=connect(proxy.port,'127.0.0.1',()=>socket.write('PRIVATE_INVALID_REQUEST\r\n\r\n'));let value='';socket.on('data',b=>value+=b);socket.on('end',()=>resolve(value));socket.on('error',reject);socket.setTimeout(3000,()=>socket.destroy(Error('TEST_TIMEOUT')));});
 assert.match(data,/400 Bad Request/);assert(!data.includes('PRIVATE_INVALID_REQUEST'));assert.equal(calls.length,0);
});

test('localhost carrier preserves native browser authority and still rejects cross-site',async t=>{
 const {server,calls}=await fixture(t),proxy=new WorkbenchProxy({port:0,upstreamPort:server.address().port,browserHost:'localhost'});await proxy.start();t.after(()=>proxy.close());
 assert.equal(new URL(proxy.origin).hostname,'localhost');
 const url=proxy.issue('synthetic-test-token');
 const r=await get(url,{'sec-fetch-site':'same-site'});assert.equal(r.status,303);assert.equal(calls.at(-1).headers.host,new URL(proxy.origin).host);assert.equal(calls.at(-1).headers['sec-fetch-site'],'same-site');
 assert.equal((await get(proxy.origin+'/api/test',{origin:proxy.origin,cookie:'native_owned=proof','sec-fetch-site':'same-origin'})).status,200);assert.equal(calls.at(-1).headers.origin,proxy.origin);
 assert.equal((await get(proxy.issue('synthetic-test-token'),{'sec-fetch-site':'cross-site'})).status,403);
 assert.throws(()=>new WorkbenchProxy({port:0,upstreamPort:1,browserHost:'evil.invalid'}),/INVALID_WORKBENCH_HOST/);
});
