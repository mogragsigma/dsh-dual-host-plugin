import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {nativeEnvironment,watchChild,nativeImRows,validateNativeOverlay,validateNativePluginIdentity} from '../bundle/onboarding-native-host.js';
test('native environment has independent roots and inherits no credentials or proxies',()=>{
 const root='/root/dsh-plugin-test-s55/host-'+randomUUID(),e=nativeEnvironment(root,'/usr/local/bin/node');
 for(const key of ['HOME','DSH_HOME','DSH_AGENTS_HOME','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','TMPDIR'])assert(e[key].startsWith(root+'/runtime/'));
 assert.equal(e.DSH_ONBOARDING_ISOLATED_ROOT,root+'/runtime');
 assert(!Object.keys(e).some(k=>/TOKEN|KEY|SECRET|PROXY|SSH|NPM/.test(k)));
});
test('spawn failure observes both promises before the first await rejects',async()=>{
 const child=new EventEmitter(),events=watchChild(child),unhandled=[],listener=e=>unhandled.push(e);process.on('unhandledRejection',listener);
 try{child.emit('error',Error('spawn failed'));await assert.rejects(events.spawned,/spawn failed/);await new Promise(r=>setImmediate(r));await assert.rejects(events.ended,/spawn failed/);assert.equal(unhandled.length,0);}finally{process.off('unhandledRejection',listener);}
});
test('native child watcher preserves exit and signal separately',async()=>{
 const child=new EventEmitter(),e=watchChild(child);child.emit('spawn');await e.spawned;child.emit('exit',null,'SIGTERM');assert.deepEqual(await e.ended,{code:null,signal:'SIGTERM'});
});
test('native runner refuses stale parent identity before importing the Host',{skip:process.platform!=='linux'},async t=>{
 const parent=await fs.mkdtemp(path.join(os.tmpdir(),'s55-native-')),root=path.join(parent,'host-'+randomUUID());t.after(()=>fs.rm(parent,{recursive:true,force:true}));await fs.mkdir(root+'/.control/runtime',{recursive:true});
 const nonce=randomUUID();await fs.writeFile(root+'/.control/runtime/native-launch.json',JSON.stringify({nonce,process:{pid:1,start:'0',boot:randomUUID()}}));
 const child=spawn(process.execPath,[fileURLToPath(new URL('../bundle/onboarding-native-runner.js',import.meta.url)),root],{stdio:['pipe','ignore','pipe'],env:{PATH:process.env.PATH}}),e=watchChild(child);let error='';child.stderr.on('data',b=>error+=b);await e.spawned;child.stdin.end(JSON.stringify({nonce}));assert.notEqual((await e.ended).code,0);assert.match(error,/NATIVE_RUNNER_IDENTITY/);await assert.rejects(fs.stat(root+'/runtime'),{code:'ENOENT'});
});
test('authorized launcher explicitly invokes exported CLI and uses a separate overlay',{skip:process.platform!=='linux'},async t=>{
 const parent=await fs.mkdtemp(path.join(os.tmpdir(),'s55-native-')),root=path.join(parent,'host-'+randomUUID());t.after(()=>fs.rm(parent,{recursive:true,force:true}));await fs.mkdir(root+'/.control/runtime',{recursive:true});await fs.mkdir(root+'/runtime/node_modules/@deepseek-ai/dsh/lib',{recursive:true});
 const marker=root+'/invoked.json';await fs.writeFile(root+'/runtime/node_modules/@deepseek-ai/dsh/package.json','{"type":"module"}');await fs.writeFile(root+'/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js',`import fs from 'node:fs/promises';export async function runCli(){await fs.writeFile(${JSON.stringify(marker)},JSON.stringify(process.argv.slice(2)));}`);
 const child=spawn(process.execPath,[fileURLToPath(new URL('../bundle/onboarding-native-runner.js',import.meta.url)),root],{stdio:['pipe','ignore','pipe'],env:{PATH:process.env.PATH}}),e=watchChild(child);child.stderr.resume();await e.spawned;
 const stat=await fs.readFile('/proc/'+child.pid+'/stat','utf8'),nonce=randomUUID(),member={pid:child.pid,start:stat.slice(stat.lastIndexOf(')')+2).split(' ')[19],boot:(await fs.readFile('/proc/sys/kernel/random/boot_id','utf8')).trim()};
 await fs.writeFile(root+'/.control/runtime/native-launch.json',JSON.stringify({nonce,process:member}));await assert.rejects(fs.stat(marker),{code:'ENOENT'});child.stdin.end(JSON.stringify({nonce}));assert.equal((await e.ended).code,0);
 assert.deepEqual(JSON.parse(await fs.readFile(marker)),['--profile','web','--patch',root+'/runtime/native-overlay.yml','--host','127.0.0.1','--port','0','--no-open']);
});

import {nativeRunPaths} from '../bundle/onboarding-native-runner.js';
test('restart runner uses per-launch overlay and rejects path injection',()=>{const id=randomUUID(),p=nativeRunPaths('/root/host-'+randomUUID(),id);assert(p.overlay.endsWith('/restarts/'+id+'/native-overlay.yml'));for(const v of ['../x','/tmp/x','a/b',''])assert.throws(()=>nativeRunPaths('/root/host',v),/SCOPE/);});

