import {Gateway} from '../bundle/index.js';
import {createOnboardingFileTransfer} from '../bundle/onboarding-file-transfer.js';
import {peerBindingKey} from '../bundle/onboarding-peer-binding.js';
import {createOnboardingTaskRuntime} from '../bundle/onboarding-task-runtime.js';
import {createOnboardingRepository} from '../bundle/onboarding-repository.js';
import {createOnboardingRepositories} from '../bundle/onboarding-repositories.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomUUID,randomBytes,createHash,createHmac} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {remoteControl} from '../bundle/onboarding-remote-control.js';
import {RUNTIME_COMMAND_LIMIT,runtimeProgram,runtimeCommand} from '../bundle/onboarding-runtime-program.js';
import {runProcess} from '../bundle/onboarding-ssh.js';
import {createOnboardingModels,ONBOARDING_PROVIDER} from '../bundle/onboarding-models.js';
import {createOnboardingTokenPlanModels,TOKEN_PLAN_PROVIDER} from '../bundle/onboarding-token-plan.js';
import {createOnboardingState} from '../bundle/onboarding-state.js';
import {createOnboardingIm} from '../bundle/onboarding-im.js';
const hash=x=>createHash('sha256').update(typeof x==='string'||Buffer.isBuffer(x)?x:JSON.stringify(x)).digest('hex');
const controller=await fs.readFile(new URL('../bundle/onboarding-remote-control.js',import.meta.url),'utf8'),extension=await fs.readFile(new URL('../bundle/onboarding-runtime-extension.js',import.meta.url),'utf8'),bridge=await fs.readFile(new URL('../bundle/onboarding-handoff-remote.js',import.meta.url),'utf8');
const program=runtimeProgram(controller,extension)+'\n'+bridge+'\nexport {runtimeInventory};';
const api=await import('data:text/javascript;base64,'+Buffer.from(program).toString('base64'));
const secret='sk-SYNTHETIC_REMOTE_HANDOFF_ONLY';
const signed=(x,q)=>({...x,signature:createHmac('sha256',q.proof).update(JSON.stringify(x)).digest('hex')});
async function fixture(t){
 const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'s56-handoff-')));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const installationId=randomUUID(),parent=dir+'/remote',root=parent+'/host-'+installationId,q={root,installationId,operationId:randomUUID(),proof:randomBytes(32).toString('hex'),planHash:hash('fixture')};
 const baseline=JSON.parse(await runProcess(process.execPath,[fileURLToPath(new URL('../bundle/onboarding-remote-probe.js',import.meta.url))],{input:JSON.stringify({parent,installationId}),env:{PATH:process.env.PATH}}));
 const files=['compatibility.json','onboarding-handoff-remote.js','onboarding-runtime-inventory.js','onboarding-task-runtime-contract.js','package.json'].map(n=>({name:n}));for(const f of files){const b=await fs.readFile(new URL('../bundle/'+f.name,import.meta.url));Object.assign(f,{path:'plugin/'+f.name,bytes:b.length,sha256:hash(b),mode:0o600,data:b.toString('base64')});delete f.name;}
 await remoteControl({...q,action:'prepare',baseline,files,manifestHash:hash(files.map(({data,...x})=>x))});
 await fs.mkdir(root+'/runtime/plugin',{recursive:true,mode:0o700});for(const f of files)await fs.writeFile(root+'/runtime/'+f.path,Buffer.from(f.data,'base64'),{mode:0o600});
 await fs.mkdir(root+'/.control/runtime',{mode:0o700});const records=new Map();let writes=0,requests=0,wrongRole=false,wrongPath=false,gateway=false,redirect=false,tokenCapability=true,imContract=1,imMissing=false,repositoryContract=1,registryContract=2,managedRuntime=null,runtimeEnabled=false,pairContract=1,probeContract=2,clarificationContract=1,modelCalls=0,probeRelease,fileContract=2,fileMigration=1,fileQueue=2,fileManager=null,fileGateway=null;const methods=[];
 const credentials={readRecord:async k=>structuredClone(records.get(k)),describeRecord:async()=>({writable:true}),modifyRecord:async(k,fn)=>{const v=fn(structuredClone(records.get(k)));if(v!==undefined){records.set(k,structuredClone(v));writes++;}}};
 const state=createOnboardingState({}, {},{credentials,home:root+'/runtime/native-home',env:{}}),dshHome=root+'/runtime/native-home/dsh',agentsHome=root+'/runtime/native-home/agents';
 let modelDeps,modelRegistered=false;const adapters=new Map(),llm={registerAdapter(ids,a){for(const id of ids)adapters.set(id,a);},listProviders:()=>[...(modelRegistered?[{id:ONBOARDING_PROVIDER,name:'DeepSeek（双端配置）'}]:[]),...[...adapters].map(([id,a])=>a.providerInfo(id))],listModels:p=>adapters.has(p)?adapters.get(p).listModels(p):modelDeps.discoverModels(p),resolveCallConfig:async p=>p};
 llm.prepareCall=async policy=>({config:policy,stream:async function*(){modelCalls++;await new Promise(r=>probeRelease=r);yield {type:'block-start',index:0,blockType:'text'};yield {type:'block-end',index:0,block:{type:'text',text:'mock only'}};yield {type:'finish',reason:{kind:'stop'}};}});t.after(()=>probeRelease?.());
 const runtimeManager=createOnboardingTaskRuntime({state:{available:()=>true},credentials:()=>credentials,config:{onboarding:{role:'cloud'}},platform:'linux',adapter:{async open(p){let active=true;return {id:p.id,instanceId:randomUUID(),workerEnabled:p.workerEnabled===true,hold(){},pairingKey:peerBindingKey(p.pairing),port:12345,forward:async frame=>({ok:true,value:frame}),active:()=>active,quiescent:async()=>{},close:async()=>{active=false;}};}}});t.after(()=>runtimeManager.close());
 const models=createOnboardingModels({}, {onboarding:{role:'cloud'}},{credentials,llm,platform:'linux',home:root+'/runtime/native-home',env:{},registerProvider(c,id,d){modelRegistered=true;modelDeps=d;}});
 const tokenModels=createOnboardingTokenPlanModels({}, {onboarding:{role:'cloud'}},{credentials,llm,platform:'linux',home:root+'/runtime/native-home',env:{}});
 const imService={contractVersion:1,listBots:async()=>[]};const im=createOnboardingIm({onboarding:{role:'cloud'}},{platform:'linux',get im(){return imMissing?undefined:imService;}});
 const repo=createOnboardingRepository({state,config:{onboarding:{role:'cloud'}},runtime:{platform:'linux',repositoryFetch:async(u,o)=>{assert(u.startsWith('https://gitee.com/api/v5/repos/fixture/task-results'));assert.equal(o.method,'GET');assert.equal(o.redirect,'error');return Response.json(u.includes('/branches/')?{name:'main',commit:{sha:'a'.repeat(40)}}:{id:9,full_name:'fixture/task-results',private:false,default_branch:'main'});}}});
 const registry=createOnboardingRepositories({state,credentials:()=>credentials,repository:repo,config:{onboarding:{role:'cloud'}},runtime:{platform:'linux'}});
 const server=http.createServer(async(req,res)=>{requests++;try{
  if(req.url.startsWith('/connect?')){res.writeHead(302,{'set-cookie':'fixture=SYNTHETIC_ONLY; HttpOnly','location':'/'});res.end();return;}
  assert.equal(req.url,'/api/task-onboarding/control');assert.equal(req.headers.cookie,'fixture=SYNTHETIC_ONLY');if(redirect){res.writeHead(307,{location:'http://exfil.invalid'});res.end();return;}
  const chunks=[];for await(const c of req)chunks.push(c);const b=JSON.parse(Buffer.concat(chunks)),{method,args}=b.payload;methods.push(method);let value;
  if(method==='describe')value={contract:1,configured:runtimeEnabled?(await runtimeManager.status()).configured:gateway,capabilities:{managedFileQueueReviewContract:fileQueue,managedFileScopeMigrationContract:fileMigration,managedFileTransferContract:fileContract,modelClarificationContract:clarificationContract,tokenModelClarificationContract:clarificationContract,modelProbeContract:probeContract,tokenModelProbeContract:probeContract,managedTaskRuntimeContract:runtimeEnabled?4:managedRuntime?1:0,managedPeerBindingContract:pairContract,repositoryRegistryContract:registryContract,repositoryCheckContract:repositoryContract,giteeCredentialReceipt:repositoryContract===1,giteeCredentialFence:repositoryContract===1,imInventoryContract:imContract,write:false,cloudCredentialReceipt:true,cloudCredentialFence:true,modelBinding:true,tokenPlanBinding:tokenCapability,tokenPlanCredentialReceipt:tokenCapability,tokenPlanCredentialFence:tokenCapability}};
  else if(method.startsWith('file_transfer_')&&fileManager)value=await fileManager[method.slice(14)](args);
  else if(method.startsWith('task_pair_')&&runtimeEnabled)value=await runtimeManager.pairing[method.slice(10)](args);
  else if(method.startsWith('task_runtime_')&&runtimeEnabled)value=await runtimeManager[method.slice(13)](args);
  else if(method==='task_runtime_status')value=managedRuntime;
  else if(method.startsWith('repository_registry_'))value=await registry[method.slice(20)](args);
  else if(method==='repository_inspect')value=await repo.inspect(args);
  else if(method==='im_inventory')value=await im.inventory(args);
  else if(method==='detect')value={role:wrongRole?'local':'cloud',platform:'linux',paths:{dsh:{path:wrongPath?'/unrelated':dshHome},agents:{path:agentsHome}}};
  else if(/^(?:token_)?model_probe_/.test(method))value=await (method.startsWith('token_')?tokenModels:models).probe[method.slice(method.lastIndexOf('_')+1)](args);
  else if(['model_status','model_preview','model_apply','model_resolve'].includes(method))value=await models[method.slice(6)](args);
  else if(['token_model_status','token_model_preview','token_model_apply','token_model_resolve'].includes(method))value=await tokenModels[method.slice(12)](args);
  else if(method==='secret_status')value=await state.secrets();else if(method==='secret_put')value=await state.put(args);else if(method==='secret_fence')value=await state.fence(args);else if(method==='secret_receipt')value=await state.secretReceipt(args);else throw Error('unsupported');
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({type:'server-response',rpcId:b.rpcId,result:{ok:true,value}}));
 }catch{res.writeHead(409);res.end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});
 const origin='http://127.0.0.1:'+server.address().port,stat=await fs.readFile('/proc/'+process.pid+'/stat','utf8'),host={pid:process.pid,platform:'linux',start:stat.slice(stat.lastIndexOf(')')+2).split(' ')[19],boot:(await fs.readFile('/proc/sys/kernel/random/boot_id','utf8')).trim()},nonce=randomUUID();
 const j={schema:1,id:randomUUID(),operationId:q.operationId,planHash:q.planHash,root,state:'host_ready',revision:1,fingerprint:hash('runtime'),host,worker:null,child:null,nativeNonce:nonce,nativeReceipt:{ok:true,nonce,pid:host.pid,origin,hostVersion:'0.2.1-rc.2',gatewayBound:false,dshHome,agentsHome}};
 const inv=JSON.stringify(signed({schema:1,operationId:q.operationId,runtimeId:j.id,items:await api.runtimeInventory(q)},q));await fs.writeFile(root+'/.control/runtime/inventory.json',inv,{mode:0o600});j.inventoryHash=hash(inv);
 const save=()=>fs.writeFile(root+'/.control/runtime/journal.json',JSON.stringify(signed(j,q)),{mode:0o600});await save();await fs.writeFile(root+'/.control/runtime/native-access.json',JSON.stringify({url:origin+'/?token=SYNTHETIC_ACCESS_ONLY'}),{mode:0o600});
 async function enableFiles(){const id=randomUUID(),owned=dshHome+'/dual-host-task-runtime/'+id;await fs.mkdir(owned+'/state',{recursive:true,mode:0o700});fileGateway=new Gateway({on(){},effect(){},agents:{list:()=>[]},agentPresets:{}},{role:'cloud',stateDir:owned+'/state',namespace:'managed-'+id,port:0,entryMode:'native',peerEnabled:false},{secrets:{localToken:'l'.repeat(32),cloudToken:'c'.repeat(32)}});fileManager=createOnboardingFileTransfer({g:fileGateway,root:owned,credentials:()=>credentials});t.after(async()=>{await fileManager.close();await fileGateway.close();});return owned;}
 return {fileGateway:()=>fileGateway,legacyFileQueue:()=>fileQueue=1,enableFiles,legacyFileMigration:()=>fileMigration=0,legacyFiles:()=>fileContract=1,q,root,j,save,state,records,legacyClarification:()=>clarificationContract=0,legacyProbe:()=>probeContract=1,modelCalls:()=>modelCalls,releaseProbe:()=>probeRelease?.(),legacyPair:()=>pairContract=0,enableRuntime:()=>runtimeEnabled=true,managed(s){gateway=true;managedRuntime=s;},writes:()=>writes,requests:()=>requests,role:()=>wrongRole=true,path:()=>wrongPath=true,gateway:()=>gateway=true,redirect:()=>redirect=true,legacyRegistry:()=>registryContract=1,legacyRepository:()=>repositoryContract=undefined,legacyToken:()=>tokenCapability=false,legacyIm:()=>imContract=undefined,missingIm:()=>imMissing=true,methods,call:(action,a={})=>api.handoffControl({...q,action:'handoff',handoff:{...a,action}})};
}
const linux={skip:process.platform!=='linux'};
test('handoff transport keeps program bounded; secret never goes into command arguments',()=>{const c=runtimeCommand('/usr/bin/node',program,'handoffCLI');assert(Buffer.byteLength(c)<=RUNTIME_COMMAND_LIMIT);assert(!c.includes(secret));assert.throws(()=>runtimeCommand('/usr/bin/node',program,'otherCLI'),/PROGRAM_REVIEW/);});
test('remote refuses URLs, arbitrary actions and malformed receipts before touching disk',async()=>{for(const h of [{action:'exec',command:'echo'},{action:'inspect',url:'http://exfil.invalid'},{action:'put',operation:randomUUID(),expectedRevision:0,targetHash:'a'.repeat(64),secret:'PRIVATE KEY'}])await assert.rejects(api.handoffControl({action:'handoff',root:'/not-used',operationId:randomUUID(),installationId:randomUUID(),proof:'a'.repeat(64),planHash:'b'.repeat(64),handoff:h}),/HANDOFF_ARGUMENTS/);});
test('real loopback HTTP plus signed owner and kernel identity: inspect, CAS write, receipt and idempotence',linux,async t=>{const f=await fixture(t),p=await f.call('inspect');assert.equal(p.revision,0);assert.equal(f.writes(),0);const a={operation:randomUUID(),expectedRevision:0,targetHash:hash(p.target),secret};const r=await f.call('put',a);assert(r.operationMatched&&r.configured&&!JSON.stringify(r).includes(secret));assert.equal(f.writes(),1);await f.call('put',a);assert.equal(f.writes(),1);const {secret:_,...query}=a;assert((await f.call('receipt',query)).operationMatched);assert.equal((await f.state.readManagedSecret('deepseek-local')).value,secret);});
for(const kind of ['role','path','gateway','redirect'])test('remote refuses '+kind+' mismatch without writing',linux,async t=>{const f=await fixture(t);f[kind]();await assert.rejects(f.call('inspect'),/HANDOFF_/);assert.equal(f.writes(),0);});
for(const kind of ['runtime-copy','source-copy','access-symlink','stopped-host','nonce'])test('owned runtime rejection: '+kind,linux,async t=>{const f=await fixture(t);if(kind==='runtime-copy')await fs.appendFile(f.root+'/runtime/plugin/package.json',' ');if(kind==='source-copy')await fs.appendFile(f.root+'/plugin/package.json',' ');if(kind==='access-symlink'){await fs.rename(f.root+'/.control/runtime/native-access.json',f.root+'/outside');await fs.symlink(f.root+'/outside',f.root+'/.control/runtime/native-access.json');}if(kind==='stopped-host'){f.j.host.start='0';await f.save();}if(kind==='nonce'){f.j.nativeNonce=randomUUID();await f.save();}await assert.rejects(f.call('inspect'),/RUNTIME_(?:HOST_)?SOURCE_CHANGED|HANDOFF_|FILE_REVIEW/);assert.equal(f.requests(),0);assert.equal(f.writes(),0);});
test('destination target drift rejects before secret write',linux,async t=>{const f=await fixture(t),p=await f.call('inspect');await assert.rejects(f.call('put',{operation:randomUUID(),expectedRevision:0,targetHash:hash({...p.target,runtimeId:randomUUID()}),secret}),/HANDOFF_TARGET_CHANGED/);assert.equal(f.writes(),0);});

