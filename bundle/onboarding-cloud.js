import path from 'node:path';
import fs from 'node:fs/promises';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createOnboardingState} from './onboarding-state.js';
import {resolveOnboardingPaths} from './onboarding-paths.js';
import {connection,identity,hostKeys,createSSH,digest,fail,shellQuote} from './onboarding-ssh.js';
import {validateRemoteSnapshot} from './onboarding-cloud-contract.js';
import {createCloudOperations} from './onboarding-cloud-operation.js';
import {cloudPackage} from './onboarding-cloud-package.js';
import {createNodeBootstrap} from './onboarding-node.js';
const OWNER='dsh-dual-host-onboarding',BINDING='dsh-task-gateway/onboarding-ssh-v1',PLAN='dsh-task-gateway/onboarding-cloud-plan-v1';
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(x);
const exact=(x,fields)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join()===fields.sort().join();
const revision=x=>Number.isSafeInteger(x)&&x>=0&&x<Number.MAX_SAFE_INTEGER;
function stored(record){
 if(!record)return null;const p=record.payload;
 if(record.kind!=='grant'||!exact(p,['owner','schema','revision','installationId','connection','identity','keys','approvedAt'])||p.owner!==OWNER||p.schema!==1||!revision(p.revision)||!p.revision||!uuid(p.installationId)||!Array.isArray(p.keys)||!p.keys.length||p.keys.length>3||!Number.isSafeInteger(p.approvedAt))fail('SSH_STATE_REVIEW');
 connection(p.connection);
 const verified=hostKeys(p.keys.map(k=>`bound-host ${k.type} ${k.key}`).join('\n'));
 if(digest(verified)!==digest(p.keys)||!p.identity||p.identity.kind!==p.connection.auth)fail('SSH_STATE_REVIEW');
 return p;
}
const view=p=>({configured:!!p,revision:p?.revision??0,reference:'dsh-managed:ssh-cloud',connection:p?.connection??null,keys:p?.keys.map(k=>({type:k.type,fingerprint:k.fingerprint}))??[],installationId:p?.installationId??null,verifiedConnection:false});
export function createOnboardingCloud(ctx,config={},runtime={}){
 const platform=runtime.platform??process.platform,env=runtime.env??process.env,home=runtime.home??homedir(),now=runtime.now??Date.now;
 const state=createOnboardingState(ctx,config,runtime),setting=config.onboarding?.cloud;
 const localState=path.join(resolveOnboardingPaths({platform,home,env}).dsh.path,'dual-host-onboarding','transport');
 const rt={platform,env,home,localState},ssh=runtime.ssh??createSSH(rt);let observation=null,inflight=false;
 const available=()=>setting?.enabled!==false&&state.available();
 function credentials(){if(!available())fail('CLOUD_DISABLED');return runtime.credentials??ctx.credentials;}
 async function readBinding(){return stored(await credentials().readRecord(BINDING));}
 async function readPlan(){const old=await credentials().readRecord(PLAN);if(!old)return null;const p=old.payload;if(old.kind!=='grant'||!p||p.owner!==OWNER||p.schema!==1||!uuid(p.id)||p.canApply!==false||p.executor!=='pending_implementation')fail('CLOUD_PLAN_REVIEW');const {fingerprint,...body}=p;if(digest(body)!==fingerprint)fail('CLOUD_PLAN_REVIEW');return p;}
 const preparationAvailable=()=>available()&&setting?.preparation!==false;
 const runtimeAvailable=()=>preparationAvailable()&&setting?.runtime!==false;
 const operations=createCloudOperations({credentials,readBinding,readPlan,inspect,ssh,localState:path.dirname(localState),source:runtime.source,now,enabled:preparationAvailable,runtimeEnabled:runtimeAvailable});
 const nodeBootstrap=createNodeBootstrap({credentials,readBinding,ssh,localState:path.dirname(localState),enabled:preparationAvailable,canRemove:async()=>!await operations.hasUnfinished(),parent:setting?.remoteParent??null,now});
 async function status(){return view(await readBinding());}
 async function newTarget(args){
  if(!preparationAvailable())fail('CLOUD_PREPARATION_DISABLED');if(!exact(args,['operationId','expectedBindingRevision','confirm'])||!uuid(args.operationId)||!revision(args.expectedBindingRevision)||args.confirm!==true)fail('CLOUD_CONFIRMATION_REQUIRED');
  const b=await readBinding();if(!b||b.revision!==args.expectedBindingRevision)fail('SSH_BINDING_CONFLICT');
  if(await nodeBootstrap.hasUnfinished())fail('NODE_RECOVERY_REQUIRED');
  const s=await operations.status({refresh:true});if(s.operationId!==args.operationId||s.state!=='retired'||!s.root.endsWith('/host-'+b.installationId))fail('CLOUD_REPLACEMENT_REQUIRED');await operations.archiveTerminal();
  let result;await credentials().modifyRecord(BINDING,old=>{const current=stored(old);if(digest(current)!==digest(b))fail('SSH_BINDING_CONFLICT');result={...current,revision:current.revision+1,installationId:randomUUID()};return {kind:'grant',payload:result};});observation=null;return {...view(result),previousTargetRetained:true,initialization:false};
 }

 async function scan(args){
  if(!exact(args,['connection']))fail('SSH_ARGUMENTS');credentials();const c=connection(args.connection),who=await identity(c,rt);
  if(inflight)fail('SSH_BUSY');inflight=true;observation=null;
  try{const keys=await ssh.scan(c),id=randomUUID();observation={id,expiresAt:now()+300000,connection:c,identity:who,keys,fingerprint:digest({c,who,keys})};return {id,expiresAt:observation.expiresAt,fingerprint:observation.fingerprint,keys:keys.map(k=>({type:k.type,fingerprint:k.fingerprint})),host:c.host,port:c.port,trust:'unverified_scan',authenticationAttempted:false};}finally{inflight=false;}
 }
 async function trust(args){
  if(!exact(args,['id','fingerprint','expectedRevision','confirm'])||args.confirm!==true||!revision(args.expectedRevision))fail('SSH_ARGUMENTS');
  const c=credentials(),o=observation;if(!o||args.id!==o.id||args.fingerprint!==o.fingerprint||now()>o.expiresAt)fail('SSH_OBSERVATION_EXPIRED');
  if(await operations.hasUnfinished()||await nodeBootstrap.hasUnfinished())fail('CLOUD_RECOVERY_REQUIRED');await operations.preserveTerminalIfAny();
  if(digest(await identity(o.connection,rt))!==digest(o.identity))fail('SSH_IDENTITY_CHANGED');let result;
  await c.modifyRecord(BINDING,old=>{
   const p=stored(old);if((p?.revision??0)!==args.expectedRevision)fail('SSH_BINDING_CONFLICT');
   const sameTarget=p&&p.connection.host===o.connection.host&&p.connection.port===o.connection.port&&p.connection.user===o.connection.user;
   result={owner:OWNER,schema:1,revision:args.expectedRevision+1,installationId:sameTarget?p.installationId:randomUUID(),connection:o.connection,identity:o.identity,keys:o.keys,approvedAt:now()};
   return {kind:'grant',payload:result};
  });observation=null;return view(result);
 }
 const bootstrap="/bin/sh -c "+shellQuote("printf '%s\\000' DSH_PROBE_V1; uname -s; printf '\\000'; uname -m; printf '\\000'; command -v node || true; printf '\\000'; command -v npm || true; printf '\\000'; command -v git || true; printf '\\000'; command -v aliyun || true; printf '\\000'");
 async function inspect(binding){
  const raw=await ssh.execute(binding,bootstrap),parts=raw.split('\0').map(x=>x.trim());if(parts[0]!=='DSH_PROBE_V1'||parts.length!==8)fail('CLOUD_RESPONSE_INVALID');
  const tools={node:parts[3]||null,npm:parts[4]||null,git:parts[5]||null,aliyun:parts[6]||null};
  for(const p of Object.values(tools))if(p!==null&&(!path.posix.isAbsolute(p)||p.length>1024||/[\x00-\x1f\x7f]/.test(p)))fail('CLOUD_RESPONSE_INVALID');
  if(parts[1]!=='Linux')return {state:'unsupported_platform',platform:parts[1],architecture:parts[2],tools,remoteWrites:0};
  const managed=await nodeBootstrap.selected(binding);if(managed)Object.assign(tools,managed);
  if(!tools.node)return {state:'runtime_bootstrap_required',platform:'Linux',architecture:parts[2],tools,remoteWrites:0};
  const nodeVersion=(await ssh.execute(binding,shellQuote(tools.node)+' --version')).trim();
  if(!/^v\d+\.\d+\.\d+$/.test(nodeVersion))fail('CLOUD_RESPONSE_INVALID');
  if(Number(nodeVersion.slice(1).split('.')[0])<22)return {state:'runtime_bootstrap_required',platform:'Linux',architecture:parts[2],tools,nodeVersion:nodeVersion.slice(1),remoteWrites:0};
  const program=await fs.readFile(new URL('./onboarding-remote-probe.js',import.meta.url),'utf8');
  const response=await ssh.execute(binding,shellQuote(tools.node)+' --input-type=module -e '+shellQuote(program),JSON.stringify({installationId:binding.installationId,parent:setting?.remoteParent??null}));
  let r;try{r=JSON.parse(response);}catch{fail('CLOUD_RESPONSE_INVALID');}
  if(!r.ok)fail('CLOUD_'+(['UNSAFE_PATH','OWNER_REVIEW','PATH_INVALID'].includes(r.code)?r.code:'PROBE_FAILED'));
  validateRemoteSnapshot(r,binding.installationId,setting?.remoteParent);
  return {...r,tools,state:'observed',observedAt:now(),expiresAt:now()+60000,bindingRevision:binding.revision,bindingFingerprint:digest(binding),notAuthorization:true};
 }
 async function probe(args){
  if(!exact(args,['expectedRevision'])||!revision(args.expectedRevision))fail('SSH_ARGUMENTS');const b=await readBinding();if(!b||b.revision!==args.expectedRevision)fail('SSH_BINDING_CONFLICT');
  if(inflight)fail('SSH_BUSY');inflight=true;try{const r=await inspect(b);if(digest(await readBinding())!==digest(b))fail('SSH_BINDING_CONFLICT');return r;}finally{inflight=false;}
 }
 async function preview(args){
  if(!exact(args,['expectedRevision'])||!revision(args.expectedRevision))fail('SSH_ARGUMENTS');
  const b=await readBinding();if(!b||b.revision!==args.expectedRevision)fail('SSH_BINDING_CONFLICT');if(inflight)fail('SSH_BUSY');inflight=true;
  try{
   const snapshot=await inspect(b),conflicts=[];if(digest(await readBinding())!==digest(b))fail('SSH_BINDING_CONFLICT');
   if(snapshot.state!=='observed')conflicts.push(snapshot.state);
   else{
    if(snapshot.rootExists)conflicts.push(snapshot.owner?.matches?'owned_installation_requires_recovery':'existing_unowned_root');
    if(!snapshot.writable)conflicts.push('remote_parent_not_writable');
    if(!snapshot.tools.npm||Number(snapshot.node.version.split('.')[0])<22)conflicts.push('runtime_bootstrap_required');
    if(!['x64','arm64'].includes(snapshot.arch))conflicts.push('unsupported_runtime_architecture');
    if(snapshot.freeBytes===null||snapshot.freeBytes<2147483648)conflicts.push('insufficient_or_unknown_disk');
   }
   const compatibility=JSON.parse(await fs.readFile(new URL('./compatibility.json',import.meta.url),'utf8')),pkg=await cloudPackage(runtime.source);
   const steps=['创建专用安装目录及归属账本','安装固定版本官方 DSH 与依赖','安装自有插件和独立 profile','保护性创建或追加全局规则与 Skill','启动仅 loopback 可访问的独立 Host','核验真实路径、能力与持久回执'];
   const plan={owner:OWNER,schema:1,id:randomUUID(),createdAt:now(),expiresAt:now()+300000,bindingRevision:b.revision,bindingFingerprint:digest(b),snapshot,hostVersion:compatibility.hostBaseline,pluginVersion:compatibility.version,sourceManifestHash:pkg.manifestHash,sourceFiles:pkg.manifest.length,sourceBytes:pkg.bytes,canStage:preparationAvailable()&&!conflicts.length,preparationOnly:true,steps,conflicts,canApply:false,executor:'pending_implementation',modelEnabled:false,imEnabled:false,repositoryWrites:false};
   plan.fingerprint=digest(plan);const c=credentials();await c.modifyRecord(PLAN,old=>{
    if(old){const p=old.payload;if(old.kind!=='grant'||!p||p.owner!==OWNER||p.schema!==1||!uuid(p.id)||p.canApply!==false||p.executor!=='pending_implementation')fail('CLOUD_PLAN_REVIEW');const {fingerprint,...body}=p;if(digest(body)!==fingerprint)fail('CLOUD_PLAN_REVIEW');}
    return {kind:'grant',payload:plan};
   });
   return plan;
  }finally{inflight=false;}
 }
 return {available,preparationAvailable,runtimeAvailable,nodeBootstrap,newTarget,status,scan,trust,probe,preview,stage:operations.stage,operationStatus:operations.status,rollback:operations.rollback,retire:operations.retire,runtimeAction:operations.runtimeAction,versionAction:operations.versionAction,hostRequest:operations.hostRequest};
}
