// Original-archive candidate receiver. No URL, tar extraction, dependency
// installation or code execution. Called only under the runtime owner lock.
import path from 'node:path';
import {fs,bytes,snapshot,syncWrite,hash,ancestors} from './onboarding-install-fs.js';
import {syncDirectory,statMaybe} from './onboarding-maintenance-fs.js';
const fail=c=>{throw Error('ONBOARDING_CLOUD_VERSION_CANDIDATE_'+c);};
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join()===keys.slice().sort().join();
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const rel=x=>typeof x==='string'&&x.length<=240&&/^[A-Za-z0-9_./-]+$/.test(x)&&x.split('/').every(p=>p&&p!=='.'&&p!=='..'&&p!=='.control'&&p!=='node_modules');
const ident=s=>({dev:s.dev,ino:s.ino,uid:s.uid,mode:s.mode&0o777});
const digest=x=>hash(JSON.stringify(x));
 function validate(files,manifestHash){
  if(!Array.isArray(files)||!files.length||files.length>512||!hex(manifestHash))fail('PACKAGE');
  const seen=new Set(),dirs=new Set(),data=new Map();let total=0;
  for(const f of files){
   if(!exact(f,['path','bytes','sha256','mode','data'])||!f.path.startsWith('plugin/')||!rel(f.path.slice(7))||seen.has(f.path.toLowerCase())||f.mode!==0o600||!Number.isSafeInteger(f.bytes)||f.bytes<0||f.bytes>4194304||!hex(f.sha256)||typeof f.data!=='string'||f.data.length>5592408)fail('PACKAGE');
   const b=Buffer.from(f.data,'base64');if(b.toString('base64')!==f.data||b.length!==f.bytes||hash(b)!==f.sha256)fail('PACKAGE');
   total+=b.length;if(total>8388608)fail('LIMIT');seen.add(f.path.toLowerCase());data.set(f.path,b);
   let p=path.posix.dirname(f.path);while(p!=='.'){dirs.add(p);p=path.posix.dirname(p);}
  }
  if(dirs.size>2048||[...dirs].some(p=>seen.has(p.toLowerCase()))||new Set([...dirs].map(p=>p.toLowerCase())).size!==dirs.size)fail('PACKAGE');
  const manifest=files.map(({data,...f})=>f).sort((a,b)=>a.path<b.path?-1:1);
  if(digest(manifest)!==manifestHash)fail('HASH');return {manifest,data,dirs:[...dirs].sort((a,b)=>a.split('/').length-b.split('/').length||a.localeCompare(b)),total};
 }
 function compatibility(data,original){
  const json=p=>{try{return JSON.parse(data.get('plugin/'+p));}catch{fail('COMPATIBILITY');}};
  const pkg=json('package.json'),compat=json('compatibility.json'),base=original.package,baseCompat=original.compatibility;
  if(pkg.name!=='@mogragsigma/dsh-dual-host-plugin'||typeof pkg.version!=='string'||pkg.version.length>99||!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(pkg.version)||compat.version!==pkg.version||compat.hostBaseline!==baseCompat.hostBaseline||compat.onboardingPluginVersion!==1)fail('COMPATIBILITY');
  if((compat.onboardingPluginVersionLifecycle===1||baseCompat.onboardingPluginVersionLifecycle===1)&&(compat.onboardingPluginVersionLifecycle!==1||baseCompat.onboardingPluginVersionLifecycle!==1||compat.onboardingNativePluginIdentity!==1||baseCompat.onboardingNativePluginIdentity!==1))fail('LIFECYCLE_UNSUPPORTED');
  if((compat.onboardingVersionRepair===1||baseCompat.onboardingVersionRepair===1)&&(compat.onboardingVersionRepair!==1||baseCompat.onboardingVersionRepair!==1))fail('REPAIR_LIFECYCLE_UNSUPPORTED');
  // Activation is an additive read-only observation. An older original archive
  // can install the image but never gains the new authority; the original
  // contract still controls verify/status. An archive that requires it cannot
  // accept its removal or a different contract revision.
  const activation=compat.onboardingVersionRepairActivation,required=baseCompat.onboardingVersionRepairActivation;
  if(activation!==undefined&&activation!==1||required!==undefined&&required!==1||required===1&&activation!==1)fail('REPAIR_ACTIVATION_UNSUPPORTED');
  const versionActivation=compat.onboardingVersionActivation,requiredVersionActivation=baseCompat.onboardingVersionActivation;
  if(versionActivation!==undefined&&versionActivation!==1||requiredVersionActivation!==undefined&&requiredVersionActivation!==1||requiredVersionActivation===1&&versionActivation!==1)fail('VERSION_ACTIVATION_UNSUPPORTED');
  // Installing a newer image never grants an older original controller deletion
  // authority. Keep a required reclamation contract; reject unknown revisions.
  const reclamation=compat.onboardingRuntimeReclamation,originalReclamation=baseCompat.onboardingRuntimeReclamation;
  if(reclamation!==undefined&&reclamation!==1||originalReclamation!==undefined&&originalReclamation!==1||originalReclamation===1&&reclamation!==1)fail('RECLAMATION_UNSUPPORTED');
  const worker=compat.onboardingRuntimeReclamationWorker,requiredWorker=baseCompat.onboardingRuntimeReclamationWorker;
  if(worker!==undefined&&worker!==1||requiredWorker!==undefined&&requiredWorker!==1||requiredWorker===1&&worker!==1||worker===1&&(compat.onboardingRuntimeReclamationRequests!==1||reclamation!==1))fail('RECLAMATION_WORKER_UNSUPPORTED');
  const reclaimRequests=compat.onboardingRuntimeReclamationRequests,requiredRequests=baseCompat.onboardingRuntimeReclamationRequests;
  if(reclaimRequests!==undefined&&reclaimRequests!==1||requiredRequests!==undefined&&requiredRequests!==1||requiredRequests===1&&reclaimRequests!==1||reclaimRequests===1&&reclamation!==1)fail('RECLAMATION_REQUESTS_UNSUPPORTED');
  // This release route cannot change native/dependency bindings or install scripts.
  const strip=p=>{const {version,description,...rest}=p;return rest;};
  if(digest(strip(pkg))!==digest(strip(base)))fail('DEPENDENCIES');
  for(const name of ['runtime-package.json','runtime-lock.json','runtime-im-package.json','runtime-im-lock.json'])if(!data.has('plugin/'+name)||hash(data.get('plugin/'+name))!==original.files.get('plugin/'+name)?.sha256)fail('DEPENDENCIES');
  const lock=json('package-lock.json'),before=structuredClone(original.lock);if(lock.version!==pkg.version||lock.packages?.['']?.version!==pkg.version)fail('DEPENDENCIES');
  before.version=pkg.version;before.packages[''].version=pkg.version;if(digest(lock)!==digest(before))fail('DEPENDENCIES');
  return pkg.version;
 }
