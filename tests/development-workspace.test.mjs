import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync,rmSync,symlinkSync,linkSync,realpathSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fixture,proposal} from './approval-fixture.mjs';
import {RepositoryCatalog} from '../bundle/repository-catalog.js';
import {developmentSpec} from '../bundle/development-contract.js';
import {workspacePlan,developmentPath} from '../bundle/development-plan.js';
import {DevelopmentFiles} from '../bundle/development-files.js';
import {contentHash} from '../bundle/development-workspace.js';
import {DevelopmentGate} from '../bundle/development-gate.js';
import {digest} from '../bundle/approval-ledger.js';
import {renderChatProposal} from '../bundle/approval-chat.js';
import {setup,plan,git,files,start,write,command,fakeCommands,result} from './workspace-fixture.mjs';
test('plan normalization retains exact command/input/budget in approval',()=>{const p=plan();assert.deepEqual(developmentSpec(p),p);assert.equal(p.max_writes,8);
 for(const x of [{...p,max_commands:0},{...p,max_model_requests:1000},{...p,command:'shell'},{...p,files:[...p.files,p.files[0]]},{...p,commands:[{...p.commands[0],image:'python:latest'}]},{...p,commands:[{...p.commands[0],required:false}]}])assert.throws(()=>workspacePlan(x),/INVALID_WORKSPACE_PLAN/);});
for(const p of ['../escape','/absolute','a//b','a/./b','.git/config','x/.GIT/config','a\\b','a\0b','a\nb','src/','x:host'])test('denies unsafe path '+JSON.stringify(p),()=>assert.throws(()=>developmentPath(p),/INVALID_WORKSPACE_PLAN/));
test('unapproved, model mismatch and disabled do not acquire',async t=>{const f=await setup(t,{approved:false});assert.throws(()=>f.enqueue(),/APPROVAL_REQUIRED/);f.reply(f.prompt);await f.chat.tick();assert.throws(()=>f.gate.enqueue('cloud',{task_id:f.task.id,approval_id:f.req.id,policy:{...proposal.model_policy,model:'other'},event_id:'wrong'}),/APPROVAL_REQUIRED/);f.gate.enabled=false;assert.throws(()=>f.enqueue(),/DISABLED/);assert.equal(git(f.root,'status','--porcelain'),'');});
test('multi-file create/modify/delete and all required commands before release',async t=>{const f=await setup(t),q=start(f),initial=f.gate.read(q.id,'cloud',q.epoch);assert(initial.hash);assert.equal(initial.files.length,3);assert.throws(()=>f.gate.read(q.id,'cloud',q.epoch,'README.md'),/READ_DENIED/);assert.equal(f.gate.read(q.id,'cloud',q.epoch,'src/count.py').content,files['src/count.py']);
 write(f,q,'src/count.py','def total(a, b):\n    return sum([a, b])\n');write(f,q,'docs/report.md','# Fixture\n');write(f,q,'src/remove.txt',null);assert.throws(()=>write(f,q,'README.md','no'),/WRITE_DENIED/);assert.throws(()=>write(f,q,'src/count.py',null,'invalid-delete'),/CONTENT_INVALID/);assert.throws(()=>f.gate.finish(q.id,'cloud',q.epoch,{agentDrained:true}),/TEST_REQUIRED/);await command(f,q,'build');assert.equal(f.gate.view(q.id).test_result.passed,false);await command(f,q,'test');assert.equal(f.gate.finish(q.id,'cloud',q.epoch,{agentDrained:true}).state,'completed');assert.equal(git(f.root,'rev-parse','HEAD'),f.base_sha);assert.equal(git(f.root,'diff','--cached','--name-only'),'');});
