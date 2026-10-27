// No Git/model/network effects: historical development, provider API and readback are synthetic.
// The real SQLite ledger, ChatApproval checks, preview storage and execution-authority bridge run unchanged.
import {randomUUID} from 'node:crypto';
import {fixture as chatFixture,proposal} from './approval-fixture.mjs';
import {DevelopmentGate} from '../bundle/development-gate.js';
import {DeliveryJournal} from '../bundle/delivery-journal.js';
import {DeliveryPreview} from '../bundle/delivery-preview.js';
import {DeliveryApproval} from '../bundle/delivery-approval.js';
import {compileCommit} from '../bundle/delivery-object-plan.js';
import {canonical,digest} from '../bundle/approval-ledger.js';
import {baseline} from './delivery-fixture.mjs';
export function fixture(t,{enabled=true,repositoryIdentity=false,mixedFiles=false}={}){
 const f=chatFixture(t,{semantic:true}),db=f.store.db,control={repository:true,ready:true,inspections:0};
 const repository={...(repositoryIdentity?{provider:'gitee',repository_id:101,private:true}:{}),url:'https://gitee.com/test-fixture/example',branch:'main',base_sha:'1'.repeat(40),fingerprint:'b'.repeat(64),binding_revision:1};
 f.ledger.repositories={approvalSnapshot:(_task,ref)=>{if(!ref||ref.binding_revision!==1||ref.fingerprint!==repository.fingerprint)throw Error('REPOSITORY_CHANGED');return {revision:1,snapshot:repository};},matches:()=>control.repository};
 const source=f.ledger.request('cloud',{task_id:f.task.id,expected_revision:1,event_id:'source',proposal:{...proposal,repository:{binding_revision:1,fingerprint:repository.fingerprint}}});
 new DevelopmentGate({store:f.store,ledger:f.ledger});
 const bytes=Buffer.from('synthetic report\n'),hash=digest(bytes.toString()),branch='dsh-task/approval';
 const before=mixedFiles?[{path:'changed.md',mode:0o644,bytes:Buffer.from('old')},{path:'deleted.md',mode:0o644,bytes:Buffer.from('old')}]:[],after=[{path:'report.md',mode:0o644,bytes},...(mixedFiles?[{path:'changed.md',mode:0o644,bytes:Buffer.from('new')}]:[])];
 const changes=[{path:'report.md',action:'create',before_sha256:null,after_sha256:hash},...(mixedFiles?[{path:'changed.md',action:'modify',before_sha256:digest('old'),after_sha256:digest('new')},{path:'deleted.md',action:'delete',before_sha256:digest('old'),after_sha256:null}]:[])];
 const tested=mixedFiles?{kind:'workspace_manifest_sha256',sha256:digest(Object.fromEntries(after.map(x=>[x.path,{sha256:digest(x.bytes.toString()),mode:x.mode}])))}:{kind:'file_sha256',sha256:hash};
 const compiled=compileCommit({parent:repository.base_sha,branch,baseline:before,files:after,changes,tested_content:tested,author:{name:'Fixture',email:'fixture@example.invalid'},committer:{name:'Fixture',email:'fixture@example.invalid'},when:1000,message:'synthetic only'});
 const identity={root:'/nonexistent/synthetic-approval-only',directory:{device:'1',inode:'2'},git_directory:{device:'1',inode:'3'},url:repository.url,branch,base_sha:repository.base_sha};
 db.prepare("INSERT INTO development_requests(id,task_id,approval_id,resource,state,expected_hash,test_result,workspace_identity) VALUES (?,?,?,?,'completed',?,?,?)").run('synthetic-development',f.task.id,source.id,repository.url,tested.sha256,canonical({passed:true,file_hash:tested.sha256}),canonical(identity));
 const body={id:'delivery-'+randomUUID(),task_id:f.task.id,spec_revision:1,request_id:'synthetic-development',repository,workspace_branch:branch,baseline_commit:repository.base_sha,tested_content:compiled.plan.tested_content,source_approval:{id:source.id,proposal_hash:source.proposal_hash},files:changes.map(({action,...x})=>({...x,approved_action:action,changed:true}))};
 const p={...body,fingerprint:digest(body)},preview=new DeliveryPreview({store:f.store,now:f.ledger.now});
 db.prepare('INSERT INTO delivery_previews VALUES (?,?,?,?,?,?,?)').run(p.id,'synthetic-preview','x',f.task.id,p.request_id,canonical(p),f.ledger.now());
 preview.checked=()=>{control.inspections++;return {a:f.ledger.view(source.id),w:{identity:()=>identity}};};
 const journal=new DeliveryJournal({store:f.store,enabled:true,exclusive:()=>true,preflight:i=>control.ready?{intent_fingerprint:i.fingerprint,drained:true,manifest_sha256:i.plan.manifest_sha256,workspace_identity:i.workspace_identity,branch:i.plan.branch,parent:i.plan.parent,baseline:baseline(i)}:null});
 const bridge=new DeliveryApproval({ledger:f.ledger,preview,journal,enabled});f.ledger.delivery=bridge;journal.authorize=a=>bridge.authorize(a);
 const input={event_id:'stage',task_id:f.task.id,preview_id:p.id,fingerprint:p.fingerprint,resource:repository.url,workspace_identity:identity,...compiled};
 const stage=()=>bridge.stage(input);
 const request=(reference=stage().reference,event='execution-approval',node='cloud')=>f.ledger.request(node,{task_id:f.task.id,expected_revision:1,event_id:event,proposal:{...proposal,scopes:['commit'],repository:{binding_revision:1,fingerprint:repository.fingerprint},delivery:reference}});
 const start=async()=>{const r=request();f.chat.queue(r.id);await f.chat.tick();const route=db.prepare('SELECT message_id FROM approval_chat_deliveries WHERE request_id=?').get(r.id);return {r,prompt:f.messages.get(route.message_id)};};
 const decide=async(prompt,text='可以按这个做',fields={})=>{f.reply(prompt,text,fields);await f.chat.tick();};
 const intent=()=>journal.prepare(input);
 const authority=id=>bridge.authorize({approval_id:id,intent:intent()});
 return {...f,control,source,repository,compiled,identity,p,preview,journal,bridge,input,stage,request,start,decide,intent,authority};
}
