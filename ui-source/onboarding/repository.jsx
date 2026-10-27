import React,{useEffect,useRef,useState} from 'react';
import {Panel,Field,Button,InfoRow,Callout} from './components';
const messages={ONBOARDING_REPOSITORY_DEFAULT_BRANCH_REQUIRED:'仓库可读取，但未设置默认分支；请填写已有分支后重新核验。空仓库须另行初始化，本导览不会创建提交。',ONBOARDING_REPOSITORY_ARGUMENTS:'请填写有效的 Gitee 仓库地址和分支；地址中不能包含凭据。',ONBOARDING_REPOSITORY_CREDENTIAL_REQUIRED:'当前目标没有保存本项目的 Gitee 令牌；公开仓库可选择匿名核验。',ONBOARDING_REPOSITORY_CREDENTIAL_INVALID:'Gitee 令牌格式不正确，请通过独立凭据窗口核对，不要填入地址或聊天。',ONBOARDING_REPOSITORY_CREDENTIAL_CHANGED:'核验期间凭据已变化，本次结果不采用；请手动重新核验。',ONBOARDING_REPOSITORY_NOT_FOUND_OR_PRIVATE:'仓库／分支不存在，或当前身份无权查看；不能仅凭此结果判断仓库已删除。',ONBOARDING_REPOSITORY_ACCESS_DENIED:'当前身份访问被拒绝；不会切换其他凭据重试。',ONBOARDING_REPOSITORY_RATE_LIMIT:'Gitee 暂时限流，请稍后手动核验，不自动重试。',ONBOARDING_REPOSITORY_PROVIDER_UNAVAILABLE:'Gitee 只读接口暂不可达；本次没有确认读取权限。',ONBOARDING_CLOUD_REPOSITORY_UNSUPPORTED:'原云端安装归档不支持仓库核验；保留原环境，不用新控制器覆盖旧归档。',ONBOARDING_CLOUD_HANDOFF_HOST_NOT_READY:'本导览的云端 Host 尚未就绪，请先核对第 6 页；不回退到本端。',ONBOARDING_CLOUD_RUNTIME_SOURCE_NOT_READY:'请先完成本导览的云端独立初始化；本端成功不能代替云端验证。'};
export function RepositoryConnection({request,url,cloud=false}){
 const [branch,setBranch]=useState(''),[authentication,setAuthentication]=useState('anonymous'),[busy,setBusy]=useState(false),[result,setResult]=useState(null),[error,setError]=useState('');
 const current=useRef(null),active=useRef(true),inflight=useRef(false),key=JSON.stringify([url,branch,authentication,cloud]);current.current=key;
 useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
 // Input changes invalidate observations. They never trigger a network request.
 useEffect(()=>{setResult(null);setError('');},[key]);
 async function inspect(){
  if(inflight.current)return;inflight.current=true;setBusy(true);setResult(null);setError('');const started=key;
  try{const value=await request(cloud?'cloud_repository_inspect':'repository_inspect',{url,branch,authentication});if(active.current&&current.current===started)setResult({key:started,value});}
  catch(e){if(active.current&&current.current===started)setError(messages[e.message]??'核验结果未确认，请手动检查目标和连接。不采用旧结果，不自动重试。');}
  finally{inflight.current=false;if(active.current)setBusy(false);}
 }
 const value=result?.key===key?result.value:null;
 return <Panel className="connection-panel" title={cloud?'云端仓库只读核验':'本端仓库只读核验'} icon="git" sub="手动查询 Gitee 元数据；不克隆、不写文件、不提交或推送。">
  <InfoRow label="查询目标" value={cloud?'本次受管云端 Host · 仅使用云端凭据':'当前 Host · 不借用云端或日常凭据'}/>
  <div className="form-grid"><Field label="核验分支" value={branch} onChange={e=>setBranch(e.target.value)} placeholder="留空使用仓库默认分支"/><Field label="仓库核验身份"><select value={authentication} onChange={e=>setAuthentication(e.target.value)}><option value="anonymous">匿名 · 公开仓库</option><option value="managed">目标端本项目 Gitee 令牌</option></select></Field></div>
  <div className="connection-actions" role="group" aria-label={cloud?'云端仓库核验操作':'本端仓库核验操作'}><Button kind="primary" icon={busy?'spinner':'git'} disabled={busy||!url} onClick={inspect}>{busy?'正在只读核验…':cloud?'手动核验云端仓库访问':'手动核验本端仓库访问'}</Button></div>
  {value&&<div role="status"><InfoRow label="读取权限" value="本次元数据读取通过 · 不代表写权限"/><InfoRow label="实际 Host" value={value.target.name+' / '+value.target.platform}/><InfoRow label="仓库" value={value.repository.url}/><InfoRow label="分支" value={value.repository.branch}/><div className="path-line"><span>观察到的提交</span><code>{value.repository.base_sha}</code></div><p className="fine-print">核验时间：{new Date(cloud?value.checkedAt:value.observedAt).toLocaleString()}。仅为本次观察，不自动刷新；实际任务执行前仍须重新核验。</p></div>}
  {error&&<p role="alert">{error}</p>}
  <Callout>这不是任务绑定或开发授权。草稿别名需另行确认登记；为任务关联仓库、开发、commit、push 必须分别走实际任务流程和审批。Gitee 不是双端通信平台。</Callout>
 </Panel>;
}
