import {createHash} from 'node:crypto';
import {brotliCompressSync,constants} from 'node:zlib';
import {shellQuote} from './onboarding-ssh.js';
export const RUNTIME_COMMAND_LIMIT=24*1024; // Encoded SSH command, independently bounded from the 200 KB source.
const hash=x=>createHash('sha256').update(x).digest('hex');
// Transport the exact archived bytes, not a replacement controller. Compression
// keeps the SSH argument bounded without remote staging files or consuming stdin.
export function runtimeCommand(node,program,entry){
 if(typeof node!=='string'||!node.startsWith('/')||/[\x00-\x1f\x7f]/.test(node)||typeof program!=='string'||Buffer.byteLength(program)>200000||!['runtimeCLI','runtimeVersionCLI','runtimeAbsenceCLI','handoffCLI'].includes(entry))throw Error('ONBOARDING_CLOUD_RUNTIME_PROGRAM_REVIEW');
 const packed=brotliCompressSync(Buffer.from(program),{params:{[constants.BROTLI_PARAM_QUALITY]:11}}).toString('base64');
 const loader=`import{brotliDecompressSync as d}from"node:zlib";await(await import("data:text/javascript;base64,"+d(Buffer.from("${packed}","base64"),{maxOutputLength:200000}).toString("base64"))).${entry}();`;
 const command=shellQuote(node)+' --input-type=module -e '+shellQuote(loader);
 if(Buffer.byteLength(command)>RUNTIME_COMMAND_LIMIT)throw Error('ONBOARDING_CLOUD_RUNTIME_TRANSPORT_LIMIT');
 return command;
}
// Extend the archived, audited source controller; never run a newer controller over old ownership.
export function runtimeProgram(controller,extension){
 if(hash(controller)!=='369c4e445133e0538c434cc090ca4ee3980c89a9b29354d403232e4638166309'||typeof extension!=='string'||extension.length>50000)throw Error('ONBOARDING_CLOUD_RUNTIME_PROGRAM_REVIEW');
 const worker=controller+'\n'+extension+'\nawait runtimeWorkerCLI();';
 return controller+'\nconst RUNTIME_SOURCE='+JSON.stringify(worker)+';\n'+extension;
}
// Read-only reconciliation after an acknowledged, terminal installer and a requested rollback.
// Absence alone is insufficient: retain the last worker/child birth identities in the local ledger.
export function runtimeAbsenceProgram(controller){
 if(hash(controller)!=='369c4e445133e0538c434cc090ca4ee3980c89a9b29354d403232e4638166309')throw Error('ONBOARDING_CLOUD_RUNTIME_PROGRAM_REVIEW');
 return controller+String.raw`
export async function runtimeAbsenceCLI(){
 try{
  let input='';for await(const c of process.stdin){input+=c;if(Buffer.byteLength(input)>32768)fail('INPUT_LIMIT');}const q=JSON.parse(input);
  if(!exact(q,['root','operationId','installationId','proof','planHash','prior']))fail('ARGUMENTS');
  if(process.platform!=='linux')fail('RUNTIME_PLATFORM_UNSUPPORTED');
  const p=q.prior;if(!p||p.operationId!==q.operationId||!uuid(p.runtimeId)||!['runtime_ready','host_stopped','failed','stopped'].includes(p.state)||p.workerActive!==false||p.childActive!==false||!Number.isSafeInteger(p.inventoryCount)||p.inventoryCount<1||!p.worker||!p.child||p.host&&p.hostActive!==false)fail('RUNTIME_ABSENCE_REVIEW');
  const s=await load(q);if(s.state!=='prepared'||s.active)fail('RUNTIME_SOURCE_NOT_READY');
  for(const member of [p.worker,p.child,...(p.host?[p.host]:[])]){
   if(member.platform!=='linux'||typeof member.boot!=='string'||typeof member.start!=='string'||!Number.isSafeInteger(member.pid)||member.pid<1)fail('RUNTIME_ABSENCE_REVIEW');
   if(await processActive(member)){const st=await fs.readFile('/proc/'+member.pid+'/stat','utf8');if(!['Z','X'].includes(st.slice(st.lastIndexOf(')')+2).split(' ')[0]))fail('RUNTIME_PROCESS_ACTIVE');}
  }
  for(const member of ['runtime','.control/runtime','.control/runtime-cleanup-plan.json','.control/runtime-cleanup.json']){const name=path.join(q.root,member);await checkAncestors(path.dirname(name));if(await stat(name))fail('RUNTIME_NOT_ABSENT');}
  console.log(JSON.stringify({ok:true,value:{state:'rolled_back',operationId:q.operationId,runtimeId:p.runtimeId,initialization:false,hostStarted:false,runtimeInstalled:false,reconciledAfterLostReceipt:true,installerProcessesEnded:true}}));
 }catch(e){console.log(JSON.stringify({ok:false,error:/^ONBOARDING_CLOUD_[A-Z_]+$/.test(e.message)?e.message:'ONBOARDING_CLOUD_RUNTIME_ABSENCE_REVIEW'}));}
}`;
}
