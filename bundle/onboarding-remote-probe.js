// This file is sent as fixed program text over authenticated SSH. Read-only.
// It does not read model/IM credentials, process environments, or user rule bodies.
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fail=code=>{throw Error(code);};
try{
 let size=0,parts=[];for await(const chunk of process.stdin){size+=chunk.length;if(size>8192)fail('INPUT_LIMIT');parts.push(chunk);}
 const input=JSON.parse(Buffer.concat(parts).toString());
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join()!=='installationId,parent'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(input.installationId))fail('INPUT_INVALID');
 const user=os.userInfo(),parent=input.parent??path.join(user.homedir,'.local/share/dsh-dual-host/instances');
 if(typeof parent!=='string'||!path.isAbsolute(parent)||path.normalize(parent)!==parent||parent.length>600||/[\x00-\x1f\x7f]/.test(parent)||['/',user.homedir].includes(parent))fail('PATH_INVALID');
 const root=path.join(parent,'host-'+input.installationId),ancestors=[];let cursor=path.parse(root).root,missing=false;
 const top=await fs.lstat(cursor);ancestors.push({path:cursor,dev:top.dev,ino:top.ino,mode:top.mode&0o777,uid:top.uid});
 for(const part of root.split(path.sep).filter(Boolean)){
  cursor=path.join(cursor,part);let s;try{s=await fs.lstat(cursor);}catch(e){if(e.code!=='ENOENT')throw e;missing=true;ancestors.push({path:cursor,missing:true});continue;}
  if(missing||s.isSymbolicLink()||!s.isDirectory())fail('UNSAFE_PATH');
  ancestors.push({path:cursor,dev:s.dev,ino:s.ino,mode:s.mode&0o777,uid:s.uid});
 }
 const anchor=ancestors.filter(x=>!x.missing).at(-1),rootExists=!ancestors.at(-1).missing;
 let writable=false;try{await fs.access(anchor.path,constants.W_OK|constants.X_OK);writable=true;}catch{}
 let freeBytes=null;try{const s=await fs.statfs(anchor.path);freeBytes=s.bavail*s.bsize;}catch{}
 let owner=null;
 if(rootExists){
  const file=path.join(root,'.dsh-onboarding-owner.json');
  try{const s=await fs.lstat(file);if(s.isSymbolicLink()||!s.isFile()||s.nlink!==1||s.size>131072)fail('OWNER_REVIEW');const h=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);try{const a=await h.stat();if(a.ino!==s.ino||a.dev!==s.dev)fail('OWNER_REVIEW');const data=Buffer.alloc(131073);let used=0;while(used<data.length){const n=(await h.read(data,used,data.length-used,used)).bytesRead;if(!n)break;used+=n;}const after=await h.stat();if(used>131072||used!==s.size||after.size!==s.size||after.mtimeMs!==s.mtimeMs)fail('OWNER_REVIEW');const p=JSON.parse(data.subarray(0,used).toString('utf8'));owner={sha256:hash(p),matches:p.installationId===input.installationId&&p.owner==='dsh-dual-host-onboarding'};}finally{await h.close();}}catch(e){if(e.code!=='ENOENT')fail('OWNER_REVIEW');}
 }
 const protectedHomes=[];for(const p of [path.join(user.homedir,'.dsh'),path.join(user.homedir,'.agents')]){let exists=false;try{await fs.lstat(p);exists=true;}catch{}protectedHomes.push({path:p,exists,read:false,modified:false});}
 const possibleHosts=[];
 if(process.platform==='linux')for(const pid of (await fs.readdir('/proc')).filter(x=>/^\d+$/.test(x)).slice(0,8192)){
  if(+pid===process.pid)continue;
  try{const c=await fs.readFile('/proc/'+pid+'/cmdline');if(c.length<65536&&c.toString().split('\0').some(x=>x.endsWith('/@deepseek-ai/dsh/lib/bin.js')))possibleHosts.push({pid:+pid,classification:'possible_dsh_cli',configurationRead:false});}catch{}
 }
 const nodeStat=await fs.stat(process.execPath),node={path:process.execPath,version:process.versions.node,dev:nodeStat.dev,ino:nodeStat.ino,size:nodeStat.size,mtime:nodeStat.mtimeMs};
 const baseline={platform:process.platform,arch:process.arch,uid:user.uid,user:user.username,home:user.homedir,parent,root,ancestors,rootExists,owner,node};
 console.log(JSON.stringify({ok:true,contract:1,...baseline,baselineHash:hash(baseline),writable,freeBytes,protectedHomes,possibleHosts,servicePathsVerified:false,remoteWrites:0}));
}catch(e){console.log(JSON.stringify({ok:false,code:['INPUT_INVALID','INPUT_LIMIT','PATH_INVALID','UNSAFE_PATH','OWNER_REVIEW'].includes(e.message)?e.message:'PROBE_FAILED'}));process.exitCode=0;}
