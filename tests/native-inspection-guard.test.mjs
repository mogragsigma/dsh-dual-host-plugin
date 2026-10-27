import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import {createNativeInspectionGuard,inspectionSessionIds} from '../bundle/onboarding-inspection-guard.js';
function fixture(){let handler,removed=0;const nonce=randomUUID();const guard=createNativeInspectionGuard({on(event,fn,options){assert.equal(event,'agent/request');assert.equal(options.prepend,true);handler=fn;return ()=>removed++;}},nonce);return {nonce,guard,call:(agent,next)=>handler({agent},next),removed:()=>removed};}
test('guard blocks only four exact inspection identifiers before request configuration',async()=>{
 const f=fixture();for(const id of inspectionSessionIds(f.nonce))await assert.rejects(f.call({id},()=>assert.fail('inspection delegated')),/NATIVE_ADMISSION_NO_MODEL/);
 assert.equal(f.guard.attempts,4);assert.equal(f.guard.scope,'inspection_agents_only');f.guard.dispose();assert.equal(f.removed(),1);
});
test('unrelated native requests preserve result identity and error without retry',async()=>{
 const f=fixture(),result={provider:'configured',model:'native-user-choice'};let calls=0;
 for(const id of ['ordinary-native',...inspectionSessionIds(randomUUID()),inspectionSessionIds(f.nonce)[0]+'-extra'])assert.equal(await f.call({id},()=>{calls++;return result;}),result);
 const error=Error('native upstream error');await assert.rejects(f.call({id:'ordinary-native'},()=>{calls++;throw error;}),e=>e===error);assert.equal(calls,7);assert.equal(f.guard.attempts,0);f.guard.dispose();
});
test('guard teardown is idempotent and a retained callback no longer rejects inspection IDs',async()=>{
 const f=fixture();f.guard.dispose();f.guard.dispose();assert.equal(f.removed(),1);assert.equal(await f.call({id:inspectionSessionIds(f.nonce)[0]},()=>42),42);assert.equal(f.guard.attempts,0);
});
test('invalid inspection nonce is rejected before listener registration',()=>{
 for(const nonce of ['',undefined,'../all','onboarding-check-','a'.repeat(36)])assert.throws(()=>createNativeInspectionGuard({on(){assert.fail('registered')}},nonce),/NATIVE_INSPECTION_NONCE/);
});
test('actual native probe uses scoped request guard and explicitly scopes receipt counts',async()=>{
 const source=await fs.readFile(new URL('../bundle/onboarding-native-probe.js',import.meta.url),'utf8');assert(!source.includes("ctx.on('llm/stream'"));assert(source.includes('createNativeInspectionGuard(ctx,c.nonce)'));assert(source.includes('finally{guard.dispose();}'));assert(source.includes('modelAttemptScope:guard.scope'));
 const host=await fs.readFile(new URL('../bundle/onboarding-native-host.js',import.meta.url),'utf8');assert(host.includes("receipt.modelAttemptScope!=='inspection_agents_only'"));
});
