// Read-only process identity for retiring a maintenance receipt, never for signalling.
// Raw machine identifiers stay in memory; only a domain-separated digest is retained.
import {readFile,readlink} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import path from 'node:path';
const execute=promisify(execFile);
const pidOK=v=>Number.isInteger(v)&&v>=1&&v<=2147483647;
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const digits=v=>typeof v==='string'&&/^[0-9]{1,24}$/.test(v);
const machine=(platform,value)=>createHash('sha256').update('dsh-maintenance-host-v1:'+platform+':'+value.toLowerCase()).digest('hex');
const exact=(v,k)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===k.slice().sort().join();
const darwinBirth=v=>typeof v==='string'&&/^bsd:[1-9][0-9]{0,19}:[0-9]{6}$/.test(v);
let darwinReader;
// Public libproc ABI (sys/proc_info.h), not a setuid ps spawn or a process scan.
// x64/arm64 proc_bsdinfo: 136 bytes, status@4, pid@12, start seconds/useconds@120/128.
export function createDarwinProcessReader(koffi,arch=process.arch){
 if(!['arm64','x64'].includes(arch))throw Error('PROCESS_ABI_UNSUPPORTED');
 const lib=koffi.load('/usr/lib/libproc.dylib'),query=lib.func('int proc_pidinfo(int pid, int flavor, uint64_t arg, _Out_ void *buffer, int buffersize)');
 return target=>{
  if(!pidOK(target))throw Error('INVALID_PID');const buffer=Buffer.alloc(136);
  try{
   koffi.errno(0);const size=query(target,3,0,buffer,buffer.length),error=koffi.errno();
   if(size===0&&error===3)return {present:false,start:null}; // ESRCH only; denied/partial results remain unknown.
   if(size!==136||buffer.readUInt32LE(12)!==target)throw Error('PROCESS_IDENTITY_UNAVAILABLE');
   const state=buffer.readUInt32LE(4),sec=buffer.readBigUInt64LE(120),usec=buffer.readBigUInt64LE(128);
   if(state<1||state>5||sec===0n||usec>=1000000n)throw Error('PROCESS_IDENTITY_UNAVAILABLE');
   return {present:true,terminal:state===5,start:'bsd:'+sec+':'+String(usec).padStart(6,'0')};
  }finally{buffer.fill(0);}
 };
}
async function readDarwinProcess(target){
 darwinReader??=createDarwinProcessReader((await import('koffi')).default);return darwinReader(target);
}
export function validMaintenanceProcess(v){
 if(!exact(v,['platform','host','namespace','boot','pid','start'])||!['linux','darwin','win32'].includes(v.platform)||!pidOK(v.pid)||!/^[a-f0-9]{64}$/.test(v.host??''))return false;
 if(v.platform==='linux')return /^pid:\[[0-9]+\]$/.test(v.namespace)&&uuid(v.boot)&&digits(v.start);
 if(v.platform==='darwin')return v.namespace==='host'&&uuid(v.boot)&&(darwinBirth(v.start)||/^[A-Za-z]{3} [A-Za-z]{3} [0-9]{1,2} [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4}$/.test(v.start));
 return v.namespace==='host'&&digits(v.boot)&&digits(v.start);
}
export function createMaintenanceProcessIdentity({platform=process.platform,pid=process.pid,env=process.env,now=Date.now,io={}}={}){
 const read=io.readFile??readFile,link=io.readlink??readlink,exec=io.execFile??execute;
 const shellEnv=platform==='win32'?{SystemRoot:env.SystemRoot??'',WINDIR:env.SystemRoot??'',PATH:path.win32.join(env.SystemRoot??'','System32')}:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LC_ALL:'C',TZ:'UTC'};
 const options={env:shellEnv,timeout:3000,maxBuffer:32768,windowsHide:true};
 async function query(target){
  if(!pidOK(target))throw Error('INVALID_PID');
  if(platform==='linux'){
   const id=(await read('/etc/machine-id','utf8')).trim(),boot=(await read('/proc/sys/kernel/random/boot_id','utf8')).trim().toLowerCase(),namespace=await link('/proc/self/ns/pid');
   if(!/^[a-f0-9]{32}$/i.test(id)||!uuid(boot)||!/^pid:\[[0-9]+\]$/.test(namespace))throw Error('HOST_IDENTITY_UNAVAILABLE');
   const base={platform,host:machine(platform,id),boot,namespace,pid:target};let raw;
   try{raw=await read('/proc/'+target+'/stat','utf8');}catch(e){if(e.code==='ENOENT')return {...base,present:false,start:null};throw e;}
   const fields=raw.slice(raw.lastIndexOf(')')+2).trim().split(/\s+/);if(Number(/^([0-9]+) /.exec(raw)?.[1])!==target||raw.lastIndexOf(')')<1||!digits(fields[19]))throw Error('PROCESS_IDENTITY_UNAVAILABLE');
   return {...base,present:true,terminal:['Z','X'].includes(fields[0]),start:fields[19]};
  }
  if(platform==='darwin'){
   const registry=(await exec('/usr/sbin/ioreg',['-rd1','-c','IOPlatformExpertDevice'],options)).stdout;
   const id=/"IOPlatformUUID"\s*=\s*"([a-f0-9-]+)"/i.exec(registry)?.[1],boot=(await exec('/usr/sbin/sysctl',['-n','kern.bootsessionuuid'],options)).stdout.trim().toLowerCase();
   if(!uuid(id)||!uuid(boot))throw Error('HOST_IDENTITY_UNAVAILABLE');const base={platform,host:machine(platform,id),boot,namespace:'host',pid:target};
   const row=await (io.darwinProcess??readDarwinProcess)(target);
   if(row.present===false&&row.start===null)return {...base,present:false,start:null};
   if(row.present!==true||typeof row.terminal!=='boolean'||!darwinBirth(row.start))throw Error('PROCESS_IDENTITY_UNAVAILABLE');
   return {...base,start:row.start,present:true,terminal:row.terminal};
  }
  if(platform==='win32'){
   if(!path.win32.isAbsolute(env.SystemRoot??''))throw Error('HOST_IDENTITY_UNAVAILABLE');
   const command="$ErrorActionPreference='Stop';[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new();$o=Get-CimInstance Win32_OperatingSystem;$m=(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography').MachineGuid;$p=Get-CimInstance Win32_Process -Filter 'ProcessId = "+target+"';@{machine=$m;boot=[string]$o.LastBootUpTime.ToUniversalTime().Ticks;present=[bool]$p;start=$(if($p){[string]$p.CreationDate.ToUniversalTime().Ticks}else{$null})}|ConvertTo-Json -Compress";
   const raw=(await exec(path.win32.join(env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-Command',command],options)).stdout.replace(/^\uFEFF/,'');
   const row=JSON.parse(raw);if(!exact(row,['machine','boot','present','start'])||!uuid(row.machine)||!digits(row.boot)||typeof row.present!=='boolean'||row.present&&!digits(row.start)||!row.present&&row.start!==null)throw Error('PROCESS_IDENTITY_UNAVAILABLE');
   return {platform,host:machine(platform,row.machine),namespace:'host',boot:row.boot,pid:target,start:row.start,present:row.present,terminal:false};
  }
  throw Error('PLATFORM_UNSUPPORTED');
 }
 async function capture(){try{if(platform==='linux'&&await link('/proc/self')!==String(pid))return null;const row=await query(pid);if(!row.present||row.terminal)return null;const {present,terminal,...identity}=row;return validMaintenanceProcess(identity)?identity:null;}catch{return null;}}
 async function observe(expected){
  const result=(state,reason,observer=null,currentStart=null)=>({state,reason,observer,currentStart,observedAt:now()});
  if(!validMaintenanceProcess(expected))return result('unknown','identity_missing');
  const observer=await capture();if(!observer)return result('unknown','observer_unavailable');
  if(observer.platform!==expected.platform||observer.host!==expected.host)return result('unknown','host_changed',observer);
  if(observer.boot!==expected.boot)return result('exited','boot_changed',observer);
  if(observer.namespace!==expected.namespace)return result('unknown','namespace_changed',observer);
  try{
   const current=await query(expected.pid);
   if(current.host!==observer.host||current.boot!==observer.boot||current.namespace!==observer.namespace)return result('unknown','observation_changed',observer);
   if(!current.present)return result('exited','absent',observer);
   if(platform==='darwin'&&darwinBirth(current.start)!==darwinBirth(expected.start))return result('unknown','identity_format_changed',observer);
   if(current.start!==expected.start)return result('exited','pid_reused',observer,current.start);
   if(current.terminal)return result('exited','terminal',observer,current.start);
   return result('alive','same_process',observer,current.start);
  }catch{return result('unknown','process_unavailable',observer);}
 }
 return {capture,observe};
}
