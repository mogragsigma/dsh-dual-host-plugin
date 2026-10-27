import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID,randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {retirementProgram} from '../bundle/onboarding-cloud-retirement.js';
import {remoteControl} from '../bundle/onboarding-remote-control.js';
import {runProcess,digest} from '../bundle/onboarding-ssh.js';
const source=await fs.readFile(new URL('../bundle/onboarding-remote-control.js',import.meta.url),'utf8');
async function fixture(t){
 const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'s55-retire-')));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const file=dir+'/program.mjs';await fs.writeFile(file,retirementProgram(source));const {remoteRetirement}=await import(pathToFileURL(file));
 const installationId=randomUUID(),parent=dir+'/remote',root=parent+'/host-'+installationId;
 const baseline=JSON.parse(await runProcess(process.execPath,[fileURLToPath(new URL('../bundle/onboarding-remote-probe.js',import.meta.url))],{input:JSON.stringify({parent,installationId}),env:{PATH:process.env.PATH}}));
 const q={action:'retire',root,operationId:randomUUID(),installationId,proof:randomBytes(32).toString('hex'),planHash:digest('plan'),baseline};
 return {dir,file,q,remoteRetirement};
}
function status(q){const {baseline,...x}=q;return {...x,action:'retirement_status'};}
function prepare(q){const body=Buffer.from('{"name":"fixture"}'),f={path:'plugin/package.json',bytes:body.length,sha256:digest(body.toString()),mode:0o600};return {...q,action:'prepare',files:[{...f,data:body.toString('base64')}],manifestHash:digest([f])};}
test('atomic file barrier blocks a late original preparation and original rollback',async t=>{const f=await fixture(t),r=await f.remoteRetirement(f.q);assert.equal(r.state,'retired');assert(r.originalRequestIsolated&&!r.originalProcessTerminated);assert((await fs.lstat(f.q.root)).isFile());const before=await fs.readFile(f.q.root);await assert.rejects(remoteControl(prepare(f.q)),/UNSAFE_PATH/);const {baseline,...old}=f.q;await assert.rejects(remoteControl({...old,action:'rollback'}),/UNSAFE_PATH/);assert.deepEqual(await fs.readFile(f.q.root),before);assert(!JSON.stringify(r).includes(f.q.proof));});
test('retirement repeated is idempotent; status never deletes retained barrier',async t=>{const f=await fixture(t),a=await f.remoteRetirement(f.q),before=await fs.stat(f.q.root);const b=await f.remoteRetirement(f.q),s=await f.remoteRetirement(status(f.q));assert.equal(a.barrierHash,b.barrierHash);assert.equal(s.state,'retired');assert.equal((await fs.stat(f.q.root)).mtimeMs,before.mtimeMs);assert.deepEqual(await fs.readdir(path.dirname(f.q.root)),[path.basename(f.q.root)]);});
for(const type of ['directory','file','link'])test('never replaces an existing target '+type,async t=>{const f=await fixture(t);await fs.mkdir(path.dirname(f.q.root));if(type==='directory')await fs.mkdir(f.q.root);if(type==='file')await fs.writeFile(f.q.root,'USER_KEEP',{mode:0o600});if(type==='link'){await fs.writeFile(f.dir+'/keep','KEEP');await fs.symlink(f.dir+'/keep',f.q.root);}await assert.rejects(f.remoteRetirement(f.q),/FENCE_SOURCE_PRESENT|FENCE_REVIEW/);assert.equal((await fs.readdir(path.dirname(f.q.root))).length,1);});
test('wrong proof, altered content or permission do not permit retirement repair',async t=>{const f=await fixture(t);await f.remoteRetirement(f.q);await assert.rejects(f.remoteRetirement({...f.q,proof:'0'.repeat(64)}),/FENCE_REVIEW/);await fs.chmod(f.q.root,0o640);await assert.rejects(f.remoteRetirement(status(f.q)),/FENCE_REVIEW/);await fs.chmod(f.q.root,0o600);await fs.appendFile(f.q.root,'EDIT');await assert.rejects(f.remoteRetirement(f.q),/FENCE_REVIEW/);});
test('unsupported source controller cannot use the compatibility extension',()=>assert.throws(()=>retirementProgram(source+'\n// altered'),/RETIREMENT_UNSUPPORTED/));
test('original producer paused immediately before mkdir loses safely to the atomic barrier',async t=>{
 const f=await fixture(t),q=prepare(f.q);await fs.mkdir(path.dirname(q.root));q.baseline=JSON.parse(await runProcess(process.execPath,[fileURLToPath(new URL('../bundle/onboarding-remote-probe.js',import.meta.url))],{input:JSON.stringify({parent:path.dirname(q.root),installationId:q.installationId}),env:{PATH:process.env.PATH}}));f.q.baseline=q.baseline;
 const code=`import fs from 'node:fs/promises';import {remoteControl} from ${JSON.stringify(new URL('../bundle/onboarding-remote-control.js',import.meta.url).href)};process.once('message',async q=>{const mkdir=fs.mkdir;fs.mkdir=async(p,...args)=>{if(p===q.root){process.send('ready');await new Promise(r=>process.once('message',r));}return mkdir(p,...args);};try{await remoteControl(q);process.exit(2);}catch(e){process.send({error:e.code??e.message});process.exit(0);}});`;
 const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','ignore','ignore','ipc'],env:{PATH:process.env.PATH}});t.after(()=>{if(child.exitCode===null)child.kill();});const exit=new Promise(r=>child.on('exit',r));const ready=new Promise(r=>child.once('message',r));child.send(q);assert.equal(await ready,'ready');await f.remoteRetirement(f.q);child.send('resume');assert.equal(await exit,0);assert.equal((await f.remoteRetirement(status(f.q))).state,'retired');
});

test('producer wins the mkdir race: preserve source and clean only own unused temporary fence',async t=>{const f=await fixture(t);await fs.mkdir(path.dirname(f.q.root));f.q.baseline=JSON.parse(await runProcess(process.execPath,[fileURLToPath(new URL('../bundle/onboarding-remote-probe.js',import.meta.url))],{input:JSON.stringify({parent:path.dirname(f.q.root),installationId:f.q.installationId}),env:{PATH:process.env.PATH}}));const original=fs.link;let arrived,release;const ready=new Promise(r=>arrived=r),wait=new Promise(r=>release=r);fs.link=async(...args)=>{if(args[1]===f.q.root){arrived();await wait;}return original(...args);};const retired=f.remoteRetirement(f.q);const rejection=assert.rejects(retired,/FENCE_SOURCE_PRESENT/);try{await ready;await remoteControl(prepare(f.q));release();await rejection;assert((await fs.stat(f.q.root)).isDirectory());await assert.rejects(fs.stat(path.join(path.dirname(f.q.root),'.dsh-retire-'+f.q.operationId+'.json')),{code:'ENOENT'});}finally{fs.link=original;release();await rejection;}});
