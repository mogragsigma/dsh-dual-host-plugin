import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {GiteeReadOnly,repositoryURL,repositoryBranch} from '../bundle/repository-gitee.js';
import {RepositoryCatalog} from '../bundle/repository-catalog.js';
import {ApprovalLedger,digest} from '../bundle/approval-ledger.js';
import {Coordinator} from '../bundle/store.js';
import {TaskCatalog} from '../bundle/task-catalog.js';
import {makeEnvelope} from '../bundle/task-envelope.js';
import {renderChatProposal} from '../bundle/approval-chat.js';
import {renderReceipt} from '../bundle/approval-receipts.js';
import {fixture,proposal} from './approval-fixture.mjs';
const url='https://gitee.com/owner/repo',sha='a'.repeat(40),snapshot={provider:'gitee',repository_id:1,url,branch:'main',base_sha:sha,private:true,workspace:null};
const source=(text=url,role='local')=>({role,session_id:'session',message_id:'msg',text,sha256:digest(text)});
function setup(t){
 const f=fixture(t);let current={...snapshot},fail=null,busy=false,pause=null;
 const provider={reference:r=>({url:r}),inspect:async()=>{if(pause)await pause;if(fail)throw Error(fail);return {...current};}};
 const repos=new RepositoryCatalog(f.store,f.catalog,provider,()=>f.ledger.now(),()=>{if(busy)throw Error('TASK_NOT_QUIESCENT');});f.ledger.repositories=repos;
 const resolve=()=>repos.resolve({reference:url});
 const bind=(r,extra={})=>repos.mutate('local',{task_id:f.task.id,expected_revision:1,expected_binding_revision:repos.status(f.task.id).binding_revision,resolution_id:r.resolution_id,event_id:'bind-'+Math.random(),sources:[source()],...extra});
 const request=(extra={})=>{const r=repos.status(f.task.id);return f.ledger.request('local',{task_id:f.task.id,expected_revision:1,event_id:'req-'+Math.random(),proposal:{...proposal,repository:r.repository?{binding_revision:r.binding_revision,fingerprint:r.repository.fingerprint}:null},...extra});};
 const approve=v=>{f.store.db.prepare('INSERT OR IGNORE INTO approval_credentials VALUES (?,?,?,0,0,?)').run('fixture-credential','fixture',Buffer.from('isolated'),f.ledger.now());return f.store.tx(()=>f.ledger.recordDecision({request_id:v.id,action:'approve',principal:'isolated-fixture',credential_id:'fixture-credential',proof_hash:'proof-'+v.id,challenge_id:'challenge-'+v.id}));};
 return {...f,repos,provider,resolve,bind,request,approve,set:v=>current={...current,...v},fail:v=>fail=v,busy:v=>busy=v,pause:v=>pause=v};
}
test('strict canonical Gitee URLs support HTTPS/SSH without fetching arbitrary hosts',()=>{
 for(const x of [url,url+'.git',url+'/', 'git@gitee.com:owner/repo.git'])assert.equal(repositoryURL(x).url,url);
 for(const x of ['http://gitee.com/o/r','https://evil.com/o/r','https://gitee.com.evil/o/r','https://x:y@gitee.com/o/r','https://gitee.com:443/o/r',url+'?token=secret',url+'#main',url+'/tree/main','https://gitee.com/o/../r','https://gitee.com/o/%72','https://gitee.com/o/.git','file:///tmp/repo'])assert.throws(()=>repositoryURL(x));
});
test('branch validation rejects ref injection and accepts an existing slash branch',()=>{assert.equal(repositoryBranch('feature/a'),'feature/a');for(const s of ['','../main','main..x','a.lock','a/.x','x?y','main\n','x@{y','a//b','a\\b','a:foo'])assert.throws(()=>repositoryBranch(s));});
test('unknown and colliding aliases clarify without network requests',()=>{const p=new GiteeReadOnly({aliases:[{name:'我的项目',url},{name:'我的项目',url:url+'2'}]},{fetch:()=>assert.fail('network')});assert.equal(p.reference('我的项目').candidates.length,2);assert.equal(p.reference('不存在').reason,'UNKNOWN_REPOSITORY_ALIAS');});
test('Gitee adapter issues only bounded fixed-origin GET and reports no write permission',async()=>{
 const calls=[],p=new GiteeReadOnly({}, {fetch:async(u,o)=>{calls.push([u,o]);return Response.json(calls.length===1?{id:1,full_name:'owner/repo',private:true,default_branch:'main'}:{name:'main',commit:{sha}});}});
 assert.deepEqual(await p.inspect(url),snapshot);assert.equal(calls.length,2);for(const [u,o] of calls){assert(u.startsWith('https://gitee.com/api/v5/repos/owner/repo'));assert.equal(o.method,'GET');assert.equal(o.redirect,'error');assert(!u.includes('token'));assert(!o.body);}
});
test('credentials remain private headers, never URLs; public secret files and symlinks rejected',async t=>{
 const dir=mkdtempSync(tmpdir()+'/repo-secret-'),file=dir+'/token';t.after(()=>rmSync(dir,{recursive:true,force:true}));writeFileSync(file,'test-secret-'.repeat(4),{mode:0o600});
 const p=new GiteeReadOnly({tokenFile:file},{fetch:async(u,o)=>{assert(!u.includes('secret'));assert(o.headers.Authorization.startsWith('Bearer '));return Response.json({});}});await p.get('/repos/o/r');chmodSync(file,0o644);assert.throws(()=>new GiteeReadOnly({tokenFile:file}),/SECRET_FILE_PERMISSIONS/);
});
for(const [status,code] of [[404,'NOT_FOUND_OR_PRIVATE'],[403,'ACCESS_DENIED'],[401,'ACCESS_DENIED'],[429,'RATE_LIMIT'],[503,'PROVIDER_UNAVAILABLE']])test('provider failure '+status+' is sanitized',async()=>{const p=new GiteeReadOnly({}, {fetch:async()=>new Response('SENSITIVE_RAW_RESPONSE',{status})});await assert.rejects(p.inspect(url),new RegExp('REPOSITORY_'+code));});
test('timeouts and malformed provider bodies do not leak exceptions',async()=>{let p=new GiteeReadOnly({}, {fetch:async()=>{throw Error('token-secret-stack');}});await assert.rejects(p.inspect(url),/^Error: REPOSITORY_PROVIDER_UNAVAILABLE$/);p=new GiteeReadOnly({}, {fetch:async()=>new Response('bad secret')});await assert.rejects(p.inspect(url),/RESPONSE_INVALID/);});
test('oversized response rejected by content length and stream bound',async()=>{for(const hdr of [{},{'content-length':'1048577'}]){const p=new GiteeReadOnly({}, {fetch:async()=>new Response('x'.repeat(1048577),{headers:hdr})});await assert.rejects(p.inspect(url),/RESPONSE_TOO_LARGE/);}});
test('provider identity substitution, mismatched branch and absent branch do not fallback',async()=>{
 const cases=[{id:1,full_name:'evil/repo',private:true,default_branch:'main'},{id:1,full_name:'owner/repo',private:true,default_branch:null}];for(const meta of cases){const p=new GiteeReadOnly({}, {fetch:async()=>Response.json(meta)});await assert.rejects(p.inspect(url));}
 let count=0;const p=new GiteeReadOnly({}, {fetch:async()=>Response.json(++count===1?{id:1,full_name:'owner/repo',private:true}:{name:'other',commit:{sha}})});await assert.rejects(p.inspect(url,'missing'),/BRANCH_RESPONSE_INVALID/);assert.equal(count,2);
});
test('binding is durable metadata, not a checkout or execution grant; replay stays idempotent',async t=>{
 const f=setup(t),r=await f.resolve(),v=f.bind(r,{event_id:'same'});assert.equal(v.binding_revision,1);assert.equal(v.execution,'disabled');assert.equal(v.workspace,'not_checked_out');
 assert.equal(f.bind(r,{event_id:'same',expected_binding_revision:0}).replayed,true);assert.throws(()=>f.bind(r,{event_id:'same'}),/EVENT_CONFLICT/);
 const reopened=new RepositoryCatalog(f.store,f.catalog,f.provider,f.ledger.now);assert.deepEqual(reopened.status(f.task.id),v);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM repository_events').get().n,1);
});
test('binding requires direct matching user reference and role; model-only URL rejected',async t=>{const f=setup(t),r=await f.resolve();for(const sources of [[],[source('unrelated')],[source(url,'cloud')]])assert.throws(()=>f.bind(r,{sources}),/CONTEXT|REFERENCE/);});
test('explicit nondefault branch must appear in selected user source',async t=>{const f=setup(t);f.set({branch:'feature/test'});const r=await f.repos.resolve({reference:url,branch:'feature/test'});assert.throws(()=>f.bind(r),/REFERENCE_NOT_IN_USER/);assert.equal(f.bind(r,{sources:[source(url+' feature/test')]}).state,'bound');});
test('binding CAS and stale resolutions are rejected without side effects',async t=>{const f=setup(t),r=await f.resolve();assert.throws(()=>f.bind(r,{expected_revision:2}),/TASK_REVISION_CONFLICT/);assert.throws(()=>f.bind(r,{expected_binding_revision:1}),/REPOSITORY_REVISION_CONFLICT/);f.time(300001);assert.throws(()=>f.bind(r),/RESOLUTION_EXPIRED/);assert.equal(f.repos.status(f.task.id).binding_revision,0);});
test('busy or unfinished work blocks metadata change, too',async t=>{const f=setup(t),r=await f.resolve();f.busy(true);assert.throws(()=>f.bind(r),/NOT_QUIESCENT/);assert.equal(f.repos.status(f.task.id).binding_revision,0);});
test('approval snapshots use authoritative data and exact binding reference',async t=>{const f=setup(t);f.bind(await f.resolve());assert.throws(()=>f.ledger.request('local',{task_id:f.task.id,expected_revision:1,event_id:'bad',proposal}),/REFERENCE_MISMATCH/);const v=f.request();assert.equal(v.proposal.repository.base_sha,sha);assert.equal(v.repository_revision,1);assert.equal(v.proposal.repository.repository_id,1);assert(renderChatProposal(v).includes(sha));assert(renderReceipt(v,{action:'approve',created:f.ledger.now(),id:'fixture'},f.ledger.now()).includes(url));});
test('freshness required to create approval but temporary outage is not a new approval',async t=>{const f=setup(t);f.bind(await f.resolve());const old=f.request();f.time(300001);assert.throws(()=>f.request(),/REVERIFY_REQUIRED/);assert.equal(f.ledger.view(old.id).state,'pending');await f.repos.refresh(f.task.id);assert.equal(f.request().state,'pending');});
test('changed remote HEAD invalidates approval permanently even if HEAD later returns',async t=>{const f=setup(t);f.bind(await f.resolve());const v=f.approve(f.request());f.set({base_sha:'b'.repeat(40)});await f.repos.refresh(f.task.id);assert.equal(f.ledger.view(v.id).state,'repository_changed');f.set({base_sha:sha});await f.repos.refresh(f.task.id);assert.equal(f.ledger.view(v.id).state,'repository_changed');assert.throws(()=>f.request(),/REVERIFY_REQUIRED/);});
test('unbound approval cannot revive after bind then unbind',async t=>{const f=setup(t),v=f.approve(f.request());f.bind(await f.resolve());assert.equal(f.ledger.view(v.id).state,'repository_changed');f.repos.mutate('local',{task_id:f.task.id,expected_revision:1,expected_binding_revision:1,event_id:'unbind',sources:[source('移除关联')]},true);assert.equal(f.ledger.view(v.id).state,'repository_changed');assert.equal(f.request().repository_revision,2);});
test('replacement binding supersedes old authority without changing task specification',async t=>{const f=setup(t);f.bind(await f.resolve());const v=f.approve(f.request());f.set({branch:'dev'});f.bind(await f.resolve());assert.equal(f.ledger.view(v.id).state,'repository_changed');assert.equal(f.catalog.head(f.task.id).spec_revision,1);});
test('late provider response cannot overwrite a newer unbind',async t=>{const f=setup(t);f.bind(await f.resolve());let release;f.pause(new Promise(r=>release=r));const pending=f.repos.refresh(f.task.id);f.repos.mutate('local',{task_id:f.task.id,expected_revision:1,expected_binding_revision:1,event_id:'unbind-race',sources:[source('移除')]},true);release();assert.equal((await pending).state,'unbound');});
test('network failure clears freshness without raw error or silent approval grant',async t=>{const f=setup(t);f.bind(await f.resolve());f.fail('secret raw failure');const v=await f.repos.refresh(f.task.id);assert.equal(v.verification_fresh,false);assert.equal(v.last_error,'REPOSITORY_PROVIDER_UNAVAILABLE');});
test('private/denied identity requires explicit rebind rather than reviving old approval',async t=>{const f=setup(t);f.bind(await f.resolve());const v=f.request();f.fail('REPOSITORY_ACCESS_DENIED');await f.repos.refresh(f.task.id);assert.equal(f.ledger.view(v.id).state,'repository_changed');});
test('gate revalidates and remains closed even with exact approval; no queue or ownership mutation',async t=>{
 const f=setup(t);f.bind(await f.resolve());const v=f.approve(f.request()),before=JSON.stringify(f.store.status(f.task.id));
 const gate=await f.repos.gate(f.task.id,{approval_id:v.id,action:'develop',model_policy:proposal.model_policy},f.ledger);assert.equal(gate.approval_valid,true);assert.equal(gate.executable,false);assert.equal(gate.queued,false);assert(gate.blockers.includes('WORKSPACE_NOT_BOUND'));assert.equal(JSON.stringify(f.store.status(f.task.id)),before);
 for(const a of [{action:'push',model_policy:proposal.model_policy},{action:'develop',model_policy:{provider:'other',model:'other'}},{}])assert.equal((await f.repos.gate(f.task.id,{approval_id:v.id,...a},f.ledger)).approval_valid,false);
});
test('busy task gate denies without scheduling any deferred write',async t=>{const f=setup(t);f.bind(await f.resolve());f.busy(true);const v=await f.repos.gate(f.task.id,{},f.ledger);assert(v.blockers.includes('TASK_NOT_QUIESCENT'));assert.equal(v.queued,false);});
test('approval request retry after rebind returns the original invalidated snapshot',async t=>{const f=setup(t);f.bind(await f.resolve());const r=f.repos.status(f.task.id),a={task_id:f.task.id,expected_revision:1,event_id:'stable',proposal:{...proposal,repository:{binding_revision:r.binding_revision,fingerprint:r.repository.fingerprint}}},v=f.ledger.request('local',a);f.bind(await f.resolve());const retry=f.ledger.request('local',a);assert.equal(retry.id,v.id);assert.equal(retry.state,'repository_changed');assert.equal(retry.proposal.repository.binding_revision,1);});
test('metadata and approval invalidation survive a full SQLite close/reopen',async t=>{
 const dir=mkdtempSync(tmpdir()+'/repo-restart-');t.after(()=>rmSync(dir,{recursive:true,force:true}));let store=new Coordinator(dir),catalog=new TaskCatalog(store);
 const e=makeEnvelope({id:'native',session:{deriveMessages:()=>[{id:'m1',role:'user',source:{kind:'user'},content:[{type:'text',text:url}]}]}},'local',{goal:'只登记',target:'cloud',intent:'register'}),task=store.accept('local',{goal:e.goal,task_key:e.task_key,source:'native-local',ingress_id:e.ingress_id});
 const provider={reference:()=>({url}),inspect:async()=>snapshot};let repos=new RepositoryCatalog(store,catalog,provider),ledger=new ApprovalLedger(store,catalog,Date.now,repos);const r=await repos.resolve({reference:url});repos.mutate('local',{task_id:task.id,expected_revision:1,expected_binding_revision:0,event_id:'persist',resolution_id:r.resolution_id,sources:[source()]});const s=repos.status(task.id),v=ledger.request('local',{task_id:task.id,expected_revision:1,event_id:'ap',proposal:{...proposal,repository:{binding_revision:1,fingerprint:s.repository.fingerprint}}});store.close();
 store=new Coordinator(dir);catalog=new TaskCatalog(store);repos=new RepositoryCatalog(store,catalog,provider);ledger=new ApprovalLedger(store,catalog,Date.now,repos);assert.equal(repos.status(task.id).repository.base_sha,sha);assert.equal(ledger.view(v.id).state,'pending');store.close();
});
test('cross-task approval cannot satisfy another task gate',async t=>{
 const f=setup(t);f.bind(await f.resolve());const approval=f.approve(f.request());
 const e=makeEnvelope({id:'other',session:{deriveMessages:()=>[{id:'m-other',role:'user',source:{kind:'user'},content:[{type:'text',text:'另一项任务 '+url}]}]}},'local',{goal:'另一项任务',target:'cloud',intent:'register'}),other=f.store.accept('local',{goal:e.goal,task_key:e.task_key,source:'native-local',ingress_id:e.ingress_id});
 const r=await f.resolve();f.repos.mutate('local',{task_id:other.id,expected_revision:1,expected_binding_revision:0,resolution_id:r.resolution_id,event_id:'other-bind',sources:[source()]});
 const gate=await f.repos.gate(other.id,{approval_id:approval.id,action:'develop',model_policy:proposal.model_policy},f.ledger);assert.equal(gate.approval_valid,false);assert.equal(gate.executable,false);
});
test('persisted repository_changed state also prevents prior read-only ledger from reviving approval',async t=>{
 const f=setup(t);f.bind(await f.resolve());const v=f.approve(f.request());f.bind(await f.resolve());
 const priorSemantics=new ApprovalLedger(f.store,f.catalog,f.ledger.now);assert.equal(priorSemantics.view(v.id).state,'repository_changed');
});
test('reply-bound chat approval and ledger receipt carry the authoritative repository snapshot',async t=>{
 const f=setup(t);f.bind(await f.resolve());const v=f.request();f.chat.queue(v.id);await f.chat.tick();
 const prompt=[...f.messages.values()][0];assert(JSON.parse(prompt.body.content).text.includes(sha));
 f.reply(prompt);await f.chat.tick();const current=f.ledger.view(v.id);assert.equal(current.state,'approved');assert.equal(current.proposal.repository.url,url);
 const receipt=[...f.messages.values()].find(m=>JSON.parse(m.body.content).text.includes('审批账本回执'));assert(receipt);assert(JSON.parse(receipt.body.content).text.includes(sha));
 f.set({base_sha:'c'.repeat(40)});const gate=await f.repos.gate(f.task.id,{approval_id:v.id,action:'develop',model_policy:proposal.model_policy},f.ledger);assert.equal(gate.approval_valid,false);assert.equal(f.ledger.view(v.id).state,'repository_changed');
});
