import test from 'node:test';import assert from 'node:assert/strict';
import {FeishuApprovalSource} from '../bundle/approval-feishu.js';
const c={provider:'feishu',appId:'cli_fixture1234',botOpenId:'ou_bot1234',chatId:'oc_chat1234',approverOpenId:'ou_user1234',appSecretEnv:'FIXTURE_SECRET_REF'};
test('official credential ref is local read-only, refreshed per operation and never falls back after revocation',async()=>{
 let secret='fixture-one',reads=0,auths=0;
 const source=new FeishuApprovalSource(c,{env:{FIXTURE_SECRET_REF:'must-not-fallback'},credentials:{async resolve(ref){reads++;assert.equal(ref,c.appSecretEnv);return secret?{value:secret,source:'file'}:undefined;}},fetcher:async(_url,args)=>{auths++;assert.equal(JSON.parse(args.body).app_secret,secret);return Response.json({code:0,tenant_access_token:'fixture-token-'+auths,expire:7200});}});
 assert.equal(await source.auth(),'fixture-token-1');assert.equal(await source.auth(),'fixture-token-1');assert.equal(auths,1);assert.equal(reads,2);
 secret='fixture-two';assert.equal(await source.auth(),'fixture-token-2');assert.equal(auths,2);
 secret=null;await assert.rejects(source.auth(),/CHAT_APPROVAL_CREDENTIAL_UNAVAILABLE/);assert.equal(source.token,null);assert.equal(source.secret,null);assert.equal(auths,2);
});
test('provider failure stays redacted and cannot use ambient credentials',async()=>{
 const source=new FeishuApprovalSource(c,{env:{FIXTURE_SECRET_REF:'ambient'},credentials:{resolve:async()=>{throw Error('private-secret-value')}},fetcher:()=>{assert.fail('network forbidden')}});
 await assert.rejects(source.auth(),e=>e.message==='CHAT_APPROVAL_CREDENTIAL_UNAVAILABLE');
});
