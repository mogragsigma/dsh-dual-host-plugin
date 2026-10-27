// Byte transport only: no parsing, execution, arbitrary destination or overwrite.
import fs from 'node:fs';
import {resolve,relative,join,isAbsolute,sep,basename} from 'node:path';
import {createHash} from 'node:crypto';
export const fileHash=b=>createHash('sha256').update(b).digest('hex');
export const fileIdentity=s=>`${s.dev}:${s.ino}`;
const fail=code=>{throw Error('PEER_FILE_'+code);};
export function fileName(s){
 if(typeof s!=='string'||!s||Buffer.byteLength(s)>220||s.startsWith('.')||/[\x00-\x1f\x7f/\\<>:"|?*]/.test(s)||/[. ]$/.test(s)||/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(s))fail('NAME_INVALID');return s;
}
export class FileRoot {
 constructor(path){if(typeof path!=='string'||!isAbsolute(path)||path.includes('\0'))fail('ROOT_INVALID');this.path=resolve(path);const s=fs.lstatSync(this.path);if(!s.isDirectory()||s.isSymbolicLink())fail('ROOT_UNSAFE');this.id=fileIdentity(s);this.canonical=fs.realpathSync(this.path);}
 check(){const s=fs.lstatSync(this.path);if(!s.isDirectory()||s.isSymbolicLink()||fileIdentity(s)!==this.id||fs.realpathSync(this.path)!==this.canonical)fail('ROOT_CHANGED');}
 at(parts,create=false){this.check();let p=this.path;for(const [i,part] of parts.entries()){
  fileName(part);p=join(p,part);if(i===parts.length-1)break;
  if(create){try{fs.mkdirSync(p,{mode:0o700});let fd;try{fd=fs.openSync(join(p,'..'),fs.constants.O_RDONLY);fs.fsyncSync(fd);}finally{if(fd!==undefined)fs.closeSync(fd);}}catch(e){if(e.code!=='EEXIST')throw e;}}
  const s=fs.lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink())fail('PATH_UNSAFE');
 }this.check();return p;}
 read(parts,max){const p=this.at(parts);let fd;try{
  fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);const a=fs.fstatSync(fd);
  if(!a.isFile()||a.nlink!==1||!(a.mode&0o444))fail('UNSAFE');if(a.size>max)fail('TOO_LARGE');
  const bytes=Buffer.alloc(a.size+1);let n=0,k;while(n<bytes.length&&(k=fs.readSync(fd,bytes,n,bytes.length-n,null)))n+=k;
  const b=fs.fstatSync(fd);this.check();const current=fs.lstatSync(this.at(parts));
  if(fileIdentity(a)!==fileIdentity(b)||fileIdentity(current)!==fileIdentity(a)||a.size!==b.size||n!==a.size||a.mtimeMs!==b.mtimeMs||a.ctimeMs!==b.ctimeMs)fail('CHANGED');
  return bytes.subarray(0,n);
 }finally{if(fd!==undefined)fs.closeSync(fd);}}
 size(parts){try{const s=fs.lstatSync(this.at(parts));if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)fail('UNSAFE');return s.size;}catch(e){if(e.code==='ENOENT')return 0;throw e;}}
 append(parts,offset,bytes,max){const p=this.at(parts,true);let fd;try{
  fd=fs.openSync(p,fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK,0o600);
  const s=fs.fstatSync(fd);if(!s.isFile()||s.nlink!==1||s.size>max||offset+bytes.length>max)fail('UNSAFE');
  if(offset<s.size){const prior=Buffer.alloc(bytes.length);const n=fs.readSync(fd,prior,0,prior.length,offset);if(n!==bytes.length||!prior.equals(bytes))fail('CHUNK_CONFLICT');return s.size;}
  if(offset!==s.size)fail('OFFSET_CONFLICT');let n=0;while(n<bytes.length)n+=fs.writeSync(fd,bytes,n,bytes.length-n,offset+n);fs.fsyncSync(fd);this.check();
  if(fileIdentity(fs.lstatSync(this.at(parts)))!==fileIdentity(s))fail('PATH_CHANGED');let parent;try{parent=fs.openSync(join(p,'..'),fs.constants.O_RDONLY);fs.fsyncSync(parent);}finally{if(parent!==undefined)fs.closeSync(parent);}return offset+bytes.length;
 }finally{if(fd!==undefined)fs.closeSync(fd);}}
 publish(parts,bytes,expected,{recover=false}={}){
  if(fileHash(bytes)!==expected)fail('HASH_MISMATCH');const p=this.at(parts,true),tmpParts=[...parts.slice(0,-1),'partial-'+fileHash(Buffer.from(p))],tmp=this.at(tmpParts);
  // The caller persisted an intent BEFORE this operation; identical final bytes can
  // be recovered after link() succeeded but the process died before its receipt.
  if(fs.existsSync(p)){
   if(!recover)fail('DESTINATION_EXISTS');
   const s=fs.lstatSync(p);if(s.isSymbolicLink()||!s.isFile())fail('DESTINATION_EXISTS');
   if(fs.existsSync(tmp)){const t=fs.lstatSync(tmp);if(!t.isSymbolicLink()&&fileIdentity(s)===fileIdentity(t)&&s.nlink===2)fs.unlinkSync(tmp);}
   if(!this.read(parts,bytes.length).equals(bytes))fail('DESTINATION_EXISTS');return p;
  }
  if(fs.existsSync(tmp)){if(!this.read(tmpParts,bytes.length).equals(bytes))fail('TEMP_CHANGED');}
  else this.append(tmpParts,0,bytes,bytes.length);
  // link is atomic and refuses an existing destination; rename would overwrite.
  try{fs.linkSync(tmp,p);}catch(e){if(e.code==='EEXIST')fail('DESTINATION_EXISTS');throw e;}
  fs.unlinkSync(tmp);let fd;try{fd=fs.openSync(join(p,'..'),fs.constants.O_RDONLY);fs.fsyncSync(fd);}finally{if(fd!==undefined)fs.closeSync(fd);}this.check();return p;
 }
}
export function sourceFile(roots,input,max){
 if(typeof input!=='string'||!input||input.includes('\0'))fail('SOURCE_INVALID');
 let path=input;
 if(!isAbsolute(input)){
  fileName(input);const matches=roots.flatMap(r=>{r.check();return fs.existsSync(join(r.path,input))?[join(r.path,input)]:[];});
  if(matches.length!==1)fail(matches.length?'SOURCE_AMBIGUOUS':'SOURCE_MISSING');path=matches[0];
 }
 if(resolve(path)!==path)fail('SOURCE_INVALID');const root=roots.find(r=>path.startsWith(r.path+sep));if(!root)fail('SOURCE_DENIED');
 const parts=relative(root.path,path).split(sep);for(const part of parts){fileName(part);if(/^(credentials|secrets|tokens(?:\.json)?|id_rsa|id_ed25519)$/i.test(part))fail('SOURCE_DENIED');}
 return {path,name:basename(path),bytes:root.read(parts,max)};
}
