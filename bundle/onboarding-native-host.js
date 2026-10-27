import fs from 'node:fs/promises';
import {isManagedGatewayReceipt} from './onboarding-task-runtime-contract.js';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createOnboardingInstaller} from './onboarding-installer.js';
const fail=c=>{throw Error('ONBOARDING_CLOUD_NATIVE_'+c);};
const hash=b=>createHash('sha256').update(b).digest('hex');
export function nativeEnvironment(root,node){
 const base=path.join(root,'runtime'),home=path.join(base,'native-home');
 return {HOME:home,DSH_HOME:path.join(home,'dsh'),DSH_AGENTS_HOME:path.join(home,'agents'),DSH_ONBOARDING_ISOLATED_ROOT:base,PATH:path.dirname(node)+':/usr/bin:/bin',SHELL:'/bin/sh',LANG:'C.UTF-8',TMPDIR:path.join(base,'native-tmp'),XDG_CONFIG_HOME:path.join(home,'config'),XDG_DATA_HOME:path.join(home,'data'),XDG_CACHE_HOME:path.join(home,'cache')};
}
export function watchChild(child){
 const spawned=new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
 const ended=new Promise((resolve,reject)=>{child.once('exit',(code,signal)=>resolve({code,signal}));child.once('error',reject);});
 // A spawn error rejects both promises; observe both immediately even while awaiting the first.
 spawned.catch(()=>{});ended.catch(()=>{});return {spawned,ended};
}

