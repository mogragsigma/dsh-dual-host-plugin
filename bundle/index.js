import {taskResults} from './task-results.js';
import {ApprovalRelayBroker,LocalApprovalEndpoint,configureLocalApproval} from './approval-local-relay.js';
import {feishuNotificationTarget} from './notification-feishu.js';
import {repositoryURL} from './repository-gitee.js';
import {existingRepositorySnapshot} from './onboarding-existing-setup.js';
import {createGatewayMaintenance} from './gateway-maintenance.js';
import {ModelSelection} from './model-selection.js';
import {DeliveryRuntime} from './delivery-runtime.js';
import {DeliveryPreview} from './delivery-preview.js';
import {A2AEndpoint,validateA2AConfig} from './a2a-endpoint.js';
import {TaskNotifications} from './task-notifications.js';
import {TaskA2A} from './task-a2a.js';
import {DevelopmentPeer} from './development-peer.js';
import {DevelopmentRuntime} from './development-runtime.js';
import {TaskSources} from './task-sources.js';
import {TaskArtifacts} from './task-artifacts.js';
import {createServer} from 'node:http';
import {mkdirSync,readFileSync,appendFileSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {timingSafeEqual,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {Coordinator,hash} from './store.js';
import {RepositoryWriter} from './repository-writer.js';
import {RepositoryCatalog} from './repository-catalog.js';
import {GiteeReadOnly} from './repository-gitee.js';
import {ManagedGiteeReadOnly} from './repository-managed.js';
import {LegacyFeishuAdapter} from './legacy-feishu-adapter.js';
import {PeerMailbox} from './peer-mailbox.js';
import {PeerFiles} from './peer-files.js';
import {safeError,permanentErrors,tx,migrateRecovery,outboxInsert} from './recovery.js';
import {SshConnector} from './ssh-connector.js';
import {TaskScheduler} from './task-scheduler.js';
import {ImDelivery} from './im-delivery.js';
import {assertScheduleEnvelope,schedulePolicy,parseEnvelope} from './task-envelope.js';
import {TaskCatalog} from './task-catalog.js';
import {validSources} from './task-context.js';
import {approvalReference} from './approval-reference.js';
import {ApprovalLedger} from './approval-ledger.js';
import {semanticClassifier} from './approval-semantic-model.js';
import {ChatApproval} from './approval-chat.js';
import {ApprovalWindow} from './approval-http.js';
import {InterventionActions} from './intervention-actions.js';
import {WorkbenchDecisions} from './workbench-decisions.js';
import {WorkbenchApprovals} from './approval-workbench.js';
import {VERSION,CAPABILITIES,METHODS,DirectLink,negotiate,requireCapability,retryBarrierErrors,errorInfo} from './link-contract.js';
import {queueDiagnostics,recoveryGuidance,RECEIPTS} from './diagnostics.js';
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export const inject=['agents','agentPresets','tools','sessions','llm'];
export class Gateway {
 constructor(ctx,c,io={}){
  c=configureLocalApproval(c,feishuNotificationTarget);
  this.ctx=ctx;this.c=c;this.closed=false;this.io=io;this.now=io.now??Date.now;
  this.maintenance=createGatewayMaintenance(this,{now:this.now});
  this.modelSelection=new ModelSelection(this);
  this.deliveries=new Map();this.tickPending=null;this.instanceId=randomUUID();this.monotonic=io.monotonic??(()=>performance.now());
  this.retry={maxAttempts:16,baseMs:2000,maxMs:300000,sendTimeoutMs:15000,...(c.recovery??{})};
  for(const [k,v] of Object.entries(this.retry))if(!Number.isSafeInteger(v)||v<1||v>3600000)throw Error('INVALID_RECOVERY_CONFIG');
  if(!['local','cloud'].includes(c.role)||!c.stateDir||!c.tokenFile&&!io.secrets)throw Error('INVALID_DEPLOYMENT');
  validateA2AConfig(c.a2a);
  if(c.a2a?.enabled&&c.peerEnabled===false)throw Error('A2A_PEER_REQUIRED');
  if(c.legacyFeishu&&c.imDelivery)throw Error('MULTIPLE_NOTIFICATION_CONSUMERS');
  if(io.secrets)this.secrets=structuredClone(io.secrets);
  else{if((lstatSync(c.tokenFile).mode&0o077)!==0)throw Error('SECRET_FILE_PERMISSIONS');this.secrets=JSON.parse(readFileSync(c.tokenFile,'utf8'));}
  for(const k of ['localToken',...(c.legacyFeishu?['a2aKey']:[]),...(c.role==='cloud'?['cloudToken']:[])])if(typeof this.secrets[k]!=='string'||this.secrets[k].length<32)throw Error('MISSING_SECRET');
  if(c.role==='cloud'&&equal(this.secrets.localToken,this.secrets.cloudToken))throw Error('DISTINCT_ROLE_TOKENS_REQUIRED');
  if(c.entryMode==='native'&&Object.keys(c.repositoryBindings??{}).length)throw Error('LEGACY_REPOSITORY_WRITER_DISABLED');
  const repositoryProvider=c.role==='cloud'?(c.repositoryAccess?.managedOnboarding===true?new ManagedGiteeReadOnly(c.repositoryAccess,io.repository):new GiteeReadOnly(c.repositoryAccess,io.repository)):null;
  mkdirSync(c.stateDir,{recursive:true,mode:0o700});
  this.trace=(type,data={})=>appendFileSync(join(c.stateDir,'events.jsonl'),JSON.stringify({type,...data,at:this.now()})+'\n',{mode:0o600});
  this.db=new DatabaseSync(join(c.stateDir,'gateway.sqlite'));
  this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS submissions(id TEXT PRIMARY KEY,fingerprint TEXT,payload TEXT,status TEXT,task_id TEXT,attempts INTEGER DEFAULT 0);
   CREATE TABLE IF NOT EXISTS a2a(id TEXT PRIMARY KEY,fingerprint TEXT);
   CREATE TABLE IF NOT EXISTS notices(id TEXT PRIMARY KEY,text TEXT,status TEXT,created INTEGER);
   CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY,text TEXT,status TEXT);`);
  migrateRecovery(this.db);
  try{this.imDelivery=c.imDelivery?new ImDelivery(this,c.imDelivery):null;}catch(e){this.db.close();throw e;}
  this.legacy=c.legacyFeishu?new LegacyFeishuAdapter(this):null;
  try{this.peer=c.peerEnabled===false?null:new PeerMailbox(this.db,{role:c.role,namespace:c.namespace,now:()=>this.now()});}catch(e){this.db.close();throw e;}
  this.peerLastError=null;
  try{if(c.fileTransfers?.enabled)this.files=new PeerFiles(this,c.fileTransfers);}catch(e){this.db.close();throw e;}
  this.writer=new RepositoryWriter(c.repositoryBindings??{});
  if(c.role==='cloud'){this.store=new Coordinator(join(c.stateDir,'coordinator'),this.writer);this.catalog=new TaskCatalog(this.store);this.repositories=new RepositoryCatalog(this.store,this.catalog,repositoryProvider,this.now,id=>this.assertTaskQuiescent(id));this.approvals=new ApprovalLedger(this.store,this.catalog,this.now,this.repositories);if(c.localApproval){this.approvalRelay=new ApprovalRelayBroker(this.store.db,c.localApproval,{now:this.now});this.chatApproval=new ChatApproval(this.approvals,{...c.localApproval,appSecretEnv:'LOCAL_RELAY_NO_SECRET',hostRole:'local',semantic:{enabled:true,...c.localApproval.semantic}},{classify:semanticClassifier(ctx,c.localApproval.semantic),source:this.approvalRelay.source()});}else if(c.chatApproval)this.chatApproval=new ChatApproval(this.approvals,c.chatApproval,{classify:semanticClassifier(ctx,c.chatApproval.semantic),...io.chatApproval});else this.store.db.prepare('UPDATE approval_chat_bindings SET disabled=1').run();this.approvalWindow=new ApprovalWindow();this.workbenchApprovals=new WorkbenchApprovals(this.approvals,()=>this.chatApproval);this.workbenchDecisions=new WorkbenchDecisions(this.approvals,()=>this.chatApproval,{hold:()=>this.maintenance.enter('workbench_interaction')});}
  if(c.role==='cloud'&&c.scheduler)this.scheduler=new TaskScheduler(ctx,{...c.scheduler,canTick:()=>!this.maintenance.blocked,stateDir:join(c.stateDir,'scheduler'),validateSchedule:s=>this.assertScheduleCurrent(s),admit:job=>{if(this.store.task(job.task_id).blocked)throw Error('TASK_BLOCKED');const e=parseEnvelope(job.goal),h=this.catalog.head(job.task_id);if(e&&(e.task_context?.spec_revision??1)!==h.spec_revision)throw Error('TASK_REVISION_CONFLICT');this.sources?.searcher.admit(job);}},io.scheduler);
  if(this.store){this.sources=new TaskSources(this,c.readonlySources??{});this.artifacts=new TaskArtifacts(this);if(this.scheduler?.worker){this.scheduler.worker.artifacts=this.artifacts;this.scheduler.worker.sources=this.sources;}}
  if(c.development?.enabled){this.development=new DevelopmentRuntime(this,c.development);this.scheduler.executors.set('development',{replaySafe:false,run:(j,s)=>this.development.run(j,s)});this.scheduler.c.canClaim=j=>j.kind==='development'?this.development.canClaim(j):!this.store.task(j.task_id).busy;this.scheduler.c.afterRecover=()=>this.development.recover();this.scheduler.c.afterFinish=j=>{if(j.kind==='development')this.development.finished(j);};this.scheduler.c.afterFailure=j=>{if(j.kind==='development')this.development.failed(j);};}
  if(this.scheduler){const admit=this.scheduler.c.canClaim;this.scheduler.c.canClaim=j=>!this.closed&&(admit?.(j)??true);}
  if(this.store){this.delivery=new DeliveryPreview(this);this.approvals.delivery=this.delivery;}
  if(c.role==='cloud'&&c.delivery?.enabled===true)this.deliveryRuntime=new DeliveryRuntime(this,c.delivery,io.delivery);
  this.notifications=new TaskNotifications(this,c.notificationTargets??[]);
  if(this.store)this.interventionActions=new InterventionActions(this);
  if(c.a2a?.enabled&&this.store){if(!this.peer)throw Error('A2A_PEER_REQUIRED');this.a2a=new TaskA2A(this);}
  this.link=c.role==='local'?new DirectLink(()=>this.hello(),(m,a,contract)=>this.remoteTransport(m,a,contract),{now:this.now,monotonic:this.monotonic}):null;
  if(c.role==='local'&&c.localApproval)this.localApprovalEndpoint=new LocalApprovalEndpoint(this,c.localApproval,{credentials:ctx.get?.('credentials'),...io.localApproval});
  if(c.developmentPeer?.enabled===true)this.developmentPeer=new DevelopmentPeer(this,c.developmentPeer,io.developmentPeer);
  if(c.a2a?.endpoint?.enabled)this.a2aEndpoint=new A2AEndpoint(this,c.a2a.endpoint,io.a2aEndpoint);
  ctx.on('agent/request',async({agent},next)=>{
   const result=await next();if(!this.isManaged(agent))return result;
   if((c.provider&&result.provider!==c.provider)||(c.model&&result.model!==c.model))throw Error('MANAGED_MODEL_ROUTE_MISMATCH');
   this.trace('model-request',{agent:agent.id,provider:result.provider,model:result.model});
   return {...result,maxTokens:2048};
  },{prepend:true}); // Validate the final UI selection, even after a gateway hot reload.
  ctx.effect(()=>()=>this.close());
 }
 isManaged(agent){return this.c.entryMode!=='native'&&!!agent&&this.ctx.agentPresets.composedPreset(agent.ctx)==='dsh-task-intake';}
 assertNativeAgent(agent){if(this.ctx.agents.get(agent?.id)!==agent||!['standard','ptc','cordis',...(this.c.nativePresets??[])].includes(this.ctx.agentPresets.composedPreset(agent.ctx)))throw Error('UNBOUND_NATIVE_SESSION');}
 assertAgent(agent){if(this.ctx.agents.get(agent?.id)!==agent||!this.isManaged(agent))throw Error('UNBOUND_ENTRY_SESSION');}
 assertScheduleCurrent(s){
  const h=this.catalog.head(s.task_id);if(this.store.task(s.task_id).blocked)throw Error('TASK_BLOCKED');
  if(h.spec_revision!==s.revision||h.goal!==s.goal)throw Error('TASK_REVISION_CONFLICT');assertScheduleEnvelope(h.goal,JSON.parse(s.policy));
 }
 assertDispatchFamily(task_id,revision,family){
  const db=this.scheduler.jobs.db;
  const workflow=db.prepare('SELECT 1 FROM task_workflows WHERE task_id=? AND revision=?').get(task_id,revision);
  const trigger=db.prepare('SELECT 1 FROM task_schedules WHERE task_id=? AND revision=?').get(task_id,revision);
  const single=db.prepare('SELECT 1 FROM jobs WHERE trigger_id=?').get('task-plan:'+task_id+':'+revision);
  if(family!=='workflow'&&workflow||family!=='trigger'&&trigger||family!=='single'&&single)throw Error('SCHEDULER_DISPATCH_FAMILY_CONFLICT');
 }
 assertTaskQuiescent(id){if(this.deliveryRuntime?.busy(id)||this.development?.busy(id)||this.a2a?.busy(id)||this.scheduler?.workflows.list(id).some(w=>!['completed','cancelled'].includes(w.status))||this.scheduler?.triggers.list(id).some(s=>!['closed','cancelled'].includes(s.status))||this.store.task(id).busy||this.scheduler?.jobs.list(id).some(j=>!['completed','cancelled'].includes(j.status))||[...(this.scheduler?.active.values()??[])].some(r=>r.task_id===id))throw Error('TASK_NOT_QUIESCENT');}
 async call(method,args,node=this.c.role){return this.maintenance.run('rpc',()=>this.callCore(method,args,node));}
 async callCore(method,args,node=this.c.role){
  await this.io.authorize?.();
  if(typeof method!=='string'||!Object.hasOwn(METHODS,method))throw Error('METHOD_DENIED');
  if(method==='onboarding_existing_repository'){
   if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).join()!=='url')throw Error('INVALID_ARGUMENTS');
   if(this.c.role!=='cloud'||!this.repositories?.provider?.inspect)throw Error('CAPABILITY_UNAVAILABLE');
   const url=repositoryURL(args.url).url;
   return existingRepositorySnapshot(await this.repositories.provider.inspect(url),url);
  }
  if(method==='onboarding_existing_inspect'){
   if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).length)throw Error('INVALID_ARGUMENTS');
   if(this.c.role!=='cloud'||!this.onboardingInspection)throw Error('CAPABILITY_UNAVAILABLE');
   return this.onboardingInspection(args);
  }
  if(method==='model_resolve'){
   if(!['local','cloud'].includes(args?.host))throw Error('MODEL_SELECTION_INVALID');
   if(args.host===this.c.role)return {...await this.modelSelection.resolve(args),observation:this.observation()};
   if(this.c.role==='local')return this.observedCall(method,args);
   throw Error('MODEL_TARGET_ENTRY_REQUIRED'); // Never pretend cloud inventory is the offline Mac's.
  }
  if(this.c.role==='local'&&['notification_discover','notification_target_add'].includes(method)&&args?.host==='local')return this.notifications.call(method,args,node);
  if(method.startsWith('board_')){if(!this.board)throw Error('CAPABILITY_UNAVAILABLE');return this.board.call(method,args);}
  if(method.startsWith('workbench_')){if(!this.workbench)throw Error('CAPABILITY_UNAVAILABLE');return this.workbench.call(method,args);}
  if(method==='diagnostics')return this.diagnostics(args?.refresh!==false); // No remote arbitrary writer/admin/probe.
  if(method.startsWith('a2a_')){if(!this.c.a2a?.enabled)throw Error('CAPABILITY_UNAVAILABLE');if(this.a2a)return this.a2a.call(method,args,node);}
  if(this.store){
   if(method.startsWith('approval_local_')){if(!this.approvalRelay)throw Error('CAPABILITY_UNAVAILABLE');return this.approvalRelay.call(node,method.slice('approval_local_'.length),args);}
   if(method.startsWith('intervention_action_'))return this.interventionActions.call(node,method.slice('intervention_action_'.length),args);
   if(method.startsWith('approval_interaction_'))return this.workbenchDecisions.call(node,method.slice('approval_interaction_'.length),args);
   if(method.startsWith('approval_workbench_')){const service=this.workbenchApprovals;if(!service){if(method==='approval_workbench_describe')return {enabled:false,reason:'APPROVAL_WORKBENCH_DISABLED'};throw Error('APPROVAL_WORKBENCH_DISABLED');}return service.call(node,method.slice('approval_workbench_'.length),args);}
   if(method.startsWith('development_bridge_')||method.startsWith('workspace_bridge_')){if(!this.development?.bridge)throw Error('CAPABILITY_UNAVAILABLE');return this.development.bridge.call(method,args,node);}
   if(['schedule','workflow_create','trigger_create','development_schedule','workspace_development_schedule'].includes(method)&&this.a2a?.busy(args.task_id))throw Error('A2A_TASK_BUSY');
   if(method.startsWith('notification_'))return this.notifications.call(method,args,node);
   if(method==='source_capabilities')return {schema:1,host:'cloud',capabilities:this.sources.capabilities(args),worker_enabled:this.scheduler?.started===true&&!this.scheduler.closed,scope:'explicit current task references intersect operator read roots',grant:false,model_policy:'per-task; inventory never selects or validates a model'};
   if(method==='delivery_push_prepare'||method==='delivery_push_schedule'){if(!this.deliveryRuntime)throw Error('CAPABILITY_UNAVAILABLE');return method==='delivery_push_prepare'?this.deliveryRuntime.stagePush(node,args):this.deliveryRuntime.schedulePush(node,args);}
   if(method==='delivery_prepare'||method==='delivery_schedule'){if(!this.deliveryRuntime)throw Error('CAPABILITY_UNAVAILABLE');return method==='delivery_prepare'?this.deliveryRuntime.stage(node,args):this.deliveryRuntime.schedule(node,args);}
   if(method==='delivery_preview')return this.delivery.create(node,args);
   if(method==='delivery_file_page')return this.delivery.page(args);
   if(method==='delivery_status')return this.delivery.status(args.task_id);
   if(method==='task_results')return taskResults(this,args);
   if(method.startsWith('artifact_'))return this.artifacts.call(method,args,node);
   if(method.startsWith('peer_')){
    if(method.startsWith('peer_file_')){if(!this.files)throw Error('CAPABILITY_UNAVAILABLE');return this.files.call(method,args,node);}
    if(!this.peer)throw Error('PEER_DISABLED');
    if(method==='peer_send')return this.peer.accept(node,args,id=>this.store.task(id));
    if(method==='peer_pull')return this.peer.pull(node);
    if(method==='peer_ack')return this.peer.acknowledge(node,args);
    return this.peer.status(node,args);
   }
   if(method==='job_input'){
    if(!this.scheduler)throw Error('SCHEDULER_UNAVAILABLE');
    const j=this.scheduler.jobs.get(args.job_id),source=validSources(args.sources),e=parseEnvelope(j.goal),h=this.catalog.head(j.task_id);
    if(!source.length||source.some(s=>s.role!==node))throw Error('CONTEXT_ORIGIN_MISMATCH');
    if(this.store.task(j.task_id).blocked||this.store.task(j.task_id).busy)throw Error('TASK_BLOCKED');
    if(!e||(e.task_context?.spec_revision??1)!==h.spec_revision)throw Error('TASK_REVISION_CONFLICT');
    assertScheduleEnvelope(j.goal,JSON.parse(j.policy));
    return this.scheduler.jobs.answer({id:j.id,question_run_id:args.question_run_id,event_id:args.event_id,source});
   }
   if(method.startsWith('workflow_')){
    if(!this.scheduler)throw Error('SCHEDULER_UNAVAILABLE');const workflows=this.scheduler.workflows;
    if(method==='workflow_list'){this.store.task(args.task_id);return {items:workflows.list(args.task_id),authority:'cloud',development:false};}
    if(method==='workflow_control')return workflows.control({...args,actor:'authenticated-'+node+'-entry'});
    const source=validSources(args.sources);if(!source.length||source.some(s=>s.role!==node))throw Error('CONTEXT_ORIGIN_MISMATCH');
    const task=this.store.task(args.task_id),h=this.catalog.head(task.id);
    if(task.blocked)throw Error('TASK_BLOCKED');
    if((task.busy||[...this.scheduler.active.values()].some(r=>r.task_id===task.id))&&!workflows.db.prepare('SELECT 1 FROM task_workflows WHERE event_id=?').get(args.event_id))throw Error('WORKFLOW_TASK_BUSY');
    this.assertDispatchFamily(task.id,h.spec_revision,'workflow');
    if(this.scheduler.triggers.list(task.id).some(s=>!['closed','cancelled'].includes(s.status)))throw Error('SCHEDULER_ALREADY_EXISTS');
    if(args.expected_revision!==h.spec_revision)throw Error('TASK_REVISION_CONFLICT');args={...args,policy:schedulePolicy(h.goal,args.policy)};
    return workflows.create({task_id:task.id,revision:h.spec_revision,goal:h.goal,policy:args.policy,nodes:args.nodes,max_total_runs:args.max_total_runs,end_at:args.end_at,event_id:args.event_id,source});
   }
   if(method.startsWith('trigger_')){
    if(!this.scheduler)throw Error('SCHEDULER_UNAVAILABLE');
    const triggers=this.scheduler.triggers;
    if(method==='trigger_list'){this.store.task(args.task_id);return {items:triggers.list(args.task_id),authority:'cloud',development:false};}
    if(method==='trigger_control')return triggers.control({...args,actor:'authenticated-'+node+'-entry'});
    const source=validSources(args.sources);if(!source.length||source.some(s=>s.role!==node))throw Error('CONTEXT_ORIGIN_MISMATCH');
    if(method==='trigger_signal'){
     if(!source.some(s=>s.text.includes(args.name)))throw Error('SCHEDULER_SIGNAL_NOT_IN_USER_CONTEXT');
     return triggers.signal({id:args.id,name:args.name,event_id:args.event_id,source});
    }
    const task=this.store.task(args.task_id),h=this.catalog.head(task.id);
    if(task.blocked)throw Error('TASK_BLOCKED');
    if(task.busy||[...this.scheduler.active.values()].some(r=>r.task_id===task.id))throw Error('SCHEDULER_TASK_BUSY');
    if(args.expected_revision!==h.spec_revision)throw Error('TASK_REVISION_CONFLICT');
    if(this.scheduler.workflows.list(task.id).some(w=>!['completed','cancelled'].includes(w.status)))throw Error('WORKFLOW_ALREADY_EXISTS');
    args={...args,policy:schedulePolicy(h.goal,args.policy)};
    this.assertDispatchFamily(task.id,h.spec_revision,'trigger');
    const trigger=triggers.create({task_id:task.id,revision:h.spec_revision,goal:h.goal,policy:args.policy,timing:args.timing,dependencies:args.dependencies,event_id:args.event_id,source});
    this.notifications.defaults.inherit(task.id);return trigger;
   }
   if(method==='workspace_development_schedule'){if(!this.development)throw Error('DEVELOPMENT_DISABLED');return this.development.schedule(args,{workspace:true});}
   if(method==='development_schedule'){if(!this.development)throw Error('DEVELOPMENT_DISABLED');return this.development.schedule(args);}
   if(method==='repository_resolve')return this.repositories.resolve(args);
   if(method==='repository_bind'||method==='repository_unbind')return this.repositories.mutate(node,args,method==='repository_unbind');
   if(method==='repository_status')return args.refresh?this.repositories.refresh(args.task_id):this.repositories.status(args.task_id);
   if(method==='repository_gate')return this.repositories.gate(args.task_id,args,this.approvals);
   if(method==='approval_request'){const r=this.approvals.request(node,args);return {...r,chat_confirmation:this.chatApproval?.queue(r.id)??null,confirmation_url:null};}
   if(method==='approval_reference')return approvalReference(this,args);
   if(method==='approval_status')return {items:this.approvals.list(args.task_id).map(r=>({...r,chat_confirmation:this.chatApproval?.delivery(r.id)??null})),confirmation_url:null,execution:this.development?'requires_runtime_gate':'disabled'};
   if(method==='catalog'){const r=this.catalog.find(args);return {...r,items:r.items.map(t=>({...t,jobs:this.scheduler?.jobs.list(t.task_id).slice(-5)??[]})),authority:'cloud'};}
   if(method==='task_amend')return this.catalog.amend(node,args,id=>this.assertTaskQuiescent(id));
   if(method==='status')return {...this.store.status(args.task_id),catalog:this.catalog.view(args.task_id),repository:this.repositories.status(args.task_id),approvals:this.approvals.list(args.task_id),...(this.scheduler?{jobs:this.scheduler.jobs.list(args.task_id),schedules:this.scheduler.triggers.list(args.task_id),workflows:this.scheduler.workflows.list(args.task_id)}:{})};
   if(method==='inspect'){const task=this.store.db.prepare('SELECT id FROM tasks WHERE task_key=?').get(args.task_key);if(!task)throw Error('TASK_NOT_FOUND');return this.call('status',{task_id:task.id},node);}
   if(method==='schedule'){
    if(!this.scheduler)throw Error('SCHEDULER_UNAVAILABLE');
    const task=args.task_id?this.store.task(args.task_id):this.store.db.prepare('SELECT * FROM tasks WHERE task_key=?').get(args.task_key);
    if(!task)throw Error('TASK_NOT_FOUND');if(task.blocked)throw Error('NEEDS_REVIEW');
    if(this.a2a?.busy(task.id))throw Error('A2A_TASK_BUSY');
    if(this.scheduler.triggers.list(task.id).some(s=>!['closed','cancelled'].includes(s.status)))throw Error('SCHEDULER_ALREADY_EXISTS');
    if(this.scheduler.workflows.list(task.id).some(w=>!['completed','cancelled'].includes(w.status)))throw Error('WORKFLOW_ALREADY_EXISTS');
    const h=this.catalog.head(task.id),goal=h.goal;
    if(args.expected_revision!==undefined&&args.expected_revision!==h.spec_revision)throw Error('TASK_REVISION_CONFLICT');
    if(h.spec_revision>1&&args.expected_revision===undefined)throw Error('TASK_REVISION_REQUIRED');
    if(!args.policy?.provider||!args.policy?.model)throw Error('MODEL_POLICY_REQUIRED');
    args={...args,policy:schedulePolicy(goal,args.policy)};
    this.assertDispatchFamily(task.id,h.spec_revision,'single');
    const job=this.scheduler.jobs.enqueue({task_id:task.id,trigger_id:h.legacy?args.trigger_id:'task-plan:'+task.id+':'+h.spec_revision,goal,policy:args.policy,delay_seconds:args.delay_seconds??0,...(args.max_runs!==undefined?{max_runs:args.max_runs}:{})});
    if((args.delay_seconds??0)>0)this.notifications.defaults.inherit(task.id);
    return {job_id:job.id,task_id:task.id,title:h.title,spec_revision:h.spec_revision,status:job.status,kind:job.kind,due:job.due,max_runs:job.max_runs,max_model_requests_per_run:6,model_policy:JSON.parse(job.policy)};
   }
   if(method==='job_control'){
    if(!this.scheduler||!['pause','resume','cancel'].includes(args.action))throw Error('METHOD_DENIED');
    return this.scheduler.control({id:args.job_id,action:args.action,event_id:args.event_id,actor:'authenticated-'+node+'-entry'});
   }
   const incoming=parseEnvelope(args.goal);if(incoming&&incoming.origin.role!==node)throw Error('CONTEXT_ORIGIN_MISMATCH');
   const t=this.store.accept(node,args);
   if(incoming?.notification_contract===1)this.notifications.track(t.id);
   // Status is queued intake, not a claim that a worker has run.
   const h=this.catalog.head(t.id);return {...t,title:h.title,spec_revision:h.spec_revision,execution:'pending_dispatch'};
  }
  return (await this.link.call(method,args)).result;
 }
 hello(){
  const capabilities={...CAPABILITIES};
  if(this.c.role==='cloud'&&!this.repositories?.provider?.inspect)delete capabilities.onboarding_existing_repository;
  if(this.c.role==='cloud'&&!this.onboardingInspection)delete capabilities.onboarding_existing;
  if(!this.files)delete capabilities.peer_files;
  if(this.c.role==='cloud'&&!this.deliveryRuntime?.pushEnabled)delete capabilities.delivery_push_plan;
  if(this.c.role==='cloud'&&!this.deliveryRuntime?.pushExecutionEnabled)delete capabilities.delivery_push;
  if(this.c.role==='cloud'&&!this.deliveryRuntime)delete capabilities.delivery_commit_plan;
  if(this.c.role==='cloud'&&!this.deliveryRuntime?.executionEnabled)delete capabilities.delivery_commit;
  if(!this.c.a2a?.enabled)delete capabilities.a2a;
  if(this.c.role==='cloud'&&!this.development?.bridge){delete capabilities.development_bridge;delete capabilities.development_review;}
  if(this.c.role==='cloud'&&!this.development)delete capabilities.development;
  if(this.c.role==='cloud'&&!this.development?.workspaceEnabled){delete capabilities.development_workspace;delete capabilities.development_workspace_bridge;}
  if(this.c.role==='cloud'&&!this.development?.bridge)delete capabilities.development_workspace_bridge;
  if(!this.workbench)delete capabilities.workbench;
  if(!this.board){delete capabilities.taskboard;delete capabilities.task_results;}
  if(this.c.role==='cloud'){if(!this.peer)delete capabilities.peer;if(!this.scheduler){delete capabilities.scheduler;delete capabilities.triggers;delete capabilities.workflows;}}
  return {schema:1,protocol:{min:1,max:1},plugin_version:VERSION,role:this.c.role,namespace:this.c.namespace,instance_id:this.instanceId,capabilities};
 }
 observation(){return {authority:this.c.role,instance_id:this.instanceId,generated_at:this.now(),freshness:'live_response',age_ms:0,usable_for_authorization:false};}
 async observedCall(method,args){return this.maintenance.run('observed_rpc',()=>this.observedCallCore(method,args));}
 async observedCallCore(method,args){
  if(!this.store){const {result,observation}=await this.link.call(method,args);return {...result,observation};}
  return {...await this.call(method,args),observation:this.observation()};
 }
 async remoteTransport(method,args,contract){
  // Own onboarding transport supplies a verified SSH-bound peer path. Static
  // deployments retain their original HTTP/token behavior without modification.
  if(this.io.transport)return this.io.transport(method,args,contract);
  const endpoint=new URL(this.c.coordinatorUrl);
  if(endpoint.username||endpoint.password||endpoint.search||endpoint.hash||!(endpoint.protocol==='https:'||(endpoint.protocol==='http:'&&['127.0.0.1','[::1]','localhost'].includes(endpoint.hostname))))throw Error('UNSAFE_COORDINATOR_URL');
  let r;try{r=await (this.io.fetch??fetch)(this.c.coordinatorUrl.replace(/\/$/,'')+'/rpc',{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+this.secrets.localToken,'Content-Type':'application/json'},body:JSON.stringify({method,args,...(contract?{contract}:{})}),signal:AbortSignal.timeout(method==='workspace_bridge_command'?330000:(method==='model_resolve'||method.startsWith('onboarding_existing_')||method.startsWith('repository_')||method.startsWith('artifact_'))?20000:8000)});}catch{throw Error('COORDINATOR_UNAVAILABLE');}
  let raw='',bytes=0;const decoder=new TextDecoder();for await(const chunk of r.body){bytes+=chunk.byteLength;if(bytes>2097152)throw Error('PROTOCOL_RESPONSE_TOO_LARGE');raw+=decoder.decode(chunk,{stream:true});}raw+=decoder.decode();
  let d;try{d=JSON.parse(raw);}catch{throw Error('PROTOCOL_DESCRIPTOR_INVALID');}
  if(!r.ok)throw Error(errorInfo(d?.error).code);return d;
 }
 rememberPeer(hello){this.inbound={hello,selected:negotiate(this.hello(),hello),received_at:this.now(),mono:this.monotonic()};this.inboundError=null;}
 inboundSnapshot(){
  const age=this.inbound?Math.max(0,this.monotonic()-this.inbound.mono):null,e=this.inboundError;
  return {state:e?(e.category==='compatibility'?'incompatible':'operation_rejected'):!this.inbound?'unknown':age>30000?'stale':'verified',direction:'passive_authenticated_observation',last_verified_at:this.inbound?.received_at??null,age_ms:age,ttl_ms:30000,peer:this.inbound?.hello??null,negotiated:this.inbound?.selected??null,last_error:e??null,remote_idle:'unknown',usable_for_authorization:false};
 }
 localDiagnostics(){
  const queues=queueDiagnostics(this);
  return {schema:1,host:this.hello(),connection:this.link?.snapshot()??this.inboundSnapshot(),remote_idle:'unknown',peer_transport:{enabled:!!this.peer,last_error:this.peerLastError?errorInfo(this.peerLastError):null},observation:this.observation(),queues,recovery:recoveryGuidance(queues),file_transfers:this.files?.snapshot()??{enabled:false},a2a_endpoint:this.a2aEndpoint?.snapshot()??null,development_peer:this.developmentPeer?.snapshot()??null,scheduler:{enabled:!!this.scheduler,active_runs:this.scheduler?.active.size??0},approval:{execution:'disabled',chat:this.chatApproval?.snapshot()??null},im:this.imDelivery?.snapshot()??null,connector:this.connector?.snapshot()??null,receipt_classes:RECEIPTS,delivery:this.deliveryRuntime?.status()??{staging_enabled:false,execution_enabled:false,grants_execution:false},development_enabled:!!this.development,publish_enabled:false,automatic_repair:false};
 }
 async diagnostics(refresh=true){
  const local=this.localDiagnostics();if(!this.link)return local;
  let remote=null;if(refresh)try{remote=await this.link.call('diagnostics',{});}catch{}
  const cached=remote?null:this.link.cached();
  return {...local,connection:this.link.snapshot(),cloud:remote?{data:remote.result,observation:remote.observation}:cached,cloud_status_available:!!(remote||cached),cloud_cached:!remote&&!!cached,remote_idle:'unknown'};
 }

 async submit(args){return this.maintenance.run('submission',()=>this.submitCore(args));}
 async submitCore(args){
  await this.io.authorize?.();
  if(this.closed)throw Error('GATEWAY_CLOSED');
  if(typeof args.goal!=='string'||!args.goal.trim()||args.goal.length>12000||!(/^[a-z0-9-]{1,64}$/).test(args.task_key)||typeof args.ingress_id!=='string'||!args.ingress_id||args.ingress_id.length>256||!['desktop','native-local','native-cloud',...(this.legacy?['feishu-local','feishu-cloud']:[])].includes(args.source))throw Error('INVALID_SUBMISSION');
  const fp=hash(JSON.stringify(args));
  this.db.prepare("INSERT OR IGNORE INTO submissions(id,fingerprint,payload,status,created_at) VALUES (?,?,?,'queued',?)").run(args.ingress_id,fp,JSON.stringify(args),this.now());
  const row=this.db.prepare('SELECT * FROM submissions WHERE id=?').get(args.ingress_id);
  if(row.fingerprint!==fp)throw Error('INGRESS_ID_CONFLICT');
  return this.deliver(args.ingress_id);
 }
 backoff(attempt){return Math.min(this.retry.maxMs,this.retry.baseMs*2**Math.min(attempt,20));}
 receipt(row,status){return this.legacy?.receipt(row,status);}
 deliver(id){
  if(this.closed)return Promise.reject(Error('GATEWAY_CLOSED'));
  if(this.maintenance.blocked)return Promise.reject(Error('PROTOCOL_MAINTENANCE_ACTIVE'));
  if(this.deliveries.has(id))return this.deliveries.get(id);
  const pending=this.deliverOnce(id).finally(()=>this.deliveries.delete(id));this.deliveries.set(id,pending);return pending;
 }
 async deliverOnce(id){
  const row=this.db.prepare('SELECT * FROM submissions WHERE id=?').get(id);
  if(!row)throw Error('SUBMISSION_NOT_FOUND');
  if(row.status==='accepted'){this.receipt(row,'accepted');return {status:'accepted',task_id:row.task_id,execution:'pending_dispatch'};}
  if(row.status==='needs_review')return {status:'needs_review',ingress_id:id};
  if(row.next_attempt_at>this.now())return {status:'queued_locally',ingress_id:id};
  this.db.prepare('UPDATE submissions SET attempts=attempts+1 WHERE id=?').run(id);
  let task;
  try{task=await this.call('accept',JSON.parse(row.payload));}
  catch(e){
   const code=retryBarrierErrors.has(e.message)?e.message:safeError(e),blocked=retryBarrierErrors.has(code),status=!blocked&&(permanentErrors.has(code)||row.attempts+1>=this.retry.maxAttempts)?'needs_review':'queued';
   tx(this.db,()=>{
    if(blocked)this.db.prepare('UPDATE submissions SET attempts=attempts-1 WHERE id=?').run(id);
    this.db.prepare('UPDATE submissions SET status=?,last_error=?,next_attempt_at=? WHERE id=?').run(status,code,this.now()+(blocked?30000:this.backoff(row.attempts+1)),id);
    this.receipt(row,status);
   });
   this.trace('forward-pending',{ingress_id:id,code});return {status:status==='queued'?'queued_locally':status,ingress_id:id};
  }
  // The remote accept is idempotent. A crash before this transaction replays it.
  // Never catch a local persistence error and falsely acknowledge it as success.
  tx(this.db,()=>{
   this.db.prepare("UPDATE submissions SET status='accepted',task_id=?,last_error=NULL WHERE id=?").run(task.id,id);
   const noticeId='notice-'+hash(id).slice(0,40);
   if(this.legacy)outboxInsert(this.db,'notices',noticeId,this.legacy.notice(task,noticeId),this.now());
   this.peer?.enqueue({id:noticeId,task_id:task.id,kind:'task_notice',text:'Task registered; no execution or approval granted.'});
   this.receipt({...row,task_id:task.id},'accepted');
  });
  this.trace('accepted',{ingress_id:id,task_id:task.id,via:this.c.role});
  return {status:'accepted',task_id:task.id,title:task.title,spec_revision:task.spec_revision,execution:'pending_dispatch'};
 }
 async receive(msg){return this.maintenance.run('legacy_im',()=>{if(!this.legacy)throw Error('LEGACY_IM_DISABLED');return this.legacy.receive(msg);});}
 async receiveControl(msg,text){return this.maintenance.run('legacy_control',()=>{if(!this.legacy)throw Error('LEGACY_IM_DISABLED');return this.legacy.receiveControl(msg,text);});}
 tick(){
  if(this.closed||this.maintenance.blocked)return Promise.resolve();
  if(this.tickPending)return this.tickPending;
  this.tickPending=this.tickOnce().finally(()=>{this.tickPending=null;});return this.tickPending;
 }
 async tickOnce(){
  this.deliveryRuntime?.tick();
  this.a2a?.reap(); // Expire authority even when the recipient is offline; never dispatch here.
  if(this.scheduler)for(const n of this.scheduler.jobs.db.prepare('SELECT id,text FROM job_notifications WHERE delivered=0 LIMIT 10').all()){
   if(this.notifications?.ownsLegacyNotice(n.id)){this.scheduler.jobs.db.prepare('UPDATE job_notifications SET delivered=1 WHERE id=?').run(n.id);continue;}
   if(this.imDelivery)this.imDelivery.enqueue(n.id,n.text);else outboxInsert(this.db,'receipts',n.id,n.text,this.now());
   this.scheduler.jobs.db.prepare('UPDATE job_notifications SET delivered=1 WHERE id=?').run(n.id);
  }
  for(const r of this.db.prepare("SELECT id FROM submissions WHERE status='queued' AND next_attempt_at<=? ORDER BY next_attempt_at LIMIT 10").all(this.now())){if(this.closed)return;await this.deliver(r.id);}
  if(this.peer)try{await this.peer.sync((m,a)=>this.call(m,a));this.peerLastError=null;}catch(e){this.peerLastError=retryBarrierErrors.has(e.message)?e.message:'PEER_UNAVAILABLE';}
  const files=this.files;if(files)try{await files.sync();}catch(e){files.lastError=files.code(e);}
  await this.legacy?.sendPending();
  await this.imDelivery?.sendPending();
  if(this.developmentPeer?.started&&!this.developmentPeer.closed)await this.developmentPeer.tick();
  await this.notifications?.tick();
  await this.chatApproval?.tick();
 }
 snapshot(){return {protocol:this.hello(),connection:this.link?.snapshot()??this.inboundSnapshot(),diagnostics:this.localDiagnostics(),scheduler:this.scheduler?.snapshot()??null,version:VERSION,approval:{chat:this.chatApproval?.snapshot()??null,window:false,identity_policy:'existing-im-only',execution:'disabled'},role:this.c.role,channelStatus:this.legacy?.status()??null,legacyFeishu:!!this.legacy,imDelivery:this.imDelivery?.snapshot()??null,files:this.files?.snapshot()??null,peer:this.peer?{...this.peer.snapshot(),lastError:this.peerLastError}:null,entryMode:this.c.entryMode??'legacy-test',managedPreset:this.c.entryMode==='native'?null:'dsh-task-intake',agents:this.ctx.agents.list().map(a=>({id:a.id,status:a.status,managed:this.isManaged(a)})),submissions:this.db.prepare('SELECT id,status,task_id,attempts,next_attempt_at,last_error FROM submissions').all(),notices:this.db.prepare('SELECT id,status,message_id,last_error FROM notices').all(),receipts:this.db.prepare('SELECT id,status,message_id,last_error FROM receipts').all(),a2a:this.db.prepare('SELECT id FROM a2a').all(),repositoryBindings:this.writer.bindings.size,repositoryAssociations:this.repositories?this.store.db.prepare("SELECT COUNT(*) AS count FROM repository_associations WHERE state<>'unbound'").get().count:null,sendNotices:!!this.c.sendNotices};}
 async start(){
  await this.sources?.ready;
  if(this.scheduler)await this.scheduler.start();
  this.deliveryRuntime?.start();
  this.server=createServer(async(req,res)=>{
   if(this.approvalWindow&&req.url?.startsWith('/approval/')){try{return await this.maintenance.run('approval_http',()=>this.approvalWindow.handle(req,res));}catch{if(!res.headersSent){res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'PROTOCOL_MAINTENANCE_ACTIVE'}));}return;}}
   let status=200,value,peerRequest=false,leave;
   try{
    if(req.method!=='POST'||!['/rpc','/health'].includes(req.url))throw Error('NOT_FOUND');
    const token=req.headers.authorization?.replace(/^Bearer /,'');
    const own=equal(token,this.c.role==='local'?this.secrets.localToken:this.secrets.cloudToken);
    const peer=this.c.role==='cloud'&&equal(token,this.secrets.localToken);
    if(!own&&!peer)throw Error('AUTH_DENIED');peerRequest=peer&&!own;
    if(req.url==='/health'){if(!own)throw Error('AUTH_DENIED');value=this.snapshot();}
    else{
     leave=this.maintenance.enter('http');
     let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>131072)throw Error('BODY_TOO_LARGE');}
     const body=JSON.parse(raw);if(!body.args||typeof body.args!=='object'||Array.isArray(body.args))throw Error('INVALID_ARGUMENTS');
     if(body.method==='accept'){
      // Validate peer RPC as strictly as native submissions; identity is bound to token.
      if(typeof body.args.goal!=='string'||!body.args.goal.trim()||body.args.goal.length>12000)throw Error('INVALID_GOAL');
     }
     if(body.method==='negotiate'){
      if(this.c.role!=='cloud')throw Error('PROTOCOL_ROLE_MISMATCH');
      const hello=this.hello();negotiate(hello,body.args.hello);if(peerRequest)this.rememberPeer(body.args.hello);value={hello};
     }else{
      const remote=peer&&!own;
      if(remote){
       if(!body.contract?.hello)throw Error('PROTOCOL_NEGOTIATION_REQUIRED');
       const hello=this.hello();requireCapability(body.method,hello,body.contract.hello,{...body.args,...(body.args.task_id&&['schedule','trigger_create','workflow_create','task_amend'].includes(body.method)&&parseEnvelope(this.catalog.head(body.args.task_id).goal)?.notification_contract===1?{notification_contract:1}:{}),...(body.args.task_id&&['schedule','trigger_create','workflow_create','task_amend'].includes(body.method)&&parseEnvelope(this.catalog.head(body.args.task_id).goal)?.search?{search:true}:{})});
       if(body.contract.peer_instance!==this.instanceId)throw Error('PROTOCOL_INSTANCE_CHANGED');
       this.rememberPeer(body.contract.hello);
      }
      const result=await this.call(body.method,body.args,remote?'local':this.c.role);
      value=remote?{result,observation:this.observation()}:result;
     }
    }
   }catch(e){if(peerRequest)this.inboundError=errorInfo(e);status=400;value={error:String(e.message??e)};}
   leave?.();res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));
  });
  this.server.requestTimeout=10000;this.server.headersTimeout=10000;
  await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(this.c.port,'127.0.0.1',resolve);});
  if(this.developmentPeer)await this.developmentPeer.start();
  const loop=async()=>{try{await this.tick();}catch{this.trace('tick-error');}if(!this.closed)this.timer=setTimeout(()=>{this.pending=loop();},10000);};this.pending=loop();
  if(this.c.role==='local'&&this.c.ssh){this.connector=new SshConnector(this.c.ssh,this.trace,this.io.ssh);this.connector.start();}
  if(this.a2aEndpoint)await this.a2aEndpoint.start();
  this.localApprovalEndpoint?.start();
  this.trace('gateway-active',{role:this.c.role,port:this.c.port});
 }
 close(){
  if(this.closing)return this.closing;
  this.closed=true;clearTimeout(this.timer);
  const serverClosed=this.server?.listening?new Promise(resolve=>{this.server.close(resolve);this.server.closeIdleConnections();}):Promise.resolve();
  this.closing=(async()=>{
   this.approvalRelay?.close();
   await this.localApprovalEndpoint?.close();
   await this.deliveryRuntime?.close();
   await this.developmentPeer?.close();
   await this.a2aEndpoint?.close();
   const settled=await Promise.allSettled([this.pending,this.tickPending,...this.deliveries.values(),this.connector?.close(),this.scheduler?.close(),this.workbenchDecisions?.close(),this.chatApproval?.close(),serverClosed]);
   await this.notifications?.close();await this.artifacts?.close();
   this.maintenance.completeClosure(()=>{this.store?.close();this.db.close();},settled.every(x=>x.status==='fulfilled'));
  })();return this.closing;
 }
}
export async function apply(ctx,c){const gateway=new Gateway(ctx,c);ctx.provide('taskGateway',gateway);ctx.provide('dshTaskIngress',{receive:m=>gateway.receive(m)});try{await gateway.start();}catch(e){await gateway.close();throw e;}}
