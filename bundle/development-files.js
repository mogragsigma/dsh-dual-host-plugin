import {createHash,randomUUID} from 'node:crypto';
import {lstatSync,readdirSync,readFileSync,openSync,closeSync,writeFileSync,fsyncSync,renameSync,unlinkSync,mkdirSync,chmodSync,constants} from 'node:fs';
import {join,dirname} from 'node:path';
import {DevelopmentWorkspace,contentHash} from './development-workspace.js';
import {workspacePlan,developmentPath} from './development-plan.js';
import {digest} from './approval-ledger.js';
const absent=e=>{if(e.code==='ENOENT')return null;throw e;};
const MAX_FILE=1048576,MAX_TOTAL=33554432,MAX_FILES=4096;
export class DevelopmentFiles extends DevelopmentWorkspace {
 constructor(binding,spec,snapshot){super(binding,{...spec,file:'unused'},snapshot);this.spec=workspacePlan(spec);}
 // Hash every regular file, including ignored files. Git assume-unchanged/filter tricks
 // must not hide an out-of-scope edit. The .git directory is never given to commands.
 inventory(){
  const out=Object.create(null);let bytes=0;
  const walk=(dir,base='')=>{for(const name of readdirSync(dir).sort()){
   if(!base&&name==='.git')continue;
   const p=base?base+'/'+name:name;developmentPath(p);const path=join(dir,name),s=lstatSync(path);
   if(s.isSymbolicLink())throw Error('DEVELOPMENT_FILE_UNSAFE');
   if(s.isDirectory()){walk(path,p);continue;}
   if(!s.isFile()||s.nlink!==1||s.size>8388608)throw Error('DEVELOPMENT_FILE_UNSAFE');
   const data=readFileSync(path);bytes+=data.length;if(bytes>MAX_TOTAL||Object.keys(out).length>=MAX_FILES)throw Error('DEVELOPMENT_WORKSPACE_LIMIT');
   out[p]={hash:contentHash(data),git_hash:createHash('sha1').update('blob '+data.length+'\0').update(data).digest('hex'),
    git_sha256:createHash('sha256').update('blob '+data.length+'\0').update(data).digest('hex'),mode:s.mode&0o111?0o755:0o644};
  }};walk(this.root);return out;
 }
 baseline(){
  this.identity();
  if(this.git(['rev-parse','--show-toplevel']).trim()!==this.root||this.git(['rev-parse','--absolute-git-dir']).trim()!==join(this.root,'.git'))throw Error('DEVELOPMENT_ROOT_CHANGED');
  if(this.git(['symbolic-ref','--short','HEAD']).trim()!==this.spec.branch||this.git(['rev-parse','HEAD']).trim()!==this.b.base_sha)throw Error('DEVELOPMENT_BASELINE_CHANGED');
  if(this.git(['remote','get-url','origin']).trim().replace(/\.git$/,'')!==this.b.url)throw Error('DEVELOPMENT_REMOTE_CHANGED');
  if(this.git(['diff','--cached','--raw','--no-ext-diff','--no-textconv','HEAD']).trim())throw Error('DEVELOPMENT_STAGED_CHANGES');
  const entries=Object.create(null);for(const raw of this.git(['ls-tree','-r','-z','HEAD']).split('\0').filter(Boolean)){
   const m=/^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/.exec(raw);
   if(!m)throw Error('DEVELOPMENT_BASELINE_UNSUPPORTED');developmentPath(m[3]);entries[m[3]]={oid:m[2],mode:m[1]==='100755'?0o755:0o644};
  }return entries;
 }
 check(expectedHash){
  const base=this.baseline(),actual=this.inventory(),allowed=new Map(this.spec.files.map(f=>[f.path,f]));
  for(const f of this.spec.files){
   if(f.action==='create'&&base[f.path]||f.action!=='create'&&!base[f.path])throw Error('DEVELOPMENT_PLAN_BASELINE_MISMATCH');
   if(f.action!=='create'){
    // Binding to HEAD and to the approved sha256 prevents approval on another revision.
    const bytes=this.git(['show',this.b.base_sha+':'+f.path]);
    if(contentHash(Buffer.from(bytes))!==f.base_sha256)throw Error('DEVELOPMENT_PLAN_BASELINE_MISMATCH');
   }
  }
  for(const f of this.spec.reads)if(!actual[f.path]||actual[f.path].hash!==f.sha256)throw Error('DEVELOPMENT_INPUT_CHANGED');
  for(const p of new Set([...Object.keys(base),...Object.keys(actual)])){
   const f=allowed.get(p),b=base[p],a=actual[p];
   if(!f){if(!a||!b||(b.oid.length===40?a.git_hash:a.git_sha256)!==b.oid||a.mode!==b.mode)throw Error('DEVELOPMENT_OUT_OF_SCOPE_CHANGE');}
   else{
    if(f.action==='modify'&&!a)throw Error('DEVELOPMENT_FILE_CONFLICT');
    if(a&&a.mode!==(b?.mode??0o644))throw Error('DEVELOPMENT_MODE_CHANGED');
    if(expectedHash===null&&((a?.hash??null)!==f.base_sha256))throw Error('DEVELOPMENT_FILE_CONFLICT');
   }
  }
  const manifest=Object.fromEntries(Object.keys(actual).sort().map(p=>[p,{sha256:actual[p].hash,mode:actual[p].mode}]));
  const hash=digest(manifest);if(expectedHash!==null&&hash!==expectedHash)throw Error('DEVELOPMENT_FILE_CONFLICT');
  return {hash,manifest,files:this.spec.files.map(f=>({path:f.path,action:f.action,sha256:actual[f.path]?.hash??null})),reads:this.spec.reads};
 }
 read(expectedHash,path){
  const state=this.check(expectedHash);if(path===undefined)return state;
  if(![...this.spec.files,...this.spec.reads].some(f=>f.path===path))throw Error('DEVELOPMENT_READ_DENIED');
  if(state.manifest[path]&&lstatSync(join(this.root,path)).size>MAX_FILE)throw Error('DEVELOPMENT_READ_LIMIT');
  const content=state.manifest[path]?readFileSync(join(this.root,path),'utf8'):null;
  if(content!==null&&content.includes('\0'))throw Error('DEVELOPMENT_BINARY_EDIT_UNSUPPORTED');
  return {...state,path,content,base_sha256:state.manifest[path]?.sha256??null};
 }
 prepare(expectedHash,{path,content}){
  developmentPath(path);const state=this.check(expectedHash),file=this.spec.files.find(f=>f.path===path);
  if(!file)throw Error('DEVELOPMENT_WRITE_DENIED');
  if(file.action==='delete'?content!==null:typeof content!=='string'||content.includes('\0')||Buffer.byteLength(content)>MAX_FILE)throw Error('DEVELOPMENT_CONTENT_INVALID');
  const manifest=structuredClone(state.manifest);
  if(content===null)delete manifest[path];else manifest[path]={sha256:contentHash(content),mode:state.manifest[path]?.mode??0o644};
  return {hash:digest(manifest),manifest,path,content};
 }
 write(change,expectedHash){
  const prepared=this.prepare(expectedHash,change),dest=join(this.root,prepared.path);
  if(prepared.content===null){try{unlinkSync(dest);}catch(e){absent(e);}}
  else{
   mkdirSync(dirname(dest),{recursive:true});const temp=join(dirname(dest),'.dsh-dev-'+randomUUID());let fd;
   try{fd=openSync(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,prepared.manifest[prepared.path].mode);
    writeFileSync(fd,prepared.content);fsyncSync(fd);}finally{if(fd!==undefined)closeSync(fd);}
   renameSync(temp,dest);
  }
  let fd=openSync(dirname(dest),'r');try{fsyncSync(fd);}finally{closeSync(fd);}
  this.check(prepared.hash);return prepared.hash;
 }
 snapshot(expectedHash,destination){
  const state=this.check(expectedHash);mkdirSync(destination,{recursive:false,mode:0o755});
  for(const f of [...this.spec.files,...this.spec.reads]){
   if(!state.manifest[f.path])continue;
   const data=readFileSync(join(this.root,f.path));if(contentHash(data)!==state.manifest[f.path].sha256)throw Error('DEVELOPMENT_FILE_CONFLICT');
   const dest=join(destination,f.path);mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,data,{flag:'wx',mode:0o444});chmodSync(dest,0o444);
  }
  // Host umask may be 077. Read access is limited to this generated snapshot,
  // not granted on any source/credential directory. Container bind stays read-only.
  const readable=dir=>{chmodSync(dir,0o755);for(const name of readdirSync(dir)){const p=join(dir,name);if(lstatSync(p).isDirectory())readable(p);}};readable(destination);
  this.check(state.hash);return state;
 }
}
