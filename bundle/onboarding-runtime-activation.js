// A manual, point-in-time observation, not a restart authority or a live monitor.
// Loaded only from the original archive. Repair publication and activation stay separate.
import {observeRuntimeHost} from './onboarding-host-stop-observation.js';
export function createRuntimeActivation(api,q,j,{repair,inventory,source,compat,versionContext,versionSubject}){
 const {fs,path,hash,fail,regular,verified,signed,atomicJSON,runtimeRecord,runtimeAlive}=api;
 const normal=!!versionSubject;
 const file=path.join(q.root,'.control/runtime',normal?'plugin-release-activation.json':versionContext?'plugin-version-activation.json':'plugin-activation.json'),schema=normal?3:versionContext?2:1;
 const exact=(v,k)=>v&&Object.keys(v).sort().join()===k.slice().sort().join();
 const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
 const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
 const version=v=>typeof v==='string'&&v.length<100&&/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(v);
 if(versionContext&&(!exact(versionContext,['version','imageHash','transactionId','artifactsReady'])||!version(versionContext.version)||!hex(versionContext.imageHash)||!uuid(versionContext.transactionId)||typeof versionContext.artifactsReady!=='function'))fail('RUNTIME_ACTIVATION_CONTRACT_REVIEW');
 if(normal&&(!versionContext||repair||!exact(versionSubject,['state','historyHash','stillCurrent'])||!['committed','rolled_back'].includes(versionSubject.state)||!hex(versionSubject.historyHash)||typeof versionSubject.stillCurrent!=='function'))fail('RUNTIME_ACTIVATION_CONTRACT_REVIEW');
 const scope=normal?'maintained_plugin_version_observed':'same_version_repaired_plugin_observed';
 const subjectFields=normal?['transactionState','historyHash']:['repairId','fingerprint','repairUpdatedAt'];
 async function read(){
  const f=await regular(file,1048576);if(!f)return [];
  if(f.identity.uid!==process.getuid()||f.identity.mode!==0o600)fail('RUNTIME_ACTIVATION_LEDGER_REVIEW');
  const d=verified(JSON.parse(f.data),q.proof);
  if(!exact(d,['schema','operationId','runtimeId','records'])||d.schema!==schema||d.operationId!==q.operationId||d.runtimeId!==j.id||!Array.isArray(d.records)||d.records.length>128)fail('RUNTIME_ACTIVATION_LEDGER_REVIEW');
  for(const r of d.records)if(!exact(r,[...subjectFields,'restartId','nativeNonce','hostHash','sourceHash','observedAt','installationId',...(versionContext?['pluginVersion','versionTransactionId','imageHash']:[])])||![r.restartId,r.nativeNonce,r.installationId].every(uuid)||![r.hostHash,r.sourceHash].every(hex)||!Number.isSafeInteger(r.observedAt)||r.observedAt<=0||(normal?(!['committed','rolled_back'].includes(r.transactionState)||!hex(r.historyHash)):(!uuid(r.repairId)||!hex(r.fingerprint)||!Number.isSafeInteger(r.repairUpdatedAt)||r.observedAt<r.repairUpdatedAt))||versionContext&&(!version(r.pluginVersion)||!uuid(r.versionTransactionId)||!hex(r.imageHash)))fail('RUNTIME_ACTIVATION_LEDGER_REVIEW');
  return d.records;
 }
 function view(r,fresh=false){
  const sameRelease=!versionContext||!!r&&r.pluginVersion===versionContext.version&&r.versionTransactionId===versionContext.transactionId&&r.imageHash===versionContext.imageHash&&(!normal||r.historyHash===versionSubject.historyHash&&r.transactionState===versionSubject.state);
  return {contract:1,scope,activationVerified:fresh,cached:!fresh,liveStateVerified:false,observedAt:r?.observedAt??null,restartId:r?.restartId??null,sameRecordedHost:!!r&&r.hostHash===hash(j.host??null)&&r.nativeNonce===j.nativeNonce,automaticRestart:false,
   ...(normal?{versionMaintenance:true,transactionState:r?.transactionState??null}:{repairId:r?.repairId??null,sameRecordedRepair:sameRelease&&!!r&&r.repairId===repair?.id&&r.fingerprint===repair.fingerprint&&r.repairUpdatedAt===repair.updatedAt,versionUpgrade:false}),
   ...(versionContext?{pluginVersion:r?.pluginVersion??null,versionTransactionId:r?.versionTransactionId??null,sameRecordedRelease:sameRelease}:{})};
 }
 async function unchanged(){
  const current=await runtimeRecord(q);
  if(!current||hash(current)!==hash(j)||!await runtimeAlive(j.host)||normal&&!await versionSubject.stillCurrent())fail('RUNTIME_ACTIVATION_HOST_CHANGED');
 }
 async function ownFiles(){
  await api.checkAncestors(path.join(q.root,'runtime/plugin'));
  const items=inventory.filter(x=>x.path==='runtime/plugin'||x.path.startsWith('runtime/plugin/'));
  if(!items.some(x=>x.path==='runtime/plugin'&&x.kind==='directory'))fail('RUNTIME_ACTIVATION_OWNERSHIP_REVIEW');
  for(const x of items){
   const p=path.join(q.root,x.path),s=await fs.lstat(p);
   if(s.isSymbolicLink()||s.dev!==x.dev||s.ino!==x.ino||s.uid!==x.uid||(s.mode&0o777)!==x.mode)fail('RUNTIME_ACTIVATION_OWNERSHIP_REVIEW');
   if(x.kind==='directory'){
    if(!s.isDirectory())fail('RUNTIME_ACTIVATION_OWNERSHIP_REVIEW');
    const expected=items.filter(y=>path.posix.dirname(y.path)===x.path).map(y=>path.posix.basename(y.path)).sort();
    if(hash((await fs.readdir(p)).sort())!==hash(expected))fail('RUNTIME_ACTIVATION_OWNERSHIP_REVIEW');
   }else{
    const f=await regular(p);if(!f||f.sha256!==x.sha256||f.data.length!==x.bytes||f.identity.dev!==x.dev||f.identity.ino!==x.ino)fail('RUNTIME_ACTIVATION_OWNERSHIP_REVIEW');
   }
  }
 }
 function admission(){
  const r=j.restart,n=j.nativeReceipt,rows=n?.rows;
  if((normal?!['committed','rolled_back'].includes(versionSubject.state):!repair||repair.state!=='committed')||!uuid(r?.id)||r.state!=='ready'||r.nativeResumeAcknowledged!==true||r.consentContract!==1||!Number.isSafeInteger(r.createdAt)||!normal&&r.createdAt<repair.updatedAt||!Number.isSafeInteger(r.completedAt)||r.completedAt<r.createdAt||hash(r.host??null)!==hash(j.host??null)||r.nonce!==j.nativeNonce||j.state!=='host_ready'||n?.ok!==true||n.pid!==j.host?.pid||n.nonce!==j.nativeNonce||n.hostVersion!==compat.hostBaseline||n.modelAttempts!==0||n.modelAttemptScope!=='inspection_agents_only')fail('RUNTIME_ACTIVATION_RESTART_REQUIRED');
  if(!Array.isArray(rows)||rows.length!==4||new Set(rows.map(x=>x.preset)).size!==4)fail('RUNTIME_ACTIVATION_ADMISSION_REVIEW');
  if(versionContext&&n.pluginVersion!==versionContext.version)fail('RUNTIME_ACTIVATION_VERSION_REVIEW');
  for(const preset of ['standard','ptc','cordis','minimal']){
   const row=rows.find(x=>x.preset===preset);
   if(!row||row.valid!==true||row.catalogComplete!==true||row.idle!==true||(preset==='minimal'?row.globalSkillCount!==0||row.globalRuleLoaded!==false:row.globalSkillPathsVerified!==true||row.globalRuleLoaded!==true||row.skillBodyLoaded!==true||row.globalSkillCount!==compat.globalSkills.length))fail('RUNTIME_ACTIVATION_ADMISSION_REVIEW');
  }
 }
 async function verify(id){
  if(id!==(normal?versionContext.transactionId:repair?.id))fail(normal?'RUNTIME_ACTIVATION_VERSION_CHANGED':'RUNTIME_ACTIVATION_REPAIR_CHANGED');
  const records=await read();admission();await unchanged();
  for(const p of [j.worker,j.child,j.restart.launcher])if(await runtimeAlive(p))fail('RUNTIME_ACTIVATION_LAUNCH_PENDING');
  await ownFiles();
  if(versionContext&&!await versionContext.artifactsReady())fail('RUNTIME_ACTIVATION_ARTIFACTS_REVIEW');
  const observation=await observeRuntimeHost(api,q,j,{installation:true,versionIdentity:!!versionContext}),installed=observation.installation;
  if(versionContext&&observation.pluginVersion!==versionContext.version)fail('RUNTIME_ACTIVATION_VERSION_REVIEW');
  const expected=[path.join(q.root,'runtime/native-home/dsh/AGENTS.md'),...compat.globalSkills.map(n=>path.join(q.root,'runtime/native-home/dsh/skills',n,'SKILL.md'))].sort();
  const legacy=installed?.state==='committed'&&installed.canRecover===false&&uuid(installed.id)&&!installed.review?.length;
  const maintained=!!versionContext&&installed?.state==='inspected'&&installed.contract===2&&installed.action==='inspect'&&installed.planReady===true&&installed.canApply===false&&installed.installedVersion===versionContext.version&&installed.targetVersion===versionContext.version&&uuid(installed.installationId)&&Array.isArray(installed.conflicts)&&!installed.conflicts.length&&Array.isArray(installed.changes)&&!installed.changes.length&&installed.lastReceipt?.id===installed.installationId&&installed.lastReceipt?.state==='committed'&&installed.lastReceipt?.canRecover===false&&!installed.lastReceipt?.review?.length&&installed.lastReceipt?.version===versionContext.version&&installed.files?.every(x=>x.state==='unchanged');
  if(!(legacy||maintained)||!Array.isArray(installed.files)||hash(installed.files.map(x=>x.path).sort())!==hash(expected))fail('RUNTIME_ACTIVATION_INSTALLATION_REVIEW');
  await ownFiles();await unchanged();
  if(versionContext&&!await versionContext.artifactsReady())fail('RUNTIME_ACTIVATION_ARTIFACTS_REVIEW');
  const receipt={...(normal?{transactionState:versionSubject.state,historyHash:versionSubject.historyHash}:{repairId:repair.id,fingerprint:repair.fingerprint,repairUpdatedAt:repair.updatedAt}),restartId:j.restart.id,nativeNonce:j.nativeNonce,hostHash:hash(j.host),sourceHash:hash(source.owner.manifest),observedAt:Date.now(),installationId:legacy?installed.id:installed.installationId,...(versionContext?{pluginVersion:versionContext.version,versionTransactionId:versionContext.transactionId,imageHash:versionContext.imageHash}:{})};
  // Repeated checks of the same binding replace its latest diagnostic observation,
  // never a repair/approval record. Different bindings retain their history.
  const last=records.at(-1),same=last&&Object.keys(receipt).filter(k=>k!=='observedAt').every(k=>receipt[k]===last[k]);
  if(same)records[records.length-1]=receipt;else{if(records.length>=128)fail('RUNTIME_ACTIVATION_HISTORY_LIMIT');records.push(receipt);}
  await atomicJSON(file,signed({schema,operationId:q.operationId,runtimeId:j.id,records},q.proof));
  return view(receipt,true);
 }
 return {verify,status:async()=>view((await read()).at(-1))};
}