test('remote revision fence advances only an owned slot and blocks delayed put, with no Key in response',linux,async t=>{
 const f=await fixture(t),p=await f.call('inspect');assert.equal(p.fencingSupported,true);const a={operation:randomUUID(),expectedRevision:0,targetHash:hash(p.target)};
 const r=await f.call('fence',a);assert.equal(r.operationMatched,true);assert.equal(r.configured,false);assert.equal(r.revision,1);await f.call('fence',a);assert.equal(f.writes(),1);
 await assert.rejects(f.call('put',{...a,operation:randomUUID(),secret}),/HANDOFF_RESPONSE_REVIEW/);assert.equal((await f.state.readManagedSecret('deepseek-local')).value,null);
 await assert.rejects(f.call('fence',{...a,secret}),/HANDOFF_ARGUMENTS/);
});

test('cloud model bridge uses native API under validated runtime, supports status/preview/apply/catalog, no default or inference',linux,async t=>{
 const f=await fixture(t),s=await f.call('model_status');assert.equal(s.value.state,'not_configured');
 await f.state.put({slot:'deepseek-local',expectedRevision:0,operation:randomUUID(),secret,confirm:true});const p=await f.call('model_preview',{enabled:true});assert.equal(p.value.modelRequests,0);
 const request={id:p.value.id,fingerprint:p.value.fingerprint,confirm:true,targetHash:hash(p.target)};
 await assert.rejects(f.call('model_apply',{...request,targetHash:'b'.repeat(64)}),/HANDOFF_TARGET_CHANGED/);assert.equal(f.writes(),1);
 const enabled=await f.call('model_apply',request);assert.equal(enabled.value.state,'configured_unverified');assert.equal(enabled.value.appliedOperation,p.value.id);assert.equal(f.writes(),2);
 assert.equal((await f.call('model_resolve',{query:'ds flash'})).value.status,'resolved');
 for(const a of [{action:'model_preview',enabled:true,secret},{action:'model_resolve',query:'ds flash',provider:'injected'},{action:'model_status',url:'http://unrelated'}])await assert.rejects(api.handoffControl({...f.q,action:'handoff',handoff:a}),/HANDOFF_ARGUMENTS/);
});


