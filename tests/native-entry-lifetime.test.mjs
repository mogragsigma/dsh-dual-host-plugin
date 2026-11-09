import test from 'node:test';
import assert from 'node:assert/strict';
import {apply,inject} from '../bundle/native-entry.js';
import {inject as executionDependencies} from '../bundle/index.js';

test('native maintenance owner has no execution service lifetime dependency',()=>{
 assert.deepEqual(inject,[]);
 assert(executionDependencies.includes('llm'));
});
test('fresh cloud binds runtime separately from connection-only setup lifetime',async()=>{
 const scopes=[];await apply({inject:(dependencies,callback)=>scopes.push({dependencies,callback})},{onboarding:{role:'cloud'}});
 assert.equal(scopes.length,2);
 assert.deepEqual(scopes[0].dependencies,['credentials',...executionDependencies]);
 assert.deepEqual(scopes[1].dependencies,['connection']);
});
test('configured runtime waits on execution services without removing its independent recovery entry',async()=>{
 const scopes=[];await apply({inject:(dependencies,callback)=>scopes.push({dependencies,callback})},{role:'cloud',stateDir:'/not-opened-fixture',tokenFile:'/not-read-fixture'});
 assert.equal(scopes.length,2);
 assert.deepEqual(scopes[0].dependencies,['connection']);
 assert.deepEqual(scopes[1].dependencies,[...executionDependencies,'onboardingActivity']);
});
test('enabled managed endpoints declare native archive service on both execution entry paths',async()=>{
 for(const config of [{role:'cloud',stateDir:'/not-opened-fixture',tokenFile:'/not-read-fixture'},{onboarding:{role:'cloud'}}]){
  const scopes=[];await apply({inject:(dependencies,callback)=>scopes.push({dependencies,callback})},{...config,managedExecution:{enabled:true,endpoint:{lockPort:32523}}});
  const runtime=scopes.find(s=>s.dependencies.includes('llm'));
  assert(runtime.dependencies.includes('workspaceRegistry'));
  assert(!scopes.find(s=>s.dependencies.includes('connection')).dependencies.includes('workspaceRegistry'));
 }
});
test('managed coordinator without endpoint does not acquire the native archive lifetime',async()=>{
 const scopes=[];await apply({inject:(dependencies,callback)=>scopes.push({dependencies,callback})},{role:'cloud',stateDir:'/not-opened-fixture',tokenFile:'/not-read-fixture',managedExecution:{enabled:true}});
 assert(scopes.every(s=>!s.dependencies.includes('workspaceRegistry')));
});
test('retired local managed endpoint never makes ordinary local entry depend on sandbox',async()=>{
 for(const [role,managedExecution,expected] of [
  ['local',{enabled:true,endpoint:{lockPort:32512}},false],
  ['cloud',{enabled:true,endpoint:{lockPort:32523}},false],
  ['local',{enabled:false,endpoint:{lockPort:32512}},false],
  ['local',{enabled:true},false],
 ]){
  const scopes=[];await apply({inject:(dependencies,callback)=>scopes.push({dependencies,callback})},{role,stateDir:'/not-opened-fixture',tokenFile:'/not-read-fixture',managedExecution});
  assert.equal(scopes.find(s=>s.dependencies.includes('llm')).dependencies.includes('sandbox'),expected);
  assert(!scopes.find(s=>s.dependencies.includes('connection')).dependencies.includes('sandbox'));
 }
});
