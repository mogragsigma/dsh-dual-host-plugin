import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../ui-source/workbench-client.js',import.meta.url),'utf8');
const body=source.slice(source.indexOf(' function managedBrowserEntry('),source.indexOf(' function apply(ctx){'));
const choose=vm.runInNewContext(body+';managedBrowserEntry',{URL});
const result={entryId:'f94219fe-aa09-4625-925e-a10d9b1de557',url:'http://127.0.0.1:23456/?workbench_ticket=once#dsh-worker=task-worker-f94219fe-aa09-4625-925e-a10d9b1de557'};
test('explicit local Web click can use verified one-use entry without a native browser plugin',()=>assert.equal(choose(result,{protocol:'http:',hostname:'127.0.0.1'}),result.url));
for(const page of [{protocol:'dsh-app:',hostname:'app'},{protocol:'file:',hostname:''},{protocol:'https:',hostname:'external.invalid'}])test('no fallback for '+page.protocol+' '+page.hostname,()=>assert.equal(choose(result,page),null));
for(const patch of [{entryId:undefined},{url:'https://evil.invalid/?workbench_ticket=x'},{url:'http://127.0.0.1:23456/?token=secret'},{url:'http://u:p@127.0.0.1:23456/?workbench_ticket=x'},{url:'http://127.0.0.1:23456/?workbench_ticket=x&token=y'},{url:'http://127.0.0.1:23456/?workbench_ticket=x#other'}])test('reject invalid managed browser entry '+JSON.stringify(patch),()=>assert.equal(choose({...result,...patch},{protocol:'http:',hostname:'127.0.0.1'}),null));
test('readonly worker contract4 appears in fresh cloud guide and browser fallback is narrow',()=>{assert(source.includes('[2,3,4].includes(x.capabilities?.managedTaskRuntimeContract)'));assert(source.includes("location.assign(webEntry)"));assert(source.includes('right.openTab'));assert(!source.includes('window.open(result.url'));});

test('localhost Web remains same-site without weakening native cross-site policy',()=>{const local={...result,url:result.url.replace('127.0.0.1','localhost')};assert.equal(choose(local,{protocol:'http:',hostname:'localhost'}),local.url);assert.equal(choose(result,{protocol:'http:',hostname:'localhost'}),null);});