test('snapshot excludes .git and unrelated files',async t=>{const f=await setup(t),q=start(f),a=f.gate.assert(q.id,'cloud',q.epoch);write(f,q,'docs/report.md','fixture');const dest=join(f.dir,'snapshot');a.workspace.snapshot(f.gate.view(q.id).expected_hash,dest);assert.equal(readFileSync(join(dest,'docs/report.md'),'utf8'),'fixture');for(const p of ['README.md','.git/config'])assert.throws(()=>readFileSync(join(dest,p)),/ENOENT/);});
test('idempotency avoids second write/command and rejects conflicting payload',async t=>{const f=await setup(t),q=start(f),args={path:'src/count.py',content:'x=1\n',expected_hash:q.expected_hash,call_id:'one'};f.gate.write(q.id,'cloud',q.epoch,args);assert.equal(f.gate.write(q.id,'cloud',q.epoch,args).replayed,true);assert.throws(()=>f.gate.write(q.id,'cloud',q.epoch,{...args,path:'docs/report.md'}),/WRITE_CONFLICT/);await command(f,q,'build');assert.equal((await command(f,q,'build')).replayed,true);assert.equal(f.gate.db.prepare('SELECT count(*) n FROM development_commands').get().n,1);await assert.rejects(command(f,q,'test','build'),/COMMAND_CONFLICT/);});
test('changed source invalidates all commands; approval-wide durable budget',async t=>{const f=await setup(t),q=start(f);await command(f,q,'build');await command(f,q,'test');assert(f.gate.view(q.id).test_result.passed);write(f,q,'docs/report.md','changed');assert.equal(f.gate.view(q.id).test_result,null);await command(f,q,'build','build-again');assert.equal(f.gate.view(q.id).test_result.passed,false);await command(f,q,'test','test-again');assert(f.gate.view(q.id).test_result.passed);await assert.rejects(command(f,q,'build','over'),/COMMAND_BUDGET/);});
for(const kind of ['unrelated','ignored','assume-unchanged','input','symlink','hardlink','staged','branch'])test('detects '+kind+' interference',async t=>{const f=await setup(t),q=start(f);
 if(kind==='unrelated')writeFileSync(join(f.root,'README.md'),'external');if(kind==='ignored'){writeFileSync(join(f.root,'.git/info/exclude'),'hidden\n');writeFileSync(join(f.root,'hidden'),'external');}if(kind==='assume-unchanged'){git(f.root,'update-index','--assume-unchanged','README.md');writeFileSync(join(f.root,'README.md'),'external');}if(kind==='input')writeFileSync(join(f.root,'tests/check.py'),'changed');if(kind==='symlink')symlinkSync('/etc/passwd',join(f.root,'evil'));if(kind==='hardlink')linkSync(join(f.root,'README.md'),join(f.root,'evil'));if(kind==='staged'){writeFileSync(join(f.root,'src/count.py'),'changed');git(f.root,'add','src/count.py');}if(kind==='branch')git(f.root,'checkout','-b','other');assert.throws(()=>f.gate.read(q.id,'cloud',q.epoch),/DEVELOPMENT_/);assert.equal(f.store.task(f.task.id).busy,1);});
