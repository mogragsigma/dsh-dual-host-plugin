import {createServer,request} from 'node:http';
import {randomBytes} from 'node:crypto';
// Loopback cookies are shared across ports. Admit a bounded browser header before
// filtering it; the upstream still receives only this carrier's native cookie.
const browserHeaderLimit=64*1024;
// This is a fixed-target carrier, not an authenticated API proxy. DSH still admits
// every Cookie/Origin/HTTP/WS request. Only a one-use root exchange gets a token.
export class WorkbenchProxy {
 constructor({port,upstreamPort,now=Date.now,ttl=15000,admit=()=>()=>{},browserHost='127.0.0.1'}){
  for(const p of [port,upstreamPort])if(!Number.isInteger(p)||p<0||p>65535)throw Error('INVALID_WORKBENCH_PORT');
  if(!['127.0.0.1','localhost'].includes(browserHost))throw Error('INVALID_WORKBENCH_HOST');
  this.browserHost=browserHost;this.port=port;this.upstreamPort=upstreamPort;this.now=now;this.ttl=ttl;this.tickets=new Map();this.cookieNames=new Set();this.sockets=new Set();this.closed=false;
  this.admit=admit;this.activityCounts={http:0,websocket:0};
 }
 async start(){
  this.server=createServer({maxHeaderSize:browserHeaderLimit},(req,res)=>this.http(req,res));
  this.server.on('clientError',(error,socket)=>{
   if(!socket.writable||socket.destroyed)return;
   const overflow=error.code==='HPE_HEADER_OVERFLOW';
   const body=overflow?'工作台请求头过大，未转发到云端。请使用独立浏览器环境；不要清理日常登录信息。':'工作台请求格式无效，未转发到云端。';
   socket.end(`HTTP/1.1 ${overflow?'431 Request Header Fields Too Large':'400 Bad Request'}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  });
  this.server.on('upgrade',(req,socket,head)=>this.upgrade(req,socket,head));
  this.server.on('connection',s=>this.track(s));this.server.requestTimeout=30000;this.server.headersTimeout=10000;
  await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(this.port,'127.0.0.1',resolve);});
  this.port=this.server.address().port;this.origin=`http://${this.browserHost}:${this.port}`;
 }
 track(s){this.sockets.add(s);s.on('close',()=>this.sockets.delete(s));s.on('error',()=>{});return s;}
 activity(){return {...this.activityCounts};}
 enter(kind){
  if(this.closed)throw Error('WORKBENCH_UNAVAILABLE');
  const leave=this.admit('workbench_'+kind);if(typeof leave!=='function')throw Error('WORKBENCH_ADMISSION_UNAVAILABLE');
  this.activityCounts[kind]++;let ended=false;
  return ()=>{if(ended)return;ended=true;this.activityCounts[kind]--;leave();};
 }
 issue(token,sessionId){
  if(this.closed||!this.origin)throw Error('WORKBENCH_UNAVAILABLE');
  if(typeof token!=='string'||!token||token.length>2048)throw Error('INVALID_WORKBENCH_TOKEN');
  if(sessionId!==undefined&&!/^(?:task-worker|a2a)-[a-f0-9-]{36}$/.test(sessionId))throw Error('INVALID_WORKBENCH_SESSION');
  for(const [key,v] of this.tickets)if(v.expires<=this.now())this.tickets.delete(key);
  if(this.tickets.size>=16)throw Error('WORKBENCH_TOO_MANY_OPENS');
  const key=randomBytes(32).toString('base64url');this.tickets.set(key,{token,expires:this.now()+this.ttl});
  return this.origin+'/?workbench_ticket='+key+(sessionId?'#dsh-worker='+sessionId:'');
 }
 trusted(req){return req.headers.host===new URL(this.origin).host&&req.headers['sec-fetch-site']!=='cross-site'&&(!req.headers.origin||req.headers.origin===this.origin);}
 route(req){
  if(!this.trusted(req)||!req.url?.startsWith('/')||req.url.startsWith('//')||req.url.length>16384)throw Error('FORBIDDEN');
  const u=new URL(req.url,this.origin);
  if(u.origin!==this.origin||u.searchParams.has('token'))throw Error('FORBIDDEN');
  if(u.searchParams.has('workbench_ticket')){
   if(req.method!=='GET'||u.pathname!=='/'||[...u.searchParams.keys()].length!==1)throw Error('FORBIDDEN');
   const key=u.searchParams.get('workbench_ticket'),ticket=this.tickets.get(key);this.tickets.delete(key);
   u.searchParams.delete('workbench_ticket');
   if(!ticket||ticket.expires<=this.now()){
    // Web iframe history may retain the redeemed entry. A reload can only fall
    // back to native cookie authentication; the ticket never authenticates twice.
    if(!(req.headers.cookie??'').split(';').some(x=>this.cookieNames.has(x.trim().split('=',1)[0])))throw Error('EXPIRED');
   }else u.searchParams.set('token',ticket.token);
  }
  return u.pathname+u.search;
 }
 options(req,path){
  // Retain browser authority and Origin: cloud signs for this local port and
  // verifies it itself. Never inject cookies, rewrite Origin, or follow redirects.
  const headers={...req.headers};
  // Cookies are host-scoped, not port-scoped. Do not carry the local Desktop or
  // another localhost application's cookies into the cloud Host. Learn names
  // only from its native root exchange; keep values solely in the browser.
  const cookie=(headers.cookie??'').split(';').map(x=>x.trim()).filter(x=>this.cookieNames.has(x.slice(0,x.indexOf('=')))).join('; ');
  if(cookie)headers.cookie=cookie;else delete headers.cookie;
  delete headers.authorization;delete headers.referer;delete headers['proxy-authorization'];delete headers['proxy-connection'];
  delete headers.forwarded;for(const k of Object.keys(headers))if(k.startsWith('x-forwarded-'))delete headers[k];
  return {hostname:'127.0.0.1',port:this.upstreamPort,path,method:req.method,headers};
 }
 http(req,res){
  // Claim admission before consuming a one-use ticket. A maintenance rejection
  // must not redeem the ticket, forward a request, or interrupt an older stream.
  let leave;try{leave=this.enter('http');}catch{res.writeHead(503,{'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});res.end('WORKBENCH_MAINTENANCE_ACTIVE');return;}
  let path;try{path=this.route(req);}catch{leave();res.writeHead(403,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer'});res.end('工作台入口已失效或请求被拒绝，请从插件重新打开。');return;}
  let upstream,upstreamClosed=false,downstreamDone=false;
  const finish=()=>{if(upstreamClosed&&downstreamDone)leave();};
  res.once('finish',()=>{downstreamDone=true;finish();});
  res.once('close',()=>{downstreamDone=true;upstream?.destroy();finish();});
  try{upstream=request(this.options(req,path),reply=>{
   reply.on('error',()=>res.destroy());
   const headers={...reply.headers,'referrer-policy':'no-referrer'};
   const cookies=(reply.headers['set-cookie']??[]).filter(value=>{
    const name=value.split('=',1)[0];
    if(path.startsWith('/?token=')&&reply.statusCode===303&&/^[A-Za-z0-9_-]{1,128}$/.test(name)&&/;\s*HttpOnly(?:;|$)/i.test(value)&&/;\s*SameSite=Strict(?:;|$)/i.test(value)&&/;\s*Path=\/(?:;|$)/i.test(value)&&!/;\s*Domain=/i.test(value))this.cookieNames.add(name);
    return this.cookieNames.has(name)&&!/;\s*Domain=/i.test(value);
   });
   if(cookies.length)headers['set-cookie']=cookies;else delete headers['set-cookie'];
   // Native root exchange must never echo a launch token into browser history.
   if(headers.location&&(/token=/i.test(headers.location)||!String(headers.location).startsWith('./'))){reply.destroy();res.writeHead(502);res.end('WORKBENCH_UNSAFE_REDIRECT');return;}
   res.writeHead(reply.statusCode,headers);reply.pipe(res);
  });}catch{upstreamClosed=true;res.writeHead(502,{'Cache-Control':'no-store'});res.end('WORKBENCH_UNAVAILABLE');return;}
  upstream.once('close',()=>{upstreamClosed=true;finish();});
  upstream.setTimeout(30000,()=>upstream.destroy());
  upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502,{'Cache-Control':'no-store'});res.end('云端连接暂不可用，请重新连接。');});
  req.on('aborted',()=>{upstream.destroy();res.destroy();});req.pipe(upstream);
 }
 upgrade(req,socket,head){
  let leave;try{leave=this.enter('websocket');}catch{socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n');return;}
  let path;try{path=this.route(req);if(req.method!=='GET'||path!=='/api/remote.mux'||req.headers.upgrade?.toLowerCase()!=='websocket')throw Error();}catch{leave();socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
  let upstream,remoteSocket,upstreamClosed=false,downstreamClosed=false,remoteClosed=true;
  const finish=()=>{if(upstreamClosed&&downstreamClosed&&remoteClosed)leave();};
  socket.once('close',()=>{downstreamClosed=true;upstream?.destroy();remoteSocket?.destroy();finish();});
  // HTTP upgraded sockets may allow a TCP half-close. A browser EOF is not a
  // usable WebSocket session; close its owned peer rather than leak a busy lease.
  socket.once('end',()=>socket.destroy());
  try{upstream=request(this.options(req,path));}catch{upstreamClosed=true;socket.destroy();return;}
  upstream.once('close',()=>{upstreamClosed=true;finish();});upstream.setTimeout(10000,()=>upstream.destroy());
  upstream.on('upgrade',(reply,remote,remoteHead)=>{
   // An upgraded ClientRequest hands ownership to the raw socket; it need not
   // emit the ordinary HTTP close lifecycle. Keep both sockets counted instead.
   upstreamClosed=true;remoteSocket=remote;remoteClosed=false;
   remote.once('close',()=>{remoteClosed=true;socket.destroy();finish();});
   if(downstreamClosed){remote.destroy();return;}
   this.track(remote);upstream.setTimeout(0);socket.write('HTTP/1.1 101 Switching Protocols\r\n'+Object.entries(reply.headers).map(([k,v])=>`${k}: ${v}`).join('\r\n')+'\r\n\r\n');
   if(remoteHead.length)socket.write(remoteHead);if(head.length)remote.write(head);
   socket.pipe(remote);remote.pipe(socket);
  });
  upstream.on('response',r=>{r.resume();socket.end(`HTTP/1.1 ${r.statusCode} Rejected\r\nConnection: close\r\n\r\n`);});
  upstream.on('error',()=>socket.destroy());upstream.end();
 }
 async close(){this.closed=true;this.tickets.clear();this.cookieNames.clear();for(const s of this.sockets)s.destroy();if(this.server?.listening)await new Promise(r=>this.server.close(r));}
}
