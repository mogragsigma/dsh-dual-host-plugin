// Bounded filesystem primitives for the opt-in isolated installer, not an OS sandbox.
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
export const hash=b=>createHash('sha256').update(b).digest('hex');
export const fail=code=>{throw Error('ONBOARDING_'+code);};
export const inside=(root,p)=>p===root||p.startsWith(root+path.sep);
export const identity=s=>({dev:s.dev,ino:s.ino,mode:s.mode&0o777,nlink:s.nlink});
export const sameIdentity=(a,b)=>!!a&&!!b&&a.dev===b.dev&&a.ino===b.ino;
export async function ancestors(p){
 let at=path.parse(p).root;const rows=[];
 for(const part of p.split(path.sep).filter(Boolean)){
  at=path.join(at,part);
  try{const s=await fs.lstat(at);if(s.isSymbolicLink()||!s.isDirectory())fail('UNSAFE_PATH');if(!(s.mode&0o200))fail('READ_ONLY_PATH');rows.push({path:at,dev:s.dev,ino:s.ino,mode:s.mode&0o777});}
  catch(e){if(e.code!=='ENOENT')throw e;rows.push({path:at,missing:true});}
 }
 return rows;
}
export async function snapshot(file,max=262144){
 await ancestors(path.dirname(file));let s;
 try{s=await fs.lstat(file);}catch(e){if(e.code==='ENOENT')return {missing:true};throw e;}
 if(s.isSymbolicLink()||!s.isFile()||s.nlink!==1||s.size>max)fail('UNSAFE_FILE');
 const h=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
 try{const a=await h.stat();if(!sameIdentity(s,a)||!a.isFile()||a.size>max||a.nlink!==1)fail('FILE_DRIFT');const b=await h.readFile(),z=await h.stat();if(a.size!==z.size||a.mtimeMs!==z.mtimeMs||b.length!==a.size)fail('FILE_DRIFT');return {...identity(z),size:b.length,sha256:hash(b),data:b.toString('base64')};}finally{await h.close();}
}
export const bytes=s=>s.missing?Buffer.alloc(0):Buffer.from(s.data,'base64');
export const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export async function syncWrite(file,data,flags='wx'){
 const h=await fs.open(file,flags,0o600);try{await h.writeFile(data);await h.sync();}finally{await h.close();}
}
export async function atomicState(file,value){
 await ancestors(path.dirname(file));
 const tmp=file+'.'+randomUUID()+'.tmp';
 await syncWrite(tmp,JSON.stringify(value));await fs.rename(tmp,file);
 // Directory fsync is available on the exercised macOS/Linux filesystems.
 const dir=await fs.open(path.dirname(file),'r');try{await dir.sync();}finally{await dir.close();}
}
export async function appendExact(file,before,addition){
 const h=await fs.open(file,constants.O_RDWR|constants.O_APPEND|(constants.O_NOFOLLOW??0));
 try{const s=await h.stat();if(!sameIdentity(s,before)||s.nlink!==1||hash(await h.readFile())!==before.sha256)fail('FILE_DRIFT');await h.writeFile(addition);await h.sync();}finally{await h.close();}
}
export async function restoreAppend(file,item){
 const h=await fs.open(file,constants.O_RDWR|(constants.O_NOFOLLOW??0));
 try{const s=await h.stat();if(!sameIdentity(s,item.publishedIdentity)||s.nlink!==1||hash(await h.readFile())!==item.afterHash)fail('ROLLBACK_DRIFT');await h.truncate(item.before.size);await h.sync();}finally{await h.close();}
}
export {fs};

// A crash between link publication and stage removal can leave exactly two links.
// Remove only our journaled stage, never an unknown hard link.
export async function cleanStage(stage,target,expected){
 let s;try{s=await fs.lstat(stage);}catch(e){if(e.code==='ENOENT')return;throw e;}
 if(!s.isFile()||s.isSymbolicLink()||!sameIdentity(s,expected.publishedIdentity)||![1,2].includes(s.nlink))fail('ROLLBACK_DRIFT');
 const h=await fs.open(stage,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
 try{if(!sameIdentity(await h.stat(),s)||hash(await h.readFile())!==expected.afterHash)fail('ROLLBACK_DRIFT');}finally{await h.close();}
 if(s.nlink===2){const t=await fs.lstat(target);if(t.isSymbolicLink()||!sameIdentity(t,s))fail('ROLLBACK_DRIFT');}
 await fs.unlink(stage);
}