test('approved base sha256 cannot adopt another baseline',async t=>{const f=await setup(t),p={...f.spec,files:f.spec.files.map(x=>x.path==='src/count.py'?{...x,base_sha256:'b'.repeat(64)}:x)},w=new DevelopmentFiles(f.bindings[f.task.id],p,f.snapshot);assert.throws(()=>w.check(null),/PLAN_BASELINE_MISMATCH/);});
test('unknown command retains resource across restart and is never rerun',async t=>{const commands={async run(){throw Error('DEVELOPMENT_CONTAINER_DRAIN_UNKNOWN');}},f=await setup(t,{commands}),q=start(f);await assert.rejects(command(f,q,'build'),/DRAIN_UNKNOWN/);assert(f.gate.unresolved(q.id));assert.equal(f.gate.view(q.id).state,'needs_review');const after=new DevelopmentGate({store:f.store,ledger:f.ledger,bindings:f.bindings,enabled:true,commands});after.recover();assert.equal(after.view(q.id).state,'needs_review');assert.equal(f.gate.db.prepare('SELECT count(*) n FROM development_commands').get().n,1);});
test('failed required commands cannot be replaced by a model claim',async t=>{const commands={async run(w,h,id,o){o.onClosed({code:1});return result(w,h,id,false);}},f=await setup(t,{commands}),q=start(f);assert.equal((await command(f,q,'build')).passed,false);assert.throws(()=>f.gate.finish(q.id,'cloud',q.epoch,{agentDrained:true}),/TEST_REQUIRED/);await assert.rejects(command(f,q,'unapproved'),/COMMAND_DENIED/);});
test('active command blocks write and handoff until verified drain',async t=>{let release;const commands={async run(w,h,id,o){await new Promise(r=>release=r);o.onClosed({code:0});return result(w,h,id);}},f=await setup(t,{commands}),q=start(f),running=command(f,q,'build');assert.throws(()=>write(f,q,'docs/report.md','no'),/IN_FLIGHT/);assert.throws(()=>f.gate.finish(q.id,'cloud',q.epoch,{agentDrained:true}),/NOT_DRAINED/);release();await running;assert.equal(f.gate.unresolved(q.id),false);});
test('proposal shows file actions, argv, immutable image, budgets and no delivery',async t=>{const f=await setup(t),text=renderChatProposal(f.ledger.view(f.req.id));for(const fragment of ['src/count.py','docs/report.md','delete','sha256:','/usr/local/bin/python','24','不授权宿主 shell','提交、推送'])assert(text.includes(fragment),fragment);});

test('new request and process reopening do not reset approval command budget',async t=>{
 const f=await setup(t),q=start(f);await command(f,q,'build');await command(f,q,'test');f.gate.finish(q.id,'cloud',q.epoch,{agentDrained:true});
 const q2=f.gate.acquire(f.enqueue('cloud','second').id);await command(f,q2,'build');await command(f,q2,'test');f.gate.finish(q2.id,'cloud',q2.epoch,{agentDrained:true});
 const after=new DevelopmentGate({store:f.store,ledger:f.ledger,bindings:f.bindings,enabled:true,commands:fakeCommands,now:f.ledger.now});after.recover();
 const queued=after.enqueue('cloud',{task_id:f.task.id,approval_id:f.req.id,policy:proposal.model_policy,event_id:'third'}),q3=after.acquire(queued.id);
 await assert.rejects(after.command(q3.id,'cloud',q3.epoch,{command_id:'build',call_id:'third'}),/COMMAND_BUDGET/);
 assert.equal(after.db.prepare('SELECT count(*) n FROM development_commands').get().n,4);
});
test('expired approval is checked before a command starts',async t=>{let calls=0;const commands={async run(){calls++;}},f=await setup(t,{commands}),q=start(f);f.time(3600001);await assert.rejects(command(f,q,'build'),/APPROVAL_REQUIRED/);assert.equal(calls,0);});
test('command receipt mismatch does not produce successful test evidence',async t=>{const commands={async run(w,h,id,o){o.onClosed({code:0});return {...result(w,h,id),command_hash:'bad'};}},f=await setup(t,{commands}),q=start(f);await assert.rejects(command(f,q,'build'),/RECEIPT_INVALID/);assert.equal(f.gate.view(q.id).state,'needs_review');assert.equal(f.gate.view(q.id).test_result,null);});
import {DevelopmentRuntime} from '../bundle/development-runtime.js';
import {DevelopmentBridge} from '../bundle/development-bridge.js';
import {TaskJobs} from '../bundle/task-jobs.js';
test('old worker/bridge entry points cannot misinterpret new workspace contract',async t=>{
 const f=await setup(t),jobs=new TaskJobs(join(f.dir,'jobs'));t.after(()=>jobs.close());
 const g={c:{role:'cloud'},ctx:{on(){}},store:f.store,approvals:f.ledger,repositories:f.repos,scheduler:{jobs},now:f.ledger.now};
 const runtime=new DevelopmentRuntime(g,{enabled:true,bindings:f.bindings}),bridge=new DevelopmentBridge(runtime);
 await assert.rejects(runtime.schedule({task_id:f.task.id,approval_id:f.req.id,model_policy:proposal.model_policy}),/CONTRACT_METHOD_MISMATCH/);
 await assert.rejects(bridge.call('development_bridge_enqueue',{task_id:f.task.id,approval_id:f.req.id,policy:proposal.model_policy,event_id:'not-legacy'},'cloud'),/CONTRACT_METHOD_MISMATCH/);
 assert.equal(f.gate.db.prepare('SELECT count(*) n FROM development_requests').get().n,0);assert.equal(jobs.db.prepare('SELECT count(*) n FROM jobs').get().n,0);
});

