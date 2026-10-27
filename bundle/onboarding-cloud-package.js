import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const hash=b=>createHash('sha256').update(b).digest('hex');
const fail=()=>{throw Error('ONBOARDING_CLOUD_SOURCE_REVIEW');};
// Package only our distributable files. A linked development node_modules is never traversed.
export async function cloudPackage(source=path.dirname(fileURLToPath(import.meta.url))){
 const files=[];let total=0;
 const declared=JSON.parse(await fs.readFile(path.join(source,'package.json'),'utf8')).files;
 if(!Array.isArray(declared)||declared.some(x=>typeof x!=='string'||x.includes('/')||x==='.'||x==='..'||x==='node_modules'||x.includes('*')&&x!=='*.js'))fail();
 async function visit(relative){
  if(relative==='node_modules')return;
  const name=path.join(source,relative),s=await fs.lstat(name);
  if(s.isSymbolicLink())fail();
  if(s.isDirectory()){for(const child of (await fs.readdir(name)).sort())await visit(relative?relative+'/'+child:child);return;}
  if(!s.isFile()||s.nlink!==1||s.size>4194304||relative.length>256||relative.split('/').some(x=>!x||x==='.'||x==='..'))fail();
  const h=await fs.open(name,'r');let data;
  try{const before=await h.stat();if(before.ino!==s.ino||before.dev!==s.dev)fail();data=await h.readFile();const after=await h.stat();if(after.mtimeMs!==before.mtimeMs||after.size!==before.size)fail();}finally{await h.close();}
  total+=data.length;if(total>8388608||files.length>=512)fail();
  files.push({path:'plugin/'+relative,bytes:data.length,sha256:hash(data),mode:0o600,data:data.toString('base64')});
 }
 for(const name of (await fs.readdir(source)).sort())if(name==='package.json'||declared.includes(name)||declared.includes('*.js')&&name.endsWith('.js'))await visit(name);
 // npm excludes package-lock.json. This shipped copy restores only the existing
 // canonical archive entry; it does not change dependencies or execute installs.
 const shippedLock=files.find(f=>f.path==='plugin/distribution-lock.json');
 if(shippedLock){
  const canonical=files.find(f=>f.path==='plugin/package-lock.json');
  if(canonical&&canonical.sha256!==shippedLock.sha256)fail();
  if(!canonical){total+=shippedLock.bytes;if(total>8388608||files.length>=512)fail();files.push({...shippedLock,path:'plugin/package-lock.json'});}
 }
 files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 const manifest=files.map(({data,...entry})=>entry),manifestHash=hash(JSON.stringify(manifest));
 const pkg=JSON.parse(Buffer.from(files.find(x=>x.path==='plugin/package.json').data,'base64'));
 const compat=JSON.parse(Buffer.from(files.find(x=>x.path==='plugin/compatibility.json').data,'base64'));
 if(pkg.name!=='@mogragsigma/dsh-dual-host-plugin'||pkg.version!==compat.version)fail();
 return {files,manifest,manifestHash,bytes:total,pluginVersion:pkg.version,hostVersion:compat.hostBaseline};
}
