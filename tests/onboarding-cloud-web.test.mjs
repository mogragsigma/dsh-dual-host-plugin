import {createOnboardingActivity} from '../bundle/onboarding-activity.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import {createOnboardingCloudWeb,validateCloudWebAccess} from '../bundle/onboarding-cloud-web.js';
const target=()=>({operationId:randomUUID(),installationId:randomUUID(),runtimeId:randomUUID(),manifestHash:'a'.repeat(64),root:'/owned/cloud',role:'cloud',hostVersion:'0.2.1-rc.2'});
const access=()=>({target:target(),value:{port:23456,token:'SYNTHETIC_NATIVE_TOKEN_NOT_FOR_UI',nativeNonce:randomUUID()}});
function fixture(){let remoteCalls=0,live=true,closes=0;const listeners=new Set(),a=access();const tunnel={port:23456,alive:()=>live,close:async()=>{closes++;live=false;for(const f of listeners)f();},onClose:f=>{listeners.add(f);return()=>listeners.delete(f);}};
 const deps={remote:async(action,args)=>{remoteCalls++;assert.equal(action,'web_access');assert.deepEqual(args,{});return {...a,tunnel};},enabled:()=>true};const web=createOnboardingCloudWeb(deps);return {web,deps,a,tunnel,calls:()=>remoteCalls,closes:()=>closes};}