test('ready Host with a finishing installer worker is explicitly not ready until worker exits',linux,async t=>{
 const f=await fixture(t);f.j.worker=f.j.host;await f.save();
 await assert.rejects(f.call('inspect'),/ONBOARDING_CLOUD_HANDOFF_HOST_NOT_READY/);
 await assert.rejects(f.call('model_status'),/ONBOARDING_CLOUD_HANDOFF_HOST_NOT_READY/);
 assert.equal(f.requests(),0);assert.equal(f.writes(),0);
 f.j.worker=null;await f.save();assert.equal((await f.call('model_status')).value.state,'not_configured');
});

test('token bridge on real loopback validates independent slot, fence and delayed-write rejection',linux,async t=>{
 const f=await fixture(t),p=await f.call('token_inspect');assert.equal(p.slot,'token-plan');assert.equal(p.revision,0);
 const a={operation:randomUUID(),expectedRevision:0,targetHash:hash(p.target)};
 await f.call('token_fence',a);await assert.rejects(f.call('token_put',{...a,operation:randomUUID(),secret}),/HANDOFF_RESPONSE_REVIEW/);
 const r=await f.call('token_put',{...a,operation:randomUUID(),expectedRevision:1,secret});assert.equal(r.revision,2);assert(r.operationMatched);
 assert.equal((await f.state.readManagedSecret('deepseek-local')).value,null);assert.equal((await f.state.readManagedSecret('token-plan')).value,secret);
});
test('token model bridge talks to public native adapter under signed target ownership',linux,async t=>{
 const f=await fixture(t);await f.state.put({slot:'token-plan',expectedRevision:0,operation:randomUUID(),confirm:true,secret});
 const p=await f.call('token_model_preview',{enabled:true});assert.equal(p.value.credentialSlot,'token-plan');assert.equal(p.value.provider,TOKEN_PLAN_PROVIDER);
 const r=await f.call('token_model_apply',{id:p.value.id,fingerprint:p.value.fingerprint,confirm:true,targetHash:hash(p.target)});assert.equal(r.value.state,'configured_unverified');assert.equal(r.value.provider,TOKEN_PLAN_PROVIDER);
 assert.equal((await f.call('model_status')).value.state,'not_configured');assert.equal((await f.call('token_model_resolve',{query:'glm 5.3'})).value.status,'resolved');
});
test('legacy target capabilities reject token actions while DeepSeek remains usable',linux,async t=>{
 const f=await fixture(t);f.legacyToken();for(const action of ['token_inspect','token_model_status'])await assert.rejects(f.call(action),/HANDOFF_TOKEN_UNSUPPORTED/);
 assert.equal((await f.call('inspect')).slot,'deepseek-local');assert.equal(f.writes(),0);
});
test('token action cannot inject service, slot, URL or downgrade its target binding',async()=>{
 const q={action:'handoff',root:'/unused',operationId:randomUUID(),installationId:randomUUID(),proof:'a'.repeat(64),planHash:'b'.repeat(64)};
 for(const handoff of [{action:'token_inspect',slot:'deepseek-local'},{action:'token_model_status',url:'http://invalid'}, {action:'token_model_preview',enabled:true,service:'deepseek'}, {action:'token_put',operation:randomUUID(),expectedRevision:0,secret,targetHash:'bad'}])await assert.rejects(api.handoffControl({...q,handoff}),/HANDOFF_ARGUMENTS/);
});

