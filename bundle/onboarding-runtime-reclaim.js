// Original-archive, offline runtime reclamation. Never adopts current user data.
// Requires completed three-artifact removal. Retains home/workspace/temp, source,
// every control receipt and backup. Deletion is irreversible and separately approved.
import {randomUUID} from 'node:crypto';

const retained=['runtime/native-home','runtime/native-tmp','runtime/workspace'];
const within=(p,root)=>p===root||p.startsWith(root+'/');
const keep=p=>p==='runtime'||retained.some(root=>within(p,root));
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join()===keys.slice().sort().join();
const identity=s=>({dev:s.dev,ino:s.ino,uid:s.uid,mode:s.mode&0o777});
const rowKeys=x=>['path','dev','ino','uid','mode','kind',...(x.kind==='file'?['bytes','sha256']:x.kind==='link'?['target']:[])];

export function createRuntimeReclamation(api,q,j,{prerequisite,background=false}){
 const {fs,path,hash,fail,regular,signed,verified,atomicJSON,checkAncestors,runtimeSource,runtimeRecord,runtimeAlive,runtimeStopLedger,runtimeBaseInventory,runtimeInventory}=api;
 const now=api.reclaimNow??Date.now,hook=api.reclaimHook??(async()=>{});
 let workerPromise;const worker=()=>workerPromise??=import('./onboarding-runtime-reclaim-worker.js').then(m=>m.createReclamationWorker(api,q,j,{ledger,boundPlan,finish,bindWorker:d=>persist(d,{workerBound:true})}));
 const result=async d=>({...view(d),...(background?await(await worker()).observe(d):{})});
 const run=async(d,p)=>background?{...view(d),...await(await worker()).begin(d)}:finish(d,p);
 const recoveryHash=async d=>background?(await worker()).fingerprint(d):hash(d);
 const dir=path.join(q.root,'.control/runtime'),planFile=path.join(dir,'runtime-reclaim-plan.json'),journalFile=path.join(dir,'runtime-reclaim.json');
 const binding=hash({root:q.root,operationId:q.operationId,runtimeId:j?.id,inventoryHash:j?.inventoryHash});
 const bad=c=>fail('RUNTIME_RECLAIM_'+c);
 async function stat(p){await checkAncestors(path.dirname(p));try{return await fs.lstat(p);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
 async function read(p,limit=67108864){await checkAncestors(path.dirname(p));const f=await regular(p,limit);if(!f)return null;if(f.identity.uid!==process.getuid()||f.identity.mode!==0o600)bad('LEDGER_REVIEW');try{return verified(JSON.parse(f.data),q.proof);}catch{bad('LEDGER_REVIEW');}}
 async function save(p,v){if(Buffer.byteLength(JSON.stringify(v))>66000000)bad('LIMIT');await atomicJSON(p,signed(v,q.proof));}
 async function guard(){
  await runtimeSource(q);const current=await runtimeRecord(q);
  if(!j?.inventoryHash||!j.nativeReceipt?.ok||!current||hash(current)!==hash(j)||!['host_ready','failed','stopped'].includes(j.state))bad('RUNTIME_CHANGED');
  for(const member of [j.host,j.worker,j.child,j.restart?.launcher])if(await runtimeAlive(member))bad('PROCESS_ACTIVE');
  await runtimeStopLedger(q,j,true);
 }
 function entries(rows){
  if(!Array.isArray(rows)||rows.length>150000)bad('PLAN_REVIEW');const names=new Set();
  for(const x of rows){
   if(!x||!['file','directory','link'].includes(x.kind)||!exact(x,rowKeys(x))||typeof x.path!=='string'||!x.path.startsWith('runtime/')||keep(x.path)||within(x.path,'runtime/plugin')||x.path.split('/').some(s=>!s||s==='.'||s==='..'||/[\x00-\x1f\x7f\\]/.test(s))||names.has(x.path)||x.uid!==process.getuid()||![x.dev,x.ino,x.uid,x.mode].every(Number.isSafeInteger)||x.mode<0||x.mode>0o777)bad('PLAN_REVIEW');
   if(x.kind==='file'&&(!Number.isSafeInteger(x.bytes)||x.bytes<0||x.bytes>268435456||!hex(x.sha256)))bad('PLAN_REVIEW');
   if(x.kind==='link'&&(typeof x.target!=='string'||path.isAbsolute(x.target)||!within(path.posix.normalize(path.posix.join(path.posix.dirname(x.path),x.target)),'runtime')))bad('PLAN_REVIEW');
   names.add(x.path);
  }
  // Every directory follows its children in deletion order.
  const positions=new Map(rows.map((x,i)=>[x.path,i]));
  for(const [i,x] of rows.entries()){const parent=path.posix.dirname(x.path);if(parent!=='runtime'&&(!positions.has(parent)||positions.get(parent)<=i||rows[positions.get(parent)].kind!=='directory'))bad('PLAN_REVIEW');}
  return rows;
 }
 function planShape(p){
  if(!p||!exact(p,['schema','binding','id','createdAt','expiresAt','journalHash','uninstallId','uninstallHash','rows','roots','fingerprint'])||p.schema!==1||p.binding!==binding||!uuid(p.id)||!uuid(p.uninstallId)||![p.journalHash,p.uninstallHash,p.fingerprint].every(hex)||!Number.isSafeInteger(p.createdAt)||p.expiresAt!==p.createdAt+300000||!Array.isArray(p.roots)||!p.roots.length)bad('PLAN_REVIEW');
  const {fingerprint,...body}=p;if(hash(body)!==fingerprint||p.journalHash!==hash(j))bad('PLAN_REVIEW');entries(p.rows);
  const names=new Set();for(const x of p.roots){if(!exact(x,['path','dev','ino','uid','mode','kind'])||!['runtime',...retained].includes(x.path)||x.kind!=='directory'||names.has(x.path)||x.uid!==process.getuid()||![x.dev,x.ino,x.uid,x.mode].every(Number.isSafeInteger)||x.mode<0||x.mode>0o777)bad('PLAN_REVIEW');names.add(x.path);}
  if(!names.has('runtime'))bad('PLAN_REVIEW');return p;
 }
 async function ledger(){
  const d=await read(journalFile,262144);if(!d)return null;
  if(!exact(d,['schema','binding','id','fingerprint','planHash','state','revision','cursor','pendingEnd','total','updatedAt',...(background?['workerBound']:[])])||d.schema!==(background?2:1)||background&&typeof d.workerBound!=='boolean'||d.binding!==binding||!uuid(d.id)||![d.fingerprint,d.planHash].every(hex)||!['deleting','committed'].includes(d.state)||![d.revision,d.cursor,d.pendingEnd,d.total,d.updatedAt].every(Number.isSafeInteger)||d.revision<1||d.cursor<0||d.pendingEnd<d.cursor||d.pendingEnd>d.total||d.pendingEnd-d.cursor>32||d.total<1||d.total>150000||d.state==='committed'&&(d.cursor!==d.total||d.pendingEnd!==d.total))bad('LEDGER_REVIEW');
  return d;
 }
 async function boundPlan(d){const p=planShape(await read(planFile));if(p.id!==d.id||p.fingerprint!==d.fingerprint||hash(p)!==d.planHash||p.rows.length!==d.total)bad('PLAN_REVIEW');return p;}
 async function pinnedRoots(p){
  for(const row of p.roots){const s=await stat(path.join(q.root,row.path));if(!s||!s.isDirectory()||s.isSymbolicLink()||hash(identity(s))!==hash({dev:row.dev,ino:row.ino,uid:row.uid,mode:row.mode}))bad('RETAINED_ROOT_DRIFT');}
  // Never follow a newly substituted retained root, even though its data is kept.
  for(const name of retained){const s=await stat(path.join(q.root,name));if(s&&(!s.isDirectory()||s.isSymbolicLink()||!p.roots.some(x=>x.path===name)))bad('RETAINED_ROOT_DRIFT');}
 }
 async function snapshot(){return runtimeInventory(q,new Set(retained));}
 function compare(expected,current,cursor,end){
  const found=new Map(current.filter(x=>!keep(x.path)).map(x=>[x.path,x]));
  for(const [i,row] of expected.entries()){const x=found.get(row.path);found.delete(row.path);if(i<cursor?!!x:i>=end?!x||hash(x)!==hash(row):x&&hash(x)!==hash(row))bad('DRIFT');}
  if(found.size)bad('DRIFT');
 }
 async function validate(d,p){await guard();if(hash(await prerequisite())!==p.uninstallHash)bad('PREREQUISITE_CHANGED');await pinnedRoots(p);compare(p.rows,await snapshot(),d.cursor,d.pendingEnd);}
 const view=d=>({contract:1,operationId:q.operationId,runtimeId:j.id,scope:'stopped_owned_runtime_keep_user_data',id:d?.id??null,state:d?.state??'not_requested',completed:d?.cursor??0,total:d?.total??0,recoveryRequired:d?.state==='deleting',managedRestartBlocked:!!d,hostStarted:false,initialization:false,automaticRetry:false,userDataPreserved:true,backupsRetained:true,userDataDeleted:false,runtimeFilesRemoved:d?.state==='committed',irreversible:true});
 function publicPlan(p){return {...view(null),id:p.id,fingerprint:p.fingerprint,expiresAt:p.expiresAt,canApply:true,files:p.rows.filter(x=>x.kind==='file').length,entries:p.rows.length,bytes:p.rows.reduce((n,x)=>n+(x.bytes??0),0),removeRoots:[...new Set(p.rows.map(x=>x.path.split('/').slice(0,2).join('/')))].sort(),retainedPaths:[...retained,'runtime','.control','plugin'],requiresExplicitConfirmation:true};}
 async function preview(a={}){
  if(!exact(a,[]))bad('ARGUMENTS');await guard();if(await ledger())bad('ALREADY_REQUESTED');
  const u=await prerequisite();if(u?.state!=='committed'||u.pluginInstalled!==false||u.recoveryRequired||!uuid(u.id))bad('PLUGIN_UNINSTALL_REQUIRED');
  const original=await runtimeBaseInventory(q,j),rows=entries(original.items.filter(x=>!keep(x.path)&&!within(x.path,'runtime/plugin')).reverse());
  if(!rows.length)bad('NOTHING_OWNED');const roots=original.items.filter(x=>['runtime',...retained].includes(x.path));
  const createdAt=now(),body={schema:1,binding,id:randomUUID(),createdAt,expiresAt:createdAt+300000,journalHash:hash(j),uninstallId:u.id,uninstallHash:hash(u),rows,roots};
  const p=planShape({...body,fingerprint:hash(body)});await pinnedRoots(p);compare(rows,await snapshot(),0,0);
  await save(planFile,p);return publicPlan(p);
 }
 async function syncParents(rows){
  const names=new Set();for(const row of rows){let n=path.dirname(path.join(q.root,row.path));while(!await stat(n)){if(n===q.root)bad('DRIFT');n=path.dirname(n);}names.add(n);}
  for(const n of names){const h=await fs.open(n,'r');try{await h.sync();}finally{await h.close();}}
 }
 async function remove(row,parents){
  const name=path.join(q.root,row.path),s=await stat(name);if(!s)return;
  for(let parent=path.posix.dirname(row.path);parent!=='runtime';parent=path.posix.dirname(parent)){
   const expected=parents.get(parent),actual=await stat(path.join(q.root,parent));
   if(!expected||!actual||!actual.isDirectory()||actual.isSymbolicLink()||hash(identity(actual))!==hash(identityRow(expected)))bad('DRIFT');
  }
  if(hash(identity(s))!==hash({dev:row.dev,ino:row.ino,uid:row.uid,mode:row.mode}))bad('DRIFT');
  if(row.kind==='directory'){if(!s.isDirectory()||s.isSymbolicLink())bad('DRIFT');await fs.rmdir(name);}
  else if(row.kind==='link'){if(!s.isSymbolicLink()||await fs.readlink(name)!==row.target)bad('DRIFT');await fs.unlink(name);}
  else{const f=await regular(name,268435456);if(!f||f.sha256!==row.sha256||s.size!==row.bytes||hash(f.identity)!==hash(identityRow(row)))bad('DRIFT');const latest=await stat(name);if(!latest||latest.nlink!==1||hash(identity(latest))!==hash(identityRow(row)))bad('DRIFT');await fs.unlink(name);}
 }
 const identityRow=x=>({dev:x.dev,ino:x.ino,uid:x.uid,mode:x.mode});
 async function persist(d,fields){Object.assign(d,fields,{revision:d.revision+1,updatedAt:now()});await save(journalFile,d);}
 async function finish(d,p){
  await validate(d,p);const parents=new Map(p.rows.filter(x=>x.kind==='directory').map(x=>[x.path,x]));
  while(d.cursor<d.total){
   await guard();await pinnedRoots(p);const start=d.cursor;await persist(d,{pendingEnd:Math.min(start+32,d.total)});await hook('batch_intent',d);
   for(let i=start;i<d.pendingEnd;i++){await remove(p.rows[i],parents);await hook('item_removed',{index:i,path:p.rows[i].path});}
   await syncParents(p.rows.slice(start,d.pendingEnd));await persist(d,{cursor:d.pendingEnd});await hook('batch_recorded',d);
  }
  await validate(d,p);await persist(d,{state:'committed'});await hook('committed',d);return view(d);
 }
 async function apply(a){
  if(!exact(a,['id','fingerprint','confirm'])||!uuid(a.id)||!hex(a.fingerprint)||a.confirm!==true)bad('CONFIRMATION_REQUIRED');
  await guard();const old=await ledger();if(old){if(old.id!==a.id||old.fingerprint!==a.fingerprint)bad('ALREADY_REQUESTED');return {...await result(old),notResent:true};}
  const p=planShape(await read(planFile));if(p.id!==a.id||p.fingerprint!==a.fingerprint||now()>p.expiresAt||now()<p.createdAt)bad('PLAN_EXPIRED');
  const u=await prerequisite();if(hash(u)!==p.uninstallHash)bad('PREREQUISITE_CHANGED');
  const d={schema:background?2:1,...(background?{workerBound:false}:{}),binding,id:p.id,fingerprint:p.fingerprint,planHash:hash(p),state:'deleting',revision:1,cursor:0,pendingEnd:0,total:p.rows.length,updatedAt:now()};
  await validate(d,p);await save(journalFile,d);await hook('intent_saved',d);return run(d,p);
 }
 async function status(a={}){if(!exact(a,[]))bad('ARGUMENTS');const d=await ledger();if(d)await boundPlan(d);return {...await result(d),historical:true};}
 function intent(p){return {schema:background?2:1,...(background?{workerBound:false}:{}),binding,id:p.id,fingerprint:p.fingerprint,planHash:hash(p),state:'deleting',revision:1,cursor:0,pendingEnd:0,total:p.rows.length,updatedAt:now()};}
 const unobserved=p=>hash({state:'intent_unobserved',planHash:hash(p)});
 async function recoveryPreview(a={}){
  if(!exact(a,[]))bad('ARGUMENTS');const d=await ledger();
  if(!d){const p=planShape(await read(planFile));await validate(intent(p),p);return {...view(null),id:p.id,state:'unobserved',recoveryRequired:true,managedRestartBlocked:true,total:p.rows.length,fingerprint:unobserved(p),action:'start_original_manifest_if_still_unobserved',requiresExplicitConfirmation:true};}
  if(d.state!=='deleting')bad('RECOVERY_REQUIRED');if(background)await(await worker()).inactive(d);const p=await boundPlan(d);await validate(d,p);
  return {...await result(d),fingerprint:await recoveryHash(d),action:'continue_original_manifest_only',requiresExplicitConfirmation:true};
 }
 async function recover(a){
  if(!exact(a,['id','fingerprint','confirm'])||a.confirm!==true||!uuid(a.id)||!hex(a.fingerprint))bad('CONFIRMATION_REQUIRED');
  const d=await ledger();
  if(!d){const p=planShape(await read(planFile));if(p.id!==a.id||unobserved(p)!==a.fingerprint)bad('RECOVERY_CHANGED');const next=intent(p);await validate(next,p);await save(journalFile,next);await hook('intent_saved',next);return run(next,p);}
  if(d.state!=='deleting'||d.id!==a.id||await recoveryHash(d)!==a.fingerprint)bad('RECOVERY_CHANGED');if(background)await(await worker()).inactive(d);const p=await boundPlan(d);await validate(d,p);return run(d,p);
 }
 return {preview,apply,status,recoveryPreview,recover,worker:async a=>{if(!background)bad('WORKER_UNSUPPORTED');return(await worker()).execute(a);}};
}
