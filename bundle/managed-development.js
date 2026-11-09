import {autonomous} from './managed-cloud-policy.js';
// Bounded, read-only observations around native tools. Never executes Git writes,
// disables hooks, manufactures a PR or treats model review as independent proof.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {realpathSync,readdirSync,lstatSync,openSync,fstatSync,readFileSync,closeSync,constants} from 'node:fs';
import {resolve,relative,isAbsolute} from 'node:path';
import {canonicalRemote,assertCliDestination} from './managed-development-contract.js';
import {compareText} from './delivery-preview.js';
const json=JSON.stringify,sha=x=>createHash('sha256').update(x).digest('hex');
const fail=s=>{throw Error('TASK_DEVELOPMENT_'+s);};
export function gitRead(cwd,args){try{return execFileSync('/usr/bin/git',['--no-optional-locks',...args],{cwd,encoding:'utf8',timeout:10000,maxBuffer:1048576,stdio:['ignore','pipe','pipe'],env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0',GIT_EXTERNAL_DIFF:'',GIT_PAGER:'cat'}}).trimEnd();}catch{fail('GIT_READ_UNAVAILABLE');}}
export function repositoryFacts(cwd){return {root:realpathSync(gitRead(cwd,['rev-parse','--show-toplevel'])),common:realpathSync(resolve(cwd,gitRead(cwd,['rev-parse','--git-common-dir']))),branch:gitRead(cwd,['symbolic-ref','--short','HEAD']),head:gitRead(cwd,['rev-parse','HEAD'])};}
export function snapshotFile(root,path,max=64*1024*1024){
 const full=resolve(root,path),rel=relative(root,full);if(!rel||rel==='..'||rel.startsWith('../')||isAbsolute(rel)||realpathSync(full)!==full)fail('ARTIFACT_PATH_UNSAFE');
 let fd;try{fd=openSync(full,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const s=fstatSync(fd);if(!s.isFile()||s.nlink!==1||s.size>max)fail('FILE_UNSAFE_OR_TOO_LARGE');const bytes=readFileSync(fd),end=fstatSync(fd),linked=lstatSync(full);if(realpathSync(full)!==full||linked.dev!==end.dev||linked.ino!==end.ino||end.size!==s.size||end.mtimeMs!==s.mtimeMs||bytes.length!==s.size||end.nlink!==1)fail('FILE_CHANGED');return {bytes,sha256:sha(bytes),size:bytes.length,mode:s.mode&0o111?1:0};}finally{if(fd!==undefined)closeSync(fd);}
}
export function treeSnapshot(cwd,{plain=false,artifacts=[]}={}){
 const facts=plain?{root:realpathSync(cwd),common:realpathSync(cwd),branch:null,head:null}:repositoryFacts(cwd);if(facts.root!==cwd)fail('REPOSITORY_ROOT_REQUIRED');
 let walked=0;const walk=(dir='')=>{if(++walked>5000||dir.split('/').length>64)fail('TREE_SCAN_LIMIT');return readdirSync(resolve(cwd,dir),{withFileTypes:true}).flatMap(e=>{if(['.git','node_modules'].includes(e.name))return [];const path=dir?dir+'/'+e.name:e.name;if(++walked>5000)fail('TREE_SCAN_LIMIT');return e.isDirectory()?walk(path):[path];});};
 const baseNames=plain?walk().sort():[...new Set(gitRead(cwd,['ls-files','-z','--cached','--others','--exclude-standard']).split('\0').filter(Boolean))].sort();const names=[...new Set([...baseNames,...artifacts])].sort(),files={},issues=[];let total=0;
 if(names.length>5000)fail('TREE_SCAN_LIMIT');
 for(const name of names){const path=resolve(cwd,name);let s;try{s=lstatSync(path);}catch(e){if(e.code==='ENOENT')continue;throw e;}
  if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1){issues.push({path:name,reason:'link_or_non_regular'});continue;}
  total+=s.size;if(total>64*1024*1024)fail('TREE_SCAN_LIMIT');const f=snapshotFile(cwd,name);files[name]={sha256:f.sha256,size:f.size,mode:f.mode};
 }
 return {...facts,files,issues,fingerprint:sha(json({files,issues})),dirty:plain?names.length>0:!!gitRead(cwd,['status','--porcelain','--untracked-files=all'])};
}
export function changedFiles(before,after){return [...new Set([...Object.keys(before.files),...Object.keys(after.files)])].sort().filter(p=>json(before.files[p])!==json(after.files[p])).map(path=>({path,kind:!before.files[path]?'added':!after.files[path]?'deleted':'modified',before:before.files[path]??null,after:after.files[path]??null}));}
export function repositoryResources(cwd,contract){const f=repositoryFacts(cwd);let remote=contract.remote;try{remote??=gitRead(cwd,['remote','get-url','--push','origin']);}catch{}return ['gitdir:'+f.common,...(remote?['repository:'+canonicalRemote(remote)]:[])];}
export class ManagedDevelopment {
 constructor(endpoint){this.e=endpoint;this.db=endpoint.db;this.db.exec(`CREATE TABLE IF NOT EXISTS managed_development_baselines(task_id TEXT NOT NULL,revision INTEGER NOT NULL,record TEXT NOT NULL,PRIMARY KEY(task_id,revision)); CREATE TABLE IF NOT EXISTS managed_development_checks(task_id TEXT NOT NULL,revision INTEGER NOT NULL,name TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(task_id,revision,name));`);}
 tree(b){return treeSnapshot(b.item.spec.cwd,{plain:!b.item.spec.development.branch,artifacts:b.item.spec.development.artifacts});}
 begin(b){if(!b.item.spec.development)return;const now=this.tree(b),d=b.item.spec.development;if(now.branch!==(d.branch??null))fail('BRANCH_CHANGED');
  const old=this.db.prepare('SELECT record FROM managed_development_baselines WHERE task_id=? AND revision=?').get(b.item.task_id,b.item.revision);
  if(this.e.g.c.role==='local'&&d.branch){const rel=relative(now.root,now.common);if(rel==='..'||rel.startsWith('../')||isAbsolute(rel))fail('LOCAL_GIT_SCOPE_DENIED');}
  if(old){b.developmentBaseline=JSON.parse(old.record);if(b.developmentBaseline.common!==now.common)fail('REPOSITORY_CHANGED');}
  else{b.developmentBaseline=now;this.db.prepare('INSERT INTO managed_development_baselines VALUES (?,?,?)').run(b.item.task_id,b.item.revision,json(now));}
 }
 before(b,exec,cwd){const d=b.item.spec.development;if(!d)return null;
  if(!autonomous(b.item.spec)&&exec.name==='bash'&&/\bgit\b[^\n;&|]*\b(?:commit|push)\b|\bgh\s+pr\s+create\b/.test(exec.arguments?.command??'')){
   assertCliDestination(exec.arguments.command,d);const current=this.tree(b);this.assertRepository(b,current);if(cwd!==current.root)fail('CLI_WORKDIR_CHANGED');
   // Scope-level controls, not a shell sandbox; arbitrary programs retain account permissions.
   if(/\bpush\b|\bgh\s+pr\s+create\b/.test(exec.arguments.command)){this.assertChecks(b,current);if(gitRead(current.root,['remote','get-url','--push','origin'])!==d.remote)fail('REMOTE_CHANGED');}
  }
  const command=exec.name==='bash'?exec.arguments?.command:exec.name==='managed_command'?exec.arguments?.name:null;
  // This exact stderr redirection preserves the contracted command's exit status.
  // No general shell normalization: pipelines, extra commands and wrappers differ.
  const check=d.checks.find(c=>c.command===command||(exec.name==='bash'&&command===c.command+' 2>&1'));if(!check||cwd!==b.item.spec.cwd)return null;
  const before=this.checkVersion(b,check,this.tree(b));this.saveCheck(b,check.name,{state:'running',fingerprint:before,at:this.e.g.now()});return {check,before};
 }
 after(b,token,result){if(!token)return;const after=this.checkVersion(b,token.check,this.tree(b)),v=result?.value??result,code=v?.exitCode??v?.exit_code,ok=!result?.isError&&code===0&&!v.timedOut&&!v.timed_out&&!v.aborted&&!v.signal;
  this.saveCheck(b,token.check.name,{state:ok&&after===token.before?'passed':ok?'changed_during_check':v?.kind==='background'||v?.kind==='promoted'?'running':typeof code==='number'?'failed':'unknown',exit_code:code??null,fingerprint:token.before,at:this.e.g.now()});
 }
 // Explicit relevant inputs bind the check to real bytes, not receipt/report
 // bookkeeping. No directory-wide output exclusion; omitted inputs remain conservative.
 checkVersion(b,check,current){
  if(!autonomous(b.item.spec)||!check.inputs)return current.fingerprint;
  return sha(json(check.inputs.map(path=>{const f=current.files[path];if(!f)fail('CHECK_INPUT_UNAVAILABLE');return [path,f];})));
 }
 saveCheck(b,name,record){record={...record,command:b.item.spec.development.checks.find(c=>c.name===name)?.command};this.db.prepare('INSERT OR REPLACE INTO managed_development_checks VALUES (?,?,?,?)').run(b.item.task_id,b.item.revision,name,json(record));}
 checks(b,current){return b.item.spec.development.checks.map(c=>{const r=this.db.prepare('SELECT record FROM managed_development_checks WHERE task_id=? AND revision=? AND name=?').get(b.item.task_id,b.item.revision,c.name),stored=r?JSON.parse(r.record):null,value=stored?.command===c.command?stored:{state:'not_run'},state=value.state==='passed'&&value.fingerprint!==this.checkVersion(b,c,current)?'stale':value.state;return {name:c.name,command:c.command,...value,state,...(state!=='passed'?{required_invocation:this.e.g.c.role==='local'?{tool:'managed_command',arguments:{name:c.command}}:{tool:'bash',arguments:{description:'Run named check: '+c.name,command:c.command,workdir:b.item.spec.cwd,run_in_background:false}}}:{})};});}
 assertRepository(b,current){if(current.common!==b.developmentBaseline.common||current.branch!==(b.item.spec.development.branch??null))fail('REPOSITORY_CHANGED');}
 assertChecks(b,current){this.assertRepository(b,current);if(current.issues.length&&!autonomous(b.item.spec))fail('TREE_INCOMPLETE');if(this.checks(b,current).some(c=>c.state!=='passed'))fail('CHECKS_NOT_CURRENT: read managed_evidence and copy each required_invocation. Pass cwd as bash workdir; do not prepend cd, append echo/exit-code printing, wrap or pipe the command. Wait for its foreground exit after all file changes, then retry ready. Do not repeat ready without fixing the check.');}
 inspect(b,{review,remote=false}={}){
  if(!b.item.spec.development)fail('CONTRACT_REQUIRED');const cwd=b.item.spec.cwd,current=this.tree(b);this.assertRepository(b,current);
  let patch='',patchTruncated=false;try{if(current.head){const raw=gitRead(cwd,['diff','--no-ext-diff','--no-textconv','--no-color','--unified=3',b.developmentBaseline.head,'--']);patch=raw.slice(0,32768);patchTruncated=raw.length>32768;}}catch{patchTruncated=true;}
  let diff;try{diff=current.head?gitRead(cwd,['diff','--no-ext-diff','--no-textconv','--stat',b.developmentBaseline.head,'--']):'普通文件任务，无 Git 差异';}catch{diff='差异统计读取失败';}
  const changes=changedFiles(b.developmentBaseline,current),details=changes.slice(0,16).map(c=>{if(c.kind!=='added'||current.issues.some(x=>x.path===c.path))return c;const bytes=snapshotFile(cwd,c.path,64*1024*1024).bytes;return {...c,preview:compareText(Buffer.alloc(0),bytes)};});
  const evidence={schema:1,at:this.e.g.now(),repository:{root:current.root,branch:current.branch,head:current.head,baseline_head:b.developmentBaseline.head},fingerprint:current.fingerprint,preexisting_changes:b.developmentBaseline.dirty,changes:details,truncated:changes.length>16||diff.length>12000||patchTruncated,git_diff:patch,git_diff_includes_preexisting:true,git_diff_stat:diff.slice(0,12000),tree_issues:current.issues,checks:this.checks(b,current),no_checks_reason:b.item.spec.development.no_checks_reason??null,review:review?{source:'worker_self_review',summary:review}:null,delivery:{mode:b.item.spec.development.delivery,state:'not_checked'},user_accepted:false,published:false,deployed:false};
  if(remote)evidence.delivery=this.delivery(b,current);return evidence;
 }
 delivery(b,current){const d=b.item.spec.development;this.assertChecks(b,current);
  if(d.delivery==='workspace')return {mode:d.delivery,state:'workspace_ready'};
  if(current.dirty||current.head===b.developmentBaseline.head)fail('COMMIT_NOT_VERIFIED');
  if(d.delivery==='commit')return {mode:d.delivery,state:'commit_verified',commit:current.head};
  // A readback can fail/timeout; never turns into another push or PR creation.
  const line=gitRead(current.root,['ls-remote','--exit-code',d.remote,'refs/heads/'+d.branch]);if(line.split(/\s+/)[0]!==current.head)fail('REMOTE_NOT_VERIFIED');
  if(d.delivery==='push')return {mode:d.delivery,state:'remote_commit_verified',commit:current.head};
  const repo=canonicalRemote(d.remote).replace('https://github.com/','');let pr;
  try{const raw=execFileSync('gh',['pr','view',d.branch,'--repo',repo,'--json','url,headRefName,headRefOid,baseRefName,state,isDraft'],{cwd:current.root,encoding:'utf8',timeout:15000,maxBuffer:32768,stdio:['ignore','pipe','pipe'],env:{...process.env,GH_PROMPT_DISABLED:'1'}});pr=JSON.parse(raw);}catch{fail('PR_READBACK_UNAVAILABLE');}
  if(pr.headRefName!==d.branch||pr.headRefOid!==current.head||pr.baseRefName!==d.base||pr.state!=='OPEN'||pr.isDraft!==false||typeof pr.url!=='string'||!pr.url.startsWith('https://github.com/'+repo+'/pull/')||!/\/pull\/\d+$/.test(pr.url))fail('PR_NOT_VERIFIED');
  return {mode:d.delivery,state:'pr_verified',commit:current.head,url:pr.url};
 }
 ready(b,review){if(!b.item.spec.development)return null;if(typeof review!=='string'||!review.trim()||review.length>2000)fail('REVIEW_REQUIRED');const current=this.tree(b);this.assertChecks(b,current);return this.inspect(b,{review,remote:true});}
}
