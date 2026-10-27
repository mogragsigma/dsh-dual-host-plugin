// Real filesystem safety tests, only in fresh temporary directories with an empty .git folder.
// No git init, Git process, object database, HEAD, config, commit, index installation or remote.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,mkdirSync,lstatSync,readFileSync,writeFileSync,renameSync,unlinkSync,linkSync,symlinkSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath} from 'node:url';import {spawnSync} from 'node:child_process';import {createHash} from 'node:crypto';
import {DeliveryGitLease} from '../bundle/delivery-commit.js';import {DeliveryRecoveryLocks} from '../bundle/delivery-recovery.js';import {DeliveryGitRead} from '../bundle/delivery-git-read.js';
import {canonical,digest} from '../bundle/approval-ledger.js';import {fixture as commitFixture} from './delivery-commit-fixture.mjs';import {compileIndex} from '../bundle/delivery-index.js';
const sha=b=>createHash('sha256').update(b).digest('hex');
function fixture(t,{child=false}={}){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'dsh-lock-filesystem-only-'))),gd=join(root,'.git');mkdirSync(gd,{mode:0o700});t.after(()=>rmSync(root,{recursive:true,force:true}));
 const id=p=>{const s=lstatSync(p,{bigint:true});return {device:String(s.dev),inode:String(s.ino)};};
 const identity={root,directory:id(root),git_directory:id(gd),url:'https://gitee.com/test/fixture',branch:'dsh-task/unit',base_sha:'1'.repeat(40)},tag={action_id:'delivery-fixture',epoch:2,intent_fingerprint:'a'.repeat(64)};let records={};
 if(child){const p=spawnSync(process.execPath,[fileURLToPath(new URL('./delivery-lock-crash-child.mjs',import.meta.url)),JSON.stringify(identity),JSON.stringify(tag)],{encoding:'utf8',timeout:10000,env:{PATH:'/usr/bin:/bin'}});assert.equal(p.status,17,p.stderr);records=JSON.parse(p.stdout);}
 else{const lease=new DeliveryGitLease(identity,tag,(name,value)=>records[name]=value);lease.open();lease.abandon();}
 const locks=new DeliveryRecoveryLocks(identity,tag,records);return {root,gd,identity,tag,records,locks};
}
test('new process leaves inode-bound owner markers; explicit component cleanup removes only fixture locks',t=>{
 const f=fixture(t,{child:true}),s=f.locks.scan();assert(s.every(x=>x.state==='owned'&&x.kind==='owner-marker'));let guards=0;f.locks.release(s,()=>guards++);assert.equal(guards,2);assert(f.locks.scan().every(x=>x.state==='absent'));assert(!existsSync(join(f.gd,'HEAD')));assert(!existsSync(join(f.gd,'objects')));
});
test('lock inode replacement with identical marker is refused without unlinking it',t=>{
 const f=fixture(t),path=join(f.gd,'index.lock'),bytes=readFileSync(path);renameSync(path,join(f.gd,'original.saved'));writeFileSync(path,bytes);assert.throws(()=>f.locks.scan(),/FOREIGN_LOCK/);assert(readFileSync(path).equals(bytes));
});
for(const kind of ['symlink','hardlink','directory'])test(kind+' lock is never followed or removed',t=>{
 const f=fixture(t),path=join(f.gd,'index.lock'),target=join(f.root,'fixture-target.txt');writeFileSync(target,'do not touch');unlinkSync(path);
 if(kind==='symlink')symlinkSync(target,path);else if(kind==='hardlink')linkSync(target,path);else mkdirSync(path);
 assert.throws(()=>f.locks.scan(),/FOREIGN_LOCK/);assert.equal(readFileSync(target,'utf8'),'do not touch');assert(lstatSync(path));
});
test('same inode with wrong marker or truncated index remains untouched',t=>{
 const f=fixture(t),path=join(f.gd,'index.lock');writeFileSync(path,'unknown partial bytes');assert.throws(()=>f.locks.scan(),/LOCK_CONTENT_UNKNOWN/);assert.equal(readFileSync(path,'utf8'),'unknown partial bytes');
});
test('complete prepared index lock is recognized only by durable expected bytes/hash',t=>{
 const f=fixture(t),c=commitFixture(t),bytes=compileIndex(c.compiled.plan,c.compiled.objects).bytes,path=join(f.gd,'index.lock');writeFileSync(path,bytes);
 const checked=new DeliveryRecoveryLocks(f.identity,f.tag,f.records,{sha256:sha(bytes),bytes:bytes.length});assert.equal(checked.scan().find(x=>x.name==='index.lock').kind,'prepared-index');
 const denied=new DeliveryRecoveryLocks(f.identity,f.tag,f.records,{sha256:'0'.repeat(64),bytes:bytes.length});assert.throws(()=>denied.scan(),/LOCK_CONTENT_UNKNOWN/);assert(readFileSync(path).equals(bytes));
 checked.release(checked.scan());assert(!existsSync(join(f.gd,'index')),'cleanup must never install prepared index');
});
test('changed lock after review fails closed and preserves remaining file',t=>{
 const f=fixture(t),s=f.locks.scan();writeFileSync(join(f.gd,'config.lock'),'changed');assert.throws(()=>f.locks.release(s),/LOCK_CONTENT_UNKNOWN|STALE_LOCK_EVIDENCE/);assert(existsSync(join(f.gd,'index.lock')));
});
test('per-file fence loss stops cleanup after first deletion',t=>{
 const f=fixture(t),s=f.locks.scan();let n=0;assert.throws(()=>f.locks.release(s,()=>{if(++n===2)throw Error('STALE_FENCE');}),/STALE_FENCE/);assert(!existsSync(join(f.gd,'index.lock')));assert(existsSync(join(f.gd,'config.lock')));
});
test('changed physical directory or unrecorded lock cannot be adopted',t=>{
 const f=fixture(t);assert.throws(()=>new DeliveryRecoveryLocks(f.identity,f.tag,{}).scan(),/FOREIGN_LOCK/);assert.throws(()=>f.locks.read('../../outside'),/LOCK_NAME_DENIED/);
 renameSync(f.gd,join(f.root,'old-git-folder'));mkdirSync(f.gd);assert.throws(()=>f.locks.scan(),/DIRECTORY_CHANGED/);assert(existsSync(join(f.root,'old-git-folder/config.lock')));
});
test('actual metadata observer never ignores another HEAD lock even when two own locks are proven',t=>{
 const f=fixture(t),c=commitFixture(t),body={...c.intent,workspace_identity:f.identity};delete body.fingerprint;const intent={...body,fingerprint:digest(body)};
 writeFileSync(join(f.gd,'HEAD.lock'),'foreign');let calls=0;const reader=new DeliveryGitRead({binding:{root:f.root,url:f.identity.url,branch:f.identity.branch,base_sha:f.identity.base_sha},drained:()=>true,ownedLocks:()=>f.records},{execute:()=>{calls++;throw Error('must not invoke Git');}});
 assert.throws(()=>reader.capture(intent),/LOCKED/);assert.equal(calls,0);assert.equal(readFileSync(join(f.gd,'HEAD.lock'),'utf8'),'foreign');
});
