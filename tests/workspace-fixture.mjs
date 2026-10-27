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
const url='https://gitee.com/isolated-fixture/plan',branch='dsh-task/multi-file';
const files={'src/count.py':'def total(a, b):\n    return a + b\n','src/remove.txt':'obsolete\n','tests/check.py':'assert True\n','README.md':'fixture baseline\n'};
const plan=()=>workspacePlan({kind:'workspace-v1',branch,files:[{path:'src/count.py',action:'modify',base_sha256:contentHash(files['src/count.py'])},{path:'docs/report.md',action:'create',base_sha256:null},{path:'src/remove.txt',action:'delete',base_sha256:contentHash(files['src/remove.txt'])}],reads:[{path:'tests/check.py',sha256:contentHash(files['tests/check.py'])}],commands:['build','test'].map(id=>({id,image:'sha256:'+'a'.repeat(64),argv:['/usr/local/bin/python','/work/tests/check.py'],cwd:'.',timeout_ms:5000,required:true})),max_writes:8,max_commands:4,max_model_requests:24,executors:['cloud']});
const git=(root,...a)=>execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','commit.gpgsign=false','-C',root,...a],{encoding:'utf8',env:{PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}}).trim();
function repo(t){const root=realpathSync(mkdtempSync(join(tmpdir(),'dsh-s41-unit-')));t.after(()=>rmSync(root,{recursive:true,force:true}));git(root,'init','-b',branch);
 for(const [p,c] of Object.entries(files)){mkdirSync(dirname(join(root,p)),{recursive:true});writeFileSync(join(root,p),c);}git(root,'add','.');
 // Disposable unit-fixture baseline only, never a project/business repository.
 git(root,'-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','-m','unit fixture');git(root,'remote','add','origin',url);return {root,base_sha:git(root,'rev-parse','HEAD')};}
const result=(w,h,id,passed=true)=>({passed,drained:true,file_hash:h,command_id:id,command_hash:digest(w.spec.commands.find(c=>c.id===id)),output:'fixture, not real container'});
const fakeCommands={async run(w,h,id,o){o.onCreated({id:'fixture-container',name:'fixture'});o.onClosed({code:0});return result(w,h,id);}};
async function setup(t,{approved=true,commands=fakeCommands,selectedSpec=null}={}){
 const f=fixture(t),r=repo(t),spec=selectedSpec??plan(),snapshot={provider:'gitee',repository_id:1,url,branch:'main',base_sha:r.base_sha,private:true,workspace:null};
 const repos=new RepositoryCatalog(f.store,f.catalog,{reference:r=>({url:r}),inspect:async()=>snapshot},f.ledger.now);f.ledger.repositories=repos;
 const resolution=await repos.resolve({reference:url}),bound=repos.mutate('local',{task_id:f.task.id,expected_revision:1,expected_binding_revision:0,resolution_id:resolution.resolution_id,event_id:'bind',sources:[{role:'local',session_id:'fixture',message_id:'fixture',text:url,sha256:digest(url)}]});
 const req=f.ledger.request('local',{task_id:f.task.id,expected_revision:1,event_id:'plan',proposal:{...proposal,repository:{binding_revision:bound.binding_revision,fingerprint:bound.repository.fingerprint},development:spec}});
 f.chat.queue(req.id);await f.chat.tick();const prompt=[...f.messages.values()][0];if(approved){f.reply(prompt);await f.chat.tick();assert.equal(f.ledger.view(req.id).state,'approved');}
 const bindings={[f.task.id]:{...r,url,branch,approval_hash:digest({approval:req.id,proposal_hash:req.proposal_hash,spec})}},gate=new DevelopmentGate({store:f.store,ledger:f.ledger,bindings,enabled:true,now:f.ledger.now,commands});
 const enqueue=(node='cloud',event_id='first')=>gate.enqueue(node,{task_id:f.task.id,approval_id:req.id,policy:proposal.model_policy,event_id});return {...f,...r,spec,snapshot,repos,req,gate,bindings,enqueue,prompt};
}
const start=f=>f.gate.acquire(f.enqueue().id);
const write=(f,q,path,content,id=path)=>f.gate.write(q.id,q.node,q.epoch,{path,content,call_id:id,expected_hash:f.gate.view(q.id).expected_hash});
const command=(f,q,id,call=id)=>f.gate.command(q.id,q.node,q.epoch,{command_id:id,call_id:call});

export {setup,plan,git,files,start,write,command,fakeCommands,result};
