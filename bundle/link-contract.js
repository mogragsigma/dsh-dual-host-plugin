// Application protocol, independent of plugin semver, IM transports and task authority.
export const VERSION='0.33.1';
export const CAPABILITIES=Object.freeze({artifact_download:1,task_results:1,intervention_actions:1,approval_local:1,approval_interaction:1,task_interventions:1,approval_workbench:2,onboarding_existing_repository:1,onboarding_existing:1,notification_default_peer:1,notification_defaults:1,schedule_budget:1,peer_files:1,model_selection:1,approval_reference:1,delivery_push_plan:1,delivery_push:1,delivery_commit_plan:1,delivery_commit:1,delivery_review:1,delivery_preview:1,development_workspace_bridge:1,development_workspace:1,development_claim:1,development_review:1,development_bridge:1,a2a:2,notification_media:2,notification_review:1,notification_discovery:1,notifications:1,search:1,sources:1,intake:1,catalog:1,approval:1,repository:1,peer:1,scheduler:1,triggers:1,workflows:1,diagnostics:1,workbench:1,taskboard:2,artifacts:2,development:2});
export const METHODS=Object.freeze({artifact_download:'artifact_download',task_results:'task_results',intervention_action_inspect:'intervention_actions',intervention_action_prepare:'intervention_actions',intervention_action_confirm:'intervention_actions',intervention_action_status:'intervention_actions',approval_local_validate:'approval_local',approval_local_pull:'approval_local',approval_local_ack:'approval_local',approval_interaction_describe:'approval_interaction',approval_interaction_prepare:'approval_interaction',approval_interaction_confirm:'approval_interaction',approval_interaction_status:'approval_interaction',approval_interaction_identity_send:'approval_interaction',approval_interaction_identity_check:'approval_interaction',approval_interaction_identity_close:'approval_interaction',board_interventions:'task_interventions',approval_workbench_describe:'approval_workbench',approval_workbench_prepare:'approval_workbench',approval_workbench_begin:'approval_workbench',approval_workbench_finish:'approval_workbench',approval_workbench_status:'approval_workbench',onboarding_existing_repository:'onboarding_existing_repository',onboarding_existing_inspect:'onboarding_existing',notification_default_peer_discover:'notification_default_peer',notification_default_peer_candidate:'notification_default_peer',notification_default_publish:'notification_defaults',notification_default_status:'notification_defaults',peer_file_offer:'peer_files',peer_file_pull:'peer_files',peer_file_chunk:'peer_files',peer_file_commit:'peer_files',peer_file_read:'peer_files',peer_file_ack:'peer_files',peer_file_status:'peer_files',model_resolve:'model_selection',approval_reference:'approval_reference',delivery_push_prepare:'delivery_push_plan',delivery_push_schedule:'delivery_push',delivery_prepare:'delivery_commit_plan',delivery_schedule:'delivery_commit',delivery_file_page:'delivery_review',delivery_preview:'delivery_preview',delivery_status:'delivery_preview',workspace_bridge_enqueue:'development_workspace_bridge',workspace_bridge_cancel:'development_workspace_bridge',workspace_bridge_status:'development_workspace_bridge',workspace_bridge_claim_acquire:'development_workspace_bridge',workspace_bridge_claim_receipt:'development_workspace_bridge',workspace_bridge_read:'development_workspace_bridge',workspace_bridge_write:'development_workspace_bridge',workspace_bridge_command:'development_workspace_bridge',workspace_bridge_finish:'development_workspace_bridge',workspace_bridge_fail:'development_workspace_bridge',workspace_bridge_evidence:'development_workspace_bridge',workspace_bridge_review:'development_workspace_bridge',workspace_development_schedule:'development_workspace',development_bridge_claim_acquire:'development_claim',development_bridge_claim_receipt:'development_claim',development_bridge_evidence:'development_review',development_bridge_review:'development_review',development_bridge_cancel:'development_bridge',development_bridge_enqueue:'development_bridge',development_bridge_acquire:'development_bridge',development_bridge_read:'development_bridge',development_bridge_write:'development_bridge',development_bridge_test:'development_bridge',development_bridge_finish:'development_bridge',development_bridge_fail:'development_bridge',development_bridge_status:'development_bridge',a2a_create:'a2a',a2a_start:'a2a',a2a_list:'a2a',a2a_control:'a2a',a2a_claim:'a2a',a2a_begin:'a2a',a2a_validate:'a2a',a2a_reserve:'a2a',a2a_finish:'a2a',a2a_failed:'a2a',notification_artifact_send:'notification_media',notification_media_pull:'notification_media',notification_media_materialize:'notification_media',notification_media_validate:'notification_media',notification_media_wait:'notification_media',notification_artifact_access:'notification_media',notification_reconcile:'notification_review',notification_discover:'notification_discovery',notification_target_add:'notification_discovery',notification_target_publish:'notification_discovery',notification_targets:'notifications',notification_bind:'notifications',notification_status:'notifications',notification_pull:'notifications',notification_validate:'notifications',notification_ack:'notifications',notification_wait:'notifications',source_capabilities:'sources',workflow_create:'workflows',workflow_list:'workflows',workflow_control:'workflows',job_input:'triggers',trigger_create:'triggers',trigger_list:'triggers',trigger_control:'triggers',trigger_signal:'triggers',development_schedule:'development',artifact_list:'artifacts',artifact_register_gitee:'artifacts',artifact_access:'artifacts',accept:'intake',status:'catalog',inspect:'catalog',catalog:'catalog',task_amend:'catalog',approval_request:'approval',approval_status:'approval',repository_resolve:'repository',repository_bind:'repository',repository_status:'repository',repository_unbind:'repository',repository_gate:'repository',peer_send:'peer',peer_pull:'peer',peer_ack:'peer',peer_status:'peer',schedule:'scheduler',job_control:'scheduler',diagnostics:'diagnostics',workbench_status:'workbench',workbench_bootstrap:'workbench',board_list:'taskboard',board_detail:'taskboard'});
export const compatibilityErrors=new Set(['PROTOCOL_NEGOTIATION_REQUIRED','PROTOCOL_VERSION_INCOMPATIBLE','PROTOCOL_PEER_LEGACY','PROTOCOL_DESCRIPTOR_INVALID','PROTOCOL_NAMESPACE_MISMATCH','PROTOCOL_ROLE_MISMATCH','PROTOCOL_INSTANCE_CHANGED','CAPABILITY_UNAVAILABLE','CAPABILITY_VERSION_INCOMPATIBLE']);
export const retryBarrierErrors=new Set([...compatibilityErrors,'PROTOCOL_MAINTENANCE_ACTIVE']);
export function errorInfo(error){
 const input=typeof error==='string'?error:error?.message;
 if(typeof input==='string'&&/^INTERVENTION_[A-Z0-9_]{1,70}$/.test(input))return {code:input,category:'validation_or_review',retry:'operator_review',does_not_grant_authority:true};
 if(['WORKER_MODEL_OUTPUT_LIMIT','APPROVAL_WORKBENCH_CHANGED','APPROVAL_OPERATION_NOT_READY','APPROVAL_IDENTITY_SOURCE_CHANGED','APPROVAL_INTERPRETATION_INTERRUPTED','APPROVAL_INTERPRETATION_UNAVAILABLE'].includes(input))return {code:input,category:'validation_or_review',retry:'operator_review',does_not_grant_authority:true};
 const raw=({'account-unverified':'IM_ACCOUNT_UNVERIFIED','capability-unavailable':'IM_CAPABILITY_UNAVAILABLE','account-changed':'IM_ROUTE_REVIEW_REQUIRED','target-changed':'IM_ROUTE_REVIEW_REQUIRED','unknown-target':'IM_ROUTE_REVIEW_REQUIRED','unknown-bot':'IM_ROUTE_REVIEW_REQUIRED','bad-request':'IM_BAD_REQUEST'})[input]??input;
 const code=raw==='NEEDS_REVIEW'?raw:typeof raw==='string'&&/^(UPDATE_|UNSUPPORTED_|PROTOCOL_|CAPABILITY_|AUTH_|INVALID_|INTERVENTION_|A2A_|SOURCE_|TASK_|APPROVAL_|PASSKEY_|APPROVER_|DEVELOPMENT_|ARTIFACT_|REPOSITORY_|GITEE_|PEER_|IM_|CHAT_|CONTEXT_|REFERENCE_|INGRESS_|MODEL_|NOTIFICATION_|SCHEDULER_|WORKFLOW_|COORDINATOR_|UNSAFE_|UNCONFIRMED_|SEND_|DELIVERY_|LEGACY_|METHOD_|TRANSIENT_|GATEWAY_|NEEDS_REVIEW)[A-Z0-9_]{1,90}$/.test(raw)?raw:'TRANSIENT_FAILURE';
 const category=code==='PROTOCOL_MAINTENANCE_ACTIVE'?'maintenance':compatibilityErrors.has(code)?'compatibility':code==='AUTH_DENIED'||code.startsWith('PASSKEY_')||code.startsWith('APPROVER_')?'authentication':/UNKNOWN|UNCERTAIN/.test(code)?'uncertain_delivery':/(?:^|_)INVALID(?:_|$)|RETIRED|CONTRACT_CHANGED|SOURCE_CHANGED|LINK_PENDING|CONFLICT|DENIED|MISMATCH|NOT_FOUND|NEEDS_REVIEW|REVIEW_REQUIRED|BAD_REQUEST|RESPONSE_TOO_LARGE|EXHAUSTED|ROUTE_CHANGED|OWNER_CHANGED|SCHEDULER_MIGRATION_|DEVELOPMENT_CLAIM_|DEVELOPMENT_WORKSPACE_(?:(?:WORKER|BRIDGE)_PENDING|DISABLED)|DEVELOPMENT_(?:CONTAINER|IMAGE)_UNAVAILABLE|DEVELOPMENT_(?:WRITE(?:_CALL)?|COMMAND|MODEL)_BUDGET|DEVELOPMENT_(?:WORKSPACE_IDENTITY|BASELINE|ROOT|REMOTE|APPROVAL)_CHANGED|DELIVERY_RESOURCE_BUSY|AUTHORIZATION_ENDED|QUEUE_LIMIT|NOT_ALLOWED|NOT_ACCEPTED|ALREADY_|NOT_IN_|DEADLINE|INPUT_STALE|CONTROL_PENDING|QUEUE_FULL|TASK_BUSY|TASK_NOT_QUIESCENT|REQUIRED|REGISTER_ONLY/.test(code)?'validation_or_review':'transient';
 return {code,category,retry:category==='maintenance'?'after_explicit_peer_release':category==='compatibility'?'after_compatible_peer':category==='transient'?'bounded_backoff':'operator_review',does_not_grant_authority:true};
}
const object=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
export function validateHello(h){
 if(!object(h)||h.schema!==1||!object(h.protocol)||!Number.isSafeInteger(h.protocol.min)||!Number.isSafeInteger(h.protocol.max)||h.protocol.min<1||h.protocol.max<h.protocol.min||!['local','cloud'].includes(h.role)||typeof h.namespace!=='string'||!h.namespace||h.namespace.length>128||!/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(h.plugin_version??'')||!/^[a-f0-9-]{36}$/.test(h.instance_id??'')||!object(h.capabilities)||Object.keys(h.capabilities).length>64)throw Error('PROTOCOL_DESCRIPTOR_INVALID');
 for(const [name,v] of Object.entries(h.capabilities))if(!/^[a-z][a-z0-9_-]{0,47}$/.test(name)||!Number.isSafeInteger(v)||v<1||v>65535)throw Error('PROTOCOL_DESCRIPTOR_INVALID');
 return h;
}
export function negotiate(own,remote){
 validateHello(own);validateHello(remote);
 if(own.namespace!==remote.namespace)throw Error('PROTOCOL_NAMESPACE_MISMATCH');
 if(own.role===remote.role)throw Error('PROTOCOL_ROLE_MISMATCH');
 const version=Math.min(own.protocol.max,remote.protocol.max);
 if(version<Math.max(own.protocol.min,remote.protocol.min))throw Error('PROTOCOL_VERSION_INCOMPATIBLE');
 const capabilities={};for(const [name,v] of Object.entries(own.capabilities))if(remote.capabilities[name]===v)capabilities[name]=v;
 return {version,capabilities};
}
export function requireCapability(method,own,remote,args={}){
 if(typeof method!=='string'||!Object.hasOwn(METHODS,method))throw Error('METHOD_DENIED');
 if(method==='schedule'&&args.max_runs!==undefined&&(own.capabilities.schedule_budget!==1||remote.capabilities.schedule_budget!==1))throw Error('CAPABILITY_VERSION_INCOMPATIBLE');
 let notify=args.notification_contract===1;try{notify ||= JSON.parse(args.goal).notification_contract===1;}catch{}
 if(notify&&(own.capabilities.notifications!==1||remote.capabilities.notifications!==1))throw Error('CAPABILITY_VERSION_INCOMPATIBLE');
 let search=!!args.search;try{search ||= !!JSON.parse(args.goal).search;}catch{}
 if(search&&(own.capabilities.search!==1||remote.capabilities.search!==1))throw Error('CAPABILITY_VERSION_INCOMPATIBLE');
 if(args.proposal?.delivery&&(own.capabilities.delivery_review!==1||remote.capabilities.delivery_review!==1))throw Error('CAPABILITY_VERSION_INCOMPATIBLE');
 if(args.proposal?.delivery?.kind==='push-execution-reference-v1'&&(own.capabilities.delivery_push_plan!==1||remote.capabilities.delivery_push_plan!==1))throw Error('CAPABILITY_VERSION_INCOMPATIBLE');
 if(args.proposal?.delivery?.kind==='commit-execution-reference-v1'&&(own.capabilities.delivery_commit_plan!==1||remote.capabilities.delivery_commit_plan!==1))throw Error('CAPABILITY_VERSION_INCOMPATIBLE');
 const capability=METHODS[method];
 negotiate(own,remote);
 if(own.capabilities[capability]===undefined||remote.capabilities[capability]===undefined)throw Error('CAPABILITY_UNAVAILABLE');
 if(own.capabilities[capability]!==remote.capabilities[capability])throw Error('CAPABILITY_VERSION_INCOMPATIBLE');
}

