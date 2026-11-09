import {createHash} from 'node:crypto';
// Small macOS native leaf-command adapter. No shell, VM, background job or
// privilege fallback. Commands needing child processes are deliberately denied.
import {spawn} from 'node:child_process';
import {realpathSync,lstatSync,readdirSync,mkdirSync} from 'node:fs';
import {isAbsolute,join,relative,dirname} from 'node:path';
const fail=s=>{throw Error('TASK_COMMAND_'+s);};
const inside=(root,p)=>{const r=relative(root,p);return !r||r!=='..'&&!r.startsWith('../')&&!isAbsolute(r);};
export function validateManagedCommands(c){
 if(c===undefined)return;
 if(!c||typeof c!=='object'||Array.isArray(c)||!Object.keys(c).length||Object.keys(c).length>8)fail('CONFIG_INVALID');
 for(const [name,v] of Object.entries(c))if(!/^[a-z][a-z0-9_-]{0,39}$/.test(name)||!v||typeof v!=='object'||Object.keys(v).some(k=>!['executable','args','timeout_ms'].includes(k))||typeof v.executable!=='string'||!isAbsolute(v.executable)||/[\x00-\x1f]/.test(v.executable)||!Array.isArray(v.args)||v.args.length>32||v.args.some(a=>typeof a!=='string'||a.length>2000||a.includes('\0'))||!Number.isInteger(v.timeout_ms)||v.timeout_ms<100||v.timeout_ms>300000)fail('CONFIG_INVALID');
}
function checkTree(root){
 let n=0;const visit=p=>{if(++n>50000)fail('TREE_LIMIT');const s=lstatSync(p);if(s.isSymbolicLink())return;if(s.isFile()&&s.nlink!==1)fail('HARDLINK_DENIED');if(s.isDirectory())for(const f of readdirSync(p))visit(join(p,f));};visit(root);
}
export function macCommandPlan(cwd,command,{protectedRoots=[]}={}){
 validateManagedCommands({command});const root=realpathSync(cwd),executable=realpathSync(command.executable);
 if(root!==cwd||root==='/'||protectedRoots.some(p=>inside(root,p)||inside(p,root))||inside(root,executable))fail('SCOPE_INVALID');
 if(!lstatSync(root).isDirectory()||!lstatSync(executable).isFile())fail('SCOPE_INVALID');checkTree(root);
 const home=join(root,'.managed-command-home'),tmp=join(root,'.managed-command-tmp');
 for(const p of [home,tmp]){mkdirSync(p,{recursive:true,mode:0o700});if(realpathSync(p)!==p||!lstatSync(p).isDirectory())fail('SCOPE_INVALID');}
 const q=JSON.stringify,system=['/System/Library','/usr/lib','/usr/share','/Library/Apple/System/Library','/System/Volumes/Preboot/Cryptexes/OS/System/Library','/System/Volumes/Preboot/Cryptexes/OS/usr/lib','/System/Cryptexes/OS/System/Library','/System/Cryptexes/OS/usr/lib'];
 const policy=`(version 1)
(deny default)
(allow process-exec (literal ${q(executable)}))
(deny process-fork)
(allow signal (target self))
(allow sysctl-read)
(allow file-read* file-map-executable (literal "/") ${system.map(p=>`(subpath ${q(p)})`).join(' ')} (subpath ${q(root)}) (literal ${q(executable)}) (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))
(allow file-read-metadata (path-ancestors "/System/Volumes/Preboot/Cryptexes/OS/System/Library") (path-ancestors "/System/Cryptexes/OS/System/Library") (path-ancestors ${q(root)}) (path-ancestors ${q(executable)}) (literal "/") ${[...new Set([dirname(root),dirname(executable)])].map(p=>`(literal ${q(p)})`).join(' ')})
(allow file-write* (subpath ${q(root)}) (literal "/dev/null"))
(deny network*)
${protectedRoots.map(p=>`(deny file-read* file-write* (subpath ${q(p)}))`).join('\n')}`;
 return {root,executable,args:command.args,timeout:command.timeout_ms,policy,env:{PATH:'/usr/bin:/bin',HOME:home,TMPDIR:tmp,LANG:'en_US.UTF-8'}};
}
export async function runMacCommand(plan,signal){
 if(process.platform!=='darwin')fail('MACOS_REQUIRED');signal?.throwIfAborted();
 // Every process starts under the policy; sandbox failure is a failed command,
 // never a reason to retry outside the sandbox. No credentials/login environment.
 return new Promise((resolve,reject)=>{
  let child;try{child=spawn('/usr/bin/sandbox-exec',['-p',plan.policy,plan.executable,...plan.args],{cwd:plan.root,env:plan.env,stdio:['ignore','pipe','pipe']});}catch{reject(Error('TASK_COMMAND_START_FAILED'));return;}
  let output='',bytes=0,truncated=false,timedOut=false,aborted=false;
  const collect=chunk=>{const available=65536-bytes;if(available>0){const v=chunk.subarray(0,available);output+=v.toString('utf8');bytes+=v.length;}if(chunk.length>available)truncated=true;};
  child.stdout.on('data',collect);child.stderr.on('data',collect);
  // Fork/posix_spawn is denied by Seatbelt. Thus this sole process + its threads
  // is the complete execution boundary; no process-tree guessing is needed.
  const stop=()=>{aborted=true;child.kill('SIGKILL');};signal?.addEventListener('abort',stop,{once:true});
  const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},plan.timeout);
  child.once('error',()=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);reject(Error('TASK_COMMAND_START_FAILED'));});
  child.once('close',(code,killedBy)=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);resolve({exit_code:code,signal:killedBy,output,truncated,timed_out:timedOut,aborted,drained:true,backend:'macos-seatbelt-leaf',network:false,child_processes:false});});
  if(signal?.aborted)stop();
 });
}
export class ManagedCommands {
 constructor(endpoint,config,run=runMacCommand){validateManagedCommands(config);this.ep=endpoint;this.config=config;this.run=run;this.busy=false;endpoint.db?.exec('CREATE TABLE IF NOT EXISTS managed_command_bindings(task_id TEXT NOT NULL,name TEXT NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(task_id,name));');}
 async execute(b,a,signal){
  if(!a||Object.keys(a).join()!=='name'||typeof a.name!=='string')fail('ARGUMENT_INVALID');
  if(this.ep.g.c.role!=='local'||!b.item.spec.commands?.includes(a.name))fail('NOT_AUTHORIZED');
  const command=this.config?.[a.name];if(!command)fail('UNAVAILABLE');if(this.busy)fail('BUSY');
  this.busy=true;try{
   await this.ep.validate(b);
   // A device config edit must not silently change what an existing task runs.
   const fingerprint=createHash('sha256').update(JSON.stringify(command)).digest('hex'),db=this.ep.db;
   if(db){const old=db.prepare('SELECT fingerprint FROM managed_command_bindings WHERE task_id=? AND name=?').get(b.item.task_id,a.name);if(old&&old.fingerprint!==fingerprint)fail('DEFINITION_CHANGED');db.prepare('INSERT OR IGNORE INTO managed_command_bindings VALUES (?,?,?)').run(b.item.task_id,a.name,fingerprint);}
   const plan=macCommandPlan(b.item.spec.cwd,command,{protectedRoots:[this.ep.g.c.stateDir,...(this.ep.c.protectedRoots??[])].filter(Boolean)});
   const result=await this.run(plan,AbortSignal.any([b.controller.signal,signal].filter(Boolean)));
   if(result?.drained!==true)fail('DRAIN_UNVERIFIED');return result;
  }finally{this.busy=false;}
 }
}
