import {packageSourceSnapshot,packageSourceParents} from './onboarding-package-source.js';
// Read-only maintenance plans. No mutation capability is advertised until the
// journaled apply/recovery path exists. This is not a plugin/Host uninstaller.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {onboardingBoundary} from './onboarding-boundary.js';
import {onboardingIdentity} from './onboarding-identity.js';
import {fs,hash,bytes,snapshot,ancestors,identity,fail} from './onboarding-install-fs.js';

const BEGIN='<!-- dsh-dual-host:begin -->',END='<!-- dsh-dual-host:end -->';
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const skillName=x=>typeof x==='string'&&/^[a-z][a-z0-9-]{1,79}$/.test(x);
const utf8=b=>{const s=b.toString('utf8');if(!Buffer.from(s).equals(b)||s.includes('\0'))fail('MAINTENANCE_ENCODING_REVIEW');return s;};
const decode=s=>{if(typeof s!=='string'||s.length>360000)fail('MAINTENANCE_OWNERSHIP_REVIEW');const b=Buffer.from(s,'base64');if(b.toString('base64')!==s)fail('MAINTENANCE_OWNERSHIP_REVIEW');return b;};
const count=(s,part)=>s.split(part).length-1;
function checkedBlock(b){
 const s=utf8(b),eol=s.startsWith('\r\n')?'\r\n':'\n';
 if(!s.startsWith(eol+eol+BEGIN+eol)||!s.endsWith(eol+END+eol)||count(s,BEGIN)!==1||count(s,END)!==1)fail('MAINTENANCE_OWNERSHIP_REVIEW');
 return eol;
}

