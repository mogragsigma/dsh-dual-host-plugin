import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {setup,start,write,command,git} from './workspace-fixture.mjs';
import {DeliveryPreview,deliverySnapshot,compareText} from '../bundle/delivery-preview.js';
import {digest} from '../bundle/approval-ledger.js';
import {receiptClassification} from '../bundle/diagnostics.js';
import {CAPABILITIES,METHODS,requireCapability} from '../bundle/link-contract.js';
import {Gateway} from '../bundle/index.js';
import {registerNativeTools} from '../bundle/native-tools.js';
import {deliveryReference} from '../bundle/delivery-contract.js';
import {renderChatProposal} from '../bundle/approval-chat.js';
import {renderReceipt} from '../bundle/approval-receipts.js';

async function completed(t,{report='# A synthetic report\n'}={}){
 const f=await setup(t),q=start(f);
 write(f,q,'src/count.py','def total(a, b):\n    return sum([a, b])\n');
 write(f,q,'docs/report.md',report);write(f,q,'src/remove.txt',null);
 await command(f,q,'build');await command(f,q,'test');f.gate.finish(q.id,'cloud',q.epoch,{agentDrained:true});
 const g={store:f.store,approvals:f.ledger,repositories:f.repos,development:{gate:f.gate},now:f.ledger.now,assertTaskQuiescent(){}};
 const preview=new DeliveryPreview(g),args={task_id:f.task.id,expected_revision:1,event_id:'preview-one'};
 return {...f,q,g,preview,args};
}
const ledger=db=>db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('delivery_previews','sqlite_sequence') ORDER BY name").all().map(({name})=>[name,db.prepare(`SELECT * FROM ${name}`).all()]);
test('preview binds completed manifest/tests, exact files and separate delivery states; no repo or authority mutations',async t=>{
 const f=await completed(t),before=ledger(f.store.db),index=readFileSync(join(f.root,'.git/index')),head=git(f.root,'rev-parse','HEAD');
 const {snapshot:p}=f.preview.create('local',f.args);
 assert.equal(p.tested_content.sha256,f.gate.view(f.q.id).expected_hash);assert.equal(p.tested_content.bound_commit,null);assert.equal(p.baseline_commit,head);
 assert.deepEqual(p.delivery.enabled,{commit:false,push:false,publish:false,deploy:false});assert.equal(p.delivery.remote_acceptance,'not_observed');assert.equal(p.delivery.runtime_adoption,'not_observed');
 assert.deepEqual(p.files.map(x=>x.path),f.spec.files.map(x=>x.path));assert(p.files.every(x=>x.changed));assert.equal(p.files.find(x=>x.approved_action==='delete').after_sha256,null);
 const {fingerprint,...body}=p;assert.equal(fingerprint,digest(body));assert.equal(p.grants_execution,false);assert(!JSON.stringify(p).includes(f.root));
 assert.deepEqual(ledger(f.store.db),before);assert.deepEqual(readFileSync(join(f.root,'.git/index')),index);assert.equal(git(f.root,'rev-parse','HEAD'),head);
});
test('snapshot survives service restart; rendering and event replay are pure stored reads not freshness checks',async t=>{
 const f=await completed(t),a=f.preview.create('local',f.args),count=f.store.db.prepare('SELECT count(*) n FROM delivery_previews').get().n;
 writeFileSync(join(f.root,'docs/report.md'),'changed after preview');const service=new DeliveryPreview(f.g),before=ledger(f.store.db),replay=service.create('local',f.args);
 assert.deepEqual(replay.snapshot,a.snapshot);assert(replay.replayed);assert.equal(replay.filesystem_checked_now,false);
 const s=deliverySnapshot(f.g,f.task.id,2);assert.equal(s.revision_matches,false);assert.equal(s.filesystem_checked_now,false);assert.equal(s.latest.fingerprint,a.snapshot.fingerprint);
 assert.deepEqual(ledger(f.store.db),before);assert.equal(f.store.db.prepare('SELECT count(*) n FROM delivery_previews').get().n,count);
 assert.throws(()=>service.create('local',{...f.args,event_id:'new-check'}),/FILE_CONFLICT/);
 assert.throws(()=>service.create('cloud',f.args),/EVENT_CONFLICT/);
});
for(const kind of ['active','blocked','busy','resource','inflight','unclosed','uncertain-write','task-revision','binding','approval-hash','test','command','missing-operation','handoff','head','remote','unrelated','symlink'])test('preview rejects '+kind+' without storing a success',async t=>{
 const f=await completed(t),db=f.store.db;
 if(kind==='active')db.prepare("UPDATE development_requests SET state='active' WHERE id=?").run(f.q.id);
 if(kind==='blocked'||kind==='busy')db.prepare(`UPDATE tasks SET ${kind}=1 WHERE id=?`).run(f.task.id);
 if(kind==='resource')f.gate.enqueue('cloud',{task_id:f.task.id,approval_id:f.req.id,policy:JSON.parse(f.gate.row(f.q.id).policy),event_id:'competing'});
 if(kind==='inflight')f.gate.inflight.add(f.q.id);
 if(kind==='unclosed')db.prepare("UPDATE development_operations SET state='running' WHERE request_id=?").run(f.q.id);
 if(kind==='uncertain-write')db.prepare("UPDATE development_writes SET state='writing' WHERE request_id=?").run(f.q.id);
 if(kind==='task-revision')db.prepare('UPDATE task_catalog SET spec_revision=2 WHERE task_id=?').run(f.task.id);
 if(kind==='binding')db.prepare('UPDATE repository_associations SET revision=revision+1 WHERE task_id=?').run(f.task.id);
 if(kind==='approval-hash')db.prepare("UPDATE development_requests SET authority_hash='wrong' WHERE id=?").run(f.q.id);
 if(kind==='test')db.prepare("UPDATE development_requests SET test_result='{}' WHERE id=?").run(f.q.id);
 if(kind==='command')db.prepare("UPDATE development_commands SET state='needs_review' WHERE request_id=?").run(f.q.id);
 if(kind==='missing-operation')db.prepare('DELETE FROM development_operations WHERE request_id=?').run(f.q.id);
 if(kind==='handoff')db.prepare("DELETE FROM development_events WHERE request_id=? AND type='safe_point'").run(f.q.id);
 if(kind==='head')git(f.root,'checkout','-b','other');
 if(kind==='remote')git(f.root,'remote','set-url','origin','https://gitee.com/elsewhere/fixture');
 if(kind==='unrelated')writeFileSync(join(f.root,'README.md'),'outside approval');
 if(kind==='symlink')symlinkSync('/etc/passwd',join(f.root,'unexpected'));
 const codes={active:'DELIVERY_COMPLETED_REQUEST_REQUIRED',blocked:'DELIVERY_TASK_BUSY',busy:'DELIVERY_TASK_BUSY',resource:'DELIVERY_RESOURCE_BUSY',inflight:'DELIVERY_DRAIN_REQUIRED',unclosed:'DELIVERY_DRAIN_REQUIRED','uncertain-write':'DELIVERY_DRAIN_REQUIRED','task-revision':'DELIVERY_TASK_REVISION_CONFLICT',binding:'DELIVERY_REPOSITORY_BINDING_MISMATCH','approval-hash':'DELIVERY_SOURCE_EVIDENCE_MISMATCH',test:'DELIVERY_TEST_EVIDENCE_REQUIRED',command:'DELIVERY_TEST_EVIDENCE_REQUIRED','missing-operation':'DELIVERY_TEST_EVIDENCE_REQUIRED',handoff:'DELIVERY_HANDOFF_EVIDENCE_REQUIRED',head:'DEVELOPMENT_BASELINE_CHANGED',remote:'DEVELOPMENT_REMOTE_CHANGED',unrelated:'DEVELOPMENT_OUT_OF_SCOPE_CHANGE',symlink:'DEVELOPMENT_FILE_UNSAFE'};
 assert.throws(()=>f.preview.create('cloud',{...f.args,request_id:f.q.id}),new RegExp('^Error: '+codes[kind]+'$'));
 assert.equal(db.prepare('SELECT count(*) n FROM delivery_previews').get().n,0);
});
test('expired historical develop approval can be inspected without revival or new execution',async t=>{
 const f=await completed(t);f.time(86400001);assert.equal(f.ledger.view(f.req.id).state,'expired');const before=ledger(f.store.db),p=f.preview.create('cloud',f.args).snapshot;
 assert.equal(p.source_approval.observed_state,'expired');assert.equal(p.source_approval.historical_evidence_only,true);assert.deepEqual(ledger(f.store.db),before);assert.equal(f.ledger.check(f.req.id,'develop').approval_valid,false);
});
test('multiple completed requests require explicit selection; arbitrary task/path/scope input cannot authorize',async t=>{
 const f=await completed(t);const q2=f.gate.acquire(f.enqueue('cloud','second').id);await command(f,q2,'build');await command(f,q2,'test');f.gate.finish(q2.id,'cloud',q2.epoch,{agentDrained:true});
 assert.throws(()=>f.preview.create('cloud',f.args),/REQUEST_AMBIGUOUS/);assert.equal(f.preview.create('cloud',{...f.args,request_id:q2.id}).snapshot.request_id,q2.id);
 for(const extra of [{path:'/etc/passwd'},{scope:'push'},{commit:true},{expected_revision:0}])assert.throws(()=>f.preview.create('cloud',{...f.args,event_id:'invalid',...extra}),/INVALID_PREVIEW/);
});
test('missing preview and absent capability preserve ordinary unbound tasks',async t=>{
 const f=await setup(t);assert.equal(deliverySnapshot({store:f.store},f.task.id,1).available,false);
 const s=new DeliveryPreview({store:f.store});assert.equal(s.status(f.task.id).latest,null);assert.equal(s.status(f.task.id).grants_execution,false);
 assert.throws(()=>s.create('cloud',{task_id:f.task.id,expected_revision:1,event_id:'unsupported'}),/CAPABILITY_REQUIRED/);
});
test('bounded comparisons are not executable patches and disclose binary, truncation and exact newline changes',()=>{
 const b=s=>Buffer.from(s),p=compareText(b('same\na\nend\n'),b('same\nb\nend\n'));assert.equal(p.before,'a');assert.equal(p.after,'b');assert.equal(p.unchanged_prefix_lines,1);assert.equal(p.executable_patch,false);
 assert.equal(compareText(b('a\n'),b('a')).truncated,false);assert.notDeepEqual(compareText(b('a\n'),b('a')),compareText(b('a'),b('a')));
 assert.equal(compareText(null,b('x'.repeat(3000))).truncated,true);assert.equal(compareText(b('a\0'),null).format,'binary_or_invalid_utf8');assert.equal(compareText(Buffer.from([0xff]),null).format,'binary_or_invalid_utf8');
});
test('capability negotiation and receipts keep preview separate from approval/commit and permit no execution RPC',()=>{
 assert.equal(CAPABILITIES.delivery_preview,1);assert.equal(METHODS.delivery_status,'delivery_preview');assert.equal(METHODS.delivery_commit,undefined);
 const hello={schema:1,protocol:{min:1,max:1},plugin_version:'0.24.0-alpha.1',namespace:'delivery',instance_id:'00000000-0000-0000-0000-000000000001'};
 assert.throws(()=>requireCapability('delivery_preview',{...hello,role:'local',capabilities:CAPABILITIES},{...hello,role:'cloud',capabilities:{}}),/CAPABILITY_UNAVAILABLE/);
 const r=receiptClassification('task_delivery_preview',{});assert.equal(r.receipt_classification.kind,'delivery_preview');assert.equal(r.receipt_classification.grants_execution,false);
});
test('own UI displays separate states and safe text with manual snapshots, no injected HTML or delivery write controls',()=>{
 const js=readFileSync(new URL('../ui-source/workbench-client.js',import.meta.url),'utf8'),section=js.slice(js.indexOf(' function Delivery('),js.indexOf(' function Planning('));
 for(const text of ['仅查看 · 不提交','预览生成时尚未创建；后续结果见交付动作','预览生成时尚未推送；后续结果见交付动作','未显示部分'])assert(section.includes(text),text);
 assert(!section.includes('本流程未推送'),'a historical preview must not deny later completed delivery');
 for(const unsafe of ['dangerouslySetInnerHTML','setInterval','delivery_commit','delivery_push','innerHTML'])assert(!section.includes(unsafe));
 assert(js.includes('h(Delivery,{item,fresh:detailFresh,request})'));
});
test('native local tool crosses authenticated negotiated HTTP and returns cloud preview without IM or approval writes',async t=>{
 const f=await completed(t),tokenFile=join(f.dir,'transport-tokens');
 writeFileSync(tokenFile,JSON.stringify({localToken:'l'.repeat(32),cloudToken:'c'.repeat(32)}),{mode:0o600});
 const agent={id:'fixture',ctx:{}},ctx={on(){},effect(){},agents:{list:()=>[agent],get:()=>agent},agentPresets:{composedPreset:()=> 'standard'}};
 const cloud=new Gateway(ctx,{role:'cloud',entryMode:'native',namespace:'delivery-test',stateDir:join(f.dir,'transport-cloud'),tokenFile,port:0});
 await cloud.start();const local=new Gateway(ctx,{role:'local',entryMode:'native',namespace:'delivery-test',stateDir:join(f.dir,'transport-local'),tokenFile,port:0,coordinatorUrl:'http://127.0.0.1:'+cloud.server.address().port});await local.start();
 // Inject only this synthetic completed ledger as the preview service, not a Host or business approval.
 cloud.delivery=f.preview;
 try{
  const tools=new Map();registerNativeTools({taskGateway:local,tools:{register:t=>tools.set(t.name,t)}});
  const before=ledger(f.store.db),p=await tools.get('task_delivery_preview').execute({task_id:f.task.id,expected_revision:1},{agent,callId:'preview-call'});
  assert.equal(p.snapshot.request_id,f.q.id);assert.equal(p.receipt_classification.kind,'delivery_preview');assert.equal(p.observation.usable_for_authorization,false);
  const status=await local.call('delivery_status',{task_id:f.task.id});assert.equal(status.latest.fingerprint,p.snapshot.fingerprint);assert.equal(status.filesystem_checked_now,false);
  for(const method of ['delivery_commit','delivery_push','delivery_publish','delivery_deploy'])await assert.rejects(local.call(method,{}),/METHOD_DENIED/);
  assert.deepEqual(ledger(f.store.db),before);
  const old=cloud.hello.bind(cloud);cloud.hello=()=>{const h=old();delete h.capabilities.delivery_preview;return h;};
  await assert.rejects(local.call('delivery_status',{task_id:f.task.id}),/CAPABILITY_UNAVAILABLE/);
 }finally{await local.close();await cloud.close();}
});

