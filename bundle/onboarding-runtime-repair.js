// Loaded only from the original verified archive, under the runtime owner lock.
// Replaces only original plugin files. Never rebases a whole filesystem scan.
import {createPluginRepair} from './onboarding-plugin-repair.js';
import {createRuntimeActivation} from './onboarding-runtime-activation.js';
export async function createRuntimeRepair(api,q,j){
 const {fs,path,hash,fail,regular,verified,signed,atomicJSON,runtimeOwnedInventory,runtimeInventory,runtimeAlive,runtimeRecord,runtimeStopLedger,runtimeSource}=api;
 if(!j)fail('RUNTIME_REPAIR_NOT_READY');const c=JSON.parse((await regular(path.join(q.root,'plugin/compatibility.json'))).data);if(c.onboardingPluginRepair!==1)fail('RUNTIME_REPAIR_UNSUPPORTED');
 const source=await runtimeSource(q),original=await runtimeOwnedInventory(q,j),file=path.join(q.root,'.control/runtime/plugin-maintenance.json');
 const manifest=source.owner.manifest.map(f=>({path:f.path.slice(7),sha256:f.sha256}));
 const sources=new Map(source.owner.manifest.map(f=>['runtime/'+f.path,f]));
 const mutable=p=>['runtime/native-home','runtime/native-tmp','runtime/workspace'].some(x=>p===x||p.startsWith(x+'/'));
 const terminal=r=>['committed','rolled_back'].includes(r.state);
 const scope='stopped_owned_plugin_files_only';
 const exact=(x,ks)=>x&&Object.keys(x).sort().join()===ks.slice().sort().join();
 const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
 const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
 async function ledger(){
  let folder;try{folder=await fs.lstat(path.join(q.root,'.control/runtime/plugin-repairs'));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(folder&&(!folder.isDirectory()||folder.isSymbolicLink()||folder.uid!==process.getuid()||(folder.mode&0o777)!==0o700))fail('RUNTIME_REPAIR_LEDGER_REVIEW');
  const names=folder?await fs.readdir(path.join(q.root,'.control/runtime/plugin-repairs')):[];
  const f=await regular(file,16777216);if(!f&&folder)fail('RUNTIME_REPAIR_LEDGER_REVIEW');if(!f)return {schema:1,operationId:q.operationId,runtimeId:j.id,inventoryHash:j.inventoryHash,records:[]};
  if(f.identity.uid!==process.getuid()||f.identity.mode!==0o600)fail('RUNTIME_REPAIR_LEDGER_REVIEW');
  const d=verified(JSON.parse(f.data),q.proof);
  if(!exact(d,['schema','operationId','runtimeId','inventoryHash','records'])||d.schema!==1||d.operationId!==q.operationId||d.runtimeId!==j.id||d.inventoryHash!==j.inventoryHash||!Array.isArray(d.records)||d.records.length>128||new Set(d.records.map(x=>x.id)).size!==d.records.length)fail('RUNTIME_REPAIR_LEDGER_REVIEW');
  for(const r of d.records)if(!exact(r,['id','fingerprint','baseHash','state','delta','updatedAt'])||!uuid(r.id)||!hex(r.fingerprint)||!hex(r.baseHash)||!['applying','committed','rolled_back','needs_review'].includes(r.state)||!Array.isArray(r.delta)||r.delta.length>512||!Number.isSafeInteger(r.updatedAt)||r.state!=='committed'&&r.delta.length)fail('RUNTIME_REPAIR_LEDGER_REVIEW');
  if(names.some(n=>!d.records.some(r=>r.id===n)))fail('RUNTIME_REPAIR_LEDGER_REVIEW');
  if(d.records.slice(0,-1).some(x=>!terminal(x)))fail('RUNTIME_REPAIR_LEDGER_REVIEW');return d;
 }
 async function save(d){const value=signed(d,q.proof);if(Buffer.byteLength(JSON.stringify(value))>16777216)fail('RUNTIME_REPAIR_HISTORY_LIMIT');await atomicJSON(file,value);}
 function merged(d,requireTerminal=false){
  const map=new Map(original.items.map(x=>[x.path,x]));
  for(const r of d.records){
   if(r.baseHash!==hash([...map.values()]))fail('RUNTIME_REPAIR_OWNERSHIP_REVIEW');
   if(!terminal(r)&&requireTerminal)fail('RUNTIME_REPAIR_RECOVERY_REQUIRED');
   const seen=new Set();
   for(const delta of r.delta){const e=delta.after,f=sources.get(e?.path),old=map.get(e?.path);
    if(!exact(delta,['before','after'])||!f||seen.has(e.path)||!old||hash(delta.before)!==hash(old)||!exact(e,['path','kind','dev','ino','uid','mode','bytes','sha256'])||e.kind!=='file'||![e.dev,e.ino,e.uid,e.bytes].every(Number.isSafeInteger)||e.uid!==process.getuid()||e.mode!==0o600||e.sha256!==f.sha256||e.bytes!==f.bytes)fail('RUNTIME_REPAIR_OWNERSHIP_REVIEW');
    seen.add(e.path);map.set(e.path,e);
   }
  }
  return [...map.values()];
 }
 async function stopped(){
  const current=await runtimeRecord(q);
  if(current?.id!==j.id||current.inventoryHash!==j.inventoryHash||current.revision!==j.revision)fail('RUNTIME_REPAIR_RUNTIME_CHANGED');
  if(!current.nativeReceipt?.ok||!['host_ready','failed','stopped'].includes(current.state))fail('RUNTIME_REPAIR_NOT_READY');
  for(const p of [current.host,current.worker,current.child,current.restart?.launcher])if(await runtimeAlive(p))fail('RUNTIME_PROCESS_ACTIVE');
  await runtimeStopLedger(q,current,true);
 }
 async function outside(d){
  await stopped();const expected=merged(d),omit=new Set(sources.keys()),current=await runtimeInventory(q,omit);
  const filter=x=>!mutable(x.path)&&!omit.has(x.path);
  if(hash(current.filter(filter))!==hash(expected.filter(filter)))fail('RUNTIME_REPAIR_OUTSIDE_DRIFT');
 }
 const inventory=original.items.filter(x=>x.path.startsWith('runtime/plugin/')).map(x=>({path:x.path.slice(15),kind:x.kind,identity:{dev:x.dev,ino:x.ino,mode:x.mode},sha256:x.sha256??null}));
 const repair=createPluginRepair({root:q.root,operationId:q.operationId,runtimeId:j.id,proof:q.proof,manifest,inventory,exclusive:fn=>fn(),verifyOwnedStopped:async()=>{await stopped();return {operationId:q.operationId,runtimeId:j.id,stopped:true,ownershipVerified:true};}});
 function view(d,r=d.records.at(-1)){return {operationId:q.operationId,runtimeId:j.id,initialization:false,hostStarted:false,state:r?'repair_'+r.state:'repair_not_started',scope,repair:{contract:1,id:r?.id??null,state:r?.state??'not_started',recoveryRequired:!!r&&!terminal(r),ownershipRebased:r?.state==='committed',activationVerified:false,versionUpgrade:false,files:r?.delta.map(x=>x.after.path.slice(15))??[]},automaticRetry:false};}
 async function finish(d,r,result){
  await outside(d);
  if(result.state==='committed'){
   const current=merged(d),map=new Map(current.map(x=>[x.path,x])),rows=await repair.ownership({id:r.id});
   r.delta=rows.map(x=>{const name='runtime/plugin/'+x.path,before=map.get(name);if(!before)fail('RUNTIME_REPAIR_OWNERSHIP_REVIEW');return {before,after:{path:name,dev:x.identity.dev,ino:x.identity.ino,uid:process.getuid(),mode:x.identity.mode,kind:'file',bytes:x.bytes,sha256:x.sha256}};});
  }
  r.state=result.state;r.updatedAt=Date.now();merged(d);await save(d);return view(d);
 }
 async function action(name,args){
  const d=await ledger();merged(d);
  const activation=()=>createRuntimeActivation(api,q,j,{repair:d.records.at(-1),inventory:merged(d,true),source,compat:c});
  if(name==='verify'){if(c.onboardingPluginRepairActivation!==1)fail('RUNTIME_ACTIVATION_UNSUPPORTED');return {...view(d),activation:await activation().verify(args.id)};}
  if(name==='status')return {...view(d),activation:c.onboardingPluginRepairActivation===1?await createRuntimeActivation(api,q,j,{repair:d.records.at(-1),inventory:[],source,compat:c}).status():null};
  try{await outside(d);}catch(e){if(name==='apply'&&!d.records.some(x=>x.id===args.id))fail('RUNTIME_REPAIR_PREFLIGHT_REFUSED');throw e;}
  if(name==='preview'){if(d.records.some(x=>!terminal(x)))fail('RUNTIME_REPAIR_RECOVERY_REQUIRED');const p=await repair.preview();return {...p,operationId:q.operationId,runtimeId:j.id,initialization:false,repairSupported:true,ownershipRebased:false,activationVerified:false};}
  if(name==='apply'){
   const old=d.records.find(x=>x.id===args.id);if(old){if(old.fingerprint!==args.fingerprint)fail('RUNTIME_REPAIR_PLAN_DRIFT');return {...view(d,old),notResent:true,cached:true};}
   if(d.records.some(x=>!terminal(x)))fail('RUNTIME_REPAIR_RECOVERY_REQUIRED');if(d.records.length>=128)fail('RUNTIME_REPAIR_HISTORY_LIMIT');
   try{await repair.validate(args);}catch{fail('RUNTIME_REPAIR_PREFLIGHT_REFUSED');}const r={id:args.id,fingerprint:args.fingerprint,baseHash:hash(merged(d)),state:'applying',delta:[],updatedAt:Date.now()};d.records.push(r);await save(d);
   // Unknown publication is never retried. Recovery examines the same signed journal.
   try{return await finish(d,r,await repair.apply(args));}catch(e){r.state='needs_review';r.delta=[];r.updatedAt=Date.now();await save(d);throw e;}
  }
  if(name==='recover'){
   const r=d.records.at(-1);if(!r||r.id!==args.id)fail('RUNTIME_REPAIR_RECOVERY_REQUIRED');if(terminal(r))return {...view(d),notResent:true};
   return finish(d,r,await repair.recover(args));
  }
  fail('ARGUMENTS');
 }
 async function dispatch(){try{const v=await action(q.action.slice(15),{...(q.repairId?{id:q.repairId,confirm:true}:{}),...(q.fingerprint?{fingerprint:q.fingerprint}:{})});return {...v,hostStarted:await runtimeAlive(j.host)};}catch(e){if(/^ONBOARDING_PLUGIN_REPAIR_[A-Z_]+$/.test(e.message))fail('RUNTIME_REPAIR_'+e.message.slice(25));throw e;}}
 return {action,dispatch,effective:async()=>merged(await ledger(),true)};
}
