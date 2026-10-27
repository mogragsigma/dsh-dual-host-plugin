// Offline own-plugin repair transaction. Internal seam only: the verified runtime
// controller supplies exclusive ownership/stop proofs; no path is accepted over RPC.
import path from 'node:path';
import {randomUUID,createHmac,timingSafeEqual} from 'node:crypto';
import {fs,hash as bytesHash,bytes,snapshot,sameIdentity,identity,syncWrite,atomicState,ancestors} from './onboarding-install-fs.js';
import {publishMaintenanceItem,rollbackMaintenanceItem,statMaybe,syncDirectory} from './onboarding-maintenance-fs.js';
const hash=v=>bytesHash(typeof v==='string'||Buffer.isBuffer(v)?v:JSON.stringify(v));
const fail=c=>{throw Error('ONBOARDING_PLUGIN_REPAIR_'+c);};
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const exact=(x,k)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join()===k.slice().sort().join();
const rel=x=>typeof x==='string'&&x.length<=240&&/^[A-Za-z0-9_.\/-]+$/.test(x)&&!x.startsWith('/')&&x.split('/').every(p=>p&&p!=='.'&&p!=='..')&&!x.split('/').includes('node_modules');
const view=j=>({contract:1,id:j.id,state:j.state,planHash:j.planHash,files:j.items.map(i=>({path:i.relative,action:i.action})),scope:'stopped_owned_plugin_files_only',versionUpgrade:false,hostStarted:false,activationVerified:false,ownershipRebased:false,review:j.review??[],recoveryRequired:!['committed','rolled_back'].includes(j.state)});
export function createPluginRepair({root,operationId,runtimeId,proof,manifest,inventory,exclusive,verifyOwnedStopped,now=Date.now,hook,versionContext}){
 if(!path.isAbsolute(root)||path.resolve(root)!==root||!uuid(operationId)||!uuid(runtimeId)||!digest(proof)||typeof exclusive!=='function'||typeof verifyOwnedStopped!=='function'||!Array.isArray(manifest)||!manifest.length||manifest.length>512||!Array.isArray(inventory))fail('CONTRACT');
 const source=versionContext?.source??path.join(root,'plugin'),target=path.join(root,'runtime/plugin'),control=versionContext?.control??path.join(root,'.control/runtime'),folder=path.join(control,'plugin-repairs');
 if(versionContext){
  const relativeControl=path.relative(path.join(root,'.control/runtime/plugin-versions'),control).split(path.sep),relativeSource=path.relative(path.join(root,'.control/runtime/plugin-candidates'),source).split(path.sep);
  if(!exact(versionContext,['source','control','targetIdentity'])||relativeControl.length!==3||!uuid(relativeControl[0])||relativeControl[1]!=='repairs'||!uuid(relativeControl[2])||source!==path.join(root,'plugin')&&(relativeSource.length!==2||!uuid(relativeSource[0])||relativeSource[1]!=='plugin')||![versionContext.targetIdentity?.dev,versionContext.targetIdentity?.ino,versionContext.targetIdentity?.uid].every(Number.isSafeInteger)||versionContext.targetIdentity?.mode!==0o700)fail('CONTRACT');
 }
 const files=new Map(),owned=new Map();
 for(const f of manifest){if(!exact(f,['path','sha256'])||!rel(f.path)||!digest(f.sha256)||files.has(f.path))fail('MANIFEST');files.set(f.path,{...f});}
 for(const f of inventory){if(!exact(f,['path','identity','sha256','kind'])||!rel(f.path)||!['file','directory'].includes(f.kind)||owned.has(f.path)||!Number.isSafeInteger(f.identity?.dev)||!Number.isSafeInteger(f.identity?.ino)||f.kind==='file'&&!digest(f.sha256))fail('INVENTORY');owned.set(f.path,structuredClone(f));}
 for(const name of files.keys())if(owned.get(name)?.kind!=='file')fail('INVENTORY');
 for(const [name,row] of owned)if(row.kind==='file'&&!files.has(name))fail('INVENTORY');
 const binding=hash({operationId,runtimeId,root,manifest:[...files],inventory:[...owned],...(versionContext?{versionContext}:{})});
 const seal=body=>({...body,signature:createHmac('sha256',proof).update(JSON.stringify(body)).digest('hex')});
 function unseal(value){if(!value||!digest(value.signature))fail('JOURNAL_REVIEW');const {signature,...body}=value,expected=seal(body).signature;if(!timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(expected,'hex')))fail('JOURNAL_REVIEW');return body;}
 const planPath=path.join(control,'plugin-repair-plan.json');
 async function guard(){const p=await verifyOwnedStopped();if(!exact(p,['operationId','runtimeId','stopped','ownershipVerified'])||p.operationId!==operationId||p.runtimeId!==runtimeId||p.stopped!==true||p.ownershipVerified!==true)fail('STOP_OR_OWNERSHIP_REQUIRED');}
 async function inspect(){
  await guard();await ancestors(source);await ancestors(target);await ancestors(control);
  const targetStat=await fs.lstat(target),controlStat=await fs.lstat(control);if(targetStat.dev!==controlStat.dev)fail('CROSS_DEVICE');
  if(versionContext&&(!sameIdentity(targetStat,versionContext.targetIdentity)||targetStat.uid!==versionContext.targetIdentity.uid||(targetStat.mode&0o777)!==0o700))fail('DIRECTORY_DRIFT');
  const seen=new Set(),current=new Map();
  async function walk(dir,prefix=''){
   for(const name of (await fs.readdir(dir)).sort()){
    const relative=prefix+name,p=path.join(dir,name),o=owned.get(relative);if(!o)fail('UNKNOWN_FILE');
    const s=await fs.lstat(p);if(s.isSymbolicLink()||versionContext&&s.uid!==process.getuid())fail('UNSAFE_FILE');if(s.dev!==controlStat.dev)fail('CROSS_DEVICE');seen.add(relative);
    if(versionContext&&o.kind==='directory'&&(s.mode&0o777)!==o.identity.mode)fail('DIRECTORY_DRIFT');
    if(o.kind==='directory'){if(!s.isDirectory()||!sameIdentity(s,o.identity))fail('DIRECTORY_DRIFT');await walk(p,relative+'/');}
    else {if(!s.isFile())fail('UNSAFE_FILE');current.set(relative,await snapshot(p,4194304));}
   }
  }
  await walk(target);
  for(const [name,o] of owned)if(o.kind==='directory'&&!seen.has(name))fail('DIRECTORY_MISSING');
  const items=[];let total=0;
  for(const [name,f] of files){
   const s=await snapshot(path.join(source,name),4194304);if(s.missing||s.sha256!==f.sha256)fail('SOURCE_DRIFT');
   const before=current.get(name)??{missing:true};
   if(!before.missing&&before.mode!==0o600)fail('MODE_REVIEW');
   if(!before.missing&&before.sha256===f.sha256){if(versionContext&&!sameIdentity(before,owned.get(name).identity))fail('OWNERSHIP_DRIFT');continue;}
   total+=bytes(s).length+(before.missing?0:bytes(before).length);if(total>8388608)fail('SIZE_LIMIT');
   items.push({relative:name,path:path.join(target,name),action:before.missing?'create':'replace',before,after:s.data,afterHash:s.sha256,phase:'pending'});
  }
  // Directory link counts change when the durable preview is created (APFS).
  // Keep inode/device/mode/owner identity; file hard-link checks remain strict.
  const directory=s=>({dev:s.dev,ino:s.ino,mode:s.mode&0o777,uid:s.uid});
  return {items,targetIdentity:directory(targetStat),controlIdentity:directory(controlStat),observations:[...current].map(([name,s])=>({name,...s,data:undefined}))};
 }
 const journalPath=id=>path.join(folder,id,'journal.json');
 async function save(j){await atomicState(journalPath(j.id),seal(j));}
 async function read(id){
  if(!uuid(id))fail('ARGUMENTS');const s=await snapshot(journalPath(id),16777216);if(s.missing)fail('NOT_FOUND');let j;try{j=unseal(JSON.parse(bytes(s)));}catch{fail('JOURNAL_REVIEW');}
  if(j?.schema!==1||j.id!==id||j.binding!==binding||!digest(j.planHash)||!['applying','committed','rolling_back','rolled_back','needs_review'].includes(j.state)||!Array.isArray(j.items)||!j.items.length||j.items.length>512||new Set(j.items.map(x=>x.relative)).size!==j.items.length)fail('JOURNAL_REVIEW');
  for(const i of j.items){
   if(!files.has(i.relative)||i.path!==path.join(target,i.relative)||!['create','replace'].includes(i.action)||!['pending','intent','done','restored'].includes(i.phase)||!i.before||i.action==='create'&&!i.before.missing||i.action==='replace'&&i.before.missing||!i.before.missing&&(hash(bytes(i.before))!==i.before.sha256||bytes(i.before).length!==i.before.size)||typeof i.after!=='string'||hash(Buffer.from(i.after,'base64'))!==files.get(i.relative).sha256||i.afterHash!==files.get(i.relative).sha256||i.published&&(i.published.sha256!==i.afterHash||i.published.size!==Buffer.from(i.after,'base64').length))fail('JOURNAL_REVIEW');
  }
  if(!sameIdentity(await fs.lstat(path.dirname(journalPath(id))),j.directoryIdentity))fail('DIRECTORY_DRIFT');
  const names=new Set(['journal.json',...j.items.flatMap((_,n)=>['stage-'+n,'backup-'+n])]);if((await fs.readdir(path.dirname(journalPath(id)))).some(n=>!names.has(n)))fail('JOURNAL_REVIEW');
  if(!sameIdentity(await fs.lstat(target),j.targetIdentity)||!sameIdentity(await fs.lstat(control),j.controlIdentity))fail('DIRECTORY_DRIFT');return j;
 }
 async function pending(){
  const stat=await statMaybe(folder);if(!stat)return null;await ancestors(folder);
  for(const name of await fs.readdir(folder)){if(!uuid(name))fail('JOURNAL_REVIEW');const j=await read(name);if(!['committed','rolled_back'].includes(j.state))return j;}
  return null;
 }
 async function rollback(j){
  await guard();j.state='rolling_back';await save(j);const review=[];
  for(let n=j.items.length-1;n>=0;n--){try{await guard();if(j.items[n].phase==='pending'&&(await statMaybe(path.join(path.dirname(journalPath(j.id)),'stage-'+n))||await statMaybe(path.join(path.dirname(journalPath(j.id)),'backup-'+n))))fail('UNRECORDED_STAGE');await rollbackMaintenanceItem(j.items[n],path.dirname(journalPath(j.id)),n,4194304);j.items[n].phase='restored';await save(j);}catch{review.push({path:j.items[n].relative,reason:'changed_or_unverified_preserved'});}}
  j.review=review;j.state=review.length?'needs_review':'rolled_back';await save(j);return view(j);
 }
 async function preview(){return exclusive(async()=>{
  if(await pending())fail('RECOVERY_REQUIRED');if(!(await snapshot(planPath,16777216)).missing)await loadPlan();const observation=await inspect(),id=randomUUID(),expiresAt=now()+300000;
  const fingerprint=hash({binding,observation,id,expiresAt});await atomicState(planPath,seal({binding,id,expiresAt,fingerprint,observation}));
  return {id,fingerprint,expiresAt,canApply:observation.items.length>0,changes:observation.items.map(i=>({path:i.relative,action:i.action,beforeHash:i.before.sha256??null,afterHash:i.afterHash})),scope:'stopped_owned_plugin_files_only',userDataChanged:false,credentialsChanged:false,versionUpgrade:false,hostStarted:false};
 });}
 async function loadPlan(){const s=await snapshot(planPath,16777216);if(s.missing)fail('PLAN_EXPIRED');let p;try{p=unseal(JSON.parse(bytes(s)));}catch{fail('JOURNAL_REVIEW');}if(p.binding!==binding||hash({binding,observation:p.observation,id:p.id,expiresAt:p.expiresAt})!==p.fingerprint)fail('PLAN_DRIFT');return p;}
 async function validate(a){return exclusive(async()=>{if(!exact(a,['id','fingerprint','confirm'])||a.confirm!==true||!uuid(a.id)||!digest(a.fingerprint))fail('CONFIRMATION_REQUIRED');await guard();if(await pending())fail('RECOVERY_REQUIRED');const p=await loadPlan();if(p.id!==a.id||p.fingerprint!==a.fingerprint||p.expiresAt<=now())fail('PLAN_EXPIRED');if(!p.observation.items.length||hash(await inspect())!==hash(p.observation))fail('PLAN_DRIFT');return {id:p.id,fingerprint:p.fingerprint,ready:true};});}
 async function apply(a){return exclusive(async()=>{
  if(!exact(a,['id','fingerprint','confirm'])||a.confirm!==true||!uuid(a.id)||!digest(a.fingerprint))fail('CONFIRMATION_REQUIRED');await guard();
  if(await statMaybe(journalPath(a.id))){const old=await read(a.id);if(old.planHash!==a.fingerprint)fail('PLAN_DRIFT');return {...view(old),notResent:true};}
  if(await pending())fail('RECOVERY_REQUIRED');const p=await loadPlan();
  if(p.id!==a.id||p.fingerprint!==a.fingerprint||p.expiresAt<=now())fail('PLAN_EXPIRED');
  const fresh=await inspect();if(hash(fresh)!==hash(p.observation)||!fresh.items.length)fail('PLAN_DRIFT');
  await fs.mkdir(folder,{recursive:true,mode:0o700});if((await fs.readdir(folder)).length>=128)fail('HISTORY_FULL');const dir=path.dirname(journalPath(p.id));await fs.mkdir(dir,{mode:0o700});await syncDirectory(folder);
  const j={schema:1,id:p.id,binding,planHash:p.fingerprint,state:'applying',items:fresh.items,targetIdentity:fresh.targetIdentity,controlIdentity:fresh.controlIdentity,directoryIdentity:identity(await fs.lstat(dir)),review:[]};await save(j);
  try{
   for(let n=0;n<j.items.length;n++){await guard();await publishMaintenanceItem(j.items[n],dir,n,()=>save(j),hook,4194304);}
   await guard();for(const i of j.items){const s=await snapshot(i.path,4194304);if(s.sha256!==i.afterHash||!sameIdentity(s,i.published))fail('PUBLISH_DRIFT');}
   j.state='committed';await save(j);return view(j);
  }catch(e){j.error=/^[A-Z_]+$/.test(e.message)?e.message:'REPAIR_INTERRUPTED';await save(j);return rollback(j);}
 });}
 async function recover(a){return exclusive(async()=>{if(!exact(a,['id','confirm'])||a.confirm!==true||!uuid(a.id))fail('CONFIRMATION_REQUIRED');await guard();
  if(!await statMaybe(path.dirname(journalPath(a.id)))){const p=await loadPlan();if(p.id!==a.id||hash(await inspect())!==hash(p.observation))fail('JOURNAL_REVIEW');return {...view({id:p.id,planHash:p.fingerprint,state:'rolled_back',items:p.observation.items}),unchangedPreimageObserved:true};}
  const j=await read(a.id);if(['committed','rolled_back'].includes(j.state))return {...view(j),notResent:true};return rollback(j);
 });}
 async function status(a){return exclusive(async()=>{if(!exact(a,['id']))fail('ARGUMENTS');return view(await read(a.id));});}
 // Only a verified committed publication can supply replacement ownership.
 // Do not rescan/adopt all current files or use a post-crash new inode as proof.
 async function ownership(a){return exclusive(async()=>{if(!exact(a,['id']))fail('ARGUMENTS');await guard();const j=await read(a.id);if(j.state!=='committed')fail('NOT_COMMITTED');const rows=[];
  for(const i of j.items){const s=await snapshot(i.path,4194304);if(!i.published||s.missing||s.sha256!==i.afterHash||s.mode!==0o600||!sameIdentity(s,i.published))fail('PUBLISH_DRIFT');rows.push({path:i.relative,sha256:s.sha256,bytes:s.size,identity:identity(s)});}
  return rows;
 });}
 return {preview,validate,apply,recover,status,ownership};
}
