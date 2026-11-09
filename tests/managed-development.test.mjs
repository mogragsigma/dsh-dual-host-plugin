import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,realpathSync,writeFileSync,mkdirSync,rmSync,symlinkSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {ManagedDevelopment,treeSnapshot,changedFiles,repositoryResources} from '../bundle/managed-development.js';
import {developmentContract,assertCliDestination,managedResourceBusy,legacyResourceBusy} from '../bundle/managed-development-contract.js';
import {assertExplicitRisk} from '../bundle/managed-policy.js';
import {ManagedSlots} from '../bundle/managed-runtime.js';
const git=(cwd,...args)=>execFileSync('/usr/bin/git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{...process.env,GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'}}).trim();
function fixture(t,{plain=false,delivery='workspace'}={}){
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'r5-development-'))),cwd=join(dir,'work');mkdirSync(cwd);writeFileSync(join(cwd,'source.txt'),'original\n');
 if(!plain){git(cwd,'init','-b','task-r5');git(cwd,'add','.');git(cwd,'commit','-m','fixture baseline');}
 const db=new DatabaseSync(':memory:'),e={db,g:{now:()=>1234,c:{role:'cloud'}}},dev=new ManagedDevelopment(e),d={delivery,...(!plain?{branch:'task-r5'}:{}),checks:[{name:'check',command:'test -f source.txt'}],artifacts:['source.txt']},b={item:{task_id:'fixture-task',revision:1,spec:{cwd,development:d}}};dev.begin(b);t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
 const check=(v={kind:'foreground',exitCode:0})=>{const token=dev.before(b,{name:'bash',arguments:{command:d.checks[0].command}},cwd);dev.after(b,token,{value:v});};return {dir,cwd,db,e,dev,b,d,check};
}
test('agreement is task-specific, remote optional; no IM identity and no implicit Git write',()=>{
 const basic={delivery:'workspace',checks:[],no_checks_reason:'文档人工核对',artifacts:['report.docx']};assert.deepEqual(developmentContract(basic,'cloud'),basic);
 for(const x of [{...basic,delivery:'publish'},{...basic,no_checks_reason:undefined},{...basic,delivery:'push',branch:'r5',remote:'https://token@github.com/a/b'},{...basic,artifacts:['../secret']},{...basic,artifacts:['.env']},{...basic,delivery:'pr',branch:'r5',base:'main',remote:'https://gitee.com/a/b'}])assert.throws(()=>developmentContract(x,'cloud'),/TASK_DEVELOPMENT_/);
 assert.throws(()=>developmentContract({...basic,delivery:'commit',branch:'r5'},'local'),/LOCAL_CLI/);
});
test('CLI task mode opens only agreed writes; high risk remains blocked and local unchanged',()=>{
 const run=(command,delivery,role='cloud')=>assertExplicitRisk({name:'bash',arguments:{command}},'/fixture',{role,development:delivery?{delivery}:undefined});
 assert.throws(()=>run('git commit -m test'),/REVIEW/);run('git commit -m test','commit');assert.throws(()=>run('git push origin task','commit'),/REVIEW/);run('git push origin task','push');run('gh pr create --base main','pr');
 for(const c of ['git push --force','git reset --hard','git commit --amend','git rebase main','gh pr merge','gh pr close','npm publish','systemctl restart app','rm -rf x'])assert.throws(()=>run(c,'pr'),/REVIEW/);
 assert.throws(()=>run('git commit -m test','commit','local'),/REVIEW/);
});
test('real Git diff covers addition, deletion, binary and pre-existing changes honestly',t=>{
 const f=fixture(t);writeFileSync(join(f.cwd,'preexisting.txt'),'user change');f.b.item.revision=2;f.dev.begin(f.b);writeFileSync(join(f.cwd,'binary.bin'),Buffer.from([0,255]));unlinkSync(join(f.cwd,'source.txt'));
 const e=f.dev.inspect(f.b);assert.equal(e.preexisting_changes,true);assert.equal(e.changes.find(c=>c.path==='source.txt').kind,'deleted');assert.equal(e.changes.find(c=>c.path==='binary.bin').preview.format,'binary_or_invalid_utf8');assert(!e.changes.some(c=>c.path==='preexisting.txt'));
});
test('native check states never manufacture success; relevant changes invalidate pass',t=>{
 const f=fixture(t);assert.throws(()=>f.dev.ready(f.b,'review'),/CHECKS_NOT_CURRENT/);
 for(const result of [{exitCode:1},{kind:'background',jobId:'job'},{kind:'promoted'},{exitCode:0,timedOut:true},null]){f.check(result);assert.notEqual(f.dev.inspect(f.b).checks[0].state,'passed');}
 f.check();assert.equal(f.dev.ready(f.b,'review').delivery.state,'workspace_ready');writeFileSync(join(f.cwd,'source.txt'),'changed\n');assert.equal(f.dev.inspect(f.b).checks[0].state,'stale');assert.throws(()=>f.dev.ready(f.b,'review'),/CHECKS_NOT_CURRENT/);f.check();assert.equal(f.dev.ready(f.b,'review').review.source,'worker_self_review');
});
test('check that modifies its input cannot certify resulting tree; unknown exception stays unknown',t=>{
 const f=fixture(t),token=f.dev.before(f.b,{name:'bash',arguments:{command:f.d.checks[0].command}},f.cwd);writeFileSync(join(f.cwd,'source.txt'),'during');f.dev.after(f.b,token,{value:{exitCode:0}});assert.equal(f.dev.inspect(f.b).checks[0].state,'changed_during_check');
});
test('plain files do not require Git/Gitee and local command results retain original exit semantics',t=>{
 const f=fixture(t,{plain:true});f.e.g.c.role='local';f.d.checks=[{name:'native-leaf',command:'verify'}];const token=f.dev.before(f.b,{name:'managed_command',arguments:{name:'verify'}},f.cwd);f.dev.after(f.b,token,{exit_code:0,drained:true});assert.equal(f.dev.ready(f.b,'file review').delivery.state,'workspace_ready');
});
test('commit/push readback uses actual native Git, pure bare remote, no platform dependency',t=>{
 const f=fixture(t,{delivery:'push'}),remote=join(f.dir,'remote.git');git(f.dir,'init','--bare',remote);f.d.remote=remote;git(f.cwd,'remote','add','origin',f.d.remote);
 writeFileSync(join(f.cwd,'source.txt'),'implemented\n');f.check();git(f.cwd,'add','.');git(f.cwd,'commit','-m','implemented');assert.throws(()=>f.dev.ready(f.b,'review'),/GIT_READ|REMOTE_NOT/);
 f.dev.before(f.b,{name:'bash',arguments:{command:'git push origin task-r5'}},f.cwd);git(f.cwd,'push','origin','task-r5');const e=f.dev.ready(f.b,'review');assert.equal(e.delivery.state,'remote_commit_verified');assert.equal(e.delivery.commit,git(f.cwd,'rev-parse','HEAD'));assert.equal(e.published,false);assert.equal(e.user_accepted,false);
 git(f.cwd,'remote','set-url','origin','https://github.com/fixture/other.git');assert.throws(()=>f.dev.before(f.b,{name:'bash',arguments:{command:'git push origin task-r5'}},f.cwd),/REMOTE_CHANGED/);
});
test('worktree common directory serializes native tasks and old URL journal conflicts both directions',t=>{
 const f=fixture(t),wt=join(f.dir,'worktree');git(f.cwd,'worktree','add','-b','other',wt);const slots=new ManagedSlots(f.db),a=repositoryResources(f.cwd,{remote:'git@gitee.com:fixture/project.git'}),b=repositoryResources(wt,{remote:'https://gitee.com/fixture/project'});
 assert.equal(a[0],b[0]);assert(slots.reserve({task_id:'one',role:'cloud',resources:a}).reserved);assert.equal(slots.reserve({task_id:'two',role:'cloud',resources:b}).reason,'resource_busy');assert(managedResourceBusy(f.db,'https://gitee.com/fixture/project'));
 f.db.exec("CREATE TABLE delivery_actions(resource TEXT,state TEXT);INSERT INTO delivery_actions VALUES('https://gitee.com/fixture/project','needs_review')");assert(legacyResourceBusy(f.db,a));
});
test('symlink or submodule cannot be silently certified; historical baseline survives endpoint restart',t=>{
 const f=fixture(t);symlinkSync(join(f.dir,'missing'),join(f.cwd,'link'));assert.throws(()=>f.dev.ready(f.b,'review'),/TREE_INCOMPLETE/);unlinkSync(join(f.cwd,'link'));f.check();const restarted=new ManagedDevelopment(f.e),b={item:f.b.item};restarted.begin(b);assert.equal(restarted.ready(b,'review').fingerprint,f.dev.ready(f.b,'review').fingerprint);
});