export function validateVersionCandidatePackage(files,manifestHash,original){const p=validate(files,manifestHash);return {...p,version:compatibility(p.data,original)};}
export function createVersionCandidates({q,j,original,regular,signed,verified,atomicJSON,guard,hook}){
 const parent=path.join(q.root,'.control/runtime/plugin-candidates');
 const binding=digest({root:q.root,operationId:q.operationId,runtimeId:j.id,inventoryHash:j.inventoryHash});
 async function directory(p){await ancestors(p);const s=await fs.lstat(p);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o777)!==0o700)fail('DIRECTORY_REVIEW');return ident(s);}
 function candidateId(id){if(!uuid(id))fail('ARGUMENTS');return path.join(parent,id);}
 async function read(id){
  const dir=candidateId(id);await directory(parent);const identity=await directory(dir),f=await regular(path.join(dir,'receipt.json'),262144);
  if(!f||f.identity.uid!==process.getuid()||f.identity.mode!==0o600)fail('RECEIPT_REVIEW');
  const r=verified(JSON.parse(f.data),q.proof);
  if(r.schema!==1||r.binding!==binding||r.id!==id||digest(r.directory)!==digest(identity)||!['receiving','ready','needs_review'].includes(r.state)||!hex(r.manifestHash)||!Array.isArray(r.manifest)||r.manifest.length>512||!r.manifest.length)fail('RECEIPT_REVIEW');
  if((await fs.readdir(dir)).some(n=>!['receipt.json','plugin'].includes(n)))fail('RECEIPT_REVIEW');return r;
 }
 async function inspect(r){
  const dir=candidateId(r.id),tree=path.join(dir,'plugin'),expected=new Map(r.manifest.map(f=>[f.path,f])),rows=[];
  async function walk(at,rel){if(rows.length>=4096)fail('LIMIT');const s=await fs.lstat(at);if(s.isDirectory()&&!s.isSymbolicLink()){await directory(at);rows.push({path:rel,kind:'directory',...ident(s)});for(const n of (await fs.readdir(at)).sort())await walk(path.join(at,n),rel+'/'+n);}
   else{const f=expected.get(rel);if(!f||s.uid!==process.getuid())fail('DRIFT');const b=await snapshot(at,4194304);if(b.mode!==0o600||b.size!==f.bytes||b.sha256!==f.sha256)fail('DRIFT');rows.push({path:rel,kind:'file',...ident(s),bytes:b.size,sha256:b.sha256});expected.delete(rel);}}
  await walk(tree,'plugin');rows.sort((a,b)=>a.path<b.path?-1:1);if(expected.size||digest(rows)!==r.imageHash)fail('DRIFT');return rows;
 }
 function view(r){return {contract:1,id:r.id,state:r.state,version:r.version,manifestHash:r.manifestHash,files:r.manifest.length,bytes:r.bytes,scope:'candidate_files_only',runtimeChanged:false,hostStarted:false,activationVerified:false,automaticRetry:false,recoveryRequired:r.state!=='ready'};}
 async function status(id){const r=await read(id);if(r.state==='ready')await inspect(r);return {...view(r),historical:true};}
 async function receive(a){
  if(!exact(a,['id','manifestHash','files','confirm'])||a.confirm!==true)fail('CONFIRMATION_REQUIRED');const dir=candidateId(a.id),p=validateVersionCandidatePackage(a.files,a.manifestHash,original),version=p.version;await guard();
  if(await statMaybe(dir)){const old=await read(a.id);if(old.manifestHash!==a.manifestHash)fail('ID_REUSED');return {...await status(a.id),notResent:true};}
  if(!await statMaybe(parent)){await fs.mkdir(parent,{mode:0o700});await syncDirectory(path.dirname(parent));}await directory(parent);
  if((await fs.readdir(parent)).length>=16)fail('HISTORY_FULL');
  await fs.mkdir(dir,{mode:0o700});await syncDirectory(parent);
  const r={schema:1,binding,id:a.id,directory:await directory(dir),manifestHash:a.manifestHash,manifest:p.manifest,version,bytes:p.total,state:'receiving',imageHash:null};
  const save=()=>atomicJSON(path.join(dir,'receipt.json'),signed(r,q.proof));await save();
  try{
   const rows=[];
   for(const d of p.dirs){const at=path.join(dir,d);await fs.mkdir(at,{mode:0o700});rows.push({path:d,kind:'directory',...await directory(at)});}
   await hook?.('candidate_created');for(const f of p.manifest){await guard();const at=path.join(dir,f.path);await syncWrite(at,p.data.get(f.path));rows.push({path:f.path,kind:'file',...ident(await fs.lstat(at)),bytes:f.bytes,sha256:f.sha256});}
   for(const d of p.dirs.slice().reverse())await syncDirectory(path.join(dir,d));await syncDirectory(dir);
   // A receipt seals exact identities too; equal bytes at a replaced path are not accepted.
   rows.sort((a,b)=>a.path<b.path?-1:1);r.imageHash=digest(rows);await inspect(r);await guard();r.state='ready';await save();return view(r);
  }catch(e){r.state='needs_review';await save();throw e;}
 }
 async function release(id){const r=await read(id);if(r.state!=='ready')fail('RECOVERY_REQUIRED');await inspect(r);return {candidateId:id,version:r.version,manifest:r.manifest.map(f=>({path:f.path.slice(7),sha256:f.sha256}))};}
 return {receive,status,release};
}
