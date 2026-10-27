import test from 'node:test';
import assert from 'node:assert/strict';
import {observeStream} from '../scripts/s37-stream-observer.mjs';
async function run(parts){const r={},input=async function*(){yield* parts;};for await(const _ of observeStream(input(),r)){}return r;}
test('normally ended iterator with provider HTTP 400 is not a successful model call',async()=>{
 const r=await run([{type:'finish',reason:{kind:'error',failure:{code:'INVALID_REQUEST',status:400,message:'secret data excluded'}}}]);
 assert.equal(r.iterationEnded,true);assert.equal(r.modelSucceeded,false);assert.equal(r.http_status,400);assert.equal(r.error_code,'INVALID_REQUEST');assert(!JSON.stringify(r).includes('secret'));
});
test('normal stop and tool calls succeed; truncated, unknown and missing finish do not',async()=>{
 for(const kind of ['stop','tool-calls','max-tokens','unknown','aborted'])assert.equal((await run([{type:'finish',reason:{kind}}])).modelSucceeded,['stop','tool-calls'].includes(kind));
 assert.equal((await run([{type:'text-delta',text:'data'}])).modelSucceeded,false);
});
test('thrown transport failures retain metadata without leaking error text',async()=>{
 const r={};let saves=0;async function* bad(){throw Object.assign(Error('private token'),{code:'INVALID_CREDENTIAL'});}
 await assert.rejects(async()=>{for await(const _ of observeStream(bad(),r,()=>saves++)){};});
 assert.equal(r.iterationEnded,false);assert.equal(r.modelSucceeded,false);assert.equal(r.error_code,'INVALID_CREDENTIAL');assert.equal(saves,1);assert(!JSON.stringify(r).includes('private'));
});
