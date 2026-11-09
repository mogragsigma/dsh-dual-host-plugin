import test from 'node:test';
import assert from 'node:assert/strict';
import {assertExplicitRisk,under} from '../bundle/managed-policy.js';
test('cloud normal cross-directory paths/commands are not per-task sandboxed',()=>{
 assert.doesNotThrow(()=>assertExplicitRisk({name:'write',arguments:{file_path:'/tmp/another-project/result.txt'}},'/tmp/task',{stateDir:'/tmp/plugin-state'}));
 assert.doesNotThrow(()=>assertExplicitRisk({name:'bash',arguments:{command:'node test.mjs && git diff --stat'}},'/tmp/task'));
});
test('explicit high-risk operations require separate reviewed authority',()=>{
 for(const command of ['sudo true','systemctl restart service','rm -rf /tmp/data','git -C repo push origin main','git commit -am x','npm publish','gh pr create','terraform destroy'])assert.throws(()=>assertExplicitRisk({name:'bash',arguments:{command}},'/tmp/task'),/HIGH_RISK_REVIEW_REQUIRED/);
});
test('direct state and credential accesses are blocked, not all cloud directories',()=>{
 assert.throws(()=>assertExplicitRisk({name:'read',arguments:{file_path:'/tmp/plugin-state/token'}},'/tmp/task',{stateDir:'/tmp/plugin-state'}),/PROTECTED_DATA/);
 assert.throws(()=>assertExplicitRisk({name:'bash',arguments:{command:'cat ~/.ssh/id_rsa'}},'/tmp/task'),/PROTECTED_DATA/);
 assert.equal(under('/tmp/root','/tmp/root2/file'),false);assert.equal(under('/tmp/root','/tmp/root/..notes'),true);
});
import {validateManagedConfig} from '../bundle/managed-endpoint.js';
test('execution configuration rejects widened flags and malformed endpoint bounds',()=>{
 assert.doesNotThrow(()=>validateManagedConfig(undefined));assert.doesNotThrow(()=>validateManagedConfig({enabled:false}));
 for(const c of [{enabled:'true'},{enabled:true,unrestrictedLocal:true},{enabled:false,endpoint:{lockPort:31562}},{enabled:true,endpoint:{lockPort:1}},{enabled:true,endpoint:{lockPort:31562,intervalMs:0}},{enabled:true,endpoint:{lockPort:31562,protectedRoots:['relative']}}])assert.throws(()=>validateManagedConfig(c),/CONFIG_INVALID/);
});
