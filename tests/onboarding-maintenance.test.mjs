import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createOnboardingInstaller} from '../bundle/onboarding-installer.js';
import {createOnboardingMaintenance} from '../bundle/onboarding-maintenance.js';
import {createOnboardingService} from '../bundle/onboarding-host.js';

const source=path.resolve(import.meta.dirname,'../bundle');
const user=Buffer.from('\ufeff# KEEP ORIGINAL USER RULES\r\nPRIVATE_USER_RULE_DO_NOT_RETURN\r\n');
async function fixture(t,{existing=true,shared=false}={}){
 const root=await fs.realpath(await fs.mkdtemp(path.join(tmpdir(),'s58-maintenance-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const home=root+'/home',dsh=home+'/dsh',agents=home+'/agents',prior=root+'/old-source';
 for(const p of [dsh,agents,prior])await fs.mkdir(p,{recursive:true});
 for(const name of ['skills','global-rules'])await fs.cp(source+'/'+name,prior+'/'+name,{recursive:true});
 const compat=JSON.parse(await fs.readFile(source+'/compatibility.json'));compat.version='0.30.0-test';
 await fs.writeFile(prior+'/compatibility.json',JSON.stringify(compat));
 // Explicit older payload, so a new version actually has something to upgrade.
 await fs.appendFile(prior+'/skills/task-onboarding/SKILL.md','\nOld fixture only.\n');
 const config={onboarding:{role:'local',installation:{enabled:true,isolatedRoot:root}}};
 const runtime={home,source,env:{HOME:home,DSH_HOME:dsh,DSH_AGENTS_HOME:agents,DSH_ONBOARDING_ISOLATED_ROOT:root}};
 const rule=(shared?agents:dsh)+'/AGENTS.md';if(existing)await fs.writeFile(rule,user,{mode:0o640});
 const installer=createOnboardingInstaller(config,{...runtime,source:prior});
 const p=await installer.preview(),installed=await installer.apply({id:p.id,fingerprint:p.fingerprint,confirm:true});
 assert.equal(installed.state,'committed');
 const f={root,home,dsh,agents,prior,config,runtime,rule,installed,source};
 f.service=createOnboardingMaintenance(config,runtime);
 f.repair=createOnboardingMaintenance(config,{...runtime,source:prior});return f;
}
async function tree(dir){
 const out={};async function visit(p){for(const e of await fs.readdir(p,{withFileTypes:true})){
  const f=path.join(p,e.name),s=await fs.lstat(f);out[path.relative(dir,f)]={mode:s.mode,ino:s.ino,
   data:e.isSymbolicLink()?await fs.readlink(f):e.isDirectory()?null:(await fs.readFile(f)).toString('base64')};if(e.isDirectory())await visit(f);
 }}await visit(dir);return out;
}
const code=(p,s)=>p.conflicts.some(c=>c.code.endsWith(s));
async function editJSON(p,edit){const x=JSON.parse(await fs.readFile(p));edit(x);await fs.writeFile(p,JSON.stringify(x));}
const journal=f=>f.dsh+'/dual-host-onboarding/transactions/'+f.installed.id+'/journal.json';

test('public contract requires explicit confirmed maintenance; preview stays read-only',async t=>{
 const f=await fixture(t),svc=createOnboardingService({},f.config,f.runtime);
 const desc=await svc.call('describe',{});assert.equal(desc.capabilities.rulesMaintenancePreviewContract,2);
 assert.equal(desc.capabilities.rulesMaintenanceMutation,true);
 const p=await svc.call('maintenance_preview',{action:'upgrade'});assert(p.planReady);assert(p.canApply&&p.mutationAvailable);
 assert.equal(p.installedVersion,'0.30.0-test');assert.equal(p.targetVersion,JSON.parse(await fs.readFile(path.join(source,'package.json'))).version);
 await assert.rejects(svc.call('maintenance_apply',{}),/INVALID_ARGUMENTS/);
 await assert.rejects(svc.call('maintenance_preview',{action:'upgrade',path:'/bad'}),/ARGUMENTS/);
 await assert.rejects(svc.call('maintenance_status',{confirm:true}),/ARGUMENTS/);
});
test('preview is byte-and-inode read-only and does not return user rules or original backup',async t=>{
 const f=await fixture(t);const before=await tree(f.root),p=await f.service.preview({action:'upgrade'});
 assert(p.planReady,JSON.stringify(p.conflicts));assert.equal(p.changes.length,1);
 assert.equal(p.changes[0].kind,'skill');assert(!JSON.stringify(p).includes('PRIVATE_USER_RULE_DO_NOT_RETURN'));
 assert(!JSON.stringify(p).includes(user.toString('base64')));assert.deepEqual(await tree(f.root),before);
 for(const k of Object.values(p.preserved))assert.equal(k,true);
});
for(const shared of [false,true])test('uninstall removes exact owned block, preserves BOM CRLF prefix and later user suffix '+shared,async t=>{
 const f=await fixture(t,{shared});const suffix=Buffer.from('\r\nUSER ADDED AFTER INSTALL\r\n');await fs.appendFile(f.rule,suffix);
 const p=await f.service.preview({action:'uninstall'});assert(p.planReady,JSON.stringify(p.conflicts));
 const row=p.changes.find(x=>x.kind==='global_rules');assert.equal(row.action,'replace');assert.equal(row.afterBytes,user.length+suffix.length);
 assert.equal(row.preservedUserBytes,user.length+suffix.length);assert.equal(row.userContentChangedOutsideBlock,true);
 assert.equal(p.changes.filter(x=>x.kind==='skill').length,19);
 assert.equal((await fs.stat(f.rule)).mode&0o777,0o640);
});
test('modified user prefix outside unchanged managed block is preserved, not restored from old journal',async t=>{
 const f=await fixture(t),all=await fs.readFile(f.rule),replacement=Buffer.from('MY NEW USER RULES\n');
 await fs.writeFile(f.rule,Buffer.concat([replacement,all.subarray(user.length)]));
 const p=await f.service.preview({action:'uninstall'});assert(p.planReady);assert.equal(p.changes[0].afterBytes,replacement.length);
 assert.equal((await f.service.status()).state,'inspected');
});
test('new originally-owned rules file can be removed, but later user additions must remain',async t=>{
 const f=await fixture(t,{existing:false});let p=await f.service.preview({action:'uninstall'});
 assert.equal(p.changes.find(x=>x.kind==='global_rules').action,'remove');
 await fs.appendFile(f.rule,'USER');p=await f.service.preview({action:'uninstall'});
 assert.equal(p.changes.find(x=>x.kind==='global_rules').action,'replace');assert.equal(p.changes[0].afterBytes,4);
});
test('preexisting empty user rules file is not deleted',async t=>{
 const f=await fixture(t,{existing:false});
 // Reinstall in a second empty isolated root with an actual preexisting empty file.
 const dsh=f.home+'/empty-dsh';await fs.mkdir(dsh);await fs.writeFile(dsh+'/AGENTS.md','');
 const runtime={...f.runtime,env:{...f.runtime.env,DSH_HOME:dsh},source:f.prior};
 const installer=createOnboardingInstaller(f.config,runtime),p=await installer.preview();assert(p.canApply);
 assert.equal((await installer.apply({id:p.id,fingerprint:p.fingerprint,confirm:true})).state,'committed');
 const plan=await createOnboardingMaintenance(f.config,runtime).preview({action:'uninstall'});
 const row=plan.changes.find(x=>x.kind==='global_rules');assert.equal(row.action,'replace');assert.equal(row.afterBytes,0);
});
for(const action of ['upgrade','repair','uninstall'])test('changed owned Skill blocks without overwriting '+action,async t=>{
 const f=await fixture(t);await fs.appendFile(f.dsh+'/skills/task-onboarding/SKILL.md','USER CHANGE');
 const p=await (action==='repair'?f.repair:f.service).preview({action});assert(!p.planReady);assert(code(p,'OWNED_SKILL_CHANGED'));assert.deepEqual(p.changes,[]);
});
for(const change of ['block','duplicate','end'])test('ambiguous or modified managed rules block blocks '+change,async t=>{
 const f=await fixture(t);let s=await fs.readFile(f.rule,'utf8');
 if(change==='block')s=s.replace('Host role：local','Host role：changed');
 if(change==='duplicate')s+='\n<!-- dsh-dual-host:begin -->\n';
 if(change==='end')s=s.replace('<!-- dsh-dual-host:end -->','<!-- missing -->');
 await fs.writeFile(f.rule,s);const p=await f.service.preview({action:'uninstall'});assert(code(p,'OWNED_RULE_BLOCK_CHANGED'));assert(!p.planReady);
});
test('repair version must match, and same version with different source payload is refused',async t=>{
 const f=await fixture(t);assert(code(await f.service.preview({action:'repair'}),'REPAIR_VERSION_MISMATCH'));
 await fs.appendFile(f.prior+'/skills/task-onboarding/SKILL.md','SOURCE CHANGE');
 assert(code(await f.repair.preview({action:'repair'}),'REPAIR_SOURCE_CHANGED'));
});
test('repair missing owned Skill only, never silently recreate a lost user rules file',async t=>{
 const f=await fixture(t);await fs.unlink(f.dsh+'/skills/task-onboarding/SKILL.md');
 let p=await f.repair.preview({action:'repair'});assert(p.planReady);assert.equal(p.changes.length,1);assert.equal(p.changes[0].action,'create');
 await fs.unlink(f.rule);p=await f.repair.preview({action:'repair'});assert(code(p,'USER_RULE_FILE_MISSING'));assert(!p.planReady);
});
test('repair missing originally-created empty-user rules file may restore managed content',async t=>{
 const f=await fixture(t,{existing:false});await fs.unlink(f.rule);const p=await f.repair.preview({action:'repair'});
 assert(p.planReady);assert.equal(p.changes[0].action,'create');assert.equal(p.changes[0].preservedUserBytes,0);
});
test('unknown Skill sidecars are named as retained, never opened or deleted',async t=>{
 const f=await fixture(t),dir=f.dsh+'/skills/task-onboarding';await fs.writeFile(dir+'/user-note.txt','DO_NOT_RETURN_SIDECAR');
 const p=await f.service.preview({action:'uninstall'});assert(p.planReady);assert(p.retained.some(x=>x.path===dir&&x.names.includes('user-note.txt')));
 assert(!JSON.stringify(p).includes('DO_NOT_RETURN_SIDECAR'));
});
test('empty shared same-name Skill is a conflict',async t=>{
 const f=await fixture(t);await fs.mkdir(f.agents+'/skills/task-onboarding',{recursive:true});
 assert(code(await f.service.preview({action:'upgrade'}),'SHARED_SKILL_CONFLICT'));
});
for(const kind of ['symlink','hardlink'])test('unsafe owned file refuses maintenance '+kind,async t=>{
 const f=await fixture(t),skill=f.dsh+'/skills/task-onboarding/SKILL.md',external=f.root+'/outside';
 await fs.writeFile(external,'KEEP OUTSIDE');await fs.unlink(skill);if(kind==='symlink')await fs.symlink(external,skill);else await fs.link(external,skill);
 const p=await f.service.preview({action:'uninstall'});assert(!p.planReady);assert(code(p,'UNSAFE_OR_UNREADABLE'));assert.equal(await fs.readFile(external,'utf8'),'KEEP OUTSIDE');
});
test('active install lock and missing journal cannot be adopted into maintenance',async t=>{
 const f=await fixture(t);await fs.writeFile(f.dsh+'/dual-host-onboarding/lock.json','{}');assert(code(await f.service.preview({action:'upgrade'}),'RECOVERY_REQUIRED'));
 await fs.unlink(journal(f));assert(code(await f.service.preview({action:'uninstall'}),'OWNERSHIP_REVIEW'));
});
for(const tamper of ['outside','hash','source','before','state','duplicate'])test('ownership proof corruption fails closed '+tamper,async t=>{
 const f=await fixture(t);await editJSON(journal(f),j=>{
  if(tamper==='outside')j.items[0].path=f.home+'/outside';
  if(tamper==='hash')j.items[0].afterHash='0'.repeat(64);
  if(tamper==='source')j.items[1].sourceHash='0'.repeat(64);
  if(tamper==='before')j.items[0].before.data=Buffer.from('forged').toString('base64');
  if(tamper==='state')j.state='applying';
  if(tamper==='duplicate')j.items[1]=j.items[0];
 });const p=await f.service.preview({action:'uninstall'});assert(code(p,'OWNERSHIP_REVIEW'));assert(!p.planReady);
});
test('fingerprint binds user suffix and does not invalidate from unrelated sibling file',async t=>{
 const f=await fixture(t);let p=await f.service.preview({action:'uninstall'});await fs.writeFile(f.root+'/unrelated','x');
 const same=await f.service.preview({action:'uninstall'});assert.equal(p.fingerprint,same.fingerprint);
 await fs.appendFile(f.rule,'NEW USER');const changed=await f.service.preview({action:'uninstall'});assert.notEqual(changed.fingerprint,p.fingerprint);
});
test('upgrade adds only genuinely missing named Skill and plans removed owned Skill without claiming sidecars',async t=>{
 const f=await fixture(t),next=f.root+'/new-source';await fs.cp(f.prior,next,{recursive:true});
 await editJSON(next+'/compatibility.json',c=>{c.version='next';c.globalSkills=c.globalSkills.filter(x=>x!=='task-onboarding');c.globalSkills.push('task-new-fixture');});
 await fs.mkdir(next+'/skills/task-new-fixture');await fs.writeFile(next+'/skills/task-new-fixture/SKILL.md','# New own Skill');
 const service=createOnboardingMaintenance(f.config,{...f.runtime,source:next});const p=await service.preview({action:'upgrade'});assert(p.planReady);
 assert(p.changes.some(x=>x.path.endsWith('/task-new-fixture/SKILL.md')&&x.action==='create'));
 assert(p.changes.some(x=>x.path.endsWith('/task-onboarding/SKILL.md')&&x.action==='remove'));
 await fs.mkdir(f.dsh+'/skills/task-new-fixture');assert(code(await service.preview({action:'upgrade'}),'NEW_SKILL_CONFLICT'));
});
test('empty environment and explicit disabled config cannot escape isolated roots',async t=>{
 const f=await fixture(t);assert(!createOnboardingMaintenance({},f.runtime).available());
 assert(!createOnboardingMaintenance(f.config,{...f.runtime,env:{}}).available());
 const disabled={...f.config,onboarding:{...f.config.onboarding,installation:{enabled:false}}};
 await assert.rejects(createOnboardingMaintenance(disabled,f.runtime).preview({action:'uninstall'}),/DISABLED/);
});
test('invalid user encoding is preserved as a structured review, not returned or normalized',async t=>{
 const f=await fixture(t);await fs.appendFile(f.rule,Buffer.from([255]));const before=await fs.readFile(f.rule);
 const p=await f.service.preview({action:'uninstall'});assert(code(p,'ENCODING_REVIEW'));assert(!p.planReady);assert.deepEqual(await fs.readFile(f.rule),before);
});
test('uninstall plan relies on committed ownership, not the availability of a replacement source',async t=>{
 const f=await fixture(t),service=createOnboardingMaintenance(f.config,{...f.runtime,source:f.root+'/missing-source'});
 const p=await service.preview({action:'uninstall'});assert(p.planReady);assert.equal(p.changes.length,20);
});
test('upgrade budget includes both global files and never truncates user text',async t=>{
 const f=await fixture(t);await fs.writeFile(f.agents+'/AGENTS.md','USER '+ 'x'.repeat(60000));const before=await tree(f.root);
 const p=await f.service.preview({action:'upgrade'});assert(code(p,'GLOBAL_BUDGET_REVIEW'));assert.deepEqual(p.changes,[]);assert.deepEqual(await tree(f.root),before);
});
test('corrupt manifest is needs_review, never a fresh not_installed state',async t=>{
 const f=await fixture(t);await fs.writeFile(f.dsh+'/dual-host-onboarding/installed.json','{broken');
 const p=await f.service.status();assert.equal(p.state,'needs_review');assert(code(p,'OWNERSHIP_REVIEW'));
 await assert.rejects(f.service.status([]),/INVALID_ARGUMENTS/);
});