test('cloud IM over real loopback transport validates kernel identity and uses only public read methods',linux,async t=>{
 const f=await fixture(t),r=await f.call('im_inventory');assert.equal(r.value.state,'no_bots');assert.equal(r.value.target.role,'cloud');assert.equal(r.target.runtimeId,f.j.id);assert.equal(f.writes(),0);assert.deepEqual(f.methods,['describe','detect','im_inventory']);
 f.missingIm();assert.equal((await f.call('im_inventory')).value.state,'missing_dependency');assert.equal(f.writes(),0);
});
test('legacy cloud IM contract refuses inventory without trying local fallback',linux,async t=>{
 const f=await fixture(t);f.legacyIm();await assert.rejects(f.call('im_inventory'),/HANDOFF_IM_UNSUPPORTED/);assert.deepEqual(f.methods,['describe','detect']);assert.equal(f.writes(),0);
});
test('cloud IM arbitrary target or credential arguments rejected before any request',linux,async t=>{
 const f=await fixture(t);for(const args of [{url:'http://unrelated'},{appSecret:'nope'},{confirm:true},{botId:'other'}])await assert.rejects(f.call('im_inventory',args),/HANDOFF_ARGUMENTS/);assert.equal(f.requests(),0);assert.equal(f.writes(),0);
});
test('cloud IM never observes a stopped or mismatched owned runtime',linux,async t=>{
 const f=await fixture(t);f.j.host.start='0';await f.save();await assert.rejects(f.call('im_inventory'),/HANDOFF_HOST_NOT_READY/);assert.equal(f.requests(),0);assert.equal(f.writes(),0);
});

