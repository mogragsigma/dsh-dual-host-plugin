import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const read=async n=>JSON.parse(await fs.readFile(new URL('../bundle/'+n,import.meta.url)));
test('optional official IM lock does not upgrade base runtime and is excluded from the basic install',async()=>{
 const base=await read('runtime-package.json'),pkg=await read('runtime-im-package.json'),old=await read('runtime-lock.json'),lock=await read('runtime-im-lock.json');
 assert.equal(base.dependencies['@deepseek-ai/dsh'],'0.2.1-rc.3');assert(!base.dependencies['@xmanrui/dsh-im']);assert.equal(pkg.dependencies['@xmanrui/dsh-im'],'5.6.0');assert.deepEqual(lock.packages[''].dependencies,pkg.dependencies);assert(!pkg.scripts);
 for(const [name,v] of Object.entries(base.dependencies))assert.equal(pkg.dependencies[name],v);
 for(const [name,v] of Object.entries(old.packages))if(name&&lock.packages[name])assert.equal(lock.packages[name].version,v.version,name);
 for(const [name,p] of Object.entries(lock.packages)){if(!name)continue;assert(!p.link);if(p.resolved)assert.match(p.resolved,/^https:\/\/registry\.npmjs\.org\/[^?#\s]+$/);assert.match(p.integrity,/^sha512-/);}
 assert.equal(lock.packages['node_modules/@xmanrui/dsh-im'].version,'5.6.0');
});