test('cloud Web does not acquire a tunnel before explicit open, and exposes only a one-use ticket',async()=>{const f=fixture();assert(f.web.available());assert.equal(f.calls(),0);const e=await f.web.open({});assert.equal(e.state,'entry_created');assert.equal(e.target.role,'cloud');assert.equal(e.botChangesAuthorized,false);assert.equal(e.initializationComplete,false);const u=new URL(e.url);assert.equal(u.hash,'#dsh-setup-im');assert.equal(u.hostname,'127.0.0.1');assert.equal([...u.searchParams.keys()].join(),'workbench_ticket');assert(!JSON.stringify(e).includes(f.a.value.token));await f.web.close({entryId:e.entryId});assert.equal(f.closes(),1);await f.web.dispose();});
for(const mutate of [r=>({...r,url:'https://bad'}),r=>({...r,value:{...r.value,url:'http://bad'}}),r=>({...r,value:{...r.value,port:0}}),r=>({...r,value:{...r.value,port:'23456'}}),r=>({...r,value:{...r.value,token:'x\ny'}}),r=>({...r,value:{...r.value,nativeNonce:'wrong'}}),r=>({...r,target:{...r.target,role:'local'}})])test('reject unsafe Web access '+String(mutate),()=>assert.throws(()=>validateCloudWebAccess(mutate(access())),/REVIEW/));
test('no arbitrary URL, automatic refresh or caller-selected port',async()=>{const f=fixture();for(const a of [{url:'http://bad'},{refresh:true},{port:22}])await assert.rejects(f.web.open(a),/ARGUMENTS/);assert.equal(f.calls(),0);await f.web.dispose();});
test('failed remote open preserves failure and never reconnects or falls back',async()=>{let calls=0;const w=createOnboardingCloudWeb({enabled:()=>true,remote:async()=>{calls++;throw Error('ONBOARDING_CLOUD_WEB_UNSUPPORTED');}});await assert.rejects(w.open({}),/UNSUPPORTED/);assert.equal(calls,1);await w.close({entryId:randomUUID()});assert.equal(calls,1);await w.dispose();});
test('concurrent opens fail; unloading waits for the original handle and closes it',async()=>{let resolve;const f=fixture();f.deps.remote=()=>new Promise(r=>resolve=r);const w=createOnboardingCloudWeb(f.deps);const first=w.open({});await new Promise(r=>setImmediate(r));await assert.rejects(w.open({}),/BUSY/);await assert.rejects(w.close({entryId:randomUUID()}),/BUSY/);const disposed=w.dispose();resolve({...f.a,tunnel:f.tunnel});await assert.rejects(first,/CLOSED/);await disposed;assert.equal(f.closes(),1);assert(!w.available());});
test('forward exit closes the local proxy; next open requires a new explicit transport',async()=>{const f=fixture(),e=await f.web.open({});await f.tunnel.close();await assert.rejects(fetch(e.url));assert.equal(f.calls(),1);await f.web.dispose();});
test('real carrier root exchange hides native token, admits learned cookie only, and closes on request',async t=>{
 const token='SYNTHETIC_NATIVE_TOKEN',seen=[];const server=http.createServer((req,res)=>{seen.push({url:req.url,cookie:req.headers.cookie,auth:req.headers.authorization});if(req.url==='/?token='+token){res.writeHead(303,{location:'./','set-cookie':'cloud_session=owned; HttpOnly; SameSite=Strict; Path=/'});res.end();return;}if(req.headers.cookie==='cloud_session=owned'){res.writeHead(200);res.end('native');}else{res.writeHead(401);res.end();}});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});let live=true;const w=createOnboardingCloudWeb({enabled:()=>true,remote:async()=>({...access(),value:{port:server.address().port,token,nativeNonce:randomUUID()},tunnel:{port:server.address().port,alive:()=>live,onClose:()=>()=>{},close:async()=>{live=false;}}})});t.after(()=>w.dispose());const e=await w.open({}),u=new URL(e.url);let r=await fetch(u,{redirect:'manual',headers:{cookie:'daily_local=DO_NOT_FORWARD',authorization:'Bearer DO_NOT_FORWARD'}});assert.equal(r.status,303);assert.equal(r.headers.get('location'),'./');assert(!r.headers.get('location').includes(token));assert.equal(seen[0].cookie,undefined);assert.equal(seen[0].auth,undefined);assert.equal((await fetch(u,{redirect:'manual'})).status,403);assert.equal((await fetch(u.origin,{headers:{cookie:'daily_local=hidden; cloud_session=owned'}})).status,200);assert.equal(seen.at(-1).cookie,'cloud_session=owned');assert.equal((await fetch(u.origin,{headers:{origin:'https://evil.invalid'}})).status,403);await w.close({entryId:e.entryId});await assert.rejects(fetch(u.origin));
});
test('UI uses owned direct navigation and retains public native rendering, not private IM methods',async()=>{const source=await fs.readFile(new URL('../ui-source/workbench-client.js',import.meta.url),'utf8'),im=await fs.readFile(new URL('../ui-source/onboarding/im.jsx',import.meta.url),'utf8');assert(source.includes("location.hash==='#dsh-setup-im'"));assert(source.includes('setupImListeners'));assert(source.includes('cloudWebEntry'));assert(im.includes("request('cloud_web_open',{})"));assert(im.includes('原生 Web 不是只读沙箱'));assert(im.includes('referrerPolicy="no-referrer"'));assert(!im.includes('appSecret'));});
test('stale page close cannot terminate a newer Web entry',async()=>{
 let calls=0;const handles=[];const w=createOnboardingCloudWeb({enabled:()=>true,remote:async()=>{calls++;let live=true;const h={port:23456,alive:()=>live,onClose:()=>()=>{},close:async()=>{live=false;}};handles.push(h);return {...access(),tunnel:h};}});
 const a=await w.open({}),b=await w.open({});assert.notEqual(a.entryId,b.entryId);assert(!handles[0].alive());
 assert.equal((await w.close({entryId:a.entryId})).state,'already_closed');assert(handles[1].alive());assert.equal(calls,2);
 await assert.rejects(w.close({}),/ARGUMENTS/);await w.close({entryId:b.entryId});assert(!handles[1].alive());await w.dispose();
});
test('proxy close failure still closes SSH and retains the exact entry for explicit cleanup',async()=>{
 let proxyCloses=0,tunnelCloses=0,failClose=true,calls=0;const w=createOnboardingCloudWeb({enabled:()=>true,remote:async()=>{calls++;return {...access(),tunnel:{port:23456,alive:()=>true,onClose:()=>()=>{},close:async()=>{tunnelCloses++;}}};},createProxy:()=>({start:async()=>{},issue:()=> 'http://127.0.0.1:23456/?workbench_ticket=test',close:async()=>{proxyCloses++;if(failClose)throw Error('DO_NOT_ECHO');}})});
 const e=await w.open({});await assert.rejects(w.close({entryId:e.entryId}),{message:'ONBOARDING_CLOUD_WEB_CLOSE_REVIEW'});assert.equal(tunnelCloses,1);
 await assert.rejects(w.open({}),/CLOSE_REVIEW/);assert.equal(calls,1);assert.equal(tunnelCloses,2);
 failClose=false;await w.close({entryId:e.entryId});assert.equal(proxyCloses,3);await w.dispose();
});
test('failed proxy startup also releases the verified tunnel without retry',async()=>{
 let stopped=0,calls=0;const w=createOnboardingCloudWeb({enabled:()=>true,remote:async()=>{calls++;return {...access(),tunnel:{port:23456,alive:()=>true,onClose:()=>()=>{},close:async()=>{stopped++;}}};},createProxy:()=>({start:async()=>{throw Error('START_FAILED');},close:async()=>{}})});
 await assert.rejects(w.open({}),/START_FAILED/);assert.equal(stopped,1);assert.equal(calls,1);await w.dispose();
});
test('manual carrier status is local-only, redacted and cannot reopen or inspect another entry',async()=>{
 const f=fixture();f.tunnel.diagnostic=()=>({reason:'PRIVATE_STDERR',exitCode:255,signal:'SIGTERM',token:f.a.value.token,port:111,endpoint:'PRIVATE_ENDPOINT'});
 assert.equal(f.web.status({entryId:randomUUID()}).state,'not_found');assert.equal(f.calls(),0);
 const e=await f.web.open({});let s=f.web.status({entryId:e.entryId});assert.equal(s.state,'open');assert.equal(f.calls(),1);assert.equal(s.remoteHostVerified,false);assert.equal(s.botConnectionVerified,false);assert.equal(s.scope,'local_owned_carrier_only');assert.equal(s.transport.reason,null);assert(!JSON.stringify(s).includes('PRIVATE'));assert(!JSON.stringify(s).includes(f.a.value.token));
 await f.tunnel.close();await f.web.close({entryId:e.entryId});s=f.web.status({entryId:e.entryId});assert.equal(s.state,'closed');assert.equal(s.closeCause,'forward_exit');assert.equal(f.calls(),1);assert.equal(s.automaticRetry,false);await f.web.dispose();
});
test('status rejects mutations and stale entry status cannot close the current entry',async()=>{
 let calls=0;const handles=[];const web=createOnboardingCloudWeb({enabled:()=>true,remote:async()=>{calls++;let live=true;const h={port:12345,alive:()=>live,onClose:()=>()=>{},close:async()=>{live=false;}};handles.push(h);return {...access(),tunnel:h};}});
 const a=await web.open({}),b=await web.open({});assert.equal(web.status({entryId:a.entryId}).state,'closed');assert.equal(web.status({entryId:a.entryId}).closeCause,'replaced');assert(handles[1].alive());
 for(const args of [{},{entryId:b.entryId,retry:true},{entryId:'bad'}])assert.throws(()=>web.status(args),/ARGUMENTS/);assert.equal(calls,2);await web.dispose();
});
test('cleanup failure remains visible until exact-handle cleanup succeeds',async()=>{
 let fail=true;const f=fixture(),web=createOnboardingCloudWeb({...f.deps,createProxy:()=>({start:async()=>{},issue:()=> 'http://127.0.0.1:12345/?workbench_ticket=test',close:async()=>{if(fail)throw Error('PRIVATE');}})});const e=await web.open({});await assert.rejects(web.close({entryId:e.entryId}),/CLOSE_REVIEW/);assert.equal(web.status({entryId:e.entryId}).state,'cleanup_required');fail=false;await web.close({entryId:e.entryId});assert.equal(web.status({entryId:e.entryId}).state,'closed');await web.dispose();
});

