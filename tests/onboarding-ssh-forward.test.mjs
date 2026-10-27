import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {startForwardProcess,forwardStderrCategory} from '../bundle/onboarding-ssh-forward.js';
import {createSSH,identity} from '../bundle/onboarding-ssh.js';
test('a live child readiness marker is required, close owns only that child, no automatic retry',async()=>{let clean=0;const h=await startForwardProcess(process.execPath,['-e','process.stdout.write("DSH_ONBOARDING_FORWARD_READY\\n");process.stdin.resume()'],{env:{},port:12345,cleanup:async()=>clean++});assert(h.alive());let closed=0;h.onClose(()=>closed++);await h.close();assert(!h.alive());assert.equal(clean,1);assert.equal(closed,1);await h.close();assert.equal(clean,1);});
for(const [code,expected] of [['console.error("PRIVATE_STDERR");process.exit(1)','FORWARD_FAILED'],['process.stdout.write("WRONG_MARKER");process.stdin.resume()','FORWARD_RESPONSE'],['process.stdout.write("x".repeat(17000));process.stdin.resume()','RESPONSE_LIMIT'],['process.stdin.resume()','TIMEOUT']])test('forward process failure is bounded and redacted '+expected,async()=>{let clean=0;await assert.rejects(startForwardProcess(process.execPath,['-e',code],{env:{},port:12345,cleanup:async()=>clean++,timeout:expected==='TIMEOUT'?250:5000}),e=>e.message==='ONBOARDING_SSH_'+expected);assert.equal(clean,1);});
test('SSH forwarding pins host identity, excludes daily config and binds only loopback', {skip:process.platform==='win32'},async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'s56-forward-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.writeFile(root+'/identity','FAKE_UNIT_IDENTITY_'.repeat(3),{mode:0o600});
 const script='#!'+process.execPath+'\n'+`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(root+'/args.json')},JSON.stringify(process.argv.slice(2)));process.stdout.write('DSH_ONBOARDING_FORWARD_READY\\n');process.stdin.resume();`;
 await fs.writeFile(root+'/ssh',script,{mode:0o700});const runtime={home:root,env:{PATH:root},platform:process.platform,localState:root+'/state'},c={host:'test.invalid',user:'testuser',port:22,auth:'file',identityPath:root+'/identity'},b={connection:c,identity:await identity(c,runtime),keys:[{type:'ssh-ed25519',key:'FAKE_TEST_PUBLIC_KEY'}]};const ssh=createSSH(runtime);const h=await ssh.forward(b,29999);const args=JSON.parse(await fs.readFile(root+'/args.json'));assert(args.includes('ExitOnForwardFailure=yes'));assert(args.includes('StrictHostKeyChecking=yes'));assert(args.includes('IdentityAgent=none'));assert(args.includes('ForwardAgent=no'));assert(args.includes('/dev/null'));assert(args.includes('127.0.0.1:'+h.port+':127.0.0.1:29999'));assert(args.includes("printf 'DSH_ONBOARDING_FORWARD_READY\\n'; cat >/dev/null"));assert(args.includes('testuser@test.invalid'));const known=args.find(x=>x.startsWith('UserKnownHostsFile=')).split('=')[1];assert.equal((await fs.stat(known)).mode&0o777,0o600);await h.close();await assert.rejects(fs.stat(known));assert.equal((await fs.readdir(root+'/state')).length,0);await fs.appendFile(root+'/identity','CHANGED');await assert.rejects(ssh.forward(b,29999),/SSH_IDENTITY_CHANGED/);for(const p of [0,65536,'22',NaN])await assert.rejects(ssh.forward(b,p),/SSH_ARGUMENTS/);
});
test('cleanup failure is not reported as a successful close; exact handle can retry cleanup',async()=>{
 let fail=true,attempts=0;const h=await startForwardProcess(process.execPath,['-e','process.stdout.write("DSH_ONBOARDING_FORWARD_READY\\n");process.stdin.resume()'],{env:{},port:12345,cleanup:async()=>{attempts++;if(fail)throw Error('PRIVATE_PATH');}});
 await assert.rejects(h.close(),{message:'ONBOARDING_SSH_CLEANUP_REVIEW'});assert(!h.alive());assert.equal(attempts,1);fail=false;await h.close();assert.equal(attempts,2);
});
test('unexpected live forward exit retains bounded redacted diagnostics without retry',async()=>{
 let clean=0;const h=await startForwardProcess(process.execPath,['-e','process.stdout.write("DSH_ONBOARDING_FORWARD_READY\\n",()=>setTimeout(()=>{console.error("PRIVATE_STDERR_TOKEN");process.exit(19)},80))'],{env:{},port:12345,cleanup:async()=>clean++});
 assert.equal(h.diagnostic().state,'ready');await new Promise(resolve=>h.onClose(resolve));
 const d=h.diagnostic();assert.equal(d.state,'closed');assert.equal(d.reason,'PROCESS_EXIT');assert.equal(d.exitCode,19);assert(d.closedAt>=d.readyAt);assert(!JSON.stringify(d).includes('PRIVATE'));assert.equal(clean,1);await h.close();assert.equal(clean,1);assert.equal(h.diagnostic().reason,'PROCESS_EXIT');
});
test('manual forward close is distinguished from an unexplained process exit',async()=>{
 const h=await startForwardProcess(process.execPath,['-e','process.stdout.write("DSH_ONBOARDING_FORWARD_READY\\n");process.stdin.resume()'],{env:{},port:12345,cleanup:async()=>{}});await h.close();assert.equal(h.diagnostic().reason,'CLOSE_REQUESTED');assert.equal(h.diagnostic().state,'closed');
});
test('SSH diagnostic categories are fixed, bounded and never echo source text',()=>{
 const samples={HOSTKEY_REJECTED:'Host key verification failed.',AUTH_REJECTED:'Permission denied (publickey).',KEEPALIVE_TIMEOUT:'Timeout, server PRIVATE_HOST not responding.',CONNECT_TIMEOUT:'connect to host PRIVATE_HOST port 22: Operation timed out',FORWARD_BIND_FAILED:'bind [127.0.0.1]:12345: Address already in use',CONNECTION_REFUSED:'connect to host PRIVATE_HOST port 22: Connection refused',NETWORK_RESET:'client_loop: send disconnect: Broken pipe',REMOTE_CLOSED:'Connection to PRIVATE_HOST closed by remote host.',UNCLASSIFIED:'PRIVATE_STDERR_SECRET'};
 for(const [expected,text] of Object.entries(samples))assert.equal(forwardStderrCategory(text),expected);assert.equal(forwardStderrCategory(''),null);
});
test('split stderr is classified after readiness and retained without the raw text on exit',async()=>{
 const script='process.stdout.write("DSH_ONBOARDING_FORWARD_READY\\n");setTimeout(()=>{process.stderr.write("Timeout, server PRIVATE_HOST ");setTimeout(()=>{process.stderr.write("not responding.\\n");process.exit(255)},30)},50)';
 const h=await startForwardProcess(process.execPath,['-e',script],{env:{},port:12345,cleanup:async()=>{}});await new Promise(resolve=>h.onClose(resolve));const d=h.diagnostic();assert.equal(d.stderrCategory,'KEEPALIVE_TIMEOUT');assert.equal(d.reason,'PROCESS_EXIT');assert.equal(d.exitCode,255);assert(!JSON.stringify(d).includes('PRIVATE_HOST'));await h.close();
});
