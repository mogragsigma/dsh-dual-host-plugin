// Fixed private SSH program. No network listener, model tool or arbitrary command interface.
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash,createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
const OWNER='dsh-dual-host-onboarding';
const hash=x=>createHash('sha256').update(typeof x==='string'||Buffer.isBuffer(x)?x:JSON.stringify(x)).digest('hex');
const fail=code=>{throw Error('ONBOARDING_CLOUD_'+code);};
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const sign=(body,proof)=>createHmac('sha256',proof).update(JSON.stringify(body)).digest('hex');
const signed=(body,proof)=>({...body,signature:sign(body,proof)});
function verified(value,proof){if(!value||!hex(value.signature))fail('JOURNAL_REVIEW');const {signature,...body}=value;if(!timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(sign(body,proof),'hex')))fail('JOURNAL_REVIEW');return body;}
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join()===keys.sort().join();
const identity=s=>({dev:s.dev,ino:s.ino,uid:s.uid,mode:s.mode&0o777});
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.uid===b.uid&&a.mode===b.mode;
const relative=p=>typeof p==='string'&&p.length<=256&&p.startsWith('plugin/')&&p.split('/').every(s=>s&&s!=='.'&&s!=='..'&&s!=='node_modules'&&!/[\x00-\x1f\x7f\\]/.test(s));
async function stat(p){try{return await fs.lstat(p);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function regular(p,limit=8388608){
 const s=await stat(p);if(!s)return null;
 if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>limit)fail('FILE_REVIEW');
 const h=await fs.open(p,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const a=await h.stat();if(!same(identity(a),identity(s)))fail('FILE_REVIEW');const data=await h.readFile();const b=await h.stat();if(a.mtimeMs!==b.mtimeMs||a.size!==b.size)fail('FILE_REVIEW');return {data,identity:identity(s),sha256:hash(data)};}finally{await h.close();}
}
async function writeNew(p,data){const h=await fs.open(p,'wx',0o600);try{await h.writeFile(data);await h.sync();}finally{await h.close();}}
async function syncDir(p){const h=await fs.open(p,'r');try{await h.sync();}finally{await h.close();}}
async function atomicJSON(p,value){
 const temp=p+'.'+randomUUID()+'.tmp';
 try{await writeNew(temp,JSON.stringify(value));await fs.rename(temp,p);await syncDir(path.dirname(p));}finally{await fs.unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
async function processInfo(pid=process.pid){
 if(process.platform!=='linux')return {platform:process.platform,pid,start:null,boot:null};
 const raw=await fs.readFile('/proc/'+pid+'/stat','utf8'),start=raw.slice(raw.lastIndexOf(')')+2).split(' ')[19];
 return {platform:'linux',pid,start,boot:(await fs.readFile('/proc/sys/kernel/random/boot_id','utf8')).trim()};
}
async function processActive(p){
 if(!p)return false;if(!Number.isSafeInteger(p.pid)||p.pid<1)fail('JOURNAL_REVIEW');
 try{if(p.platform==='linux'){const now=await processInfo(p.pid);return now.start===p.start&&now.boot===p.boot;}process.kill(p.pid,0);return true;}
 catch(e){if(['ENOENT','ESRCH'].includes(e.code))return false;fail('PROCESS_REVIEW');}
}
function base(q){
 if(!q||!uuid(q.operationId)||!uuid(q.installationId)||!hex(q.proof)||!hex(q.planHash)||typeof q.root!=='string'||q.root.length>700||q.root.split(path.sep).length>64||!path.isAbsolute(q.root)||path.normalize(q.root)!==q.root||/[\x00-\x1f\x7f]/.test(q.root)||path.basename(q.root)!=='host-'+q.installationId)fail('ARGUMENTS');
 if(q.root===os.homedir()||path.dirname(q.root)==='/')fail('UNSAFE_ROOT');
 return {owner:path.join(q.root,'.dsh-onboarding-owner.json'),journal:path.join(q.root,'.control/journal.json')};
}
function manifest(files,withData){
 if(!Array.isArray(files)||!files.length||files.length>512)fail('SOURCE_REVIEW');
 let total=0,last='';const result=[];
 for(const f of files){
  if(!exact(f,withData?['path','bytes','sha256','mode','data']:['path','bytes','sha256','mode'])||!relative(f.path)||f.path<=last||!Number.isSafeInteger(f.bytes)||f.bytes<0||f.bytes>4194304||!hex(f.sha256)||f.mode!==0o600)fail('SOURCE_REVIEW');
  if(withData){if(typeof f.data!=='string'||f.data.length>5592408)fail('SOURCE_REVIEW');const b=Buffer.from(f.data,'base64');if(b.toString('base64')!==f.data||b.length!==f.bytes||hash(b)!==f.sha256)fail('SOURCE_REVIEW');}
  total+=f.bytes;if(total>8388608)fail('SOURCE_REVIEW');last=f.path;result.push({path:f.path,bytes:f.bytes,sha256:f.sha256,mode:f.mode});
 }
 if(!result.some(x=>x.path==='plugin/package.json')||Buffer.byteLength(JSON.stringify(result))>65536)fail('SOURCE_REVIEW');return result;
}
async function checkAncestors(root,expected=null){
 let p=path.parse(root).root;const names=[p];for(const x of root.split(path.sep).filter(Boolean)){p=path.join(p,x);names.push(p);}
 if(expected&&(!Array.isArray(expected)||expected.length!==names.length||expected.some((x,i)=>x.path!==names[i])))fail('BASELINE_DRIFT');
 const result=[];
 for(let i=0;i<names.length;i++){
  const s=await stat(names[i]);if(s&&(s.isSymbolicLink()||!s.isDirectory()))fail('UNSAFE_PATH');
  if(expected){const e=expected[i];if(e.missing?s!==null:!s||!same(e,identity(s)))fail('BASELINE_DRIFT');}
  result.push(s?{path:names[i],...identity(s)}:{path:names[i],missing:true});
 }
 return result;
}
async function load(q){
 const files=base(q);await checkAncestors(q.root);
 const s=await stat(q.root);if(!s)return {state:'absent'};
 const stored=await regular(files.owner,131072);if(!stored||stored.identity.mode!==0o600||stored.identity.uid!==s.uid)fail('OWNER_REVIEW');
 let owner;try{owner=verified(JSON.parse(stored.data),q.proof);}catch{fail('OWNER_REVIEW');}
 if(!exact(owner,['owner','schema','installationId','operationId','planHash','proofHash','root','identity','parents','manifest','manifestHash','creator'])||owner.owner!==OWNER||owner.schema!==1||owner.root!==q.root||owner.operationId!==q.operationId||owner.installationId!==q.installationId||owner.planHash!==q.planHash||!hex(owner.proofHash)||!timingSafeEqual(Buffer.from(owner.proofHash,'hex'),Buffer.from(hash(q.proof),'hex'))||!same(identity(s),owner.identity))fail('OWNER_REVIEW');
 manifest(owner.manifest,false);if(hash(owner.manifest)!==owner.manifestHash||!Array.isArray(owner.parents))fail('OWNER_REVIEW');
 for(const a of owner.parents)if(!a||typeof a.path!=='string'||a.path==='/'||!q.root.startsWith(a.path+path.sep)||!Number.isSafeInteger(a.dev)||!Number.isSafeInteger(a.ino))fail('OWNER_REVIEW');
 const j=await regular(files.journal,131072);let journal=null;
 if(j){if(j.identity.mode!==0o600||j.identity.uid!==s.uid)fail('JOURNAL_REVIEW');try{journal=verified(JSON.parse(j.data),q.proof);}catch{fail('JOURNAL_REVIEW');}if(!exact(journal,['owner','schema','operationId','planHash','revision','state','written','error','process'])||journal.owner!==OWNER||journal.schema!==1||journal.operationId!==q.operationId||journal.planHash!==q.planHash||!Number.isSafeInteger(journal.revision)||!['preparing','prepared','rolling_back','needs_review'].includes(journal.state)||!Array.isArray(journal.written)||journal.written.some(x=>!owner.manifest.some(f=>f.path===x)))fail('JOURNAL_REVIEW');}
 const active=await processActive(journal?journal.process:owner.creator);
 return {state:journal?.state==='preparing'&&!active?'needs_review':journal?.state??(active?'preparing':'needs_review'),active,owner,ownerSnapshot:stored,journal,journalSnapshot:j,files};
}
const publicState=s=>({state:s.state,active:s.active??false,operationId:s.owner?.operationId??null,manifestHash:s.owner?.manifestHash??null,written:s.journal?.written.length??0,files:s.owner?.manifest.length??0,initialization:false,hostStarted:false});
export async function remoteControl(q,runtime={}){
 const names=['action','root','operationId','installationId','proof','planHash'];
 if(!['prepare','status','rollback'].includes(q?.action)||!exact(q,q.action==='prepare'?[...names,'baseline','files','manifestHash']:names))fail('ARGUMENTS');
 base(q);
 if(q.action==='status'){
  const s=await load(q);if(s.state==='absent')return publicState(s);
  const changed=[];for(const f of s.owner.manifest){const r=await regular(path.join(q.root,f.path));if(r&&(r.sha256!==f.sha256||r.identity.mode!==f.mode||r.identity.uid!==s.owner.identity.uid)||!r&&s.state==='prepared')changed.push(f.path);}
  return {...publicState(s),state:changed.length?'needs_review':s.state,changed};
 }
 if(q.action==='prepare'){
  const rows=manifest(q.files,true);if(!hex(q.manifestHash)||hash(rows)!==q.manifestHash)fail('SOURCE_REVIEW');
  if(await stat(q.root)){
   const s=await load(q);if(s.owner.manifestHash!==q.manifestHash)fail('SOURCE_CHANGED');
   if(s.state==='prepared'){for(const f of rows){const r=await regular(path.join(q.root,f.path));if(!r||r.sha256!==f.sha256||r.identity.mode!==f.mode||r.identity.uid!==s.owner.identity.uid)fail('FILE_CHANGED');}return {...publicState(s),idempotent:true};}
   fail('RECOVERY_REQUIRED');
  }
  const b=q.baseline;if(!b||b.root!==q.root||b.rootExists!==false||b.uid!==os.userInfo().uid||b.platform!==process.platform||b.arch!==process.arch||!b.node)fail('BASELINE_DRIFT');
  const node=await fs.stat(process.execPath);if(b.node.path!==process.execPath||b.node.version!==process.versions.node||b.node.dev!==node.dev||b.node.ino!==node.ino||b.node.size!==node.size||b.node.mtime!==node.mtimeMs)fail('BASELINE_DRIFT');
  const ancestors=await checkAncestors(q.root,b.ancestors),created=[];
  for(const a of ancestors.filter(x=>x.missing)){
   // Recheck the complete parent chain immediately before each exclusive mkdir.
   await checkAncestors(path.dirname(a.path));await fs.mkdir(a.path,{mode:0o700});const s=await fs.lstat(a.path);created.push({path:a.path,...identity(s)});
  }
  const rootStat=await fs.lstat(q.root),files=base(q),owner={owner:OWNER,schema:1,installationId:q.installationId,operationId:q.operationId,planHash:q.planHash,proofHash:hash(q.proof),root:q.root,identity:identity(rootStat),parents:created.filter(x=>x.path!==q.root),manifest:rows,manifestHash:q.manifestHash,creator:await processInfo()};
  await writeNew(files.owner,JSON.stringify(signed(owner,q.proof)));await syncDir(q.root);
  await runtime.afterOwner?.();
  await fs.mkdir(path.dirname(files.journal),{mode:0o700});
  const j={owner:OWNER,schema:1,operationId:q.operationId,planHash:q.planHash,revision:1,state:'preparing',written:[],error:null,process:await processInfo()};await atomicJSON(files.journal,signed(j,q.proof));
  try{
   for(const f of q.files){
    const p=path.join(q.root,f.path);let parent=q.root;
    for(const part of f.path.split('/').slice(0,-1)){parent=path.join(parent,part);const s=await stat(parent);if(!s)await fs.mkdir(parent,{mode:0o700});else if(!s.isDirectory()||s.isSymbolicLink())fail('UNSAFE_PATH');}
    if(await stat(p))fail('FILE_CHANGED');await writeNew(p,Buffer.from(f.data,'base64'));
    await runtime.afterFile?.(f.path,j.written.length+1);
    j.written.push(f.path);j.revision++;await atomicJSON(files.journal,signed(j,q.proof));
   }
   j.state='prepared';j.process=null;j.revision++;await atomicJSON(files.journal,signed(j,q.proof));return publicState(await load(q));
  }catch(e){j.state='needs_review';j.process=null;j.error=/^ONBOARDING_CLOUD_[A-Z_]+$/.test(e.message)?e.message:'ONBOARDING_CLOUD_PREPARATION_FAILED';j.revision++;await atomicJSON(files.journal,signed(j,q.proof));throw e;}
 }
 const s=await load(q);if(s.state==='absent')return {state:'absent',initialization:false,hostStarted:false};
 if(s.active)fail('PROCESS_ACTIVE');
 // Full preflight before deletion: unknown content is preserved, never claimed by a directory prefix.
 const allowed=new Map(s.owner.manifest.map(f=>[f.path,f.sha256]));allowed.set('.dsh-onboarding-owner.json',s.ownerSnapshot.sha256);
 if(s.journalSnapshot)allowed.set('.control/journal.json',s.journalSnapshot.sha256);
 const allowedDirs=new Set(['.control']);for(const name of allowed.keys()){let d=path.dirname(name);while(d!=='.'){allowedDirs.add(d);d=path.dirname(d);}}
 const files=[],dirs=[];async function walk(dir){for(const name of await fs.readdir(dir)){const p=path.join(dir,name),rel=path.relative(q.root,p),a=await fs.lstat(p);if(a.isSymbolicLink())fail('ROLLBACK_REVIEW');if(a.isDirectory()){if(!allowedDirs.has(rel)||(a.mode&0o777)!==0o700||a.uid!==s.owner.identity.uid)fail('ROLLBACK_REVIEW');dirs.push({path:p,identity:identity(a)});await walk(p);}else{const f=await regular(p);if(!allowed.has(rel)||f.sha256!==allowed.get(rel)||f.identity.mode!==0o600||f.identity.uid!==s.owner.identity.uid)fail('ROLLBACK_REVIEW');files.push({path:p,...f});}}}
 await walk(q.root);
 // Filesystem may change after preflight: recheck each item immediately, retain any divergence.
 for(const f of files.filter(x=>x.path!==s.files.owner)){const current=await regular(f.path);if(!current||current.sha256!==f.sha256||!same(current.identity,f.identity))fail('ROLLBACK_REVIEW');await fs.unlink(f.path);}
 for(const d of dirs.sort((a,b)=>b.path.length-a.path.length)){const current=await fs.lstat(d.path);if(!same(identity(current),d.identity))fail('ROLLBACK_REVIEW');await fs.rmdir(d.path);}
 const last=await fs.lstat(q.root),owner=await regular(s.files.owner);if(!same(identity(last),s.owner.identity)||!owner||owner.sha256!==s.ownerSnapshot.sha256||(await fs.readdir(q.root)).join()!=='.dsh-onboarding-owner.json')fail('OWNER_REVIEW');await fs.unlink(s.files.owner);await fs.rmdir(q.root);
 const retainedParents=[];
 for(const p of [...s.owner.parents].reverse())try{const current=await fs.lstat(p.path);if(!same(identity(current),p)){retainedParents.push(p.path);continue;}await fs.rmdir(p.path);}catch{retainedParents.push(p.path);}
 return {state:'rolled_back',operationId:q.operationId,retainedParents,initialization:false,hostStarted:false};
}
export async function remoteControlCLI(){
 try{let size=0,parts=[];for await(const c of process.stdin){size+=c.length;if(size>12582912)fail('INPUT_LIMIT');parts.push(c);}const r=await remoteControl(JSON.parse(Buffer.concat(parts)));console.log(JSON.stringify({ok:true,value:r}));}
 catch(e){console.log(JSON.stringify({ok:false,error:/^ONBOARDING_CLOUD_[A-Z_]+$/.test(e.message)?e.message:'ONBOARDING_CLOUD_CONTROL_FAILED'}));}
}
