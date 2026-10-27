// Git/workspace/approval evidence is synthetic; no repository files or Git processes.
import {fixture as commitFixture} from './delivery-commit-fixture.mjs';
import {DeliveryRecovery} from '../bundle/delivery-recovery.js';
import {canonical} from '../bundle/approval-ledger.js';
import {compileIndex} from '../bundle/delivery-index.js';
export function fixture(t,{locks=false,quiescent=true,enabled=true}={}){
 const f=commitFixture(t),{j,action,intent,state}=f,epoch=action.epoch;let outside=quiescent;
 j.markDispatched(action.id,epoch);const before=JSON.parse(j.row(action.id).before_snapshot),index=compileIndex(f.compiled.plan,f.compiled.objects);
 const hash=createHash('sha256').update(index.bytes).digest('hex');
 const idx={epoch,plan_fingerprint:intent.plan.fingerprint,tree_oid:index.tree_oid,sha256:hash,bytes:index.bytes.length};j.event(action.id,'index_planned',idx);
 let currentLocks=['config.lock','index.lock'].map(name=>({name,state:'absent'})),releases=0,throwAfter=false;
 if(locks){const op=j.startOperation(action.id,epoch,'lock');currentLocks=currentLocks.map((l,i)=>({...l,state:'owned',identity:{device:'1',inode:String(i+10)},sha256:'a'.repeat(64),stamp:String(i),bytes:1,kind:'owner-marker'}));for(const l of currentLocks)j.event(action.id,'lock_owned',{epoch,name:l.name,identity:l.identity});j.closed(op,{code:0});state.locked=true;}
 j.markUnknown(action.id,epoch);
 const set={scan:()=>structuredClone(currentLocks),release(expected,each){if(canonical(expected)!==canonical(currentLocks))throw Error('DELIVERY_RECOVERY_STALE_LOCK_EVIDENCE');
  releases++;for(const l of [...currentLocks].reverse()){if(l.state!=='owned')continue;each(l.name);l.state='absent';delete l.identity;delete l.sha256;delete l.stamp;delete l.bytes;delete l.kind;if(throwAfter)throw Error('filesystem uncertainty');}state.locked=false;
 }};
 const makeReader=()=>({capture:i=>f.reader.capture(i)});
 const recovery=new DeliveryRecovery({journal:j,binding:f.binding,enabled,quiescent:()=>outside},{makeLocks:()=>set,makeReader});
 j.observeUnapplied=(i,b)=>{if(state.locked||canonical(f.reader.capture(i))!==canonical(b))throw Error('not unchanged');return {kind:'commit-not-applied-v1',intent_fingerprint:i.fingerprint,baseline_fingerprint:b.fingerprint,drained:true,unchanged:true,object_presence_unchanged:true};};
 const inspect=()=>recovery.inspect(action.id,epoch),apply=(decision,event='review')=>recovery.apply({id:action.id,epoch,event_id:event,decision,evidence_fingerprint:inspect().fingerprint});
 const phase=kind=>{
  if(kind==='objects'||kind==='reference'||kind==='complete')state.objects=new Set(f.compiled.objects.map(o=>o.oid));
  if(kind==='reference'||kind==='complete')state.head=state.ref=intent.plan.computed_commit_oid;
  if(kind==='complete'||kind==='index'){state.indexTree=intent.plan.tree_oid;state.metadata.index_sha256=hash;}
 };
 return {...f,before,index,set,recovery,inspect,apply,phase,locks:()=>currentLocks,releaseCount:()=>releases,quiescent:v=>outside=v,throwAfter:v=>throwAfter=v};
}
import {createHash} from 'node:crypto';