test('Web bootstrap validates the live managed native Host, secret returned only to internal transport',linux,async t=>{
 const f=await fixture(t),r=await f.call('web_access');assert.equal(r.target.runtimeId,f.j.id);assert.equal(r.value.token,'SYNTHETIC_ACCESS_ONLY');assert.equal(r.value.nativeNonce,f.j.nativeNonce);assert.equal(r.value.port,new URL(f.j.nativeReceipt.origin).port*1);assert.deepEqual(f.methods,['describe','detect']);assert.equal(f.writes(),0);
 for(const a of [{url:'http://arbitrary'},{port:22},{botId:'daily'}])await assert.rejects(f.call('web_access',a),/HANDOFF_ARGUMENTS/);
 f.j.host.start='0';await f.save();await assert.rejects(f.call('web_access'),/HANDOFF_HOST_NOT_READY/);
});


test('signed native Gitee bridge uses its own credential slot and read-only metadata API',linux,async t=>{
 const f=await fixture(t),p=await f.call('gitee_inspect');assert.equal(p.slot,'gitee');assert.equal(f.writes(),0);
 const a={operation:randomUUID(),expectedRevision:0,targetHash:hash(p.target),secret};await f.call('gitee_put',a);assert.equal((await f.state.readManagedSecret('gitee')).value,secret);assert.equal((await f.state.readManagedSecret('deepseek-local')).value,null);
 const r=await f.call('repository_inspect',{url:'https://gitee.com/fixture/task-results',branch:'',authentication:'managed'});assert.equal(r.value.repository.repository_id,9);assert.equal(r.value.writeAuthorized,false);assert.equal(r.value.credentialRevision,1);assert.equal(f.writes(),1);
 await f.call('gitee_fence',{operation:randomUUID(),expectedRevision:1,targetHash:hash(p.target)});await assert.rejects(f.call('gitee_put',{...a,operation:randomUUID(),expectedRevision:1}),/HANDOFF_RESPONSE_REVIEW/);
});
test('native Gitee capability is mandatory and cannot be inferred from model support',linux,async t=>{
 const f=await fixture(t);f.legacyRepository();for(const a of ['gitee_inspect','repository_inspect'])await assert.rejects(f.call(a,a==='repository_inspect'?{url:'https://gitee.com/fixture/task-results',branch:'',authentication:'anonymous'}:{}),/HANDOFF_REPOSITORY_UNSUPPORTED/);assert.equal(f.writes(),0);
});

test('signed target registry bridge confirms only bound target and preserves entries when fencing',linux,async t=>{
 const f=await fixture(t),args={url:'https://gitee.com/fixture/task-results',alias:'成果库',authentication:'anonymous',enabled:true};
 const p=await f.call('repository_registry_preview',args),a={id:p.value.id,fingerprint:p.value.fingerprint,confirm:true,targetHash:hash(p.target)};
 await assert.rejects(f.call('repository_registry_apply',{...a,targetHash:'b'.repeat(64)}),/HANDOFF_TARGET_CHANGED/);assert.equal(f.writes(),0);
 const r=await f.call('repository_registry_apply',a);assert.equal(r.value.revision,1);assert.equal(r.value.entries[0].alias,'成果库');assert.equal(r.value.runtimeConfigured,false);
 const fence=await f.call('repository_registry_fence',{operation:randomUUID(),expectedRevision:1,confirm:true,targetHash:hash(p.target)});assert.equal(fence.value.revision,2);assert.deepEqual(fence.value.entries,r.value.entries);
 const status=await f.call('repository_registry_status',{targetHash:hash(p.target)});assert.equal(status.value.revision,2);assert.equal(f.writes(),2);
});
test('old registry contract rejects all registration actions without writes or fallback',linux,async t=>{
 const f=await fixture(t);f.legacyRegistry();await assert.rejects(f.call('repository_registry_status'),/HANDOFF_REPOSITORY_UNSUPPORTED/);assert.equal(f.writes(),0);assert(!f.methods.includes('repository_registry_status'));
});
test('registry remote arguments cannot choose URL endpoint or omit mutation target binding',async()=>{
 const q={action:'handoff',root:'/unused',operationId:randomUUID(),installationId:randomUUID(),proof:'a'.repeat(64),planHash:'b'.repeat(64)};
 for(const handoff of [{action:'repository_registry_apply',id:randomUUID(),fingerprint:'a'.repeat(64),confirm:true},{action:'repository_registry_fence',operation:randomUUID(),expectedRevision:0,confirm:true},{action:'repository_registry_status',url:'https://unrelated'},{action:'repository_registry_preview',url:'https://gitee.com/a/b',alias:'b',authentication:'anonymous',enabled:true,secret:'NO'}])await assert.rejects(api.handoffControl({...q,handoff}),/HANDOFF_ARGUMENTS/);
});

