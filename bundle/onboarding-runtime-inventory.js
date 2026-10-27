// Original-archive inventory scanner. Omission is internal and only for manifest-owned repair files.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
const identity=s=>({dev:s.dev,ino:s.ino,uid:s.uid,mode:s.mode&0o777});
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fail=c=>{throw Error('ONBOARDING_CLOUD_'+c);};
export async function runtimeInventory(q,omit=null){
 const root=path.join(q.root,'runtime'),out=[],pending=new Set();let count=0,error=null;
 // Bounded reads, not cached hashes: every invocation still checks every byte.
 // Reserve output slots during the ordered walk so completion order cannot
 // change the signed inventory representation. Always drain before returning.
 async function file(p,s,entry,index){
  const h=await fs.open(p,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const unchanged=x=>x.isFile()&&x.nlink===1&&same(identity(s),identity(x))&&x.size===s.size&&x.mtimeMs===s.mtimeMs&&x.ctimeMs===s.ctimeMs;
  try{
   if(!unchanged(await h.stat()))fail('RUNTIME_INVENTORY_DRIFT');
   const digest=createHash('sha256'),buffer=Buffer.allocUnsafe(Math.min(s.size+1,262144));let total=0;
   for(;;){const {bytesRead}=await h.read(buffer,0,buffer.length,null);if(!bytesRead)break;total+=bytesRead;if(total>s.size)fail('RUNTIME_INVENTORY_DRIFT');digest.update(buffer.subarray(0,bytesRead));}
   if(total!==s.size||!unchanged(await h.stat())||!unchanged(await fs.lstat(p)))fail('RUNTIME_INVENTORY_DRIFT');
   out[index]={...entry,kind:'file',bytes:s.size,sha256:digest.digest('hex')};
  }finally{await h.close();}
 }
 async function enqueue(p,s,entry){
  if(pending.size>=4)await Promise.race(pending);if(error)throw error;
  const index=out.length;out.push(null);
  const work=file(p,s,entry,index).catch(e=>{error??=e;}).finally(()=>pending.delete(work));pending.add(work);
 }
 async function visit(p){
  if(error)throw error;if(++count>150000)fail('RUNTIME_INVENTORY_LIMIT');const name=path.relative(q.root,p);if(omit?.has(name))return;const s=await fs.lstat(p),entry={path:name,...identity(s)};
  if(s.uid!==process.getuid())fail('RUNTIME_INVENTORY_REVIEW');
  if(s.isSymbolicLink()){const target=await fs.readlink(p),resolved=path.resolve(path.dirname(p),target);if(!(resolved===root||resolved.startsWith(root+path.sep))||path.isAbsolute(target))fail('RUNTIME_LINK_REVIEW');out.push({...entry,kind:'link',target});}
  else if(s.isDirectory()){out.push({...entry,kind:'directory'});for(const child of (await fs.readdir(p)).sort())await visit(path.join(p,child));}
  else if(s.isFile()&&s.nlink===1)await enqueue(p,s,entry);
  else fail('RUNTIME_INVENTORY_REVIEW');
 }
 try{let exists=true;try{await fs.lstat(root);}catch(e){if(e.code!=='ENOENT')throw e;exists=false;}if(exists)await visit(root);}catch(e){error??=e;}
 await Promise.all(pending);if(error)throw error;return out;
}

const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
// A launch may add only its four zero-model admission sessions to deletion ownership.
// This does NOT adopt the rest of native-home/workspace, refresh the original inventory,
// or recognize a session merely because its name resembles ours.
export function runtimeAdmissionDelta(before,after,nonce){
 if(!uuid(nonce)||before.some(x=>x.path.includes(nonce)))fail('RUNTIME_ADMISSION_OWNERSHIP_REVIEW');
 const previous=new Map(before.map(x=>[x.path,x])),items=[];let project;
 for(const preset of ['standard','ptc','cordis','minimal']){
  const id='onboarding-check-'+nonce+'-'+preset;
  const dirs=after.filter(x=>x.kind==='directory'&&x.path.startsWith('runtime/native-home/dsh/sessions/')&&x.path.split('/').length===6&&x.path.endsWith('/'+id));
  if(dirs.length!==1)fail('RUNTIME_ADMISSION_OWNERSHIP_REVIEW');
  const dir=dirs[0].path,parent=path.dirname(dir);
  if(project&&project!==parent)fail('RUNTIME_ADMISSION_OWNERSHIP_REVIEW');project=parent;
  const expected=[[dir,'directory'],[dir+'/session.lock','file'],[dir+'/session.v4.jsonl.zstd','file'],['runtime/native-home/dsh/storages/session_projcache/sessions/'+id+'.json','file']];
  for(const [name,kind] of expected){
   const matches=after.filter(x=>x.path===name),entry=matches[0],oldParent=previous.get(path.dirname(name)),newParent=after.find(x=>x.path===path.dirname(name));
   if(previous.has(name)||matches.length!==1||entry.kind!==kind||entry.uid!==process.getuid()||entry.mode!==(kind==='directory'?0o700:0o600)||kind==='file'&&!hex(entry.sha256))fail('RUNTIME_ADMISSION_OWNERSHIP_REVIEW');
   if(path.dirname(name)!==dir&&(!oldParent||oldParent.kind!=='directory'||hash(oldParent)!==hash(newParent)))fail('RUNTIME_ADMISSION_OWNERSHIP_REVIEW');
   items.push(entry);
  }
 }
 const owned=new Set(items.map(x=>x.path));
 if(after.some(x=>x.path.includes(nonce)&&!owned.has(x.path)))fail('RUNTIME_ADMISSION_OWNERSHIP_REVIEW');
 return items;
}

// Only the signed original/effective inventory may be supplied by the archived
// controller. No current directory is adopted and no deletion ownership is refreshed.
export async function verifyRuntimePlugin(q,items){
 const rows=items.filter(x=>x.path==='runtime/plugin'||x.path.startsWith('runtime/plugin/')),names=new Set(rows.map(x=>x.path));
 if(!rows.length||names.size!==rows.length||!rows.some(x=>x.path==='runtime/plugin'&&x.kind==='directory'))fail('RUNTIME_HOST_SOURCE_CHANGED');
 for(const x of rows){
  if(path.posix.normalize(x.path)!==x.path||x.path.includes('\\')||!['file','directory'].includes(x.kind))fail('RUNTIME_HOST_SOURCE_CHANGED');
  const p=path.join(q.root,x.path),s=await fs.lstat(p);
  if(s.isSymbolicLink()||!same(identity(s),{dev:x.dev,ino:x.ino,uid:x.uid,mode:x.mode})||s.uid!==process.getuid())fail('RUNTIME_HOST_SOURCE_CHANGED');
  if(x.kind==='directory'){
   const children=rows.filter(y=>path.posix.dirname(y.path)===x.path).map(y=>path.posix.basename(y.path)).sort();
   if(!s.isDirectory()||hash((await fs.readdir(p)).sort())!==hash(children))fail('RUNTIME_HOST_SOURCE_CHANGED');
  }else{
   if(!s.isFile()||s.nlink!==1||s.size!==x.bytes)fail('RUNTIME_HOST_SOURCE_CHANGED');
   const handle=await fs.open(p,constants.O_RDONLY|constants.O_NOFOLLOW);
   try{const before=await handle.stat(),b=await handle.readFile(),after=await handle.stat();if(!same(identity(before),identity(s))||!same(identity(after),identity(s))||before.size!==after.size||before.mtimeMs!==after.mtimeMs||createHash('sha256').update(b).digest('hex')!==x.sha256)fail('RUNTIME_HOST_SOURCE_CHANGED');}finally{await handle.close();}
  }
 }
}
