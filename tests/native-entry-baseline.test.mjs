import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {apply} from '../bundle/native-entry.js';
import {apply as legacyTools} from '../bundle/tools.js';
import {registerNativeTools} from '../bundle/native-tools.js';
test('public entry refuses legacy consumer and mode before any side effect',async()=>{
 for(const c of [{legacyFeishu:true},{entryMode:'legacy'}])await assert.rejects(apply({},c),/LEGACY_ENTRY_RETIRED/);
});
test('native-only runtime exposes no old consumer or restrictive preset; native tools remain additive',async t=>{
 const dir=mkdtempSync(tmpdir()+'/native-baseline-'),tokenFile=dir+'/tokens.json';
 writeFileSync(tokenFile,JSON.stringify({localToken:'l'.repeat(32),cloudToken:'c'.repeat(32)}),{mode:0o600});
 const services=new Map(),agents=new Map(),events=[];
 const ctx={inject(){},provide:(k,v)=>services.set(k,v),effect(){},on:(...a)=>events.push(a),agents:{get:k=>agents.get(k),list:()=>[...agents.values()]},agentPresets:{composedPreset:c=>c.preset}};
 await apply(ctx,{role:'cloud',namespace:'baseline',stateDir:dir+'/state',tokenFile,port:0});const g=services.get('taskGateway');
 t.after(async()=>{await g.close();rmSync(dir,{recursive:true,force:true});});
 assert.equal(services.has('dshTaskIngress'),false);assert.equal(g.snapshot().entryMode,'native');assert.equal(g.snapshot().managedPreset,null);assert.equal(g.snapshot().legacyFeishu,false);
 const agent={id:'old',ctx:{preset:'dsh-task-intake'}};agents.set(agent.id,agent);assert.equal(g.isManaged(agent),false);
 const old=new Map();legacyTools({taskGateway:g,tools:{register:d=>old.set(d.name,d),guard(){}}});
 assert.throws(()=>old.get('task_status').execute({task_id:'x'},{agent}),/UNBOUND_ENTRY_SESSION/);
 let guards=0;const added=new Map();registerNativeTools({taskGateway:g,tools:{register:d=>added.set(d.name,d),guard(){guards++;}}});
 assert.equal(guards,0);assert.equal(added.size,51);assert(added.has('task_delivery_push_prepare'));assert(added.has('task_delivery_push_start'));assert(added.has('task_delivery_prepare'));assert(added.has('task_delivery_schedule'));assert(added.has('task_development_start'));assert.equal(g.snapshot().repositoryBindings,0);
 await assert.rejects(g.receive({text:'/approve'}),/LEGACY_IM_DISABLED/);
 for(const event of events.filter(e=>e[0]==='agent/request')){
  const result={provider:'original',model:'original',maxTokens:4096};assert.equal(await event[1]({agent},async()=>result),result);
 }
});
test('package exports native entry and compatibility baseline matches versions',()=>{
 const pkg=JSON.parse(readFileSync(new URL('../bundle/package.json',import.meta.url)));
 const c=JSON.parse(readFileSync(new URL('../bundle/compatibility.json',import.meta.url)));
 assert.equal(pkg.exports['.'],'./native-entry.js');assert.equal(pkg.exports['./tools'],undefined);assert.equal(pkg.version,c.version);
 assert.equal(c.legacyImConsumer,false);assert.equal(c.development,false);assert.equal(c.publish,false);
});
test('native gateway refuses legacy repository writers before creating any state',async t=>{
 const dir=mkdtempSync(tmpdir()+'/native-no-writer-'),tokenFile=dir+'/tokens.json';t.after(()=>rmSync(dir,{recursive:true,force:true}));
 writeFileSync(tokenFile,JSON.stringify({localToken:'l'.repeat(32),cloudToken:'c'.repeat(32)}),{mode:0o600});
 await assert.rejects(apply({}, {role:'cloud',stateDir:dir+'/state',tokenFile,repositoryBindings:{task:{root:'/tmp',branch:'dsh-task/test',path:'x'}}}),/LEGACY_REPOSITORY_WRITER_DISABLED/);
 assert.throws(()=>readFileSync(dir+'/state/gateway.sqlite'),/ENOENT/);
});
