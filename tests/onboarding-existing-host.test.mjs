import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {createExistingHostInspection,existingHostView} from '../bundle/onboarding-existing-host.js';
import {createOnboardingService} from '../bundle/onboarding-host.js';
import {Gateway} from '../bundle/index.js';
import {VERSION,CAPABILITIES} from '../bundle/link-contract.js';
const uuid=randomUUID;
function fixture(role='local'){
 let g={c:{role},instanceId:uuid(),closed:false,scheduler:{started:true,closed:false,active:new Map()},repositories:{provider:{}},modelSelection:{available:()=>true,catalog:async()=>({items:[{provider:'test-provider',model:'test-model',apiKey:'never-export'}],errors:[]})}};
 g.hello=()=>({schema:1,protocol:{min:1,max:1},plugin_version:VERSION,role,namespace:'existing-unit',instance_id:g.instanceId,capabilities:{...CAPABILITIES}});
 const opts={gateway:()=>g,now:()=>1000,detect:async()=>({role,platform:'linux',nodeVersion:'22.23.3',paths:{dsh:{path:'/isolated/dsh'},agents:{path:'/isolated/agents'}}}),installer:{available:()=>true,status:async()=>({state:'committed',files:[{path:'/isolated/user-file'}],secret:'never-export'})},im:{inventory:async()=>({state:'listed',botsConfigured:1,botId:'never-export'})}};
 const s=createExistingHostInspection(opts);return {s,opts,get g(){return g;},set g(x){g=x;}};
}
async function pair(){const f=fixture(),remote=fixture('cloud');f.g.link={call:async()=>({result:await remote.s.inspectHost({}),observation:{freshness:'live_response',authority:'cloud',instance_id:remote.g.instanceId}})};return {...f,remote};}
test('existing Host inspection projects only bounded metadata and grants nothing',async()=>{
 const f=fixture(),v=existingHostView(await f.s.inspectHost({}));
 assert.equal(v.models.models,1);assert.equal(v.rules.files,1);assert.equal(v.im.botsConfigured,1);
 assert.equal(v.models.inferenceVerified,false);assert.equal(v.im.connectionVerified,false);assert.equal(v.runtime.repositoryAccessVerified,false);assert.equal(v.rules.activationVerified,false);
 assert(!JSON.stringify(v).includes('never-export'));assert(!JSON.stringify(v).includes('/isolated/user-file'));assert.equal(v.host.namespace,undefined);
});
test('no configured gateway never falls back to SSH or a different Host',async()=>{
 const f=fixture();f.g=null;await assert.rejects(f.s.inspectHost({}),/UNAVAILABLE/);await assert.rejects(f.s.inspectPair({}),/UNAVAILABLE/);assert.equal(f.s.available(),false);
});
test('strict empty request forbids arbitrary methods, paths and command forwarding',async()=>{
 const f=fixture();for(const args of [null,[],{method:'install_apply'},{path:'/etc/passwd'},{confirm:true}]){await assert.rejects(f.s.inspectHost(args),/ARGUMENTS/);await assert.rejects(f.s.inspectPair(args),/ARGUMENTS/);}
});
test('partial model and IM inventory is not promoted to ready',async()=>{
 const f=fixture();f.g.modelSelection.catalog=async()=>({items:[],errors:[{provider:'p',secret:'never-export'}]});f.opts.im.inventory=async()=>({state:'missing_dependency'});
 const v=existingHostView(await f.s.inspectHost({}));assert.equal(v.models.state,'catalog_incomplete');assert.equal(v.im.state,'missing_dependency');assert.equal(v.models.models,0);assert(!JSON.stringify(v).includes('never-export'));
});
test('filesystem or SDK errors become a review state without raw provider errors',async()=>{
 const f=fixture();f.opts.installer.status=async()=>{throw Error('secret-private-file');};f.opts.im.inventory=async()=>{throw Error('secret-bot');};f.g.modelSelection.catalog=async()=>{throw Error('secret-key');};
 const r=await f.s.inspectHost({});assert.equal(r.rules.state,'needs_review');assert.equal(r.models.state,'unavailable');assert.equal(r.im.state,'needs_review');assert(!JSON.stringify(r).includes('secret-'));
});
test('target role must come from Host configuration, never OS or a label',async()=>{
 const f=fixture();f.opts.detect=async()=>({role:'cloud'});const s=createExistingHostInspection(f.opts);await assert.rejects(s.inspectHost({}),/IDENTITY_CONFLICT/);
});
test('Host replacement and disposal during an observation invalidate the response',async()=>{
 for(const replace of [true,false]){const f=fixture();f.opts.im.inventory=async()=>{if(replace)f.g={...f.g};else f.s.dispose();return {state:'listed',botsConfigured:1};};await assert.rejects(f.s.inspectHost({}),/HOST_CHANGED|UNAVAILABLE/);}
});
test('successful pair inspection is fresh read-only evidence, not an install or execution receipt',async()=>{
 const f=await pair(),r=await f.s.inspectPair({});assert.equal(r.scope,'existing_pair_review_only');assert.equal(r.expiresAt,61000);assert.equal(r.installationOwned,false);assert.equal(r.configurationChanged,false);assert.equal(r.executionAuthorized,false);assert.equal(r.endToEndVerified,false);assert.equal(r.local.host.role,'local');assert.equal(r.cloud.host.role,'cloud');
});
test('offline and legacy peers never use a cached success',async()=>{
 const f=await pair();await f.s.inspectPair({});for(const code of ['COORDINATOR_UNAVAILABLE','CAPABILITY_UNAVAILABLE']){f.g.link.call=async()=>{throw Error(code);};await assert.rejects(f.s.inspectPair({}),new RegExp(code));}
});
test('wrong peer instance, namespace, role or stale proof is rejected',async()=>{
 for(const mutate of [p=>p.observation.instance_id=uuid(),p=>p.result.host.namespace='other',p=>p.result.host.role='local',p=>p.observation.freshness='recent_snapshot']){const f=await pair(),call=f.g.link.call;f.g.link.call=async()=>{const p=await call();mutate(p);return p;};await assert.rejects(f.s.inspectPair({}),/PEER_CHANGED/);}
});
test('remote view rejects unexpected fields and unbounded counters',async()=>{
 for(const mutate of [v=>v.paths.token='not-allowed',v=>v.models.models=1e9,v=>v.im.botId='not-allowed',v=>v.runtime.repositoryAccessVerified=true,v=>v.rules.activationVerified=true,v=>v.host.capabilities={x:'invalid'}]){const f=fixture('cloud'),v=await f.s.inspectHost({});mutate(v);assert.throws(()=>existingHostView(v),/RESPONSE_INVALID|DESCRIPTOR_INVALID/);}
});
test('concurrent manual checks coalesce and a cloud entry cannot inspect the Mac by pretending',async()=>{
 const f=await pair();let calls=0;const call=f.g.link.call;f.g.link.call=async(...a)=>{calls++;return call(...a);};await Promise.all([f.s.inspectPair({}),f.s.inspectPair({})]);assert.equal(calls,1);await assert.rejects(f.remote.s.inspectPair({}),/LOCAL_ENTRY_REQUIRED/);
});
test('real loopback Gateway negotiates this optional read capability and denies its absence',async t=>{
 const root=mkdtempSync(tmpdir()+'/existing-pair-');t.after(()=>rmSync(root,{recursive:true,force:true}));
 writeFileSync(root+'/keys',JSON.stringify({localToken:'l'.repeat(32),cloudToken:'c'.repeat(32)}),{mode:0o600});
 const ctx={on(){},effect(){},agents:{list:()=>[]},agentPresets:{},get(){}};
 const c=new Gateway(ctx,{role:'cloud',entryMode:'native',namespace:'existing-unit',stateDir:root+'/cloud-state',tokenFile:root+'/keys',port:0});t.after(()=>c.close());
 await c.start();await c.pending;clearTimeout(c.timer);
 const l=new Gateway(ctx,{role:'local',entryMode:'native',namespace:'existing-unit',stateDir:root+'/local-state',tokenFile:root+'/keys',port:0,coordinatorUrl:'http://127.0.0.1:'+c.server.address().port});t.after(()=>l.close());
 assert.equal(c.hello().capabilities.onboarding_existing,undefined);await assert.rejects(l.link.call('onboarding_existing_inspect',{}),/CAPABILITY_UNAVAILABLE/);
 const inspect=[];for(const [role,g] of [['cloud',c],['local',l]]){
  const home=root+'/'+role+'-home';mkdirSync(home+'/.dsh',{recursive:true});mkdirSync(home+'/.agents');
  const config={role,onboarding:{installation:{enabled:false}}};
  const runtime={gateway:g,home,env:{HOME:home,DSH_HOME:home+'/.dsh',DSH_AGENTS_HOME:home+'/.agents',PATH:''},platform:'linux'};
  const service=createOnboardingService({},config,runtime);t.after(()=>service.dispose());g.onboardingInspection=service.inspectExistingHost;inspect.push(service);
 }
 const r=await inspect[1].call('existing_pair_inspect',{});assert.equal(r.cloud.host.instance_id,c.instanceId);assert.equal(r.local.host.instance_id,l.instanceId);assert.equal(r.cloud.rules.state,'unavailable');assert.equal(r.cloud.models.state,'unavailable');
 for(const role of ['local','cloud'])assert.deepEqual(readdirSync(root+'/'+role+'-home/.dsh'),[]);
 assert.equal(c.store.db.prepare('SELECT count(*) AS n FROM tasks').get().n,0);
 const d=await inspect[1].call('describe',{});assert.equal(d.capabilities.existingPairInspectionContract,1);
 c.onboardingInspection=null;await assert.rejects(inspect[1].call('existing_pair_inspect',{}),/CAPABILITY_UNAVAILABLE/);
});

