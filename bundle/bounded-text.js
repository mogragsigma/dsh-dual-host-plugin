// Shared synchronous file boundary. No shell, traversal, symlinks, hidden files or parsers.
import {lstatSync,realpathSync,openSync,closeSync,fstatSync,readSync,constants} from 'node:fs';
import {resolve,relative,join,isAbsolute,extname,sep} from 'node:path';
const identity=s=>`${s.dev}:${s.ino}`;
export const textFormats={'.md':'markdown','.txt':'text','.json':'json','.csv':'csv'};
export class BoundedTextReader {
 constructor(paths=[]){
  if(!Array.isArray(paths)||paths.length>8)throw Error('SOURCE_CONFIG_INVALID');
  this.roots=paths.map(path=>{
   if(typeof path!=='string'||!isAbsolute(path)||path.includes('\0'))throw Error('SOURCE_CONFIG_INVALID');
   const p=resolve(path),s=lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink())throw Error('SOURCE_ROOT_UNSAFE');
   return {path:p,canonical:realpathSync(p),identity:identity(s)};
  });
 }
 checkRoot(root){const s=lstatSync(root.path);if(!s.isDirectory()||s.isSymbolicLink()||identity(s)!==root.identity||realpathSync(root.path)!==root.canonical)throw Error('SOURCE_ROOT_UNSAFE');}
 locate(ref,role){
  if(ref.kind!=='file-reference')throw Error('SOURCE_CAPABILITY_UNAVAILABLE');
  if(ref.host!==role)throw Error('SOURCE_PEER_REQUIRED');
  if(typeof ref.uri!=='string'||!isAbsolute(ref.uri)||ref.uri.includes('\0'))throw Error('SOURCE_PERMISSION_DENIED');
  const path=resolve(ref.uri),root=this.roots.find(r=>path.startsWith(r.path+sep));if(!root)throw Error('SOURCE_PERMISSION_DENIED');
  const parts=relative(root.path,path).split(sep);
  if(parts.some(p=>p.startsWith('.')||/^(credentials|secrets|tokens\.json|id_rsa|id_ed25519)$/i.test(p)))throw Error('SOURCE_PERMISSION_DENIED');
  const format=textFormats[extname(path).toLowerCase()];if(!format)throw Error('SOURCE_FORMAT_UNSUPPORTED');
  this.checkRoot(root);let current=root.path;
  for(const [i,p] of parts.entries()){
   current=join(current,p);const s=lstatSync(current);if(s.isSymbolicLink()||(i<parts.length-1&&!s.isDirectory()))throw Error('SOURCE_PATH_UNSAFE');
   if(i===parts.length-1){if(!s.isFile()||s.nlink!==1||!(s.mode&0o444))throw Error('SOURCE_FILE_UNSAFE');if(s.size>65536)throw Error('SOURCE_TOO_LARGE');}
  }
  return {root,path,format};
 }
 read(ref,role){
  const loc=this.locate(ref,role);let fd,bytes;
  try{
   fd=openSync(loc.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const before=fstatSync(fd);
   if(!before.isFile()||before.nlink!==1||!(before.mode&0o444))throw Error('SOURCE_FILE_UNSAFE');
   if(before.size>65536)throw Error('SOURCE_TOO_LARGE');
   const buf=Buffer.alloc(before.size+1);let offset=0,n;while(offset<buf.length&&(n=readSync(fd,buf,offset,buf.length-offset,null)))offset+=n;bytes=buf.subarray(0,offset);
   const after=fstatSync(fd);this.locate(ref,role);
   if(identity(before)!==identity(after)||before.size!==after.size||bytes.length!==before.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||identity(lstatSync(loc.path))!==identity(before))throw Error('SOURCE_CHANGED_DURING_READ');
  }finally{if(fd!==undefined)closeSync(fd);}
  let content;try{content=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(content.includes('\0'))throw Error();if(loc.format==='json')JSON.parse(content);}catch{throw Error('SOURCE_CONTENT_UNSUPPORTED');}
  return {content,bytes,format:loc.format};
 }
}
