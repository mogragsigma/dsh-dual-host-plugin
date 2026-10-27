import test from 'node:test';
import assert from 'node:assert/strict';
import {fileScopeObservation} from '../ui-source/onboarding/file-scope-presentation.js';
import {cloudFileStatus} from '../bundle/onboarding-file-contract.js';

const runtimeId='11111111-1111-4111-8111-111111111111',root='/test/runtime/'+runtimeId;
function status(){return {contract:2,available:true,scope:'current_managed_host_only',scopeHash:'a'.repeat(64),role:'cloud',runtimeId,namespace:'managed-'+runtimeId,revision:4,appliedOperation:'22222222-2222-4222-8222-222222222222',appliedPlanHash:'b'.repeat(64),enabled:true,active:true,state:'active',sendRoots:[root+'/files/outbox','/test/workspace/.dsh-im/inbound'],receiveRoot:root+'/files/inbox',maxBytes:2097152,limits:{maxBytes:2097152,queueEntries:64,chunkBytes:49152,automaticDeletion:false},counts:{outgoing:0,incoming:0,broker:0},error:null,imTemporaryRootsIncluded:false,repositoryWriteAuthorized:false,executionAuthorized:false,automaticDeletion:false};}

test('v2 accepts explicit ordinary IM root without changing the legacy exact wire contract',()=>{
 const s=status();assert.equal(cloudFileStatus(s),s);
 const v=fileScopeObservation(s,{cloud:true,freshness:'remote_checked'});
 assert.deepEqual(v.roots,s.sendRoots);assert(v.roots.includes('/test/workspace/.dsh-im/inbound'));
 assert.throws(()=>cloudFileStatus({...s,imTemporaryRootsIncluded:true}),/RESPONSE_REVIEW/);
 assert.throws(()=>cloudFileStatus({...s,scopeSummary:'new field'}),/RESPONSE_REVIEW/);
});
test('presentation never uses legacy flag as inclusion or exclusion evidence',()=>{
 const s=status(),v=fileScopeObservation(s);assert.deepEqual(v,fileScopeObservation({...s,imTemporaryRootsIncluded:true}));
 const {imTemporaryRootsIncluded,...without}=s;assert.deepEqual(v,fileScopeObservation(without));
});
test('display owns a copy and never changes recorded roots while editing a draft',()=>{
 const s=status(),v=fileScopeObservation(s),draft=['/another/draft'];
 assert.notEqual(v.roots,s.sendRoots);draft.push('/extra');v.roots.push('/display-only');
 assert.equal(s.sendRoots.length,2);assert(!s.sendRoots.includes('/display-only'));
});
test('unconfigured defaults are not promoted to a grant',()=>{
 const v=fileScopeObservation({...status(),scopeHash:null,revision:0,enabled:false,active:false});
 assert.match(v.title,/尚未授权/);assert.match(v.note,/尚未获得/);
});
test('uncertain operation never presents last roots as current authority',()=>{
 const v=fileScopeObservation(status(),{uncertain:true});assert.match(v.note,/历史目录不能证明/);
});
test('remote cached and missing freshness are explicitly historical',()=>{
 for(const freshness of [undefined,'cached','check_failed'])assert.match(fileScopeObservation(status(),{cloud:true,freshness}).note,/历史目录不能证明/);
 assert.match(fileScopeObservation(status(),{cloud:true,freshness:'remote_checked'}).note,/本次查询/);
});
test('disabled and needs-review grants keep visible roots without declaring sendability',()=>{
 for(const state of ['disabled','needs_review']){
  const v=fileScopeObservation({...status(),state,enabled:false,active:false});assert.equal(v.roots.length,2);assert.match(v.note,/启用状态、文件和目标端校验/);
 }
});
test('missing or unavailable inventory produces no inferred directory list',()=>{
 for(const s of [null,undefined,{available:false},{available:true},{}])assert.equal(fileScopeObservation(s),null);
});