test('genuine maintenance inspection and uninstall remain distinct from install success',async()=>{
 for(const state of ['inspected','uninstalled','needs_review']){const f=fixture();f.opts.installer.status=async()=>({state,files:[]});assert.equal((await f.s.inspectHost({})).rules.state,state);}
});

test('existing repository capability uses GET API through real link, with no resolution or task writes',async t=>{
 const root=mkdtempSync(tmpdir()+'/existing-repo-');t.after(()=>rmSync(root,{recursive:true,force:true}));
 writeFileSync(root+'/keys',JSON.stringify({localToken:'l'.repeat(32),cloudToken:'c'.repeat(32)}),{mode:0o600});
 const requests=[],ctx={on(){},effect(){},agents:{list:()=>[]},agentPresets:{},get(){}};
 const fetch=async(url,options)=>{requests.push({url,method:options.method});return Response.json(url.endsWith('/branches/main')?{name:'main',commit:{sha:'b'.repeat(40)}}:{id:42,full_name:'example/task-results',private:true,default_branch:'main',token:'never-export'});};
 const c=new Gateway(ctx,{role:'cloud',entryMode:'native',namespace:'existing-repo-unit',stateDir:root+'/cloud',tokenFile:root+'/keys',port:0},{repository:{fetch}});t.after(()=>c.close());await c.start();await c.pending;clearTimeout(c.timer);
 const l=new Gateway(ctx,{role:'local',entryMode:'native',namespace:'existing-repo-unit',stateDir:root+'/local',tokenFile:root+'/keys',port:0,coordinatorUrl:'http://127.0.0.1:'+c.server.address().port});t.after(()=>l.close());
 const tables=['tasks','repository_resolutions','repository_associations','repository_events'];const counts=()=>tables.map(name=>c.store.db.prepare('SELECT count(*) AS n FROM '+name).get().n);const before=counts();
 const r=await l.link.call('onboarding_existing_repository',{url:'https://gitee.com/example/task-results'});
 assert.equal(r.result.repository_id,42);assert.equal(r.result.token,undefined);assert.deepEqual(counts(),before);assert.equal(requests.length,2);assert(requests.every(r=>r.method==='GET'&&r.url.startsWith('https://gitee.com/api/v5/repos/example/task-results')));
 for(const a of [{url:'https://other.example/a/b'},{url:'https://gitee.com/example/task-results',confirm:true}])await assert.rejects(l.link.call('onboarding_existing_repository',a));assert.equal(requests.length,2);
 c.repositories.provider=null;assert.equal(c.hello().capabilities.onboarding_existing_repository,undefined);await assert.rejects(l.link.call('onboarding_existing_repository',{url:'https://gitee.com/example/task-results'}),/CAPABILITY_UNAVAILABLE/);
});