test('disabled worker can inspect retained operator binding without constructing a Gate or enabling execution',async t=>{
 const f=await completed(t),g={...f.g,development:undefined,c:{development:{enabled:false,bindings:f.bindings}}},service=new DeliveryPreview(g),before=ledger(f.store.db);
 const p=service.create('cloud',f.args).snapshot;assert.equal(p.tested_content.sha256,f.gate.row(f.q.id).expected_hash);assert.equal(g.development,undefined);assert.deepEqual(ledger(f.store.db),before);assert.equal(g.c.development.enabled,false);
});
test('failed task quiescence blocks preview even after successful development handoff',async t=>{
 const f=await completed(t);f.g.assertTaskQuiescent=()=>{throw Error('TASK_NOT_QUIESCENT');};assert.throws(()=>f.preview.create('cloud',f.args),/TASK_NOT_QUIESCENT/);assert.equal(f.preview.status(f.task.id).latest,null);
});

test('new generic commit scope does not revive develop or authorize delivery of its historical completed content',async t=>{
 const f=await completed(t),old=f.ledger.view(f.req.id),{development,...proposal}=old.proposal,repo=f.repos.status(f.task.id);
 const next=f.ledger.request('local',{task_id:f.task.id,expected_revision:1,event_id:'generic-commit-proposal',proposal:{...proposal,scopes:['commit'],repository:{binding_revision:repo.binding_revision,fingerprint:repo.repository.fingerprint}}});
 const p=f.preview.create('cloud',f.args).snapshot;assert.equal(p.source_approval.observed_state,'superseded');assert.equal(p.delivery.enabled.commit,false);assert.equal(f.ledger.view(next.id).state,'pending');assert.equal(p.grants_execution,false);
});