test('fresh Host without Gateway counts real setup proxy streams and preserves a held ticket',async t=>{
 const gate=createOnboardingActivity();let finish,arrived,requests=0;const received=new Promise(r=>arrived=r);
 const upstream=http.createServer((req,res)=>{requests++;finish=()=>{res.writeHead(303,{location:'./','set-cookie':'native_fixture=owned; Path=/; HttpOnly'});res.end();};arrived();});await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 const web=createOnboardingCloudWeb({enabled:()=>true,admit:label=>gate.enter(label),remote:async()=>{let live=true;return {...access(),tunnel:{port:upstream.address().port,alive:()=>live,onClose:()=>()=>{},close:async()=>{live=false;}}};}});
 t.after(async()=>{await web.dispose();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));});
 const e=await web.open({}),p=gate.preview({}),pending=fetch(e.url,{redirect:'manual'});await received;assert.equal(gate.status().counts.workbench_http,1);assert.throws(()=>gate.apply({id:p.id,fingerprint:p.fingerprint,confirm:true}),/BUSY/);finish();const r=await pending;assert.equal(r.status,303);await r.arrayBuffer();
 for(let i=0;i<100&&gate.status().busy;i++)await new Promise(r=>setTimeout(r,2));assert(!gate.status().busy);
 const next=await web.open({}),plan=gate.preview({}),held=gate.apply({id:plan.id,fingerprint:plan.fingerprint,confirm:true});const denied=await fetch(next.url,{redirect:'manual'});assert.equal(denied.status,503);await denied.arrayBuffer();assert.equal(requests,1);
 gate.release({operationId:held.operationId,instanceId:held.instanceId,confirm:true});const retry=fetch(next.url,{redirect:'manual'});for(let i=0;i<100&&requests!==2;i++)await new Promise(r=>setTimeout(r,2));assert.equal(requests,2);finish();assert.equal((await retry).status,303);
});
