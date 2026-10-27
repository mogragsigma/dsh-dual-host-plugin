// Pre-Node bootstrap: fixed official release, explicit confirmation, durable local receipt.
// All remote execution is this archived controller over the existing pinned SSH binding.
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {credentialKey} from '@deepseek-ai/dsh-credentials';
import {digest,fail,shellQuote} from './onboarding-ssh.js';
import {ancestors,snapshot,bytes} from './onboarding-install-fs.js';
export const NODE_RELEASE=Object.freeze({version:'22.23.4',hashes:Object.freeze({x64:'b8492284c76a54baf58d61668dd0e41ee0fc98adabf9503d30f05d08f55b4406',arm64:'f7a1e486dbc8b286847815b477d4fb5e9fb963ed4489c3e1588853d685f589f9'})});
const OWNER='dsh-dual-host-node-bootstrap',PLAN=credentialKey('dsh-task-gateway','onboarding-node-plan-v1'),OP=credentialKey('dsh-task-gateway','onboarding-node-operation-v1');
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x),hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===keys.sort().join();
const absolute=x=>typeof x==='string'&&x.length<1024&&path.posix.isAbsolute(x)&&path.posix.normalize(x)===x&&!/[\x00-\x1f\x7f]/.test(x);
const fields=['owner','schema','id','revision','binding','bindingFingerprint','plan','proof','sourceHash','phase','remote','error','createdAt','updatedAt'];
function record(r){if(!r)return null;const p=r.payload;if(r.kind!=='grant'||!exact(p,fields)||p.owner!==OWNER||p.schema!==1||!uuid(p.id)||!Number.isSafeInteger(p.revision)||p.revision<1||!hex(p.proof)||!hex(p.sourceHash)||!p.binding||digest(p.binding)!==p.bindingFingerprint||!p.plan||p.plan.bindingFingerprint!==p.bindingFingerprint||p.plan.sourceHash!==p.sourceHash||!['start_requested','observed','outcome_unknown','rollback_requested','rolled_back'].includes(p.phase))fail('NODE_RECORD_REVIEW');const {fingerprint,...body}=p.plan;if(digest(body)!==fingerprint)fail('NODE_RECORD_REVIEW');return p;}
const publicRecord=p=>p?{state:p.phase,operationId:p.id,revision:p.revision,receipt:p.remote,error:p.error,observedAt:p.updatedAt,cached:true,automaticRetry:false,systemNodeModified:false}:{state:'not_started',cached:true,automaticRetry:false,systemNodeModified:false};
export function nodeCommand(python,source){if(!absolute(python)||typeof source!=='string'||Buffer.byteLength(source)>65536)fail('NODE_PROGRAM_REVIEW');const code="import base64; SOURCE=base64.b64decode('"+Buffer.from(source).toString('base64')+"'); exec(compile(SOURCE, '<dsh-node-bootstrap>', 'exec'))";return shellQuote(python)+' -I -B -c '+shellQuote(code);}
function response(raw){let r;try{r=JSON.parse(raw);}catch{fail('NODE_RESPONSE_REVIEW');}if(!r?.ok){if(/^ONBOARDING_NODE_[A-Z_]+$/.test(r?.error))throw Error(r.error);fail('NODE_RESPONSE_REVIEW');}return r.value;}
export function validateNodePlan(v,b,parent){
 const bad=()=>fail('NODE_RESPONSE_REVIEW'),r=v?.release;
 if(!v||v.schema!==1||v.installationId!==b.installationId||v.platform!=='linux'||!['x64','arm64'].includes(v.arch)||!absolute(v.home)||v.home==='/'||!absolute(v.root)||v.parent!==(parent??path.posix.join(v.home,'.local/share/dsh-dual-host/instances'))||v.root!==path.posix.join(v.parent,'node-'+b.installationId)||v.sourceRoot!==path.posix.join(v.parent,'host-'+b.installationId)||!absolute(v.python?.path)||!/^3\.[0-9]+\.[0-9]+$/.test(v.python.version)||!hex(v.fingerprint)||typeof v.rootExists!=='boolean'||typeof v.writable!=='boolean'||!Number.isSafeInteger(v.freeBytes)||v.freeBytes<0||v.remoteWrites!==0||v.systemNodeModified!==false||v.npmGlobalModified!==false||v.serviceStarted!==false||v.modelEnabled!==false)bad();
 if(r?.version!==NODE_RELEASE.version||r.arch!==v.arch||r.directory!==`node-v${NODE_RELEASE.version}-linux-${v.arch}`||r.sha256!==NODE_RELEASE.hashes[v.arch]||r.url!==`https://nodejs.org/dist/v${NODE_RELEASE.version}/${r.directory}.tar.gz`||r.maxArchiveBytes!==134217728||r.maxExpandedBytes!==536870912)bad();
 return v;
}
export function createNodeBootstrap({credentials,readBinding,ssh,localState,enabled,canRemove,parent=null,now=Date.now,readSource=()=>fs.readFile(new URL('./onboarding-node-bootstrap.py',import.meta.url),'utf8')}){
 let busy=false;
 const read=async()=>record(await credentials().readRecord(OP));
 const requireEnabled=()=>{if(!enabled())fail('NODE_DISABLED');};
 async function exclusive(fn){requireEnabled();if(busy)fail('NODE_BUSY');busy=true;try{return await fn();}finally{busy=false;}}
 async function binding(expectedRevision){const b=await readBinding();if(!b||b.revision!==expectedRevision)fail('SSH_BINDING_CONFLICT');return b;}
 async function update(p,change){let next;await credentials().modifyRecord(OP,old=>{const current=record(old);if(!current||current.id!==p.id||current.revision!==p.revision)fail('NODE_OPERATION_CONFLICT');next={...current,...change,revision:current.revision+1,updatedAt:now()};return {kind:'grant',payload:next};});return next;}
 async function readPlan(){const r=await credentials().readRecord(PLAN);if(!r)return null;const p=r.payload;if(r.kind!=='grant'||p?.owner!==OWNER||p.schema!==1||!uuid(p.id)||!hex(p.sourceHash)||!hex(p.fingerprint)||typeof p.canStart!=='boolean')fail('NODE_PLAN_REVIEW');const {fingerprint,...body}=p;if(digest(body)!==fingerprint)fail('NODE_PLAN_REVIEW');return p;}
 async function preview(args){
  if(!exact(args,['expectedRevision'])||!Number.isSafeInteger(args.expectedRevision))fail('NODE_ARGUMENTS');
  return exclusive(async()=>{
   const p=await read();if(p&&p.phase!=='rolled_back')fail('NODE_RECOVERY_REQUIRED');
   const b=await binding(args.expectedRevision),source=await readSource();
   const python=(await ssh.execute(b,"/bin/sh -c 'command -v python3 || true'")).trim();if(!absolute(python))fail('NODE_PYTHON_MISSING');
   const remote=validateNodePlan(response(await ssh.execute(b,nodeCommand(python,source),JSON.stringify({action:'preview',installationId:b.installationId,parent}))),b,parent);
   if(digest(await readBinding())!==digest(b))fail('SSH_BINDING_CONFLICT');
   const plan={owner:OWNER,schema:1,id:randomUUID(),bindingFingerprint:digest(b),bindingRevision:b.revision,sourceHash:digest(source),remote,canStart:!remote.rootExists&&remote.writable&&remote.freeBytes>=2147483648,createdAt:now(),expiresAt:now()+300000};plan.fingerprint=digest(plan);
   await readPlan();await credentials().modifyRecord(PLAN,()=>({kind:'grant',payload:plan}));return plan;
  });
 }
 async function sourceFor(p){const file=path.join(localState,'node-bootstrap',p.id,'controller.py');await ancestors(path.dirname(file));const s=await snapshot(file,65536);if(s.missing||s.sha256!==p.sourceHash)fail('NODE_PROGRAM_REVIEW');return bytes(s).toString('utf8');}
 async function invoke(p,action){
  const b=await readBinding();if(digest(b)!==p.bindingFingerprint)fail('SSH_BINDING_CONFLICT');
  const source=await sourceFor(p),q={action,installationId:b.installationId,parent,operationId:p.id,proof:p.proof};if(action==='start')q.fingerprint=p.plan.remote.fingerprint;
  const v=response(await ssh.execute(b,nodeCommand(p.plan.remote.python.path,source),JSON.stringify(q),{timeoutMs:action==='rollback'?120000:30000}));
  if(!v||v.operationId!==p.id||!['absent','launching','downloading','extracting','checking','ready','failed','stopped','needs_review','rolling_back','rolled_back'].includes(v.state)||v.systemNodeModified!==false||v.automaticRetry!==false||v.root&&v.root!==p.plan.remote.root)fail('NODE_RESPONSE_REVIEW');
  if(v.state==='ready'&&(v.node!==`${p.plan.remote.root}/${p.plan.remote.release.directory}/bin/node`||v.npm!==`${p.plan.remote.root}/${p.plan.remote.release.directory}/bin/npm`||v.version!==p.plan.remote.release.version||v.arch!==p.plan.remote.arch))fail('NODE_RESPONSE_REVIEW');return v;
 }
 async function outcome(p,action){try{const remote=await invoke(p,action);const phase=remote.state==='rolled_back'?'rolled_back':remote.state==='absent'?'outcome_unknown':'observed';return update(p,{phase,remote,error:remote.state==='absent'?'NODE_ABSENCE_REQUIRES_REVIEW':null});}catch(e){return update(p,{phase:p.phase==='rollback_requested'?'rollback_requested':'outcome_unknown',error:/^ONBOARDING_[A-Z_]+$/.test(e.message)?e.message:'ONBOARDING_NODE_OUTCOME_UNKNOWN'});}}
 async function start(args){
  if(!exact(args,['id','fingerprint','confirm'])||!uuid(args.id)||!hex(args.fingerprint)||args.confirm!==true)fail('NODE_CONFIRMATION_REQUIRED');
  return exclusive(async()=>{
   const prior=await read();if(prior?.plan.id===args.id&&prior.plan.fingerprint===args.fingerprint)return publicRecord(prior);if(prior&&prior.phase!=='rolled_back')fail('NODE_RECOVERY_REQUIRED');
   const plan=await readPlan();if(!plan||plan.id!==args.id||plan.fingerprint!==args.fingerprint||plan.expiresAt<now()||!plan.canStart)fail('NODE_PLAN_EXPIRED');
   const b=await binding(plan.bindingRevision),source=await readSource();if(digest(b)!==plan.bindingFingerprint||digest(source)!==plan.sourceHash)fail('NODE_PLAN_DRIFT');
   const id=randomUUID(),dir=path.join(localState,'node-bootstrap',id);await ancestors(dir);await fs.mkdir(dir,{recursive:true,mode:0o700});await ancestors(dir);const file=await fs.open(path.join(dir,'controller.py'),'wx',0o600);try{await file.writeFile(source);await file.sync();}finally{await file.close();}
   const p={owner:OWNER,schema:1,id,revision:1,binding:b,bindingFingerprint:digest(b),plan,proof:randomBytes(32).toString('hex'),sourceHash:digest(source),phase:'start_requested',remote:null,error:null,createdAt:now(),updatedAt:now()};
   if(prior)await credentials().modifyRecord(credentialKey('dsh-task-gateway','onboarding-node-history-v1-'+prior.id),old=>{if(old&&(old.kind!=='grant'||digest(old.payload)!==digest(prior)))fail('NODE_HISTORY_REVIEW');return old??{kind:'grant',payload:prior};});
   await credentials().modifyRecord(OP,old=>{const r=record(old);if((r?.id??null)!==(prior?.id??null)||(r?.revision??null)!==(prior?.revision??null))fail('NODE_OPERATION_CONFLICT');return {kind:'grant',payload:p};});return publicRecord(await outcome(p,'start'));
  });
 }
 async function status(args){
  requireEnabled();if(!exact(args,['refresh'])||typeof args.refresh!=='boolean')fail('NODE_ARGUMENTS');
  const p=await read();if(!p||!args.refresh||p.phase==='rolled_back')return publicRecord(p);
  return exclusive(async()=>publicRecord(await outcome(await read(),'status')));
 }
 async function action(args){
  if(!exact(args,['action','operationId','expectedRevision','confirm'])||!['stop','rollback'].includes(args.action)||!uuid(args.operationId)||!Number.isSafeInteger(args.expectedRevision)||args.confirm!==true)fail('NODE_CONFIRMATION_REQUIRED');
  return exclusive(async()=>{let p=await read();if(!p||p.id!==args.operationId||p.revision!==args.expectedRevision)fail('NODE_OPERATION_CONFLICT');if(p.phase==='rolled_back')return publicRecord(p);if(args.action==='rollback'){if(!await canRemove())fail('NODE_HOST_REMOVAL_REQUIRED');p=await update(p,{phase:'rollback_requested',error:null});}return publicRecord(await outcome(p,args.action));});
 }
 async function selected(b){const p=await read();if(!p||p.phase==='rolled_back')return null;if(p.bindingFingerprint!==digest(b)||p.phase!=='observed'||p.remote?.state!=='ready')fail('NODE_RECOVERY_REQUIRED');const v=await invoke(p,'status');if(v.state!=='ready')fail('NODE_RECOVERY_REQUIRED');return {node:v.node,npm:v.npm};}
 return {preview,start,status,action,selected,hasUnfinished:async()=>{const p=await read();return !!p&&p.phase!=='rolled_back';}};
}
