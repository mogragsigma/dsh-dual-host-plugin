// Original-archive worker authority. A launch is separate from deletion success.
// No retries: a dead/unknown worker requires a new explicit recovery approval.
import {randomUUID} from 'node:crypto';
import {spawn as runtimeSpawn} from 'node:child_process';
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const exact=(x,k)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join()===k.slice().sort().join();
const birth=x=>exact(x,['platform','pid','start','boot'])&&x.platform==='linux'&&Number.isSafeInteger(x.pid)&&x.pid>0&&/^\d+$/.test(x.start)&&typeof x.boot==='string'&&/^[a-f0-9-]{36}$/.test(x.boot);

export function createReclamationWorker(api,q,j,{ledger,boundPlan,finish,bindWorker}){
 const {path,hash,regular,verified,signed,atomicJSON,checkAncestors,runtimeAlive}=api;
 const file=path.join(q.root,'.control/runtime/reclaim-worker.json'),binding=hash({operationId:q.operationId,runtimeId:j.id,inventoryHash:j.inventoryHash,workerHash:j.workerHash});
 const fail=c=>api.fail('RUNTIME_RECLAIM_WORKER_'+c);
 async function read(d){
  await checkAncestors(path.dirname(file));const f=await regular(file,262144);if(!f){if(d?.workerBound)fail('REVIEW');return null;}
  if(f.identity.uid!==process.getuid()||f.identity.mode!==0o600)fail('REVIEW');let x;try{x=verified(JSON.parse(f.data),q.proof);}catch{fail('REVIEW');}
  if(!exact(x,['schema','binding','revision','launches'])||x.schema!==1||x.binding!==binding||!Number.isSafeInteger(x.revision)||x.revision<1||!Array.isArray(x.launches)||!x.launches.length||x.launches.length>128)fail('REVIEW');
  const ids=new Set();for(const r of x.launches){
   if(!exact(r,['id','reclaimId','planHash','identity','state','error'])||!uuid(r.id)||ids.has(r.id)||r.reclaimId!==d?.id||r.planHash!==d.planHash||!hex(r.planHash)||!['prepared','running','finished','failed'].includes(r.state)||r.identity!==null&&!birth(r.identity)||r.state!=='prepared'&&r.identity===null||r.error!==null&&(!/^ONBOARDING_CLOUD_[A-Z_]{1,160}$/.test(r.error)||r.state!=='failed'))fail('REVIEW');ids.add(r.id);
  }return x;
 }
 async function save(x){x.revision++;if(Buffer.byteLength(JSON.stringify(x))>250000)fail('LIMIT');await atomicJSON(file,signed(x,q.proof));}
 async function observe(d){
  const x=await read(d),r=x?.launches.at(-1),active=r?.identity?await runtimeAlive(r.identity):false;
  return {backgroundSupported:true,workerActive:active,executionState:!d?'not_requested':d.state==='committed'?'completed':active?'running':'interrupted',recoveryRequired:d?.state==='deleting'&&!active};
 }
 async function inactive(d){if((await observe(d)).workerActive)fail('ACTIVE');}
 async function begin(d){
  await inactive(d);const x=await read(d)??{schema:1,binding,revision:0,launches:[]};if(x.launches.length>=128)fail('LIMIT');
  if(typeof api.runtimeReclaimLaunch!=='function'&&typeof api.reclaimWorkerSource!=='string'||typeof api.deferReclaimStart!=='function')fail('UNAVAILABLE');
  const r={id:randomUUID(),reclaimId:d.id,planHash:d.planHash,identity:null,state:'prepared',error:null};x.launches.push(r);await save(x);if(!d.workerBound)await bindWorker(d);
  const launch=api.runtimeReclaimLaunch??((...args)=>launchReclamationWorker({...api,processInfo:api.runtimeProcessInfo,source:api.reclaimWorkerSource},...args));
  const handle=await launch(q,j,{id:r.id,planHash:d.planHash},async identity=>{
   if(!birth(identity))fail('IDENTITY');r.identity=identity;r.state='running';await save(x);
  });
  // The dispatcher releases the original owner lock before delivering stdin.
  // Parent loss before that point closes stdin: no unrecorded launch may execute.
  api.deferReclaimStart(handle);return observe(d);
 }
 async function execute(a){
  if(!exact(a,['id','planHash'])||!uuid(a.id)||!hex(a.planHash))fail('ARGUMENTS');
  const d=await ledger(),x=await read(d),r=x?.launches.at(-1),self=await api.runtimeProcessInfo();
  if(!d||d.state!=='deleting'||!r||r.id!==a.id||r.planHash!==a.planHash||r.state!=='running'||!birth(self)||hash(r.identity)!==hash(self))fail('NOT_AUTHORIZED');
  try{const result=await finish(d,await boundPlan(d));r.state='finished';await save(x);return result;}
  catch(e){r.state='failed';r.error=/^ONBOARDING_CLOUD_[A-Z_]{1,160}$/.test(e.message)?e.message:'ONBOARDING_CLOUD_RUNTIME_RECLAIM_WORKER_FAILED';await save(x);throw e;}
 }
 return {observe,inactive,begin,execute,fingerprint:async d=>hash({journal:d,worker:await read(d)})};
}

export async function launchReclamationWorker(api,q,j,args,persistIdentity){
 const {fs,path,hash,regular,fail,runtimeDir,runtimeEnv,processInfo,source:originalProgram}=api;
 const worker=path.join(runtimeDir(q),'worker.mjs'),source=await regular(worker,200000);
 if(!source||source.identity.uid!==process.getuid()||source.identity.mode!==0o600||source.sha256!==j.workerHash||source.sha256!==hash(originalProgram))fail('RUNTIME_RECLAIM_WORKER_SOURCE_REVIEW');
 const log=await fs.open(path.join(runtimeDir(q),'reclaim-'+args.id+'.log'),'wx',0o600);let child;
 try{
  child=runtimeSpawn(process.execPath,[worker],{cwd:q.root,detached:true,env:runtimeEnv(q),stdio:['pipe',log.fd,log.fd]});
  child.stdin.on('error',()=>{});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  await persistIdentity(await processInfo(child.pid));child.unref();let sent=false;
  const input=JSON.stringify({action:'runtime_version',root:q.root,operationId:q.operationId,installationId:q.installationId,proof:q.proof,planHash:q.planHash,versionAction:'reclaim_worker',args});
  return {start:()=>{if(!sent){sent=true;child.stdin.end(input);}},cancel:()=>{if(!sent){sent=true;child.stdin.end();}}};
 }catch(e){child?.stdin.end();child?.unref();throw e;}finally{await log.close();}
}
