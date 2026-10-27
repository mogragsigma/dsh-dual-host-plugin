// Real SQLite + semantic/chat proof verification; all Git/provider evidence synthetic.
import {fixture} from './delivery-approval-fixture.mjs';
import {DeliveryPushApproval} from '../bundle/delivery-push-approval.js';
import {compilePush} from '../bundle/delivery-push-plan.js';
import {digest} from '../bundle/approval-ledger.js';
export function commitReadback(i){const p=i.plan;return {kind:'commit-readback-v1',intent_fingerprint:i.fingerprint,drained:true,object_exists:true,head_oid:p.computed_commit_oid,ref_oid:p.computed_commit_oid,commit_oid:p.computed_commit_oid,tree_oid:p.tree_oid,index_tree_oid:p.tree_oid,branch:p.branch,parent:p.parent,manifest_sha256:p.manifest_sha256,workspace_identity:i.workspace_identity};}
export function pushPreflight(i,now){const p=i.plan,b={kind:'push-state-v1',intent_fingerprint:i.fingerprint,workspace_identity:i.workspace_identity,repository_id:p.repository_id,url:p.url,ref:p.ref,remote_oid:p.expected_remote_oid,commit_oid:p.commit_oid,tree_oid:p.tree_oid,manifest_sha256:p.manifest_sha256,local_snapshot_sha256:'a'.repeat(64)};return {kind:'push-preflight-v1',intent_fingerprint:i.fingerprint,drained:true,local_commit_verified:true,fast_forward_verified:p.expected_remote_oid!==null,observed_at:now,baseline:{...b,fingerprint:digest(b)}};}
export async function setup(t,options={}){
 const f=fixture(t,{...options,repositoryIdentity:true}),j=f.journal;j.now=f.ledger.now;j.observe=commitReadback;
 const original=await f.start();await f.decide(original.prompt);
 const q=j.enqueue({...f.input,approval_id:original.r.id,event_id:'source-commit'}),a=j.acquire(q.id);j.markDispatched(q.id,a.epoch);j.finish(q.id,a.epoch);
 const source=j.row(q.id),intent=j.intent(source),plan=compilePush({source_action_id:q.id,commit_intent:intent,commit_result:JSON.parse(source.result),repository_id:101,expected_remote_oid:null});
 j.pushEnabled=true;const preflight=j.preflight;j.preflight=i=>i.kind==='push-execution-intent-v1'?pushPreflight(i,f.ledger.now()):preflight(i);
 const push=new DeliveryPushApproval({commit:f.bridge,journal:j,enabled:true});f.ledger.delivery=push;j.authorize=a=>push.authorize(a);
 const input={task_id:f.task.id,resource:intent.resource,workspace_identity:intent.workspace_identity,plan,event_id:'push-stage'};
 const stage=()=>push.stage(input),pi=()=>j.prepare(input);
 const request=(ref=stage().reference,extra={})=>f.ledger.request('local',{task_id:f.task.id,expected_revision:1,event_id:'push-approval',proposal:{...JSON.parse(f.ledger.row(original.r.id).proposal),scopes:['push'],repository:{binding_revision:1,fingerprint:f.repository.fingerprint},delivery:ref,...extra}});
 const prompt=async(r=request())=>{f.time(10000);f.chat.queue(r.id);await f.chat.tick();const d=f.store.db.prepare('SELECT message_id FROM approval_chat_deliveries WHERE request_id=?').get(r.id);return {r,prompt:f.messages.get(d.message_id)};};
 return {...f,j,push,source,original,input,stage,pi,request,prompt};
}
