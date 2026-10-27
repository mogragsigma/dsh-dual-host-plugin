import path from 'node:path';
import {constants} from 'node:fs';
import {lstat,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const ownedStart='<!-- dsh-dual-host:begin -->',ownedEnd='<!-- dsh-dual-host:end -->';
export function resolveOnboardingPaths({platform,home,env={},configured={}}){
 if(!['darwin','linux','win32'].includes(platform))throw Error('ONBOARDING_PLATFORM_UNSUPPORTED');
 const p=platform==='win32'?path.win32:path.posix;
 const resolve=v=>{
  if(typeof v!=='string'||!v||/[\u0000-\u001f]/u.test(v))throw Error('ONBOARDING_PATH_UNRESOLVED');
  const x=v==='~'?home:/^~[\\/]/.test(v)?p.join(home,v.slice(2)):v;
  if(!p.isAbsolute(x)||platform==='win32'&&/^[/\\](?![/\\])/.test(x))throw Error('ONBOARDING_PATH_UNRESOLVED');
  return p.normalize(x);
 };
 if(!p.isAbsolute(home))throw Error('ONBOARDING_PATH_UNRESOLVED');
 // Match official dsh-home-paths: blank environment overrides mean "unset".
 // Explicit plugin paths remain strict, and still describe candidates, not activation.
 const root=(key,variable,fallback)=>{
  const fromEnv=typeof env[variable]==='string'&&env[variable].trim().length>0?env[variable]:undefined;
  return {path:resolve(configured[key]??fromEnv??p.join(home,fallback)),source:configured[key]!==undefined?'plugin_configuration':fromEnv!==undefined?'process_environment':'platform_home_default'};
 };
 const dsh=root('dshHome','DSH_HOME','.dsh'),agents=root('agentsHome','DSH_AGENTS_HOME','.agents');
 const custom=configured.customSkillDirs??[];
 if(!Array.isArray(custom)||custom.length>32||configured.includeDefaultRoots!==undefined&&typeof configured.includeDefaultRoots!=='boolean')throw Error('ONBOARDING_PATH_UNRESOLVED');
 const unique=xs=>[...new Set(xs)];
 return {platform,dsh,agents,globalCandidates:unique([p.join(dsh.path,'AGENTS.md'),p.join(agents.path,'AGENTS.md')]),skillCandidates:unique([...(configured.includeDefaultRoots===false?[]:[p.join(dsh.path,'skills'),p.join(agents.path,'skills')]),...custom.map(resolve)]),includeDefaultRoots:configured.includeDefaultRoots!==false,activeRootsVerified:false,installationAllowed:false,warning:'候选路径来自本 Host 进程及显式配置；尚未证明指令/Skill 提供方正在加载它们。云端路径须在云端服务账号下独立核验。'};
}
// lstat each ancestor; never follow a user-controlled symlink into another rules file.
// This is a best-effort read-only observation, NOT an OS isolation or future write guarantee.
export async function inspectRuleFile(file){
 try{
  const parts=file.split(path.sep).filter(Boolean);let parent=path.parse(file).root;
  for(let i=0;i<parts.length;i++){
   parent=path.join(parent,parts[i]);let s;try{s=await lstat(parent);}catch(e){if(e.code==='ENOENT')return {path:file,state:'missing',action:'create_after_approval',contentRead:false};throw e;}
   if(s.isSymbolicLink())return {path:file,state:'symlink_review',action:'blocked',contentRead:false};
   if(i<parts.length-1&&!s.isDirectory())return {path:file,state:'not_directory',action:'blocked',contentRead:false};
   if(i===parts.length-1&&(!s.isFile()||s.size>262144))return {path:file,state:'unsupported_file',action:'blocked',contentRead:false};
  }
  const f=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
  try{
   const before=await f.stat();if(!before.isFile()||before.size>262144)return {path:file,state:'unsupported_file',action:'blocked',contentRead:false};
   const bytes=Buffer.alloc(before.size);const {bytesRead}=await f.read(bytes,0,bytes.length,0),after=await f.stat();
   if(bytesRead!==before.size||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs)return {path:file,state:'changed_during_read',action:'blocked',contentRead:false};
   const content=bytes.toString('utf8'),starts=content.split(ownedStart).length-1,ends=content.split(ownedEnd).length-1;
   const encodingOK=Buffer.from(content).equals(bytes),markerOK=starts===0&&ends===0||starts===1&&ends===1&&content.indexOf(ownedStart)<content.indexOf(ownedEnd);
   const legacy=content.split(/\r?\n/).filter(line=>['## 双端协作（本地鱼 / 云端鱼）','## 双端协作（全局托管规则）'].includes(line)).length;
   const blocked=!encodingOK||!markerOK||!(before.mode&0o222)||starts>0||legacy>0;
   return {path:file,state:!encodingOK?'encoding_review':!markerOK||legacy>1?'marker_conflict':!(before.mode&0o222)?'read_only':starts?'owned_block_requires_manifest':legacy?'legacy_section_requires_manifest':'existing_user_rules',action:blocked?'blocked':'append_after_approval',sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,contentRead:true,contentReturned:false};
  }finally{await f.close();}
 }catch{return {path:file,state:'unreadable',action:'blocked',contentRead:false};}
}
export async function inspectSkillRoot(root,names){
 const result={path:root,state:'candidate',conflicts:[],contentRead:false};
 try{let cursor=path.parse(root).root;for(const part of root.split(path.sep).filter(Boolean)){cursor=path.join(cursor,part);const s=await lstat(cursor);if(s.isSymbolicLink()||!s.isDirectory())return {...result,state:'unsafe_path'};}
  for(const name of names){try{await lstat(path.join(root,name));result.conflicts.push(name);}catch(e){if(e.code!=='ENOENT')return {...result,state:'unreadable'};}}
  return {...result,state:result.conflicts.length?'ownership_review':'no_name_collision'};
 }catch(e){return {...result,state:e.code==='ENOENT'?'missing':'unreadable'};}
}