export function validateNativePluginIdentity(receipt,expected){if(typeof expected!=='string'||!expected||receipt?.pluginVersion!==expected)fail('PLUGIN_IDENTITY_MISMATCH');}
export function nativeImRows(enabled){return enabled?[{id:'dual-host-optional-im',name:'@xmanrui/dsh-im',config:{}}]:[];}
export function validateNativeOverlay(patch,env,optionalIm=false){
 if(patch?.length!==2||patch[0].id!=='spill-local'||patch[0].config?.root!==path.join(env.TMPDIR,'spill')||patch[1].insert?.length!==(optionalIm?3:2)||patch[1].insert[0].id!=='dual-host-onboarding'||patch[1].insert[1].id!=='dual-host-admission'||optionalIm&&JSON.stringify(patch[1].insert[2])!==JSON.stringify(nativeImRows(true)[0]))fail('RESTART_OVERLAY_REVIEW');
 if((patch[1].insert[1].config?.expectedIm===true)!==optionalIm)fail('RESTART_OVERLAY_REVIEW');
}
export async function initializeNativeHost(q,j,io){
 const base=path.join(q.root,'runtime'),control=path.join(q.root,'.control/runtime'),env=nativeEnvironment(q.root,process.execPath),workspace=path.join(base,'workspace'),source=path.join(base,'plugin');
 const active=()=>{if(io.stopping())fail('STOPPED');};
 const fresh=async p=>{try{await fs.mkdir(p,{mode:0o700});}catch(e){if(e.code==='EEXIST')fail('PATH_OCCUPIED');throw e;}};
 for(const p of [env.HOME,env.DSH_HOME,env.DSH_AGENTS_HOME,env.TMPDIR,workspace,source,path.join(env.TMPDIR,'spill')]){active();await fresh(p);}
 const manifest=io.manifest;
 for(const file of manifest){active();const relative=file.path.slice('plugin/'.length),to=path.join(source,relative);await fs.mkdir(path.dirname(to),{recursive:true,mode:0o700});const b=await fs.readFile(path.join(q.root,file.path));if(hash(b)!==file.sha256)fail('SOURCE_DRIFT');await fs.writeFile(to,b,{flag:'wx',mode:0o600});}
 const log=await fs.open(path.join(control,'native-setup.log'),'wx',0o600);
 async function command(args){
  active();const child=spawn(process.execPath,args,{cwd:workspace,env,stdio:['ignore',log.fd,log.fd]}),events=watchChild(child);await events.spawned;
  try{j.child=await io.processInfo(child.pid);await io.save();}catch(e){if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');throw e;}const result=await events.ended;if(result.code!==0)fail('SETUP_COMMAND_FAILED');return;}
  const timer=setTimeout(()=>{child.kill('SIGTERM');},90000);let result;try{result=await events.ended;}finally{clearTimeout(timer);}
  active();if(result.code!==0)fail('SETUP_COMMAND_FAILED');
 }
 try{
  j.state='configuring';await io.save();
  // Official, pinned support step only. No npm lifecycle script or third-party source rewrite.
  const helper=path.join(base,'node_modules/@deepseek-ai/dsh-subprocess-local/scripts/ensure-spawn-helper.mjs');
  if(hash(await fs.readFile(helper))!=='ca5509febf1e6ec1356df121835ebe5ed2f9cace4bdc2ba6d83d41c7e45e0f1b')fail('SETUP_SCRIPT_DRIFT');
  await command([helper]);
  const cli=path.join(base,'node_modules/@deepseek-ai/dsh/lib/bin.js');await command([cli,'web','--dump-default-config']);
  const profile=path.join(env.DSH_HOME,'profiles/web'),local=path.join(base,'node_modules/@mogragsigma');
  const defaultPatch=path.join(profile,'cordis.patch.yml'),defaultBytes=await fs.readFile(defaultPatch);
  await fresh(local);await fs.symlink('../../plugin',path.join(local,'dsh-dual-host-plugin'));
  await fs.symlink(path.relative(profile,path.join(base,'node_modules')),path.join(profile,'node_modules'));
  const installer=createOnboardingInstaller({role:'cloud',onboarding:{installation:{enabled:true,isolatedRoot:base}}},{env,home:env.HOME,source});
  const plan=await installer.preview();if(!plan.canApply)fail('RULES_CONFLICT');
  const applied=await installer.apply({id:plan.id,fingerprint:plan.fingerprint,confirm:true});if(applied.state!=='committed')fail('RULES_NOT_INSTALLED');
  j.rules={transactionId:applied.id,target:plan.target,files:applied.files.length};
  const nonce=randomUUID(),settings={onboarding:{role:'cloud',persistence:{enabled:true,isolatedRoot:base},installation:{enabled:true,isolatedRoot:base}}};
  const patch=[{id:'spill-local',config:{root:path.join(env.TMPDIR,'spill')}},{insert:[{id:'dual-host-onboarding',name:'@mogragsigma/dsh-dual-host-plugin',config:settings},{id:'dual-host-admission',name:path.join(source,'onboarding-native-probe.js'),config:{nonce,control,workspace,dshHome:env.DSH_HOME,agentsHome:env.DSH_AGENTS_HOME,expectedIm:j.optionalIm===true}},...nativeImRows(j.optionalIm===true)]}];
  await fs.writeFile(path.join(base,'native-overlay.yml'),JSON.stringify(patch),{flag:'wx',mode:0o600});
  await launchNative(q,j,io,{control,nonce,defaultBytes,runId:null});
 }finally{await log.close();}
}

async function launchNative(q,j,io,{control,nonce,defaultBytes,runId}){
 const base=path.join(q.root,'runtime'),env=nativeEnvironment(q.root,process.execPath),workspace=path.join(base,'workspace'),source=path.join(base,'plugin');
 const defaultPatch=path.join(env.DSH_HOME,'profiles/web/cordis.patch.yml');
 const expectedVersion=JSON.parse(await fs.readFile(path.join(source,'package.json'))).version;
 const installed=JSON.parse(await fs.readFile(path.join(base,'package.json'))).dependencies;
 if(typeof installed?.['@deepseek-ai/dsh']!=='string'||j.optionalIm===true&&typeof installed?.['@xmanrui/dsh-im']!=='string')fail('RUNTIME_VERSION_REVIEW');
 const active=()=>{if(io.stopping())fail('STOPPED');};let native;
 try{
  j.state=runId?'restarting':'starting_host';j.nativeNonce=nonce;await io.save();active();
  const hostLog=await fs.open(path.join(control,'native-host.log'),'wx',0o600);
  try{
   native=spawn(process.execPath,['--expose-internals',path.join(source,'onboarding-native-runner.js'),q.root,...(runId?[runId]:[])],{cwd:workspace,env,detached:true,stdio:['pipe',hostLog.fd,hostLog.fd]});
   const events=watchChild(native);await events.spawned;j.host=await io.processInfo(native.pid);await io.save();
   await fs.writeFile(path.join(control,'native-launch.json'),JSON.stringify({nonce,process:j.host,...(runId?{resumeAuthorization:{contract:1,restartId:runId,fingerprint:j.restart.fingerprint,acknowledged:j.restart.nativeResumeAcknowledged===true}}:{})}),{flag:'wx',mode:0o600});
   active();native.stdin.on('error',()=>{});native.stdin.end(JSON.stringify({nonce}));native.unref();
  }finally{await hostLog.close();}
  // Poll only this exact live process. An observation expiry never starts another Host.
  const until=Date.now()+90000;
  while(Date.now()<until){
   active();if(!await io.alive(j.host))fail('HOST_EXITED');
   let receipt;try{receipt=JSON.parse(await fs.readFile(path.join(control,'native-receipt.json')));}catch(e){if(e.code!=='ENOENT')throw e;}
   if(receipt){if(j.optionalIm===true&&(receipt.im?.version!==installed['@xmanrui/dsh-im']||receipt.im?.contract!==1||!Number.isSafeInteger(receipt.im?.botsConfigured)||receipt.im.botsConfigured<0||!runId&&receipt.im.botsConfigured!==0))fail('IM_ADMISSION_FAILED');validateNativePluginIdentity(receipt,expectedVersion);if(!receipt.ok||receipt.pid!==j.host.pid||receipt.nonce!==nonce||receipt.hostVersion!==installed['@deepseek-ai/dsh']||receipt.modelAttempts!==0||receipt.modelAttemptScope!=='inspection_agents_only'||(receipt.gatewayBound!==false&&!(runId&&isManagedGatewayReceipt(receipt)))||receipt.rows?.length!==4||new URL(receipt.origin).hostname!=='127.0.0.1')fail('ADMISSION_FAILED');if(hash(await fs.readFile(defaultPatch))!==hash(defaultBytes))fail('DEFAULT_CONFIG_DRIFT');j.defaultConfig={path:defaultPatch,sha256:hash(defaultBytes),bytes:defaultBytes.length,preserved:true};j.nativeReceipt=receipt;j.state='host_ready';await io.save();return;}
   await new Promise(r=>setTimeout(r,250));
  }
  fail('OBSERVATION_EXPIRED');

 }finally{if(native?.stdin&&!native.stdin.writableEnded)native.stdin.end();}
}
export async function restartNativeHost(q,j,io){
 if(q.acknowledgeNativeResume!==true||j.restart?.nativeResumeAcknowledged!==true||j.restart?.consentContract!==1)fail('RESTART_CONSENT_REQUIRED');
 const runId=j.restart?.id;if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(runId??''))fail('RESTART_SCOPE');
 const base=path.join(q.root,'runtime'),control=path.join(q.root,'.control/runtime/restarts',runId),env=nativeEnvironment(q.root,process.execPath);
 const patch=JSON.parse(await fs.readFile(path.join(base,'native-overlay.yml')));
 validateNativeOverlay(patch,env,j.optionalIm===true);
 const nonce=j.restart.nonce,admission=patch[1].insert[1];
 admission.config={...admission.config,nonce,control};
 await fs.writeFile(path.join(control,'native-overlay.yml'),JSON.stringify(patch),{flag:'wx',mode:0o600});
 const defaultBytes=await fs.readFile(path.join(env.DSH_HOME,'profiles/web/cordis.patch.yml'));
 await launchNative(q,j,io,{control,nonce,defaultBytes,runId});
}
