import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import semver from 'semver';
import {evaluatePluginCompatibility} from '@deepseek-ai/dsh-app-boot';
const pkg=JSON.parse(fs.readFileSync(new URL('../bundle/package.json',import.meta.url)));
for(const [version,allowed] of [
 ['0.2.1-rc.4',false],['0.2.1-rc.5',true],['0.2.1-rc.6',true],['0.2.1',true],
 ['0.2.2-alpha.3',false],['0.2.2-rc.1',true],['0.2.2-rc.2',true],['0.2.2',true],
 ['0.2.3-alpha.1',false],['0.2.3',false],['0.3.0',false],['1.0.0',false],
])test(`DSH loader and npm agree: ${version} ${allowed?'allowed':'rejected'}`,()=>{
 assert.equal(evaluatePluginCompatibility(pkg,{},version)===undefined,allowed);
 assert.equal(semver.satisfies(version,pkg.engines.dsh),allowed);
 for(const [name,range] of Object.entries(pkg.peerDependencies)){
  if(name.startsWith('@deepseek-ai/'))assert.equal(semver.satisfies(version,range),allowed,name);
 }
});
test('pi-ai admits observed host peers but does not admit the next unreviewed minor',()=>{
 const range=pkg.peerDependencies['@earendil-works/pi-ai'];
 for(const version of ['1.3.0','1.4.0','1.5.0'])assert(semver.satisfies(version,range));
 for(const version of ['1.2.9','1.6.0','2.0.0'])assert(!semver.satisfies(version,range));
});
test('compatibility range never changes the reproducible standalone runtime pin',()=>{
 const c=JSON.parse(fs.readFileSync(new URL('../bundle/compatibility.json',import.meta.url)));
 assert.equal(c.hostCompatibilityPolicy.declaredRange,pkg.engines.dsh);
 for(const f of ['runtime-package.json','runtime-im-package.json']){
  const runtime=JSON.parse(fs.readFileSync(new URL('../bundle/'+f,import.meta.url)));
  assert.equal(runtime.dependencies['@deepseek-ai/dsh'],c.hostCompatibilityPolicy.standalonePinnedHost);
 }
});