test('required ignored artifact participates in check freshness instead of silently bypassing Git inputs',t=>{
 const f=fixture(t);writeFileSync(join(f.cwd,'.gitignore'),'output.bin\n');f.d.artifacts.push('output.bin');writeFileSync(join(f.cwd,'output.bin'),'one');f.check();writeFileSync(join(f.cwd,'output.bin'),'two');assert.throws(()=>f.dev.ready(f.b,'review'),/CHECKS_NOT_CURRENT/);
});

test('PR readback checks exact repository/branch/base/head and never substitutes a push for PR',t=>{
 const f=fixture(t,{delivery:'pr'}),remote=join(f.dir,'remote.git');git(f.dir,'init','--bare',remote);f.d.remote='https://github.com/fixture/r5.git';f.d.base='main';git(f.cwd,'config','url.'+remote+'.insteadOf',f.d.remote);git(f.cwd,'remote','add','origin',f.d.remote);writeFileSync(join(f.cwd,'source.txt'),'implemented\n');f.check();git(f.cwd,'add','.');git(f.cwd,'commit','-m','implemented');git(f.cwd,'push','origin','task-r5');
 const bin=join(f.dir,'bin');mkdirSync(bin);const old=process.env.PATH;process.env.PATH=bin+':'+old;t.after(()=>process.env.PATH=old);
 const response={url:'https://github.com/fixture/r5/pull/7',headRefName:'task-r5',headRefOid:git(f.cwd,'rev-parse','HEAD'),baseRefName:'main',state:'OPEN',isDraft:false};
 const mock=x=>writeFileSync(join(bin,'gh'),'#!/bin/sh\nprintf \'%s\\n\' \''+JSON.stringify(x)+'\'\n',{mode:0o700});mock(response);assert.equal(f.dev.ready(f.b,'review').delivery.state,'pr_verified');
 for(const change of [{headRefOid:'a'.repeat(40)},{baseRefName:'other'},{isDraft:true},{state:'MERGED'},{url:'https://evil.invalid/fixture/r5/pull/7'}]){mock({...response,...change});assert.throws(()=>f.dev.ready(f.b,'review'),/PR_NOT_VERIFIED/);}
});