// Monotonic age is local. A remote wall clock is displayed but never trusted for freshness.
export class DirectLink {
 constructor(describe,transport,{now=Date.now,monotonic=()=>performance.now(),ttl=30000}={}){
  this.describe=describe;this.transport=transport;this.now=now;this.monotonic=monotonic;this.ttl=ttl;this.last=null;this.lastError=null;this.lastAttempt=null;this.cache=null;
 }
 failed(e){this.lastError=errorInfo(e);this.lastAttempt=this.now();}
 async handshake(){
  // Every operation negotiates; no stale capability grant survives a restart or configuration change.
  this.lastAttempt=this.now();const started=this.monotonic();
  try{
   let r;try{r=await this.transport('negotiate',{hello:this.describe()});}catch(e){if(e.message==='METHOD_DENIED')throw Error('PROTOCOL_PEER_LEGACY');throw e;}
   const selected=negotiate(this.describe(),r?.hello);
   if(r.hello.role!=='cloud')throw Error('PROTOCOL_ROLE_MISMATCH');
   this.last={hello:r.hello,selected,received_at:this.now(),mono:this.monotonic(),rtt_ms:Math.max(0,this.monotonic()-started)};this.lastError=null;
   return r.hello;
  }catch(e){this.failed(e);throw e;}
 }
 async call(method,args){
  try{
   const peer=await this.handshake(),own=this.describe();requireCapability(method,own,peer,args);
   const started=this.monotonic(),r=await this.transport(method,args,{hello:own,peer_instance:peer.instance_id});
   if(!object(r)||!object(r.result)||!object(r.observation)||r.observation.instance_id!==peer.instance_id||r.observation.authority!=='cloud'||!Number.isSafeInteger(r.observation.generated_at))throw Error('PROTOCOL_DESCRIPTOR_INVALID');
   const received=this.now(),mono=this.monotonic();this.lastError=null;
   const observation={...r.observation,received_at:received,round_trip_ms:Math.max(0,mono-started),freshness:'live_response',age_ms:0,ttl_ms:this.ttl,clock_basis:'local-monotonic; remote timestamp informational',usable_for_authorization:false};
   if(method==='diagnostics')this.cache={data:r.result,observation,mono};
   return {result:r.result,observation};
  }catch(e){this.failed(e);throw e;}
 }
 snapshot(){
  const age=this.last?Math.max(0,this.monotonic()-this.last.mono):null;
  return {state:this.lastError?(this.lastError.category==='compatibility'?'incompatible':this.lastError.category==='authentication'?'unauthenticated':this.lastError.category==='validation_or_review'?'operation_rejected':'unavailable'):!this.last?'unknown':age>this.ttl?'stale':'verified',last_attempt_at:this.lastAttempt,last_verified_at:this.last?.received_at??null,age_ms:age,ttl_ms:this.ttl,peer:this.last?.hello??null,negotiated:this.last?.selected??null,last_error:this.lastError,ssh_is_not_application_health:true,remote_idle:'unknown',usable_for_authorization:false};
 }
 cached(){if(!this.cache)return null;const age=Math.max(0,this.monotonic()-this.cache.mono);return {data:this.cache.data,observation:{...this.cache.observation,age_ms:age,freshness:this.lastError?'stale':age>this.ttl?'stale':'recent_snapshot',usable_for_authorization:false}};}
}
