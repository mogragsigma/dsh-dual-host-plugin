// Read-only snapshot, NOT an ingress barrier. Only the original managed Host
// and its public plugin RPC are consulted. Never follow/activate a session.
import path from 'node:path';
import {randomUUID} from 'node:crypto';
const count=n=>Number.isSafeInteger(n)&&n>=0;
const keys=(v,k)=>v&&Object.keys(v).sort().join()===k.slice().sort().join();
export async function observeRuntimeHost(api,q,j,options={}){
 const {regular,runtimeAlive,runtimeSource,checkAncestors,fail}=api;
 const base=path.join(q.root,'runtime'),control=path.join(q.root,'.control/runtime',...(j.restart?['restarts',j.restart.id]:[]));
 if(j.state!=='host_ready'||j.nativeReceipt?.ok!==true||j.nativeReceipt.pid!==j.host?.pid||j.nativeReceipt.nonce!==j.nativeNonce||!await runtimeAlive(j.host))fail('RUNTIME_HOST_OBSERVATION_REQUIRED');
 if(j.nativeReceipt.dshHome!==path.join(base,'native-home/dsh')||j.nativeReceipt.agentsHome!==path.join(base,'native-home/agents'))fail('RUNTIME_HOST_IDENTITY_REVIEW');
 const source=await runtimeSource(q);
 if(api.runtimeVerifyPlugin)await api.runtimeVerifyPlugin(q,j);
 else for(const f of source.owner.manifest){const p=path.join(base,f.path);await checkAncestors(path.dirname(p));const r=await regular(p);if(!r||r.sha256!==f.sha256||r.identity.mode!==f.mode||r.identity.uid!==process.getuid())fail('RUNTIME_HOST_SOURCE_CHANGED');}
 await checkAncestors(control);const r=await regular(path.join(control,'native-access.json'),16384);
 if(!r||r.identity.mode!==0o600||r.identity.uid!==process.getuid())fail('RUNTIME_HOST_ACCESS_REVIEW');
 let url;try{url=new URL(JSON.parse(r.data).url);}catch{fail('RUNTIME_HOST_ACCESS_REVIEW');}
 if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.pathname!=='/'||url.hash||url.origin!==j.nativeReceipt.origin||[...url.searchParams.keys()].join()!=='token'||!url.searchParams.get('token'))fail('RUNTIME_HOST_ACCESS_REVIEW');
 const login=new URL('/connect',url.origin);login.searchParams.set('token',url.searchParams.get('token'));login.searchParams.set('interactions','none');
 const response=await fetch(login,{redirect:'manual',signal:AbortSignal.timeout(3000)}),cookie=response.headers.get('set-cookie')?.split(';')[0];
 if(response.status!==302||!cookie||/[\r\n]/.test(cookie))fail('RUNTIME_HOST_AUTH_FAILED');
 async function rpc(method){
  const rpcId=randomUUID(),res=await fetch(new URL('/api/task-onboarding/control',url.origin),{method:'POST',redirect:'manual',headers:{'content-type':'application/json',cookie},body:JSON.stringify({type:'client-request',rpcId,method:'task-onboarding/control',payload:{method,args:{}}}),signal:AbortSignal.timeout(3000)});
  if(!res.ok)fail('RUNTIME_HOST_RESPONSE_REVIEW');let size=0;const chunks=[];for await(const c of res.body){size+=c.length;if(size>262144)fail('RUNTIME_HOST_RESPONSE_REVIEW');chunks.push(c);}
  let v;try{v=JSON.parse(Buffer.concat(chunks));}catch{fail('RUNTIME_HOST_RESPONSE_REVIEW');}
  if(v?.type!=='server-response'||v.rpcId!==rpcId||v.result?.ok!==true)fail('RUNTIME_HOST_RESPONSE_REVIEW');return v.result.value;
 }
 const joint=await rpc('coordinated_hold_status'),own=await rpc('onboarding_hold_status'),agents=await rpc('agent_hold_status'),im=j.optionalIm?await rpc('im_maintenance_status'):null;
 if(joint?.contract!==1||joint.scope!=='coordinated_components_only'||own?.contract!==1||own.scope!=='own_onboarding_only'||agents?.contract!==1||agents.scope!=='native_agents_only'||!keys(agents.counts,['agents','running','unsupported','held','pendingNextTurn','pendingNextStep','inboxUnknown'])||!keys(own.counts,['rpc','startup','model_attempt','workbench_http','workbench_websocket']))fail('RUNTIME_HOST_RESPONSE_REVIEW');
 const rows=joint.components,gateway=rows?.gateway;
 if(rows?.onboarding?.instanceId!==own.instanceId||rows?.agents?.instanceId!==agents.instanceId||typeof own.instanceId!=='string'||typeof agents.instanceId!=='string'||!gateway||!Object.values(own.counts).every(count)||!Object.values(agents.counts).every(count))fail('RUNTIME_HOST_RESPONSE_REVIEW');
 if(gateway.state!=='not_configured'&&(!gateway.counts||!Object.keys(gateway.counts).length||!Object.values(gateway.counts).every(count)||typeof gateway.instanceId!=='string'))fail('RUNTIME_HOST_RESPONSE_REVIEW');
 if(im&&(im.contract!==1||im.inventoryState!=='observed'||typeof im.pending!=='boolean'||typeof im.operationInFlight!=='boolean'||typeof im.instanceId!=='string'))fail('RUNTIME_HOST_RESPONSE_REVIEW');
 const reasons=[];
 if(!['open','held'].includes(joint.state)||!['open','held'].includes(own.state)||!['open','held'].includes(agents.state)||!['not_configured','open','held'].includes(gateway.state))reasons.push('component_unavailable');
 if(Object.values(own.counts).some(n=>n!==0)||gateway.counts&&Object.values(gateway.counts).some(n=>n!==0))reasons.push('own_work_active');
 if(agents.counts.running||agents.counts.unsupported||agents.counts.inboxUnknown||agents.counts.pendingNextTurn||agents.counts.pendingNextStep||agents.inboxState!=='empty')reasons.push('native_work_active_or_unknown');
 if(im&&(im.pending||im.operationInFlight))reasons.push('im_maintenance_pending');
 const installation=options.installation===true?await rpc('install_status'):null;
 const description=options.versionIdentity===true?await rpc('describe'):null;
 if(options.versionIdentity===true&&(typeof description?.pluginVersion!=='string'||description.pluginVersion.length>99||!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(description.pluginVersion)))fail('RUNTIME_HOST_VERSION_REVIEW');
 if(!await runtimeAlive(j.host))fail('RUNTIME_HOST_IDENTITY_REVIEW');
 return {contract:1,nativeNonce:j.nativeNonce,instances:{onboarding:own.instanceId,agents:agents.instanceId,gateway:gateway.instanceId??null,im:im?.instanceId??null},idle:reasons.length===0,reasons,observedAt:Date.now(),ingressFrozen:false,imInFlightVerified:false,...(options.installation===true?{installation}:{} ),...(options.versionIdentity===true?{pluginVersion:description.pluginVersion}:{})};
}
