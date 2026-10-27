import {managedTaskBranch} from './task-branch.js';
// Private bounded read-only Git observer. No command here can update an object, ref or index.
import {execFileSync} from 'node:child_process';
import {constants,lstatSync,fstatSync,realpathSync,openSync,readSync,closeSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {canonical,digest} from './approval-ledger.js';
import {developmentPath} from './development-plan.js';
import {repositoryURL,repositoryBranch} from './repository-gitee.js';
import {compileCommit,gitObject,indexTree} from './delivery-object-plan.js';
const fail=code=>{throw Error('DELIVERY_GIT_'+code);};
const sha=b=>createHash('sha256').update(b).digest('hex');
const same=(a,b)=>canonical(a)===canonical(b);
const validOID=x=>typeof x==='string'&&/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(x);
const stamp=s=>[String(s.dev),String(s.ino),String(s.size),String(s.mtimeNs),String(s.ctimeNs)].join(':');
const exists=p=>{try{return lstatSync(p);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
function bytes(path,limit){
 const before=lstatSync(path,{bigint:true});
 if(!before.isFile()||before.nlink!==1n||before.size>BigInt(limit)||realpathSync(path)!==path)fail('FILE_UNSAFE');
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  if(stamp(fstatSync(fd,{bigint:true}))!==stamp(before))fail('FILE_CHANGED');
  const b=Buffer.alloc(Number(before.size)+1);let n=0,got;
  while(n<b.length&&(got=readSync(fd,b,n,b.length-n,null))>0)n+=got;
  if(n!==Number(before.size)||stamp(fstatSync(fd,{bigint:true}))!==stamp(before)||stamp(lstatSync(path,{bigint:true}))!==stamp(before))fail('FILE_CHANGED');
  return b.subarray(0,n);
 }finally{closeSync(fd);}
}
function physicalIdentity(b){
 const dir=p=>{const s=lstatSync(p,{bigint:true});if(!s.isDirectory()||s.isSymbolicLink()||realpathSync(p)!==p)fail('DIRECTORY_UNSAFE');return {device:String(s.dev),inode:String(s.ino)};};
 return {root:b.root,directory:dir(b.root),git_directory:dir(join(b.root,'.git')),url:b.url,branch:b.branch,base_sha:b.base_sha};
}
function inventory(root){
 const out=[];let total=0;
 const walk=(dir,prefix='')=>{
  const before=lstatSync(dir,{bigint:true});if(!before.isDirectory()||realpathSync(dir)!==dir)fail('DIRECTORY_UNSAFE');
  for(const name of readdirSync(dir).sort()){
   if(!prefix&&name==='.git')continue;const path=prefix+name;developmentPath(path);const absolute=join(dir,name),s=lstatSync(absolute);
   if(s.isSymbolicLink())fail('FILE_UNSAFE');if(s.isDirectory()){walk(absolute,path+'/');continue;}
   const data=bytes(absolute,8388608);total+=data.length;if(total>33554432||out.length>=4096)fail('LIMIT');
   out.push({path,bytes:data,mode:s.mode&0o111?0o755:0o644});
  }
  if(stamp(lstatSync(dir,{bigint:true}))!==stamp(before))fail('DIRECTORY_CHANGED');
 };walk(root);return out;
}
function metadata(root,owned={}){
 const gd=join(root,'.git');
 for(const p of ['commondir','gitdir','shallow','info/grafts','objects/info/alternates','objects/info/http-alternates','refs/replace','worktrees','reftable'])if(exists(join(gd,p)))fail('REPOSITORY_LAYOUT_UNSUPPORTED');
 if(Object.keys(owned).some(p=>!['index.lock','config.lock'].includes(p)))fail('LOCK_PROOF_INVALID');
 const own=p=>{const expected=Object.hasOwn(owned,p)?owned[p]:null;if(!expected)return false;const s=lstatSync(join(gd,p),{bigint:true});
  if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1n||String(s.dev)!==expected.device||String(s.ino)!==expected.inode)fail('LOCK_PROOF_CHANGED');return true;};
 for(const p of ['index.lock','HEAD.lock','config.lock'])if(!own(p)&&exists(join(gd,p)))fail('LOCKED');
 // Reject links/hardlinks before Git can follow object, pack or reference paths.
 let count=0;const layout=[];const walk=(dir,depth=0)=>{if(depth>64)fail('LIMIT');for(const name of readdirSync(dir).sort()){
  if(++count>65536)fail('LIMIT');const p=join(dir,name),s=lstatSync(p);
  if(dir===gd&&own(name))continue;if(name.endsWith('.lock'))fail('LOCKED');
  if(s.isSymbolicLink()||(!s.isDirectory()&&(!s.isFile()||s.nlink!==1)))fail('REPOSITORY_LAYOUT_UNSUPPORTED');
  layout.push({path:p.slice(gd.length+1),kind:s.isDirectory()?'directory':'file',mode:s.mode&0o777,size:s.isDirectory()?null:s.size});
  if(s.isDirectory())walk(p,depth+1);
 }};walk(gd);
 return {layout_sha256:digest(layout),config_sha256:sha(bytes(join(gd,'config'),262144)),index_sha256:exists(join(gd,'index'))?sha(bytes(join(gd,'index'),8388608)):null,head_sha256:sha(bytes(join(gd,'HEAD'),2048))};
}
function config(raw,url){
 const seen=new Set();let origin=false;
 const values={
  'core.repositoryformatversion':/^[01]$/,'core.filemode':/^(true|false)$/,'core.bare':/^false$/,
  'core.logallrefupdates':/^(true|false)$/,'core.ignorecase':/^(true|false)$/,'core.precomposeunicode':/^(true|false)$/,
  'extensions.objectformat':/^(sha1|sha256)$/,'remote.origin.fetch':/^\+refs\/heads\/\*:refs\/remotes\/origin\/\*$/,
  'user.name':/^[^\x00-\x1f\x7f]{1,256}$/,'user.email':/^[^\x00-\x1f\x7f]{1,254}$/
 };
 for(const item of raw.toString('utf8').split('\0').filter(Boolean)){
  const at=item.indexOf('\n');if(at<1)fail('CONFIG_UNSUPPORTED');const key=item.slice(0,at),value=item.slice(at+1);
  if(seen.has(key))fail('CONFIG_UNSUPPORTED');seen.add(key);
  if(key==='remote.origin.url'){try{if(repositoryURL(value).url!==url)fail('REMOTE_CHANGED');}catch{fail('REMOTE_CHANGED');}origin=true;}
  else if(key==='remote.origin.fetch'&&value!=='+refs/heads/*:refs/remotes/origin/*'){
   const m=/^\+refs\/heads\/(.+):refs\/remotes\/origin\/(.+)$/.exec(value);
   if(!m||m[1]!==m[2])fail('CONFIG_UNSUPPORTED');
   try{repositoryBranch(m[1]);}catch{fail('CONFIG_UNSUPPORTED');}
  }else if(/^branch\.(.+)\.(remote|merge)$/.test(key)){
   const m=/^branch\.(.+)\.(remote|merge)$/.exec(key);
   try{repositoryBranch(m[1]);if(m[2]==='remote'?value!=='origin':!value.startsWith('refs/heads/'))fail('CONFIG_UNSUPPORTED');if(m[2]==='merge')repositoryBranch(value.slice(11));}catch{fail('CONFIG_UNSUPPORTED');}
  }else if(!Object.hasOwn(values,key)||!values[key].test(value))fail('CONFIG_UNSUPPORTED');
 }
 if(!origin)fail('REMOTE_CHANGED');
}
function entries(raw,index=false){
 const out=[],str=raw.toString('utf8');if(!Buffer.from(str).equals(raw))fail('PATH_ENCODING');
 for(const record of str.split('\0').filter(Boolean)){
  const m=(index?/^(100644|100755) ([a-f0-9]{40}|[a-f0-9]{64}) 0\t(.+)$/u:/^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/u).exec(record);
  if(!m)fail('TREE_UNSUPPORTED');developmentPath(m[3]);out.push({mode:m[1]==='100755'?0o755:0o644,oid:m[2],path:m[3]});
 }return out;
}
export function parseBatch(raw,oids,format){
 const out=new Map();let at=0;
 for(const oid of oids){
  const end=raw.indexOf(10,at);if(end<0)fail('OBJECT_INVALID');const h=raw.subarray(at,end).toString('ascii');at=end+1;
  if(h===oid+' missing'){out.set(oid,null);continue;}
  const m=/^([a-f0-9]+) (blob|tree|commit) ([0-9]+)$/.exec(h);if(!m||m[1]!==oid)fail('OBJECT_INVALID');
  const size=Number(m[3]);if(!Number.isSafeInteger(size)||size>40000000||at+size>=raw.length||raw[at+size]!==10)fail('OBJECT_INVALID');
  const obj=gitObject(m[2],raw.subarray(at,at+size),format);if(obj.oid!==oid)fail('OBJECT_INVALID');out.set(oid,obj);at+=size+1;
 }if(at!==raw.length)fail('OBJECT_INVALID');return out;
}
export function readOnlyCommand(kind,arg){
 const simple={config:['config','--local','--no-includes','--null','--list'],format:['rev-parse','--show-object-format'],branch:['symbolic-ref','--quiet','HEAD'],head:['rev-parse','--verify','HEAD'],index:['ls-files','--stage','-z'],flags:['ls-files','-v','-z'],batch:['cat-file','--batch']};
 if(Object.hasOwn(simple,kind)&&arg===undefined)return simple[kind];
 if(kind==='ref'&&managedTaskBranch(arg))return ['rev-parse','--verify','refs/heads/'+arg];
 if(validOID(arg)&&kind==='tree')return ['ls-tree','-r','-z',arg];
 if(validOID(arg)&&kind==='root-tree')return ['rev-parse','--verify',arg+'^{tree}'];
 fail('READ_COMMAND_DENIED');
}
export function validateGitBaseline(intent,s){
 const {fingerprint,...body}=s??{},p=intent.plan;
 if(!fingerprint||digest(body)!==fingerprint||s.kind!=='git-state-v1'||s.intent_fingerprint!==intent.fingerprint||
  !same(s.workspace_identity,intent.workspace_identity)||s.branch!==p.branch||s.head_oid!==p.parent||s.ref_oid!==p.parent||
  !validOID(s.parent_tree_oid)||s.index_tree_oid!==s.parent_tree_oid||s.manifest_sha256!==p.manifest_sha256||
  !s.metadata||Object.keys(s.metadata).sort().join(',')!=='config_sha256,head_sha256,index_sha256,layout_sha256'||
  Object.entries(s.metadata).some(([k,v])=>k==='index_sha256'&&v===null?s.index_tree_oid!==indexTree([],p.format):typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v))||
  !Array.isArray(s.objects_present)||new Set(s.objects_present).size!==s.objects_present.length||
  !same(s.objects_present,[...s.objects_present].sort())||s.objects_present.some(oid=>!p.objects.some(o=>o.oid===oid)))fail('BASELINE_REQUIRED');
 return s;
}
export class DeliveryGitRead {
 constructor({binding,drained=()=>false,ownedLocks=()=>({})},io={}){
  if(!binding||typeof binding.root!=='string'||!binding.root.startsWith('/')||binding.root.endsWith('/')||repositoryURL(binding.url).url!==binding.url||
   !managedTaskBranch(binding.branch)||!validOID(binding.base_sha))fail('BINDING');
  this.b=structuredClone(binding);this.drained=drained;
  this.identity=()=>io.identity?io.identity():physicalIdentity(this.b);
  this.inventory=()=>io.inventory?io.inventory():inventory(this.b.root);
  this.metadata=()=>io.metadata?io.metadata():metadata(this.b.root,ownedLocks());
  this.execute=io.execute??((args,input)=>execFileSync('/usr/bin/git',args,{cwd:this.b.root,input,timeout:10000,maxBuffer:67108864,
   env:{PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_SYSTEM:'/dev/null',GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0',GIT_NO_REPLACE_OBJECTS:'1',GIT_TERMINAL_PROMPT:'0',GIT_LITERAL_PATHSPECS:'1',LC_ALL:'C'},stdio:['pipe','pipe','pipe']}));
 }
 read(kind,arg,input){
  const command=readOnlyCommand(kind,arg);
  if(kind!=='batch'&&input!==undefined)fail('READ_COMMAND_DENIED');
  if(kind==='batch'&&(!Buffer.isBuffer(input)||input.length>5000000||!input.toString('ascii').split('\n').filter(Boolean).every(validOID)))fail('READ_COMMAND_DENIED');
  try{return Buffer.from(this.execute(['--git-dir='+join(this.b.root,'.git'),'--work-tree='+this.b.root,
   '-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','core.untrackedCache=false','-c','gc.auto=0','-c','maintenance.auto=false',...command],input));}
  catch{fail('READ_FAILED');}
 }
 objects(oids,format){if(!oids.length)return new Map();return parseBatch(this.read('batch',undefined,Buffer.from(oids.join('\n')+'\n')),oids,format);}
 ancestor(older,newer,format='sha1'){
  if(!['sha1','sha256'].includes(format)||![older,newer].every(v=>typeof v==='string'&&new RegExp('^[a-f0-9]{'+(format==='sha1'?40:64)+'}$').test(v)))fail('ANCESTRY_INPUT');
  if(this.drained()!==true)fail('DRAIN_REQUIRED');
  const seen=new Set(),queue=[newer];let found=false;
  // Read verified raw commit objects, not rev-list helpers, replacements or network fetches.
  for(let at=0;at<queue.length;at++){
   const id=queue[at];if(seen.has(id))continue;if(seen.size>=16384)fail('ANCESTRY_LIMIT');seen.add(id);
   const object=this.objects([id],format).get(id);if(object?.type!=='commit')fail('ANCESTRY_OBJECT');
   const end=object.data.indexOf(Buffer.from('\n\n'));if(end<0||end>1048576)fail('ANCESTRY_OBJECT');
   const lines=object.data.subarray(0,end).toString('utf8').split('\n'),oid=new RegExp('^[a-f0-9]{'+(format==='sha1'?40:64)+'}$');
   if(!lines[0].startsWith('tree ')||!oid.test(lines[0].slice(5)))fail('ANCESTRY_OBJECT');
   const parents=lines.filter(x=>x.startsWith('parent ')).map(x=>x.slice(7));
   if(parents.length>16||parents.some(x=>!oid.test(x)))fail('ANCESTRY_OBJECT');
   if(id===older){found=true;break;}queue.push(...parents);
  }
  if(this.drained()!==true)fail('DRAIN_REQUIRED');return found;
 }
 compile(input){
  // Inputs are resolved by the runtime from an immutable, checked preview and
  // operator-configured author identity. This reads only; staging rechecks the
  // complete preflight again before persisting the approval plan.
  if(this.drained()!==true)fail('DRAIN_REQUIRED');
  if(input.parent!==this.b.base_sha||input.branch!==this.b.branch)fail('BINDING');
  const identity=this.identity(),meta=this.metadata();config(this.read('config'),this.b.url);
  const format=this.read('format').toString('ascii').trim();
  if(this.read('branch').toString('ascii').trim()!=='refs/heads/'+this.b.branch||
   this.read('head').toString('ascii').trim()!==input.parent||this.read('ref',this.b.branch).toString('ascii').trim()!==input.parent)fail('BASELINE_CHANGED');
  const base=entries(this.read('tree',input.parent)),raw=this.objects([...new Set(base.map(x=>x.oid))],format);
  if(this.read('root-tree',input.parent).toString('ascii').trim()!==indexTree(base,format))fail('BASELINE_TREE_UNSUPPORTED');
  const baseline=base.map(x=>{const o=raw.get(x.oid);if(o?.type!=='blob')fail('BASELINE_OBJECT');return {path:x.path,mode:x.mode,bytes:o.data};});
  const compiled=compileCommit({...input,format,baseline,files:this.inventory()});
  if(!same(identity,this.identity())||!same(meta,this.metadata())||this.drained()!==true)fail('STATE_CHANGED');
  return {...compiled,workspace_identity:identity};
 }
 capture(intent){
  const {fingerprint,...body}=intent??{},p=intent?.plan,{fingerprint:pf,...pb}=p??{};
  if(intent?.kind!=='commit-execution-intent-v1'||digest(body)!==fingerprint||digest(pb)!==pf||p.kind!=='commit-objects-v1'||p.persisted!==false||p.grants_execution!==false)fail('INTENT_CHANGED');
  if(this.drained()!==true)fail('DRAIN_REQUIRED');
  const identity=this.identity(),meta=this.metadata();if(!same(identity,intent.workspace_identity)||this.b.url!==intent.resource||this.b.branch!==p.branch||this.b.base_sha!==p.parent)fail('WORKSPACE_CHANGED');
  config(this.read('config'),this.b.url);const format=this.read('format').toString('ascii').trim();if(format!==p.format)fail('FORMAT_CHANGED');
  const branch=this.read('branch').toString('ascii').trim();if(branch!=='refs/heads/'+p.branch)fail('BRANCH_CHANGED');
  const head=this.read('head').toString('ascii').trim(),ref=this.read('ref',p.branch).toString('ascii').trim();if(!validOID(head)||!validOID(ref))fail('REFERENCE_INVALID');
  const baseEntries=entries(this.read('tree',p.parent)),baseObjects=this.objects([...new Set(baseEntries.map(x=>x.oid))],format);
  if(this.read('root-tree',p.parent).toString('ascii').trim()!==indexTree(baseEntries,format))fail('BASELINE_TREE_UNSUPPORTED');
  const baseline=baseEntries.map(x=>{const o=baseObjects.get(x.oid);if(!o||o.type!=='blob')fail('BASELINE_OBJECT');return {path:x.path,mode:x.mode,bytes:o.data};});
  const actual=this.inventory(),compiled=compileCommit({format,parent:p.parent,branch:p.branch,baseline,files:actual,changes:p.changes,tested_content:p.tested_content,author:p.author,committer:p.committer,when:p.when,message:p.message});
  if(compiled.plan.fingerprint!==p.fingerprint)fail('PLAN_CHANGED');
  const index=entries(this.read('index'),true),tree=indexTree(index,format),flags=this.read('flags').toString('utf8').split('\0').filter(Boolean);
  if(flags.length!==index.length||!same(flags.map(x=>{if(!x.startsWith('H '))fail('INDEX_FLAGS_UNSUPPORTED');return x.slice(2);}).sort(),index.map(x=>x.path).sort()))fail('INDEX_FLAGS_UNSUPPORTED');
  const objects=this.objects(p.objects.map(x=>x.oid),format);
  for(const o of p.objects){const got=objects.get(o.oid);if(got&&(got.type!==o.type||got.data.length!==o.bytes))fail('OBJECT_INVALID');}
  if(!same(identity,this.identity())||!same(meta,this.metadata())||this.read('head').toString('ascii').trim()!==head||
   this.read('ref',p.branch).toString('ascii').trim()!==ref||this.read('branch').toString('ascii').trim()!==branch||this.drained()!==true)fail('STATE_CHANGED');
  const second=this.inventory();if(!same(actual.map(x=>({path:x.path,mode:x.mode,hash:sha(x.bytes)})),second.map(x=>({path:x.path,mode:x.mode,hash:sha(x.bytes)}))))fail('WORKTREE_CHANGED');
  const state={kind:'git-state-v1',intent_fingerprint:fingerprint,workspace_identity:identity,branch:p.branch,head_oid:head,ref_oid:ref,index_tree_oid:tree,
   parent_tree_oid:indexTree(baseEntries,format),manifest_sha256:p.manifest_sha256,metadata:meta,objects_present:p.objects.filter(x=>objects.get(x.oid)).map(x=>x.oid).sort()};
  return {...state,fingerprint:digest(state)};
 }
 preflight(intent){
  const s=this.capture(intent),p=intent.plan;
  if(s.head_oid!==p.parent||s.ref_oid!==p.parent||s.index_tree_oid!==s.parent_tree_oid)fail('BASELINE_CHANGED');
  validateGitBaseline(intent,s);
  return {intent_fingerprint:intent.fingerprint,drained:true,manifest_sha256:s.manifest_sha256,workspace_identity:s.workspace_identity,branch:p.branch,parent:p.parent,baseline:s};
 }
 observe(intent){
  const s=this.capture(intent),p=intent.plan;
  if(s.head_oid!==p.computed_commit_oid||s.ref_oid!==p.computed_commit_oid||s.index_tree_oid!==p.tree_oid||s.objects_present.length!==p.objects.length)fail('NOT_APPLIED');
  return {kind:'commit-readback-v1',intent_fingerprint:intent.fingerprint,drained:true,object_exists:true,head_oid:s.head_oid,ref_oid:s.ref_oid,
   commit_oid:p.computed_commit_oid,tree_oid:p.tree_oid,index_tree_oid:s.index_tree_oid,branch:p.branch,parent:p.parent,manifest_sha256:s.manifest_sha256,workspace_identity:s.workspace_identity};
 }
 unchanged(intent,baseline){
  validateGitBaseline(intent,baseline);const {fingerprint}=baseline;
  const current=this.preflight(intent).baseline;if(!same(current,baseline))fail('EFFECT_UNKNOWN');
  return {kind:'commit-not-applied-v1',intent_fingerprint:intent.fingerprint,baseline_fingerprint:fingerprint,drained:true,unchanged:true,object_presence_unchanged:true};
 }
}
