import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {onboardingIdentity} from '../bundle/onboarding-identity.js';
import {apply} from '../bundle/native-entry.js';
import {createOnboardingService} from '../bundle/onboarding-host.js';
import {createOnboardingInstaller} from '../bundle/onboarding-installer.js';
import {createOnboardingModels} from '../bundle/onboarding-models.js';
test('setup identity does not infer cloud/local from platform, host labels or credentials',()=>{
 for(const config of [{},{host:'cloud',name:'云端大肥鱼'},{platform:'linux',user:'root'}])assert.equal(onboardingIdentity(config).role,'unassigned');
});
for(const role of ['local','cloud'])test('explicit '+role+' setup opens only onboarding, not gateway',async()=>{
 let injected=0;const config={onboarding:{role}};
 await apply({inject(){injected++;},provide(){throw Error('must not provide gateway');}},config);
 assert.equal(injected,role==='cloud'?2:1);assert.deepEqual(onboardingIdentity(config),{role,name:role==='cloud'?'云端大肥鱼':'本地大肥鱼',source:'setup_configuration'});
});
test('invalid or conflicting identities fail before providing/injecting anything',async()=>{
 for(const config of [{role:'bad'},{onboarding:{role:'root'}},{onboarding:{role:null}},{role:'local',onboarding:{role:'cloud'}}]){
  assert.throws(()=>onboardingIdentity(config),/ONBOARDING_IDENTITY_/);
  await assert.rejects(apply({inject(){throw Error('not reached');},provide(){throw Error('not reached');}},config),/ONBOARDING_IDENTITY_/);
 }
 assert.equal(onboardingIdentity({role:'cloud',onboarding:{role:'cloud'}}).source,'gateway_configuration');
});
test('current Host detection and model state use setup identity without business write capability',async()=>{
 const runtime={platform:'linux',home:'/isolated/s56-home',env:{}},config={onboarding:{role:'cloud'}};
 const service=createOnboardingService({},config,runtime),description=await service.call('describe',{}),d=await service.call('detect',{});
 assert.equal(d.role,'cloud');assert.equal(d.identity.source,'setup_configuration');assert.equal(description.configured,false);assert.equal(description.capabilities.write,false);
 const models=createOnboardingModels({},config,runtime);assert.deepEqual((await models.status()).target,{role:'cloud',name:'云端大肥鱼',source:'setup_configuration',platform:'linux'});
});
test('protective rules preview uses the same explicit setup identity without rewriting user bytes',async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(tmpdir(),'s56-identity-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const home=root+'/home',dsh=home+'/dsh',agents=home+'/agents';await fs.mkdir(dsh,{recursive:true});await fs.mkdir(agents);const original=Buffer.from('\ufeff# User identity stays mine\r\n');await fs.writeFile(agents+'/AGENTS.md',original);
 const runtime={home,env:{HOME:home,DSH_HOME:dsh,DSH_AGENTS_HOME:agents,DSH_ONBOARDING_ISOLATED_ROOT:root}};
 const config={onboarding:{role:'cloud',installation:{enabled:true,isolatedRoot:root}}},plan=await createOnboardingInstaller(config,runtime).preview();assert(plan.canApply);
 assert(plan.changes[0].addedText.includes('本机身份：云端大肥鱼（Host role：cloud）'));assert.equal(plan.changes[0].preservedBytes,original.length);assert.deepEqual(await fs.readFile(agents+'/AGENTS.md'),original);
});
test('native cloud initializer explicitly sets setup identity without gateway attributes',async()=>{
 const source=await fs.readFile(new URL('../bundle/onboarding-native-host.js',import.meta.url),'utf8');assert.match(source,/settings=\{onboarding:\{role:'cloud',persistence:/);assert(!source.includes("settings={role:'cloud'"));
});