test('managed intake runtime remains eligible for Gitee reads before and after restart receipt',linux,async t=>{
 const f=await fixture(t),s={contract:1,available:true,owned:true,scope:'current_host_only',role:'cloud',configured:true,desiredEnabled:true,state:'active',id:randomUUID(),instanceId:randomUUID(),appliedOperation:randomUUID(),appliedPlanHash:'a'.repeat(64),revision:1,listen:'127.0.0.1',port:12345,repositoryRuntime:true,workerEnabled:false,peerEnabled:false,writeAuthorized:false,publishEnabled:false,error:null};
 f.managed(s);assert.equal((await f.call('gitee_inspect')).slot,'gitee');assert.equal(f.writes(),0);
 f.j.nativeReceipt={...f.j.nativeReceipt,gatewayBound:true,runtimeScopeVerified:true,taskRuntime:s};await f.save();assert.equal((await f.call('gitee_inspect')).slot,'gitee');assert.equal(f.writes(),0);
 f.managed({...s,workerEnabled:true});await assert.rejects(f.call('gitee_inspect'),/HANDOFF_IDENTITY_REVIEW/);assert.equal(f.writes(),0);
});
test('unverified bound-gateway receipt is not accepted by merely exposing managed capability',linux,async t=>{
 const f=await fixture(t);f.j.nativeReceipt.gatewayBound=true;await f.save();await assert.rejects(f.call('inspect'),/HANDOFF_HOST_NOT_READY/);assert.equal(f.requests(),0);
});

test('cloud runtime bridge requires advertised contract and target-bound consent; status never activates',linux,async t=>{
 const f=await fixture(t);await assert.rejects(f.call('task_runtime_status'),/HANDOFF_TASK_RUNTIME_UNSUPPORTED/);assert.equal(f.writes(),0);f.enableRuntime();const s=await f.call('task_runtime_status');assert.equal(s.value.state,'not_configured');const p=await f.call('task_runtime_preview',{enabled:true});assert.equal(f.writes(),0);
 const a={id:p.value.id,fingerprint:p.value.fingerprint,confirm:true,targetHash:hash(p.target)};await assert.rejects(f.call('task_runtime_apply',{...a,targetHash:'b'.repeat(64)}),/HANDOFF_TARGET_CHANGED/);assert.equal(f.writes(),0);const v=await f.call('task_runtime_apply',a);assert(v.value.configured);assert(!v.value.workerEnabled&&!v.value.writeAuthorized);
 const fenced=await f.call('task_runtime_fence',{operation:randomUUID(),expectedRevision:1,confirm:true,targetHash:hash(p.target)});assert(fenced.value.configured&&fenced.value.desiredEnabled);assert.equal(fenced.value.revision,2);assert.equal((await f.call('gitee_inspect')).slot,'gitee');
});
test('cloud runtime mutations cannot omit target binding or inject configuration',async()=>{
 const q={action:'handoff',root:'/unused',operationId:randomUUID(),installationId:randomUUID(),proof:'a'.repeat(64),planHash:'b'.repeat(64)};
 for(const handoff of [{action:'task_runtime_apply',id:randomUUID(),fingerprint:'a'.repeat(64),confirm:true},{action:'task_runtime_fence',operation:randomUUID(),expectedRevision:0,confirm:true},{action:'task_runtime_preview',enabled:true,worker:true},{action:'task_runtime_status',url:'https://unrelated'}])await assert.rejects(api.handoffControl({...q,handoff}),/HANDOFF_ARGUMENTS/);
});


test('peer binding bridge requires advertised capability, target hash and separate consent',linux,async t=>{
 const f=await fixture(t);f.enableRuntime();const p=await f.call('task_runtime_preview',{enabled:true}),targetHash=hash(p.target);await f.call('task_runtime_apply',{id:p.value.id,fingerprint:p.value.fingerprint,confirm:true,targetHash});
 const localId=randomUUID(),v=await f.call('task_pair_preview',{enabled:true,localId,targetHash});assert.equal(f.writes(),1);await assert.rejects(f.call('task_pair_apply',{id:v.value.id,fingerprint:v.value.fingerprint,confirm:true,targetHash:'b'.repeat(64)}),/TARGET_CHANGED/);
 const s=(await f.call('task_pair_apply',{id:v.value.id,fingerprint:v.value.fingerprint,confirm:true,targetHash})).value;assert(s.enabled&&s.mounted);assert.equal((await f.call('gitee_inspect')).slot,'gitee');
 const a={id:s.id,localId,revision:s.revision,frame:{method:'catalog',args:{}},targetHash};assert.deepEqual((await f.call('task_pair_forward',a)).value,{ok:true,value:a.frame});
 await assert.rejects(f.call('task_pair_forward',{...a,targetHash:'b'.repeat(64)}),/TARGET_CHANGED/);f.legacyPair();await assert.rejects(f.call('task_pair_status'),/PAIR_UNSUPPORTED/);
});
test('peer bridge refuses missing target, unbounded frames and injected URLs before disk or network',async()=>{
 const q={action:'handoff',root:'/unused',operationId:randomUUID(),installationId:randomUUID(),proof:'a'.repeat(64),planHash:'b'.repeat(64)};
 for(const handoff of [{action:'task_pair_preview',enabled:true,localId:randomUUID()},{action:'task_pair_apply',id:randomUUID(),fingerprint:'a'.repeat(64),confirm:true},{action:'task_pair_status',url:'https://invalid'},{action:'task_pair_forward',id:randomUUID(),localId:randomUUID(),revision:1,frame:{args:'x'.repeat(131073)},targetHash:'a'.repeat(64)}])await assert.rejects(api.handoffControl({...q,handoff}),/HANDOFF_ARGUMENTS/);
});

