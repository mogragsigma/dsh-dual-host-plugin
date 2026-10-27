// Pure in-memory repository doubles. No Git files, objects, refs or commits are created.
import test from 'node:test';import assert from 'node:assert/strict';
import {DeliveryGitRead,parseBatch,readOnlyCommand,validateGitBaseline} from '../bundle/delivery-git-read.js';
import {compileCommit,gitObject,indexTree} from '../bundle/delivery-object-plan.js';
import {digest} from '../bundle/approval-ledger.js';
import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
function fixture(empty=false){
 const old={path:'README',mode:0o644,bytes:Buffer.from('old\n')},fresh={path:'src/a',mode:0o644,bytes:Buffer.from('new\0binary\n')},source=gitObject('blob',old.bytes),after=empty?[fresh]:[old,fresh],parent='1'.repeat(40),url='https://gitee.com/test/fixture';
 const compiled=compileCommit({parent,branch:'dsh-task/test',baseline:empty?[]:[old],files:after,changes:[{path:fresh.path,action:'create',before_sha256:null,after_sha256:sha(fresh.bytes)}],tested_content:{kind:'file_sha256',sha256:sha(fresh.bytes)},author:{name:'Unit',email:'test@example.invalid'},committer:{name:'Unit',email:'test@example.invalid'},when:1000,message:'intent'});
 const identity={root:'/in-memory/repo',directory:{device:'1',inode:'2'},git_directory:{device:'1',inode:'3'},url,branch:compiled.plan.branch,base_sha:parent};
 const body={schema:1,kind:'commit-execution-intent-v1',task_id:'task',task_revision:0,resource:url,workspace_identity:identity,plan:compiled.plan},intent={...body,fingerprint:digest(body)};
 const state={phase:'before',drained:true,extraConfig:'',flags:null,lock:false,objectsOnly:false,metadata:{layout_sha256:'d'.repeat(64),config_sha256:'a'.repeat(64),head_sha256:'b'.repeat(64),index_sha256:empty?null:'c'.repeat(64)},calls:[]};
 const baseEntries=empty?[]:[{path:old.path,mode:old.mode,oid:source.oid}],allEntries=after.map(f=>({path:f.path,mode:f.mode,oid:gitObject('blob',f.bytes).oid}));
 const io={identity:()=>structuredClone(identity),inventory:()=>after.map(f=>({...f,bytes:Buffer.from(f.bytes)})),metadata:()=>{if(state.lock)throw Error('DELIVERY_GIT_LOCKED');return {...state.metadata};},
  execute:(args,input)=>{
   const start=args.findIndex((a,i)=>i>=2&&['config','rev-parse','symbolic-ref','ls-tree','ls-files','cat-file'].includes(a)),a=args.slice(start);state.calls.push(a);
   const text=x=>Buffer.from(x);const current=state.phase==='after'?compiled.plan.computed_commit_oid:parent;
   if(a[0]==='config')return text('core.repositoryformatversion\n0\0core.filemode\ntrue\0core.bare\nfalse\0remote.origin.url\n'+url+'\0'+state.extraConfig);
   if(a[0]==='rev-parse'&&a[1]==='--show-object-format')return text('sha1\n');
   if(a[0]==='rev-parse'&&a.at(-1).endsWith('^{tree}'))return text(indexTree(baseEntries)+'\n');
   if(a[0]==='rev-parse')return text(current+'\n');
   if(a[0]==='symbolic-ref')return text('refs/heads/'+compiled.plan.branch+'\n');
   if(a[0]==='ls-tree')return text(baseEntries.map(f=>`100644 blob ${f.oid}\t${f.path}\0`).join(''));
   const index=state.phase==='after'?allEntries:baseEntries;
   if(a[0]==='ls-files'&&a[1]==='--stage')return text(index.map(f=>`100644 ${f.oid} 0\t${f.path}\0`).join(''));
   if(a[0]==='ls-files')return text(state.flags??index.map(f=>'H '+f.path+'\0').join(''));
   if(a[0]==='cat-file'){
    const objects=new Map([[source.oid,source],...((state.phase==='after'||state.objectsOnly)?compiled.objects.map(o=>[o.oid,o]):[])]);
    return Buffer.concat(input.toString().trim().split('\n').map(oid=>{const o=objects.get(oid);return o?Buffer.concat([text(`${oid} ${o.type} ${o.data.length}\n`),o.data,text('\n')]):text(oid+' missing\n');}));
   }throw Error('Unexpected readonly command');
  }};
 const reader=new DeliveryGitRead({binding:{root:identity.root,url,branch:identity.branch,base_sha:parent},drained:()=>state.drained},io);
 return {state,reader,intent,compiled,io,identity,baseEntries};
}
test('preflight recompiles actual bytes, old index and verified baseline objects',()=>{
 const f=fixture(),p=f.reader.preflight(f.intent);validateGitBaseline(f.intent,p.baseline);assert.equal(p.baseline.head_oid,f.intent.plan.parent);assert.equal(p.baseline.index_tree_oid,indexTree(f.baseEntries));assert.equal(p.baseline.objects_present.length,1);assert(p.drained);
 for(const a of f.state.calls)assert(['config','rev-parse','symbolic-ref','ls-tree','ls-files','cat-file'].includes(a[0]));
});
test('actual commit proof requires branch, HEAD, index and all object content (synthetic IO)',()=>{
 const f=fixture();assert.throws(()=>f.reader.observe(f.intent),/NOT_APPLIED/);f.state.phase='after';assert.equal(f.reader.observe(f.intent).commit_oid,f.intent.plan.computed_commit_oid);assert.throws(()=>f.reader.preflight(f.intent),/BASELINE_CHANGED/);
});
test('unchanged result pins exact pre-acquisition snapshot, not just current branch',()=>{
 const f=fixture(),p=f.reader.preflight(f.intent);assert.equal(f.reader.unchanged(f.intent,p.baseline).unchanged,true);
 f.state.metadata.index_sha256='f'.repeat(64);assert.throws(()=>f.reader.unchanged(f.intent,p.baseline),/EFFECT_UNKNOWN/);
});
test('objects-only partial write cannot be reported as no effect',()=>{
 const f=fixture(),p=f.reader.preflight(f.intent);f.state.objectsOnly=true;assert.throws(()=>f.reader.unchanged(f.intent,p.baseline),/EFFECT_UNKNOWN/);assert.throws(()=>f.reader.observe(f.intent),/NOT_APPLIED/);
});
for(const c of ['include.path\n/private/secret\0','core.sshcommand\ncurl secret\0','core.fsmonitor\n/evil\0','filter.bad.clean\n/evil\0','extensions.worktreeconfig\ntrue\0','remote.origin.url\nhttps://evil.invalid/a\0','user.name\nline1\nline2\0'])test('unsafe/duplicate config rejected without outputting content: '+c.split('\n')[0],()=>{
 const f=fixture();f.state.extraConfig=c;assert.throws(()=>f.reader.preflight(f.intent),/CONFIG_UNSUPPORTED/);
});
test('index assume-unchanged/skip-worktree flags cannot mask scope changes',()=>{
 const f=fixture();for(const flag of ['h','S']){f.state.flags=flag+' README\0';assert.throws(()=>f.reader.preflight(f.intent),/INDEX_FLAGS_UNSUPPORTED/);}
});
test('drain proof required before any Git child; pending lock never bypassed',()=>{
 const f=fixture();f.state.drained=false;assert.throws(()=>f.reader.preflight(f.intent),/DRAIN_REQUIRED/);assert.equal(f.state.calls.length,0);f.state.drained=true;f.state.lock=true;assert.throws(()=>f.reader.preflight(f.intent),/LOCKED/);assert.equal(f.state.calls.length,0);
});
test('double snapshot catches metadata/worktree drift',()=>{
 const f=fixture();let n=0;f.reader.metadata=()=>({...f.state.metadata,index_sha256:(++n===1?'a':'b').repeat(64)});assert.throws(()=>f.reader.preflight(f.intent),/STATE_CHANGED/);
 const g=fixture(),old=g.reader.inventory;let i=0;g.reader.inventory=()=>{const files=old();if(++i>1)files[0].bytes=Buffer.from('changed');return files;};assert.throws(()=>g.reader.preflight(g.intent),/WORKTREE_CHANGED/);
});
test('plan checksum or physical identity drift denied',()=>{
 const f=fixture(),bad=structuredClone(f.intent);bad.plan.message='wrong';assert.throws(()=>f.reader.preflight(bad),/INTENT_CHANGED/);
 f.reader.identity=()=>({...f.identity,directory:{device:'1',inode:'900'}});assert.throws(()=>f.reader.preflight(f.intent),/WORKSPACE_CHANGED/);
});
test('batch preserves binary bytes and rejects corrupt/extra/truncated/type-spoofed data',()=>{
 const data=Buffer.from([0,255,10,128]),o=gitObject('blob',data),raw=Buffer.concat([Buffer.from(`${o.oid} blob 4\n`),data,Buffer.from('\n')]);assert(parseBatch(raw,[o.oid],'sha1').get(o.oid).data.equals(data));
 for(const bad of [raw.subarray(0,-1),Buffer.concat([raw,Buffer.from('extra')]),Buffer.from(raw.toString('latin1').replace('blob','tree'),'latin1')])assert.throws(()=>parseBatch(bad,[o.oid],'sha1'),/OBJECT_INVALID/);
 const corrupt=Buffer.from(raw);corrupt[raw.length-2]^=1;assert.throws(()=>parseBatch(corrupt,[o.oid],'sha1'),/OBJECT_INVALID/);
});
test('readonly command dispatch does not accept arbitrary Git args or revision injection',()=>{
 for(const args of [['commit'],['push'],['config','--set'],['ref','main'],['tree','--upload-pack=evil'],['batch',[]]])assert.throws(()=>readOnlyCommand(...args),/READ_COMMAND_DENIED/);
 const f=fixture();assert.throws(()=>f.reader.read('batch',undefined,Buffer.from('HEAD\n')),/READ_COMMAND_DENIED/);assert.equal(f.state.calls.length,0);
});
test('raw child errors never surface credentials in command stderr',()=>{
 const f=fixture();f.reader.execute=()=>{throw Error('secret-url-and-token');};assert.throws(()=>f.reader.preflight(f.intent),e=>e.message==='DELIVERY_GIT_READ_FAILED');
});
test('missing index is valid only for an empty baseline, explicitly persisted as null',()=>{
 const f=fixture(true),p=f.reader.preflight(f.intent);assert.equal(p.baseline.metadata.index_sha256,null);assert.equal(f.reader.unchanged(f.intent,p.baseline).unchanged,true);
 const g=fixture();g.state.metadata.index_sha256=null;assert.throws(()=>g.reader.preflight(g.intent),/BASELINE_REQUIRED/);
});
test('ordinary branch tracking metadata allowed but cannot choose an execution remote',()=>{
 const f=fixture();f.state.extraConfig='branch.dsh-task/old.remote\norigin\0branch.dsh-task/old.merge\nrefs/heads/main\0';assert(f.reader.preflight(f.intent).drained);
 f.state.extraConfig='branch.dsh-task/old.remote\nevil\0';assert.throws(()=>f.reader.preflight(f.intent),/CONFIG_UNSUPPORTED/);
});
test('empty directories hidden by recursive ls-tree cannot silently alter parent tree',()=>{
 const f=fixture(),execute=f.reader.execute;f.reader.execute=(args,input)=>args.at(-1).endsWith('^{tree}')?Buffer.from('f'.repeat(40)+'\n'):execute(args,input);
 assert.throws(()=>f.reader.preflight(f.intent),/BASELINE_TREE_UNSUPPORTED/);
});

