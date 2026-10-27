// A bounded compatibility extension for the audited source-only controller.
// It creates a regular-file barrier at the old directory pathname. Never deletes it.
import {createHash} from 'node:crypto';
const supported=new Set(['369c4e445133e0538c434cc090ca4ee3980c89a9b29354d403232e4638166309']);
export function retirementProgram(controller){
 const digest=createHash('sha256').update(controller).digest('hex');
 if(!supported.has(digest))throw Error('ONBOARDING_CLOUD_RETIREMENT_UNSUPPORTED');
 return controller+'\nconst retiredControllerHash='+JSON.stringify(digest)+';\n'+extension;
}
const extension=String.raw`
async function readFence(q){
 await checkAncestors(path.dirname(q.root));
 const a=await stat(q.root);if(!a)return null;if(a.isDirectory())fail('FENCE_SOURCE_PRESENT');
 const temp=path.join(path.dirname(q.root),'.dsh-retire-'+q.operationId+'.json');
 if(!a.isFile()||a.isSymbolicLink()||a.size>16384||a.uid!==os.userInfo().uid||(a.mode&0o777)!==0o600||a.nlink<1||a.nlink>2)fail('FENCE_REVIEW');
 const h=await fs.open(q.root,constants.O_RDONLY|constants.O_NOFOLLOW);let data;
 try{const opened=await h.stat();if(!same(identity(opened),identity(a)))fail('FENCE_REVIEW');data=await h.readFile();const after=await h.stat();if(after.size!==a.size||after.mtimeMs!==a.mtimeMs)fail('FENCE_REVIEW');}finally{await h.close();}
 let f;try{f=verified(JSON.parse(data),q.proof);}catch{fail('FENCE_REVIEW');}
 if(!exact(f,['owner','schema','operationId','installationId','planHash','proofHash','root','identity','parents','controllerHash','boot','createdAt'])||f.owner!==OWNER||f.schema!==1||f.operationId!==q.operationId||f.installationId!==q.installationId||f.planHash!==q.planHash||f.proofHash!==hash(q.proof)||f.root!==q.root||f.controllerHash!==retiredControllerHash||!same(identity(a),f.identity)||!Array.isArray(f.parents))fail('FENCE_REVIEW');
 const alias=await stat(temp);if(alias&&(!alias.isFile()||alias.isSymbolicLink()||!same(identity(alias),identity(a)))||a.nlink!==(alias?2:1))fail('FENCE_REVIEW');
 return {f,alias:alias?temp:null};
}
export async function remoteRetirement(q){
 if(!q||!['retire','retirement_status'].includes(q.action)||!exact(q,q.action==='retire'?['action','root','operationId','installationId','proof','planHash','baseline']:['action','root','operationId','installationId','proof','planHash']))fail('ARGUMENTS');
 base(q);let found=await readFence(q);
 if(!found&&q.action==='retirement_status')return {state:'absent',operationId:q.operationId,initialization:false,hostStarted:false};
 if(!found){
  const b=q.baseline;if(!b||b.root!==q.root||b.rootExists!==false||b.uid!==os.userInfo().uid||b.platform!==process.platform||b.arch!==process.arch||!b.node)fail('BASELINE_DRIFT');
  const n=await fs.stat(process.execPath);if(b.node.path!==process.execPath||b.node.version!==process.versions.node||b.node.dev!==n.dev||b.node.ino!==n.ino||b.node.size!==n.size||b.node.mtime!==n.mtimeMs)fail('BASELINE_DRIFT');
  const expected=await checkAncestors(q.root,b.ancestors),parents=[];
  for(const x of expected.filter(x=>x.missing&&x.path!==q.root)){await checkAncestors(path.dirname(x.path));await fs.mkdir(x.path,{mode:0o700});parents.push({path:x.path,...identity(await fs.lstat(x.path))});}
  const temp=path.join(path.dirname(q.root),'.dsh-retire-'+q.operationId+'.json');let f;
  if(await stat(temp)){
   const old=await regular(temp,16384);if(!old)fail('FENCE_REVIEW');try{f=verified(JSON.parse(old.data),q.proof);}catch{fail('FENCE_REVIEW');}
   if(f.operationId!==q.operationId||f.root!==q.root||f.planHash!==q.planHash||f.controllerHash!==retiredControllerHash||!same(f.identity,old.identity))fail('FENCE_REVIEW');
  }else{
   const h=await fs.open(temp,'wx',0o600);
   try{f={owner:OWNER,schema:1,operationId:q.operationId,installationId:q.installationId,planHash:q.planHash,proofHash:hash(q.proof),root:q.root,identity:identity(await h.stat()),parents,controllerHash:retiredControllerHash,boot:process.platform==='linux'?(await fs.readFile('/proc/sys/kernel/random/boot_id','utf8')).trim():null,createdAt:Date.now()};await h.writeFile(JSON.stringify(signed(f,q.proof)));await h.sync();}finally{await h.close();}
  }
  // link is atomic no-replace: unlike rename it cannot replace an empty directory.
  await checkAncestors(path.dirname(q.root));
  try{await fs.link(temp,q.root);}catch(e){
   if(e.code==='EEXIST'){
    const target=await stat(q.root),own=await regular(temp,16384).catch(()=>null);
    if(own&&same(own.identity,f.identity)&&own.sha256===hash(JSON.stringify(signed(f,q.proof)))){await fs.unlink(temp);await syncDir(path.dirname(q.root));}
    if(target?.isDirectory())fail('FENCE_SOURCE_PRESENT');
   }
   throw e;
  }
  await syncDir(path.dirname(q.root));found=await readFence(q);
 }
 if(q.action==='retire'&&found.alias){await fs.unlink(found.alias);await syncDir(path.dirname(q.root));found=await readFence(q);}
 return {state:'retired',operationId:q.operationId,root:q.root,barrier:'regular-file-no-replace',barrierHash:hash(found.f),controllerHash:retiredControllerHash,retainedPaths:[q.root,...(found.alias?[found.alias]:[])],originalProcessTerminated:false,originalRequestIsolated:true,initialization:false,hostStarted:false};
}
export async function retirementCLI(){
 try{let size=0,parts=[];for await(const c of process.stdin){size+=c.length;if(size>65536)fail('INPUT_LIMIT');parts.push(c);}console.log(JSON.stringify({ok:true,value:await remoteRetirement(JSON.parse(Buffer.concat(parts)))}));}
 catch(e){console.log(JSON.stringify({ok:false,error:/^ONBOARDING_CLOUD_[A-Z_]+$/.test(e.message)?e.message:'ONBOARDING_CLOUD_RETIREMENT_FAILED'}));}
}
`;
