import {packageSourceSnapshot} from './onboarding-package-source.js';
// Initial installation only. Existing owned installations are verified, never upgraded implicitly.
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {onboardingBoundary} from './onboarding-boundary.js';
import {onboardingIdentity} from './onboarding-identity.js';
import {createOnboardingMaintenance} from './onboarding-maintenance.js';
import {fs,hash,fail,inside,identity,sameIdentity,ancestors,snapshot,bytes,equal,syncWrite,atomicState,appendExact,restoreAppend,cleanStage} from './onboarding-install-fs.js';
const activeTransactions=new Set();
const BEGIN='<!-- dsh-dual-host:begin -->',END='<!-- dsh-dual-host:end -->';
const uuid=s=>typeof s==='string'&&/^[a-f0-9-]{36}$/.test(s);
const utf8=b=>{const t=b.toString('utf8');if(!Buffer.from(t).equals(b)||t.includes('\0'))fail('ENCODING_REVIEW');return t;};
export function createOnboardingInstaller(config={},runtime={}){
 const now=runtime.now??Date.now;
 const source=runtime.source??path.dirname(fileURLToPath(import.meta.url));
 let busy=false,plans=new Map();
 function boundary(){
  onboardingIdentity(config);
  return onboardingBoundary(config,runtime,'installation');
 }
 const available=()=>{try{boundary();return true;}catch{return false;}};
 async function context(){
  const {paths:p,roots,isolated}=boundary();
  for(const root of roots){if((await ancestors(path.dirname(root))).some(x=>x.missing))fail('INSTALL_PARENT_REVIEW');await ancestors(root);}
  const compat=JSON.parse(utf8(bytes(await packageSourceSnapshot(path.join(source,'compatibility.json')))));
  const names=compat.globalSkills;if(!Array.isArray(names)||names.length>64||new Set(names).size!==names.length||names.some(n=>!/^[a-z][a-z0-9-]+$/.test(n)||n===compat.workerSkill))fail('INSTALL_SOURCE_INVALID');
  const sources=[];
  for(const name of names){const dir=path.join(source,'skills',name);if((await fs.readdir(dir)).join()!=='SKILL.md')fail('INSTALL_SOURCE_INVALID');const file=path.join(dir,'SKILL.md'),s=await packageSourceSnapshot(file);const b=bytes(s);utf8(b);sources.push({name,data:b.toString('base64'),hash:hash(b)});}
  const template=utf8(bytes(await packageSourceSnapshot(path.join(source,'global-rules/AGENTS.md')))).replaceAll('__HOST_NAME__',onboardingIdentity(config).name).replaceAll('__HOST_ROLE__',onboardingIdentity(config).role);
  const state=path.join(p.dsh.path,'dual-host-onboarding');
  const allowed=new Set([...p.globalCandidates,...sources.map(s=>path.join(p.dsh.path,'skills',s.name,'SKILL.md'))]);
  return {p,roots,isolated,compat,sources,template,state,allowed};
 }
 async function readJSON(file){const s=await snapshot(file,2097152);return s.missing?null:JSON.parse(utf8(bytes(s)));}
 const publicReceipt=j=>({id:j.id,state:j.state,error:j.error??null,review:j.review??[],files:j.items.map(i=>({path:i.path,action:i.action})),initialization:false,activationVerified:false,canRecover:['applying','rolling_back','needs_review'].includes(j.state)});
 async function status(){
  const c=await context(),lock=await readJSON(path.join(c.state,'lock.json'));
  if(lock?.kind==='maintenance')return createOnboardingMaintenance(config,runtime).status();
  if(lock){if(!uuid(lock.id))fail('JOURNAL_REVIEW');const j=await readJSON(path.join(c.state,'transactions',lock.id,'journal.json'));if(j)validateJournal(c,j);return j?publicReceipt(j):{state:'needs_review',id:lock.id,error:'INCOMPLETE_JOURNAL'};}
  const latest=await readJSON(path.join(c.state,'latest.json'));if(!latest)return {state:'not_installed',initialization:false};
  if(latest.kind==='maintenance')return createOnboardingMaintenance(config,runtime).status();
  if(!uuid(latest.id))fail('JOURNAL_REVIEW');const j=await readJSON(path.join(c.state,'transactions',latest.id,'journal.json'));validateJournal(c,j);
  const receipt={...publicReceipt(j),canRecover:false};
  if(j.state==='committed'){
   const review=[];for(const i of j.items)try{if((await snapshot(i.path)).sha256!==i.afterHash)review.push({path:i.path,reason:'installed_content_changed'});}catch{review.push({path:i.path,reason:'installed_content_unreadable'});}
   if(review.length)return {...receipt,state:'needs_review',error:'ONBOARDING_INSTALLED_CONTENT_CHANGED',review};
  }
  return receipt;
 }
 async function build(selection={}){
  if(Object.keys(selection).some(k=>k!=='ruleRoot')||selection.ruleRoot!==undefined&&!['dsh','shared'].includes(selection.ruleRoot))fail('INVALID_ARGUMENTS');
  const c=await context(),conflicts=[],ops=[],observations=[];
  const observe=async file=>{try{const s=await snapshot(file);observations.push({path:file,snapshot:s,parents:await ancestors(path.dirname(file))});return s;}catch(e){conflicts.push({path:file,code:e.message});return null;}};
  const globals=await Promise.all(c.p.globalCandidates.map(observe));
  const manifestFile=path.join(c.state,'installed.json'),manifestSnapshot=await observe(manifestFile);
  const lock=await observe(path.join(c.state,'lock.json'));if(lock&&!lock.missing)conflicts.push({code:'ONBOARDING_RECOVERY_REQUIRED'});
  const latest=await observe(path.join(c.state,'latest.json'));
  let manifest=null;if(manifestSnapshot&&!manifestSnapshot.missing){try{manifest=JSON.parse(utf8(bytes(manifestSnapshot)));if(![1,2].includes(manifest.schema)||!uuid(manifest.id)||!Array.isArray(manifest.files))throw Error();}catch{conflicts.push({code:'ONBOARDING_MANIFEST_REVIEW'});}}
  if(manifest?.schema===2){const current=await createOnboardingMaintenance(config,runtime).status();if(current.state!=='inspected')conflicts.push({code:'ONBOARDING_MAINTENANCE_REQUIRED'});}
  const oldGlobals=globals.map(s=>s?utf8(bytes(s)):null);
  let index=selection.ruleRoot==='shared'?1:selection.ruleRoot==='dsh'?0:null;
  if(index===null){const found=globals.map((s,i)=>s&&!s.missing?i:null).filter(i=>i!==null);if(found.length>1)conflicts.push({code:'ONBOARDING_GLOBAL_TARGET_AMBIGUOUS'});index=found.length===1?found[0]:0;}
  const target=c.p.globalCandidates[index],before=globals[index];
  const line=before&&utf8(bytes(before)).includes('\r\n')?'\r\n':'\n';
  const block=line+line+BEGIN+line+c.template.replace(/\r?\n/g,line)+line+END+line;
  const owned=manifest?.files?.find(x=>x.path===target);
  if(before){
   if(owned){if(before.sha256!==owned.sha256||owned.sourceHash!==hash(block)||manifest.version!==c.compat.version)conflicts.push({path:target,code:'ONBOARDING_OWNED_CONTENT_REVIEW'});}
   else if(oldGlobals.some(t=>t&&(t.includes(BEGIN)||t.includes(END)||/^## 双端协作（/m.test(t))))conflicts.push({path:target,code:'ONBOARDING_UNOWNED_RULE_BLOCK'});
   else if(!before.missing&&!(before.mode&0o200))conflicts.push({path:target,code:'ONBOARDING_READ_ONLY_FILE'});
   else{const after=Buffer.concat([bytes(before),Buffer.from(block)]);ops.push({path:target,action:before.missing?'create':'append',before,after:after.toString('base64'),afterHash:hash(after),addition:block,sourceHash:hash(block)});}
  }
  const projected=globals.reduce((n,s,i)=>n+(s?bytes(s).length:0)+(i===index&&!owned?Buffer.byteLength(block):0),0);
  if(projected>61440)conflicts.push({code:'ONBOARDING_GLOBAL_BUDGET_REVIEW'});
  for(const s of c.sources){
   const dest=path.join(c.p.dsh.path,'skills',s.name,'SKILL.md'),existing=await observe(dest),folder=path.dirname(dest);let dirExists=false;try{await fs.lstat(folder);dirExists=true;}catch(e){if(e.code!=='ENOENT')throw e;}
   const row=manifest?.files?.find(x=>x.path===dest);
   if(row){if(!existing||existing.sha256!==row.sha256||row.sourceHash!==s.hash||manifest.version!==c.compat.version)conflicts.push({path:dest,code:'ONBOARDING_OWNED_CONTENT_REVIEW'});}
   else if(dirExists||existing&&!existing.missing)conflicts.push({path:dest,code:'ONBOARDING_SKILL_CONFLICT'});
   else if(existing)ops.push({path:dest,action:'create',before:existing,after:s.data,afterHash:s.hash,sourceHash:s.hash});
   // Shared root wins/duplicates must be reviewed too; never silently shadow a user Skill.
   const sharedDir=path.join(c.p.agents.path,'skills',s.name);
   try{observations.push({path:sharedDir,parents:await ancestors(path.dirname(sharedDir))});await fs.lstat(sharedDir);conflicts.push({path:sharedDir,code:'ONBOARDING_SKILL_CONFLICT'});}catch(e){if(e.code!=='ENOENT')conflicts.push({path:sharedDir,code:e.message});}
   observations.push({path:sharedDir,directoryAbsent:true});
  }
  if(manifest){const expected=[target,...c.sources.map(s=>path.join(c.p.dsh.path,'skills',s.name,'SKILL.md'))];if(manifest.files.length!==expected.length||manifest.files.some(x=>!expected.includes(x.path)))conflicts.push({code:'ONBOARDING_MANIFEST_REVIEW'});}
  observations.sort((a,b)=>a.path.localeCompare(b.path));conflicts.sort((a,b)=>(a.path??'').localeCompare(b.path??'')||a.code.localeCompare(b.code));
  const fingerprint=hash(JSON.stringify({selection,observations,ops,conflicts,version:c.compat.version,projected,roots:c.roots}));
  return {c,selection,ops,conflicts,fingerprint,manifest,observations,projected,target};
 }
 function view(p){return {id:p.id,fingerprint:p.fingerprint,expiresAt:p.expiresAt,canApply:!p.conflicts.length&&p.ops.length>0,alreadyInstalled:!p.conflicts.length&&p.ops.length===0,conflicts:p.conflicts,scope:p.c.isolated?'isolated_global_rules_and_skills_only':'current_host_global_rules_and_skills_only',target:p.target,globalBytes:p.projected,byteLimit:61440,changes:p.ops.map(o=>({path:o.path,action:o.action,beforeHash:o.before.sha256??null,afterHash:o.afterHash,preservedBytes:bytes(o.before).length,addedText:o.action==='append'?o.addition:Buffer.from(o.after,'base64').toString('utf8')})),notECSInitialization:true,activationVerified:false};}
 async function preview(selection={}){const p=await build(selection);p.id=randomUUID();p.expiresAt=now()+300000;plans.clear();plans.set(p.id,p);return view(p);}
 async function journalSave(c,j){await atomicState(path.join(c.state,'transactions',j.id,'journal.json'),j);}
 async function ensureDirs(c,j,dir){
  const paths=await ancestors(dir);
  for(const entry of paths.filter(x=>x.missing)){
   if(!c.roots.some(root=>inside(root,entry.path)))fail('UNSAFE_PATH');j.dirs.push({path:entry.path,identity:null});await journalSave(c,j);
   await fs.mkdir(entry.path,{mode:0o700});const s=await fs.lstat(entry.path);j.dirs.at(-1).identity=identity(s);await journalSave(c,j);
  }
 }
 async function rollback(c,j){
  j.state='rolling_back';await journalSave(c,j);const review=[];
  for(const i of [...j.items].reverse())if(i.phase==='intent'||i.phase==='done')try{
   if(i.action==='create')await cleanStage(path.join(c.state,'transactions',j.id,'stage-'+j.items.indexOf(i)),i.path,i);
   const current=await snapshot(i.path);if(i.before.missing&&current.missing||!i.before.missing&&current.sha256===i.before.sha256)continue;
   if(current.sha256!==i.afterHash||!sameIdentity(current,i.publishedIdentity))fail('ROLLBACK_DRIFT');
   if(i.action==='append')await restoreAppend(i.path,i);else await fs.unlink(i.path);
  }catch{review.push({path:i.path,reason:'changed_or_unreadable_preserved'});}
  for(const d of [...j.dirs].reverse())try{
   const s=await fs.lstat(d.path);if(!sameIdentity(s,d.identity)||s.isSymbolicLink())fail('ROLLBACK_DRIFT');await fs.rmdir(d.path);
  }catch(e){if(e.code!=='ENOENT')review.push({path:d.path,reason:'directory_preserved'});}
  const mf=path.join(c.state,'installed.json');try{const m=await readJSON(mf);if(m?.id===j.id)await fs.unlink(mf);else if(m)fail('ROLLBACK_DRIFT');}catch{review.push({path:mf,reason:'manifest_preserved'});}
  j.review=review;j.state=review.length?'needs_review':'rolled_back';await journalSave(c,j);await atomicState(path.join(c.state,'latest.json'),{id:j.id});
  if(!review.length)await fs.unlink(path.join(c.state,'lock.json'));return publicReceipt(j);
 }
 function validateJournal(c,j){
  if(!j||j.schema!==1||!uuid(j.id)||!Array.isArray(j.items)||j.items.length>65||!Array.isArray(j.dirs)||j.dirs.length>132||!['applying','committed','rolling_back','rolled_back','needs_review'].includes(j.state)||new Set(j.items.map(i=>i.path)).size!==j.items.length)fail('JOURNAL_REVIEW');
  for(const i of j.items){if(!c.allowed.has(i.path)||!['pending','intent','done'].includes(i.phase)||!['append','create'].includes(i.action)||!i.before||typeof i.after!=='string'||i.action==='append'&&(!c.p.globalCandidates.includes(i.path)||i.before.missing||!Buffer.from(i.after,'base64').subarray(0,i.before.size).equals(bytes(i.before)))||i.action==='create'&&i.before.missing!==true||hash(Buffer.from(i.after,'base64'))!==i.afterHash||!i.before.missing&&hash(bytes(i.before))!==i.before.sha256)fail('JOURNAL_REVIEW');}
  const possibleDirs=new Set(j.items.flatMap(i=>{let p=path.dirname(i.path),a=[];while(c.roots.some(root=>inside(root,p))){a.push(p);p=path.dirname(p);}return a;}));
  if(j.dirs.some(d=>!possibleDirs.has(d.path)))fail('JOURNAL_REVIEW');
 }
 async function apply(args){
  if(!args||Object.keys(args).sort().join()!=='confirm,fingerprint,id'||args.confirm!==true||!uuid(args.id))fail('INVALID_ARGUMENTS');
  if(busy)fail('INSTALL_BUSY');const plan=plans.get(args.id);if(!plan||plan.fingerprint!==args.fingerprint||now()>plan.expiresAt)fail('PLAN_EXPIRED');
  if(plan.conflicts.length||!plan.ops.length)fail('PLAN_BLOCKED');busy=true;plans.delete(args.id);let c,j,locked=false;
  try{
   const fresh=await build(plan.selection);if(fresh.fingerprint!==plan.fingerprint)fail('PLAN_DRIFT');c=fresh.c;
   // Own private state is created only after an explicit apply, never by preview.
   await ancestors(c.state);await fs.mkdir(c.state,{recursive:true,mode:0o700});
   try{await syncWrite(path.join(c.state,'lock.json'),JSON.stringify({id:args.id,pid:process.pid}));locked=true;activeTransactions.add(c.state);}catch(e){if(e.code==='EEXIST')fail('INSTALL_BUSY');throw e;}
   await fs.mkdir(path.join(c.state,'transactions'),{recursive:true,mode:0o700});await fs.mkdir(path.join(c.state,'transactions',args.id),{mode:0o700});
   j={schema:1,id:args.id,version:c.compat.version,state:'applying',created:now(),fingerprint:args.fingerprint,items:fresh.ops.map(o=>({...o,phase:'pending'})),dirs:[]};await journalSave(c,j);
   for(let n=0;n<j.items.length;n++){
    const i=j.items[n];await ensureDirs(c,j,path.dirname(i.path));if(!equal(await snapshot(i.path),i.before))fail('FILE_DRIFT');
    if(i.action==='create'){
     const stage=path.join(c.state,'transactions',j.id,'stage-'+n);await syncWrite(stage,Buffer.from(i.after,'base64'));i.publishedIdentity=identity(await fs.lstat(stage));
     i.phase='intent';await journalSave(c,j);await fs.link(stage,i.path);await runtime.afterPublish?.(n+1,i.path);await fs.unlink(stage);
    }else{i.publishedIdentity=i.before;i.phase='intent';await journalSave(c,j);await appendExact(i.path,i.before,Buffer.from(i.addition));}
    if((await snapshot(i.path)).sha256!==i.afterHash)fail('FILE_DRIFT');i.phase='done';await journalSave(c,j);await runtime.afterWrite?.(n+1,i.path);
   }
   const manifest={schema:1,id:j.id,version:c.compat.version,files:j.items.map(i=>({path:i.path,sha256:i.afterHash,sourceHash:i.sourceHash}))};
   await atomicState(path.join(c.state,'installed.json'),manifest);j.state='committed';await journalSave(c,j);await atomicState(path.join(c.state,'latest.json'),{id:j.id});await fs.unlink(path.join(c.state,'lock.json'));return publicReceipt(j);
  }catch(e){if(locked&&j){j.error=/^ONBOARDING_[A-Z_]+$/.test(e.message)?e.message:'ONBOARDING_INSTALL_FAILED';return await rollback(c,j);}throw e;}finally{if(locked&&c)activeTransactions.delete(c.state);busy=false;}
 }
 async function recover(args){
  if(!args||Object.keys(args).sort().join()!=='confirm,id'||args.confirm!==true||!uuid(args.id))fail('INVALID_ARGUMENTS');if(busy)fail('INSTALL_BUSY');busy=true;
  try{const c=await context(),lock=await readJSON(path.join(c.state,'lock.json'));if(lock?.kind==='maintenance')fail('MAINTENANCE_RECOVERY_REQUIRED');if(activeTransactions.has(c.state))fail('INSTALL_BUSY');if(!lock||lock.id!==args.id)fail('RECOVERY_NOT_PENDING');
   if(!Number.isSafeInteger(lock.pid)||lock.pid<1)fail('JOURNAL_REVIEW');
   if(lock.pid!==process.pid){try{process.kill(lock.pid,0);fail('INSTALL_BUSY');}catch(e){if(e.code!=='ESRCH')throw e;}}
   const j=await readJSON(path.join(c.state,'transactions',args.id,'journal.json'));validateJournal(c,j);
   if(j.state==='committed'){for(const i of j.items)if((await snapshot(i.path)).sha256!==i.afterHash)fail('ROLLBACK_DRIFT');await fs.unlink(path.join(c.state,'lock.json'));return publicReceipt(j);}
   return await rollback(c,j);
  }finally{busy=false;}
 }
 return {available,preview,apply,status,recover};
}
