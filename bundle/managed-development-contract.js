// Task-level agreement only. Native CLI remains the executor; IM is not authority.
const fail=s=>{throw Error('TASK_DEVELOPMENT_'+s);};
const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
const text=(x,n=1000)=>typeof x==='string'&&x.trim()===x&&!!x&&!/[\x00-\x1f\x7f]/.test(x)&&x.length<=n;
export const relativeFile=x=>text(x,500)&&!x.startsWith('/')&&!x.includes('\\')&&x.split('/').every(p=>p&&p!=='.'&&p!=='..'&&p!=='.git'&&!p.startsWith('.env'));
export const branchName=x=>text(x,200)&&!x.startsWith('-')&&!/[\s~^:?*\[\\]/.test(x)&&!x.includes('..')&&!x.includes('@{')&&!x.endsWith('.')&&!x.endsWith('/')&&!x.endsWith('.lock');
export function developmentContract(x,role){
 if(!object(x)||Object.keys(x).some(k=>!['delivery','branch','remote','base','checks','no_checks_reason','artifacts','notification'].includes(k))||!['workspace','commit','push','pr'].includes(x.delivery)||(x.delivery!=='workspace'||x.branch!==undefined)&&!branchName(x.branch))fail('CONTRACT_INVALID');
 if(role==='local'&&(x.delivery!=='workspace'||x.branch!==undefined))fail('LOCAL_CLI_UNAVAILABLE');
 if(!Array.isArray(x.checks)||x.checks.length>16||x.checks.some(c=>!object(c)||Object.keys(c).some(k=>!['name','command','inputs'].includes(k))||!text(c.name,80)||!text(c.command,2000)||c.inputs!==undefined&&(!Array.isArray(c.inputs)||!c.inputs.length||c.inputs.length>256||c.inputs.some(p=>!relativeFile(p))||new Set(c.inputs).size!==c.inputs.length))||new Set(x.checks.map(c=>c.name)).size!==x.checks.length||new Set(x.checks.map(c=>c.command)).size!==x.checks.length)fail('CHECKS_INVALID');
 if(!x.checks.length&&!text(x.no_checks_reason,600)||x.no_checks_reason!==undefined&&!text(x.no_checks_reason,600))fail('CHECKS_REQUIRED');
 if(!Array.isArray(x.artifacts)||x.artifacts.length>32||x.artifacts.some(p=>!relativeFile(p))||new Set(x.artifacts).size!==x.artifacts.length)fail('ARTIFACTS_INVALID');
 if(['push','pr'].includes(x.delivery)){
  // A credential-free exact remote, not an inherited origin credential grant.
  if(!text(x.remote,500)||!(/^https:\/\/[\w.-]+\/[\w./-]+$/.test(x.remote)||/^git@[\w.-]+:[\w./-]+$/.test(x.remote)||/^\/(?:[^/\x00-\x1f]+\/)*[^/\x00-\x1f]+$/.test(x.remote)&&!x.remote.split('/').some(p=>p==='.'||p==='..')))fail('REMOTE_INVALID');
 }else if(x.remote!==undefined)fail('REMOTE_UNEXPECTED');
 if(x.delivery==='pr'&&(!branchName(x.base)||x.base===x.branch||!/^https:\/\/github\.com\/[^/]+\/[^/]+(?:\.git)?$|^git@github\.com:[^/]+\/[^/]+(?:\.git)?$/.test(x.remote)))fail('PR_PLATFORM_UNAVAILABLE');
 if(x.delivery!=='pr'&&x.base!==undefined)fail('BASE_UNEXPECTED');
 if(x.notification!==undefined&&(!object(x.notification)||Object.keys(x.notification).some(k=>!['target_key','binding_revision'].includes(k))||!text(x.notification.target_key,200)||!Number.isInteger(x.notification.binding_revision)||x.notification.binding_revision<1||!x.artifacts.length))fail('NOTIFICATION_INVALID');
 return structuredClone(x);
}
export const developmentSchema={type:'object',properties:{delivery:{type:'string',enum:['workspace','commit','push','pr']},branch:{type:'string'},remote:{type:'string'},base:{type:'string'},checks:{type:'array',items:{type:'object',properties:{name:{type:'string'},command:{type:'string'},inputs:{type:'array',items:{type:'string'},minItems:1,maxItems:256}},required:['name','command'],additionalProperties:false},maxItems:16},no_checks_reason:{type:'string'},artifacts:{type:'array',items:{type:'string'},maxItems:32},notification:{type:'object',properties:{target_key:{type:'string'},binding_revision:{type:'integer',minimum:1}},required:['target_key','binding_revision'],additionalProperties:false}},required:['delivery','checks','artifacts'],additionalProperties:false};

export function canonicalRemote(url){return url.replace(/^git@([^:]+):/,'https://$1/').replace(/\.git$/,'').replace(/\/$/,'');}
export function managedResourceBusy(db,resource){return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='managed_slots'").get()&&db.prepare('SELECT resources FROM managed_slots').all().some(r=>JSON.parse(r.resources).includes('repository:'+canonicalRemote(resource)));}
export function legacyResourceBusy(db,resources){for(const table of ['development_requests','delivery_actions'])if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))for(const r of db.prepare(`SELECT resource FROM ${table} WHERE state IN ('active','needs_review')`).all())if(resources.includes('repository:'+canonicalRemote(r.resource)))return true;return false;}

// An explicit-command guard, not a shell interpreter or an unbypassable sandbox.
// Complex shell indirection must not be advertised as verified destination scope.
export function assertCliDestination(command,d){
 if(/\bgit\s+(?:-C|--git-dir|--work-tree)|\bcd\s/.test(command))fail('CLI_WORKDIR_CHANGED');
 const words=s=>(s.match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/g)??[]).map(x=>/^['"]/.test(x)?x.slice(1,-1):x);
 for(const match of command.matchAll(/\bgit\s+push\s+([^;&|\n]+)/g)){
  const args=words(match[1]);if(['-u','--set-upstream'].includes(args[0]))args.shift();
  if(args.length!==2||!['origin',d.remote].includes(args[0])||![d.branch,'HEAD:'+d.branch,'HEAD:refs/heads/'+d.branch].includes(args[1]))fail('CLI_DESTINATION_CHANGED');
 }
 if(/\bgit\s+push(?:\s*$|[;&|\n])/.test(command))fail('CLI_DESTINATION_REQUIRED');
 for(const match of command.matchAll(/\bgh\s+pr\s+create\s+([^;&|\n]+)/g)){
  const args=words(match[1]),value=flag=>args.filter(x=>x===flag).length===1?args[args.indexOf(flag)+1]:null,repo=canonicalRemote(d.remote).replace('https://github.com/','');
  if(value('--repo')!==repo||value('--base')!==d.base||value('--head')!==d.branch)fail('CLI_DESTINATION_CHANGED');
 }
 if(/\bgh\s+pr\s+create\s*$/.test(command))fail('CLI_DESTINATION_REQUIRED');
}
