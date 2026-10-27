// Pure validation only; no Git command execution or fabricated real approval.
import test from 'node:test';import assert from 'node:assert/strict';
import {managedTaskBranch} from '../bundle/task-branch.js';
import {workspacePlan} from '../bundle/development-plan.js';
import {compileCommit,verifyObjects} from '../bundle/delivery-object-plan.js';
import {readOnlyCommand,DeliveryGitRead} from '../bundle/delivery-git-read.js';
import {commitCommand} from '../bundle/delivery-commit.js';
import {validatePushPlan,pushCommand} from '../bundle/delivery-push-plan.js';
import {createHash} from 'node:crypto';
import {digest} from '../bundle/approval-ledger.js';
const workspace=branch=>({kind:'workspace-v1',branch,files:[{path:'acceptance/check.md',action:'create',base_sha256:null}],reads:[],commands:[{id:'check',image:'sha256:'+'a'.repeat(64),argv:['/bin/true'],cwd:'.',timeout_ms:1000,required:true}],max_writes:3,max_commands:3,max_model_requests:16});
const bytes=Buffer.from('branch check\n'),hash=createHash('sha256').update(bytes).digest('hex');
const commit=branch=>compileCommit({parent:'1'.repeat(40),branch,baseline:[],files:[{path:'check.md',bytes,mode:0o644}],changes:[{path:'check.md',action:'create',before_sha256:null,after_sha256:hash}],tested_content:{kind:'workspace_manifest_sha256',sha256:digest({'check.md':{sha256:hash,mode:0o644}})},author:{name:'Unit',email:'unit@example.invalid'},committer:{name:'Unit',email:'unit@example.invalid'},when:1792340000,message:'Unit branch validation only'});
for(const branch of ['dsh-task/s45-delivery','acceptance/s45-delivery'])test('consistent managed branch '+branch,()=>{
 assert(managedTaskBranch(branch));assert.equal(workspacePlan(workspace(branch)).branch,branch);
 const c=commit(branch);assert(verifyObjects(c.plan,c.objects).verified);
 assert.deepEqual(readOnlyCommand('ref',branch),['rev-parse','--verify','refs/heads/'+branch]);
 assert(new DeliveryGitRead({binding:{root:'/own/fixture',url:'https://gitee.com/owner/repo',branch,base_sha:c.plan.parent}}));
 assert(commitCommand('reference',c.plan).includes('refs/heads/'+branch));
 const raw={schema:1,kind:'push-commit-v1',source_action_id:'delivery-11111111-1111-1111-1111-111111111111',source_intent_fingerprint:'a'.repeat(64),source_result_fingerprint:'b'.repeat(64),repository_id:1,url:'https://gitee.com/owner/repo',format:'sha1',branch,ref:'refs/heads/'+branch,commit_oid:c.plan.computed_commit_oid,parent_oid:c.plan.parent,tree_oid:c.plan.tree_oid,manifest_sha256:c.plan.manifest_sha256,tested_content:c.plan.tested_content,expected_remote_oid:null,max_pushes:1,rewrite:false,delete:false,tags:false,publish:false,deploy:false,grants_execution:false};
 const p={...raw,fingerprint:digest(raw)};validatePushPlan(p);assert(pushCommand(p).includes(c.plan.computed_commit_oid+':refs/heads/'+branch));
});
for(const branch of ['main','master','refs/heads/acceptance/x','acceptance/../main','acceptance/a/b','acceptance/-x','acceptance/a.lock','acceptance/x\n','feature/x','acceptance/','acceptance/'+ 'a'.repeat(65),null,{}])test('reject unmanaged or malformed '+JSON.stringify(branch),()=>{
 assert.equal(managedTaskBranch(branch),false);assert.throws(()=>workspacePlan(workspace(branch)));assert.throws(()=>commit(branch));assert.throws(()=>readOnlyCommand('ref',branch));
});
