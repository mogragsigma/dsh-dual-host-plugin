import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createOnboardingInstaller} from '../bundle/onboarding-installer.js';
import {createOnboardingMaintenance} from '../bundle/onboarding-maintenance.js';
const source=path.resolve(import.meta.dirname,'../bundle');
const user=Buffer.from('\ufeff# USER ORIGINAL\r\nKEEP\r\n'),suffix=Buffer.from('\r\nUSER LATER\r\n');
const exists=p=>fs.lstat(p).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;});
async function fixture(t,{original=true}={}){
 const root=await fs.realpath(await fs.mkdtemp(path.join(tmpdir(),'s58-apply-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const home=root+'/home',dsh=home+'/dsh',agents=home+'/agents',old=root+'/old-source';
 for(const p of [dsh,agents,old])await fs.mkdir(p,{recursive:true});
 for(const n of ['global-rules','skills'])await fs.cp(source+'/'+n,old+'/'+n,{recursive:true});
 const compat=JSON.parse(await fs.readFile(source+'/compatibility.json'));compat.version='0.30.0-test';await fs.writeFile(old+'/compatibility.json',JSON.stringify(compat));
 await fs.appendFile(old+'/skills/task-onboarding/SKILL.md','\nOLD PAYLOAD\n');
 const rule=dsh+'/AGENTS.md';if(original)await fs.writeFile(rule,user,{mode:0o640});
 const config={onboarding:{role:'local',installation:{enabled:true,isolatedRoot:root}}};
 const runtime={source,home,env:{HOME:home,DSH_HOME:dsh,DSH_AGENTS_HOME:agents,DSH_ONBOARDING_ISOLATED_ROOT:root}};
 const installer=createOnboardingInstaller(config,{...runtime,source:old}),p=await installer.preview();assert(p.canApply);const initial=await installer.apply({id:p.id,fingerprint:p.fingerprint,confirm:true});assert.equal(initial.state,'committed');
 return {root,home,dsh,agents,old,rule,config,runtime,initial,service:createOnboardingMaintenance(config,runtime)};
}
async function apply(f,action='upgrade',service=f.service){const p=await service.preview({action});assert(p.canApply,JSON.stringify(p));return {p,r:await service.apply({id:p.id,fingerprint:p.fingerprint,confirm:true})};}
async function targets(f){const out={};out.rules=(await fs.readFile(f.rule)).toString('base64');for(const name of await fs.readdir(f.dsh+'/skills'))out[name]=(await fs.readFile(f.dsh+'/skills/'+name+'/SKILL.md')).toString('base64');return out;}

test('upgrade commits schema2 ownership, preserves user suffix and is idempotent after reconstruction',async t=>{
 const f=await fixture(t);await fs.appendFile(f.rule,suffix);const before=await fs.readFile(f.rule),{p,r}=await apply(f);assert.equal(r.state,'committed');
 assert.deepEqual(await fs.readFile(f.rule),before);assert.equal((await fs.stat(f.rule)).mode&0o777,0o640);
 assert.equal(await fs.readFile(f.dsh+'/skills/task-onboarding/SKILL.md','utf8'),await fs.readFile(source+'/skills/task-onboarding/SKILL.md','utf8'));
 const s=createOnboardingMaintenance(f.config,f.runtime);assert.equal((await s.status()).state,'inspected');assert.equal((await s.status()).lastReceipt.id,r.id);assert.equal((await s.status()).installedVersion,JSON.parse(await fs.readFile(source+'/package.json')).version);
 assert.equal((await s.apply({id:p.id,fingerprint:p.fingerprint,confirm:true})).state,'committed');
 const j=JSON.parse(await fs.readFile(f.dsh+'/dual-host-onboarding/installed.json'));assert.equal(j.schema,2);
 assert.equal((await createOnboardingInstaller(f.config,f.runtime).status()).state,'inspected');
 assert.equal((await s.preview({action:'repair'})).canApply,false);
});
test('upgrade replaces only managed block, keeps current user prefix and suffix',async t=>{
 const f=await fixture(t),replacement=Buffer.from('NEW USER PREFIX\n');const old=await fs.readFile(f.rule);
 await fs.writeFile(f.rule,Buffer.concat([replacement,old.subarray(user.length),suffix]));
 const next=f.root+'/next';await fs.cp(source+'/global-rules',next+'/global-rules',{recursive:true});await fs.cp(source+'/skills',next+'/skills',{recursive:true});await fs.copyFile(source+'/compatibility.json',next+'/compatibility.json');
 const p=next+'/global-rules/AGENTS.md';await fs.writeFile(p,(await fs.readFile(p,'utf8')).replace('按需加载 Skill','按需加载本项目 Skill'));
 const s=createOnboardingMaintenance(f.config,{...f.runtime,source:next});assert.equal((await apply(f,'upgrade',s)).r.state,'committed');
 const result=await fs.readFile(f.rule);assert(result.subarray(0,replacement.length).equals(replacement));assert(result.subarray(-suffix.length).equals(suffix));assert(result.toString().includes('按需加载本项目 Skill'));
});
test('repair recreates only a missing owned Skill; user-modified existing file is blocked',async t=>{
 const f=await fixture(t);await apply(f);const target=f.dsh+'/skills/task-onboarding/SKILL.md';await fs.unlink(target);
 const r=await apply(f,'repair');assert.equal(r.r.state,'committed');assert.equal((await f.service.status()).state,'inspected');
 await fs.appendFile(target,'USER');const p=await f.service.preview({action:'repair'});assert(!p.canApply);
 await assert.rejects(f.service.apply({id:p.id,fingerprint:p.fingerprint,confirm:true}),/BLOCKED/);assert((await fs.readFile(target,'utf8')).endsWith('USER'));
});
for(const upgraded of [false,true])test('uninstall exact owned files then original installer can reinstall '+upgraded,async t=>{
 const f=await fixture(t);if(upgraded)await apply(f);await fs.appendFile(f.rule,suffix);const r=await apply(f,'uninstall');assert.equal(r.r.state,'committed');
 assert.deepEqual(await fs.readFile(f.rule),Buffer.concat([user,suffix]));assert(!(await exists(f.dsh+'/skills')));
 assert.equal((await f.service.status()).state,'uninstalled');assert.equal((await createOnboardingInstaller(f.config,f.runtime).status()).state,'uninstalled');
 assert(await exists(f.dsh+'/dual-host-onboarding/transactions/'+f.initial.id+'/journal.json'));
 const i=createOnboardingInstaller(f.config,f.runtime),p=await i.preview();assert(p.canApply,JSON.stringify(p.conflicts));assert.equal((await i.apply({id:p.id,fingerprint:p.fingerprint,confirm:true})).state,'committed');
 assert.equal((await f.service.status()).state,'inspected');
});
test('uninstall retains unknown Skill sidecars and never removes them recursively',async t=>{
 const f=await fixture(t),note=f.dsh+'/skills/task-onboarding/USER.txt';await fs.writeFile(note,'KEEP');const r=await apply(f,'uninstall');assert.equal(r.r.state,'committed');assert.equal(await fs.readFile(note,'utf8'),'KEEP');
 assert(r.r.directoryResults.some(x=>x.state==='retained_nonempty_or_changed'));assert(!(await exists(f.dsh+'/skills/task-onboarding/SKILL.md')));
});
test('created AGENTS with no user content is removed; user-owned empty AGENTS is not',async t=>{
 const f=await fixture(t,{original:false});await apply(f,'uninstall');assert(!(await exists(f.rule)));
});
test('preview drift, missing consent and expiry do not mutate anything',async t=>{
 const f=await fixture(t);let clock=10;const s=createOnboardingMaintenance(f.config,{...f.runtime,now:()=>clock});let p=await s.preview({action:'uninstall'});
 await assert.rejects(s.apply({id:p.id,fingerprint:p.fingerprint,confirm:false}),/ARGUMENTS/);clock+=300001;await assert.rejects(s.apply({id:p.id,fingerprint:p.fingerprint,confirm:true}),/EXPIRED/);
 p=await s.preview({action:'uninstall'});await fs.appendFile(f.rule,suffix);const before=await targets(f);await assert.rejects(s.apply({id:p.id,fingerprint:p.fingerprint,confirm:true}),/DRIFT/);assert.deepEqual(await targets(f),before);
});
for(const phase of ['before_capture','after_capture','after_publish','after_write','after_manifest'])test('failure rolls back original inodes and data at '+phase,async t=>{
 const f=await fixture(t),before=await targets(f),inode=(await fs.stat(f.rule)).ino;
 const s=createOnboardingMaintenance(f.config,{...f.runtime,maintenanceHook:(p,n)=>{if(p===phase&&(n===0||n===-1))throw Error('injected');}});
 const {r}=await apply(f,'uninstall',s);assert.equal(r.state,'rolled_back',JSON.stringify(r));assert.deepEqual(await targets(f),before);assert.equal((await fs.stat(f.rule)).ino,inode);assert(!(await exists(f.dsh+'/dual-host-onboarding/lock.json')));
});
for(const phase of ['after_capture','after_publish','after_manifest','after_commit'])test('real child process exit then explicit recovery '+phase,async t=>{
 const f=await fixture(t),before=await targets(f);const code=`import {createOnboardingMaintenance} from ${JSON.stringify('file://'+source+'/onboarding-maintenance.js')};const s=createOnboardingMaintenance(${JSON.stringify(f.config)},{...${JSON.stringify(f.runtime)},maintenanceHook:(p,n)=>{if(p===${JSON.stringify(phase)}&&(n===0||n===-1))process.exit(91)}});const p=await s.preview({action:'uninstall'});await s.apply({id:p.id,fingerprint:p.fingerprint,confirm:true});`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',code],{env:{HOME:f.home,PATH:path.dirname(process.execPath)},encoding:'utf8'});assert.equal(child.status,91,child.stderr);
 const status=await f.service.status();assert(status.canRecover);const p=await f.service.recoveryPreview({id:status.id});
 const r=await f.service.recover({id:p.id,fingerprint:p.fingerprint,confirm:true});
 if(phase==='after_commit'){assert.equal(r.state,'committed');assert.deepEqual(await fs.readFile(f.rule),user);assert.equal((await f.service.status()).state,'uninstalled');}
 else{assert.equal(r.state,'rolled_back',JSON.stringify(r));assert.deepEqual(await targets(f),before);}
});
test('a user file created between capture and publish is never overwritten, restore remains needs_review',async t=>{
 const f=await fixture(t);const s=createOnboardingMaintenance(f.config,{...f.runtime,maintenanceHook:async(p,n,file)=>{if(p==='after_capture'&&n===0)await fs.writeFile(file,'NEW USER FILE',{flag:'wx'});}});
 const {r}=await apply(f,'uninstall',s);assert.equal(r.state,'needs_review');assert.equal(await fs.readFile(f.rule,'utf8'),'NEW USER FILE');
 assert(r.review.some(x=>x.path===f.rule));assert(await exists(r.review.find(x=>x.path===f.rule).backup));
});
test('user edit to published result is preserved, not silently rolled back',async t=>{
 const f=await fixture(t);const s=createOnboardingMaintenance(f.config,{...f.runtime,maintenanceHook:async(p,n,file)=>{if(p==='after_write'&&n===0){await fs.appendFile(file,'USER_CONCURRENT');throw Error();}}});
 const {r}=await apply(f,'uninstall',s);assert.equal(r.state,'needs_review');assert((await fs.readFile(f.rule,'utf8')).endsWith('USER_CONCURRENT'));
});
test('same-process other instance cannot recover active maintenance or use initial install recovery',async t=>{
 const f=await fixture(t);let checked=false;
 const s=createOnboardingMaintenance(f.config,{...f.runtime,maintenanceHook:async(p)=>{if(p!=='after_capture'||checked)return;checked=true;const state=await f.service.status();await assert.rejects(f.service.recoveryPreview({id:state.id}),/BUSY/);await assert.rejects(createOnboardingInstaller(f.config,f.runtime).recover({id:state.id,confirm:true}),/MAINTENANCE_RECOVERY_REQUIRED/);}});
 assert.equal((await apply(f,'uninstall',s)).r.state,'committed');assert(checked);
});
test('read-only owned files require review before any mutation',async t=>{
 const f=await fixture(t);await fs.chmod(f.rule,0o400);const p=await f.service.preview({action:'uninstall'});assert(!p.canApply);assert(p.conflicts.some(x=>x.code.endsWith('READ_ONLY_FILE')));
});
test('real SIGKILL after link publication recovers both links without overwriting user bytes',async t=>{
 const f=await fixture(t),before=await targets(f);const code=`import {createOnboardingMaintenance} from ${JSON.stringify('file://'+source+'/onboarding-maintenance.js')};const s=createOnboardingMaintenance(${JSON.stringify(f.config)},{...${JSON.stringify(f.runtime)},maintenanceHook:(p,n)=>{if(p==='after_publish'&&n===0)process.kill(process.pid,'SIGKILL')}});const p=await s.preview({action:'uninstall'});await s.apply({id:p.id,fingerprint:p.fingerprint,confirm:true});`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',code],{env:{HOME:f.home,PATH:path.dirname(process.execPath)},encoding:'utf8'});assert.equal(child.signal,'SIGKILL',child.stderr);
 const status=await f.service.status(),p=await f.service.recoveryPreview({id:status.id});assert.equal((await f.service.recover({id:p.id,fingerprint:p.fingerprint,confirm:true})).state,'rolled_back');assert.deepEqual(await targets(f),before);
});
test('corrupted journal cannot redirect recovery into an outside file',async t=>{
 const f=await fixture(t);const s=createOnboardingMaintenance(f.config,{...f.runtime,maintenanceHook:async(p,n,file)=>{if(p==='after_write'&&n===0){await fs.appendFile(file,'user');throw Error();}}});
 const {r}=await apply(f,'uninstall',s),outside=f.root+'/outside';await fs.writeFile(outside,'DO NOT TOUCH');
 const jp=f.dsh+'/dual-host-onboarding/maintenance-transactions/'+r.id+'/journal.json',j=JSON.parse(await fs.readFile(jp));j.items[0].path=outside;await fs.writeFile(jp,JSON.stringify(j));
 await assert.rejects(f.service.recoveryPreview({id:r.id}),/JOURNAL_REVIEW/);assert.equal(await fs.readFile(outside,'utf8'),'DO NOT TOUCH');
});
test('incomplete first journal retains lock for review, does not invent a rollback receipt',async t=>{
 const f=await fixture(t),before=await targets(f);const s=createOnboardingMaintenance(f.config,{...f.runtime,maintenanceHook:phase=>{if(phase==='after_lock')throw Error('injected-before-journal');}});const p=await s.preview({action:'uninstall'});
 await assert.rejects(s.apply({id:p.id,fingerprint:p.fingerprint,confirm:true}),/injected-before-journal/);
 const status=await f.service.status();assert.equal(status.state,'needs_review');assert.equal(status.canRecover,false);assert.deepEqual(await targets(f),before);
});
test('cross-filesystem capture is rejected in preview with no writes', {skip:process.platform!=='linux'},async t=>{
 const f=await fixture(t),shared=await fs.mkdtemp('/dev/shm/s58-cross-device-');t.after(()=>fs.rm(shared,{recursive:true,force:true}));
 if((await fs.stat(shared)).dev===(await fs.stat(f.dsh)).dev){t.skip('no separate test filesystem');return;}
 const dsh=f.home+'/cross-dsh';await fs.mkdir(dsh);await fs.writeFile(shared+'/AGENTS.md',user);
 const config={onboarding:{role:'local'}},runtime={...f.runtime,env:{HOME:f.home,DSH_HOME:dsh,DSH_AGENTS_HOME:shared}};
 const installer=createOnboardingInstaller(config,runtime),p=await installer.preview();assert(p.canApply);assert.equal((await installer.apply({id:p.id,fingerprint:p.fingerprint,confirm:true})).state,'committed');
 const before=await fs.readFile(shared+'/AGENTS.md'),service=createOnboardingMaintenance(config,runtime),plan=await service.preview({action:'uninstall'});
 assert(!plan.canApply);assert(plan.conflicts.some(x=>x.code.endsWith('CROSS_DEVICE_REVIEW')));assert.deepEqual(await fs.readFile(shared+'/AGENTS.md'),before);assert(!(await exists(dsh+'/dual-host-onboarding/lock.json')));
});
