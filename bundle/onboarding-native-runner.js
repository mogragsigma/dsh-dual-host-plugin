// No credential in argv. The parent records kernel birth identity before releasing stdin.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
export function nativeRunPaths(root,runId){
 if(runId!==undefined&&!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(runId))throw Error('NATIVE_RUNNER_SCOPE');
 const control=path.join(root,'.control/runtime',...(runId?['restarts',runId]:[]));
 return {control,overlay:runId?path.join(control,'native-overlay.yml'):path.join(root,'runtime/native-overlay.yml')};
}
export function validateNativeRestartConsent(runId,launch){
 if(runId===undefined)return;
 const a=launch?.resumeAuthorization;
 if(a?.contract!==1||a.restartId!==runId||a.acknowledged!==true||!/^[a-f0-9]{64}$/.test(a.fingerprint??''))throw Error('NATIVE_RUNNER_RESTART_CONSENT');
}
export async function nativeRunner(){
 const root=process.argv[2];if(process.platform!=='linux'||!path.isAbsolute(root??'')||path.normalize(root)!==root||!/^host-[a-f0-9-]{36}$/.test(path.basename(root)))throw Error('NATIVE_RUNNER_SCOPE');
 const paths=nativeRunPaths(root,process.argv[3]);
 let input='';for await(const c of process.stdin){input+=c;if(input.length>4096)throw Error('NATIVE_RUNNER_INPUT');}
 const request=JSON.parse(input),launch=JSON.parse(await fs.readFile(path.join(paths.control,'native-launch.json')));
 const stat=await fs.readFile('/proc/self/stat','utf8'),start=stat.slice(stat.lastIndexOf(')')+2).split(' ')[19],boot=(await fs.readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();
 if(!launch.nonce||request.nonce!==launch.nonce||launch.process.pid!==process.pid||launch.process.start!==start||launch.process.boot!==boot)throw Error('NATIVE_RUNNER_IDENTITY');
 validateNativeRestartConsent(process.argv[3],launch);
 const cli=path.join(root,'runtime/node_modules/@deepseek-ai/dsh/lib/bin.js');
 process.argv=[process.execPath,cli,'--profile','web','--patch',paths.overlay,'--host','127.0.0.1','--port','0','--no-open'];
 const {runCli}=await import(pathToFileURL(cli));
 if(typeof runCli!=='function')throw Error('NATIVE_RUNNER_CLI_CONTRACT');
 await runCli();
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)await nativeRunner();
