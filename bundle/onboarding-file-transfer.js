// Explicit, per-runtime file consent. No user profile writes or implicit IM export.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {credentialKey} from '@deepseek-ai/dsh-credentials';
import {PeerFiles,FILE_MAX} from './peer-files.js';
import {FileRoot} from './peer-file-fs.js';
import {migrationSnapshot,migrateFileScope} from './peer-file-migration.js';
import {fileQueueList,fileQueuePlan,fileQueueReceipt,fileQueueClosed,closeFileQueuePlan,applyFileQueuePlan} from './peer-file-review.js';
import {digest} from './onboarding-ssh.js';
const owner='dsh-dual-host-file-transfer',exact=(v,ks)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===ks.slice().sort().join();
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v),hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const fail=c=>{throw Error('ONBOARDING_FILES_'+c);},within=(a,b)=>a===b||a.startsWith(b+path.sep);
const limits={maxBytes:FILE_MAX,queueEntries:64,chunkBytes:48*1024,automaticDeletion:false};
// The outbox contains user input, not executable runtime state. Recognize only our
// exact private marker; callers must still validate the directory itself. Never
// traverse, chmod or adopt its contents here: PeerFiles validates each send.
export function isManagedFileOutbox(root,p){
 if(p!==path.join(root,'files','outbox'))return false;
 try{const marker=path.join(root,'files','owner.json'),s=fs.lstatSync(marker);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||(s.mode&0o077)||s.size>1024||process.getuid&&s.uid!==process.getuid())return false;const v=JSON.parse(fs.readFileSync(marker,'utf8'));return exact(v,['owner','schema','runtimeId','role','namespace'])&&v.owner===owner&&v.schema===1&&uuid(v.runtimeId)&&v.runtimeId===path.basename(root)&&['local','cloud'].includes(v.role)&&typeof v.namespace==='string'&&v.namespace.startsWith('managed-')&&uuid(v.namespace.slice(8));}catch{return false;}
}
export function createOnboardingFileTransfer({g,root,credentials,protectedRoots=[],now=Date.now}){
 const runtimeId=path.basename(root),role=g.c.role,namespace=g.c.namespace,base=new FileRoot(root),folder=path.join(root,'files'),outbox=path.join(folder,'outbox'),inbox=path.join(folder,'inbox');
 if(!uuid(runtimeId)||!['local','cloud'].includes(role)||!/^managed-[a-f0-9-]{36}$/.test(namespace)||path.resolve(g.c.stateDir)!==path.join(root,'state'))fail('RUNTIME_REQUIRED');
 const key=credentialKey('dsh-task-gateway','onboarding-files-v1-'+runtimeId),marker=JSON.stringify({owner,schema:1,runtimeId,role,namespace});let pending=null,queuePending=null,mounted=null,raw=null,busy=false,closed=false,lastError=null;
 const available=()=>!closed&&!g.closed&&!!credentials();
 const ready=()=>{if(!available())fail('UNAVAILABLE');base.check();};
 function owned(p,dir){const s=fs.lstatSync(p);if(s.isSymbolicLink()||!(dir?s.isDirectory():s.isFile())||!dir&&s.nlink!==1||s.mode&0o077||process.getuid&&s.uid!==process.getuid())fail('PATH_REVIEW');return s;}
 function inspectOwned(){base.check();if(!fs.existsSync(folder))return;owned(folder,true);owned(path.join(folder,'owner.json'),false);if(fs.readFileSync(path.join(folder,'owner.json'),'utf8')!==marker)fail('PATH_REVIEW');for(const p of [outbox,inbox])if(fs.existsSync(p))owned(p,true);}
 function makeOwned(){inspectOwned();if(!fs.existsSync(folder)){fs.mkdirSync(folder,{mode:0o700});fs.writeFileSync(path.join(folder,'owner.json'),marker,{flag:'wx',mode:0o600});}for(const p of [outbox,inbox]){try{fs.mkdirSync(p,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}owned(p,true);}}
 function scope(roots,maxBytes){
  ready();inspectOwned();if(!Array.isArray(roots)||roots.length>8||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>FILE_MAX)fail('ARGUMENTS');
  const selected=(roots.length?roots:[outbox]).map(p=>{
   if(typeof p!=='string'||p.length>4096||!path.isAbsolute(p)||path.resolve(p)!==p||/[\x00-\x1f\x7f]/u.test(p))fail('SOURCE_REVIEW');
   if(p===outbox)return {path:p,identity:'owned-outbox'};
   if(p===path.dirname(p)||within(p,root)||within(root,p)||protectedRoots.some(x=>within(p,x)||within(x,p))||p.split(path.sep).some(x=>/^(?:\.ssh|\.dsh|\.agents|\.\u0063\u006f\u0064\u0065\u0078|\.aws|\.aliyun|credentials|secrets)$/iu.test(x)))fail('SOURCE_DENIED');
   const r=new FileRoot(p);if(r.canonical!==p)fail('SOURCE_REVIEW');return {path:p,identity:r.id};
  }).sort((a,b)=>a.path.localeCompare(b.path));
  if(new Set(selected.map(x=>x.path)).size!==selected.length||selected.some((a,i)=>selected.some((b,j)=>i!==j&&within(a.path,b.path))))fail('SOURCE_OVERLAP');
  return {runtimeId,role,namespace,root,rootIdentity:base.id,sendRoots:selected,receiveRoot:inbox,maxBytes};
 }
 function checkedScope(s){if(!exact(s,['runtimeId','role','namespace','root','rootIdentity','sendRoots','receiveRoot','maxBytes'])||s.runtimeId!==runtimeId||s.role!==role||s.namespace!==namespace||s.root!==root||s.rootIdentity!==base.id||s.receiveRoot!==inbox||!Array.isArray(s.sendRoots)||!s.sendRoots.length||s.sendRoots.length>8||s.sendRoots.some(x=>!exact(x,['path','identity'])||typeof x.path!=='string'||!path.isAbsolute(x.path)||path.resolve(x.path)!==x.path||typeof x.identity!=='string'||!(x.path===outbox?x.identity==='owned-outbox':/^\d+:\d+$/.test(x.identity)))||!Number.isSafeInteger(s.maxBytes)||s.maxBytes<1||s.maxBytes>FILE_MAX)fail('LEDGER_REVIEW');return s;}
 function record(r){if(!r)return null;const p=r.payload;
  if(r.kind!=='grant'||!exact(p,['owner','schema','revision','operation','planHash','enabled','scope','updatedAt',...(p?.schema===2?['transition']:[])])||p.owner!==owner||![1,2].includes(p.schema)||!Number.isSafeInteger(p.revision)||p.revision<1||p.revision>=Number.MAX_SAFE_INTEGER-1||!uuid(p.operation)||!hex(p.planHash)||typeof p.enabled!=='boolean'||!Number.isSafeInteger(p.updatedAt))fail('LEDGER_REVIEW');
  if(p.scope===null){if(p.enabled||p.schema===2)fail('LEDGER_REVIEW');return p;}checkedScope(p.scope);
  if(p.schema===2){const t=p.transition;if(p.enabled||!exact(t,['previousScope','snapshot'])||!exact(t.snapshot,['ownerHash','queueHash','held'])||!hex(t.snapshot.ownerHash)||!hex(t.snapshot.queueHash)||!exact(t.snapshot.held,['outgoing','incoming','broker'])||!Object.values(t.snapshot.held).every(x=>Number.isSafeInteger(x)&&x>=0&&x<=64))fail('LEDGER_REVIEW');checkedScope(t.previousScope);}
  return p;
 }
 function settled(p){if(p?.transition)fail('MIGRATION_PENDING');}
 async function completeMigration(p){
  if(!p?.transition)return p;
  // The persistent intent is already an explicit disabled-only authorization.
  // Resume only that exact operation; never infer consent from the new DB owner.
  if(g.files||raw||mounted)fail('MIGRATION_DISABLE_REQUIRED');inspectOwned();
  if(digest(scope(p.scope.sendRoots.map(x=>x.path),p.scope.maxBytes))!==digest(p.scope))fail('SOURCE_CHANGED');
  migrateFileScope(g.db,{operation:p.operation,planHash:p.planHash,previous:p.transition.previousScope,next:p.scope,snapshot:p.transition.snapshot});
  let next;await credentials().modifyRecord(key,current=>{const c=record(current);if(c?.revision!==p.revision||c.operation!==p.operation||c.planHash!==p.planHash||digest(c.scope)!==digest(p.scope))fail('CONFLICT');if(!c.transition){next=c;return undefined;}if(digest(c.transition)!==digest(p.transition))fail('CONFLICT');const {transition,...rest}=c;next={...rest,schema:1};return {kind:'grant',payload:next};});lastError=null;return next;
 }
 async function read(){ready();return record(await credentials().readRecord(key));}
 async function run(fn){ready();if(busy)fail('BUSY');busy=true;try{return await fn();}finally{busy=false;}}
 async function suspend(){const prior=raw;if(g.files===mounted)g.files=undefined;mounted=null;raw=null;if(prior?.pending)await prior.pending.catch(()=>{});}
 async function sync(p){
  await suspend();lastError=null;if(!p?.enabled)return;
  if(g.files)fail('SERVICE_CONFLICT');if(digest(scope(p.scope.sendRoots.map(x=>x.path),p.scope.maxBytes))!==digest(p.scope))fail('SOURCE_CHANGED');makeOwned();
  let acceptedRevision=p.revision;const engine=new PeerFiles(g,{enabled:true,sendRoots:p.scope.sendRoots.map(x=>x.path),receiveRoot:inbox,maxBytes:p.scope.maxBytes});let facade;
  async function authorized(){const latest=await read();if(g.files!==facade||!latest?.enabled||latest.revision!==acceptedRevision||digest(latest.scope)!==digest(p.scope))fail('DISABLED');}
  const tracked=fn=>g.maintenance?g.maintenance.run('managed_files',fn):fn();
  facade={scopeHash:digest(p.scope),advanceRevision:r=>{acceptedRevision=r;},code:e=>engine.code(e),get pending(){return engine.pending;},get lastError(){return engine.lastError;},set lastError(e){engine.lastError=e;},snapshot:()=>engine.snapshot(),async scope(){await authorized();return {...engine.scope(),revision:acceptedRevision,scope_hash:digest(p.scope)};},async enqueue(a){return tracked(async()=>{await authorized();return engine.enqueue(a);});},async list(a){return tracked(async()=>{await authorized();return engine.list(a);});},async call(...a){return tracked(async()=>{await authorized();return engine.call(...a);});},async sync(){if(g.maintenance?.blocked)return;return tracked(async()=>{await authorized();return engine.sync();});}};
  if(g.files)fail('SERVICE_CONFLICT');raw=engine;mounted=facade;g.files=facade;mounted.revision=p.revision;
 }
 async function start(){if(!available())return;return run(async()=>{try{await sync(await completeMigration(await read()));}catch(e){lastError=safe(e);}});}
 function safe(e){return /^ONBOARDING_FILES_[A-Z_]+$/.test(e.message)?e.message:'ONBOARDING_FILES_NEEDS_REVIEW';}
 function counts(){const db=g.db,exists=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='peer_file_out'").get();if(!exists)return {outgoing:0,incoming:0,broker:0};return {outgoing:db.prepare('SELECT count(*) n FROM peer_file_out').get().n,incoming:db.prepare('SELECT count(*) n FROM peer_file_in').get().n,broker:db.prepare('SELECT count(*) n FROM peer_file_broker').get().n};}
 async function status(a={}){if(!exact(a,[]))fail('ARGUMENTS');const p=await read(),active=!p?.transition&&!!p?.enabled&&g.files===mounted&&mounted?.revision===p.revision;
  return {contract:2,available:true,scope:'current_managed_host_only',scopeHash:p?.scope?digest(p.scope):null,role,runtimeId,namespace,revision:p?.revision??0,appliedOperation:p?.operation??null,appliedPlanHash:p?.planHash??null,enabled:p?.enabled??false,active:!!active,state:active?'active':p?.transition||lastError?'needs_review':p?.enabled?'activation_pending':p?'disabled':'not_configured',sendRoots:p?.scope?.sendRoots.map(x=>x.path)??[outbox],receiveRoot:inbox,maxBytes:p?.scope?.maxBytes??FILE_MAX,limits,counts:counts(),error:p?.transition?'ONBOARDING_FILES_MIGRATION_PENDING':lastError,imTemporaryRootsIncluded:false,repositoryWriteAuthorized:false,executionAuthorized:false,automaticDeletion:false};}
 async function preview(a){return run(async()=>{pending=null;if(!exact(a,['enabled','sendRoots','maxBytes'])||typeof a.enabled!=='boolean')fail('ARGUMENTS');const p=await read();settled(p);let s;if(!a.enabled){if(!p?.scope)fail('NOT_CONFIGURED');if(!Array.isArray(a.sendRoots)||digest(a.sendRoots.length?a.sendRoots.slice().sort():[outbox])!==digest(p.scope.sendRoots.map(x=>x.path).sort())||a.maxBytes!==p.scope.maxBytes)fail('ARGUMENTS');s=p.scope;}else s=scope(a.sendRoots,a.maxBytes);if(p?.scope&&digest(p.scope)!==digest(s))fail('SCOPE_CHANGE_REQUIRES_MIGRATION');
  const body={id:randomUUID(),expectedRevision:p?.revision??0,enabled:a.enabled,scope:s,expiresAt:now()+300000};pending={...body,fingerprint:digest(body)};return {...pending,contract:2,limits,writes:0,modelRequests:0,imTemporaryRootsIncluded:false,repositoryWriteAuthorized:false,executionAuthorized:false};});}
 async function migrationPreview(a){return run(async()=>{
  pending=null;if(!exact(a,['sendRoots','maxBytes']))fail('ARGUMENTS');const p=await read();settled(p);
  if(!p?.scope)fail('NOT_CONFIGURED');if(p.enabled||g.files||mounted||raw)fail('MIGRATION_DISABLE_REQUIRED');
  const s=scope(a.sendRoots,a.maxBytes);if(digest(s)===digest(p.scope))fail('MIGRATION_NO_CHANGE');
  const migration={previousScope:p.scope,snapshot:migrationSnapshot(g.db,p.scope)};
  const body={id:randomUUID(),expectedRevision:p.revision,enabled:false,scope:s,migration,expiresAt:now()+300000};pending={...body,fingerprint:digest(body)};
  return {...pending,contract:1,kind:'scope_migration',limits,writes:0,modelRequests:0,preservesFiles:true,holdsPendingTransfers:true,requiresSeparateEnable:true,executionAuthorized:false,repositoryWriteAuthorized:false};
 });}
 async function migrationRecover(a){return run(async()=>{
  if(!exact(a,['operation','confirm'])||!uuid(a.operation)||a.confirm!==true)fail('CONFIRMATION_REQUIRED');const p=await read();if(p?.operation!==a.operation)fail('CONFLICT');
  if(!p.transition){lastError=null;return {...await status({}),notReapplied:true};}
  try{await completeMigration(p);}catch(e){lastError=safe(e);throw e;}return status({});
 });}
 function queueReady(p){settled(p);if(!p?.scope)fail('NOT_CONFIGURED');if(p.enabled||g.files||raw||mounted)fail('QUEUE_DISABLE_REQUIRED');inspectOwned();}
 async function queueList(a){return run(async()=>{if(!exact(a,[]))fail('ARGUMENTS');const p=await read();settled(p);if(!p?.scope)fail('NOT_CONFIGURED');inspectOwned();return {...fileQueueList(g,p.scope),revision:p.revision,enabled:p.enabled};});}
 async function queueReviewPreview(a){return run(async()=>{
  queuePending=null;if(!exact(a,['item','decision']))fail('ARGUMENTS');const p=await read();queueReady(p);
  const body={id:randomUUID(),runtimeId,role,expectedRevision:p.revision,scopeHash:digest(p.scope),review:fileQueuePlan(g,p.scope,a),expiresAt:now()+300000};queuePending={...body,fingerprint:digest(body)};
  return {...queuePending,contract:2,kind:'queue_review',writes:0,modelRequests:0};
 });}
 async function queueReviewApply(a){return run(async()=>{
  if(!exact(a,['id','fingerprint','confirm'])||!uuid(a.id)||!hex(a.fingerprint)||a.confirm!==true)fail('CONFIRMATION_REQUIRED');
  const prior=fileQueueReceipt(g.db,a.id,a.fingerprint);if(prior)return {...prior,notReapplied:true};
  if(fileQueueClosed(g.db,a.id,a.fingerprint))fail('QUEUE_CLOSED');
  const plan=queuePending;if(!plan||plan.id!==a.id||plan.fingerprint!==a.fingerprint||plan.expiresAt<=now())fail('PLAN_EXPIRED');queuePending=null;
  const p=await read();queueReady(p);if(p.revision!==plan.expectedRevision||digest(p.scope)!==plan.scopeHash)fail('CONFLICT');
  // No await between this last disabled-grant check and the synchronous DB commit.
  // Queue intent is the atomic receipt, not a new grant; restart cannot enable it.
  return applyFileQueuePlan(g,p.scope,plan);
 });}
 async function queueReviewStatus(a){return run(async()=>{
  if(!exact(a,['operation','fingerprint'])||!uuid(a.operation)||!hex(a.fingerprint))fail('ARGUMENTS');
  return queueOutcome(a);
 });}
 function queueOutcome(a){return {contract:2,runtimeId,role,operation:a.operation,fingerprint:a.fingerprint,receipt:fileQueueReceipt(g.db,a.operation,a.fingerprint),closed:fileQueueClosed(g.db,a.operation,a.fingerprint),automaticRetry:false};}
 async function queueReviewClose(a){return run(async()=>{
  if(!exact(a,['operation','fingerprint','confirm'])||!uuid(a.operation)||!hex(a.fingerprint)||a.confirm!==true)fail('CONFIRMATION_REQUIRED');
  // This barrier does not require or change the file grant, queue, or engine.
  closeFileQueuePlan(g.db,a.operation,a.fingerprint);return queueOutcome(a);
 });}
 async function apply(a){return run(async()=>{if(!exact(a,['id','fingerprint','confirm'])||!uuid(a.id)||!hex(a.fingerprint)||a.confirm!==true)fail('CONFIRMATION_REQUIRED');const old=await read();if(old?.operation===a.id&&old.planHash===a.fingerprint)return {...await status({}),notReapplied:true};const p=pending;if(!p||p.id!==a.id||p.fingerprint!==a.fingerprint||p.expiresAt<=now())fail('PLAN_EXPIRED');pending=null;
  if((p.enabled||p.migration)&&digest(scope(p.scope.sendRoots.map(x=>x.path),p.scope.maxBytes))!==digest(p.scope))fail('SOURCE_CHANGED');
  if(p.migration&&(old?.enabled||g.files||mounted||raw))fail('MIGRATION_DISABLE_REQUIRED');
  await credentials().modifyRecord(key,current=>{const prior=record(current);settled(prior);if((prior?.revision??0)!==p.expectedRevision)fail('CONFLICT');return {kind:'grant',payload:{owner,schema:p.migration?2:1,revision:p.expectedRevision+1,operation:p.id,planHash:p.fingerprint,enabled:p.enabled,scope:p.scope,updatedAt:now(),...(p.migration?{transition:p.migration}:{})}};});
  try{await sync(await completeMigration(await read()));}catch(e){lastError=safe(e);await suspend();}return status({});
 });}
 async function fence(a){return run(async()=>{
  if(!exact(a,['operation','expectedRevision','confirm'])||!uuid(a.operation)||!Number.isSafeInteger(a.expectedRevision)||a.expectedRevision<0||a.expectedRevision>=Number.MAX_SAFE_INTEGER-1||a.confirm!==true)fail('CONFIRMATION_REQUIRED');
  let next;await credentials().modifyRecord(key,current=>{const p=record(current);settled(p);if(p?.operation===a.operation&&p.planHash===digest(a)){next=p;return undefined;}if((p?.revision??0)!==a.expectedRevision)fail('CONFLICT');next={owner,schema:1,revision:a.expectedRevision+1,operation:a.operation,planHash:digest(a),enabled:p?.enabled??false,scope:p?.scope??null,updatedAt:now()};return {kind:'grant',payload:next};});
  // A fence closes an uncertain old write; it must not mount, stop, or adopt a directory.
  if(mounted&&g.files===mounted&&next.enabled&&mounted.revision===a.expectedRevision&&mounted.scopeHash===digest(next.scope)){mounted.revision=next.revision;mounted.advanceRevision(next.revision);}
  return status({});
 });}
 async function close(){closed=true;pending=null;queuePending=null;await suspend();}
 return {available,start,status,preview,apply,fence,migrationPreview,migrationRecover,queueList,queueReviewPreview,queueReviewApply,queueReviewStatus,queueReviewClose,close};
}