test('public onboarding dispatch exposes reuse only with local pair and owned persistence enabled',async()=>{
 const f=fixture(),root='/isolated';f.g.link={call:async()=>{throw Error('not needed');}};
 const records=new Map(),credentials={readRecord:async k=>records.get(k),describeRecord:async()=>({writable:true}),modifyRecord:async()=>{throw Error('read only test');}};
 const runtime={gateway:f.g,home:root+'/home',env:{DSH_ONBOARDING_ISOLATED_ROOT:root,DSH_HOME:root+'/home/.dsh',DSH_AGENTS_HOME:root+'/home/.agents',PATH:''},credentials};
 const config={role:'local',onboarding:{persistence:{enabled:true,isolatedRoot:root},installation:{enabled:false}}};
 const s=createOnboardingService({},config,runtime);try{assert.equal((await s.call('describe',{})).capabilities.existingSetupContract,1);assert.equal((await s.call('existing_setup_status',{})).revision,0);await assert.rejects(s.call('existing_setup_status',{secret:true}),/ARGUMENTS/);await assert.rejects(s.call('existing_setup_execute',{}),/METHOD_DENIED/);}finally{await s.dispose();}
 const disabled=createOnboardingService({}, {...config,onboarding:{}},runtime);try{assert.equal((await disabled.call('describe',{})).capabilities.existingSetupContract,0);await assert.rejects(disabled.call('existing_setup_status',{}),/UNAVAILABLE/);}finally{await disabled.dispose();}
});
