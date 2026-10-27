// Private actual SSH push adapter. Default off; constructed only by the opt-in cloud runtime.
// Async remote observations are cached only for the journal's synchronous atomic
// gate. The journal checks freshness; CAS protects changes after that observation.
import {canonical,digest} from './approval-ledger.js';
import {validatePushIntent,validatePushReadiness,pushReadback} from './delivery-push-plan.js';
import {DeliveryGitRead} from './delivery-git-read.js';
import {DeliverySSH} from './delivery-ssh.js';
const fail=c=>{throw Error('DELIVERY_PUSH_ADAPTER_'+c);};
const same=(a,b)=>canonical(a)===canonical(b);
export class DeliveryPush {
 constructor({journal,binding,provider,credentials,receipts,enabled=false,externalDrained=()=>false,now=Date.now},io={}){
  this.j=journal;this.binding=structuredClone(binding);this.provider=provider;this.enabled=enabled;this.externalDrained=externalDrained;this.now=now;this.active=false;
  this.receipts=receipts;
  this.reader=io.reader??new DeliveryGitRead({binding,drained:()=>externalDrained()===true});
  this.ssh=io.ssh??new DeliverySSH({binding,...credentials,enabled});this.preflightCache=null;this.readbackCache=null;
 }
 check(i){
  if(this.enabled!==true)fail('DISABLED');validatePushIntent(i);
  if(!same(this.binding,{root:i.workspace_identity.root,url:i.resource,branch:i.plan.branch,base_sha:i.plan.parent_oid}))fail('BINDING_CHANGED');
  if(this.externalDrained()!==true)fail('DRAIN_REQUIRED');
  const r=this.j.row(i.plan.source_action_id),source=this.j.intent(r);
  if(r.state!=='completed'||source.fingerprint!==i.plan.source_intent_fingerprint||digest(JSON.parse(r.result??'null'))!==i.plan.source_result_fingerprint)fail('SOURCE_CHANGED');return source;
 }
 local(i){
  const source=this.check(i);this.reader.observe(source);return this.reader.capture(source);
 }
 async identity(i){
  const r=await this.provider.identity(i.plan.url);
  if(r.provider!=='gitee'||r.url!==i.plan.url||r.repository_id!==i.plan.repository_id)fail('REMOTE_IDENTITY_CHANGED');return r;
 }
 async remoteBaseline(i,{signal}={}){
  const before=this.local(i);await this.identity(i);const remote=await this.ssh.read(i.plan,{signal});await this.identity(i);
  if(!same(before,this.local(i)))fail('LOCAL_CHANGED');return remote;
 }
 async preflight(i,{signal}={}){
  const before=this.local(i);await this.identity(i);const remote=await this.ssh.read(i.plan,{signal}),observed_at=this.now();await this.identity(i);
  if(remote!==i.plan.expected_remote_oid)fail('REMOTE_CHANGED');
  const ff=remote===null?false:this.reader.ancestor(remote,i.plan.commit_oid,i.plan.format);
  if(remote!==null&&ff!==true)fail('NON_FAST_FORWARD');
  const after=this.local(i);if(!same(before,after))fail('LOCAL_CHANGED');
  const b={kind:'push-state-v1',intent_fingerprint:i.fingerprint,workspace_identity:i.workspace_identity,repository_id:i.plan.repository_id,
   url:i.plan.url,ref:i.plan.ref,remote_oid:remote,commit_oid:i.plan.commit_oid,tree_oid:i.plan.tree_oid,
   manifest_sha256:i.plan.manifest_sha256,local_snapshot_sha256:after.fingerprint};
  const proof={kind:'push-preflight-v1',intent_fingerprint:i.fingerprint,drained:true,local_commit_verified:true,
   fast_forward_verified:ff,observed_at,baseline:{...b,fingerprint:digest(b)}};
  validatePushReadiness(i,proof,this.now());this.preflightCache=proof;return structuredClone(proof);
 }
 cachedPreflight(i){if(this.preflightCache?.intent_fingerprint!==i.fingerprint)fail('PREFLIGHT_REQUIRED');validatePushReadiness(i,this.preflightCache,this.now());return structuredClone(this.preflightCache);}
 async readback(i,{signal}={}){
  const before=this.local(i);await this.identity(i);const remote=await this.ssh.read(i.plan,{signal}),observed_at=this.now();
  await this.identity(i);if(!same(before,this.local(i)))fail('LOCAL_CHANGED');
  const proof={kind:'push-readback-v1',intent_fingerprint:i.fingerprint,workspace_identity:i.workspace_identity,
   repository_id:i.plan.repository_id,url:i.plan.url,ref:i.plan.ref,ref_oid:remote,drained:true,observed_at};
  pushReadback(i,proof,this.now());this.readbackCache=proof;return structuredClone(proof);
 }
 cachedReadback(i){if(this.readbackCache?.intent_fingerprint!==i.fingerprint)fail('READBACK_REQUIRED');pushReadback(i,this.readbackCache,this.now());return structuredClone(this.readbackCache);}
 guard(id,epoch,i){
  this.j.effectAuthority(id,epoch);if(this.j.unfinished(id))fail('DRAIN_REQUIRED');
  const local=this.local(i),proof=this.cachedPreflight(i);
  if(local.fingerprint!==proof.baseline.local_snapshot_sha256)fail('LOCAL_CHANGED');
 }
 async execute(id,epoch,{signal}={}){
  if(this.enabled!==true)fail('DISABLED');if(this.active)fail('IN_FLIGHT');if(signal?.aborted)fail('ABORTED');
  this.active=true;let dispatched=false,operation;
  try{
   const r=this.j.fence(id,epoch),i=this.j.intent(r);if(i.kind!=='push-execution-intent-v1'||r.dispatched)fail('INVALID_ACTION');
   await this.preflight(i,{signal});this.j.markDispatched(id,epoch);dispatched=true;
   try{
    await this.ssh.push(i.plan,{signal,beforeSpawn:()=>{
     this.guard(id,epoch,i);operation=this.j.startOperation(id,epoch,'push',{plan_fingerprint:i.plan.fingerprint});
     return this.receipts?.prepare(operation);
    },onSpawn:({pid})=>this.j.spawned(operation,pid),onDrained:r=>this.j.closed(operation,{code:r.code,signal:r.signal})});
   }catch{/* Never repeat a push. A closed process may still have updated the remote. */}
   if(this.j.unfinished(id))fail('DRAIN_UNKNOWN');
   // Only a fresh readback can settle uncertain acknowledgement; never retry.
   await this.readback(i,{signal});return this.j.finish(id,epoch);
  }catch(e){
   if(!dispatched)throw e;
   try{this.j.recordFailure(id,epoch);}catch{}
   return {...this.j.view(id),review_required:true,error:'DELIVERY_PUSH_UNCERTAIN'};
  }finally{this.active=false;}
 }
}
