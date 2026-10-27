import {createHash} from 'node:crypto';
import {readFileSync,lstatSync} from 'node:fs';
// Only this fixed provider origin is contacted. No clone, arbitrary HTTP, write API or credential tool.
export function repositoryURL(raw){
 if(typeof raw!=='string'||raw.length>500)throw Error('INVALID_REPOSITORY_URL');
 const m=/^(?:https:\/\/gitee\.com\/|git@gitee\.com:)([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(raw);
 if(!m||['.','..'].includes(m[2])||m[2].startsWith('.')||m[2].endsWith('.'))throw Error('INVALID_REPOSITORY_URL');
 return {owner:m[1],repo:m[2],url:`https://gitee.com/${m[1]}/${m[2]}`};
}
export function repositoryBranch(v){
 if(typeof v!=='string'||!v||v.length>200||v==='@'||/[\x00-\x20\x7f~^:?*\[\\]/.test(v)||v.includes('..')||v.includes('@{')||v.split('/').some(s=>!s||s.startsWith('.')||s.endsWith('.')||s.endsWith('.lock')))throw Error('INVALID_REPOSITORY_BRANCH');
 return v;
}
export function repositoryLabel(p){return p?`仓库：${p.url}\n分支：${p.branch}；基线：${p.base_sha}\n绑定版本：${p.binding_revision}；仅远端元数据，未检出工作区`:'仓库：未绑定';}
export class GiteeReadOnly {
 constructor(config={},io={}){
  this.fetch=io.fetch??fetch;this.token=null;
  if(config.tokenFile){const s=lstatSync(config.tokenFile);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077))throw Error('REPOSITORY_SECRET_FILE_PERMISSIONS');this.token=readFileSync(config.tokenFile,'utf8').trim();if(!/^[A-Za-z0-9_-]{16,256}$/.test(this.token))throw Error('INVALID_REPOSITORY_CREDENTIAL');}
  // Internal onboarding seam: one explicit managed credential, never env fallback.
  if(io.token!==undefined){if(config.tokenFile||typeof io.token!=='string'||!/^[A-Za-z0-9_-]{16,256}$/.test(io.token))throw Error('INVALID_REPOSITORY_CREDENTIAL');this.token=io.token;}
  const aliases=config.aliases??[];if(!Array.isArray(aliases)||aliases.length>100)throw Error('INVALID_REPOSITORY_ALIASES');
  this.aliases=aliases.map(a=>{if(typeof a?.name!=='string'||!a.name.trim()||a.name.length>120)throw Error('INVALID_REPOSITORY_ALIAS');return {name:a.name,url:repositoryURL(a.url).url};});
 }
 reference(reference){
  if(typeof reference!=='string'||!reference.trim()||reference.length>500)throw Error('INVALID_REPOSITORY_REFERENCE');
  if(reference.startsWith('https:')||reference.startsWith('git@'))return {url:repositoryURL(reference).url};
  const matches=this.aliases.filter(a=>a.name.normalize('NFKC').toLowerCase()===reference.normalize('NFKC').toLowerCase());
  const urls=[...new Set(matches.map(a=>a.url))];
  if(urls.length!==1)return {requires_clarification:true,reason:urls.length?'AMBIGUOUS_REPOSITORY_ALIAS':'UNKNOWN_REPOSITORY_ALIAS',candidates:urls.map(url=>({url}))};
  return {url:urls[0]};
 }
 async get(path,limit=1048576){
  let response;
  try{response=await this.fetch('https://gitee.com/api/v5'+path,{method:'GET',redirect:'error',headers:{Accept:'application/json',...(this.token?{Authorization:'Bearer '+this.token}:{})},signal:AbortSignal.timeout(6000)});}catch{throw Error('REPOSITORY_PROVIDER_UNAVAILABLE');}
  if(!response.ok){await response.body?.cancel();throw Error(response.status===404?'REPOSITORY_NOT_FOUND_OR_PRIVATE':[401,403].includes(response.status)?'REPOSITORY_ACCESS_DENIED':response.status===429?'REPOSITORY_RATE_LIMIT':'REPOSITORY_PROVIDER_UNAVAILABLE');}
  if(Number(response.headers.get('content-length'))>limit){await response.body?.cancel();throw Error('REPOSITORY_RESPONSE_TOO_LARGE');}
  try{let size=0;const chunks=[];for await(const chunk of response.body){size+=chunk.length;if(size>limit)throw Error('REPOSITORY_RESPONSE_TOO_LARGE');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch(e){throw Error(e.message==='REPOSITORY_RESPONSE_TOO_LARGE'?e.message:'REPOSITORY_RESPONSE_INVALID');}
 }
 async file(snapshot,filePath){
  const r=repositoryURL(snapshot.url),path=`/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}`;
  if(!/^[a-f0-9]{40}$/.test(snapshot.base_sha??'')||typeof filePath!=='string'||!filePath||filePath.length>500||/[\\\x00-\x1f\x7f?#%]/.test(filePath)||filePath.split('/').some(s=>!s||s==='.'||s==='..'))throw Error('ARTIFACT_INVALID_PATH');
  const meta=await this.get(path);
  if(meta.id!==snapshot.repository_id||typeof meta.full_name!=='string'||repositoryURL('https://gitee.com/'+meta.full_name).url!==r.url)throw Error('ARTIFACT_REPOSITORY_IDENTITY_MISMATCH');
  const f=await this.get(path+'/contents/'+filePath.split('/').map(encodeURIComponent).join('/')+'?ref='+snapshot.base_sha,1500000);
  if(f.type!=='file'||f.target!==undefined||f.submodule_git_url!==undefined||f.path!==filePath||f.encoding!=='base64'||!Number.isSafeInteger(f.size)||f.size<0||f.size>1048576||typeof f.content!=='string'||f.content.length>1450000||!/^[a-f0-9]{40}$/.test(f.sha??''))throw Error('ARTIFACT_PROVIDER_FILE_INVALID');
  const b64=f.content.replace(/[\r\n]/g,'');
  if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b64))throw Error('ARTIFACT_PROVIDER_FILE_INVALID');
  const bytes=Buffer.from(b64,'base64');
  if(bytes.length!==f.size||createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex')!==f.sha)throw Error('ARTIFACT_PROVIDER_FILE_INVALID');
  return {bytes,blob_sha:f.sha,url:r.url+'/blob/'+snapshot.base_sha+'/'+filePath.split('/').map(encodeURIComponent).join('/')};
 }
 async identity(url){
  const r=repositoryURL(url),meta=await this.get(`/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}`);
  if(!Number.isSafeInteger(meta.id)||meta.id<=0||typeof meta.full_name!=='string'||typeof meta.private!=='boolean'||repositoryURL('https://gitee.com/'+meta.full_name).url!==r.url)throw Error('REPOSITORY_IDENTITY_MISMATCH');
  return {provider:'gitee',repository_id:meta.id,url:r.url,private:meta.private};
 }
 async commit(snapshot,expected){
  const r=repositoryURL(snapshot.url),path=`/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}`;
  if(!/^[a-f0-9]{40}$/.test(snapshot.base_sha??'')||![expected?.tree_oid,expected?.parent_oid].every(x=>/^[a-f0-9]{40}$/.test(x??'')))throw Error('ARTIFACT_PROVIDER_COMMIT_INVALID');
  const meta=await this.identity(r.url);if(meta.repository_id!==snapshot.repository_id)throw Error('ARTIFACT_REPOSITORY_IDENTITY_MISMATCH');
  const c=await this.get(path+'/commits/'+snapshot.base_sha);
  if(c.sha!==snapshot.base_sha||c.commit?.tree?.sha!==expected.tree_oid||!Array.isArray(c.parents)||c.parents.length!==1||c.parents[0]?.sha!==expected.parent_oid)throw Error('ARTIFACT_PROVIDER_COMMIT_INVALID');
  return {commit_oid:c.sha,tree_oid:c.commit.tree.sha,parent_oid:c.parents[0].sha,url:r.url+'/commit/'+c.sha};
 }
 async inspect(url,branch){
  const r=repositoryURL(url),path=`/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}`;
  if(branch!==undefined)repositoryBranch(branch);
  const meta=await this.get(path);
  if(!Number.isSafeInteger(meta.id)||meta.id<=0||typeof meta.full_name!=='string'||typeof meta.private!=='boolean'||repositoryURL('https://gitee.com/'+meta.full_name).url.toLowerCase()!==r.url.toLowerCase())throw Error('REPOSITORY_IDENTITY_MISMATCH');
  if(branch===undefined&&(meta.default_branch==null||meta.default_branch===''))throw Error('REPOSITORY_DEFAULT_BRANCH_REQUIRED');
  const canonical=repositoryURL('https://gitee.com/'+meta.full_name).url,selected=repositoryBranch(branch??meta.default_branch);
  const b=await this.get(path+'/branches/'+encodeURIComponent(selected));
  if(b.name!==selected||typeof b.commit?.sha!=='string'||!(/^[a-f0-9]{40}$/).test(b.commit.sha))throw Error('REPOSITORY_BRANCH_RESPONSE_INVALID');
  return {provider:'gitee',repository_id:meta.id,url:canonical,branch:selected,base_sha:b.commit.sha,private:meta.private,workspace:null};
 }
}
