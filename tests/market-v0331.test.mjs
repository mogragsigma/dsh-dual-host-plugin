import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {cloudPackage} from '../bundle/onboarding-cloud-package.js';

const source=fileURLToPath(new URL('../bundle/',import.meta.url));
const read=(name)=>fs.readFile(path.join(source,name),'utf8');
const name='@mogragsigma/dsh-dual-host-plugin';
test('release identity is consistent and publish-ready after the deliberate release change',async()=>{
 const p=JSON.parse(await read('package.json')),c=JSON.parse(await read('compatibility.json'));
 assert.equal(p.name,name);assert.equal(c.plugin,name);assert.equal(p.version,'0.33.1');assert.equal(c.version,p.version);
 assert.equal(p.private,undefined);assert.equal(p.publishConfig.access,'public');assert.equal(p.author,'mogragsigma');assert.equal(p.license,'SEE LICENSE IN LICENSE');
 assert.equal(p.engines.dsh,'0.2.1-rc.3');assert.equal(p.scripts,undefined);
 for(const f of ['LICENSE','LICENSE.en.md','THIRD_PARTY_NOTICES.md','ASSET_NOTICE.md','README.md','distribution-lock.json'])assert(p.files.includes(f));
});
test('shipped lock preserves the canonical lock and root identity',async()=>{
 const lock=await read('package-lock.json');assert.equal(await read('distribution-lock.json'),lock);
 const p=JSON.parse(lock);assert.equal(p.name,name);assert.equal(p.version,'0.33.1');assert.equal(p.packages[''].name,name);
});
test('source cloud package stays bounded and excludes development dependency links',async()=>{
 const p=await cloudPackage(source);assert(p.bytes<=8388608);assert(p.files.length<=512);
 assert.equal(p.pluginVersion,'0.33.1');assert(p.files.every(x=>!x.path.includes('node_modules')));
 const a=p.files.find(x=>x.path==='plugin/package-lock.json'),b=p.files.find(x=>x.path==='plugin/distribution-lock.json');
 assert.equal(a.sha256,b.sha256);assert.equal(a.data,b.data);
});
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'market-lock-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 for(const f of ['package.json','compatibility.json','distribution-lock.json'])await fs.copyFile(path.join(source,f),path.join(dir,f));
 return dir;
}
test('npm-style extraction materializes only canonical lock without package mutation',async t=>{
 const dir=await fixture(t),p=await cloudPackage(dir),a=p.files.find(x=>x.path==='plugin/package-lock.json');
 assert(a);assert.equal(a.data,Buffer.from(await read('package-lock.json')).toString('base64'));
 await assert.rejects(fs.stat(path.join(dir,'package-lock.json')),{code:'ENOENT'});
});
test('conflicting canonical and distribution locks fail closed',async t=>{
 const dir=await fixture(t);await fs.writeFile(path.join(dir,'package-lock.json'),'{}');
 await assert.rejects(cloudPackage(dir),/SOURCE_REVIEW/);
});
test('lock symlinks cannot read or package another file',async t=>{
 const dir=await fixture(t);await fs.unlink(path.join(dir,'distribution-lock.json'));
 await fs.symlink(path.join(source,'package-lock.json'),path.join(dir,'distribution-lock.json'));
 await assert.rejects(cloudPackage(dir),/SOURCE_REVIEW/);
});
test('legacy full package identity is not silently accepted as new namespace',async t=>{
 const dir=await fixture(t),p=JSON.parse(await fs.readFile(path.join(dir,'package.json'),'utf8'));
 p.name='@local/dsh-task-gateway';await fs.writeFile(path.join(dir,'package.json'),JSON.stringify(p));
 await assert.rejects(cloudPackage(dir),/SOURCE_REVIEW/);
});
test('rules and Skills install under protected namespaces, not publisher account paths',async()=>{
 const host=await read('onboarding-native-host.js');
 assert(host.includes('node_modules/@mogragsigma'));assert(host.includes("path.join(local,'dsh-dual-host-plugin')"));
 assert(!host.includes('node_modules/@local'));
});