test('runtime preparation compiles only observed baseline/worktree bytes, no object writes',()=>{
 const f=fixture(),p=f.compiled.plan;
 const r=f.reader.compile({parent:p.parent,branch:p.branch,changes:p.changes,tested_content:p.tested_content,author:p.author,committer:p.committer,when:p.when,message:p.message});
 assert.equal(r.plan.fingerprint,p.fingerprint);assert.deepEqual(r.workspace_identity,f.identity);
 for(const a of f.state.calls)assert(['config','rev-parse','symbolic-ref','ls-tree','cat-file'].includes(a[0]));
});
test('runtime compilation refuses undrained process, unsafe config and moved baseline',()=>{
 const f=fixture(),p=f.compiled.plan,input={parent:p.parent,branch:p.branch,changes:p.changes,tested_content:p.tested_content,author:p.author,committer:p.committer,when:p.when,message:p.message};
 f.state.drained=false;assert.throws(()=>f.reader.compile(input),/DRAIN_REQUIRED/);assert.equal(f.state.calls.length,0);
 f.state.drained=true;f.state.phase='after';assert.throws(()=>f.reader.compile(input),/BASELINE_CHANGED/);
 f.state.phase='before';f.state.extraConfig='core.sshcommand\nevil\0';assert.throws(()=>f.reader.compile(input),/CONFIG_UNSUPPORTED/);
});
test('ancestry walks content-verified commit objects, including merge parents, without network',()=>{
 const f=fixture(),tree='a'.repeat(40),make=parents=>gitObject('commit',Buffer.from('tree '+tree+'\n'+parents.map(p=>'parent '+p+'\n').join('')+'author Test <t@example.invalid> 1 +0000\ncommitter Test <t@example.invalid> 1 +0000\n\nmessage\n'));
 const a=make([]),b=make([a.oid]),c=make([a.oid,b.oid]),other=gitObject('commit',Buffer.from(a.data.toString().replace('message','other'))),all=new Map([a,b,c,other].map(o=>[o.oid,o]));
 f.reader.objects=ids=>new Map(ids.map(id=>[id,all.get(id)??null]));
 assert.equal(f.reader.ancestor(a.oid,c.oid),true);assert.equal(f.reader.ancestor(b.oid,c.oid),true);assert.equal(f.reader.ancestor(other.oid,c.oid),false);
 all.delete(b.oid);assert.throws(()=>f.reader.ancestor(other.oid,c.oid),/ANCESTRY_OBJECT/);
 assert.throws(()=>f.reader.ancestor('HEAD',c.oid),/ANCESTRY_INPUT/);
});

for(const value of ['+refs/heads/main:refs/remotes/origin/main','+refs/heads/acceptance/s45-delivery:refs/remotes/origin/acceptance/s45-delivery'])test('standard single-branch clone fetch refspec accepted '+value,()=>{const f=fixture();f.state.extraConfig='remote.origin.fetch\n'+value+'\0';assert(f.reader.preflight(f.intent).drained);});
for(const value of ['+refs/heads/main:refs/heads/main','+refs/heads/main:refs/remotes/origin/other','+refs/heads/../main:refs/remotes/origin/../main','+refs/tags/v1:refs/remotes/origin/v1','+refs/heads/*:refs/remotes/origin/other/*'])test('unsafe fetch refspec remains rejected '+value,()=>{const f=fixture();f.state.extraConfig='remote.origin.fetch\n'+value+'\0';assert.throws(()=>f.reader.preflight(f.intent),/CONFIG_UNSUPPORTED/);});
