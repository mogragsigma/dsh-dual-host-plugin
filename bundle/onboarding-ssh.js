import {reserveForwardPort,startForwardProcess} from './onboarding-ssh-forward.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {ancestors} from './onboarding-install-fs.js';
export const fail=code=>{throw Error('ONBOARDING_'+code);};
export const digest=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
export const shellQuote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const printable=s=>typeof s==='string'&&s.length<=1024&&!/[\x00-\x1f\x7f]/.test(s);
export function connection(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join()!=='auth,host,identityPath,port,user')fail('SSH_ARGUMENTS');
 const {host,user,port,auth,identityPath}=value;
 if(!printable(host)||host.length>253||!host.split('.').every(x=>/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(x))||/^\d+(?:\.\d+){3}$/.test(host)&&host.split('.').some(x=>+x>255))fail('SSH_ARGUMENTS');
 if(!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(user)||!Number.isInteger(port)||port<1||port>65535||!['file','agent'].includes(auth)||!printable(identityPath)||auth==='agent'&&identityPath!=='')fail('SSH_ARGUMENTS');
 return {host:host.toLowerCase(),user,port,auth,identityPath};
}
export async function identity(c,{home,env,platform}){
 if(c.auth==='agent'){
  if(platform==='win32')return {kind:'agent',socket:'windows-openssh-agent'};
  const socket=env.SSH_AUTH_SOCK;
  if(!printable(socket)||!path.isAbsolute(socket))fail('SSH_AGENT_UNAVAILABLE');
  const s=await fs.lstat(socket).catch(()=>fail('SSH_AGENT_UNAVAILABLE'));
  if(!s.isSocket()||process.getuid&&s.uid!==process.getuid())fail('SSH_AGENT_UNAVAILABLE');
  return {kind:'agent',socket,dev:s.dev,ino:s.ino};
 }
 const p=c.identityPath.startsWith('~/')?path.join(home,c.identityPath.slice(2)):c.identityPath;
 if(!path.isAbsolute(p)||path.resolve(p)!==p)fail('SSH_IDENTITY_PATH');
 // Identity parents only need to be readable directories; never demand write access.
 let parent=path.parse(p).root;
 for(const part of path.relative(parent,path.dirname(p)).split(path.sep).filter(Boolean)){
  parent=path.join(parent,part);let s;try{s=await fs.lstat(parent);}catch{fail('SSH_IDENTITY_UNAVAILABLE');}
  if(s.isSymbolicLink()||!s.isDirectory())fail('SSH_IDENTITY_UNSAFE');
 }
 const s=await fs.lstat(p).catch(()=>fail('SSH_IDENTITY_UNAVAILABLE'));
 if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>65536||s.size<32||platform!=='win32'&&((s.mode&0o077)!==0||process.getuid&&s.uid!==process.getuid()))fail('SSH_IDENTITY_UNSAFE');
 return {kind:'file',path:p,dev:s.dev,ino:s.ino,size:s.size,mtime:s.mtimeMs,mode:s.mode&0o777};
}
export function hostKeys(raw){
 if(typeof raw!=='string'||raw.length>65536)fail('SSH_HOSTKEY_RESPONSE');
 const rows=[];
 for(const line of raw.split(/\r?\n/)){
  if(!line||line.startsWith('#'))continue;
  const fields=line.trim().split(/\s+/);if(fields.length!==3)fail('SSH_HOSTKEY_RESPONSE');
  const [,type,encoded]=fields;if(!['ssh-ed25519','ssh-rsa','ecdsa-sha2-nistp256'].includes(type)||!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))fail('SSH_HOSTKEY_RESPONSE');
  const bytes=Buffer.from(encoded,'base64');if(bytes.length<32||bytes.length>16384||bytes.length<4||bytes.readUInt32BE(0)>bytes.length-4||bytes.subarray(4,4+bytes.readUInt32BE(0)).toString()!==type)fail('SSH_HOSTKEY_RESPONSE');
  if(rows.some(x=>x.type===type&&x.key!==encoded))fail('SSH_MULTIPLE_HOSTKEYS');
  if(!rows.some(x=>x.type===type))rows.push({type,key:encoded,fingerprint:'SHA256:'+createHash('sha256').update(bytes).digest('base64').replace(/=+$/,'')});
 }
 if(!rows.length)fail('SSH_HOSTKEY_UNAVAILABLE');return rows.sort((a,b)=>a.type.localeCompare(b.type));
}
async function command(name,{env,platform}){
 for(const dir of (env.PATH??'').split(path.delimiter).filter(p=>path.isAbsolute(p))){
  const file=path.join(dir,name+(platform==='win32'?'.exe':''));
  try{const p=await fs.realpath(file),s=await fs.stat(p);if(s.isFile()){await fs.access(p,platform==='win32'?0:1);return p;}}catch{}
 }
 fail('SSH_TOOL_UNAVAILABLE');
}
export function runProcess(file,args,{input='',env,timeout=30000,maxOutput=1048576}={}){
 return new Promise((resolve,reject)=>{
  let out=[],err=[],size=0,error=null,killTimer;
  const p=spawn(file,args,{env,stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false});
  const stop=code=>{if(error)return;error=code;p.kill('SIGTERM');killTimer=setTimeout(()=>p.kill('SIGKILL'),1000);killTimer.unref();};
  const timer=setTimeout(()=>stop('SSH_TIMEOUT'),timeout);timer.unref();
  const collect=target=>chunk=>{size+=chunk.length;if(size>maxOutput)return stop('SSH_RESPONSE_LIMIT');target.push(chunk);};
  p.stdout.on('data',collect(out));p.stderr.on('data',collect(err));p.stdin.on('error',()=>{});
  p.on('error',()=>{clearTimeout(timer);clearTimeout(killTimer);reject(Error('ONBOARDING_SSH_PROCESS_FAILED'));});
  p.on('close',code=>{clearTimeout(timer);clearTimeout(killTimer);if(error)return reject(Error('ONBOARDING_'+error));const stderr=Buffer.concat(err).toString();if(code!==0){const reason=/REMOTE HOST IDENTIFICATION|Host key verification failed|No .* host key is known/.test(stderr)?'SSH_HOSTKEY_CHANGED':/Permission denied|Load key|bad permissions/.test(stderr)?'SSH_AUTH_FAILED':/timed out|Connection refused|No route|Could not resolve/.test(stderr)?'SSH_UNREACHABLE':'SSH_PROCESS_FAILED';return reject(Error('ONBOARDING_'+reason));}resolve(Buffer.concat(out).toString());});
  p.stdin.end(input);
 });
}
export function createSSH(runtime){
 const {env,home,platform,localState}=runtime;
 const cleanEnv={HOME:home,PATH:env.PATH??'',LANG:'C',LC_ALL:'C',...(env.SSH_AUTH_SOCK?{SSH_AUTH_SOCK:env.SSH_AUTH_SOCK}:{}),...(platform==='win32'&&env.SystemRoot?{SystemRoot:env.SystemRoot}:{})};
 async function scan(c){const bin=await command('ssh-keyscan',runtime);return hostKeys(await runProcess(bin,['-T','10','-p',String(c.port),'-t','ed25519,ecdsa,rsa',c.host],{env:cleanEnv,timeout:15000,maxOutput:65536}));}
 async function execute(binding,cmd,input='',options={}){
  if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(k=>k!=='timeoutMs')||![30000,120000].includes(options.timeoutMs??30000)||typeof input!=='string'||Buffer.byteLength(input)>12582912)fail('SSH_ARGUMENTS');
  if(typeof cmd!=='string'||cmd.length>100000||cmd.includes('\0'))fail('SSH_COMMAND_INVALID');
  const current=await identity(binding.connection,runtime);if(digest(current)!==digest(binding.identity))fail('SSH_IDENTITY_CHANGED');
  const bin=await command('ssh',runtime);await ancestors(localState);await fs.mkdir(localState,{recursive:true,mode:0o700});await ancestors(localState);
  const temp=await fs.mkdtemp(path.join(localState,'ssh-')),known=path.join(temp,'known_hosts'),alias='dsh-onboarding-cloud';
  try{
   await fs.writeFile(known,binding.keys.map(k=>`${alias} ${k.type} ${k.key}`).join('\n')+'\n',{flag:'wx',mode:0o600});
   const c=binding.connection,args=['-F',platform==='win32'?'NUL':'/dev/null','-T','-p',String(c.port),'-o','BatchMode=yes','-o','ConnectTimeout=12','-o','ConnectionAttempts=1','-o','ServerAliveInterval=10','-o','ServerAliveCountMax=3','-o','StrictHostKeyChecking=yes','-o','UpdateHostKeys=no','-o','GlobalKnownHostsFile='+ (platform==='win32'?'NUL':'/dev/null'),'-o','UserKnownHostsFile='+known,'-o','HostKeyAlias='+alias,'-o','ControlMaster=no','-o','ControlPath=none','-o','ForwardAgent=no','-o','ForwardX11=no','-o','ClearAllForwardings=yes','-o','PreferredAuthentications=publickey','-o','PasswordAuthentication=no','-o','KbdInteractiveAuthentication=no'];
   if(current.kind==='file')args.push('-o','IdentitiesOnly=yes','-o','IdentityAgent=none','-i',current.path);else args.push('-o','IdentitiesOnly=no');
   args.push(c.user+'@'+c.host,cmd);
   return await runProcess(bin,args,{input,env:cleanEnv,timeout:options.timeoutMs??30000,maxOutput:1048576});
  }finally{await fs.unlink(known).catch(()=>{});await fs.rmdir(temp).catch(()=>{});}
 }
 async function forward(binding,remotePort){
  if(!Number.isInteger(remotePort)||remotePort<1||remotePort>65535)fail('SSH_ARGUMENTS');
  const current=await identity(binding.connection,runtime);if(digest(current)!==digest(binding.identity))fail('SSH_IDENTITY_CHANGED');
  const bin=await command('ssh',runtime);await ancestors(localState);await fs.mkdir(localState,{recursive:true,mode:0o700});await ancestors(localState);
  const temp=await fs.mkdtemp(path.join(localState,'web-')),known=path.join(temp,'known_hosts'),alias='dsh-onboarding-cloud';
  const cleanup=async()=>{const missing=e=>{if(e.code!=='ENOENT')fail('SSH_CLEANUP_REVIEW');};await fs.unlink(known).catch(missing);await fs.rmdir(temp).catch(missing);};
  try{
   await fs.writeFile(known,binding.keys.map(k=>`${alias} ${k.type} ${k.key}`).join('\n')+'\n',{flag:'wx',mode:0o600});
   const port=await reserveForwardPort(),c=binding.connection,args=['-F',platform==='win32'?'NUL':'/dev/null','-T','-p',String(c.port),'-o','BatchMode=yes','-o','ConnectTimeout=12','-o','ConnectionAttempts=1','-o','ServerAliveInterval=10','-o','ServerAliveCountMax=3','-o','StrictHostKeyChecking=yes','-o','UpdateHostKeys=no','-o','GlobalKnownHostsFile='+(platform==='win32'?'NUL':'/dev/null'),'-o','UserKnownHostsFile='+known,'-o','HostKeyAlias='+alias,'-o','ControlMaster=no','-o','ControlPath=none','-o','ForwardAgent=no','-o','ForwardX11=no','-o','ClearAllForwardings=no','-o','ExitOnForwardFailure=yes','-o','GatewayPorts=no','-o','PreferredAuthentications=publickey','-o','PasswordAuthentication=no','-o','KbdInteractiveAuthentication=no'];
   if(current.kind==='file')args.push('-o','IdentitiesOnly=yes','-o','IdentityAgent=none','-i',current.path);else args.push('-o','IdentitiesOnly=no');
   args.push('-L',`127.0.0.1:${port}:127.0.0.1:${remotePort}`,c.user+'@'+c.host,"printf 'DSH_ONBOARDING_FORWARD_READY\\n'; cat >/dev/null");
   return await startForwardProcess(bin,args,{env:cleanEnv,port,cleanup});
  }catch(e){await cleanup();throw e;}
 }
 return {scan,execute,forward};
}
