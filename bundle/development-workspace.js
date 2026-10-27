import {execFileSync} from 'node:child_process';
import {execFileDrained} from './drained-process.js';
import {lstatSync,realpathSync,readFileSync,openSync,closeSync,writeFileSync,fsyncSync,renameSync,constants} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {validateDevelopmentSource} from './development-source.js';
export const contentHash=x=>createHash('sha256').update(x).digest('hex');
const env=()=>({PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0'});
const absent=e=>{if(e.code==='ENOENT')return null;throw e;};
export class DevelopmentWorkspace {
 constructor(binding,spec,snapshot){
  if(!binding||binding.url!==snapshot.url||binding.branch!==spec.branch||binding.base_sha!==snapshot.base_sha||typeof binding.root!=='string'||!binding.root.startsWith('/'))throw Error('DEVELOPMENT_WORKSPACE_NOT_BOUND');
  this.b={...binding};this.spec=spec;this.root=resolve(binding.root);this.file=join(this.root,spec.file);
 }
 git(args){try{return execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','core.untrackedCache=false','-C',this.root,...args],{encoding:'utf8',env:env(),timeout:5000,maxBuffer:1048576,stdio:['ignore','pipe','pipe']});}catch{throw Error('DEVELOPMENT_GIT_CHECK_FAILED');}}
 identity(){
  if(realpathSync(this.root)!==this.root||!lstatSync(this.root).isDirectory())throw Error('DEVELOPMENT_ROOT_CHANGED');
  const gd=join(this.root,'.git');if(!lstatSync(gd).isDirectory()||lstatSync(gd).isSymbolicLink()||realpathSync(gd)!==gd)throw Error('DEVELOPMENT_SHARED_GITDIR_DENIED');
  const dir=p=>{const s=lstatSync(p,{bigint:true});return {device:String(s.dev),inode:String(s.ino)};};
  return {root:this.root,directory:dir(this.root),git_directory:dir(gd),url:this.b.url,branch:this.spec.branch,base_sha:this.b.base_sha};
 }
 check(expectedHash){
  this.identity();const gd=join(this.root,'.git');
  if(this.git(['rev-parse','--show-toplevel']).trim()!==this.root||this.git(['rev-parse','--absolute-git-dir']).trim()!==gd)throw Error('DEVELOPMENT_ROOT_CHANGED');
  if(this.git(['symbolic-ref','--short','HEAD']).trim()!==this.spec.branch||this.git(['rev-parse','HEAD']).trim()!==this.b.base_sha)throw Error('DEVELOPMENT_BASELINE_CHANGED');
  const remote=this.git(['remote','get-url','origin']).trim().replace(/\.git$/,'');
  if(remote!==this.b.url)throw Error('DEVELOPMENT_REMOTE_CHANGED');
  // Only this new file may be dirty. No rename, staged file, deletion or unrelated dirty file.
  const changes=this.git(['status','--porcelain=v1','-z','--untracked-files=all']).split('\0').filter(Boolean);
  if(changes.some(x=>x!=='?? '+this.spec.file)||changes.length>1)throw Error('DEVELOPMENT_DIRTY_WORKSPACE');
  let s;try{s=lstatSync(this.file);}catch(e){s=absent(e);}
  if(s&&(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>8192))throw Error('DEVELOPMENT_FILE_UNSAFE');
  const bytes=s?readFileSync(this.file):null,hash=bytes?contentHash(bytes):null;
  if(hash!==expectedHash)throw Error('DEVELOPMENT_FILE_CONFLICT');
  return {hash,content:bytes?.toString('utf8')??null};
 }
 write(content,expectedHash){
  if(typeof content!=='string'||!content.trim()||Buffer.byteLength(content)>8192||content.includes('\0'))throw Error('DEVELOPMENT_CONTENT_INVALID');
  this.check(expectedHash);const temp=join(this.root,'.dsh-dev-'+randomUUID());let fd;
  try{fd=openSync(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);writeFileSync(fd,content);fsyncSync(fd);}finally{if(fd!==undefined)closeSync(fd);}
  renameSync(temp,this.file);fd=openSync(this.root,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
  return contentHash(content);
 }
 async test(expectedHash,signal,observer={}){
  const source=this.check(expectedHash).content;if(!expectedHash)throw Error('DEVELOPMENT_FILE_REQUIRED');
  try{validateDevelopmentSource(source);}catch{return {passed:false,code:'DEVELOPMENT_SOURCE_SUBSET',file_hash:expectedHash};}
  const runner=fileURLToPath(new URL('./development-test-runner.js',import.meta.url));
  if(process.versions.electron||Number(process.versions.node.split('.')[0])<22)throw Error('DEVELOPMENT_TEST_RUNTIME_UNSUPPORTED');
  let output;try{output=await execFileDrained(process.execPath,['--permission','--allow-fs-read='+runner,'--max-old-space-size=64',runner],{cwd:this.root,env:{PATH:'/usr/bin:/bin'},timeout:5000,maxBuffer:16384,killSignal:'SIGKILL',signal},source,observer);}catch(e){if(!e.drained)throw Error('DEVELOPMENT_TEST_DRAIN_UNKNOWN');if(signal?.aborted)throw Object.assign(Error('DEVELOPMENT_TEST_CANCELLED'),{drained:true});return {passed:false,code:'DEVELOPMENT_TEST_FAILED',file_hash:expectedHash};}
  this.check(expectedHash);let parsed;try{parsed=JSON.parse(output);}catch{return {passed:false,code:'DEVELOPMENT_TEST_OUTPUT_INVALID',file_hash:expectedHash};}
  return {passed:parsed?.validator==='task-summary-v1'&&parsed?.cases===6&&parsed?.passed===true,validator:'task-summary-v1',cases:parsed?.cases??0,file_hash:expectedHash};
 }
}
