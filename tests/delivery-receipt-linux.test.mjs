import test from 'node:test';import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';import {once} from 'node:events';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';import {fileURLToPath} from 'node:url';
import {fixture} from './delivery-receipt-fixture.mjs';
import {runSupervised} from '../bundle/delivery-process.js';
const linux=process.platform==='linux',pause=ms=>new Promise(r=>setTimeout(r,ms));
test('real Linux supervisor fsyncs a private redacted terminal receipt before pipe acknowledgement',{skip:!linux},async t=>{
 const f=await fixture(t,{real:true});
 const result=await runSupervised(['/usr/bin/python3','-I','-c','print("synthetic-secret-output")'],{cwd:f.dir,env:{PATH:'/usr/bin:/bin',SYNTHETIC_SECRET:'must-not-persist'},receipt:f.binding,onSpawn:({pid})=>f.j.spawned(f.op,pid)});
 assert.equal(result.drained,true);assert.equal(result.stdout.toString().trim(),'synthetic-secret-output');f.j.recover();
 const p=f.receipts.inspect(f.op);assert.equal(p.state,'terminal_verified');assert.equal(p.reaped,1);assert(!readFileSync(f.file,'utf8').includes('synthetic-secret-output'));assert(!readFileSync(f.file,'utf8').includes('must-not-persist'));
 f.receipts.reconcile(f.op,p.fingerprint);assert.equal(f.j.operation(f.op).state,'closed');assert.equal(f.store.task(f.task.id).busy,1);
});
test('real Linux fsync report is never overwritten and a failed seal cannot close the live operation',{skip:!linux},async t=>{
 const f=await fixture(t,{real:true});writeFileSync(f.file,'preexisting-evidence',{mode:0o600});let closed=false;
 await assert.rejects(runSupervised(['/usr/bin/python3','-I','-c','pass'],{cwd:f.dir,env:{PATH:'/usr/bin:/bin'},receipt:f.binding,onSpawn:({pid})=>f.j.spawned(f.op,pid),onDrained:()=>closed=true}),/DRAIN_UNKNOWN/);
 assert.equal(readFileSync(f.file,'utf8'),'preexisting-evidence');assert.equal(closed,false);assert.equal(f.j.unfinished(f.a.id),true);
});
test('real Linux rejects an altered bound directory before launching a managed command',{skip:!linux},async t=>{
 const f=await fixture(t,{real:true}),marker=f.dir+'/must-not-exist';
 await assert.rejects(runSupervised(['/usr/bin/python3','-I','-c','open('+JSON.stringify(marker)+',"w").write("bad")'],{cwd:f.dir,env:{PATH:'/usr/bin:/bin'},receipt:{...f.binding,directory:{...f.binding.directory,inode:'0'}},onSpawn:({pid})=>f.j.spawned(f.op,pid)}),/DRAIN_UNKNOWN/);
 assert.equal(existsSync(marker),false);assert.equal(existsSync(f.file),false);
});
test('actual Node client SIGKILL loses stdout but supervisor reaps descendants and a new Node process recovers receipt',{skip:!linux,timeout:20000},async t=>{
 const f=await fixture(t,{real:true}),script=fileURLToPath(new URL('./delivery-receipt-crash-child.mjs',import.meta.url)),ready=f.dir+'/child-ready';
 const child=spawn(process.execPath,[script,'run',f.dir,f.op,ready],{env:{PATH:'/usr/bin:/bin'},stdio:['ignore','pipe','pipe']});
 child.stdout.resume();child.stderr.resume();const exit=once(child,'exit');let exited=false;exit.then(()=>exited=true);t.after(()=>{if(!exited)child.kill('SIGTERM');});
 const deadline=Date.now()+8000;while(!existsSync(ready)&&!exited&&Date.now()<deadline)await pause(20);
 assert(existsSync(ready),'managed descendants must actually start before client crash');child.kill('SIGKILL');const [,signal]=await exit;assert.equal(signal,'SIGKILL');
 let proof;while(Date.now()<deadline){try{proof=f.receipts.inspect(f.op);if(proof.state==='terminal_verified')break;}catch{}await pause(20);}
 assert.equal(proof?.state,'terminal_verified');assert(proof.reaped>=2);assert.equal(f.j.operation(f.op).state,'spawned');
 const recovered=spawnSync(process.execPath,[script,'recover',f.dir,f.op],{env:{PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:10000});
 assert.equal(recovered.status,0,recovered.stderr);const out=JSON.parse(recovered.stdout);assert.equal(out.operation_state,'closed');assert.equal(out.action_state,'needs_review');assert.equal(out.busy,1);assert.equal(out.result.retry_authorized,false);
 assert.equal(out.proof.receipt_sha256,proof.receipt_sha256);assert(!readFileSync(f.file,'utf8').includes('synthetic-output-not-persisted'));
});
