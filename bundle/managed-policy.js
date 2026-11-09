// Task policy is not an OS sandbox. These guards catch explicit high-risk
// requests; arbitrary shell programs still run with the cloud account's rights.
import {homedir} from 'node:os';
import {resolve,relative,isAbsolute,dirname,basename} from 'node:path';
import {realpathSync} from 'node:fs';
const fail=s=>{throw Error('TASK_EXECUTION_'+s);};
export const under=(root,path)=>{const rel=relative(root,path);return rel===''||rel!=='..'&&!rel.startsWith('../')&&!isAbsolute(rel);};
const physical=p=>{p=resolve(p);try{return realpathSync(p);}catch(e){if(e.code!=='ENOENT'&&e.code!=='ENOTDIR')throw e;const parent=dirname(p);return parent===p?p:resolve(physical(parent),basename(p));}};
export function assertExplicitRisk(exec,cwd,{stateDir,protectedRoots=[],development,role='cloud'}={}){
 const roots=[stateDir,process.env.DSH_HOME,resolve(homedir(),'.ssh'),resolve(homedir(),'.aws'),...protectedRoots].filter(Boolean).map(physical);
 const arg=exec.arguments??{},path=arg.file_path??arg.path;
 if(typeof path==='string'&&roots.some(root=>under(root,physical(resolve(cwd,path)))))fail('PROTECTED_DATA');
 if(exec.name==='bash'){
  const command=arg.command;if(typeof command!=='string')fail('COMMAND_INVALID');
  if(/\b(?:sudo|su|systemctl|launchctl|shutdown|reboot|mkfs(?:\.\w+)?|fdisk|parted)\b|\brm\s+[^\n;&|]*-[\w]*[rR]|\bgit\b[^\n;&|]*\b(?:reset|clean|rebase|merge)\b|\bgit\b[^\n;&|]*(?:--force|--mirror|--delete|--amend|\s-[a-zA-Z]*f(?:\s|$))|\bgit\s+(?:branch\s+-[dD]|tag\s+-d)|\b(?:npm|pnpm|yarn)\s+publish\b|\b(?:gh|glab)\s+(?:(?:pr|mr)\s+(?:merge|close)|release\s+create)\b|\b(?:kubectl|terraform)\b[^\n;&|]*\b(?:apply|destroy|delete)\b/.test(command))fail('HIGH_RISK_REVIEW_REQUIRED');
  const mode=role==='cloud'?development?.delivery:null;
  if(/\bgit\b[^\n;&|]*\bcommit\b/.test(command)&&!['commit','push','pr'].includes(mode)||/\bgit\b[^\n;&|]*\bpush\b/.test(command)&&!['push','pr'].includes(mode)||/\b(?:gh|glab)\s+(?:pr|mr)\s+create\b/.test(command)&&mode!=='pr')fail('HIGH_RISK_REVIEW_REQUIRED');
  if(roots.some(p=>command.includes(p))||/(?:~\/|\$HOME\/)(?:\.ssh|\.aws|\.dsh)(?:[\/\s]|$)/.test(command))fail('PROTECTED_DATA');
 }
}