test('snapshot remains readable by isolated command uid under restrictive Host umask',async t=>{
 const f=await setup(t),q=start(f),w=f.gate.assert(q.id,'cloud',q.epoch).workspace,mask=process.umask(0o077),dest=join(f.dir,'umask-snapshot');
 try{w.snapshot(q.expected_hash,dest);}finally{process.umask(mask);}
 assert.equal(statSync(join(dest,'src')).mode&0o777,0o755);assert.equal(statSync(join(dest,'src/count.py')).mode&0o777,0o444);
});
import {DevelopmentContainer} from '../bundle/development-container.js';
test('real cloud container connects approval, multi-file gate, build, acceptance and drained release',{skip:!process.env.DSH_CONTAINER_IMAGE?'requires explicitly selected installed Linux image':false},async t=>{
 const directory=mkdtempSync(join(tmpdir(),'dsh-s41-integrated-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const commands=new DevelopmentContainer({directory}),spec=plan();for(const c of spec.commands)c.image=process.env.DSH_CONTAINER_IMAGE;
 spec.commands[0].argv=['/usr/local/bin/python','-c','import py_compile;py_compile.compile("/work/src/count.py",cfile="/out/count.pyc",doraise=True);print("build passed")'];
 spec.commands[1].argv=['/usr/local/bin/python','-c','import runpy;f=runpy.run_path("/work/src/count.py")["total"];assert f(2,3)==5;assert f(-1,1)==0;print("acceptance passed")'];
 const f=await setup(t,{commands,selectedSpec:spec}),q=start(f);
 write(f,q,'src/count.py','def total(a, b):\n    return sum([a, b])\n');write(f,q,'docs/report.md','# Fixture multi-file result\n');write(f,q,'src/remove.txt',null);
 const build=await command(f,q,'build'),acceptance=await command(f,q,'test');assert(build.passed&&build.started&&acceptance.passed&&acceptance.started);
 assert.equal(f.gate.unresolved(q.id),false);assert.equal(f.gate.finish(q.id,'cloud',q.epoch,{agentDrained:true}).state,'completed');
 assert.equal(f.store.task(f.task.id).busy,0);assert.equal(git(f.root,'rev-parse','HEAD'),f.base_sha);assert.equal(git(f.root,'diff','--cached','--name-only'),'');
 const resumed=new DevelopmentGate({store:f.store,ledger:f.ledger,bindings:f.bindings,commands,enabled:true,now:f.ledger.now});resumed.recover();assert.equal(resumed.view(q.id).state,'completed');
 assert.equal(resumed.db.prepare('SELECT count(*) n FROM development_commands').get().n,2);
});

import {errorInfo} from '../bundle/link-contract.js';
test('pending workspace adapters and budgets require capability/operator resolution, not blind retry',()=>{
 for(const code of ['DEVELOPMENT_WORKSPACE_WORKER_PENDING','DEVELOPMENT_WORKSPACE_BRIDGE_PENDING','DEVELOPMENT_CONTAINER_UNAVAILABLE','DEVELOPMENT_IMAGE_UNAVAILABLE','DEVELOPMENT_COMMAND_BUDGET'])assert.equal(errorInfo(code).retry,'operator_review');
 const p=plan();p.files=[{path:'文档/结果.md',action:'create',base_sha256:null},{path:'Z.md',action:'create',base_sha256:null},{path:'a.md',action:'create',base_sha256:null}];assert.deepEqual(workspacePlan(p).files.map(f=>f.path),['Z.md','a.md','文档/结果.md']);
});
