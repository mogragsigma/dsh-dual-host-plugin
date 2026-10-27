// Only hash-object WITHOUT -w is invoked. No repository is created or modified.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {compileCommit,verifyObjects,gitObject} from '../bundle/delivery-object-plan.js';
import {digest} from '../bundle/approval-ledger.js';
const sha=b=>createHash('sha256').update(b).digest('hex');
const f=(path,content,mode=0o644)=>({path,bytes:Buffer.from(content),mode});
const manifest=files=>digest(Object.fromEntries(files.map(x=>[x.path,{sha256:sha(x.bytes),mode:x.mode}])));
function input(extra={}){
 const before=[f('README.md','retained\n')],after=[...before,f('a.txt','new\n')];
 return {parent:'1'.repeat(40),branch:'dsh-task/unit',baseline:before,files:after,
  changes:[{path:'a.txt',action:'create',before_sha256:null,after_sha256:sha(after[1].bytes)}],
  tested_content:{kind:'workspace_manifest_sha256',sha256:manifest(after)},author:{name:'DSH Test',email:'test@example.invalid'},
  committer:{name:'DSH Test',email:'test@example.invalid'},when:1792340000,message:'Unit intent only',...extra};
}
const seal=p=>{const {fingerprint,...body}=p;return {...body,fingerprint:digest(body)};}; // checksum is NOT an approval.
test('canonical blob hash and commit object graph match Git read-only hash oracle',()=>{
 const dir=mkdtempSync(join(tmpdir(),'delivery-hash-only-'));
 try{
  const c=compileCommit(input());assert.deepEqual(verifyObjects(c.plan,c.objects),{verified:true,persisted:false,grants_execution:false});
  for(const o of c.objects){
   const hash=execFileSync('/usr/bin/git',['hash-object','-t',o.type,'--stdin','--no-filters'],{cwd:dir,input:o.data,encoding:'utf8',env:{PATH:'/usr/bin:/bin',HOME:dir,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1'},timeout:5000}).trim();
   assert.equal(hash,o.oid);
  }
  assert.deepEqual(readdirSync(dir),[]);assert.equal(c.plan.persisted,false);assert.equal(c.plan.remote_acceptance,'not_observed');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('tree byte ordering places a.c before directory a/ before a0, with UTF-8 paths',()=>{
 const after=[f('a0','z'),f('a/报告.md','report'),f('a.c','c')],v=input({baseline:[],files:after,changes:after.map(x=>({path:x.path,action:'create',before_sha256:null,after_sha256:sha(x.bytes)})),tested_content:{kind:'workspace_manifest_sha256',sha256:manifest(after)}});
 const c=compileCommit(v),root=c.objects.find(x=>x.oid===c.plan.tree_oid);assert.ok(root.data.indexOf(Buffer.from('a.c\0'))<root.data.indexOf(Buffer.from('a\0')));assert.ok(root.data.indexOf(Buffer.from('a\0'))<root.data.indexOf(Buffer.from('a0\0')));
 verifyObjects(c.plan,c.objects);const reversed=compileCommit({...v,files:[...after].reverse(),changes:[...v.changes].reverse()});assert.equal(c.plan.computed_commit_oid,reversed.plan.computed_commit_oid);
});
test('sha256 object format roundtrips; independently checks raw SHA256 header (not Git SHA256 repository validation)',()=>{
 const c=compileCommit(input({format:'sha256',parent:'2'.repeat(64)}));verifyObjects(c.plan,c.objects);
 for(const o of c.objects){assert.equal(o.oid.length,64);assert.equal(o.oid,sha(Buffer.concat([Buffer.from(`${o.type} ${o.data.length}\0`),o.data])));}
});
test('source buffers copied; plan metadata and object buffers have deterministic identity',()=>{
 const v=input(),c=compileCommit(v);v.files[1].bytes.fill(0);v.changes[0].path='tampered';v.author.name='tampered';verifyObjects(c.plan,c.objects);assert.equal(c.plan.author.name,'DSH Test');
});
test('modify, delete and unchanged executable permission preserved',()=>{
 const before=[f('m','old'),f('d','bye'),f('bin/x','keep',0o755)],after=[f('m','next'),before[2]];
 const c=compileCommit(input({baseline:before,files:after,changes:[{path:'m',action:'modify',before_sha256:sha(before[0].bytes),after_sha256:sha(after[0].bytes)},{path:'d',action:'delete',before_sha256:sha(before[1].bytes),after_sha256:null}],tested_content:{kind:'workspace_manifest_sha256',sha256:manifest(after)}}));verifyObjects(c.plan,c.objects);
});
test('single-create legacy content hash is accepted but does not attest other files',()=>{
 const v=input();v.tested_content={kind:'file_sha256',sha256:v.changes[0].after_sha256};verifyObjects(...Object.values(compileCommit(v)));
 v.changes.push({path:'README.md',action:'delete',before_sha256:sha(v.baseline[0].bytes),after_sha256:null});v.files.splice(0,1);assert.throws(()=>compileCommit(v),/TEST_CONTENT/);
});
for(const [name,mutate,error] of [
 ['extra out-of-scope content',v=>{v.files[0]=f('README.md','oops');},/OUT_OF_SCOPE/],
 ['mode mutation',v=>{v.files[1].mode=0o755;},/MODE_CHANGED/],
 ['stale test digest',v=>{v.tested_content.sha256='0'.repeat(64);},/TEST_CONTENT/],
 ['stale before digest',v=>{v.changes[0].before_sha256='0'.repeat(64);},/CONTENT_MISMATCH/],
 ['invalid branch',v=>{v.branch='main';},/REFERENCE/],
 ['invalid object format',v=>{v.format='md5';},/REFERENCE/],
 ['identity newline',v=>{v.author.name='A\nB';},/IDENTITY/],
 ['commit control byte',v=>{v.message='a\rb';},/METADATA/],
 ['empty commit message',v=>{v.message=' ';},/METADATA/],
 ['oversized file',v=>{v.files[1].bytes=Buffer.alloc(1048577);},/FILE_INVALID/],
 ['case collision',v=>{v.files.push(f('A.TXT','x'));},/PATH_CONFLICT/],
 ['directory case collision',v=>{v.files.push(f('D/x','x'),f('d/y','y'));},/PATH_CONFLICT/],
 ['NFC collision',v=>{v.files.push(f('é','x'),f('e\u0301','y'));},/PATH_CONFLICT/],
 ['invalid UTF-16 name',v=>{v.files.push(f('\ud800','x'));},/PATH_CONFLICT/],
 ['file-directory collision',v=>{v.files.push(f('a.txt/x','x'));},/PATH_CONFLICT/],
 ['dotgit path',v=>{v.files[1].path='.Git/config';},/INVALID_WORKSPACE_PLAN/],
 ['no changed bytes',v=>{v.files=[...v.baseline];v.changes=[{path:'README.md',action:'modify',before_sha256:sha(v.files[0].bytes),after_sha256:sha(v.files[0].bytes)}];},/NO_CHANGES/]
])test('rejects '+name,()=>{const v=input();mutate(v);assert.throws(()=>compileCommit(v),error);});
test('rejects a changed object byte or object metadata',()=>{
 const c=compileCommit(input());c.objects[0].data[0]^=1;assert.throws(()=>verifyObjects(c.plan,c.objects),/PLAN_CHANGED/);
 const d=compileCommit(input());d.plan.objects[0].bytes++;d.plan=seal(d.plan);assert.throws(()=>verifyObjects(d.plan,d.objects),/PLAN_CHANGED/);
});
for(const [key,value] of [['computed_commit_oid','a'.repeat(40)],['tree_oid','a'.repeat(40)],['manifest_sha256','a'.repeat(64)],['persisted',true],['remote_acceptance','accepted']])test('rejects resealed inconsistent '+key,()=>{
 const c=compileCommit(input());c.plan=seal({...c.plan,[key]:value});assert.throws(()=>verifyObjects(c.plan,c.objects),/PLAN_CHANGED/);
});
test('rejects unreachable objects even with updated checksum',()=>{
 const c=compileCommit(input()),o=gitObject('blob',Buffer.from('not in tree'));c.objects.push(o);c.plan.objects.push({oid:o.oid,type:o.type,bytes:o.data.length});c.plan=seal(c.plan);assert.throws(()=>verifyObjects(c.plan,c.objects),/PLAN_CHANGED/);
});
test('compiler is deterministic across inventory and change order, including plan fingerprint',()=>{
 const v=input(),a=compileCommit(v),b=compileCommit({...v,files:[...v.files].reverse(),baseline:[...v.baseline].reverse(),changes:[...v.changes].reverse()});assert.deepEqual(a.plan,b.plan);
});
test('deleting last file creates canonical empty root tree, no empty subdirectory object',()=>{
 const old=f('deep/path/a','old'),c=compileCommit(input({baseline:[old],files:[],changes:[{path:old.path,action:'delete',before_sha256:sha(old.bytes),after_sha256:null}],tested_content:{kind:'workspace_manifest_sha256',sha256:manifest([])}}));
 assert.equal(c.plan.tree_oid,'4b825dc642cb6eb9a060e54bf8d69288fbee4904');assert.equal(c.objects.length,2);verifyObjects(c.plan,c.objects);
});
