import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const read=p=>readFileSync(root+p,'utf8'),json=p=>JSON.parse(read(p)),hash=b=>createHash('sha256').update(b).digest('hex');
const release=json('docs/source-bundle-v0.33.0.json'),previous=json('docs/candidate-bundle-alpha33-9.json');
test('stable release version is consistent without enabling package publication',()=>{
 const pkg=json('bundle/package.json'),lock=json('bundle/package-lock.json'),compat=json('bundle/compatibility.json');
 assert.equal(pkg.version,'0.33.0');assert.equal(lock.version,pkg.version);assert.equal(lock.packages[''].version,pkg.version);assert.equal(compat.version,pkg.version);
 assert(read('bundle/link-contract.js').includes("VERSION='0.33.0'"));assert.equal(pkg.private,true);assert.equal(compat.publish,false);
});
test('stable promotion changes only version and descriptive metadata from deployed alpha9',()=>{
 const changed=Object.keys(release.manifest).filter(p=>release.manifest[p]!==previous.files[p]);
 assert.deepEqual(changed.sort(),['compatibility.json','link-contract.js','package-lock.json','package.json']);
 for(const p of changed){
  let text=read('bundle/'+p);
  text=p==='link-contract.js'?text.replace("VERSION='0.33.0'","VERSION='0.33.0-alpha.9'"):text.replaceAll('"version": "0.33.0"','"version": "0.33.0-alpha.9"');
  if(p==='package.json')text=text.replace('Local and cloud DSH coordination with protected onboarding, task approval and controlled artifacts','Bounded development alpha; disabled unless explicitly operator-bound and independently approved');
  assert.equal(hash(text),previous.files[p],p);
 }
});
test('complete release bundle and all rules/skills match the new source manifest',()=>{
 const actual={};function walk(base,relative=''){for(const entry of readdirSync(base,{withFileTypes:true})){if(['node_modules','__pycache__','.DS_Store'].includes(entry.name))continue;const p=relative+entry.name;assert(!entry.isSymbolicLink(),p);if(entry.isDirectory())walk(base+'/'+entry.name,p+'/');else actual[p]=hash(readFileSync(base+'/'+entry.name));}}
 walk(root+'bundle');assert.deepEqual(actual,release.manifest);assert.equal(Object.keys(actual).length,259);
 for(const p of Object.keys(actual).filter(p=>p.startsWith('skills/')||p.startsWith('global-rules/')||p.startsWith('native-rules/')))assert.equal(actual[p],previous.files[p],p);
});
