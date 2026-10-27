import {createExistingSetup} from './onboarding-existing-setup.js';
import {createExistingHostInspection} from './onboarding-existing-host.js';
import {createOnboardingNotificationDefaults} from './onboarding-notification-defaults.js';
import {createOnboardingSelfStop} from './onboarding-self-stop.js';
import {createOnboardingSelfRemove} from './onboarding-self-remove.js';
import {createOnboardingSelfDisable} from './onboarding-self-disable.js';
import {createOnboardingSelfMaintenance} from './onboarding-self-maintenance.js';
import {VERSION} from './link-contract.js';
import {createOnboardingImMaintenance} from './onboarding-im-maintenance.js';
import {nativeImMaintenanceTransport} from './onboarding-im-maintenance-native.js';
import {createOnboardingActivity} from './onboarding-activity.js';
import {inject as executionDependencies} from './index.js';
import {createOnboardingCoordinatedHold} from './onboarding-coordinated-hold.js';
import {createOnboardingMaintenanceRecord} from './onboarding-maintenance-record.js';
import {createOnboardingAgentHold} from './onboarding-agent-hold.js';
import {createOnboardingCloudFileReview} from './onboarding-cloud-file-review.js';
import {createOnboardingLocalPair} from './onboarding-local-pair.js';
import {nativeLocalPairAdapter} from './onboarding-local-pair-native.js';
import {createOnboardingRepository,createOnboardingCloudRepository} from './onboarding-repository.js';
import {createOnboardingRepositories} from './onboarding-repositories.js';
import {createOnboardingCloudFiles} from './onboarding-cloud-files.js';
import {createOnboardingCloudTaskRuntime} from './onboarding-cloud-task-runtime.js';
import {createOnboardingCloudRepositories} from './onboarding-cloud-repositories.js';
import {createOnboardingCloudWeb} from './onboarding-cloud-web.js';
import {homedir} from 'node:os';
import {lstat,access,readFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {resolveOnboardingPaths,inspectRuleFile,inspectSkillRoot} from './onboarding-paths.js';
import {validateDraft} from './onboarding-schema.js';
import {workbenchAppearance} from './workbench-host.js';
import {createOnboardingInstaller} from './onboarding-installer.js';
import {createOnboardingMaintenance} from './onboarding-maintenance.js';
import {createOnboardingState} from './onboarding-state.js';
import {createOnboardingCloud} from './onboarding-cloud.js';
import {createOnboardingModels} from './onboarding-models.js';
import {createOnboardingTokenPlanModels} from './onboarding-token-plan.js';
import {onboardingIdentity} from './onboarding-identity.js';
import {createOnboardingCloudModels} from './onboarding-cloud-models.js';
import {createOnboardingHandoff} from './onboarding-handoff.js';
import {createOnboardingCloudIm} from './onboarding-cloud-im.js';
import {createOnboardingIm} from './onboarding-im.js';
const endpoint='task-onboarding/control';
const object=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
const empty=a=>object(a)&&Object.keys(a).length===0;
async function executablePresent(name,env,platform){
 // No spawn, no --version, no npm/SSH/Git calls. Presence is not operational readiness.
 const dirs=(env.PATH??'').split(path.delimiter).filter(x=>path.isAbsolute(x)).slice(0,64);
 for(const dir of dirs)for(const ext of platform==='win32'?['.exe','.cmd','.bat']:[''])try{const file=path.join(dir,name+ext),s=await lstat(file);if(s.isSymbolicLink())continue;if(s.isFile()){await access(file,platform==='win32'?constants.F_OK:constants.X_OK);return {state:'present_unexecuted'};}}catch{}
 return {state:'not_observed'};
}
export function createOnboardingService(ctx,config={},runtime={}){
 const platform=runtime.platform??process.platform,env=runtime.env??process.env,home=runtime.home??homedir(),now=runtime.now??Date.now;
 const activity=runtime.activity??createOnboardingActivity({now});
 let pending;
 const configured=config.onboarding?.paths??{},identity=onboardingIdentity(config);
 const installer=createOnboardingInstaller(config,runtime);
 const maintenance=createOnboardingMaintenance(config,runtime);
 const selfMaintenance=createOnboardingSelfMaintenance({manager:()=>runtime.pluginManager,entryId:runtime.ownEntryId,now});
 const state=createOnboardingState(ctx,config,runtime);
 const cloud=createOnboardingCloud(ctx,config,runtime);
 const repository=createOnboardingRepository({state,config,runtime,now});
 const repositories=createOnboardingRepositories({state,credentials:()=>runtime.credentials??ctx.credentials,repository,config,runtime,now});
 const cloudRepositories=createOnboardingCloudRepositories({state,credentials:()=>runtime.credentials??ctx.credentials,remote:cloud.hostRequest,enabled:cloud.runtimeAvailable,now});
 const localPair=createOnboardingLocalPair({state,credentials:()=>runtime.credentials??ctx.credentials,remote:cloud.hostRequest,enabled:()=>identity.role!=='cloud'&&!config.role&&!config.stateDir&&!config.tokenFile&&cloud.runtimeAvailable(),adapter:runtime.localPairAdapter??(ctx.plugin?nativeLocalPairAdapter(ctx,config,runtime,{openWorkbench:(args,proof,target,browserHost)=>cloudWeb.openWorkbench({args,proof,target,browserHost}),closeWorkbench:entryId=>cloudWeb.close({entryId})}):null),now});
 const coordinated=createOnboardingCoordinatedHold({now,components:()=>({onboarding:activity,gateway:runtime.gateway?.maintenance,agents:runtime.agentHold,gatewayExpected:!!(config.role||config.stateDir||config.tokenFile||localPair.configured||runtime.taskRuntime?.configured),imPresent:!!runtime.im})});
 const maintenanceRecord=createOnboardingMaintenanceRecord({coordinated,activity,credentials:()=>runtime.credentials??ctx.credentials,enabled:state.available,now});
 const selfDisable=createOnboardingSelfDisable({inspection:selfMaintenance,manager:()=>runtime.pluginManager,credentials:()=>runtime.credentials??ctx.credentials,maintenance:maintenanceRecord,enabled:state.available,now});
 const selfRemove=createOnboardingSelfRemove({inspection:selfMaintenance,manager:()=>runtime.pluginManager,credentials:()=>runtime.credentials??ctx.credentials,maintenance:maintenanceRecord,enabled:state.available,now});
 const cloudFileReview=createOnboardingCloudFileReview({state,credentials:()=>runtime.credentials??ctx.credentials,remote:cloud.hostRequest,enabled:()=>identity.role!=='cloud'&&cloud.runtimeAvailable(),now});
 const cloudFiles=createOnboardingCloudFiles({state,credentials:()=>runtime.credentials??ctx.credentials,remote:cloud.hostRequest,enabled:()=>identity.role!=='cloud'&&cloud.runtimeAvailable(),now});
 const cloudTaskRuntime=createOnboardingCloudTaskRuntime({state,credentials:()=>runtime.credentials??ctx.credentials,remote:cloud.hostRequest,enabled:cloud.runtimeAvailable,now});
 const cloudRepository=createOnboardingCloudRepository({remote:cloud.hostRequest,enabled:cloud.runtimeAvailable,now});
 const giteeHandoff=createOnboardingHandoff({state,credentials:()=>runtime.credentials??ctx.credentials,remote:cloud.hostRequest,enabled:cloud.runtimeAvailable,now,service:'gitee'});
 const im=createOnboardingIm(config,runtime);
 const existing=createExistingHostInspection({gateway:()=>runtime.gateway,detect,installer,im,now});
 const notificationDefaults=createOnboardingNotificationDefaults({state,credentials:()=>runtime.credentials??ctx.credentials,im:()=>runtime.im,gateway:()=>runtime.gateway,role:identity.role,remote:cloud.hostRequest,remoteEnabled:cloud.runtimeAvailable,now});
 const existingSetup=createExistingSetup({gateway:()=>runtime.gateway,inspection:existing,state,credentials:()=>runtime.credentials??ctx.credentials,notifications:notificationDefaults,now});
 const imMaintenance=createOnboardingImMaintenance({credentials:()=>runtime.credentials??ctx.credentials,im:()=>runtime.im,enabled:state.available,now});
 const selfStop=createOnboardingSelfStop({inspection:selfMaintenance,credentials:()=>runtime.credentials??ctx.credentials,maintenance:maintenanceRecord,appExit:()=>runtime.appExit,peers:()=>Promise.all([selfDisable.status({}),selfRemove.status({}),imMaintenance.status({})]),enabled:state.available,now});
 const admit=label=>{const leave=activity.enter(label);try{const exit=runtime.gateway?.maintenance?.enter(label);return ()=>{try{exit?.();}finally{leave();}};}catch(e){leave();throw e;}};
 const cloudWeb=createOnboardingCloudWeb({remote:cloud.hostRequest,enabled:cloud.runtimeAvailable,now,admit});
 const cloudIm=createOnboardingCloudIm({remote:cloud.hostRequest,enabled:cloud.runtimeAvailable,now});
 const handoff=createOnboardingHandoff({state,credentials:()=>runtime.credentials??ctx.credentials,remote:cloud.hostRequest,enabled:cloud.runtimeAvailable,now});
 const cloudModels=createOnboardingCloudModels({remote:cloud.hostRequest,enabled:cloud.runtimeAvailable,now});
 const tokenHandoff=createOnboardingHandoff({state,credentials:()=>runtime.credentials??ctx.credentials,remote:cloud.hostRequest,enabled:cloud.runtimeAvailable,now,service:'token-plan'});
 const cloudTokenModels=createOnboardingCloudModels({remote:cloud.hostRequest,enabled:cloud.runtimeAvailable,now,service:'token-plan'});
 async function detect(){
  if(pending)return pending;
  pending=(async()=>{
   const paths=resolveOnboardingPaths({platform,home,env,configured}),compat=JSON.parse(await readFile(new URL('./compatibility.json',import.meta.url),'utf8'));
   const rules=await Promise.all(paths.globalCandidates.map(inspectRuleFile));
   const skills=await Promise.all(paths.skillCandidates.map(p=>inspectSkillRoot(p,compat.globalSkills)));
   const commands=Object.fromEntries(await Promise.all(['ssh','git','aliyun'].map(async n=>[n,await executablePresent(n,env,platform)])));
   const observed=now();return {contract:1,id:randomUUID(),observedAt:observed,expiresAt:observed+60000,role:identity.role,identity,accountSource:'current_host_process',platform,nodeVersion:process.versions.node,paths,rules,skills,commands,cloud:{state:'not_probed',serviceAccount:'unknown'},checks:{networkRequests:0,modelRequests:0,writes:0,commandsExecuted:0},readyForInstallation:false};
  })();try{return await pending;}finally{pending=null;}
 }
 async function dispatch(method,args,context={}){
  if(/^existing_setup_(model|repository|notifications|status|preview|apply|fence)$/.test(method))return existingSetup[method.slice(15)](args);
  if(method==='existing_pair_inspect')return existing.inspectPair(args);
  if(/^self_stop_(status|preview|apply|reconcilePreview|reconcileApply)$/.test(method))return selfStop[method.slice(10)](args);
  if(method==='self_maintenance_status')return selfMaintenance.status(args);
  if(/^self_disable_(status|preview|apply|reconcilePreview|reconcileApply)$/.test(method))return selfDisable[method.slice(13)](args);
  if(/^self_remove_(status|preview|apply|reconcilePreview|reconcileApply)$/.test(method))return selfRemove[method.slice(12)](args);
  if(/^im_maintenance_(status|preview|apply|reconcilePreview|reconcileApply)$/.test(method))return imMaintenance[method.slice(15)](args,context.imTransport);
  if(['maintenance_record_status','maintenance_record_preview','maintenance_record_apply','maintenance_record_releasePreview','maintenance_record_releaseApply','maintenance_record_recoveryPreview','maintenance_record_recover','maintenance_record_retirementPreview','maintenance_record_retirementApply','maintenance_record_resumePreview','maintenance_record_resumeApply'].includes(method))return maintenanceRecord[method.slice(19)](args);
  if(/^(coordinated|onboarding|gateway|agent)_hold_(status|preview|apply|release)$/.test(method)){
   const [part,,action]=method.split('_'),target={coordinated,onboarding:activity,gateway:runtime.gateway?.maintenance,agent:runtime.agentHold}[part];
   if(!target)throw Error(part==='gateway'?'ONBOARDING_GATEWAY_HOLD_UNAVAILABLE':'ONBOARDING_AGENT_HOLD_UNAVAILABLE');
   if(action==='status')return target.status(args);
   return maintenanceRecord.componentMutation(()=>{if(part!=='coordinated')coordinated.assertIndividualOpen();return target[action](args);});
  }
  if(['cloud_file_transfer_queueList','cloud_file_transfer_queueReviewPreview','cloud_file_transfer_queueReviewApply','cloud_file_transfer_queueReviewStatus','cloud_file_transfer_queueReviewClose','cloud_file_transfer_queueReviewClosePreview'].includes(method))return cloudFileReview[method.slice(20)](args);
  if(['cloud_file_transfer_status','cloud_file_transfer_preview','cloud_file_transfer_apply','cloud_file_transfer_recoveryPreview','cloud_file_transfer_recoveryApply','cloud_file_transfer_migrationPreview','cloud_file_transfer_migrationRecover'].includes(method))return cloudFiles[method.slice(20)](args);
  if(['file_transfer_status','file_transfer_preview','file_transfer_apply','file_transfer_fence','file_transfer_migrationPreview','file_transfer_migrationRecover','file_transfer_queueList','file_transfer_queueReviewPreview','file_transfer_queueReviewApply','file_transfer_queueReviewStatus','file_transfer_queueReviewClose'].includes(method)){
   const files=identity.role==='cloud'?runtime.taskRuntime?.files:localPair.files;
   if(!files){if(method==='file_transfer_status'&&empty(args))return {contract:2,available:false,state:'runtime_required',executionAuthorized:false,repositoryWriteAuthorized:false};throw Error('ONBOARDING_FILES_RUNTIME_REQUIRED');}
   return files[method.slice(14)](args);
  }
  if(['model_probe_status','model_probe_preview','model_probe_apply','model_probe_start','token_model_probe_status','token_model_probe_preview','token_model_probe_apply','token_model_probe_start'].includes(method)){
   const models=method.startsWith('token_')?runtime.tokenModels:runtime.models;
   if(!models?.probe)throw Error('ONBOARDING_MODEL_PROBE_UNAVAILABLE');
   return models.probe[method.slice(method.lastIndexOf('_')+1)](args);
  }
  if(['cloud_model_probe_status','cloud_model_probe_preview','cloud_model_probe_start','cloud_token_model_probe_status','cloud_token_model_probe_preview','cloud_token_model_probe_start'].includes(method)){const models=method.startsWith('cloud_token_')?cloudTokenModels:cloudModels;return models.probe[method.slice(method.lastIndexOf('_')+1)](args);}
  if(['local_pair_status','local_pair_preview','local_pair_apply','local_pair_recoveryPreview','local_pair_recoveryApply'].includes(method))return localPair[method.slice(11)](args);
  if(['task_pair_status','task_pair_preview','task_pair_apply','task_pair_fence','task_pair_forward'].includes(method)){if(!runtime.taskRuntime?.pairing)throw Error('ONBOARDING_TASK_RUNTIME_PAIR_UNAVAILABLE');return runtime.taskRuntime.pairing[method.slice(10)](args);}
  if(['cloud_task_runtime_status','cloud_task_runtime_preview','cloud_task_runtime_apply','cloud_task_runtime_recoveryPreview','cloud_task_runtime_recoveryApply'].includes(method))return cloudTaskRuntime[method.slice(19)](args);
  if(['task_runtime_status','task_runtime_preview','task_runtime_apply','task_runtime_fence'].includes(method)){if(!runtime.taskRuntime)throw Error('ONBOARDING_TASK_RUNTIME_UNAVAILABLE');return runtime.taskRuntime[method.slice(13)](args);}
  if(['repository_registry_status','repository_registry_preview','repository_registry_apply','repository_registry_fence'].includes(method)){const value=await repositories[method.slice(20)](args);if(method!=='repository_registry_preview'&&runtime.taskRuntime)value.runtimeConfigured=(await runtime.taskRuntime.status({})).configured;return value;}
  if(['cloud_repository_registry_status','cloud_repository_registry_preview','cloud_repository_registry_apply','cloud_repository_registry_recoveryPreview','cloud_repository_registry_recoveryApply'].includes(method))return cloudRepositories[method.slice(26)](args);
  if(method==='repository_inspect')return repository.inspect(args);
  if(method==='cloud_repository_inspect')return cloudRepository.inspect(args);
  if(['gitee_handoff_status','gitee_handoff_preview','gitee_handoff_apply','gitee_handoff_recoveryPreview','gitee_handoff_recoveryApply'].includes(method))return giteeHandoff[method.slice(14)](args);
  if(method==='cloud_web_open')return cloudWeb.open(args);
  if(method==='cloud_web_close')return cloudWeb.close(args);
  if(method==='cloud_web_status')return cloudWeb.status(args);
  if(method==='cloud_im_inventory')return cloudIm.inventory(args);
  if(method==='im_inventory')return im.inventory(args);
  if(method==='notification_defaults_discover')return notificationDefaults.scan(args);
  if(method==='notification_defaults_candidate')return notificationDefaults.candidate(args);
  if(/^notification_defaults_(status|preview|apply|sync)$/.test(method))return notificationDefaults[method.slice(22)](args);
  if(['cloud_token_model_status','cloud_token_model_preview','cloud_token_model_apply','cloud_token_model_resolve'].includes(method))return cloudTokenModels[method.slice(18)](args);
  if(['token_handoff_status','token_handoff_preview','token_handoff_apply','token_handoff_recoveryPreview','token_handoff_recoveryApply'].includes(method))return tokenHandoff[method.slice(14)](args);
  if(['cloud_model_status','cloud_model_preview','cloud_model_apply','cloud_model_resolve'].includes(method))return cloudModels[method.slice(12)](args);
  if(['handoff_status','handoff_preview','handoff_apply','handoff_recoveryPreview','handoff_recoveryApply'].includes(method))return handoff[method.slice(8)](args);
  if(['ssh_status','ssh_scan','ssh_trust','cloud_probe','cloud_preview','cloud_stage','cloud_operation_status','cloud_rollback','cloud_retire','cloud_new_target','cloud_runtime','cloud_version','node_preview','node_start','node_status','node_action'].includes(method)){
   if(!cloud.available())throw Error('ONBOARDING_CLOUD_DISABLED');
   if(method.startsWith('node_'))return cloud.nodeBootstrap[method.slice(5)](args);
   if(method==='ssh_status'){if(!empty(args))throw Error('ONBOARDING_INVALID_ARGUMENTS');return cloud.status();}
   if(method==='ssh_scan')return cloud.scan(args);
   if(method==='ssh_trust')return cloud.trust(args);
   if(method==='cloud_probe')return cloud.probe(args);
   if(method==='cloud_stage')return cloud.stage(args);
   if(method==='cloud_runtime')return cloud.runtimeAction(args);
   if(method==='cloud_version')return cloud.versionAction(args);
   if(method==='cloud_operation_status')return cloud.operationStatus(args);
   if(method==='cloud_rollback')return cloud.rollback(args);
   if(method==='cloud_retire')return cloud.retire(args);
   if(method==='cloud_new_target')return cloud.newTarget(args);
   return cloud.preview(args);
  }
  if(['draft_load','draft_save','secret_status','secret_put','secret_remove','secret_receipt','secret_fence'].includes(method)){
   if(!state.available())throw Error('ONBOARDING_PERSISTENCE_DISABLED');
   if(!object(args))throw Error('ONBOARDING_INVALID_ARGUMENTS');
   if(method==='draft_save')return state.save(args);
   if(method==='secret_put')return state.put(args);
   if(method==='secret_remove')return state.remove(args);
   if(method==='secret_fence')return state.fence(args);
   if(method==='secret_receipt')return state.secretReceipt(args);
   if(!empty(args))throw Error('ONBOARDING_INVALID_ARGUMENTS');
   return method==='draft_load'?state.load():state.secrets();
  }
  if(['model_status','model_preview','model_apply','model_resolve','token_model_status','token_model_preview','token_model_apply','token_model_resolve'].includes(method)){
   const models=method.startsWith('token_')?runtime.tokenModels:runtime.models;
   if(!models)throw Error('ONBOARDING_MODEL_UNAVAILABLE');
   const action=method.slice(method.lastIndexOf('_')+1);
   if(action==='status'){if(!empty(args))throw Error('ONBOARDING_INVALID_ARGUMENTS');return models.status();}
   return models[action](args);
  }
  if(['maintenance_preview','maintenance_status','maintenance_apply','maintenance_recoveryPreview','maintenance_recover'].includes(method)){
   if(!maintenance.available())throw Error('ONBOARDING_INSTALL_DISABLED');
   if(!object(args))throw Error('ONBOARDING_INVALID_ARGUMENTS');
   return maintenance[method.slice(12)](args);
  }
  if(['install_preview','install_status','install_apply','install_recover'].includes(method)){
   if(!installer.available())throw Error('ONBOARDING_INSTALL_DISABLED');
   if(!object(args))throw Error('ONBOARDING_INVALID_ARGUMENTS');
   if(method==='install_preview')return installer.preview(args);
   if(method==='install_status'){if(!empty(args))throw Error('ONBOARDING_INVALID_ARGUMENTS');return installer.status();}
   if(method==='install_apply')return installer.apply(args);
   return installer.recover(args);
  }
  if(method==='validate'){if(!object(args)||Object.keys(args).join()!=='draft')throw Error('ONBOARDING_INVALID_ARGUMENTS');return validateDraft(args.draft);}
  if(!empty(args))throw Error('ONBOARDING_INVALID_ARGUMENTS');
  if(method==='describe')return {contract:1,pluginVersion:VERSION,pages:6,mode:state.available()?'host_setup_storage':installer.available()?'host_rules_install':'read_only',configured:localPair.configured||!!(config.role&&config.stateDir&&config.tokenFile)||(!!runtime.taskRuntime&&(await runtime.taskRuntime.status({})).configured===true),capabilities:{existingSetupContract:existingSetup.available()?1:0,existingPairInspectionContract:existing.available()?1:0,notificationDefaultsContract:notificationDefaults.available()?1:0,notificationDiscoveryContract:1,selfStopContract:selfStop.available()?1:0,selfStopQueryContract:state.available()?1:0,selfRemoveContract:selfRemove.available()?1:0,selfRemoveQueryContract:selfRemove.available()?1:0,selfDisableQueryContract:selfDisable.available()?1:0,selfDisableContract:selfDisable.available()?1:0,selfMaintenanceInspectionContract:1,imMaintenanceQueryContract:state.available()?1:0,imMaintenanceContract:state.available()&&typeof ctx.connection?.createSharedFetchHandler==='function'?1:0,maintenanceAdmissionContract:maintenanceRecord.available()?1:0,maintenanceRecordContract:maintenanceRecord.available()?2:0,maintenanceRecordQueryContract:maintenanceRecord.available()?1:0,coordinatedMaintenanceHoldContract:1,onboardingStartupRecoveryContract:1,onboardingMaintenanceHoldContract:1,gatewayMaintenanceHoldContract:runtime.gateway?.maintenance?1:0,agentMaintenanceHoldContract:runtime.agentHold?1:0,rulesMaintenancePreviewContract:maintenance.available()?2:0,rulesMaintenanceMutation:maintenance.available(),cloudFileQueueReviewContract:cloudFileReview.available()?1:0,managedFileQueueReviewContract:!config.role&&!config.stateDir&&!config.tokenFile?2:0,cloudFileScopeMigrationContract:cloudFiles.available()?1:0,managedFileScopeMigrationContract:!config.role&&!config.stateDir&&!config.tokenFile?1:0,cloudFileTransferContract:cloudFiles.available()?1:0,managedFileTransferContract:!config.role&&!config.stateDir&&!config.tokenFile?2:0,modelClarificationContract:runtime.models?.available()?1:0,tokenModelClarificationContract:runtime.tokenModels?.available()?1:0,modelProbeContract:runtime.models?.probe?.available()?2:0,tokenModelProbeContract:runtime.tokenModels?.probe?.available()?2:0,cloudModelProbe:cloudModels.available(),cloudTokenModelProbe:cloudTokenModels.available(),localPeerBinding:localPair.available(),managedTaskRuntimeContract:runtime.taskRuntime?.available()?4:0,managedPeerBindingContract:runtime.taskRuntime?.pairing?1:0,cloudTaskRuntime:cloudTaskRuntime.available(),repositoryRegistryContract:repositories.available()?2:0,cloudRepositoryRegistry:cloudRepositories.available(),repositoryCheckContract:1,cloudRepositoryCheck:cloudRepository.available(),giteeCredentialReceipt:state.available(),giteeCredentialFence:state.available(),cloudGiteeHandoff:giteeHandoff.available(),cloudWebEntry:cloudWeb.available(),optionalImInstallation:cloud.runtimeAvailable(),imInventoryContract:1,cloudImInventory:cloudIm.available(),imInventory:im.capability()==='available',localDetection:true,pathCandidates:true,fieldValidation:true,remoteDetection:cloud.available(),sourcePreparation:cloud.preparationAvailable(),nativeHostInstallation:cloud.runtimeAvailable(),nodeBootstrap:cloud.preparationAvailable(),draftPersistence:state.available(),credentialStorage:state.available(),cloudCredentialReceipt:state.available(),cloudCredentialFence:state.available(),tokenPlanCredentialReceipt:state.available(),tokenPlanCredentialFence:state.available(),cloudTokenPlanHandoff:tokenHandoff.available(),cloudTokenPlanBinding:cloudTokenModels.available(),cloudCredentialHandoff:handoff.available(),cloudModelBinding:cloudModels.available(),modelBinding:runtime.models?.available()===true,tokenPlanBinding:runtime.tokenModels?.available()===true,initialization:false,write:false,rulesInstall:installer.available()},consent:'per_action_explicit',notAuthorization:true};
  if(method==='detect')return detect();
  if(method==='appearance')return workbenchAppearance();
  throw Error('ONBOARDING_METHOD_DENIED');
 }
 return {inspectExistingHost:existing.inspectHost,syncNotificationDefaults:()=>notificationDefaults.available()?activity.run('notification_defaults_sync',()=>notificationDefaults.sync({})):null,initializeAdmission:maintenanceRecord.initializeAdmission,suspendAdmission:maintenanceRecord.suspendAdmission,start:async()=>activity.run('startup',()=>localPair.start()),scheduleStart:()=>activity.deferStartup('local_pair',()=>localPair.start()),suspend:localPair.suspend,async dispose(){existingSetup.dispose();existing.dispose();notificationDefaults.dispose();selfStop.dispose();selfRemove.dispose();selfDisable.dispose();imMaintenance.dispose();activity.close();maintenanceRecord.dispose();coordinated.dispose();await localPair.close();await cloudWeb.dispose();},async call(method,args,context={}){
  const stopGuarded=/^self_(disable|remove)_(preview|apply)$/.test(method)||/^im_maintenance_(preview|apply)$/.test(method)||/^maintenance_record_(preview|apply|releasePreview|releaseApply|resumePreview|resumeApply)$/.test(method)||/^(coordinated|onboarding|gateway|agent)_hold_(preview|apply|release)$/.test(method);
  if(stopGuarded&&state.available())await selfStop.assertNoPending();
  const exempt=/^self_stop_(status|preview|apply|reconcilePreview|reconcileApply)$/.test(method)||/^self_remove_(status|preview|apply|reconcilePreview|reconcileApply)$/.test(method)||/^self_disable_(status|preview|apply|reconcilePreview|reconcileApply)$/.test(method)||/^im_maintenance_(status|preview|apply|reconcilePreview|reconcileApply)$/.test(method)||method==='describe'||method==='self_maintenance_status'||['maintenance_record_status','maintenance_record_preview','maintenance_record_apply','maintenance_record_releasePreview','maintenance_record_releaseApply','maintenance_record_recoveryPreview','maintenance_record_recover','maintenance_record_retirementPreview','maintenance_record_retirementApply','maintenance_record_resumePreview','maintenance_record_resumeApply','coordinated_hold_status','coordinated_hold_preview','coordinated_hold_apply','coordinated_hold_release','onboarding_hold_status','onboarding_hold_preview','onboarding_hold_apply','onboarding_hold_release','gateway_hold_status','gateway_hold_preview','gateway_hold_apply','gateway_hold_release','agent_hold_status','agent_hold_preview','agent_hold_apply','agent_hold_release'].includes(method),gate=runtime.gateway?.maintenance;
  if(exempt)return dispatch(method,args,context);
  // Runtime lifecycle calls inspect/drain their own Gateway. Count them in the
  // onboarding barrier, not as work inside the very Gateway they must drain.
  // They still honor an existing hold; peer data frames remain counted below.
  const lifecycle=['task_runtime_preview','task_runtime_apply','task_runtime_fence','task_pair_preview','task_pair_apply','task_pair_fence'].includes(method);
  return activity.run('rpc',()=>{if(!gate)return dispatch(method,args,context);if(gate.blocked)throw Error('ONBOARDING_GATEWAY_HOLD_ACTIVE');return lifecycle?dispatch(method,args,context):gate.run('onboarding',()=>dispatch(method,args,context));});
 }};
}
export function installOnboarding(ctx,config={}){
 const ownEntryId=ctx.fiber?.entry?.id;
 ctx.inject(['connection'],sub=>{
  // Credentials are optional for read-only onboarding. Access must be made from
  // its injected public-service scope, not an unrelated connection-only scope.
  const activity=createOnboardingActivity({initialAdmission:'checking'});
  sub.provide?.('onboardingActivity',activity);
  let credentials,models,tokenModels,im,taskRuntime,agentHold,gateway,pluginManager,appExit;
  sub.inject?.(['appExit'],scope=>{const current=scope.appExit;appExit=current;scope.effect(()=>()=>{if(appExit===current)appExit=undefined;});});
  sub.inject?.(['pluginManager'],scope=>{const current=scope.pluginManager;pluginManager=current;scope.effect(()=>()=>{if(pluginManager===current)pluginManager=undefined;});});
  sub.inject?.(['taskGateway'],scope=>{const current=scope.taskGateway;gateway=current;scope.effect(()=>()=>{if(gateway===current)gateway=undefined;});});
  sub.inject?.(['agents'],scope=>{const own=createOnboardingAgentHold(scope);agentHold=own;scope.effect(()=>()=>{if(agentHold===own)agentHold=undefined;own.dispose();});});
  sub.inject?.(['onboardingTaskRuntime'],scope=>{const current=scope.onboardingTaskRuntime;taskRuntime=current;const cancel=activity.deferStartup('cloud_runtime',()=>current.start());scope.effect(()=>()=>{cancel();if(taskRuntime===current)taskRuntime=undefined;});});
  sub.inject?.(['dshIm'],scope=>{const current=scope.dshIm;im=current;scope.effect(()=>()=>{if(im===current)im=undefined;});});
  sub.inject?.(['llm','credentials'],scope=>{
   const own=createOnboardingModels(scope,config,{credentials:scope.credentials,llm:scope.llm,modelContext:scope,admit:label=>activity.enter(label)});
   models=own;const cancelModels=activity.deferStartup('models',()=>own.start());
   scope.effect(()=>()=>{cancelModels();if(models===own)models=undefined;});
   const tokenOwn=createOnboardingTokenPlanModels(scope,config,{credentials:scope.credentials,llm:scope.llm,modelContext:scope,admit:label=>activity.enter(label)});
   tokenModels=tokenOwn;const cancelToken=activity.deferStartup('token_models',()=>tokenOwn.start());
   scope.effect(()=>()=>{cancelToken();if(tokenModels===tokenOwn)tokenModels=undefined;});
  });
  const service=createOnboardingService(sub,config,{activity,ownEntryId,get appExit(){return appExit;},get pluginManager(){return pluginManager;},get gateway(){return gateway;},get agentHold(){return agentHold;},get taskRuntime(){return taskRuntime;},get repositoryRuntime(){return taskRuntime?.configured===true;},get im(){return im;},get credentials(){return credentials;},get models(){return models;},get tokenModels(){return tokenModels;}});
  sub.inject?.(['taskGateway'],scope=>{const current=scope.taskGateway;if(current.onboardingInspection)return;const read=service.inspectExistingHost;current.onboardingInspection=read;scope.effect(()=>()=>{if(current.onboardingInspection===read)current.onboardingInspection=null;});});
  sub.inject?.(['taskGateway'],scope=>{const current=scope.taskGateway;if(current.c.role!=='local')return;const sync=()=>service.syncNotificationDefaults();current.notifications.defaultSource=sync;scope.effect(()=>()=>{if(current.notifications.defaultSource===sync)current.notifications.defaultSource=null;});});
  sub.inject?.(['credentials'],scope=>{const current=scope.credentials;credentials=current;void service.initializeAdmission().catch(()=>{});scope.effect(()=>()=>{if(credentials===current){service.suspendAdmission();credentials=undefined;}});});
  sub.inject?.(['credentials',...executionDependencies],scope=>{const cancel=service.scheduleStart();scope.effect(()=>()=>{cancel();return service.suspend();});});
  sub.effect(()=>()=>service.dispose());
  sub.connection.fetch.register({path:'/api/'+endpoint,methods:['POST'],requestBody:'buffered',async fetch(request){
   const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
   // Authentication/CSRF belongs to the public DSH connection router; no new listener.
   if(request.method!=='POST')return new Response('method not allowed',{status:405,headers});
   if(!request.headers.get('content-type')?.startsWith('application/json'))return new Response('unsupported content type',{status:415,headers});
   let size=0,b;try{const raw=await request.text();size=Buffer.byteLength(raw);if(size>196608)return new Response('too large',{status:413,headers});b=JSON.parse(raw);}catch{return new Response('bad request',{status:400,headers});}
   if(!object(b)||b.type!=='client-request'||typeof b.rpcId!=='string'||b.rpcId.length>128||b.method!==endpoint||!object(b.payload)||Object.keys(b.payload).some(k=>!['method','args'].includes(k)))return new Response('bad request',{status:400,headers});
   if(size>16384&&b.payload.method!=='task_pair_forward')return new Response('too large',{status:413,headers});
   try{return Response.json({type:'server-response',rpcId:b.rpcId,result:{ok:true,value:await service.call(b.payload.method,b.payload.args??{}, /^im_maintenance_(status|preview|apply|reconcilePreview|reconcileApply)$/.test(b.payload.method)?{imTransport:nativeImMaintenanceTransport(sub.connection,request)}:{})}},{headers});}
   catch(e){return Response.json({type:'server-response',rpcId:b.rpcId,result:{ok:false,error:{code:/^ONBOARDING_[A-Z_]+$/.test(e.message)?e.message:'ONBOARDING_DETECTION_FAILED',details:{},message:'操作未完成；若已点击应用，请手动核对持久安装回执，不要据报错推断未写入。不会自动重试或初始化 ECS。'}}},{headers});}
  }});
 });
}
