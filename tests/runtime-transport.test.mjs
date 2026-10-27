import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {brotliDecompressSync} from 'node:zlib';
import {RUNTIME_COMMAND_LIMIT,runtimeProgram,runtimeAbsenceProgram,runtimeCommand} from '../bundle/onboarding-runtime-program.js';
import {runProcess} from '../bundle/onboarding-ssh.js';
const controller=await fs.readFile(new URL('../bundle/onboarding-remote-control.js',import.meta.url),'utf8');
const extension=await fs.readFile(new URL('../bundle/onboarding-runtime-extension.js',import.meta.url),'utf8');
const bridge=await fs.readFile(new URL('../bundle/onboarding-handoff-remote.js',import.meta.url),'utf8');
test('current full archived program fits bounded SSH argv and decodes byte-for-byte',()=>{
 const source=runtimeProgram(controller,extension),command=runtimeCommand(process.execPath,source,'runtimeCLI');
 assert(Buffer.byteLength(command)<=RUNTIME_COMMAND_LIMIT);assert(Buffer.byteLength(source)>100000);
 const encoded=command.match(/Buffer\.from\("([A-Za-z0-9+/=]+)",/)[1];
 assert.equal(brotliDecompressSync(Buffer.from(encoded,'base64')).toString(),source);
 assert(!command.includes('proof'));assert(!command.includes('writeFile'));
});
test('full notification/file-review bridge fits 24 KiB SSH bound with byte-exact decoding',()=>{
 const source=runtimeProgram(controller,extension)+'\n'+bridge,command=runtimeCommand(process.execPath,source,'handoffCLI');
 assert(Buffer.byteLength(command)<=RUNTIME_COMMAND_LIMIT);
 const encoded=command.match(/Buffer\.from\("([A-Za-z0-9+/=]+)",/)[1];
 assert.equal(brotliDecompressSync(Buffer.from(encoded,'base64')).toString(),source);
});
test('real compressed module preserves stdin JSON, Unicode and punctuation without staging files',{skip:process.platform==='win32'},async()=>{
 const source=`export async function runtimeCLI(){let input='';for await(const part of process.stdin)input+=part;console.log(JSON.stringify({value:JSON.parse(input),module:import.meta.url.startsWith('data:')}));}`;
 const value={message:"原归档 ' \\"+'\n',proof:randomBytes(32).toString('hex')};
 const command=runtimeCommand(process.execPath,source,'runtimeCLI');assert(!command.includes(value.proof));
 const result=JSON.parse(await runProcess('/bin/sh',['-c',command],{input:JSON.stringify(value),env:{PATH:'/usr/bin:/bin'}}));
 assert.deepEqual(result,{value,module:true});
});
test('real archived runtime and absence entrypoints reject malformed input through compressed transport',{skip:process.platform==='win32'},async()=>{
 for(const [source,entry] of [[runtimeProgram(controller,extension),'runtimeCLI'],[runtimeAbsenceProgram(controller),'runtimeAbsenceCLI']]){
  const raw=await runProcess('/bin/sh',['-c',runtimeCommand(process.execPath,source,entry)],{input:'{}',env:{PATH:'/usr/bin:/bin'}});
  const result=JSON.parse(raw);assert.equal(result.ok,false);assert.match(result.error,/^ONBOARDING_CLOUD_/);
 }
});
test('invalid entrypoints and oversized sources/commands fail before SSH',()=>{
 assert.throws(()=>runtimeCommand('/node','',"runtimeCLI();evil()"),/PROGRAM_REVIEW/);
 assert.throws(()=>runtimeCommand('/node\n','',"runtimeCLI"),/PROGRAM_REVIEW/);
 assert.throws(()=>runtimeCommand('/node','字'.repeat(70000),'runtimeCLI'),/PROGRAM_REVIEW/);
 assert.throws(()=>runtimeCommand('/node',randomBytes(40000).toString('hex'),'runtimeCLI'),/TRANSPORT_LIMIT/);
});
