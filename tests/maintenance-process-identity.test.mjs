import test from 'node:test';
import assert from 'node:assert/strict';
import {createMaintenanceProcessIdentity,validMaintenanceProcess,createDarwinProcessReader} from '../bundle/maintenance-process-identity.js';
const bootA='11111111-1111-1111-1111-111111111111',bootB='22222222-2222-2222-2222-222222222222',machineId='a'.repeat(32);
const stat=(pid,start,state='S')=>{const f=Array(20).fill('0');f[0]=state;f[19]=start;return `${pid} (command with ) spaces) ${f.join(' ')}`;};
function linux(){
 let boot=bootA,id=machineId,ns='pid:[123]',denied=false,reads=0;const processes=new Map([[17,stat(17,'100')],[22,stat(22,'200')]]);
 const io={async readFile(p){reads++;if(denied)throw Object.assign(Error('DO_NOT_LOG'),{code:'EACCES'});if(p==='/etc/machine-id')return id;if(p==='/proc/sys/kernel/random/boot_id')return boot;const n=Number(/^\/proc\/(\d+)\/stat$/.exec(p)?.[1]);if(processes.has(n))return processes.get(n);throw Object.assign(Error('missing'),{code:'ENOENT'});},async readlink(p){assert.equal(p,'/proc/self/ns/pid');return ns;},async execFile(){throw Error('SHELL_NOT_EXPECTED');}};
 const at=pid=>createMaintenanceProcessIdentity({platform:'linux',pid,io:{...io,readlink:p=>p==='/proc/self'?Promise.resolve(String(pid)):io.readlink(p)},now:()=>1000});return {at,processes,boot:v=>{boot=v;},machine:v=>{id=v;},namespace:v=>{ns=v;},deny:()=>{denied=true;},reads:()=>reads};
}
test('Linux records only hashed host identity and exact birth metadata; existing owner remains alive',async()=>{
 const f=linux(),old=await f.at(17).capture();assert(validMaintenanceProcess(old));assert(!JSON.stringify(old).includes(machineId));assert.equal(old.start,'100');assert.equal((await f.at(22).observe(old)).state,'alive');
});
test('Linux absent, reused PID and zombie are distinct terminal evidence, with no signals',async()=>{
 const f=linux(),old=await f.at(17).capture();f.processes.delete(17);assert.equal((await f.at(22).observe(old)).reason,'absent');f.processes.set(17,stat(17,'300'));assert.equal((await f.at(22).observe(old)).reason,'pid_reused');f.processes.set(17,stat(17,'100','Z'));const p=await f.at(22).observe(old);assert.equal(p.state,'exited');assert.equal(p.reason,'terminal');
});
test('same-host new boot proves old process ended; another host never does',async()=>{
 const f=linux(),old=await f.at(17).capture();f.boot(bootB);assert.equal((await f.at(22).observe(old)).reason,'boot_changed');f.machine('b'.repeat(32));const p=await f.at(22).observe(old);assert.equal(p.state,'unknown');assert.equal(p.reason,'host_changed');
});
test('Linux PID namespace change is not an exit proof within the same boot',async()=>{
 const f=linux(),old=await f.at(17).capture();f.namespace('pid:[456]');f.processes.delete(17);const p=await f.at(22).observe(old);assert.equal(p.state,'unknown');assert.equal(p.reason,'namespace_changed');
});
test('permission failure or malformed process metadata stays unknown and does not echo diagnostics',async()=>{
 const f=linux(),old=await f.at(17).capture();f.deny();const p=await f.at(22).observe(old);assert.equal(p.state,'unknown');assert(!JSON.stringify(p).includes('DO_NOT_LOG'));const g=linux();g.processes.set(17,'truncated');assert.equal(await g.at(17).capture(),null);
});
test('malformed persisted identities cannot drive OS queries or arbitrary process arguments',async()=>{
 const f=linux();for(const bad of [null,{}, {platform:'linux',pid:'17;touch /tmp/bad'}, {platform:'linux',pid:-1}])assert.equal((await f.at(22).observe(bad)).reason,'identity_missing');assert.equal(f.reads(),0);
});
function darwin(){
 let mode='alive',start='bsd:1792800001:000001';const rawId='abcdefab-cdef-abcd-efab-cdefabcdefab',calls=[];
 const io={async execFile(file,args,options){calls.push({file,args,options});assert.equal(options.env.LC_ALL,'C');assert.equal(options.env.TZ,'UTC');assert(!options.env.SECRET);
 if(file==='/usr/sbin/ioreg')return {stdout:`"IOPlatformUUID" = "${rawId}"`};assert.equal(file,'/usr/sbin/sysctl');assert.deepEqual(args,['-n','kern.bootsessionuuid']);return {stdout:bootA};},async darwinProcess(target){
 assert([17,22].includes(target));if(target===17&&mode==='absent')return {present:false,start:null};if(target===17&&mode==='denied')throw Error('DO_NOT_LOG');return {present:true,terminal:target===17&&mode==='terminal',start:target===17?start:'bsd:1792800002:000002'};}};
 return {at:pid=>createMaintenanceProcessIdentity({platform:'darwin',pid,env:{SECRET:'NO'},io,now:()=>1000}),mode:v=>{mode=v;},start:v=>{start=v;},calls,rawId};
}
test('Mac records microsecond birth and hashed machine identity without spawning setuid ps',async()=>{
 const f=darwin(),old=await f.at(17).capture();assert(validMaintenanceProcess(old));assert(!JSON.stringify(old).includes(f.rawId));assert.equal((await f.at(22).observe(old)).state,'alive');f.start('bsd:1792800001:000002');assert.equal((await f.at(22).observe(old)).reason,'pid_reused');assert(f.calls.every(x=>x.file!=='/bin/ps'));
});
test('Mac absent or zombie prove exit, denied/malformed metadata stay unknown',async()=>{
 const f=darwin(),old=await f.at(17).capture();f.mode('absent');assert.equal((await f.at(22).observe(old)).reason,'absent');f.mode('terminal');assert.equal((await f.at(22).observe(old)).reason,'terminal');f.mode('denied');const p=await f.at(22).observe(old);assert.equal(p.state,'unknown');assert(!JSON.stringify(p).includes('DO_NOT_LOG'));f.mode('alive');f.start('bsd:1792800001:1000000');assert.equal((await f.at(22).observe(old)).state,'unknown');
});
test('Mac legacy second-resolution birth is not compared to a different birth format as PID reuse',async()=>{
 const f=darwin(),old={...await f.at(17).capture(),start:'Sat Oct 24 00:00:01 2026'};assert(validMaintenanceProcess(old));const p=await f.at(22).observe(old);assert.equal(p.state,'unknown');assert.equal(p.reason,'identity_format_changed');f.mode('absent');assert.equal((await f.at(22).observe(old)).reason,'absent');
});
function fakeKoffi({size=136,error=0,pid=17,state=2,sec=1792800001n,usec=1n}={}){
 let errno=0,buffer,called=0;const koffi={errno(value){if(arguments.length)errno=value;return errno;},load(file){assert.equal(file,'/usr/lib/libproc.dylib');return {func(signature){assert.equal(signature,'int proc_pidinfo(int pid, int flavor, uint64_t arg, _Out_ void *buffer, int buffersize)');return (target,flavor,arg,b,length)=>{called++;assert.equal(target,17);assert.equal(flavor,3);assert.equal(arg,0);assert.equal(length,136);assert.equal(errno,0);buffer=b;b.writeUInt32LE(state,4);b.writeUInt32LE(pid,12);b.write('DO_NOT_PERSIST_PROCESS_NAME',48);b.writeBigUInt64LE(sec,120);b.writeBigUInt64LE(usec,128);errno=error;return size;};}};}};return {koffi,buffer:()=>buffer,called:()=>called};
}
test('Mac public libproc fixed ABI reads only the selected PID and wipes temporary metadata',()=>{
 const f=fakeKoffi(),read=createDarwinProcessReader(f.koffi,'arm64');assert.deepEqual(read(17),{present:true,terminal:false,start:'bsd:1792800001:000001'});assert(f.buffer().every(x=>x===0));const z=fakeKoffi({state:5});assert.equal(createDarwinProcessReader(z.koffi,'x64')(17).terminal,true);assert(z.buffer().every(x=>x===0));
});
test('Mac libproc ESRCH is the only absent result; permission, partial, wrong PID and invalid birth fail closed',()=>{
 const f=fakeKoffi({size:0,error:3});assert.deepEqual(createDarwinProcessReader(f.koffi,'arm64')(17),{present:false,start:null});assert(f.buffer().every(x=>x===0));
 for(const options of [{size:0,error:1},{size:0,error:13},{size:0,error:0},{size:128},{size:-1,error:3},{pid:18},{state:0},{state:6},{sec:0n},{usec:1000000n}]){
  const g=fakeKoffi(options);assert.throws(()=>createDarwinProcessReader(g.koffi,'arm64')(17),/UNAVAILABLE/);assert(g.buffer().every(x=>x===0));
 }
});
test('Mac unsupported ABI and invalid PID cannot reach native query',()=>{
 const f=fakeKoffi();assert.throws(()=>createDarwinProcessReader(f.koffi,'ppc'),/UNSUPPORTED/);const read=createDarwinProcessReader(f.koffi,'arm64');for(const p of [0,-1,2147483648,'17'])assert.throws(()=>read(p),/INVALID_PID/);assert.equal(f.called(),0);
});
test('Windows CIM adapter is command-bounded, profile-free and handles absent/reused process using creation ticks',async()=>{
 let absent=false,reused=false;const rawId='abcdefab-cdef-abcd-efab-cdefabcdefab',io={async execFile(file,args,options){assert(file.endsWith('WindowsPowerShell\\v1.0\\powershell.exe'));assert(args.includes('-NoProfile')&&args.includes('-NonInteractive'));assert(!args.includes('-ExecutionPolicy'));assert(!options.env.SECRET);const command=args.at(-1);assert(command.includes("HKLM:\\SOFTWARE\\Microsoft\\Cryptography"));const n=Number(/ProcessId = (\d+)/.exec(command)[1]);assert([17,22].includes(n));return {stdout:JSON.stringify({machine:rawId,boot:'638900000000000000',present:!(n===17&&absent),start:n===17&&absent?null:n===17?(reused?'638900000000000300':'638900000000000100'):'638900000000000200'})};}};
 const at=pid=>createMaintenanceProcessIdentity({platform:'win32',pid,env:{SystemRoot:'C:\\Windows',SECRET:'NO'},io,now:()=>1000});const old=await at(17).capture();assert(validMaintenanceProcess(old));assert(!JSON.stringify(old).includes(rawId));assert.equal((await at(22).observe(old)).state,'alive');absent=true;assert.equal((await at(22).observe(old)).reason,'absent');absent=false;reused=true;assert.equal((await at(22).observe(old)).reason,'pid_reused');
});
test('unsupported platform cannot fabricate identity or process absence',async()=>{
 const p=createMaintenanceProcessIdentity({platform:'unsupported',pid:22});assert.equal(await p.capture(),null);assert.equal((await p.observe(null)).state,'unknown');
});
test('Linux procfs mounted for a different PID view cannot identify the current Host',async()=>{
 let queried=false;const p=createMaintenanceProcessIdentity({platform:'linux',pid:1,io:{readlink:async()=> '9001',readFile:async()=>{queried=true;throw Error();}}});assert.equal(await p.capture(),null);assert(!queried);
});
