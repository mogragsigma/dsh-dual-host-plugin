// Fixed Gitee SSH Git transport. No model-supplied command, endpoint or credential.
// Executes only under a Linux descendant supervisor; macOS can stage/observe via RPC.
import {lstatSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {canonical} from './approval-ledger.js';
import {validatePushPlan,pushCommand,remoteReadCommand,parseRemoteRef} from './delivery-push-plan.js';
import {runSupervised} from './delivery-process.js';
const fail=c=>{throw Error('DELIVERY_SSH_'+c);};
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
function identity(path,secret){
 if(typeof path!=='string'||!path.startsWith('/')||path.length>2048||/[\x00-\x1f\x7f]/.test(path))fail('CREDENTIAL_PATH');
 const s=lstatSync(path,{bigint:true});
 if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1n||s.size<1n||s.size>1048576n||realpathSync(path)!==path||
  (s.mode&BigInt(secret?0o077:0o022))!==0n)fail('CREDENTIAL_FILE');
 return {device:String(s.dev),inode:String(s.ino),size:String(s.size),mtime:String(s.mtimeNs),ctime:String(s.ctimeNs)};
}
export function sshEnvironment({keyFile,knownHostsFile}){
 const args=['/usr/bin/ssh','-F','/dev/null','-T','-p','22','-i',keyFile,
  '-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','UpdateHostKeys=no','-o','IdentitiesOnly=yes',
  '-o','IdentityAgent=none','-o','AddKeysToAgent=no','-o','ForwardAgent=no','-o','ClearAllForwardings=yes',
  '-o','ControlMaster=no','-o','ControlPath=none','-o','ControlPersist=no','-o','ProxyCommand=none','-o','ProxyJump=none',
  '-o','PermitLocalCommand=no','-o','KnownHostsCommand=none','-o','CertificateFile=none',
  '-o','GlobalKnownHostsFile=/dev/null','-o','UserKnownHostsFile='+knownHostsFile,'-o','ConnectTimeout=8'];
 if([keyFile,knownHostsFile].some(p=>typeof p!=='string'||!p.startsWith('/')||p.length>2048||/[\x00-\x1f\x7f]/.test(p)))fail('CREDENTIAL_PATH');
 return {PATH:'/usr/bin:/bin',LC_ALL:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_SYSTEM:'/dev/null',GIT_CONFIG_GLOBAL:'/dev/null',
  GIT_OPTIONAL_LOCKS:'0',GIT_NO_REPLACE_OBJECTS:'1',GIT_TERMINAL_PROMPT:'0',GIT_LITERAL_PATHSPECS:'1',
  GIT_SSH_VARIANT:'ssh',GIT_SSH_COMMAND:args.map(quote).join(' ')};
}
export function sshGitCommand(binding,plan,kind){
 validatePushPlan(plan);
 if(!binding||binding.url!==plan.url||binding.branch!==plan.branch||binding.base_sha!==plan.parent_oid||
  typeof binding.root!=='string'||!binding.root.startsWith('/')||binding.root.endsWith('/')||/[\x00-\x1f\x7f]/.test(binding.root))fail('BINDING');
 const tail=kind==='read'?remoteReadCommand(plan):kind==='push'?pushCommand(plan):null;if(!tail)fail('COMMAND_DENIED');
 return ['/usr/bin/git','--git-dir='+join(binding.root,'.git'),'--work-tree='+binding.root,
  '-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','core.untrackedCache=false','-c','gc.auto=0','-c','maintenance.auto=false',
  '-c','protocol.allow=never','-c','protocol.ssh.allow=always','-c','protocol.version=0','-c','push.followTags=false',
  '-c','push.recurseSubmodules=no','-c','push.gpgSign=false','-c','credential.helper=',...tail];
}
export class DeliverySSH {
 constructor({binding,keyFile,knownHostsFile,enabled=false},io={}){
  this.b=structuredClone(binding);this.credentials={keyFile,knownHostsFile};this.enabled=enabled;this.platform=io.platform??process.platform;
  this.fileIdentity=io.fileIdentity??identity;this.run=io.run??runSupervised;
  this.secretIdentity=null;this.active=false;
 }
 check(){
  if(this.enabled!==true)fail('DISABLED');if(this.platform!=='linux')fail('PLATFORM_UNSUPPORTED');
  const current={key:this.fileIdentity(this.credentials.keyFile,true),hosts:this.fileIdentity(this.credentials.knownHostsFile,false)};
  if(this.secretIdentity&&canonical(current)!==canonical(this.secretIdentity))fail('CREDENTIAL_CHANGED');this.secretIdentity??=current;
 }
 async invoke(plan,kind,{signal,onSpawn,onDrained,beforeSpawn}={}){
  this.check();if(this.active)fail('IN_FLIGHT');if(signal?.aborted)fail('ABORTED');
  const argv=sshGitCommand(this.b,plan,kind),env=sshEnvironment(this.credentials);this.active=true;
  try{
   const receipt=beforeSpawn?.();this.check();
   const result=await this.run(argv,{cwd:this.b.root,env,timeout:20,limit:1048576,signal,onSpawn,onDrained,receipt});
   if(result.drained!==true)fail('DRAIN_UNKNOWN');this.check();
   if(result.cause!==null||result.signal!==null)fail('OPERATION_FAILED');
   if(kind==='read')return parseRemoteRef(plan,{code:result.code,stdout:result.stdout.toString('ascii')});
   if(result.code!==0)fail('PUSH_REJECTED');return {acknowledged:true,drained:true};
  }catch{fail('OUTCOME_UNKNOWN');}finally{this.active=false;}
 }
 read(plan,options){return this.invoke(plan,'read',options);}
 push(plan,options){return this.invoke(plan,'push',options);}
}