const pageArgs=(p,more={})=>({task_id:p.task_id,preview_id:p.id,fingerprint:p.fingerprint,path:'docs/report.md',side:'after',offset:0,limit:4096,...more});
test('explicit Unicode pages reconstruct full approved content beyond summary truncation without surrogate corruption or mutations',async t=>{
 const report=('甲😀乙\n').repeat(2300),f=await completed(t,{report}),p=f.preview.create('cloud',f.args).snapshot,before=ledger(f.store.db);
 assert(p.files.find(x=>x.path==='docs/report.md').comparison.truncated);let offset=0,reassembled='',pages=0;
 do{const page=f.preview.page(pageArgs(p,{offset}));assert.equal(page.cursor_unit,'unicode_codepoints');assert.equal(page.grants_execution,false);assert(!/[\uD800-\uDBFF]$/.test(page.text));reassembled+=page.text;offset=page.next_offset;pages++;}while(offset!==null);
 assert.equal(reassembled,report);assert.equal(pages,3);assert.deepEqual(ledger(f.store.db),before);
 const absent=f.preview.page(pageArgs(p,{side:'before'}));assert.equal(absent.state,'absent');assert.equal(absent.next_offset,null);
 const deleted=f.preview.page(pageArgs(p,{path:'src/remove.txt',side:'before'}));assert.equal(deleted.text,'obsolete\n');assert.equal(f.preview.page(pageArgs(p,{path:'src/remove.txt'})).state,'absent');
});
test('page arguments, task/path ownership and fingerprint reject before file access',async t=>{
 const f=await completed(t),p=f.preview.create('cloud',f.args).snapshot;
 for(const extra of [{offset:-1},{offset:0.1},{limit:0},{limit:4097},{side:'HEAD'},{command:'show'}])assert.throws(()=>f.preview.page(pageArgs(p,extra)),/INVALID_PAGE/);
 for(const path of ['/etc/passwd','../README.md','README.md','.git/config'])assert.throws(()=>f.preview.page(pageArgs(p,{path})),/FILE_DENIED/);
 assert.throws(()=>f.preview.page(pageArgs(p,{task_id:'another-task'})),/PREVIEW_NOT_FOUND/);assert.throws(()=>f.preview.page(pageArgs(p,{fingerprint:'b'.repeat(64)})),/FINGERPRINT_MISMATCH/);
 assert.throws(()=>f.preview.page(pageArgs(p,{offset:9999})),/INVALID_PAGE/);
});
test('each page revalidates the complete tested workspace, not just the selected file',async t=>{
 const f=await completed(t),p=f.preview.create('cloud',f.args).snapshot;f.preview.page(pageArgs(p));writeFileSync(join(f.root,'src/count.py'),'changed');
 assert.throws(()=>f.preview.page(pageArgs(p)),/FILE_CONFLICT/);assert.equal(f.preview.status(f.task.id).latest.fingerprint,p.fingerprint);
});
function exactProposal(f,p,extra={}){
 const old=f.ledger.view(f.req.id),{development,...base}=old.proposal,repo=f.repos.status(f.task.id);
 return {...base,scopes:['commit'],repository:{binding_revision:repo.binding_revision,fingerprint:repo.repository.fingerprint},delivery:{preview_id:p.id,fingerprint:p.fingerprint,commit_message:'本地隔离方案\n仅拟提交，不执行'},...extra};
}
async function deliveryRequest(t){
 const f=await completed(t);f.ledger.delivery=f.preview;const p=f.preview.create('cloud',f.args).snapshot,args={task_id:f.task.id,expected_revision:1,event_id:'delivery-plan',proposal:exactProposal(f,p)};
 const a=f.ledger.request('local',args);return {...f,p,approval:a,approvalArgs:args};
}
test('exact commit proposal is server-bound to immutable preview; chat approval only records that content, not push or execution',async t=>{
 const f=await deliveryRequest(t),a=f.approval,d=a.proposal.delivery;
 assert.equal(d.kind,'commit-preview-v1');assert.equal(d.workspace_branch,f.spec.branch);assert.equal(d.tested_content_sha256,f.p.tested_content.sha256);assert.equal(d.changed_files,3);
 assert.equal(f.ledger.view(f.req.id).state,'superseded');assert.equal(a.execution,'disabled');
 f.chat.queue(a.id);f.time(5001);await f.chat.tick();const route=f.store.db.prepare('SELECT message_id FROM approval_chat_deliveries WHERE request_id=?').get(a.id),prompt=f.messages.get(route.message_id);
 assert(prompt.body.content.includes('拟提交交付'));f.reply(prompt);await f.chat.tick();
 const approved=f.ledger.view(a.id);assert.equal(approved.state,'approved');assert.equal(f.ledger.check(a.id,'commit').executable,false);assert.equal(f.ledger.check(a.id,'commit').content_recheck_required,true);assert.equal(f.ledger.check(a.id,'push').approval_valid,false);
 const decision=f.store.db.prepare('SELECT * FROM approval_decisions WHERE request_id=?').get(a.id),receipt=renderReceipt(approved,decision,f.ledger.now());assert(receipt.includes('执行器关闭'));assert(receipt.includes('不包含推送'));assert.equal(git(f.root,'rev-parse','HEAD'),f.base_sha);
});
test('exact proposal replay does not re-resolve or revive development; current file drift blocks new proposal and pages, not immutable historical scope',async t=>{
 const f=await deliveryRequest(t),before=ledger(f.store.db);writeFileSync(join(f.root,'docs/report.md'),'drift');
 assert.equal(f.ledger.request('local',f.approvalArgs).id,f.approval.id);assert.deepEqual(ledger(f.store.db),before);
 assert.throws(()=>f.ledger.request('local',{...f.approvalArgs,event_id:'new-plan'}),/FILE_CONFLICT/);
 assert.equal(f.ledger.view(f.approval.id).state,'pending');assert.equal(f.ledger.view(f.approval.id).execution,'disabled');assert.throws(()=>f.preview.page(pageArgs(f.p)),/FILE_CONFLICT/);
});
test('delivery proposal validates source content and model before superseding any existing approval',async t=>{
 const f=await completed(t);f.ledger.delivery=f.preview;const p=f.preview.create('cloud',f.args).snapshot,base=exactProposal(f,p),args={task_id:f.task.id,expected_revision:1,event_id:'invalid-plan'};
 for(const changes of [{scopes:['commit','push']},{scopes:['push']},{scopes:['develop']},{repository:null},{model_policy:{provider:'another',model:'arbitrary'}},{delivery:{...base.delivery,branch:'main'}},{delivery:{...base.delivery,commit_message:'nul\0'}},{delivery:{...base.delivery,fingerprint:'b'.repeat(64)}}]){
  assert.throws(()=>f.ledger.request('local',{...args,proposal:{...base,...changes}}),/DELIVERY_/);assert.equal(f.ledger.view(f.req.id).state,'approved');
 }
 const n=f.store.db.prepare('SELECT count(*) n FROM approval_requests').get().n;assert.equal(n,1);
});
test('missing or modified preview invalidates bound approval; reads do not recheck workspace or modify ledgers',async t=>{
 const f=await deliveryRequest(t),before=ledger(f.store.db);f.preview.inspect=()=>{throw Error('MUST_NOT_READ_FILES_ON_VIEW');};
 assert.equal(f.ledger.view(f.approval.id).state,'pending');assert.equal(f.ledger.check(f.approval.id,'commit').executable,false);assert.deepEqual(ledger(f.store.db),before);
 f.store.db.prepare('DELETE FROM delivery_previews WHERE id=?').run(f.p.id);assert.equal(f.ledger.view(f.approval.id).state,'delivery_changed');assert.throws(()=>f.ledger.assertDecision(f.approval.id,'approve'),/NOT_PENDING/);
});
test('unsupported old peer rejects typed delivery proposal before generic approval handling',()=>{
 const h={schema:1,protocol:{min:1,max:1},plugin_version:'0.24.0-alpha.2',namespace:'delivery',instance_id:'00000000-0000-0000-0000-000000000001'},old={...CAPABILITIES};delete old.delivery_review;
 assert.throws(()=>requireCapability('approval_request',{...h,role:'local',capabilities:CAPABILITIES},{...h,role:'cloud',capabilities:old},{proposal:{delivery:{preview_id:'opaque'}}}),/CAPABILITY_VERSION_INCOMPATIBLE/);
 assert.throws(()=>requireCapability('delivery_file_page',{...h,role:'local',capabilities:CAPABILITIES},{...h,role:'cloud',capabilities:old}),/CAPABILITY_UNAVAILABLE/);
});
test('typed input cannot smuggle resolved authority fields; schema is explicit commit reference only',()=>{
 const p={preview_id:'delivery-00000000-0000-0000-0000-000000000001',fingerprint:'a'.repeat(64),commit_message:'message'};
 assert.deepEqual(deliveryReference(p),p);
 for(const extra of [{files:['README.md']},{execution:'enabled'},{push:true},{source_approval_hash:'a'.repeat(64)},{commit_message:'\tbad'},{commit_message:' '}])assert.throws(()=>deliveryReference({...p,...extra}),/INVALID_APPROVAL_REFERENCE/);
});

