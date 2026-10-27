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
