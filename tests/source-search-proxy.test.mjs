// Public native route contract; HTTP is mocked here. TLS/CONNECT lives in isolation acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {installProxyFromEnvironment,proxyRouteFor} from '@deepseek-ai/dsh-http-proxy';
import {createTaskSearchReader} from '../bundle/source-search.js';
const policy={provider:'deepseek-official',model:'fixture-search-model',reasoningEffort:'disabled'};
const endpoint=new URL('https://api.deepseek.com/anthropic/v1/messages');
const names=['http_proxy','HTTP_PROXY','https_proxy','HTTPS_PROXY','all_proxy','ALL_PROXY','no_proxy','NO_PROXY'];
for(const mode of ['direct','native-http','native-https','declared-only','socks','no-proxy-bypass'])test('search proxy contract: '+mode,async()=>{
 const saved=Object.fromEntries(names.map(k=>[k,process.env[k]])),fetch=globalThis.fetch;let dispose,resolutions=0,sends=0,records=0;
 for(const k of names)delete process.env[k];
 const vars=mode==='direct'?{}:{https_proxy:mode==='socks'?'socks5://127.0.0.1:32401':mode==='native-https'?'https://127.0.0.1:32401':'http://127.0.0.1:32401',...(mode==='no-proxy-bypass'?{no_proxy:'api.deepseek.com'}:{})};
 const denied=['declared-only','socks','no-proxy-bypass'].includes(mode);
 try{
  Object.assign(process.env,vars);
  if(mode!=='declared-only')dispose=await installProxyFromEnvironment({get:k=>vars[k]===undefined?undefined:{value:vars[k]}},()=>{});
  if(mode==='socks')assert.equal(process.env.https_proxy,vars.https_proxy); // Native direct policy retains the rejected declaration.
  assert.equal(proxyRouteFor(endpoint).proxied,mode.startsWith('native-'));
  globalThis.fetch=async(u,o)=>{sends++;assert.equal(records,sends);assert.equal(u,endpoint.href);assert.equal(o.redirect,'error');return new Response(JSON.stringify({content:[{type:'web_search_tool_result',content:[{type:'web_search_result',url:'https://fixture.invalid/',title:'fixture'}]}]}),{headers:{'Content-Type':'application/json'}});};
  const reader=await createTaskSearchReader({get:()=>({resolve:async()=>{resolutions++;return {value:'fixture-no-credential'};}})},{credentialRef:'FIXTURE_SEARCH_KEY'});
  const call=()=>reader.search('fixture query',policy,AbortSignal.timeout(1000),r=>{assert.equal(r.body.model,policy.model);assert.equal(r.body.tools[0].max_uses,1);records++;});
  if(denied){await assert.rejects(call(),/SOURCE_PROXY_UNSUPPORTED/);assert.equal(resolutions,0);assert.equal(sends,0);assert.equal(records,0);}
  else{await call();assert.equal(resolutions,1);assert.equal(sends,1);}
 }finally{globalThis.fetch=fetch;if(dispose)await dispose();for(const k of names){if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];}}
});
