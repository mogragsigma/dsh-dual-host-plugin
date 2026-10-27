import {createOnboardingFileTransfer} from './onboarding-file-transfer.js';
import {onboardingBoundary} from './onboarding-boundary.js';
import {Gateway,inject as gatewayInject} from './index.js';
import {taskRuntimeLease} from './onboarding-task-runtime-native.js';
import {localPairKey} from './onboarding-local-pair.js';
import {installWorkbench} from './workbench-host.js';
import {installTaskBoard} from './task-board.js';
import {installArtifactAccess} from './task-artifacts.js';
import * as nativeTools from './native-tools.js';
export function nativeLocalPairAdapter(ctx,config,runtime,io={}){return {async open(p,authorize,transport){
 if(ctx.get('taskGateway'))throw Error('ONBOARDING_LOCAL_PAIR_SERVICE_CONFLICT');
 const lease=await taskRuntimeLease(config,runtime,p.localId);let g,fiber,tools,files;
 try{
  fiber=ctx.plugin({name:'dual-host-managed-local-pair',inject:gatewayInject,async apply(scope){
   await authorize();g=new Gateway(scope,{role:'local',stateDir:lease.root+'/state',namespace:p.binding.namespace,port:0,entryMode:'native',legacyFeishu:false,peerEnabled:true},{secrets:{localToken:p.localToken},authorize,transport});
   const {paths}=onboardingBoundary(config,runtime,'persistence');files=createOnboardingFileTransfer({g,root:lease.root,credentials:()=>runtime.credentials??scope.credentials,protectedRoots:[paths.dsh.path,paths.agents.path]});await files.start();
   await g.start();scope.provide('taskGateway',g);installWorkbench(scope,g,{enabled:true,managedOpen:io.openWorkbench?async(args,proof,browserHost)=>{await authorize();const result=await io.openWorkbench(args,proof,p.binding.target,browserHost);try{await authorize();return result;}catch(e){await io.closeWorkbench?.(result.entryId);throw e;}}:undefined});installTaskBoard(scope,g);installArtifactAccess(scope,g);tools=scope.plugin({name:'dual-host-managed-local-tools',inject:nativeTools.inject,apply:nativeTools.apply});
  }});await fiber.await();await tools?.await();if(!g?.server?.listening||g.closed||ctx.get('taskGateway')!==g)throw Error('ONBOARDING_LOCAL_PAIR_START_REVIEW');let ending;
  return {files,bindingKey:localPairKey(p),active:()=>!ending&&!g.closed&&g.server.listening,async quiescent(){await Promise.allSettled([g.tickPending,...g.deliveries.values()]);if(g.deliveries.size)throw Error('ONBOARDING_LOCAL_PAIR_BUSY');},close(){return ending??=(async()=>{try{await files?.close();await g.close();await fiber.dispose();}finally{lease.release();}})();}};
 }catch(e){try{await files?.close();await g?.close();await fiber?.dispose();}finally{lease.release();}throw e;}
}};}
