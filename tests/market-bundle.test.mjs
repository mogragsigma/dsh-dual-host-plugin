import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {apply} from '../bundle/native-entry.js';
const require=createRequire(new URL('./package.json',import.meta.url));
const {parse}=require('yaml');
async function patch(){return parse(await readFile(new URL('../bundle/cordis.patch.yml',import.meta.url),'utf8'));}
test('official bundle declaration inserts exactly one native owner without hardcoded configuration',async()=>{
 const p=await patch();assert.deepEqual(p,[{insert:[{id:'dual-host-onboarding',name:'@mogragsigma/dsh-dual-host-plugin'}]}]);
 const pkg=JSON.parse(await readFile(new URL('../bundle/package.json',import.meta.url)));assert.equal(pkg.dsh.bundle.patch,'./cordis.patch.yml');assert.equal(pkg.exports['.'],'./native-entry.js');assert.equal(pkg.exports['./client'],'./workbench-client.js');assert.equal(pkg.dsh.client.platform,'web');assert(pkg.files.includes('cordis.patch.yml'));
});
test('bundle does not override original modes, packages, credentials, paths or authorizations',async()=>{
 const text=JSON.stringify(await patch());for(const word of ['config','disabled','standard','ptc','cordis','minimal','provider','model','token','secret','/Users/','/root/'])assert(!text.includes(word),word);
});
test('new bundle activates only onboarding, never Gateway or a cloud worker',async()=>{
 const root={},disposers=[],bindings=[];const ctx={root,effect:fn=>disposers.push(fn()),inject:(deps,fn)=>bindings.push(deps)};
 await apply(ctx,(await patch())[0].insert[0].config);assert.deepEqual(bindings,[['connection']]);for(const f of disposers)f();
});
test('same installed module cannot bind two native owners on one Host',async()=>{
 const root={},first=[],second=[];let bound=0;const ctx=cleanups=>({root,effect:fn=>cleanups.push(fn()),inject:()=>bound++});
 await apply(ctx(first));await assert.rejects(apply(ctx(second)),/DUPLICATE_NATIVE_ENTRY/);assert.equal(bound,1);assert.equal(second.length,0);
 first[0]();await apply(ctx(second));assert.equal(bound,2);first[0]();await assert.rejects(apply(ctx([])),/DUPLICATE_NATIVE_ENTRY/);second[0]();
});
test('distinct Host roots remain independent and rejected legacy config makes no claim',async()=>{
 const first=[],second=[],rootA={},rootB={};const ctx=(root,out)=>({root,effect:fn=>out.push(fn()),inject(){}});
 await assert.rejects(apply(ctx(rootA,first),{legacyFeishu:true}),/LEGACY_ENTRY_RETIRED/);assert.equal(first.length,0);
 await apply(ctx(rootA,first));await apply(ctx(rootB,second));first[0]();second[0]();
});
test('failed lifecycle registration releases only its own claim',async()=>{
 const root={},out=[];await assert.rejects(apply({root,effect(){throw Error('inactive');},inject(){}}),/inactive/);
 await apply({root,effect:fn=>out.push(fn()),inject(){}});out[0]();
});
test('global rules and Skill keep native function and explicit-confirmation boundaries',async()=>{
 const rules=await readFile(new URL('../bundle/global-rules/AGENTS.md',import.meta.url),'utf8'),skill=await readFile(new URL('../bundle/skills/task-onboarding/SKILL.md',import.meta.url),'utf8');assert(rules.includes('原生功能'));assert(skill.includes('新用户无需手写加载补丁'));assert(skill.includes('不会自行改写用户 profile'));assert(skill.includes('不同目录的多份旧插件仍需官方清单核对'));
});
