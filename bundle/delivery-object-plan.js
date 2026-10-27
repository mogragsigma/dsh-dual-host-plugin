import {managedTaskBranch} from './task-branch.js';
// Pure Git object compiler. No filesystem, child process, network or repository writes.
// A computed OID is NOT evidence an object exists or a branch was committed.
import {createHash} from 'node:crypto';
import {developmentPath} from './development-plan.js';
import {digest,canonical} from './approval-ledger.js';
const fail=code=>{throw Error('DELIVERY_OBJECT_'+code);};
const formats=new Map([['sha1',40],['sha256',64]]);
const text=(s,n)=>typeof s==='string'&&s.length>0&&Buffer.byteLength(s)<=n;
const oid=(x,format)=>typeof x==='string'&&new RegExp('^[a-f0-9]{'+formats.get(format)+'}$').test(x);
export function gitObject(type,data,format='sha1'){
 if(!formats.has(format)||!['blob','tree','commit'].includes(type)||!Buffer.isBuffer(data))fail('INVALID');
 const bytes=Buffer.from(data),id=createHash(format).update(type+' '+bytes.length+'\0').update(bytes).digest('hex');
 return {oid:id,type,data:bytes};
}
function files(input,format){
 if(!Array.isArray(input)||input.length>4096)fail('LIMIT');const out=new Map(),names=new Map();let total=0;
 for(const f of input){
  if(!f||Object.keys(f).some(k=>!['path','mode','bytes'].includes(k))||![0o644,0o755].includes(f.mode)||!Buffer.isBuffer(f.bytes)||f.bytes.length>8388608)fail('FILE_INVALID');
  developmentPath(f.path);if(Buffer.from(f.path).toString('utf8')!==f.path)fail('PATH_CONFLICT');if(out.has(f.path))fail('PATH_CONFLICT');
  const parts=f.path.split('/');for(let i=1;i<=parts.length;i++){
   const path=parts.slice(0,i).join('/'),key=path.normalize('NFC').toLowerCase();
   if(names.has(key)&&names.get(key)!==path)fail('PATH_CONFLICT');names.set(key,path);
  }
  total+=f.bytes.length;if(total>33554432)fail('LIMIT');const b=gitObject('blob',f.bytes,format);
  out.set(f.path,{path:f.path,mode:f.mode,blob:b,sha256:createHash('sha256').update(b.data).digest('hex')});
 }
 for(const path of out.keys())for(let i=path.indexOf('/');i!==-1;i=path.indexOf('/',i+1))if(out.has(path.slice(0,i)))fail('PATH_CONFLICT');
 return out;
}
function treeOf(all,format,objects){
 const root=new Map();
 for(const f of [...all.values()].sort((a,b)=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path)))){
  let at=root;const parts=f.path.split('/');for(const name of parts.slice(0,-1)){if(!at.has(name))at.set(name,new Map());at=at.get(name);}
  at.set(parts.at(-1),f);objects.set(f.blob.oid,f.blob);
 }
 const visit=dir=>{
  // Git compares a directory as name + '/', not as the bare directory name.
  const entries=[...dir].map(([name,v])=>({name,dir:v instanceof Map,value:v})).sort((a,b)=>Buffer.compare(Buffer.from(a.name+(a.dir?'/':'')),Buffer.from(b.name+(b.dir?'/':''))));
  const chunks=entries.map(e=>{
   const obj=e.dir?visit(e.value):e.value.blob,mode=e.dir?'40000':e.value.mode===0o755?'100755':'100644';
   return Buffer.concat([Buffer.from(mode+' '+e.name+'\0'),Buffer.from(obj.oid,'hex')]);
  });
  const result=gitObject('tree',Buffer.concat(chunks),format);objects.set(result.oid,result);return result;
 };return visit(root);
}
// Compute a tree from index entries without creating objects or reading their bytes.
export function indexTree(entries,format='sha1'){
 if(!formats.has(format)||!Array.isArray(entries))fail('INVALID');
 const normalized=files(entries.map(e=>({path:e.path,mode:e.mode,bytes:Buffer.alloc(0)})),format);
 for(const e of entries){if(!oid(e.oid,format))fail('INVALID');normalized.get(e.path).blob={oid:e.oid,type:'blob',data:Buffer.alloc(0)};}
 return treeOf(normalized,format,new Map()).oid;
}
function identity(v){
 if(!v||Object.keys(v).some(k=>!['name','email'].includes(k))||!text(v.name,256)||v.name.trim()!==v.name||/[<>\x00-\x1f\x7f]/.test(v.name)||!text(v.email,254)||!/^[A-Za-z0-9._+\-]+@[A-Za-z0-9.-]+$/.test(v.email))fail('IDENTITY');
 return {...v};
}
export function compileCommit(v){
 if(!v||Object.keys(v).some(k=>!['format','parent','branch','baseline','files','changes','tested_content','author','committer','when','message'].includes(k)))fail('INVALID');
 const format=v.format??'sha1';if(!formats.has(format)||!oid(v.parent,format)||!managedTaskBranch(v.branch))fail('REFERENCE');
 if(!Number.isSafeInteger(v.when)||v.when<0||v.when>253402300799||!text(v.message,2000)||!v.message.trim()||/[\x00-\x09\x0b-\x1f\x7f]/.test(v.message))fail('METADATA');
 const author=identity(v.author),committer=identity(v.committer),before=files(v.baseline,format),after=files(v.files,format);
 // Large assets may pass through unchanged; new/modified blobs keep the 1 MiB cap.
 for(const [path,f] of after)if(f.blob.data.length>1048576&&before.get(path)?.blob.oid!==f.blob.oid)fail('FILE_INVALID');
 if(!Array.isArray(v.changes)||!v.changes.length||v.changes.length>128)fail('CHANGES');const allowed=new Map();
 for(const f of v.changes){
  if(!f||Object.keys(f).some(k=>!['path','action','before_sha256','after_sha256'].includes(k))||!['create','modify','delete'].includes(f.action))fail('CHANGES');developmentPath(f.path);
  if([...allowed.keys()].some(p=>p.normalize('NFC').toLowerCase()===f.path.normalize('NFC').toLowerCase())||f.before_sha256!==(before.get(f.path)?.sha256??null)||f.after_sha256!==(after.get(f.path)?.sha256??null))fail('CONTENT_MISMATCH');
  if(f.action==='create'?(before.has(f.path)||!after.has(f.path)):f.action==='modify'?(!before.has(f.path)||!after.has(f.path)):(!before.has(f.path)||after.has(f.path)))fail('CHANGES');allowed.set(f.path,f);
 }
 for(const path of new Set([...before.keys(),...after.keys()])){
  const a=before.get(path),b=after.get(path),f=allowed.get(path);
  if(!f&&(a?.blob.oid!==b?.blob.oid||a?.mode!==b?.mode))fail('OUT_OF_SCOPE');
  if(f&&Math.max(a?.blob.data.length??0,b?.blob.data.length??0)>1048576)fail('CHANGED_FILE_LIMIT');
  if(f&&b&&b.mode!==(a?.mode??0o644))fail('MODE_CHANGED');
 }
 if(![...allowed.values()].some(x=>x.before_sha256!==x.after_sha256))fail('NO_CHANGES');
 const manifest=Object.fromEntries([...after.keys()].sort().map(p=>[p,{sha256:after.get(p).sha256,mode:after.get(p).mode}])),content=digest(manifest);
 const tested=v.tested_content;
 if(!tested||Object.keys(tested).some(k=>!['kind','sha256'].includes(k))||
  (tested.kind==='workspace_manifest_sha256'?tested.sha256!==content:tested.kind==='file_sha256'?allowed.size!==1||[...allowed.values()][0].action!=='create'||tested.sha256!==[...allowed.values()][0].after_sha256:true))fail('TEST_CONTENT_MISMATCH');
 const objects=new Map(),tree=treeOf(after,format,objects),line=p=>`${p.name} <${p.email}> ${v.when} +0000`,message=v.message.endsWith('\n')?v.message:v.message+'\n';
 const commit=gitObject('commit',Buffer.from(`tree ${tree.oid}\nparent ${v.parent}\nauthor ${line(author)}\ncommitter ${line(committer)}\n\n${message}`),format);objects.set(commit.oid,commit);
 const body={schema:1,kind:'commit-objects-v1',format,parent:v.parent,branch:v.branch,tree_oid:tree.oid,computed_commit_oid:commit.oid,manifest_sha256:content,tested_content:{...tested},author,committer,when:v.when,message,
  changes:[...allowed.values()].map(x=>({...x})).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0),objects:[...objects.values()].map(o=>({oid:o.oid,type:o.type,bytes:o.data.length})),persisted:false,grants_execution:false,remote_acceptance:'not_observed',runtime_adoption:'not_observed'};
 return {plan:{...body,fingerprint:digest(body)},objects:[...objects.values()]};
}
export function verifyObjects(plan,objects){
 const {fingerprint,...body}=plan??{};
 if(!fingerprint||digest(body)!==fingerprint||plan.schema!==1||plan.kind!=='commit-objects-v1'||
  plan.persisted!==false||plan.grants_execution!==false||plan.remote_acceptance!=='not_observed'||plan.runtime_adoption!=='not_observed'||
  !Array.isArray(plan.objects)||!Array.isArray(objects)||objects.length!==plan.objects.length||!objects.length||objects.length>65536)fail('PLAN_CHANGED');
 if(!formats.has(plan.format)||!oid(plan.parent,plan.format)||!managedTaskBranch(plan.branch))fail('PLAN_CHANGED');
 identity(plan.author);identity(plan.committer);
 if(!Number.isSafeInteger(plan.when)||plan.when<0||plan.when>253402300799||!text(plan.message,2001)||
  !plan.message.trim()||!plan.message.endsWith('\n')||/[\x00-\x09\x0b-\x1f\x7f]/.test(plan.message))fail('PLAN_CHANGED');
 const byId=new Map(),used=new Set();let size=0;
 for(let i=0;i<objects.length;i++){
  const o=objects[i],expected=plan.objects[i],fresh=gitObject(o.type,o.data,plan.format);
  if(o.oid!==fresh.oid||byId.has(o.oid)||canonical(expected)!==canonical({oid:fresh.oid,type:fresh.type,bytes:fresh.data.length}))fail('PLAN_CHANGED');
  byId.set(o.oid,fresh);size+=fresh.data.length;if(size>40000000)fail('LIMIT');
 }
 const get=(id,type)=>{const o=byId.get(id);if(!o||o.type!==type)fail('PLAN_CHANGED');used.add(id);return o;};
 const line=p=>`${p.name} <${p.email}> ${plan.when} +0000`;
 const expected=Buffer.from(`tree ${plan.tree_oid}\nparent ${plan.parent}\nauthor ${line(plan.author)}\ncommitter ${line(plan.committer)}\n\n${plan.message}`);
 if(!get(plan.computed_commit_oid,'commit').data.equals(expected))fail('PLAN_CHANGED');
 let walked=0;const decoded=[],stack=new Set(),rawLength=formats.get(plan.format)/2;
 const walk=(id,prefix)=>{
  if(++walked>65536||stack.has(id)||prefix.length>512)fail('PLAN_CHANGED');stack.add(id);
  const data=get(id,'tree').data;let at=0,last=null;
  while(at<data.length){
   const end=data.indexOf(0,at);if(end<0||end+1+rawLength>data.length)fail('PLAN_CHANGED');
   const header=data.subarray(at,end),s=header.toString('utf8');
   if(!Buffer.from(s).equals(header))fail('PLAN_CHANGED');const m=/^(40000|100644|100755) (.+)$/u.exec(s);if(!m||m[2].includes('/'))fail('PLAN_CHANGED');
   const path=prefix+m[2];developmentPath(path);const dir=m[1]==='40000',sort=Buffer.from(m[2]+(dir?'/':''));
   if(last&&Buffer.compare(last,sort)>=0)fail('PLAN_CHANGED');last=sort;
   const child=data.subarray(end+1,end+1+rawLength).toString('hex');at=end+1+rawLength;
   if(dir)walk(child,path+'/');else decoded.push({path,mode:m[1]==='100755'?0o755:0o644,bytes:get(child,'blob').data});
   if(decoded.length>4096)fail('LIMIT');
  }stack.delete(id);
 };walk(plan.tree_oid,'');
 const checked=files(decoded,plan.format),manifest=Object.fromEntries([...checked.keys()].sort().map(p=>[p,{sha256:checked.get(p).sha256,mode:checked.get(p).mode}]));
 // Rebuild to reject empty/unreachable directories and noncanonical object graphs.
 const rebuilt=treeOf(checked,plan.format,new Map());
 if(rebuilt.oid!==plan.tree_oid||used.size!==objects.length||digest(manifest)!==plan.manifest_sha256)fail('PLAN_CHANGED');
 if(!Array.isArray(plan.changes)||!plan.changes.length||plan.changes.length>128)fail('PLAN_CHANGED');
 const paths=new Set();for(const change of plan.changes){
  if((checked.get(change.path)?.blob.data.length??0)>1048576)fail('PLAN_CHANGED');
  developmentPath(change.path);const key=change.path.normalize('NFC').toLowerCase();
  if(paths.has(key)||!['create','modify','delete'].includes(change.action)||change.after_sha256!==(checked.get(change.path)?.sha256??null)||
   (change.action==='create'?change.before_sha256!==null:!oid(change.before_sha256,'sha256'))||
   (change.action==='delete'?checked.has(change.path):!checked.has(change.path)))fail('PLAN_CHANGED');paths.add(key);
 }
 const tested=plan.tested_content;
 if(!tested||(tested.kind==='workspace_manifest_sha256'?tested.sha256!==plan.manifest_sha256:
  tested.kind==='file_sha256'?plan.changes.length!==1||plan.changes[0].action!=='create'||tested.sha256!==plan.changes[0].after_sha256:true))fail('PLAN_CHANGED');
 return {verified:true,persisted:false,grants_execution:false};
}