test('native optional IM overlay uses a fixed official package with empty isolated configuration',()=>{
 const env=nativeEnvironment('/owned','/usr/bin/node'),base=[{id:'spill-local',config:{root:env.TMPDIR+'/spill'}},{insert:[{id:'dual-host-onboarding'},{id:'dual-host-admission',config:{}}]}];
 assert.deepEqual(nativeImRows(false),[]);validateNativeOverlay(base,env,false);
 assert.throws(()=>validateNativeOverlay(base,env,true),/OVERLAY_REVIEW/);
 base[1].insert[1].config.expectedIm=true;base[1].insert.push(...nativeImRows(true));validateNativeOverlay(base,env,true);
 assert.throws(()=>validateNativeOverlay(base,env,false),/OVERLAY_REVIEW/);
 base[1].insert[2].config={appSecret:'never import daily credentials'};assert.throws(()=>validateNativeOverlay(base,env,true),/OVERLAY_REVIEW/);
});
import {validateNativeRestartConsent} from '../bundle/onboarding-native-runner.js';
import {restartNativeHost} from '../bundle/onboarding-native-host.js';
test('native restart guard requires a matching durable restart acknowledgement, initial launch stays separate',()=>{
 const id=randomUUID(),grant={contract:1,restartId:id,fingerprint:'a'.repeat(64),acknowledged:true};assert.doesNotThrow(()=>validateNativeRestartConsent(undefined,{}));assert.doesNotThrow(()=>validateNativeRestartConsent(id,{resumeAuthorization:grant}));
 for(const row of [undefined,{}, {...grant,acknowledged:false},{...grant,restartId:randomUUID()},{...grant,fingerprint:'invalid'},{...grant,contract:0}])assert.throws(()=>validateNativeRestartConsent(id,{resumeAuthorization:row}),/NATIVE_RUNNER_RESTART_CONSENT/);
});
test('native host restart refuses absent caller or journal consent before creating any files',async()=>{
 for(const [q,j] of [[{},{}],[{acknowledgeNativeResume:true},{restart:{nativeResumeAcknowledged:false,consentContract:1}}],[{}, {restart:{nativeResumeAcknowledged:true,consentContract:1}}]])await assert.rejects(restartNativeHost(q,j,{}),/RESTART_CONSENT_REQUIRED/);
});
for(const authorized of [false,true])test(`real Linux runner checks restart consent before importing CLI; authorized=${authorized}`,{skip:process.platform!=='linux'},async t=>{
 const parent=await fs.mkdtemp(path.join(os.tmpdir(),'s58-restart-runner-')),root=path.join(parent,'host-'+randomUUID()),id=randomUUID(),control=root+'/.control/runtime/restarts/'+id,marker=root+'/invoked.json';t.after(()=>fs.rm(parent,{recursive:true,force:true}));await fs.mkdir(control,{recursive:true});await fs.mkdir(root+'/runtime/node_modules/@deepseek-ai/dsh/lib',{recursive:true});
 await fs.writeFile(root+'/runtime/node_modules/@deepseek-ai/dsh/package.json','{"type":"module"}');await fs.writeFile(root+'/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js',`import fs from 'node:fs/promises';export async function runCli(){await fs.writeFile(${JSON.stringify(marker)},JSON.stringify(process.argv));}`);
 const child=spawn(process.execPath,[fileURLToPath(new URL('../bundle/onboarding-native-runner.js',import.meta.url)),root,id],{stdio:['pipe','ignore','pipe'],env:{PATH:process.env.PATH}}),e=watchChild(child);let err='';child.stderr.on('data',b=>err+=b);await e.spawned;
 const raw=await fs.readFile('/proc/'+child.pid+'/stat','utf8'),member={pid:child.pid,platform:'linux',start:raw.slice(raw.lastIndexOf(')')+2).split(' ')[19],boot:(await fs.readFile('/proc/sys/kernel/random/boot_id','utf8')).trim()},nonce=randomUUID();await fs.writeFile(control+'/native-launch.json',JSON.stringify({nonce,process:member,...(authorized?{resumeAuthorization:{contract:1,restartId:id,fingerprint:'a'.repeat(64),acknowledged:true}}:{})}));child.stdin.end(JSON.stringify({nonce}));const result=await e.ended;
 if(authorized){assert.equal(result.code,0);assert((await fs.readFile(marker,'utf8')).includes(control+'/native-overlay.yml'));}else{assert.notEqual(result.code,0);assert.match(err,/NATIVE_RUNNER_RESTART_CONSENT/);await assert.rejects(fs.stat(marker),{code:'ENOENT'});}
});

test('native admission requires the version loaded by the new process, not a package label alone',()=>{validateNativePluginIdentity({pluginVersion:'1.0.1'},'1.0.1');for(const r of [{},{pluginVersion:'1.0.0'},{pluginVersion:null}])assert.throws(()=>validateNativePluginIdentity(r,'1.0.1'),/PLUGIN_IDENTITY_MISMATCH/);assert.throws(()=>validateNativePluginIdentity({},undefined),/PLUGIN_IDENTITY_MISMATCH/);});
