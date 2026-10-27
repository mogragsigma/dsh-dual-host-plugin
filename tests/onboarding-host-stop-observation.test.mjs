import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {observeRuntimeHost} from '../bundle/onboarding-host-stop-observation.js';
import {observationServer,regular} from './helpers/host-stop-fixture.mjs';
async function fixture(t){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'host-stop-observe-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));const j={host:{pid:123},optionalIm:false};
 const server=await observationServer(t,root,j),api={regular,runtimeAlive:async()=>true,runtimeSource:async()=>({owner:{manifest:[]}}),checkAncestors:async()=>{},fail:c=>{throw Error('ONBOARDING_CLOUD_'+c);}};
 return {root,j,api,...server,call:()=>observeRuntimeHost(api,{root},j)};
}
test('managed idle snapshot uses only public read RPC and omits token/cookie',async t=>{const f=await fixture(t),v=await f.call();assert(v.idle&&!v.ingressFrozen&&!v.imInFlightVerified);assert.deepEqual(f.calls,['coordinated_hold_status','onboarding_hold_status','agent_hold_status']);assert(!JSON.stringify(v).includes('isolated'));});
for(const kind of ['running','pendingNextTurn','pendingNextStep','inboxUnknown','unsupported'])test('native '+kind+' blocks stop readiness',async t=>{const f=await fixture(t);f.rows.agent_hold_status.counts[kind]=1;const v=await f.call();assert(!v.idle);assert(v.reasons.includes('native_work_active_or_unknown'));});
test('own model or proxy activity cannot be mistaken for idle',async t=>{const f=await fixture(t);f.rows.onboarding_hold_status.counts.model_attempt=1;assert(!(await f.call()).idle);});
test('negative or missing counts are unknown, never idle',async t=>{const f=await fixture(t);f.rows.agent_hold_status.counts.running=-1;await assert.rejects(f.call(),/RESPONSE_REVIEW/);delete f.rows.agent_hold_status.counts.running;await assert.rejects(f.call(),/RESPONSE_REVIEW/);});
test('an unavailable expected gateway blocks idle observation',async t=>{const f=await fixture(t);f.rows.coordinated_hold_status.components.gateway={state:'unavailable'};await assert.rejects(f.call(),/RESPONSE_REVIEW/);});
test('IM inventory or maintenance uncertainty blocks without disconnecting a bot',async t=>{const f=await fixture(t);f.j.optionalIm=true;f.rows.im_maintenance_status.pending=true;assert(!(await f.call()).idle);f.rows.im_maintenance_status.inventoryState='unavailable';await assert.rejects(f.call(),/RESPONSE_REVIEW/);assert(f.calls.every(x=>x.endsWith('_status')));});
test('component replacement, wrong RPC id and failed auth reject observation',async t=>{const f=await fixture(t);f.rows.agent_hold_status.instanceId='replaced';await assert.rejects(f.call(),/RESPONSE_REVIEW/);f.settings.wrongId=true;await assert.rejects(f.call(),/RESPONSE_REVIEW/);f.settings.auth=false;await assert.rejects(f.call(),/AUTH_FAILED/);});
test('login address is fixed to the managed loopback origin',async t=>{const f=await fixture(t);await fs.writeFile(f.access,JSON.stringify({url:'https://example.invalid/?token=DO_NOT_SEND'}));await assert.rejects(f.call(),/ACCESS_REVIEW/);assert.equal(f.calls.length,0);});
test('absent original birth identity refuses before authenticating',async t=>{const f=await fixture(t);f.api.runtimeAlive=async()=>false;await assert.rejects(f.call(),/OBSERVATION_REQUIRED/);assert.equal(f.calls.length,0);});
test('observation consults authoritative effective image instead of initial package bytes',async t=>{const f=await fixture(t);f.api.runtimeSource=async()=>({owner:{manifest:[{path:'plugin/old-not-current'}]}});let verified=0;f.api.runtimeVerifyPlugin=async(q,j)=>{assert.equal(q.root,f.root);assert.equal(j,f.j);verified++;};assert((await f.call()).idle);assert.equal(verified,1);});
test('failed effective-image verification prevents all authentication and RPC',async t=>{const f=await fixture(t);f.api.runtimeVerifyPlugin=async()=>{throw Error('ONBOARDING_CLOUD_RUNTIME_HOST_SOURCE_CHANGED');};await assert.rejects(f.call(),/SOURCE_CHANGED/);assert.equal(f.calls.length,0);});