test('archived bridge starts a live async model probe and returns while inference remains pending',linux,async t=>{
 const f=await fixture(t);await f.state.put({slot:'deepseek-local',expectedRevision:0,operation:randomUUID(),secret,confirm:true});
 const enabled=await f.call('model_preview',{enabled:true});await f.call('model_apply',{id:enabled.value.id,fingerprint:enabled.value.fingerprint,confirm:true,targetHash:hash(enabled.target)});
 const p=await f.call('model_probe_preview',{query:'ds flash',acknowledgeUnknown:null});assert.equal(f.modelCalls(),0);
 const a={id:p.value.id,fingerprint:p.value.fingerprint,confirm:true,targetHash:hash(p.target)};
 await assert.rejects(f.call('model_probe_start',{...a,targetHash:'0'.repeat(64)}),/TARGET_CHANGED/);assert.equal(f.modelCalls(),0);
 const started=await f.call('model_probe_start',a);assert.equal(started.value.receipt.state,'running');assert.equal(f.modelCalls(),1);assert.equal((await f.call('model_probe_status')).value.receipt.id,p.value.id);
 await f.call('model_probe_start',a);assert.equal(f.modelCalls(),1);f.releaseProbe();await new Promise(r=>setImmediate(r));assert.equal((await f.call('model_probe_status')).value.receipt.state,'succeeded');
 await assert.rejects(f.call('model_probe_apply',a),/ARGUMENTS/);
});
test('legacy live model probe contract is refused without inference or fallback',linux,async t=>{const f=await fixture(t);f.legacyProbe();await assert.rejects(f.call('model_probe_status'),/MODEL_PROBE_UNSUPPORTED/);await assert.rejects(f.call('token_model_probe_status'),/MODEL_PROBE_UNSUPPORTED/);assert.equal(f.modelCalls(),0);assert(!f.methods.includes('model_probe_status'));});

test('remote natural clarification is capability gated for both services before dispatch',linux,async t=>{
 const f=await fixture(t);for(const prefix of ['', 'token_'])assert.equal((await f.call(prefix+'model_resolve',{query:'ds flash',clarification:'请用 DeepSeek（双端配置）'})).value.status,'not_found');f.legacyClarification();
 for(const prefix of ['', 'token_'])for(const action of ['model_resolve','model_probe_preview']){const n=f.methods.filter(x=>x===prefix+action).length;await assert.rejects(f.call(prefix+action,{query:'ds flash',clarification:'请用 DeepSeek（双端配置）',...(action==='model_probe_preview'?{acknowledgeUnknown:null}:{})}),/HANDOFF_MODEL_CLARIFICATION_UNSUPPORTED/);assert.equal(f.methods.filter(x=>x===prefix+action).length,n);}
 assert.equal(f.modelCalls(),0);assert.equal(f.writes(),0);
});


test('signed remote file bridge uses capability 2 and native file manager, with target-bound apply/fence',linux,async t=>{
 const f=await fixture(t),root=await f.enableFiles();const s=await f.call('file_transfer_status');assert.equal(s.value.contract,2);assert.equal(s.value.state,'not_configured');const p=await f.call('file_transfer_preview',{enabled:true,sendRoots:[],maxBytes:1024});assert.equal(p.value.scope.root,root);const r=await f.call('file_transfer_apply',{id:p.value.id,fingerprint:p.value.fingerprint,confirm:true,targetHash:hash(p.target)});assert(r.value.active);const count=f.writes();const fence=await f.call('file_transfer_fence',{operation:randomUUID(),expectedRevision:r.value.revision,confirm:true,targetHash:hash(p.target)});assert(fence.value.active&&fence.value.enabled);assert.equal(fence.value.revision,r.value.revision+1);assert.equal(f.writes(),count+1);
});
test('old file capability or changed destination refuses before any file grant',linux,async t=>{
 const f=await fixture(t);await f.enableFiles();const p=await f.call('file_transfer_preview',{enabled:true,sendRoots:[],maxBytes:1024});await assert.rejects(f.call('file_transfer_apply',{id:p.value.id,fingerprint:p.value.fingerprint,confirm:true,targetHash:hash({...p.target,runtimeId:randomUUID()})}),/HANDOFF_TARGET_CHANGED/);assert.equal(f.writes(),0);f.legacyFiles();await assert.rejects(f.call('file_transfer_status'),/HANDOFF_FILES_UNSUPPORTED/);assert.equal(f.writes(),0);
});
test('malformed file bridge arguments are refused before source or network reads',async()=>{
 const q={action:'handoff',root:'/not-used',operationId:randomUUID(),installationId:randomUUID(),proof:'a'.repeat(64),planHash:'b'.repeat(64)};for(const handoff of [{action:'file_transfer_status',secret:'NO'},{action:'file_transfer_preview',enabled:true,sendRoots:['/tmp/x'],maxBytes:2097153},{action:'file_transfer_apply',id:randomUUID(),fingerprint:'a'.repeat(64),confirm:true},{action:'file_transfer_fence',operation:randomUUID(),expectedRevision:1,confirm:true,targetHash:'a'.repeat(64),receiveRoot:'/bad'}])await assert.rejects(api.handoffControl({...q,handoff}),/HANDOFF_ARGUMENTS/);
});

