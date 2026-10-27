// Internal offline version transaction. The original installer must explicitly
// provide this contract, its original inventory, an exclusive lock and stop proof.
// No arbitrary path, network fetch, Host startup or rules installation is exposed.
import path from 'node:path';
import {randomUUID,createHmac,timingSafeEqual} from 'node:crypto';
import {fs,hash as sha,bytes,snapshot,sameIdentity,syncWrite,atomicState,ancestors} from './onboarding-install-fs.js';
import {statMaybe,syncDirectory} from './onboarding-maintenance-fs.js';
import {renameExclusive} from './onboarding-exclusive-rename.js';
import {createVersionRepair} from './onboarding-version-repair.js';
const hash=x=>sha(JSON.stringify(x)),fail=c=>{throw Error('ONBOARDING_PLUGIN_VERSION_'+c);};
const exact=(x,k)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join()===k.slice().sort().join();
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const version=x=>typeof x==='string'&&x.length<100&&/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(x);
const relative=x=>typeof x==='string'&&x.length<=240&&/^[A-Za-z0-9_./-]+$/.test(x)&&x.split('/').every(p=>p&&p!=='.'&&p!=='..'&&p!=='node_modules'&&p!=='.control');
const id=s=>({dev:s.dev,ino:s.ino,uid:s.uid,mode:s.mode&0o777});
const terminal=j=>['committed','rolled_back'].includes(j.state);
const stateView=j=>({contract:1,id:j.id,state:j.state,fromVersion:j.before.version,toVersion:j.after.version,scope:'stopped_owned_plugin_image_only',hostStarted:false,activationVerified:false,globalRulesChanged:false,credentialsChanged:false,backupsRetained:true,recoveryRequired:!terminal(j)});
function manifest(value){
 if(!Array.isArray(value)||!value.length||value.length>512)fail('MANIFEST');
 const seen=new Set(),dirs=new Set(['']);
 for(const f of value){if(!exact(f,['path','sha256'])||!relative(f.path)||!digest(f.sha256)||seen.has(f.path.toLowerCase()))fail('MANIFEST');seen.add(f.path.toLowerCase());let p=path.posix.dirname(f.path);while(p!=='.'){dirs.add(p);p=path.posix.dirname(p);}}
 if(dirs.size>2048||[...dirs].some(p=>seen.has(p.toLowerCase()))||new Set([...dirs].map(p=>p.toLowerCase())).size!==dirs.size||!value.some(f=>f.path==='package.json'))fail('MANIFEST');
 return {files:value.map(f=>({...f})).sort((a,b)=>a.path.localeCompare(b.path,'en')),dirs:[...dirs].sort()};
}
function release(value){
 if(!exact(value,['version','manifest','image'])||!version(value.version)||!Array.isArray(value.image))fail('INVENTORY');
 const m=manifest(value.manifest),expected=new Map([...m.dirs.map(p=>[p,null]),...m.files.map(f=>[f.path,f.sha256])]);
 const seen=new Set();for(const e of value.image){
  if(!e||!expected.has(e.path)||seen.has(e.path)||!['dev','ino','uid','mode'].every(k=>Number.isSafeInteger(e[k])&&e[k]>=0))fail('INVENTORY');seen.add(e.path);
  if(expected.get(e.path)===null){if(!exact(e,['path','kind','dev','ino','uid','mode'])||e.kind!=='directory'||e.mode!==0o700)fail('INVENTORY');}
  else if(!exact(e,['path','kind','dev','ino','uid','mode','bytes','sha256'])||e.kind!=='file'||e.mode!==0o600||e.sha256!==expected.get(e.path)||!Number.isSafeInteger(e.bytes)||e.bytes<0||e.bytes>4194304)fail('INVENTORY');
 }
 if(seen.size!==expected.size)fail('INVENTORY');return {version:value.version,manifest:m.files,image:structuredClone(value.image).sort((a,b)=>a.path.localeCompare(b.path,'en'))};
}
export function createPluginVersion({root,operationId,runtimeId,proof,initial,exclusive,verifyOwnedStopped,moveImage=renameExclusive,now=Date.now,hook,verifyRepairCandidate}){
 if(!path.isAbsolute(root)||path.resolve(root)!==root||!uuid(operationId)||!uuid(runtimeId)||!digest(proof)||typeof exclusive!=='function'||typeof verifyOwnedStopped!=='function'||typeof moveImage!=='function'||typeof process.getuid!=='function')fail('CONTRACT');
 const original=release(initial),binding=hash({root,operationId,runtimeId,initial:original});
 const control=path.join(root,'.control/runtime'),folder=path.join(control,'plugin-versions'),target=path.join(root,'runtime/plugin'),planFile=path.join(control,'plugin-version-plan.json');
 const txn=id=>path.join(folder,id),journal=id=>path.join(txn(id),'journal.json');
 const seal=body=>({...body,signature:createHmac('sha256',proof).update(JSON.stringify(body)).digest('hex')});
 function unseal(v){if(!v||!digest(v.signature))fail('JOURNAL_REVIEW');const{signature,...body}=v;if(!timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(seal(body).signature,'hex')))fail('JOURNAL_REVIEW');return body;}
 async function signedFile(p){const s=await snapshot(p,33554432);if(s.missing)fail('NOT_FOUND');if(s.mode!==0o600)fail('JOURNAL_REVIEW');try{return unseal(JSON.parse(bytes(s)));}catch{fail('JOURNAL_REVIEW');}}
 async function privateDir(p){await ancestors(p);const s=await fs.lstat(p);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o777)!==0o700)fail('DIRECTORY_REVIEW');return id(s);}
 async function guard(){const p=await verifyOwnedStopped();if(!exact(p,['operationId','runtimeId','stopped','ownershipVerified'])||p.operationId!==operationId||p.runtimeId!==runtimeId||p.stopped!==true||p.ownershipVerified!==true)fail('STOP_OR_OWNERSHIP_REQUIRED');await privateDir(control);}
 async function image(p){
  await ancestors(path.dirname(p));if(!await statMaybe(p))return null;
  const rows=[];let total=0;
  async function walk(dir,name){
   const s=await fs.lstat(dir);if(rows.length>=4096||s.isSymbolicLink()||s.uid!==process.getuid())fail('UNSAFE_IMAGE');
   if(s.isDirectory()){if((s.mode&0o777)!==0o700)fail('MODE_REVIEW');rows.push({path:name,kind:'directory',...id(s)});for(const child of (await fs.readdir(dir)).sort()){const rel=name?name+'/'+child:child;if(!relative(rel))fail('UNSAFE_IMAGE');await walk(path.join(dir,child),rel);}if(!sameIdentity(await fs.lstat(dir),s))fail('IMAGE_DRIFT');}
   else if(s.isFile()&&s.nlink===1){const b=await snapshot(dir,4194304);if(!sameIdentity(s,b)||b.mode!==0o600)fail('IMAGE_DRIFT');total+=b.size;if(total>16777216)fail('SIZE_LIMIT');rows.push({path:name,kind:'file',...id(s),bytes:b.size,sha256:b.sha256});}
   else fail('UNSAFE_IMAGE');
  }
  await walk(p,'');return rows.sort((a,b)=>a.path.localeCompare(b.path,'en'));
 }
 const matches=async(p,expected)=>hash(await image(p))===hash(expected);
 async function verifyImage(p,expected){if(!await matches(p,expected))fail('IMAGE_DRIFT');}
 async function readAll(){
  if(!await statMaybe(folder))return [];await privateDir(folder);const names=await fs.readdir(folder);if(names.length>128||names.some(n=>!uuid(n)))fail('JOURNAL_REVIEW');
  const rows=[];for(const name of names){const j=await signedFile(journal(name));
   if(j.binding!==binding||j.id!==name||j.schema!==1||!Number.isSafeInteger(j.sequence)||j.sequence<1||!digest(j.planHash)||!digest(j.parentHash)||!['preparing','applying','committed','rolling_back','rolled_back','needs_review'].includes(j.state)||!uuid(j.candidateId))fail('JOURNAL_REVIEW');
   if(hash(await privateDir(txn(name)))!==hash(j.directoryIdentity)||hash(release(j.before))!==hash(j.before)||!version(j.after?.version)||j.after.version===j.before.version||hash(manifest(j.after.manifest).files)!==hash(j.after.manifest))fail('JOURNAL_REVIEW');
   if(j.stage!==null&&hash(release({...j.after,image:j.stage}))!==hash({...j.after,image:j.stage}))fail('JOURNAL_REVIEW');
   if(['applying','committed','rolling_back'].includes(j.state)&&!j.stage)fail('JOURNAL_REVIEW');
   if((await fs.readdir(txn(name))).some(n=>!['journal.json','stage','backup','discarded','repairs'].includes(n)))fail('JOURNAL_REVIEW');await repair.validate(j);rows.push(j);
  }
  rows.sort((a,b)=>a.sequence-b.sequence);let current=original,parent=binding;
  for(let n=0;n<rows.length;n++){const j=rows[n];if(j.sequence!==n+1||j.parentHash!==parent||hash(j.before)!==hash(current)||n<rows.length-1&&!terminal(j))fail('JOURNAL_REVIEW');if(terminal(j)&&n<rows.length-1)current=repair.current(j);parent=hash(j);}
  return rows;
 }
 function active(rows){const j=rows.at(-1);if(j&&!terminal(j))fail('RECOVERY_REQUIRED');return j?repair.current(j):original;}
 async function loadPlan(){const p=await signedFile(planFile);if(p.binding!==binding||!uuid(p.id)||!['switch','rollback'].includes(p.kind)||hash({...p,fingerprint:undefined})!==p.fingerprint)fail('PLAN_DRIFT');return p;}
 async function savePlan(p){if(await statMaybe(planFile))await loadPlan();const value={...p,binding,id:randomUUID(),expiresAt:now()+300000};value.fingerprint=hash(value);await atomicState(planFile,seal(value));return value;}
 async function save(j){if(Buffer.byteLength(JSON.stringify(j))>33554432)fail('SIZE_LIMIT');await atomicState(journal(j.id),seal(j));}
 async function candidate(a){
  if(!exact(a,['candidateId','version','manifest'])||!uuid(a.candidateId)||!version(a.version))fail('ARGUMENTS');
  const m=manifest(a.manifest),source=path.join(control,'plugin-candidates',a.candidateId,'plugin'),observed=await image(source);if(!observed)fail('CANDIDATE_MISSING');
  const r=release({version:a.version,manifest:m.files,image:observed}),pkg=JSON.parse(bytes(await snapshot(path.join(source,'package.json'),262144)));
  if(pkg.name!=='@mogragsigma/dsh-dual-host-plugin'||pkg.version!==r.version)fail('PACKAGE_MISMATCH');return {candidateId:a.candidateId,source,release:r};
 }
 async function verifyCurrent(current){await verifyImage(target,current.image);const pkg=JSON.parse(bytes(await snapshot(path.join(target,'package.json'),262144)));if(pkg.name!=='@mogragsigma/dsh-dual-host-plugin'||pkg.version!==current.version)fail('PACKAGE_MISMATCH');const dev=(await fs.lstat(control)).dev;if(current.image.some(x=>x.dev!==dev))fail('CROSS_DEVICE');}
 async function preview(a){return exclusive(async()=>{
  await guard();const rows=await readAll(),current=active(rows);await verifyCurrent(current);const c=await candidate(a),dev=(await fs.lstat(control)).dev;if(c.release.version===current.version)fail('SAME_VERSION');if(c.release.image.some(x=>x.dev!==dev))fail('CROSS_DEVICE');
  const p=await savePlan({kind:'switch',before:current,candidate:c.release,candidateId:c.candidateId,parentHash:rows.length?hash(rows.at(-1)):binding,sequence:rows.length+1});
  const old=new Map(current.manifest.map(f=>[f.path,f.sha256])),next=new Map(c.release.manifest.map(f=>[f.path,f.sha256]));
  return {id:p.id,fingerprint:p.fingerprint,expiresAt:p.expiresAt,fromVersion:current.version,toVersion:c.release.version,scope:'stopped_owned_plugin_image_only',changes:[...new Set([...old.keys(),...next.keys()])].sort().filter(n=>old.get(n)!==next.get(n)).map(n=>({path:n,action:!old.has(n)?'add':!next.has(n)?'remove':'replace'})),hostStarted:false,activationVerified:false,globalRulesChanged:false,credentialsChanged:false,backupsRetained:true};
 });}
 async function move(from,to){await moveImage(from,to);await syncDirectory(path.dirname(from));if(path.dirname(from)!==path.dirname(to))await syncDirectory(path.dirname(to));}
 async function restore(j){
  await guard();const dir=txn(j.id),backup=path.join(dir,'backup'),discarded=path.join(dir,'discarded');
  try{
   if(await matches(target,j.before.image)&&!await statMaybe(backup)){j.state='rolled_back';await save(j);return stateView(j);}
   await verifyImage(backup,j.before.image);
   if(await statMaybe(target)){if(!j.stage)fail('IMAGE_DRIFT');await verifyImage(target,repair.after(j));await guard();await move(target,discarded);await hook?.('after_rollback_capture');}
   else if(await statMaybe(discarded)){if(!j.stage)fail('IMAGE_DRIFT');await verifyImage(discarded,repair.after(j));}
   await guard();await verifyImage(backup,j.before.image);await move(backup,target);await hook?.('after_restore');await verifyImage(target,j.before.image);
   j.state='rolled_back';await save(j);return stateView(j);
  }catch(e){j.state='needs_review';j.review='changed_or_unverified_image_preserved';await save(j);return stateView(j);}
 }
 async function apply(a){return exclusive(async()=>{
  if(!exact(a,['id','fingerprint','confirm'])||!uuid(a.id)||!digest(a.fingerprint)||a.confirm!==true)fail('CONFIRMATION_REQUIRED');await guard();const rows=await readAll(),prior=rows.find(x=>x.id===a.id);if(prior){if(prior.planHash!==a.fingerprint)fail('PLAN_DRIFT');return {...stateView(prior),notResent:true};}
  const current=active(rows),p=await loadPlan();if(p.kind!=='switch'||p.id!==a.id||p.fingerprint!==a.fingerprint||p.expiresAt<=now()||p.sequence!==rows.length+1||p.parentHash!==(rows.length?hash(rows.at(-1)):binding)||hash(p.before)!==hash(current))fail('PLAN_DRIFT');
  await verifyCurrent(current);const c=await candidate({candidateId:p.candidateId,version:p.candidate.version,manifest:p.candidate.manifest});if(hash(c.release)!==hash(p.candidate))fail('PLAN_DRIFT');if(rows.length>=128)fail('HISTORY_FULL');
  if(!await statMaybe(folder)){await fs.mkdir(folder,{mode:0o700});await syncDirectory(control);}await privateDir(folder);
  const dir=txn(p.id);await fs.mkdir(dir,{mode:0o700});await syncDirectory(folder);
  const j={schema:1,id:p.id,binding,sequence:p.sequence,parentHash:p.parentHash,planHash:p.fingerprint,before:current,after:{version:c.release.version,manifest:c.release.manifest},candidateId:p.candidateId,state:'preparing',stage:null,directoryIdentity:await privateDir(dir)};await save(j);
  try{
   const stage=path.join(dir,'stage');for(const name of manifest(c.release.manifest).dirs.sort((a,b)=>a.split('/').length-b.split('/').length||a.localeCompare(b)))await fs.mkdir(path.join(stage,name),{mode:0o700});
   await hook?.('stage_created');for(const f of c.release.manifest){await guard();const s=await snapshot(path.join(c.source,f.path),4194304);if(s.sha256!==f.sha256)fail('CANDIDATE_DRIFT');await syncWrite(path.join(stage,f.path),bytes(s));}
   for(const name of manifest(c.release.manifest).dirs.sort((a,b)=>b.length-a.length))await syncDirectory(path.join(stage,name));await syncDirectory(dir);
   j.stage=(await candidateImage(stage,c.release)).image;j.state='applying';await save(j);await hook?.('stage_ready');
   await guard();await verifyImage(target,j.before.image);await hook?.('before_capture');await move(target,path.join(dir,'backup'));await hook?.('after_capture');await verifyImage(path.join(dir,'backup'),j.before.image);
   await guard();await verifyImage(stage,j.stage);await move(stage,target);await hook?.('after_publish');await verifyImage(target,j.stage);await verifyImage(path.join(dir,'backup'),j.before.image);await guard();
   j.state='committed';await save(j);await hook?.('after_commit');return stateView(j);
  }catch(e){if(j.state==='committed')throw e;j.state='needs_review';j.review='operation_interrupted';await save(j);return stateView(j);}
 });}
 async function candidateImage(p,r){return release({version:r.version,manifest:r.manifest,image:await image(p)});}
 async function latest(id){if(!uuid(id))fail('ARGUMENTS');const rows=await readAll(),j=rows.at(-1);if(!j||j.id!==id)fail('NOT_LATEST');return j;}
 async function previewRollback(a){return exclusive(async()=>{
  if(!exact(a,['id']))fail('ARGUMENTS');await guard();const j=await latest(a.id);if(j.state!=='committed')fail('NOT_COMMITTED');repair.settled(j);await verifyImage(target,repair.after(j));await verifyImage(path.join(txn(j.id),'backup'),j.before.image);
  const p=await savePlan({kind:'rollback',transactionId:j.id,journalHash:hash(j)});return {id:p.id,transactionId:j.id,fingerprint:p.fingerprint,expiresAt:p.expiresAt,fromVersion:j.after.version,toVersion:j.before.version,scope:'stopped_owned_plugin_image_only',hostStarted:false,activationVerified:false,backupsRetained:true};
 });}
 async function rollback(a){return exclusive(async()=>{
  if(!exact(a,['id','planId','fingerprint','confirm'])||!uuid(a.planId)||!digest(a.fingerprint)||a.confirm!==true)fail('CONFIRMATION_REQUIRED');await guard();const j=await latest(a.id),p=await loadPlan();
  if(j.state!=='committed'||p.kind!=='rollback'||p.id!==a.planId||p.transactionId!==j.id||p.fingerprint!==a.fingerprint||p.expiresAt<=now()||p.journalHash!==hash(j))fail('PLAN_DRIFT');
  repair.settled(j);await verifyImage(target,repair.after(j));await verifyImage(path.join(txn(j.id),'backup'),j.before.image);j.state='rolling_back';await save(j);return restore(j);
 });}
 async function recover(a){return exclusive(async()=>{if(!exact(a,['id','confirm'])||a.confirm!==true)fail('CONFIRMATION_REQUIRED');await guard();const j=await latest(a.id);repair.settled(j);if(terminal(j))return {...stateView(j),notResent:true};if(j.stage){j.state='rolling_back';await save(j);}return restore(j);});}
 async function status(a){return exclusive(async()=>{if(!exact(a,['id'])||!uuid(a.id))fail('ARGUMENTS');const j=(await readAll()).find(j=>j.id===a.id);if(!j)fail('NOT_FOUND');return {...stateView(j),historical:true};});}
 async function ownership(){return exclusive(async()=>{await guard();const rows=await readAll(),current=active(rows);await verifyCurrent(current);return structuredClone(current);});}
 // Read-only signed identity for runtime admission. This does not certify a
 // stopped Host, authorize a move, or infer loaded code from files on disk.
 async function effective(){return exclusive(async()=>{await privateDir(control);const current=active(await readAll());await verifyCurrent(current);return structuredClone(current);});}
 // Signed release identity, not a disk-to-ledger rebase or a repair operation.
 async function activationBinding(){return exclusive(async()=>{
  await privateDir(control);const rows=await readAll(),current=active(rows),j=rows.at(-1);
  if(!j)fail('ACTIVATION_VERSION_REQUIRED');repair.settled(j);
  return {transactionId:j.id,state:j.state,historyHash:hash(j),release:structuredClone(current)};
 });}
 const repair=createVersionRepair({root,operationId,runtimeId,proof,original,readAll,save,guard,privateDir,verifyImage,readImage:image,now,hook,verifyRepairCandidate});
 return {preview,apply,previewRollback,rollback,recover,status,ownership,effective,activationBinding,repair:(name,args)=>exclusive(()=>repair.action(name,args)),repairBinding:()=>exclusive(()=>repair.binding())};
}