export function createMaintenancePlanner(config={},runtime={}){
 const now=runtime.now??Date.now,source=runtime.source??path.dirname(fileURLToPath(import.meta.url));
 function boundary(){onboardingIdentity(config);return onboardingBoundary(config,runtime,'installation');}
 function available(){try{boundary();return true;}catch{return false;}}

 async function inspect(action){
  const {paths:p,roots,isolated}=boundary(),state=path.join(p.dsh.path,'dual-host-onboarding');
  const observations=[],conflicts=[],changes=[],retained=[],rows=[],operations=[],nextFiles=[];let ownedDirs=[];
  const conflict=(code,file)=>conflicts.push({code:'ONBOARDING_MAINTENANCE_'+code,...(file?{path:file}:{})});
  const observe=async(file,max)=>{
   try{const s=await snapshot(file,max);observations.push({path:file,snapshot:s,parents:await ancestors(path.dirname(file))});return s;}
   catch(e){observations.push({path:file,error:/^ONBOARDING_[A-Z_]+$/.test(e.message)?e.message:'UNREADABLE'});conflict('UNSAFE_OR_UNREADABLE',file);return null;}
  };
  const observeSource=async file=>{const s=await packageSourceSnapshot(file);observations.push({path:file,snapshot:s,parents:await packageSourceParents(path.dirname(file)),readOnlyPackageSource:true});return s;};
  const json=async(file)=>{const s=await observe(file,2097152);if(!s||s.missing)return null;try{return JSON.parse(utf8(bytes(s)));}catch{conflict('OWNERSHIP_REVIEW',file);return null;}};
  // A directory observation records names only. Unknown sidecar files are never read.
  const directory=async(dir,readOnlySource=false)=>{
   try{
    const parents=await (readOnlySource?packageSourceParents(dir):ancestors(dir)),s=await fs.lstat(dir),names=await fs.readdir(dir);
    if(!s.isDirectory()||s.isSymbolicLink()||names.length>256)fail('MAINTENANCE_DIRECTORY_REVIEW');
    names.sort();observations.push({path:dir,parents,identity:identity(s),names});return names;
   }catch(e){if(e.code==='ENOENT'){observations.push({path:dir,missing:true,parents:await ancestors(path.dirname(dir))});return [];}
    conflict('UNSAFE_OR_UNREADABLE',dir);return null;}
  };
  const add=(file,kind,before,after,why,extra={},managed=after,createdFile=true)=>{
   if(action!=='uninstall'&&after!==null)nextFiles.push({path:file,kind,sha256:hash(after),sourceHash:hash(managed),managedData:managed.toString('base64'),createdFile});
   const same=after!==null&&!before.missing&&hash(after)===before.sha256;
   rows.push({path:file,kind,state:same?'unchanged':before.missing?'missing':'owned_content',...extra});
   if(same||after===null&&before.missing)return;
   if(!before.missing&&!(before.mode&0o200)){conflict('READ_ONLY_FILE',file);return;}
   const stateDevice=observations.find(x=>x.path===path.join(state,'installed.json'))?.snapshot?.dev;
   const fileObservation=observations.find(x=>x.path===file&&x.snapshot);
   const fileDevice=before.missing?[...(fileObservation?.parents??[])].reverse().find(x=>!x.missing)?.dev:before.dev;
   // Capture/restore and no-replace publication require a common filesystem.
   // Reject in preview, rather than discover EXDEV after changing another file.
   if(stateDevice===undefined||fileDevice!==stateDevice){conflict('CROSS_DEVICE_REVIEW',file);return;}
   operations.push({path:file,kind,before,after:after===null?null:after.toString('base64'),afterHash:after===null?null:hash(after),action:after===null?'remove':before.missing?'create':'replace'});
   changes.push({path:file,kind,action:after===null?'remove':before.missing?'create':'replace',reason:why,
    beforeHash:before.sha256??null,afterHash:after===null?null:hash(after),beforeBytes:before.size??0,
    afterBytes:after?.length??0,...extra});
  };
  const finish=(metadata={})=>{
   conflicts.sort((a,b)=>(a.path??'').localeCompare(b.path??'')||a.code.localeCompare(b.code));
   observations.sort((a,b)=>a.path.localeCompare(b.path));
   const fingerprint=hash(JSON.stringify({action,roots,observations,conflicts,changes,metadata}));
   const view={contract:2,action,scope:isolated?'isolated_managed_rules_and_skills_only':'current_host_managed_rules_and_skills_only',
    ...metadata,fingerprint,planReady:conflicts.length===0,canApply:false,mutationAvailable:false,
    conflicts,changes:conflicts.length?[]:changes,files:rows,retained,
    preserved:{userRulesOutsideOwnedBlock:true,unknownSkillFiles:true,pluginBinary:true,credentials:true,
     tasksAndArtifacts:true,nativeDSHConfiguration:true,thirdPartyPlugins:true,cloudInstance:true},
    initialization:false,activationVerified:false,executionAuthorized:false,repositoryWriteAuthorized:false};
   return {view,context:{p,roots,isolated,state},operations,nextFiles,observations,manifest,ownedDirs};
  };
  const lock=await observe(path.join(state,'lock.json'));
  if(lock&&!lock.missing)conflict('RECOVERY_REQUIRED',path.join(state,'lock.json'));
  const manifest=await json(path.join(state,'installed.json'));
  if(!manifest){
   if(conflicts.length)return finish({state:'needs_review'});
   conflict('NOT_INSTALLED');return finish({state:'not_installed'});
  }
  if(![1,2].includes(manifest.schema)||!uuid(manifest.id)||typeof manifest.version!=='string'||manifest.version.length>80||
   !Array.isArray(manifest.files)||manifest.files.length<1||manifest.files.length>65||
   new Set(manifest.files.map(f=>f?.path)).size!==manifest.files.length){conflict('OWNERSHIP_REVIEW');return finish({state:'needs_review'});}
  const journal=await json(path.join(state,manifest.schema===2?'maintenance-transactions':'transactions',manifest.id,'journal.json'));
  const latest=await json(path.join(state,'latest.json'));
  if(!journal||journal.schema!==manifest.schema||journal.id!==manifest.id||journal.state!=='committed'||latest?.id!==manifest.id||
   (manifest.schema===1&&(journal.version!==manifest.version||!Array.isArray(journal.items)||journal.items.length!==manifest.files.length||new Set(journal.items.map(i=>i?.path)).size!==journal.items.length))||
   (manifest.schema===2&&(latest.kind!=='maintenance'||JSON.stringify(journal.afterManifest)!==JSON.stringify(manifest)))){
   conflict('OWNERSHIP_REVIEW');return finish({state:'needs_review'});
  }
  const owned=[];
  try{
   const dirs=manifest.schema===1?journal.dirs:manifest.ownedDirs??[];
   if(!Array.isArray(dirs)||dirs.length>132)fail('MAINTENANCE_OWNERSHIP_REVIEW');
   ownedDirs=dirs.filter(d=>d?.path===path.join(p.dsh.path,'skills')||typeof d?.path==='string'&&d.path.startsWith(path.join(p.dsh.path,'skills')+path.sep));
   if(ownedDirs.some(d=>!d.identity||typeof d.identity.ino!=='number'||typeof d.identity.dev!=='number'))fail('MAINTENANCE_OWNERSHIP_REVIEW');
   for(const row of manifest.files){
    if(typeof row?.path!=='string'||!digest(row.sha256)||!digest(row.sourceHash))fail('MAINTENANCE_OWNERSHIP_REVIEW');
    const rule=p.globalCandidates.includes(row.path),name=path.basename(path.dirname(row.path));
    if(!rule&&(!skillName(name)||row.path!==path.join(p.dsh.path,'skills',name,'SKILL.md')))fail('MAINTENANCE_OWNERSHIP_REVIEW');
    if(manifest.schema===2){
     if(typeof row.createdFile!=='boolean'||row.kind!==(rule?'global_rules':'skill'))fail('MAINTENANCE_OWNERSHIP_REVIEW');
     const addition=decode(row.managedData);if(hash(addition)!==row.sourceHash||!rule&&hash(addition)!==row.sha256)fail('MAINTENANCE_OWNERSHIP_REVIEW');
     if(rule)checkedBlock(addition);else utf8(addition);
     owned.push({path:row.path,kind:row.kind,name,addition,createdFile:row.createdFile,afterHash:row.sha256});continue;
    }
    const item=journal.items.find(i=>i?.path===row.path);
    if(!item||item.phase!=='done'||!['create','append'].includes(item.action)||!item.before||
     item.afterHash!==row.sha256||item.sourceHash!==row.sourceHash)fail('MAINTENANCE_OWNERSHIP_REVIEW');
    const after=decode(item.after);if(hash(after)!==row.sha256)fail('MAINTENANCE_OWNERSHIP_REVIEW');
    let addition=after;
    if(item.action==='append'){
     if(!rule||item.before.missing)fail('MAINTENANCE_OWNERSHIP_REVIEW');const before=decode(item.before.data);
     if(before.length!==item.before.size||hash(before)!==item.before.sha256||!after.subarray(0,before.length).equals(before))fail('MAINTENANCE_OWNERSHIP_REVIEW');
     addition=after.subarray(before.length);if(item.addition!==utf8(addition))fail('MAINTENANCE_OWNERSHIP_REVIEW');
    }else if(item.before.missing!==true)fail('MAINTENANCE_OWNERSHIP_REVIEW');
    if(hash(addition)!==row.sourceHash)fail('MAINTENANCE_OWNERSHIP_REVIEW');
    if(rule)checkedBlock(addition);else utf8(after);
    owned.push({path:row.path,kind:rule?'global_rules':'skill',name,addition,createdFile:item.before.missing===true,afterHash:item.afterHash});
   }
   if(owned.filter(i=>i.kind==='global_rules').length!==1)fail('MAINTENANCE_OWNERSHIP_REVIEW');
  }catch{conflict('OWNERSHIP_REVIEW');return finish({state:'needs_review'});}

  let targetVersion=manifest.version,newTemplate=null,newSkills=null;
  if(action==='upgrade'||action==='repair'){
   try{
    const compat=JSON.parse(utf8(bytes(await observeSource(path.join(source,'compatibility.json')))));
    if(!compat||typeof compat.version!=='string'||compat.version.length>80||!Array.isArray(compat.globalSkills)||
     compat.globalSkills.length>64||new Set(compat.globalSkills).size!==compat.globalSkills.length||
     compat.globalSkills.some(n=>!skillName(n)||n===compat.workerSkill))fail('MAINTENANCE_SOURCE_REVIEW');
    targetVersion=compat.version;newSkills=new Map();
    const template=await observeSource(path.join(source,'global-rules/AGENTS.md'));
    if(!template||template.missing)fail('MAINTENANCE_SOURCE_REVIEW');
    newTemplate=utf8(bytes(template)).replaceAll('__HOST_NAME__',onboardingIdentity(config).name).replaceAll('__HOST_ROLE__',onboardingIdentity(config).role);
    if(newTemplate.includes(BEGIN)||newTemplate.includes(END)||Buffer.byteLength(newTemplate)>12288)fail('MAINTENANCE_SOURCE_REVIEW');
    for(const name of compat.globalSkills){
     const dir=path.join(source,'skills',name);if((await directory(dir,true))?.join()!=='SKILL.md')fail('MAINTENANCE_SOURCE_REVIEW');
     const s=await observeSource(path.join(dir,'SKILL.md'));if(!s||s.missing)fail('MAINTENANCE_SOURCE_REVIEW');utf8(bytes(s));newSkills.set(name,bytes(s));
    }
    if(action==='repair'&&manifest.version!==targetVersion)conflict('REPAIR_VERSION_MISMATCH');
    // A version label is not enough: repair must use the exact installed content.
    if(action==='repair'){
     const oldSkills=owned.filter(x=>x.kind==='skill');
     if(oldSkills.length!==newSkills.size||oldSkills.some(x=>!newSkills.has(x.name)||hash(newSkills.get(x.name))!==hash(x.addition)))conflict('REPAIR_SOURCE_CHANGED');
    }
   }catch{conflict('SOURCE_REVIEW');return finish({state:'needs_review',installedVersion:manifest.version});}
  }
  let projectedGlobals=0;
  const globals=new Map();for(const file of p.globalCandidates){const s=await observe(file);globals.set(file,s);if(s)projectedGlobals+=bytes(s).length;}
  for(const i of owned){
   const current=i.kind==='global_rules'?globals.get(i.path):await observe(i.path);
   if(!current)continue;
   if(i.kind==='global_rules'){
    let prefix=Buffer.alloc(0),suffix=Buffer.alloc(0);
    if(current.missing){
     if(action==='inspect'){rows.push({path:i.path,kind:i.kind,state:'missing'});conflict('FILE_MISSING',i.path);continue;}
     if(action==='uninstall'){rows.push({path:i.path,kind:i.kind,state:'already_missing'});continue;}
     // Restoring an old user prefix would silently replace later user changes.
     if(!i.createdFile){conflict('USER_RULE_FILE_MISSING',i.path);continue;}
    }else{
     const content=bytes(current);let text;
     try{text=utf8(content);}catch{conflict('ENCODING_REVIEW',i.path);continue;}
     const at=content.indexOf(i.addition);
     if(at<0||content.indexOf(i.addition,at+i.addition.length)!==-1||count(text,BEGIN)!==1||count(text,END)!==1){conflict('OWNED_RULE_BLOCK_CHANGED',i.path);continue;}
     prefix=content.subarray(0,at);suffix=content.subarray(at+i.addition.length);
    }
    const eol=checkedBlock(i.addition),next=newTemplate===null?i.addition:Buffer.from(eol+eol+BEGIN+eol+newTemplate.replace(/\r?\n/g,eol)+eol+END+eol);
    if(action==='repair'&&hash(next)!==hash(i.addition))conflict('REPAIR_SOURCE_CHANGED',i.path);
    const after=action==='uninstall'?Buffer.concat([prefix,suffix]):Buffer.concat([prefix,next,suffix]);
    // A pre-existing empty user file is retained. Only our created, still-empty file can disappear.
    const remove=action==='uninstall'&&after.length===0&&i.createdFile;
    add(i.path,i.kind,current,remove?null:after,action==='uninstall'?'remove_exact_owned_block':'preserve_user_bytes',{
     preservedUserBytes:prefix.length+suffix.length,userContentChangedOutsideBlock:!current.missing&&current.sha256!==i.afterHash,
     ...(newTemplate===null?{}:{managedText:newTemplate})},next,i.createdFile);
    projectedGlobals+=after.length-(current.size??0);
   }else{
    const folder=path.dirname(i.path),names=await directory(folder);
    if(names?.some(n=>n!=='SKILL.md'))retained.push({path:folder,reason:'unknown_sidecars_preserved',names:names.filter(n=>n!=='SKILL.md')});
    const shared=path.join(p.agents.path,'skills',i.name);const sharedNames=await directory(shared);
    if(sharedNames===null)continue;
    // Even an empty, pre-existing same-name shared directory is a conflict.
    if(observations.some(x=>x.path===shared&&!x.missing&&x.identity))conflict('SHARED_SKILL_CONFLICT',shared);
    if(!current.missing&&current.sha256!==i.afterHash){conflict('OWNED_SKILL_CHANGED',i.path);continue;}
    if(action==='inspect'){
     rows.push({path:i.path,kind:i.kind,state:current.missing?'missing':'unchanged'});
     if(current.missing)conflict('FILE_MISSING',i.path);continue;
    }
    const after=action==='uninstall'?null:newSkills?.get(i.name)??null;
    add(i.path,i.kind,current,after,after===null?'remove_unchanged_owned_skill':current.missing?'restore_missing_owned_skill':'update_owned_skill',
     after===null?{}:{managedText:utf8(after)});
   }
  }
  if(newSkills)for(const [name,data] of newSkills){
   if(owned.some(i=>i.kind==='skill'&&i.name===name))continue;
   const target=path.join(p.dsh.path,'skills',name,'SKILL.md'),dir=path.dirname(target),shared=path.join(p.agents.path,'skills',name);
   await directory(dir);await directory(shared);const before=await observe(target);
   if(observations.some(x=>[dir,shared].includes(x.path)&&!x.missing&&x.identity)){conflict('NEW_SKILL_CONFLICT',target);continue;}
   if(before)add(target,'skill',before,data,'install_new_owned_skill',{managedText:utf8(data)});
  }
  if(projectedGlobals>61440)conflict('GLOBAL_BUDGET_REVIEW');
  return finish({state:conflicts.length?'needs_review':'inspected',installationId:manifest.id,installedVersion:manifest.version,
   targetVersion,globalBytes:projectedGlobals,byteLimit:61440});
 }
 async function preview(args){
  if(!args||Object.keys(args).join()!=='action'||!['upgrade','repair','uninstall'].includes(args.action))fail('INVALID_ARGUMENTS');
  return {...(await inspect(args.action)).view,id:randomUUID(),expiresAt:now()+300000};
 }
 async function status(args={}){if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).length)fail('INVALID_ARGUMENTS');return (await inspect('inspect')).view;}
 return {available,preview,status,prepare:inspect,boundary};
}