test('signed remote file migration validates native capability, stays disabled and recovers exact receipt',linux,async t=>{
 const f=await fixture(t),root=await f.enableFiles();let p=await f.call('file_transfer_preview',{enabled:true,sendRoots:[],maxBytes:1024});const targetHash=hash(p.target);await f.call('file_transfer_apply',{id:p.value.id,fingerprint:p.value.fingerprint,confirm:true,targetHash});p=await f.call('file_transfer_preview',{enabled:false,sendRoots:[],maxBytes:1024});await f.call('file_transfer_apply',{id:p.value.id,fingerprint:p.value.fingerprint,confirm:true,targetHash});
 const source=f.root+'/migration-test-source';await fs.mkdir(source,{mode:0o700});p=await f.call('file_transfer_migrationPreview',{sendRoots:[source],maxBytes:512});assert.equal(p.value.kind,'scope_migration');assert.equal(p.value.scope.root,root);const applied=await f.call('file_transfer_apply',{id:p.value.id,fingerprint:p.value.fingerprint,confirm:true,targetHash});assert.equal(applied.value.state,'disabled');assert.equal(applied.value.revision,3);const count=f.writes();const result=await f.call('file_transfer_migrationRecover',{operation:p.value.id,confirm:true,targetHash});assert(result.value.notReapplied);assert.equal(f.writes(),count);await assert.rejects(f.call('file_transfer_migrationRecover',{operation:p.value.id,confirm:true,targetHash:'f'.repeat(64)}),/HANDOFF_TARGET_CHANGED/);
});
test('native file migration is not inferred from basic file support',linux,async t=>{
 const f=await fixture(t);await f.enableFiles();f.legacyFileMigration();await assert.rejects(f.call('file_transfer_migrationPreview',{sendRoots:[],maxBytes:1024}),/HANDOFF_FILES_MIGRATION_UNSUPPORTED/);assert.equal(f.writes(),0);
});
test('migration bridge refuses hidden enable, destination override and missing recovery identity before I/O',async()=>{
 const q={action:'handoff',root:'/not-used',operationId:randomUUID(),installationId:randomUUID(),proof:'a'.repeat(64),planHash:'b'.repeat(64)};
 for(const handoff of [{action:'file_transfer_migrationPreview',sendRoots:[],maxBytes:1024,enabled:true},{action:'file_transfer_migrationPreview',sendRoots:[],maxBytes:1024,receiveRoot:'/bad'},{action:'file_transfer_migrationRecover',operation:randomUUID(),confirm:true}])await assert.rejects(api.handoffControl({...q,handoff}),/HANDOFF_ARGUMENTS/);
});
test('signed file queue bridge calls the target public contract and preserves per-item receipts',linux,async t=>{
 const f=await fixture(t),root=await f.enableFiles();let p=await f.call('file_transfer_preview',{enabled:true,sendRoots:[],maxBytes:1024});const targetHash=hash(p.target);await f.call('file_transfer_apply',{id:p.value.id,fingerprint:p.value.fingerprint,confirm:true,targetHash});const file=root+'/files/outbox/bridge.txt',id='file-'+hash('queue bridge');await fs.writeFile(file,'KEEP');await f.fileGateway().files.enqueue({id,task_id:'task-'+randomUUID(),file});p=await f.call('file_transfer_preview',{enabled:false,sendRoots:[],maxBytes:1024});await f.call('file_transfer_apply',{id:p.value.id,fingerprint:p.value.fingerprint,confirm:true,targetHash});
 const next=f.root+'/review-source';await fs.mkdir(next);p=await f.call('file_transfer_migrationPreview',{sendRoots:[next],maxBytes:1024});await f.call('file_transfer_apply',{id:p.value.id,fingerprint:p.value.fingerprint,confirm:true,targetHash});const list=await f.call('file_transfer_queueList',{targetHash});assert.equal(list.value.items[0].name,'bridge.txt');p=await f.call('file_transfer_queueReviewPreview',{item:list.value.items[0].item,decision:'resume',targetHash});assert.equal(p.value.contract,2);const receipt=await f.call('file_transfer_queueReviewApply',{id:p.value.id,fingerprint:p.value.fingerprint,confirm:true,targetHash});assert.equal(receipt.value.stateAtDecision,'queued');const query={operation:p.value.id,fingerprint:p.value.fingerprint,targetHash};assert.equal((await f.call('file_transfer_queueReviewStatus',query)).value.receipt.operation,p.value.id);assert.equal((await f.call('file_transfer_queueReviewClose',{...query,confirm:true})).value.closed,false);const original=await fs.readFile(file,'utf8');assert.equal(original,'KEEP');assert(!f.fileGateway().files);
});
test('old target queue contract and wrong target are rejected without queue writes',linux,async t=>{
 const f=await fixture(t);await f.enableFiles();const s=await f.call('file_transfer_status');const targetHash=hash(s.target);await assert.rejects(f.call('file_transfer_queueList',{targetHash:'f'.repeat(64)}),/HANDOFF_TARGET_CHANGED/);f.legacyFileQueue();await assert.rejects(f.call('file_transfer_queueList',{targetHash}),/HANDOFF_FILES_QUEUE_UNSUPPORTED/);assert.equal(f.writes(),0);
});
test('malformed file review commands stop before runtime access',linux,async()=>{
 const q={action:'handoff',root:'/not-used',operationId:randomUUID(),installationId:randomUUID(),proof:'a'.repeat(64),planHash:'b'.repeat(64)};for(const handoff of [{action:'file_transfer_queueList'},{action:'file_transfer_queueReviewPreview',targetHash:'a'.repeat(64),item:{queue:'outgoing',id:'file-'+ 'b'.repeat(64),origin:'cloud'},decision:'resume'},{action:'file_transfer_queueReviewStatus',targetHash:'a'.repeat(64),operation:randomUUID(),fingerprint:'bad'},{action:'file_transfer_queueReviewClose',targetHash:'a'.repeat(64),operation:randomUUID(),fingerprint:'b'.repeat(64),confirm:false}])await assert.rejects(api.handoffControl({...q,handoff}),/HANDOFF_ARGUMENTS/);
});

test('contract 4 bridge carries only explicit worker consent and keeps repository checks available',linux,async t=>{
 const f=await fixture(t);f.enableRuntime();const p=await f.call('task_runtime_preview',{enabled:true,workerEnabled:true});assert.equal(p.value.contract,4);assert(p.value.workerEnabled);const r=await f.call('task_runtime_apply',{id:p.value.id,fingerprint:p.value.fingerprint,confirm:true,targetHash:hash(p.target)});assert(r.value.workerEnabled&&r.value.workerDesiredEnabled);assert(!r.value.writeAuthorized&&!r.value.publishEnabled);assert.equal((await f.call('gitee_inspect')).slot,'gitee');
});
