import {managedTaskBranch} from './task-branch.js';
// Internal actual commit adapter, disabled by default and not wired to a public entry.
// Unit tests replace both Git and filesystem effects; no real Git-write acceptance yet.
import {constants,openSync,closeSync,fstatSync,lstatSync,realpathSync,writeSync,fsyncSync,ftruncateSync,renameSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {canonical} from './approval-ledger.js';
import {verifyObjects} from './delivery-object-plan.js';
import {compileIndex} from './delivery-index.js';
import {DeliveryGitRead} from './delivery-git-read.js';
import {execFileDrained} from './drained-process.js';
const fail=code=>{throw Error('DELIVERY_COMMIT_'+code);};
const sha=b=>createHash('sha256').update(b).digest('hex');
const syncDir=p=>{const fd=openSync(p,'r');try{fsyncSync(fd);}finally{closeSync(fd);}};
const statId=s=>({device:String(s.dev),inode:String(s.ino)});
const writeAll=(fd,data)=>{let at=0;while(at<data.length){const n=writeSync(fd,data,at,data.length-at,at);if(n<1)fail('SHORT_WRITE');at+=n;}};
export class DeliveryGitLease {
 constructor(identity,tag,onLock=()=>{}){this.identity=structuredClone(identity);this.gd=join(identity.root,'.git');this.tag=tag;this.onLock=onLock;this.handles=new Map();}
 checkRoot(){
  for(const [path,id] of [[this.identity.root,this.identity.directory],[this.gd,this.identity.git_directory]]){
   const s=lstatSync(path,{bigint:true});if(!s.isDirectory()||s.isSymbolicLink()||realpathSync(path)!==path||canonical(statId(s))!==canonical(id))fail('DIRECTORY_CHANGED');
  }
 }
 assert(){this.checkRoot();for(const [name,h] of this.handles){
  const s=lstatSync(join(this.gd,name),{bigint:true}),fd=fstatSync(h.fd,{bigint:true});
  if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1n||canonical(statId(s))!==canonical(h.identity)||canonical(statId(fd))!==canonical(h.identity))fail('LOCK_CHANGED');
 }}
 proofs(){return Object.fromEntries([...this.handles].map(([n,h])=>[n,{...h.identity}]));}
 open(){
  this.checkRoot();if(this.handles.size)fail('LEASE_ALREADY_OPEN');
  // Do not hold HEAD.lock: Git may need it for a branch transaction. HEAD is rechecked;
  // standard checkout is excluded by index.lock, not by an OS isolation guarantee.
  for(const name of ['config.lock','index.lock']){
   this.assert();const fd=openSync(join(this.gd,name),constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
   let identity;try{identity=statId(fstatSync(fd,{bigint:true}));}catch(e){closeSync(fd);throw e;}this.handles.set(name,{fd,identity});
   writeAll(fd,Buffer.from(canonical(this.tag)+'\n'));fsyncSync(fd);syncDir(this.gd);this.onLock(name,identity);
  }this.assert();
 }
 installIndex(bytes){
  this.assert();const h=this.handles.get('index.lock');if(!h||!Buffer.isBuffer(bytes))fail('INDEX_LOCK_REQUIRED');
  ftruncateSync(h.fd,0);writeAll(h.fd,bytes);fsyncSync(h.fd);this.assert();
  renameSync(join(this.gd,'index.lock'),join(this.gd,'index'));
  this.handles.delete('index.lock');try{closeSync(h.fd);}finally{syncDir(this.gd);}
 }
 release(){
  this.assert();for(const [name,h] of [...this.handles].reverse()){
   this.assert();unlinkSync(join(this.gd,name));this.handles.delete(name);try{closeSync(h.fd);}finally{syncDir(this.gd);}
  }
 }
 abandon(){for(const h of this.handles.values()){try{closeSync(h.fd);}catch{}}this.handles.clear();} // Never unlink an uncertain lock.
}
export function commitCommand(kind,plan,object){
 const oid=x=>typeof x==='string'&&new RegExp('^[a-f0-9]{'+(plan.format==='sha256'?64:40)+'}$').test(x);
 if(!['sha1','sha256'].includes(plan?.format)||!managedTaskBranch(plan.branch)||!oid(plan.parent)||!oid(plan.computed_commit_oid))fail('COMMAND_DENIED');
 if(kind==='object'&&object&&Buffer.isBuffer(object.data)&&['blob','tree','commit'].includes(object.type)&&plan.objects.some(o=>o.oid===object.oid&&o.type===object.type&&o.bytes===object.data?.length))return ['hash-object','-w','-t',object.type,'--stdin','--no-filters'];
 if(kind==='reference'&&object===undefined)return ['update-ref','--no-deref','-m','DSH approved delivery','refs/heads/'+plan.branch,plan.computed_commit_oid,plan.parent];
 fail('COMMAND_DENIED');
}
export class DeliveryCommit {
 constructor({journal,binding,enabled=false,externalDrained=()=>false},io={}){
  this.j=journal;this.enabled=enabled;this.binding=structuredClone(binding);this.active=false;this.lease=null;this.action=null;
  this.reader=io.reader??new DeliveryGitRead({binding,drained:()=>externalDrained()===true&&(!this.action||!journal.unfinished(this.action)),ownedLocks:()=>this.lease?.proofs()??{}});
  this.makeLease=io.makeLease??((identity,tag,onLock)=>new DeliveryGitLease(identity,tag,onLock));
  this.runGit=io.runGit??((args,input,signal,observer,plan)=>execFileDrained('/usr/bin/git',[
   '--git-dir='+join(binding.root,'.git'),'--work-tree='+binding.root,
   '-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','core.untrackedCache=false','-c','gc.auto=0','-c','maintenance.auto=false',
   '-c','core.fsync=loose-object,reference','-c','core.fsyncMethod=fsync',...args],{
    cwd:binding.root,timeout:10000,maxBuffer:1048576,killSignal:'SIGKILL',signal,
    env:{PATH:'/usr/bin:/bin',LC_ALL:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_SYSTEM:'/dev/null',GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0',GIT_NO_REPLACE_OBJECTS:'1',GIT_TERMINAL_PROMPT:'0',GIT_LITERAL_PATHSPECS:'1',
     GIT_COMMITTER_NAME:plan.committer.name,GIT_COMMITTER_EMAIL:plan.committer.email,GIT_COMMITTER_DATE:'@'+plan.when+' +0000'}},input,observer));
 }
 fsOperation(id,epoch,kind,fn){
  const op=this.j.startOperation(id,epoch,kind);let code=1,async=false;try{const result=fn();if(result&&typeof result.then==='function'){async=true;fail('ASYNC_FS_DENIED');}code=0;return result;}finally{if(!async)this.j.closed(op,{code});}
 }
 async gitOperation(id,epoch,kind,plan,object,signal){
  const args=commitCommand(kind,plan,object),op=this.j.startOperation(id,epoch,kind,object?{oid:object.oid}:{});
  let output;try{output=await this.runGit(args,object?.data,signal,{
   onSpawn:({pid})=>{if(pid!==null)this.j.spawned(op,pid);},onClose:result=>this.j.closed(op,result)},plan);
  }catch(e){
   const r=this.j.operation(op);if(e?.drained===true&&r.state==='intent'&&r.pid===null)this.j.closed(op,{code:null});throw e;
  }
  const closed=this.j.operation(op);if(closed.state!=='closed')fail('DRAIN_UNKNOWN');if(closed.code!==0||closed.signal!==null)fail('PROCESS_FAILED');
  if(kind==='object'&&Buffer.from(output??'').toString('ascii').trim()!==object.oid)fail('OBJECT_RESULT_MISMATCH');
 }
 guard(id,epoch,intent,baseline,index,phase){
  this.j.effectAuthority(id,epoch);if(this.j.unfinished(id))fail('DRAIN_UNKNOWN');this.lease.assert();
  const s=this.reader.capture(intent),p=intent.plan,updated=phase==='referenced'||phase==='indexed';
  if(s.head_oid!==(updated?p.computed_commit_oid:p.parent)||s.ref_oid!==(updated?p.computed_commit_oid:p.parent)||
   s.metadata.config_sha256!==baseline.metadata.config_sha256||s.metadata.head_sha256!==baseline.metadata.head_sha256||
   s.index_tree_oid!==(phase==='indexed'?p.tree_oid:baseline.parent_tree_oid)||
   s.metadata.index_sha256!==(phase==='indexed'?sha(index.bytes):baseline.metadata.index_sha256))fail('STATE_CHANGED');
  if(phase==='locked'&&s.fingerprint!==baseline.fingerprint)fail('BEFORE_SNAPSHOT_CHANGED');
  if(phase!=='locked'&&s.objects_present.length!==p.objects.length)fail('OBJECTS_INCOMPLETE');
 }
 async execute(id,epoch,objects,{signal}={}){
  if(this.enabled!==true)fail('DISABLED');if(this.active)fail('IN_FLIGHT');if(signal?.aborted)fail('CANCELLED');
  this.active=true;let dispatched=false,intent;
  try{
   const row=this.j.fence(id,epoch);if(row.dispatched)fail('ALREADY_DISPATCHED');intent=this.j.intent(row);
   if(this.binding.root!==intent.workspace_identity.root||this.binding.url!==intent.resource||this.binding.branch!==intent.plan.branch||this.binding.base_sha!==intent.plan.parent)fail('BINDING_CHANGED');
   const copy=objects.map(o=>({oid:o.oid,type:o.type,data:Buffer.from(o.data)}));verifyObjects(intent.plan,copy);const index=compileIndex(intent.plan,copy);
   const baseline=JSON.parse(row.before_snapshot??'null');this.j.markDispatched(id,epoch);dispatched=true;this.action=id;
   this.j.event(id,'index_planned',{epoch,plan_fingerprint:intent.plan.fingerprint,tree_oid:index.tree_oid,sha256:sha(index.bytes),bytes:index.bytes.length});
   this.lease=this.makeLease(intent.workspace_identity,{action_id:id,epoch,intent_fingerprint:intent.fingerprint},(name,identity)=>this.j.event(id,'lock_owned',{epoch,name,identity}));
   this.fsOperation(id,epoch,'lock',()=>this.lease.open());this.guard(id,epoch,intent,baseline,index,'locked');
   const present=new Set(baseline.objects_present);
   for(const object of copy){
    if(present.has(object.oid))continue;if(signal?.aborted)fail('CANCELLED');
    this.j.effectAuthority(id,epoch);this.lease.assert();await this.gitOperation(id,epoch,'object',intent.plan,object,signal);
   }
   this.guard(id,epoch,intent,baseline,index,'objects');if(signal?.aborted)fail('CANCELLED');
   await this.gitOperation(id,epoch,'reference',intent.plan,undefined,signal);
   this.guard(id,epoch,intent,baseline,index,'referenced');if(signal?.aborted)fail('CANCELLED');
   this.fsOperation(id,epoch,'index',()=>this.lease.installIndex(index.bytes));this.guard(id,epoch,intent,baseline,index,'indexed');
   this.fsOperation(id,epoch,'unlock',()=>this.lease.release());this.reader.observe(intent);return this.j.finish(id,epoch);
  }catch(e){
   if(!dispatched)throw e;
   // Cleanup only our inode-bound locks after all operations are closed. Revocation
   // stops new effects but does not prevent this cleanup; uncertain child => keep locks.
   if(this.lease&&!this.j.unfinished(id))try{this.fsOperation(id,epoch,'unlock',()=>this.lease.release());}catch{}
   try{this.j.recordFailure(id,epoch);}catch{} // A lost owner never steals the new task fence.
   return {...this.j.view(id),review_required:true,error:'DELIVERY_COMMIT_UNCERTAIN'};
  }finally{this.lease?.abandon();this.lease=null;this.action=null;this.active=false;}
 }
}
