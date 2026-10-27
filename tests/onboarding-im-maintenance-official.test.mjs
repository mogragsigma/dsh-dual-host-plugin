// Tests the installed, unchanged upstream public RPC code. Controller is synthetic;
// this is NOT a live bot disconnect or native Host lifecycle acceptance.
import test from 'node:test';
import {registerHooks} from 'node:module';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {nativeImMaintenanceTransport} from '../bundle/onboarding-im-maintenance-native.js';
// Explicit isolated fixtures only. No personal paths or daily DSH discovery.
const vendor=process.env.DSH_TEST_IM_VENDOR;
const file=vendor ? vendor+'/@xmanrui/dsh-im/plugin-src/host/channels/feishu/rpc.mjs' : '';
const reactFile=process.env.DSH_TEST_REACT_FILE ?? '';
const installed=existsSync(file)&&existsSync(reactFile);let install;
if(installed){assert.equal(JSON.parse(readFileSync(decodeURI(vendor)+'/@xmanrui/dsh-im/package.json','utf8')).version,'5.0.3');const hook=registerHooks({resolve(specifier,context,next){return next(specifier==='react'?pathToFileURL(reactFile).href:specifier,context);}});try{({installFeishuRpc:install}=await import(pathToFileURL(file)));}finally{hook.deregister();}}
function fixture(host='localhost'){
 let connected=true,calls=[],finish=null,started=null;const status=async()=>({schemaVersion:2,revision:1,configured:true,bots:[{botId:'isolated-bot',configured:true,connected,bot:{name:'零凭据合成机器人'}}]});
 const controller={status,startRegistration(){throw Error('NOT_ALLOWED');},cancelRegistration(){throw Error('NOT_ALLOWED');},disconnect(){throw Error('LEGACY_NOT_ALLOWED');},async disconnectBot(id){assert.equal(id,'isolated-bot');calls.push('disconnect');connected=false;started?.();await finish?.();return status();},async reconnectBot(id){assert.equal(id,'isolated-bot');calls.push('reconnect');connected=true;return status();}};
 let route;const peer={},connection={browserPeer:peer,fetch:{register(r){route=r;}},createSharedFetchHandler(){return {fetch:(r,p)=>{assert.equal(p,peer);return route.fetch(r);}};}};
 install({connection},controller,undefined,'loopback');assert.equal(route.path,'/api/dsh-im/feishu');
 const transport=nativeImMaintenanceTransport(connection,new Request('http://'+host+'/api/task-onboarding/control',{method:'POST',headers:{Host:host,Origin:'http://'+host}}));
 return {transport,calls,wait:(s,f)=>{started=s;finish=f;}};
}
test('official 5.0.3 public multi-bot route is compatible with status/disconnect/reconnect adapter',{skip:installed?false:'Upstream source helper needs optional React build dependency; no vendor edit'},async()=>{
 const f=fixture();assert.equal((await f.transport.call('status'))[0].connected,true);const d=await f.transport.call('disconnect','isolated-bot');assert.equal(d[0].configured,true);assert.equal(d[0].connected,false);const r=await f.transport.call('reconnect','isolated-bot');assert.equal(r[0].connected,true);assert.equal(r[0].configHash,d[0].configHash);assert.deepEqual(f.calls,['disconnect','reconnect']);
});
test('official handler response waits for disconnect promise; observed offline alone is not completion',{skip:installed?false:'Upstream source helper needs optional React build dependency; no vendor edit'},async()=>{
 const f=fixture();let seen,release,settled=false;const started=new Promise(r=>seen=r),wait=new Promise(r=>release=r);f.wait(seen,()=>wait);const pending=f.transport.call('disconnect','isolated-bot').then(x=>{settled=true;return x;});await started;assert.equal((await f.transport.call('status'))[0].connected,false);assert.equal(settled,false);release();await pending;assert.equal(settled,true);assert.deepEqual(f.calls,['disconnect']);
});
test('official loopback restriction survives own adapter: remote authority denied without bot action',{skip:installed?false:'Upstream source helper needs optional React build dependency; no vendor edit'},async()=>{
 const f=fixture('untrusted.example');await assert.rejects(f.transport.call('disconnect','isolated-bot'),/TRANSPORT_REVIEW/);assert.deepEqual(f.calls,[]);
});
