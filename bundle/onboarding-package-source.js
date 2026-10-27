// Installed package templates are read-only inputs, not writable owned targets.
// pnpm may hardlink them to its store. Never use this reader for user files,
// transaction journals or publication; their single-link checks remain mandatory.
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {hash,identity,sameIdentity,fail} from './onboarding-install-fs.js';
export async function packageSourceParents(folder,io=fs){
 if(!path.isAbsolute(folder))fail('INSTALL_SOURCE_INVALID');
 let at=path.parse(folder).root;const rows=[];
 for(const part of folder.split(path.sep).filter(Boolean)){
  at=path.join(at,part);const s=await io.lstat(at);
  if(s.isSymbolicLink()||!s.isDirectory())fail('UNSAFE_PATH');
  rows.push({path:at,dev:s.dev,ino:s.ino,mode:s.mode&0o777});
 }
 return rows;
}
export async function packageSourceSnapshot(file,max=262144,io=fs){
 if(!path.isAbsolute(file)||!Number.isSafeInteger(max)||max<1||max>2097152)fail('INSTALL_SOURCE_INVALID');
 const parents=await packageSourceParents(path.dirname(file),io),before=await io.lstat(file);
 if(before.isSymbolicLink()||!before.isFile()||before.nlink<1||before.size>max)fail('UNSAFE_FILE');
 const h=await io.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
 const same=(a,b)=>sameIdentity(a,b)&&a.isFile()&&b.isFile()&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs&&a.nlink===b.nlink&&(a.mode&0o777)===(b.mode&0o777);
 try{
  const a=await h.stat();if(!same(before,a))fail('FILE_DRIFT');
  // Bound allocation and reads even if another store link grows concurrently.
  const buffer=Buffer.alloc(a.size+1);let used=0;
  while(used<buffer.length){const {bytesRead}=await h.read(buffer,used,buffer.length-used,used);if(!bytesRead)break;used+=bytesRead;}
  const z=await h.stat(),current=await io.lstat(file);
  if(!same(a,z)||current.isSymbolicLink()||!same(z,current)||used!==a.size||JSON.stringify(parents)!==JSON.stringify(await packageSourceParents(path.dirname(file),io)))fail('FILE_DRIFT');
  const b=buffer.subarray(0,used);return {...identity(z),size:used,sha256:hash(b),data:b.toString('base64')};
 }finally{await h.close();}
}
