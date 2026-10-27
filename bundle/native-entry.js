import {createOnboardingTaskRuntime} from './onboarding-task-runtime.js';
import {nativeTaskRuntimeAdapter} from './onboarding-task-runtime-native.js';
import {installOnboarding} from './onboarding-host.js';
import {onboardingIdentity} from './onboarding-identity.js';
import {createOnboardingState} from './onboarding-state.js';
import {createOnboardingRepository} from './onboarding-repository.js';
import {createOnboardingRepositories} from './onboarding-repositories.js';
import {installArtifactAccess} from './task-artifacts.js';
import {installTaskBoard} from './task-board.js';
import {installWorkbench} from './workbench-host.js';
import {Gateway,inject as gatewayInject} from './index.js';
// The setup/maintenance owner must not be disposed when an execution service
// reloads. Bind execution dependencies only to the runtime that needs them.
export const inject=[];
// Same installed module, same public Host root: no second owner/consumer. The
// normal Cordis lifecycle releases the claim; a duplicate never releases another.
const owners=new WeakMap();
function claimOwner(ctx){
 if(!ctx.root)return; // Non-Host embedding/tests have no shared application root.
 if(owners.has(ctx.root))throw Error('DUPLICATE_NATIVE_ENTRY');
 const root=ctx.root,claim={};owners.set(root,claim);
 try{ctx.effect(()=>()=>{if(owners.get(root)===claim)owners.delete(root);});}
 catch(error){if(owners.get(root)===claim)owners.delete(root);throw error;}
}
// Only the native entry is public. Legacy modules remain for historical regression,
// but loading this release must never reconnect an old IM consumer or restricted entry.
export async function apply(ctx,config={}){
 onboardingIdentity(config); // Reject conflicting setup identity before starting any gateway.
 if(config.legacyFeishu)throw Error('LEGACY_ENTRY_RETIRED');
 if(config.entryMode&&config.entryMode!=='native')throw Error('LEGACY_ENTRY_RETIRED');
 claimOwner(ctx);
 // A fresh install has no gateway state/credentials yet. It exposes only onboarding.
 if(!config.role&&!config.stateDir&&!config.tokenFile){
  if(onboardingIdentity(config).role==='cloud')ctx.inject(['credentials',...gatewayInject],scope=>{
   const runtime={credentials:scope.credentials},state=createOnboardingState(scope,config,runtime);
   const manager=createOnboardingTaskRuntime({state,credentials:()=>scope.credentials,config,adapter:nativeTaskRuntimeAdapter(scope,config,runtime,state)});
   scope.provide('onboardingTaskRuntime',manager);scope.effect(()=>()=>manager.close());
  });
  installOnboarding(ctx,config);return;
 }
 installOnboarding(ctx,config);
 ctx.inject([...gatewayInject,'onboardingActivity'],ctx=>{
 const cancel=ctx.onboardingActivity.deferStartup('configured_gateway',async()=>{
 let repository;
 if(config.role==='cloud'&&config.repositoryAccess?.managedOnboarding===true){
  let credentials;
  ctx.inject?.(['credentials'],scope=>{const current=scope.credentials;credentials=current;scope.effect(()=>()=>{if(credentials===current)credentials=undefined;});});
  const runtime={get credentials(){return credentials;}},state=createOnboardingState({},config,runtime);
  const registry=createOnboardingRepositories({state,credentials:()=>credentials,repository:createOnboardingRepository({state,config,runtime}),config,runtime});
  repository={state,registry};
 }
 const gateway=new Gateway(ctx,{...config,legacyFeishu:false,entryMode:'native'},{repository});
 ctx.provide('taskGateway',gateway);
 try{await gateway.start();installWorkbench(ctx,gateway,config.workbench);installTaskBoard(ctx,gateway);installArtifactAccess(ctx,gateway);}catch(e){await gateway.close();throw e;}
 });
 ctx.effect(()=>cancel);
 });
}
