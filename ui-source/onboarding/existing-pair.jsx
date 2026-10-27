import React,{useState,useRef,useEffect} from 'react';
import {Panel,Button,InfoRow,Callout} from './components';
const rules={inspected:'托管清单核验一致',uninstalled:'已卸载托管内容',committed:'托管文件核验一致',not_installed:'尚无托管安装记录',unavailable:'未开放检查',removed:'已移除托管内容',rolled_back:'已回滚',needs_review:'需人工核对',applying:'事务未完成',rolling_back:'回滚未完成'};
export function ExistingPairInspection({request,onResult}){
 const [value,setValue]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const alive=useRef(true),lock=useRef(false),generation=useRef(0);
 useEffect(()=>{alive.current=true;generation.current++;lock.current=false;setBusy(false);setValue(null);setError('');return()=>{alive.current=false;generation.current++;};},[request]);
 async function inspect(){
  if(lock.current)return;lock.current=true;const n=++generation.current;setBusy(true);setValue(null);onResult?.(null);setError('');
  try{const r=await request('existing_pair_inspect',{});if(alive.current&&n===generation.current){setValue(r);onResult?.(r);}}
  catch{if(alive.current&&n===generation.current)setError('本次双端核对未完成。请检查原直连与两端插件版本；不会采用历史成功、另建 Host 或复制凭据。');}
  finally{if(n===generation.current){lock.current=false;if(alive.current)setBusy(false);}}
 }
 return <Panel title="已有双端配置" icon="cloud" className="connection-panel" sub="仅适用于已经建立自有直连的两个 Host。手动核对当前实际配置；不重复保存 Key，不接管 Host 生命周期，不生成安装归属，也不改变下方新建环境流程。">
  <div className="connection-actions"><Button kind="secondary" icon={busy?'spinner':'search'} disabled={busy} onClick={inspect}>{busy?'正在核对既有双端…':'手动核对既有双端'}</Button></div>
  {value&&<div className="connection-result" role="status">
   <p className="fine-print">核对时间：{new Date(value.observedAt).toLocaleString()} · 此次观察，不代表持续在线</p>
   <div className="form-grid">{[['本地 Host',value.local],['云端 Host',value.cloud]].map(([name,h])=><section key={name} aria-label={name+'既有配置'}>
    <h3>{name}</h3><InfoRow label="插件版本" value={h.host.plugin_version}/>
    <InfoRow label="规则与 Skill" value={rules[h.rules.state]??'需核对'}/>
    <InfoRow label="模型清单" value={h.models.state==='listed'?`${h.models.providers} 个渠道 / ${h.models.models} 个模型`:h.models.state==='catalog_incomplete'?'清单不完整':'未读取到清单'}/>
    <InfoRow label="IM 清单" value={h.im.state==='listed'?`${h.im.botsConfigured} 个机器人 · 未验证连接`:h.im.state==='no_bots'?'尚无机器人':'未取得完整清单'}/>
    <InfoRow label="只读调度器" value={h.runtime.scheduler?`已启动 / 活动 ${h.runtime.activeRuns} 批`:'未启动'}/>
    <details className="details"><summary>目标端解析路径</summary><p className="fine-print">由目标进程解析，尚未证明会话加载；不按本机推测，不授予删除权。</p><div className="path-line"><span>DSH</span><code>{h.paths.dsh}</code></div><div className="path-line"><span>Agents</span><code>{h.paths.agents}</code></div></details>
   </section>)}</div>
   <Callout>这不是安装或全链路验收回执。模型请求、IM 收发、仓库访问及任务成果仍须分别验证；不会开启开发、提交、推送或发布。</Callout>
  </div>}
  {error&&<p role="alert" className="connection-error">{error}</p>}
 </Panel>;
}
