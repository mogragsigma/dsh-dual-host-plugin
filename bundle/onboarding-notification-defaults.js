// Page 3 owns one explicit default entry/return-channel selection. Native IM
// continues to own receiving messages. This module never starts an IM consumer.
import {handoffTarget} from './onboarding-handoff.js';
import {credentialKey} from '@deepseek-ai/dsh-credentials';
import {randomUUID} from 'node:crypto';
import {NotificationDiscovery} from './notification-discovery.js';
import {defaultPolicy} from './notification-defaults.js';
import {targets,digest} from './notification-contract.js';
const KEY=credentialKey('dsh-task-gateway','onboarding-notification-default-v1');
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join()===keys.slice().sort().join();
const fail=c=>{throw Error('ONBOARDING_NOTIFICATION_'+c);};
const safe=e=>/^(NOTIFICATION|CAPABILITY|PROTOCOL|COORDINATOR|ONBOARDING)_[A-Z_]+$/.test(e?.message??'')?e.message:'ONBOARDING_NOTIFICATION_UNAVAILABLE';
function record(r){
 if(!r)return null;if(r.kind!=='grant'||!exact(r.payload,['owner','policy'])||r.payload.owner!=='dsh-dual-host-onboarding')fail('RECORD_REVIEW');
 try{return defaultPolicy(r.payload.policy);}catch{fail('RECORD_REVIEW');}
}
export function createOnboardingNotificationDefaults({state,credentials,im,gateway,role,remote,remoteEnabled,now=Date.now}){
 let pending=null,busy=false,closed=false,lastSync=null,syncing=null,remoteTarget=null,peerTarget=null;
 const discovery=new NotificationDiscovery({c:{role:role==='cloud'?'cloud':'local'},now,get closed(){return closed;}},im);
 const available=()=>role!=='cloud'&&state.available()&&!!credentials();
 const ready=()=>{if(!available()||closed)fail('UNAVAILABLE');return credentials();};
 async function read(){return record(await ready().readRecord(KEY));}
 async function run(fn){if(busy)fail('BUSY');busy=true;try{return await fn();}finally{busy=false;}}
 function currentHost(host){return host===(role==='cloud'?'cloud':'local');}
 async function scan(a){
  if(!exact(a,['host'])||!['local','cloud'].includes(a.host))fail('ARGUMENTS');
  if(currentHost(a.host))return discovery.inspect();
  remoteTarget=null;peerTarget=null;
  const g=gateway();
  // Existing paired Hosts need no managed-install archive. Use their current
  // authenticated protocol, never reinterpret them as a new cloud installation.
  if(role!=='cloud'&&g&&!g.closed){
   if(g.c.role!=='local')fail('CANDIDATE_REVIEW');
   const r=await g.call('notification_default_peer_discover',a);
   if(gateway()!==g||g.closed||closed||!exact(r,['instance_id','value'])||typeof r.instance_id!=='string'||!r.instance_id||r.value?.host!=='cloud'||!Array.isArray(r.value.items))fail('CANDIDATE_REVIEW');
   peerTarget={gateway:g,instance:r.instance_id};return r.value;
  }
  if(role==='cloud'||!remoteEnabled())fail('PEER_UNAVAILABLE');
  const r=await remote('notification_defaults_discover',a);handoffTarget(r.target);if(r.value?.host!=='cloud'||!Array.isArray(r.value.items))fail('CANDIDATE_REVIEW');remoteTarget=r.target;return r.value;
 }
 // Internal Host-to-Host read: revalidate the exact SDK candidate on its owning
 // Host. No credentials are returned; the browser receives only the plan view.
 async function candidate(a){
  if(!exact(a,['host','candidate_id','label'])||!['local','cloud'].includes(a.host))fail('ARGUMENTS');
  let d;
  if(currentHost(a.host))d=await discovery.resolve(a.candidate_id,a.label);
  else if(peerTarget){
   const pin=peerTarget,g=gateway();if(g!==pin.gateway||g.closed)fail('CANDIDATE_CHANGED');
   const r=await g.call('notification_default_peer_candidate',{...a,instance_id:pin.instance});
   if(gateway()!==g||g.closed||peerTarget!==pin||!exact(r,['instance_id','value'])||r.instance_id!==pin.instance)fail('CANDIDATE_CHANGED');d=r.value;
  }else {if(role==='cloud'||!remoteEnabled())fail('PEER_UNAVAILABLE');if(!remoteTarget)fail('CANDIDATE_REVIEW');const r=await remote('notification_defaults_candidate',a,remoteTarget);handoffTarget(r.target);if(digest(r.target)!==digest(remoteTarget))fail('CANDIDATE_CHANGED');d=r.value;}
  try{const t=targets([d])[0];if(t.host!==a.host||t.label!==a.label||!t.alias.startsWith('discovered-'))fail('CANDIDATE_REVIEW');}catch{fail('CANDIDATE_REVIEW');}
  return d;
 }
 function view(p){return {contract:1,enabled:p?.enabled??false,revision:p?.revision??0,operation:p?.operation??null,target:p?.definition?{host:p.definition.host,label:p.definition.label}:null,publication:p&&lastSync?.operation===p.operation?{state:lastSync.state,error:lastSync.error??null,observedAt:lastSync.at}:{state:p?'pending_pair_or_sync':'not_configured'},scope:'new_cloud_scheduled_tasks',events:['result','attention'],historicalBackfill:false,writeAuthorized:false};}
 async function status(a){if(!exact(a,[]))fail('ARGUMENTS');return view(await read());}
 async function preview(a){return run(async()=>{
  pending=null;
  if(!exact(a,a?.enabled?['enabled','host','candidate_id','label']:['enabled'])||typeof a.enabled!=='boolean')fail('ARGUMENTS');
  const old=await read(),definition=a.enabled?await candidate({host:a.host,candidate_id:a.candidate_id,label:a.label}):null;
  if(closed||(await read())?.revision!==old?.revision)fail('REVISION_CONFLICT');
  const policy={contract:1,owner:old?.owner??randomUUID(),revision:(old?.revision??0)+1,operation:randomUUID(),enabled:a.enabled,definition,approvedAt:now()};
  defaultPolicy(policy);pending={policy,input:a,expectedRevision:old?.revision??0,expiresAt:now()+300000,fingerprint:digest(policy)};
  return {id:policy.operation,fingerprint:pending.fingerprint,expiresAt:pending.expiresAt,enabled:policy.enabled,revision:policy.revision,target:definition?{host:definition.host,label:definition.label}:null,events:['result','attention'],scope:'new_cloud_scheduled_tasks',endsPreviousInheritedConsent:true,inflightCannotBeRecalled:true,writeAuthorized:false};
 });}
 async function apply(a){return run(async()=>{
  if(!exact(a,['id','fingerprint','confirm'])||a.confirm!==true)fail('CONFIRMATION_REQUIRED');
  const p=pending;if(!p||p.policy.operation!==a.id||p.fingerprint!==a.fingerprint||p.expiresAt<=now())fail('PLAN_EXPIRED');
  pending=null; // Unknown writes must be reconciled by status, never replayed.
  if(p.policy.enabled){const d=await candidate({host:p.input.host,candidate_id:p.input.candidate_id,label:p.input.label});if(digest(d)!==digest(p.policy.definition))fail('CANDIDATE_CHANGED');}
  if(closed||p.expiresAt<=now())fail('PLAN_EXPIRED');
  await ready().modifyRecord(KEY,old=>{const r=record(old);if((r?.revision??0)!==p.expectedRevision)fail('REVISION_CONFLICT');return {kind:'grant',payload:{owner:'dsh-dual-host-onboarding',policy:p.policy}};});
  lastSync=null; // Save first; absence/offline peer is not a failed local write.
  try{await sync({});}catch{}
  return status({});
 });}
 async function sync(a){
  if(!exact(a,[]))fail('ARGUMENTS');if(syncing)return syncing;
  syncing=(async()=>{
   const p=await read();if(!p)return view(null);const g=gateway();
   if(!g||g.closed){lastSync={operation:p.operation,state:'pending_pair_or_sync',at:now()};fail('PAIR_UNAVAILABLE');}
   try{
    if(lastSync?.operation!==p.operation||lastSync.state!=='active'||lastSync.gateway!==g||now()-lastSync.at>=10000||now()<lastSync.at){
     await g.notifications.defaults.sync(p);
     if(closed||gateway()!==g||(await read())?.operation!==p.operation)fail('REVISION_CONFLICT');
     lastSync={operation:p.operation,state:'active',at:now(),gateway:g};
    }
    return view(p);
   }catch(e){lastSync={operation:p.operation,state:'pending_or_review',error:safe(e),at:now()};throw e;}
  })();try{return await syncing;}finally{syncing=null;}
 }
 return {available,scan,candidate,status,preview,apply,sync,dispose(){closed=true;pending=null;}};
}
