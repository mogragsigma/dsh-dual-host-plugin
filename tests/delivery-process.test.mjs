// Private supervisor tests; no Git mutations or external services.
import test from 'node:test';import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';import {PassThrough,Writable} from 'node:stream';
import {runSupervised,validateProcessReport} from '../bundle/delivery-process.js';
const nonce='a'.repeat(64),good={schema:1,nonce,drained:true,started:true,code:0,signal:null,cause:null,stdout:Buffer.from('ok').toString('base64'),reaped:1};
test('valid report requires exact nonce, closed supervisor and child-tree drainage',()=>{
 assert.equal(validateProcessReport(JSON.stringify(good),nonce,0,null).stdout.toString(),'ok');
 for(const c of [{nonce:'b'.repeat(64)},{drained:false},{reaped:0},{cause:'unknown'},{code:null},{stdout:'garbage==='},{extra:true},{signal:'SIGKILL'}])assert.throws(()=>validateProcessReport(JSON.stringify({...good,...c}),nonce,0,null),/DELIVERY_PROCESS/);
 for(const [code,signal] of [[1,null],[null,'SIGKILL']])assert.throws(()=>validateProcessReport(JSON.stringify(good),nonce,code,signal),/DELIVERY_PROCESS/);
});
test('no child started requires explicit clean abort or spawn failure, not a forged success',()=>{
 const r={...good,started:false,code:null,reaped:0,stdout:'',cause:'SPAWN_FAILED'};assert.equal(validateProcessReport(JSON.stringify(r),nonce,0,null).drained,true);
 assert.throws(()=>validateProcessReport(JSON.stringify({...r,cause:null}),nonce,0,null),/REPORT_INVALID/);
});
function fake(report=true){
 let child,request;const io={platform:'linux',spawn:()=>{
  child=new EventEmitter();child.pid=123;child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>true;
  child.stdin=new Writable({write(c,_e,cb){request=JSON.parse(c);cb();queueMicrotask(()=>{
   if(report)child.stdout.write(JSON.stringify({...good,nonce:request.nonce}));child.emit('close',0,null);
  });}});return child;
 }};return {io,get:()=>({child,request})};
}
test('client closes operation only after valid descendant report and supervisor close',async()=>{
 const f=fake(),events=[];const r=await runSupervised(['/usr/bin/git','--version'],{cwd:'/tmp',env:{PATH:'/usr/bin:/bin'},onSpawn:()=>events.push('spawn'),onDrained:()=>events.push('drain')},f.io);
 assert.equal(r.drained,true);assert.deepEqual(events,['spawn','drain']);assert.equal(f.get().request.parent_pid,process.pid);
});
test('mere supervisor exit without final proof leaves operation unclosed',async()=>{
 const f=fake(false);let closed=false;await assert.rejects(runSupervised(['/usr/bin/git','--version'],{cwd:'/tmp',env:{},onDrained:()=>closed=true},f.io),/DRAIN_UNKNOWN/);assert.equal(closed,false);
});
test('non-Linux execution and pre-aborted requests start no process',async()=>{
 let spawned=0;await assert.rejects(runSupervised([],{}, {platform:'darwin',spawn:()=>spawned++}),/PLATFORM_UNSUPPORTED/);
 const c=new AbortController();c.abort();await assert.rejects(runSupervised([],{signal:c.signal},{platform:'linux',spawn:()=>spawned++}),e=>e.drained===true);assert.equal(spawned,0);
});
const linux=process.platform==='linux';
test('actual Linux supervisor executes readonly Git version and proves ECHILD', {skip:!linux},async()=>{
 const r=await runSupervised(['/usr/bin/git','--version'],{cwd:'/tmp',env:{PATH:'/usr/bin:/bin'},timeout:2});assert(r.stdout.toString().startsWith('git version '));assert.equal(r.code,0);assert.equal(r.drained,true);assert.equal(r.cause,null);
});
test('actual Linux supervisor reaps orphaned setsid grandchild before reporting drain', {skip:!linux},async()=>{
 const code="import os,time; p=os.fork();\nif p==0:\n os.setsid(); os.close(1); os.close(2); time.sleep(20)\nelse:\n os._exit(0)";
 const started=Date.now(),r=await runSupervised(['/usr/bin/python3','-I','-c',code],{cwd:'/tmp',env:{PATH:'/usr/bin:/bin'},timeout:2});
 assert.equal(r.drained,true);assert.equal(r.cause,'ORPHANED_DESCENDANT');assert(r.reaped>=2);assert(Date.now()-started<5000);
});
test('actual Linux timeout kills and reaps descendants, never claims a successful command', {skip:!linux},async()=>{
 const r=await runSupervised(['/usr/bin/python3','-I','-c','import time; time.sleep(20)'],{cwd:'/tmp',env:{PATH:'/usr/bin:/bin'},timeout:0.15});assert.equal(r.drained,true);assert.equal(r.cause,'TIMEOUT');assert.equal(r.signal,'SIGKILL');
});
test('actual Linux output limit drains without exposing excess output', {skip:!linux},async()=>{
 const r=await runSupervised(['/usr/bin/python3','-I','-c','import os,time; os.write(1,b"x"*10000);time.sleep(20)'],{cwd:'/tmp',env:{PATH:'/usr/bin:/bin'},timeout:2,limit:64});assert.equal(r.drained,true);assert.equal(r.cause,'OUTPUT_LIMIT');assert(r.stdout.length<=64);
});
test('actual Linux cancellation waits for descendant drain', {skip:!linux},async()=>{
 const c=new AbortController();let timer;const r=await runSupervised(['/usr/bin/python3','-I','-c','import time;time.sleep(20)'],{cwd:'/tmp',env:{PATH:'/usr/bin:/bin'},signal:c.signal,onSpawn:()=>timer=setTimeout(()=>c.abort(),150)});clearTimeout(timer);assert.equal(r.drained,true);assert.equal(r.cause,'ABORTED');
});

test('client carries a previously journaled receipt nonce into the private supervisor request',async()=>{
 const f=fake(),receipt={nonce:'b'.repeat(64),binding_hash:'c'.repeat(64)},events=[];
 const r=await runSupervised(['/usr/bin/git','--version'],{cwd:'/tmp',env:{},receipt,onSpawn:()=>events.push('persisted'),onDrained:()=>events.push('drained')},f.io);
 assert.equal(r.nonce,receipt.nonce);assert.deepEqual(f.get().request.receipt,receipt);assert.deepEqual(events,['persisted','drained']);
});
