import React,{useEffect,useState,useRef} from 'react';
import {Button,InfoRow,Callout,CheckRow} from './components';
const states={running:'正在验证 · 请稍后手动查询',succeeded:'本次请求成功',failed:'本次请求失败',unknown:'结果未知 · 不自动重发'};
const messages={
 ONBOARDING_CLOUD_MODEL_CLARIFICATION_UNSUPPORTED:'本次云端归档尚不支持名称补充说明，不忽略选择或降级验证。',
 ONBOARDING_CLOUD_HANDOFF_MODEL_CLARIFICATION_UNSUPPORTED:'目标 Host 尚不支持名称补充说明，不忽略选择或降级验证。',
 ONBOARDING_MODEL_PROBE_BINDING_REQUIRED:'请先单独启用此端的模型接入，再预览验证。',
 ONBOARDING_MODEL_PROBE_MODEL_SELECTION_REQUIRED:'模型名称还不能唯一匹配。请先用上方“模型名称核对”查看候选，再填写“模型接入补充说明”；无需输入 provider 编号。',
 ONBOARDING_MODEL_PROBE_OWN_ROUTE_REQUIRED:'所填模型属于其他接入，不会借用它的 Key。请使用本面板接入的模型，或到对应服务面板验证。',
 ONBOARDING_MODEL_PROBE_BUSY:'上一次验证尚未结束。请稍后手动查询，不会新增请求。',
 ONBOARDING_MODEL_PROBE_UNKNOWN_ACK_REQUIRED:'上一次结果未知，请先查询回执，再明确确认是否发起一次新的验证。',
 ONBOARDING_MODEL_PROBE_PLAN_EXPIRED:'预览已失效或 Host 已重启。请先查询回执，再重新预览。',
 ONBOARDING_CLOUD_MODEL_PROBE_PLAN_EXPIRED:'预览已消费、过期或本端已重启。请先查询云端回执，不要重复发送。',
 ONBOARDING_CLOUD_MODEL_PROBE_UNSUPPORTED:'本次云端归档不支持异步模型验证；保留原环境，不自动升级或改用本端。',
 ONBOARDING_CLOUD_HANDOFF_MODEL_PROBE_UNSUPPORTED:'目标 Host 未声明异步模型验证能力；不降级调用、不自动重试。',
 ONBOARDING_MODEL_PROBE_UNAVAILABLE:'当前 Host 的模型请求能力未就绪，请手动核对依赖。',
};
export function ModelProbe({request,query,clarification='',cloud=false,service='deepseek'}){
 const side=cloud?'云端':'本端',token=service==='token-plan',prefix=(cloud?'cloud_':'')+(token?'token_':'')+'model_probe_';
 const queryKey=JSON.stringify([query,clarification,cloud,service]),currentQuery=useRef(queryKey);currentQuery.current=queryKey;
 const [value,setValue]=useState(null),[plan,setPlan]=useState(null),[confirmed,setConfirmed]=useState(false),[ack,setAck]=useState(false),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false),[error,setError]=useState('');
 useEffect(()=>{setPlan(null);setConfirmed(false);},[query,clarification,cloud,service]);
 async function act(action){
  setBusy(true);setError('');
  try{
   if(action==='status'){setUncertain(true);setPlan(null);setConfirmed(false);setValue(await request(prefix+'status',{}));setUncertain(false);setAck(false);}
   if(action==='preview'){setPlan(null);setConfirmed(false);const p=await request(prefix+'preview',{query,...(clarification.trim()?{clarification:clarification.trim()}:{}),acknowledgeUnknown:value?.receipt?.state==='unknown'&&ack?value.receipt.id:null});if(currentQuery.current===queryKey)setPlan(p);}
   if(action==='start'){
    if(!plan||!confirmed)return;
    const p=plan;setPlan(null);setConfirmed(false);setValue(null);setUncertain(true);setAck(false);
    setValue(await request(prefix+'start',{id:p.id,fingerprint:p.fingerprint,confirm:true}));setUncertain(false);
   }
  }catch(e){setPlan(null);setConfirmed(false);setError(messages[e.message]??'操作未能核验，请手动查询回执。不会自动重试、切换模型或借用其他凭据。');}
  finally{setBusy(false);}
 }
 const receipt=value?.receipt,unknown=receipt?.state==='unknown';
 return <section className="connection-utility connection-probe" aria-label={side+'单次模型请求验证'}>
  <div><h3>单次模型请求验证</h3><p>保存与启用不等于连通。回执是手动查询时的快照。此处独立确认，只验证{side}当前接入；可能产生 API 费用。</p></div>
  <InfoRow label="准备验证的模型" value={query?.trim()||'请先填写上方模型名称，例如 ds flash'}/>
  {clarification.trim()&&<InfoRow label="接入补充说明" value={clarification.trim()}/>}
  <InfoRow label="请求回执" value={uncertain?'发送结果未核对 · 请手动查询':receipt?states[receipt.state]:value?'尚无请求记录':'尚未查询'}/>
  {receipt&&<><InfoRow label="上次实际模型" value={receipt.selection.model_name+' · '+receipt.selection.provider_name}/><InfoRow label="回执时间" value={new Date(receipt.completedAt??receipt.startedAt).toLocaleString()}/>{receipt.state==='succeeded'&&!receipt.verifiedForCurrentBinding&&<Callout tone="warn">此成功属于旧配置；凭据或接入已变化，不能据此判断当前模型可用。</Callout>}{receipt.error&&<p>原因分类：{receipt.error}。不会展示上游错误正文或凭据。</p>}</>}
  {unknown&&<CheckRow title="我理解上次结果未知，新验证可能产生额外费用" checked={ack} onChange={setAck} disabled={busy}/>}
  <div className="connection-actions" role="group" aria-label={side+'模型验证操作'}>
   <Button kind="soft" icon="play" disabled={busy||uncertain||receipt?.state==='running'||unknown&&!ack||!query?.trim()} onClick={()=>act('preview')}>预览一次{side}验证</Button>
   <Button kind="secondary" icon="reset" disabled={busy} onClick={()=>act('status')}>手动查询{side}请求回执</Button>
  </div>
  {plan&&<section className="connection-confirm" aria-label={side+'模型验证确认'}><h3>确认一次{side}请求</h3><InfoRow label="实际 Host" value={plan.target.name+' · '+plan.target.platform}/>{plan.remoteTarget&&<InfoRow label="云端专用目录" value={plan.remoteTarget.root}/>}<InfoRow label="实际模型" value={plan.selection.model_name+' · '+plan.selection.provider_name}/><InfoRow label="请求范围" value="1 次 · High · 最多 1024 输出 token · 60 秒"/><Callout>固定连通提示，无工具、不启动任务、不修改默认模型。不自动重试。关闭页面不会取消已经确认的请求；重新进入后手动查询。</Callout><CheckRow title={'我同意仅向'+side+'上述模型发起这一次验证请求（可能产生费用）'} checked={confirmed} onChange={setConfirmed} disabled={busy}/><div className="connection-actions"><Button kind="primary" icon="check" disabled={busy||!confirmed} onClick={()=>act('start')}>确认开始一次{side}验证</Button><Button kind="secondary" disabled={busy} onClick={()=>{setPlan(null);setConfirmed(false);}}>取消验证预览</Button></div></section>}
  {error&&<p className="connection-error" role="alert">{error}</p>}
 </section>;
}
