import React,{useEffect,useState} from 'react';
import {Panel,Button,CheckRow,Callout,InfoRow,Badge} from './components';
import {createNodeFlow,nodeActions} from './node-flow';
const labels={not_started:'尚未安装专用 Node',rolled_back:'专用 Node 已移除',start_requested:'请求已登记',observed:'已有持久回执',outcome_unknown:'结果待核对',rollback_requested:'回滚待核对',launching:'启动独立安装进程',downloading:'下载官方固定版本',extracting:'校验并展开官方文件',checking:'核对完整性与版本',ready:'专用 Node 就绪',failed:'安装失败，保留现场',stopped:'安装进程已停止',needs_review:'需核对，未自动重试',rolling_back:'正在回滚／等待核对'};
const errors={ONBOARDING_NODE_KERNEL_UNSUPPORTED:'固定发行包需要 Linux 内核 4.18+；不会擅自更新内核。',ONBOARDING_NODE_PYTHON_MISSING:'未检测到 Python 3。此准备器需要 Linux 上的 Python 3.8+ 标准库；不会擅自安装系统软件。',ONBOARDING_NODE_LIBC_UNSUPPORTED:'此发行包要求 glibc 2.28+；不会将不兼容的二进制安装到目标机。',ONBOARDING_NODE_ARCH_UNSUPPORTED:'目前固定发行包支持 Linux x64 / arm64。',ONBOARDING_NODE_HOST_REMOVAL_REQUIRED:'请先停止并清理引用此 Node 的独立 Host 及安装文件，再移除 Node。',ONBOARDING_NODE_PLAN_EXPIRED:'计划已失效，请重新预览，不会沿用旧确认。',ONBOARDING_SSH_NOT_BOUND:'请先在第 1 页核对主机公钥并保存连接。'};
export function NodeBootstrap({request,onMutation}){
 const [s,setState]=useState({}),[flow]=useState(()=>createNodeFlow(request,setState,onMutation)),[pending,setPending]=useState(null),[checked,setChecked]=useState(false);
 useEffect(()=>{flow.resume();flow.act('load');return()=>flow.dispose();},[flow]);
 const a=nodeActions(s),p=s.plan,r=s.record?.receipt,code=s.error??s.record?.error??r?.error;
 const clear=action=>{setPending(null);setChecked(false);flow.act(action);};
 const confirm=(action,title,detail)=>a[action]&&<div className="cloud-action"><Button data-node-action={action} disabled={s.busy} kind={action==='start'?'primary':'soft'} onClick={()=>{setPending(action);setChecked(false);}}>{title}</Button>{pending===action&&<div className="cloud-confirm" aria-label={title+'确认'}><p>{detail}</p><CheckRow checked={checked} onChange={setChecked} disabled={s.busy} title="我已核对专用 Node 的操作范围" sub="不替换系统 Node，不修改 shell、全局 npm 或日常服务。"/><div className="form-actions"><Button kind="primary" disabled={s.busy||!checked} onClick={()=>{setPending(null);setChecked(false);flow.act(action,true);}}>确认{title}</Button><Button disabled={s.busy} kind="secondary" onClick={()=>{setPending(null);setChecked(false);}}>取消</Button></div></div>}</div>;
 return <Panel title="独立 Node 运行环境" sub="缺少合适 Node 时先准备；已有系统 Node 也可选择独立版本，不替换原版本。" icon="terminal" extra={<Badge>单独确认 · 手动刷新</Badge>}>
  <InfoRow label="持久记录" value={labels[s.record?.state]??'尚未读取'}/>{r&&<InfoRow label="安装进程" value={labels[r.state]??'待核对'}/>}
  <p className="fine-print">{s.fresh?'最近观察：'+new Date(s.observedAt).toLocaleString()+'，执行前仍重新核验。':'当前显示历史回执；重新打开页面不会自动连接、安装或重试。'}</p>
  <div className="form-actions"><Button icon="search" disabled={!a.preview} onClick={()=>clear('preview')}>预览专用 Node 计划</Button><Button icon="reset" disabled={!a.refresh} onClick={()=>clear('refresh')}>手动刷新 Node 状态</Button>{!s.loaded&&<Button disabled={s.busy} onClick={()=>clear('load')}>重读 Node 账本</Button>}</div>
  {s.busy&&<p role="status">正在核对本次 Node 请求；下载和安装使用独立进程。</p>}
  {code&&<Callout tone="warn"><span role="alert">{errors[code]??'结果尚未确认，请手动刷新原事务；不会自动重发或改用系统 Node。'}</span><code>{code}</code></Callout>}
  {p&&<div className="cloud-plan"><InfoRow label="固定官方版本" value={`Node ${p.remote.release.version} / ${p.remote.arch}`}/><InfoRow label="下载来源" value="nodejs.org · HTTPS · 固定 SHA-256 校验"/><div className="path-line"><span>专用 Node 目录</span><code>{p.remote.root}</code></div><div className="path-line"><span>发行包 SHA-256</span><code>{p.remote.release.sha256}</code></div><Callout>只准备 Node 与发行包自带的 npm；不安装 DSH、不启动服务、不调用模型。支持 Linux x64 / arm64、内核 4.18+、glibc 2.28+、Python 3.8+。若不满足条件会停止，不自动替换系统组件。</Callout><p className="fine-print">有效至 {new Date(p.expiresAt).toLocaleString()}。{!p.canStart&&' 当前目录已存在、空间不足或不可写，需要先核对。'}</p>{confirm('start','准备专用 Node','将下载上方固定官方发行包，验证哈希后在专用目录展开。未知同名目录不会覆盖。')}</div>}
  {r?.root&&<div className="path-line"><span>本事务专用目录</span><code>{r.root}</code></div>}
  {r?.state==='ready'&&<Callout>后续云端计划会重新核验并使用此专用 Node。请重新生成下方云端安装计划；不能用旧基线继续安装。</Callout>}
  {confirm('stop','停止 Node 准备进程','只停止本事务记录且出生身份一致的进程。保留文件用于核对，不停止其他服务。')}
  {confirm('rollback','移除专用 Node','按归属账本逐项核验后清理。先清理依赖它的独立 Host；有文件变化或未知内容时保留现场。共享父目录不会递归删除。')}
 </Panel>;
}
