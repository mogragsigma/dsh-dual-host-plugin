import {createOnboardingFileTransfer,isManagedFileOutbox} from './onboarding-file-transfer.js';
// Fixed own runtime configuration. Never writes the DSH profile or loads user tokens.
import {peerBindingKey} from './onboarding-peer-binding.js';
import {errorInfo} from './link-contract.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const workerPreset='dsh-onboarding-readonly-worker';
import {DatabaseSync} from 'node:sqlite';
import {Gateway,inject as gatewayInject} from './index.js';
import {onboardingBoundary} from './onboarding-boundary.js';
import {createOnboardingRepository} from './onboarding-repository.js';
import {createOnboardingRepositories} from './onboarding-repositories.js';
import {installWorkbench} from './workbench-host.js';
import {installTaskBoard} from './task-board.js';
import {installArtifactAccess} from './task-artifacts.js';
import * as nativeTools from './native-tools.js';
const fail=c=>{throw Error('ONBOARDING_TASK_RUNTIME_'+c);};
async function checked(p,dir){const s=await fs.lstat(p);if(s.isSymbolicLink()||!(dir?s.isDirectory():s.isFile())||!dir&&s.nlink!==1||(s.mode&0o077)||process.getuid&&s.uid!==process.getuid())fail('PATH_REVIEW');return s;}
export async function taskRuntimeLease(config,runtime,id){
 if(typeof id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id))fail('ARGUMENTS');
 const {paths}=onboardingBoundary(config,runtime,'persistence'),parent=path.join(paths.dsh.path,'dual-host-task-runtime'),root=path.join(parent,id);
 // DSH root exists already; never recursively create or follow arbitrary ancestors.
 for(let p=paths.dsh.path;p!==path.dirname(p);p=path.dirname(p)){const s=await fs.lstat(p);if(s.isSymbolicLink()||!s.isDirectory())fail('PATH_REVIEW');}
 try{await fs.mkdir(parent,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}await checked(parent,true);
 const owner=JSON.stringify({owner:'dsh-dual-host-task-runtime',schema:1,id});
 try{await fs.mkdir(root,{mode:0o700});await fs.writeFile(path.join(root,'owner.json'),owner,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
 await checked(root,true);await checked(path.join(root,'owner.json'),false);if(await fs.readFile(path.join(root,'owner.json'),'utf8')!==owner)fail('PATH_REVIEW');
 const lock=path.join(root,'exclusive.sqlite');try{await fs.writeFile(lock,'',{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}await checked(lock,false);
 const db=new DatabaseSync(lock);try{db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');}catch{db.close();fail('ALREADY_RUNNING');}
 // Under the exclusive lease, refuse pre-existing linked/foreign state before SQLite opens it.
 try{
  // SQLite inherits the initial file mode; do not change the process-wide umask.
  for(const relative of ['state','state/coordinator']){const p=path.join(root,relative);try{await fs.mkdir(p,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}await checked(p,true);}
  for(const relative of ['state/gateway.sqlite','state/coordinator/tasks.sqlite']){const p=path.join(root,relative);try{await fs.writeFile(p,'',{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}await checked(p,false);}
  let seen=0;async function inspect(dir){for(const name of await fs.readdir(dir)){if(++seen>10000)fail('PATH_REVIEW');const p=path.join(dir,name),s=await fs.lstat(p);await checked(p,s.isDirectory());if(s.isDirectory()&&!isManagedFileOutbox(root,p))await inspect(p);}}await inspect(root);}catch(e){db.exec('ROLLBACK');db.close();throw e;}
 let released=false;return {root,release(){if(released)return;released=true;try{db.exec('ROLLBACK');}finally{db.close();}}};
}
export function nativeTaskRuntimeAdapter(ctx,config,runtime,state){
 return {async open(p,authorize){
  if(ctx.get('taskGateway'))fail('SERVICE_CONFLICT');
  const lease=await taskRuntimeLease(config,runtime,p.id);let g,fiber,tools,files,unregisterWorker;
  try{
   const workspace=path.join(lease.root,'worker-workspace');
   if(p.workerEnabled){try{await fs.mkdir(workspace,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}await checked(workspace,true);}
   const repository={state,fetch:runtime.repositoryFetch,registry:createOnboardingRepositories({state,credentials:()=>runtime.credentials,repository:createOnboardingRepository({state,config,runtime}),config,runtime})};
   fiber=ctx.plugin({name:'dual-host-managed-task-runtime',inject:gatewayInject,async apply(scope){
    await authorize();
    g=new Gateway(scope,{role:'cloud',stateDir:path.join(lease.root,'state'),namespace:'managed-'+p.id,port:0,entryMode:'native',legacyFeishu:false,peerEnabled:!!p.pairing?.enabled,repositoryAccess:{managedOnboarding:true},workbench:{enabled:true},...(p.workerEnabled?{scheduler:{lockPort:0,workspace,preset:workerPreset,maxConcurrent:1,timeoutMs:180000}}:{})},{scheduler:{allowEphemeralLock:true},secrets:{localToken:p.localToken,cloudToken:p.cloudToken},authorize,repository});
    const {paths}=onboardingBoundary(config,runtime,'persistence');files=createOnboardingFileTransfer({g,root:lease.root,credentials:()=>runtime.credentials??scope.credentials,protectedRoots:[paths.dsh.path,paths.agents.path]});await files.start();
    scope.provide('taskGateway',g);
    if(p.workerEnabled){
     unregisterWorker=await scope.agentPresets.register({id:workerPreset,name:'云端只读任务 Worker',description:'本项目只读后台执行；不改变原生模式或开放仓库写入。',plugins:[
      {name:'@deepseek-ai/dsh-agent-instructions',config:{dshHome:fileURLToPath(new URL('./worker-rules',import.meta.url)),maxBytes:16384}},
      {name:'@deepseek-ai/dsh-skill-filesystem',config:{providerName:'dsh-onboarding-worker-skills',includeDefaultRoots:false,customSkillDirs:[fileURLToPath(new URL('./skills',import.meta.url))],watch:false}},
      {name:'@deepseek-ai/dsh-tool-skill'},
      {name:fileURLToPath(new URL('./worker-tools.js',import.meta.url))}
     ]});
     scope.effect(()=>()=>unregisterWorker?.());
    }
    installWorkbench(scope,g,{enabled:true});installTaskBoard(scope,g);installArtifactAccess(scope,g);
    tools=scope.plugin({name:'dual-host-managed-native-tools',inject:nativeTools.inject,apply:nativeTools.apply});
   }});await fiber.await();await tools?.await();
   if(p.workerEnabled){const row=(await ctx.agentPresets.list()).find(x=>x.id===workerPreset);if(!row||row.broken)fail('WORKER_PRESET_REVIEW');}
   await g.start();
   if(!g?.server?.listening||g.closed||ctx.get('taskGateway')!==g)fail('START_REVIEW');
   let ending;
   return {files,id:p.id,instanceId:g.instanceId,pairingKey:peerBindingKey(p.pairing),get workerEnabled(){return !!g.scheduler?.started&&!g.scheduler.closed;},port:g.server.address().port,
    async forward(frame){
     await authorize();if(!p.pairing?.enabled||ending)fail('PAIR_AUTH_DENIED');
     const res=await fetch('http://127.0.0.1:'+g.server.address().port+'/rpc',{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Authorization:'Bearer '+p.localToken},body:JSON.stringify(frame),signal:AbortSignal.timeout(20000)});
     let size=0,chunks=[];for await(const chunk of res.body){size+=chunk.length;if(size>524288)fail('PAIR_RESPONSE_REVIEW');chunks.push(chunk);}let value;try{value=JSON.parse(Buffer.concat(chunks));}catch{fail('PAIR_RESPONSE_REVIEW');}
     return res.ok?{ok:true,value}:{ok:false,error:errorInfo(value?.error).code};
    },active:()=>!ending&&!g.closed&&g.server.listening,
    async quiescent(){if(!g.maintenance.status().canHold)fail('BUSY');},
    hold(){const plan=g.maintenance.preview();try{g.maintenance.apply({id:plan.id,fingerprint:plan.fingerprint,confirm:true});}catch{fail('BUSY');}},
    close(){return ending??=(async()=>{try{await files?.close();await g.close();await unregisterWorker?.();await fiber.dispose();}finally{lease.release();}})();}};
  }catch(e){try{await files?.close();await g?.close();await unregisterWorker?.();await fiber?.dispose();}finally{lease.release();}throw e;}
 }};
}
