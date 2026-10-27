import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {compileIndex} from '../bundle/delivery-index.js';import {compileCommit,indexTree} from '../bundle/delivery-object-plan.js';import {digest} from '../bundle/approval-ledger.js';
const hash=b=>createHash('sha256').update(b).digest('hex');
function plan(paths,format='sha1'){
 const files=paths.map((path,i)=>({path,mode:0o644,bytes:Buffer.from('file '+i)}));
 return compileCommit({format,parent:'1'.repeat(format==='sha1'?40:64),branch:'dsh-task/index',baseline:[],files,
  changes:files.map(f=>({path:f.path,action:'create',before_sha256:null,after_sha256:hash(f.bytes)})),tested_content:{kind:'workspace_manifest_sha256',sha256:digest(Object.fromEntries(files.map(f=>[f.path,{mode:f.mode,sha256:hash(f.bytes)}])))},author:{name:'Unit',email:'test@example.invalid'},committer:{name:'Unit',email:'test@example.invalid'},when:1000,message:'synthetic'});
}
function decode(bytes,format){
 const h=format==='sha1'?20:32;assert.equal(bytes.subarray(0,4).toString(),'DIRC');assert.equal(bytes.readUInt32BE(4),2);
 assert(bytes.subarray(-h).equals(createHash(format).update(bytes.subarray(0,-h)).digest()));const count=bytes.readUInt32BE(8),entries=[];let at=12;
 for(let i=0;i<count;i++){
  const start=at,mode=bytes.readUInt32BE(at+24);assert([0o100644,0o100755].includes(mode));
  for(let n=0;n<40;n+=4)if(n!==24)assert.equal(bytes.readUInt32BE(at+n),0);
  const oid=bytes.subarray(at+40,at+40+h).toString('hex'),flags=bytes.readUInt16BE(at+40+h),nameStart=at+42+h,end=bytes.indexOf(0,nameStart),path=bytes.subarray(nameStart,end).toString('utf8');
  assert.equal(flags,Buffer.byteLength(path));at=start+Math.ceil((end-start+1)/8)*8;assert(bytes.subarray(end,at).every(x=>x===0));entries.push({path,mode:mode&0o777,oid});
 }assert.equal(at,bytes.length-h);return entries;
}
for(const format of ['sha1','sha256'])test('index-v2 checksum, byte ordering, padding and no flags: '+format,()=>{
 const x=plan(['a0','a/z','a.c','中文/报告.md','z', 'len1234', 'len12345'],format),index=compileIndex(x.plan,x.objects),decoded=decode(index.bytes,format);
 assert.deepEqual(decoded,index.entries);assert.equal(indexTree(decoded,format),x.plan.tree_oid);assert.deepEqual(decoded.slice(0,3).map(x=>x.path),['a.c','a/z','a0']);
});
test('empty after-tree has only header and checksum, not phantom entries',()=>{
 const bytes=Buffer.from('gone'),x=compileCommit({format:'sha1',parent:'1'.repeat(40),branch:'dsh-task/index',baseline:[{path:'a',mode:0o644,bytes}],files:[],changes:[{path:'a',action:'delete',before_sha256:hash(bytes),after_sha256:null}],tested_content:{kind:'workspace_manifest_sha256',sha256:digest({})},author:{name:'Unit',email:'test@example.invalid'},committer:{name:'Unit',email:'test@example.invalid'},when:1000,message:'delete'});
 const index=compileIndex(x.plan,x.objects);assert.equal(index.bytes.length,32);assert.deepEqual(decode(index.bytes,'sha1'),[]);
});
test('compiler rejects a changed object or mismatched plan before constructing index',()=>{
 const x=plan(['a']);x.objects[0].data[0]^=1;assert.throws(()=>compileIndex(x.plan,x.objects),/PLAN_CHANGED/);
});
