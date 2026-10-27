// Synthetic approval and repository. SQLite is real; filesystem/Git write effects are in memory.
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {createHash} from 'node:crypto';
import {Coordinator} from '../bundle/store.js';import {DeliveryJournal} from '../bundle/delivery-journal.js';
import {DeliveryCommit} from '../bundle/delivery-commit.js';import {compileCommit} from '../bundle/delivery-object-plan.js';
import {digest} from '../bundle/approval-ledger.js';import {baseline} from './delivery-fixture.mjs';
export const sha=b=>createHash('sha256').update(b).digest('hex');
export function fixture(t,options={}){
 const root=mkdtempSync(tmpdir()+'/delivery-commit-unit-'),store=new Coordinator(root);t.after(()=>{store.db.close();rmSync(root,{recursive:true,force:true});});
 const content=Buffer.from('not a real commit'),compiled=compileCommit({parent:'1'.repeat(40),branch:'dsh-task/unit',baseline:[],files:[{path:'src/a',mode:0o644,bytes:content}],changes:[{path:'src/a',action:'create',before_sha256:null,after_sha256:sha(content)}],tested_content:{kind:'file_sha256',sha256:sha(content)},author:{name:'Test',email:'test@example.invalid'},committer:{name:'Test',email:'test@example.invalid'},when:1000,message:'synthetic'});
 const identity={root:'/synthetic/not-a-repository',directory:{device:'1',inode:'2'},git_directory:{device:'1',inode:'3'},url:'https://gitee.com/test/fixture',branch:compiled.plan.branch,base_sha:compiled.plan.parent},binding={root:identity.root,url:identity.url,branch:identity.branch,base_sha:identity.base_sha};
 const state={authorized:true,owner:true,locked:false,objects:new Set(),head:compiled.plan.parent,ref:compiled.plan.parent,events:[],leaseCalls:0,gitCalls:0,releaseCalls:0,abandoned:false,observeCalls:0,failAt:null,pid:1000};let initial;
 const capture=i=>{const {fingerprint,...s}=initial;return {...s,head_oid:state.head,ref_oid:state.ref,index_tree_oid:state.indexTree,metadata:{...state.metadata},objects_present:[...state.objects].sort(),fingerprint:undefined};};
 const reader={capture(i){const {fingerprint,...s}=capture(i);return {...s,fingerprint:digest(s)};},observe(i){state.observeCalls++;
  if(state.locked||state.head!==i.plan.computed_commit_oid||state.ref!==i.plan.computed_commit_oid||state.indexTree!==i.plan.tree_oid||state.objects.size!==i.plan.objects.length)throw Error('NOT_APPLIED');
  return {kind:'commit-readback-v1',intent_fingerprint:i.fingerprint,drained:true,object_exists:true,head_oid:state.head,ref_oid:state.ref,commit_oid:i.plan.computed_commit_oid,tree_oid:i.plan.tree_oid,index_tree_oid:state.indexTree,branch:i.plan.branch,parent:i.plan.parent,manifest_sha256:i.plan.manifest_sha256,workspace_identity:i.workspace_identity};}};
 const j=new DeliveryJournal({store,enabled:true,exclusive:()=>state.owner,authorize:({approval_id,intent})=>state.authorized?{kind:'delivery-execution-v1',scope:'commit',execution:true,approval_id,task_id:intent.task_id,task_revision:intent.task_revision,intent_fingerprint:intent.fingerprint,authority_hash:'a'.repeat(64)}:null,
  preflight:i=>({intent_fingerprint:i.fingerprint,drained:true,manifest_sha256:i.plan.manifest_sha256,workspace_identity:i.workspace_identity,branch:i.plan.branch,parent:i.plan.parent,baseline:baseline(i)}),observe:i=>reader.observe(i)});
 const task=store.accept('cloud',{task_key:'unit',ingress_id:'unit',source:'unit'}),q=j.enqueue({task_id:task.id,resource:identity.url,workspace_identity:identity,...compiled,approval_id:'synthetic',event_id:'unit'}),a=j.acquire(q.id),intent=j.intent(j.row(q.id));initial=JSON.parse(j.row(q.id).before_snapshot);state.indexTree=initial.index_tree_oid;state.metadata={...initial.metadata};
 const assertEffect=()=>{if(!j.row(q.id).dispatched)throw Error('Effect without durable dispatch');if(!j.unfinished(q.id))throw Error('Effect without durable operation');};
 const lease={open(){assertEffect();state.leaseCalls++;state.events.push('lock');state.locked=true;if(state.failAt==='lock')throw Error('partial lock failure');},assert(){if(!state.locked||state.failAt==='lock-changed')throw Error('LOCK_CHANGED');},proofs(){return {};},
  installIndex(bytes){assertEffect();state.events.push('index');if(state.failAt==='index-before')throw Error('index failed');state.indexTree=compiled.plan.tree_oid;state.metadata.index_sha256=sha(bytes);if(state.failAt==='index-after')throw Error('index applied but receipt failed');},
  release(){assertEffect();state.releaseCalls++;state.events.push('unlock');if(state.failAt==='unlock'||state.failAt==='lock-changed')throw Error('unlock unknown');state.locked=false;},abandon(){state.abandoned=true;}};
 const runGit=async(args,input,signal,observer,plan)=>{
  assertEffect();state.gitCalls++;const kind=args[0]==='hash-object'?'object':'reference';state.events.push(kind);observer.onSpawn({pid:++state.pid});
  if(state.failAt===kind+'-unknown')throw Error('unknown process');
  if(state.failAt===kind+'-before'){observer.onClose({code:1,signal:null});throw Object.assign(Error('failed'),{drained:true});}
  let output='';if(kind==='object'){const object=compiled.objects.find(o=>o.type===args[3]&&o.data.equals(input));if(!object)throw Error('Unapproved bytes');state.objects.add(object.oid);output=object.oid+'\n';}
  else{if(args.at(-1)!==state.ref)throw Error('CAS mismatch');state.head=state.ref=plan.computed_commit_oid;}
  options.onEffect?.({kind,state,j,action:a});
  if(state.failAt===kind+'-no-close')return output;
  observer.onClose({code:state.failAt===kind+'-bad-close'?1:0,signal:null});
  if(state.failAt===kind+'-after')throw Object.assign(Error('result lost after effect'),{drained:true});
  return state.failAt===kind+'-bad-result'?'wrong':output;
 };
 const io={reader,makeLease:()=>lease,runGit:options.runGit??runGit};
 const commit=new DeliveryCommit({journal:j,binding,enabled:options.enabled??true},io);
 return {store,j,compiled,binding,state,reader,lease,io,commit,action:a,intent,run:signal=>commit.execute(a.id,a.epoch,compiled.objects,{signal})};
}
