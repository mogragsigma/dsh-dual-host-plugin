// Pure command/credential metadata checks plus synthetic process reports. No SSH or Git execution.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,chmodSync,symlinkSync,rmSync,realpathSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {DeliverySSH,sshEnvironment,sshGitCommand} from '../bundle/delivery-ssh.js';
import {digest} from '../bundle/approval-ledger.js';
const b={schema:1,kind:'push-commit-v1',source_action_id:'delivery-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',source_intent_fingerprint:'a'.repeat(64),source_result_fingerprint:'b'.repeat(64),repository_id:101,url:'https://gitee.com/test-fixture/temporary',format:'sha1',branch:'dsh-task/unit',ref:'refs/heads/dsh-task/unit',commit_oid:'2'.repeat(40),parent_oid:'1'.repeat(40),tree_oid:'3'.repeat(40),manifest_sha256:'c'.repeat(64),tested_content:{kind:'file_sha256',sha256:'d'.repeat(64)},expected_remote_oid:'1'.repeat(40),max_pushes:1,rewrite:false,delete:false,tags:false,publish:false,deploy:false,grants_execution:false};
const plan={...b,fingerprint:digest(b)},binding={root:'/nonexistent/fixture',url:b.url,branch:b.branch,base_sha:b.parent_oid};
const identity=()=>({device:'1',inode:'2',size:'10',mtime:'1',ctime:'1'});
test('SSH environment pins identity, host trust and disables agents, proxy, hooks and inherited config',()=>{
 const env=sshEnvironment({keyFile:'/private/with quote\'s/key',knownHostsFile:'/private/known_hosts'});
 assert(!Object.hasOwn(env,'SSH_AUTH_SOCK'));assert(!Object.hasOwn(env,'HOME'));assert(env.GIT_SSH_COMMAND.includes("'\\''"));
 for(const s of ['StrictHostKeyChecking=yes','UpdateHostKeys=no','IdentityAgent=none','ForwardAgent=no','ProxyCommand=none','ControlPath=none','KnownHostsCommand=none','CertificateFile=none'])assert(env.GIT_SSH_COMMAND.includes(s));
 assert.equal(env.GIT_CONFIG_GLOBAL,'/dev/null');
 const args=sshGitCommand(binding,plan,'push');for(const s of ['core.hooksPath=/dev/null','protocol.allow=never','protocol.ssh.allow=always','credential.helper=','push.gpgSign=false'])assert(args.includes(s));
 assert.equal(args.at(-1),plan.commit_oid+':'+plan.ref);assert.throws(()=>sshGitCommand({...binding,url:'https://gitee.com/other/repo'},plan,'push'),/BINDING/);
});
test('transport disabled or wrong platform cannot reach process',async()=>{
 let calls=0;for(const [enabled,platform] of [[false,'linux'],[true,'darwin']]){
  const t=new DeliverySSH({binding,keyFile:'/key',knownHostsFile:'/hosts',enabled},{platform,fileIdentity:identity,run:()=>calls++});await assert.rejects(t.push(plan),/DISABLED|PLATFORM_UNSUPPORTED/);
 }assert.equal(calls,0);
});
test('read parses exact remote ref and forwards supervisor evidence only',async()=>{
 const events=[];const t=new DeliverySSH({binding,keyFile:'/key',knownHostsFile:'/hosts',enabled:true},{platform:'linux',fileIdentity:identity,run:async(args,o)=>{
  events.push('run');o.onSpawn?.({pid:12});o.onDrained?.({code:0,signal:null,reaped:2});return {drained:true,cause:null,code:0,signal:null,stdout:Buffer.from(plan.commit_oid+'\t'+plan.ref+'\n')};}});
 assert.equal(await t.read(plan,{beforeSpawn:()=>events.push('guard'),onDrained:()=>events.push('drain')}),plan.commit_oid);assert.deepEqual(events,['guard','run','drain']);
});
test('changed credential identity stops subsequent use; never refreshes silently',async()=>{
 let stamp=identity(),calls=0;const t=new DeliverySSH({binding,keyFile:'/key',knownHostsFile:'/hosts',enabled:true},{platform:'linux',fileIdentity:()=>stamp,run:async()=>{calls++;return {drained:true,cause:null,code:0,signal:null,stdout:Buffer.from('')};}});
 await t.push(plan);stamp={...stamp,inode:'3'};await assert.rejects(t.push(plan),/CREDENTIAL_CHANGED/);assert.equal(calls,1);
});
test('failed/unknown process output is sanitized and never retried',async()=>{
 let calls=0;const t=new DeliverySSH({binding,keyFile:'/key',knownHostsFile:'/hosts',enabled:true},{platform:'linux',fileIdentity:identity,run:async()=>{calls++;throw Error('secret raw stderr');}});
 await assert.rejects(t.push(plan),e=>e.message==='DELIVERY_SSH_OUTCOME_UNKNOWN');assert.equal(calls,1);
});
test('real credential-file metadata rejects public-readable keys and symbolic links without reading contents',async t=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'delivery-key-metadata-')));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const key=join(root,'key'),hosts=join(root,'hosts');writeFileSync(key,'synthetic key, not a credential',{mode:0o600});writeFileSync(hosts,'synthetic trust, no server',{mode:0o600});
 const transport=new DeliverySSH({binding,keyFile:key,knownHostsFile:hosts,enabled:true},{platform:'linux',run:async()=>({drained:true,cause:null,code:0,signal:null,stdout:Buffer.from('')})});
 await transport.push(plan);chmodSync(key,0o644);await assert.rejects(transport.push(plan),/CREDENTIAL_FILE/);chmodSync(key,0o600);
 const link=join(root,'link');symlinkSync(key,link);const linked=new DeliverySSH({binding,keyFile:link,knownHostsFile:hosts,enabled:true},{platform:'linux'});await assert.rejects(linked.push(plan),/CREDENTIAL_FILE/);
});
test('read-only provider identity validates canonical repository ID separately from branch existence',async()=>{
 const {GiteeReadOnly}=await import('../bundle/repository-gitee.js');let calls=0;
 const provider=new GiteeReadOnly({}, {fetch:async(url,o)=>{calls++;assert.equal(url,'https://gitee.com/api/v5/repos/test-fixture/temporary');assert.equal(o.method,'GET');assert.equal(o.redirect,'error');return new Response(JSON.stringify({id:101,full_name:'test-fixture/temporary',private:true}),{status:200});}});
 assert.deepEqual(await provider.identity(plan.url),{provider:'gitee',repository_id:101,url:plan.url,private:true});assert.equal(calls,1);
 provider.fetch=async()=>new Response(JSON.stringify({id:101,full_name:'other/temporary',private:true}),{status:200});await assert.rejects(provider.identity(plan.url),/IDENTITY_MISMATCH/);
});

test('fixed SSH transport passes only the journal-prepared descriptor to its supervisor',async()=>{
 const receipt={nonce:'b'.repeat(64)},events=[];
 const t=new DeliverySSH({binding,keyFile:'/key',knownHostsFile:'/hosts',enabled:true},{platform:'linux',fileIdentity:identity,run:async(_args,o)=>{
  assert.equal(o.receipt,receipt);events.push('supervise');return {drained:true,cause:null,code:0,signal:null,stdout:Buffer.from('')};}});
 await t.push(plan,{beforeSpawn:()=>{events.push('persist');return receipt;}});assert.deepEqual(events,['persist','supervise']);
});