test('delivery confirmation cannot silently adopt changed commit text or broadened scopes in its stored record',async t=>{
 const f=await deliveryRequest(t),original=f.ledger.row(f.approval.id).proposal;
 for(const change of [p=>p.delivery.commit_message='changed',p=>p.scopes.push('push'),p=>p.delivery.tested_content_sha256='a'.repeat(64)]){
  const p=JSON.parse(original);change(p);f.store.db.prepare('UPDATE approval_requests SET proposal=? WHERE id=?').run(JSON.stringify(p),f.approval.id);
  assert.equal(f.ledger.view(f.approval.id).state,'delivery_changed');assert.throws(()=>f.ledger.assertDecision(f.approval.id,'approve'),/NOT_PENDING/);
 }
 f.store.db.prepare('UPDATE approval_requests SET proposal=? WHERE id=?').run(original,f.approval.id);assert.equal(f.ledger.view(f.approval.id).state,'pending');
});
test('semantic hold and conditional agreement apply to the exact delivery snapshot; amendments cannot revive old commit plan',async t=>{
 const f=await deliveryRequest(t);f.chat.semantic=true;f.chat.queue(f.approval.id);f.time(5001);await f.chat.tick();const r=f.store.db.prepare('SELECT message_id FROM approval_chat_deliveries WHERE request_id=?').get(f.approval.id),prompt=f.messages.get(r.message_id);
 f.reply(prompt,'先等等');await f.chat.tick();assert.equal(f.ledger.view(f.approval.id).state,'held');
 f.reply(prompt,'同意，但请把提交说明改成两行');await f.chat.tick();const v=f.ledger.view(f.approval.id);assert.equal(v.state,'changes_requested');assert.equal(v.proposal.delivery.commit_message,f.approval.proposal.delivery.commit_message);assert.equal(f.ledger.check(f.approval.id,'commit').approval_valid,false);
 f.reply(prompt,'确定');await f.chat.tick();assert.equal(f.ledger.view(f.approval.id).state,'changes_requested');
 assert.throws(()=>f.ledger.request('local',{...f.approvalArgs,event_id:'unchanged-amendment'}),/APPROVAL_AMENDMENT_REQUIRED/);
});