test('explicit native CLI cannot silently push another branch/remote or create a different PR',()=>{
 const d={remote:'https://github.com/fixture/r5.git',branch:'task-r5',base:'main'};
 for(const c of ['git push origin task-r5','git push -u origin HEAD:refs/heads/task-r5','gh pr create --repo fixture/r5 --base main --head task-r5 --title "fixture"'])assert.doesNotThrow(()=>assertCliDestination(c,d));
 for(const c of ['git push','git push origin','git push evil task-r5','git push origin main','git push origin HEAD:main','git push origin task-r5 other','cd other && git push origin task-r5','git -C other push origin task-r5','gh pr create','gh pr create --repo evil/r5 --base main --head task-r5'])assert.throws(()=>assertCliDestination(c,d),/CLI_/);
});

test('renewing a same-named check with a different command never inherits an old pass',t=>{const f=fixture(t);f.check();f.d.checks[0].command='test -f missing';assert.equal(f.dev.inspect(f.b).checks[0].state,'not_run');assert.throws(()=>f.dev.ready(f.b,'review'),/CHECKS_NOT_CURRENT/);});

test('ready requires current retained candidates; automatic agreed delivery reuses endpoint queue without another worker tool',async t=>{
 const {ManagedEndpoint}=await import('../bundle/managed-endpoint.js'),f=fixture(t,{plain:true});f.check();f.db.exec('CREATE TABLE managed_endpoint_artifacts(id TEXT,task_id TEXT,revision INTEGER,record TEXT)');
 const endpoint={db:f.db,development:f.dev,readyEvidence:ManagedEndpoint.prototype.readyEvidence,validate:async()=>{},call:async(method,args)=>{calls.push({method,args});return {id:'notice',state:'media_queued'};}},calls=[];
 assert.throws(()=>endpoint.readyEvidence(f.b,'review'),/CANDIDATE_ARTIFACT_REQUIRED/);const file=f.dev.tree(f.b).files['source.txt'],a={id:'artifact',stage:'candidate',path:'source.txt',sha256:file.sha256};f.db.prepare('INSERT INTO managed_endpoint_artifacts VALUES (?,?,?,?)').run(a.id,f.b.item.task_id,1,JSON.stringify(a));
 f.b.review='review';f.d.notification={target_key:'cloud:fixture',binding_revision:1};await ManagedEndpoint.prototype.deliverArtifacts.call(endpoint,f.b);assert.deepEqual(calls.map(c=>c.method),['deliver','evidence']);assert.equal(calls[0].args.current_sha256,file.sha256);assert.equal(calls[1].args.evidence.notification_delivery[0].user_read,false);
 writeFileSync(join(f.cwd,'source.txt'),'changed');assert.throws(()=>endpoint.readyEvidence(f.b,'review'),/CHECKS_NOT_CURRENT|CANDIDATE_ARTIFACT_REQUIRED/);
});
