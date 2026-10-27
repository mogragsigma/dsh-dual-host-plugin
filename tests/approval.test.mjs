import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,statSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {fork,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {Coordinator} from '../bundle/store.js';
import {TaskCatalog} from '../bundle/task-catalog.js';
import {ApprovalLedger} from '../bundle/approval-ledger.js';
import {ApprovalAuth} from './fixtures/legacy-approval-auth.mjs';
import {ApprovalWindow} from '../bundle/approval-http.js';
import {Gateway} from '../bundle/index.js';
import {makeEnvelope} from '../bundle/task-envelope.js';
import {registerNativeTools} from '../bundle/native-tools.js';
import {softwareAuthenticator} from './fixtures/passkey.mjs';
const policy={provider:'chosen',model:'glm-5.3',reasoningEffort:'low'},proposal={summary:'只做审批记账测试',changes:'未来可修改的计划',validation:'只读验收',risks:'不写仓库',rollback:'撤销授权',model_policy:policy,scopes:['develop'],repository:null};
function fixture(t){
 const dir=mkdtempSync(tmpdir()+'/approval-test-'),store=new Coordinator(dir),catalog=new TaskCatalog(store);let now=1792210000000;
 const l=new ApprovalLedger(store,catalog,()=>now),auth=new ApprovalAuth(l,{origin:'http://localhost:19468',rpID:'localhost'}),key=softwareAuthenticator();
 const envelope=makeEnvelope({id:'native',session:{deriveMessages:()=>[{id:'m1',role:'user',source:{kind:'user'},content:[{type:'text',text:'登记审批回归，禁止开发执行。'}]}]}},'local',{goal:'审批回归',title:'审批回归',target:'cloud',intent:'register'});
 const task=store.accept('local',{goal:envelope.goal,task_key:envelope.task_key,source:'native-local',ingress_id:envelope.ingress_id});catalog.head(task.id);
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const request=(event_id='test-request',extra={})=>l.request('local',{task_id:task.id,expected_revision:1,event_id,proposal,...extra});
 const enroll=async()=>{const ticket=auth.issueEnrollment('用户本人（隔离夹具）'),q=await auth.begin('enroll',{ticket});return auth.finish('enroll',{challenge_id:q.challenge_id,response:key.response(q.options,{register:true})});};
 const decision=async(id,action='approve',overrides={})=>{const q=await auth.begin('decision',{request_id:id,action}),response=key.response(q.options,overrides);return {q,response,result:await auth.finish('decision',{challenge_id:q.challenge_id,response})};};
 return {dir,store,catalog,l,auth,key,task,request,enroll,decision,time:n=>now+=n};
}
test('requests are durable, revision/model/scope bound and never execution',t=>{const f=fixture(t),r=f.request();assert.equal(r.state,'pending');assert.deepEqual(r.proposal.model_policy,policy);assert.equal(r.execution,'disabled');assert.deepEqual(f.request(),r);assert.throws(()=>f.request('test-request',{proposal:{...proposal,scopes:['publish']}}),/APPROVAL_EVENT_CONFLICT/);assert.throws(()=>f.request('new',{expected_revision:9}),/TASK_REVISION_CONFLICT/);
 const s=new Coordinator(f.dir);try{assert.deepEqual(new ApprovalLedger(s,new TaskCatalog(s),()=>1792210000000).view(r.id),r);}finally{s.close();}});
test('rejects scope expansion, repository strings and invalid expiry',t=>{const f=fixture(t);for(const p of [{...proposal,scopes:['admin']},{...proposal,scopes:['develop','develop']},{...proposal,repository:'https://gitee.com/a/b'},{...proposal,approved:true}])assert.throws(()=>f.request('bad',{proposal:p}));for(const ttl_seconds of [0,86401,1.5,'3600'])assert.throws(()=>f.request('bad',{ttl_seconds}),/INVALID_APPROVAL_EXPIRY/);assert.equal(f.l.list().length,0);});
test('requires separately issued enrollment; registration grants no approval',async t=>{const f=fixture(t),r=f.request();await assert.rejects(f.auth.begin('enroll',{ticket:'model generated'}),/ENROLLMENT_DENIED/);await assert.rejects(f.auth.begin('login'),/APPROVER_NOT_ENROLLED/);const e=await f.enroll();assert.equal(e.approval_granted,false);assert.equal(f.l.view(r.id).state,'pending');assert.throws(()=>f.auth.issueEnrollment('new identity'),/APPROVER_ALREADY_ENROLLED/);});
test('real crypto verifies bound decision, ignores claimed approver and makes exact replay idempotent',async t=>{const f=fixture(t),r=f.request();await f.enroll();const {q,response,result}=await f.decision(r.id);assert.equal(result.state,'approved');assert.equal(result.decision.principal,'用户本人（隔离夹具）');assert.equal(f.l.check(r.id,'develop').approval_valid,true);assert.equal(f.l.check(r.id,'publish').approval_valid,false);assert.equal(f.l.check(r.id,'develop').executable,false);
 assert.equal((await f.auth.finish('decision',{challenge_id:q.challenge_id,response,principal:'forged',request_id:'forged'})).idempotent,true);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM approval_decisions').get().n,1);assert.equal(f.store.snapshot().intents.length,0);});
for(const [name,options] of [['wrong origin',{origin:'https://evil.test'}],['wrong RP',{rpID:'evil.test'}],['missing UV',{flags:1}],['missing presence',{flags:4}],['cross-origin',{crossOrigin:true}],['top-origin',{topOrigin:'https://evil.test'}],['wrong challenge',{challenge:'fake'}]])test('rejects '+name+' without approving',async t=>{const f=fixture(t),r=f.request();await f.enroll();await assert.rejects(f.decision(r.id,'approve',options));assert.equal(f.l.view(r.id).state,'pending');});
test('tampered signature, unknown key, forged boolean and wrong ceremony cannot approve',async t=>{const f=fixture(t),r=f.request();await f.enroll();const q=await f.auth.begin('decision',{request_id:r.id,action:'approve'}),response=f.key.response(q.options);response.response.signature='AA';await assert.rejects(f.auth.finish('decision',{challenge_id:q.challenge_id,response}),/PASSKEY_VERIFICATION_FAILED/);await assert.rejects(f.auth.finish('decision',{challenge_id:q.challenge_id,response:softwareAuthenticator().response(q.options)}),/PASSKEY_VERIFICATION_FAILED/);await assert.rejects(f.auth.finish('decision',{challenge_id:q.challenge_id,response:{approved:true}}));await assert.rejects(f.auth.finish('login',{challenge_id:q.challenge_id,response}),/APPROVAL_CHALLENGE_DENIED/);assert.equal(f.l.view(r.id).state,'pending');});
test('revision, replacement, timeout and credential withdrawal invalidate pending or approved authority',async t=>{const f=fixture(t);await f.enroll();let r=f.request();await f.decision(r.id);f.store.db.prepare('UPDATE task_catalog SET spec_revision=2 WHERE task_id=?').run(f.task.id);assert.equal(f.l.view(r.id).state,'stale_revision');f.store.db.prepare('UPDATE task_catalog SET spec_revision=1 WHERE task_id=?').run(f.task.id);const r2=f.request('replacement',{proposal:{...proposal,changes:'变更方案'}});assert.equal(f.l.view(r.id).state,'superseded');await f.decision(r2.id);f.store.db.prepare('UPDATE approval_credentials SET disabled=1').run();assert.equal(f.l.view(r2.id).state,'identity_revoked');f.store.db.prepare('UPDATE approval_credentials SET disabled=0').run();f.time(3600001);assert.equal(f.l.view(r2.id).state,'expired');assert.equal(f.l.check(r2.id,'develop').approval_valid,false);});
test('challenge cannot approve another proposal or survive a concurrent replacement',async t=>{const f=fixture(t);await f.enroll();const r=f.request(),q=await f.auth.begin('decision',{request_id:r.id,action:'approve'});const r2=f.request('replace');await assert.rejects(f.auth.finish('decision',{challenge_id:q.challenge_id,response:f.key.response(q.options),request_id:r2.id}),/APPROVAL_NOT_PENDING/);assert.equal(f.l.view(r2.id).state,'pending');});
test('expiry during user ceremony fails closed',async t=>{const f=fixture(t);await f.enroll();const r=f.request(),q=await f.auth.begin('decision',{request_id:r.id,action:'approve'});f.time(120001);await assert.rejects(f.auth.finish('decision',{challenge_id:q.challenge_id,response:f.key.response(q.options)}),/APPROVAL_CHALLENGE_EXPIRED/);assert.equal(f.l.view(r.id).state,'pending');});
test('reject and revoke persist separately; login cannot stand in for a decision',async t=>{const f=fixture(t);await f.enroll();const r=f.request();const login=await f.auth.begin('login');await f.auth.finish('login',{challenge_id:login.challenge_id,response:f.key.response(login.options)});assert.equal(f.l.view(r.id).state,'pending');await f.decision(r.id,'reject');assert.equal(f.l.view(r.id).state,'rejected');const r2=f.request('second');await f.decision(r2.id);await f.decision(r2.id,'revoke');assert.equal(f.l.view(r2.id).state,'revoked');assert.equal(f.l.check(r2.id,'develop').approval_valid,false);});
test('pending challenge and approved ledger survive database re-open',async t=>{const f=fixture(t);await f.enroll();const r=f.request(),q=await f.auth.begin('decision',{request_id:r.id,action:'approve'});const s=new Coordinator(f.dir);try{const l=new ApprovalLedger(s,new TaskCatalog(s),()=>1792210000000),auth=new ApprovalAuth(l,{origin:'http://localhost:19468',rpID:'localhost'});assert.equal((await auth.finish('decision',{challenge_id:q.challenge_id,response:f.key.response(q.options)})).state,'approved');}finally{s.close();}assert.equal(f.l.view(r.id).state,'approved');});
// Runtime passkey retirement is tested in approval-workbench.test.mjs.
// Earlier cryptographic checks above use a test-only historical ledger fixture.
test('two entry RPCs share one authority and expose no approve/admin method or tool',async t=>{
 const dir=mkdtempSync(tmpdir()+'/approval-gateway-'),tokenFile=dir+'/tokens';writeFileSync(tokenFile,JSON.stringify({localToken:'l'.repeat(32),cloudToken:'c'.repeat(32)}),{mode:0o600});const ctx={on(){},effect(){},agents:{get(){},list:()=>[]},agentPresets:{composedPreset:()=> 'standard'}};
 const cloud=new Gateway(ctx,{role:'cloud',entryMode:'native',namespace:'approval',stateDir:dir+'/cloud',tokenFile,port:0});await cloud.start();const local=new Gateway(ctx,{role:'local',entryMode:'native',namespace:'approval',stateDir:dir+'/local',tokenFile,port:0,coordinatorUrl:'http://127.0.0.1:'+cloud.server.address().port});t.after(async()=>{await local.close();await cloud.close();rmSync(dir,{recursive:true,force:true});});
 const e=makeEnvelope({id:'test',session:{deriveMessages:()=>[{id:'m',role:'user',source:{kind:'user'},content:[{type:'text',text:'仅登记'}]}]}},'local',{goal:'审批',target:'cloud',intent:'register'}),task=await local.submit({goal:e.goal,task_key:e.task_key,ingress_id:e.ingress_id,source:'native-local'}),a=await local.call('approval_request',{task_id:task.task_id,expected_revision:1,event_id:'request',proposal});assert.equal((await cloud.call('approval_status',{task_id:task.task_id})).items[0].id,a.id);
 for(const method of ['approve','approval_decide','approval_enroll','chat_confirm','approval_chat_verify','apply','write'])await assert.rejects(local.call(method,{approved:true}),/METHOD_DENIED/);
 const names=[];registerNativeTools({taskGateway:local,tools:{register:d=>names.push(d.name)}});assert.equal(names.length,56);for(const n of ['task_approval_reference','task_delivery_prepare','task_delivery_schedule','task_delivery_push_prepare','task_delivery_push_start'])assert(names.includes(n));assert(names.includes('task_development_start'));assert(!names.some(x=>/approve|enroll|approval_workbench/.test(x)));assert.equal(cloud.store.snapshot().intents.length,0);
});


test('SIGKILL then new process resumes a persisted decision without duplicate authorization',async t=>{
 const f=fixture(t);await f.enroll();const r=f.request();let child;
 async function start(){child=fork(new URL('./approval-process-child.mjs',import.meta.url),[f.dir],{stdio:['ignore','ignore','ignore','ipc']});const [m]=await once(child,'message');assert.equal(m.ready,true);}
 async function stop(){const p=child;child=null;if(p){p.kill('SIGKILL');await once(p,'exit');}}
 const call=(op,args)=>new Promise((resolve,reject)=>{const id=String(Math.random());child.once('message',m=>m.error?reject(Error(m.error)):resolve(m.value));child.send({id,op,args});});
 t.after(stop);await start();const q=await call('begin',{request_id:r.id,action:'approve'});await stop();await start();const args={challenge_id:q.challenge_id,response:f.key.response(q.options)};assert.equal((await call('finish',args)).state,'approved');await stop();await start();assert.equal((await call('read',{id:r.id})).state,'approved');assert.equal((await call('finish',args)).idempotent,true);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM approval_decisions').get().n,1);await stop();
});


test('enrollment also requires UV, expires, and rotated invitations cannot bind an attacker',async t=>{
 const f=fixture(t),old=f.auth.issueEnrollment('owner'),ticket=f.auth.issueEnrollment('owner');await assert.rejects(f.auth.begin('enroll',{ticket:old}),/ENROLLMENT_DENIED/);
 const q=await f.auth.begin('enroll',{ticket});await assert.rejects(f.auth.finish('enroll',{challenge_id:q.challenge_id,response:f.key.response(q.options,{register:true,flags:0x41})}),/PASSKEY_VERIFICATION_FAILED/);assert.equal(f.auth.credentials().length,0);f.time(600001);await assert.rejects(f.auth.begin('enroll',{ticket}),/ENROLLMENT_DENIED/);
});
test('retired administrative invitation creates no file or enrollment',t=>{
 const f=fixture(t),file=f.dir+'/invitation.txt',before=f.store.db.prepare('SELECT * FROM approval_enrollment').all();
 assert.throws(()=>execFileSync(process.execPath,[decodeURIComponent(new URL('../scripts/prepare-enrollment.mjs',import.meta.url).pathname),f.dir+'/missing-config.json','test owner',file],{encoding:'utf8',stdio:'pipe'}),e=>e.status===1&&String(e.stderr).includes('已停用'));
 assert.equal(existsSync(file),false);assert.deepEqual(f.store.db.prepare('SELECT * FROM approval_enrollment').all(),before);
});

test('concurrent challenge requests cannot bypass the pending limit',async t=>{
 const f=fixture(t);await f.enroll();const results=await Promise.allSettled(Array.from({length:130},()=>f.auth.begin('login')));assert.equal(results.filter(x=>x.status==='fulfilled').length,100);assert(results.filter(x=>x.status==='rejected').every(x=>/APPROVAL_RATE_LIMIT/.test(x.reason.message)));f.time(800000);assert((await f.auth.begin('login')).challenge_id);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM approval_challenges').get().n,1);
});
test('repository tools across two authenticated entries share binding CAS and no writer methods',async t=>{
 const dir=mkdtempSync(tmpdir()+'/repo-rpc-'),tokenFile=dir+'/tokens';writeFileSync(tokenFile,JSON.stringify({localToken:'l'.repeat(32),cloudToken:'c'.repeat(32)}),{mode:0o600});
 const ctx={on(){},effect(){},agents:{list:()=>[]},agentPresets:{}};
 const cloud=new Gateway(ctx,{role:'cloud',entryMode:'native',namespace:'repository',stateDir:dir+'/cloud',tokenFile,port:0,peerEnabled:false});await cloud.start();
 const local=new Gateway(ctx,{role:'local',entryMode:'native',namespace:'repository',stateDir:dir+'/local',tokenFile,port:0,peerEnabled:false,coordinatorUrl:'http://127.0.0.1:'+cloud.server.address().port});
 t.after(async()=>{await local.close();await cloud.close();rmSync(dir,{recursive:true,force:true});});
 const url='https://gitee.com/isolated/repo',raw='隔离：关联 '+url+'，不执行。',agent={id:'native',session:{deriveMessages:()=>[{id:'msg',role:'user',source:{kind:'user'},content:[{type:'text',text:raw}]}]}},e=makeEnvelope(agent,'local',{goal:'只登记',target:'cloud',intent:'register'});
 cloud.repositories.provider={reference:()=>({url}),inspect:async()=>({provider:'gitee',repository_id:1,url,branch:'main',base_sha:'a'.repeat(40),private:true,workspace:null})};
 const task=await local.submit({goal:e.goal,task_key:e.task_key,ingress_id:e.ingress_id,source:'native-local'}),resolved=await local.call('repository_resolve',{reference:url});
 const {selectedHumanContext}=await import('../bundle/task-envelope.js'),a={task_id:task.task_id,expected_revision:1,expected_binding_revision:0,resolution_id:resolved.resolution_id,event_id:'rpc-bind',sources:selectedHumanContext(agent,'local')};
 const b=await local.call('repository_bind',a);assert.equal(b.binding_revision,1);assert.equal((await cloud.call('repository_status',{task_id:task.task_id})).repository.fingerprint,b.repository.fingerprint);
 assert.equal((await local.call('repository_bind',a)).replayed,true);assert.equal((await local.call('repository_gate',{task_id:task.task_id})).executable,false);
 for(const method of ['repository_write','repository_clone','repository_commit','repository_push','begin','drain','release'])await assert.rejects(local.call(method,{task_id:task.task_id}),/METHOD_DENIED/);
 assert.equal(cloud.store.snapshot().intents.length,0);assert.equal(cloud.writer.bindings.size,0);
});
