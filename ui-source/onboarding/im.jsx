import React,{useState,useEffect,useSyncExternalStore} from 'react';
import {Panel,Button,InfoRow,Callout,Icon} from './components';
const unavailable=Object.freeze({available:false,generation:0});
const absent={subscribe:()=>()=>{},getSnapshot:()=>unavailable,render:()=>null};
const labels={missing_dependency:'未发现可选 IM 服务',unsupported_contract:'IM 公开接口版本尚不兼容',provider_changed:'IM 服务已变化，请重新核对',needs_review:'未能核对 IM 清单',no_bots:'本端尚无已登记机器人',listed:'已读取本端机器人清单'};
const channels={feishu:'飞书',weixin:'微信',dingtalk:'钉钉',wecom:'企业微信','wecom-app':'企业微信应用',qq:'QQ',slack:'Slack',telegram:'Telegram',discord:'Discord',whatsapp:'WhatsApp',imessage:'iMessage',email:'邮件',matrix:'Matrix'};
const cloudErrors={ONBOARDING_CLOUD_WEB_UNSUPPORTED:'旧安装归档没有安全 Web 入口契约；保留旧实例，请通过其原入口配置。',ONBOARDING_CLOUD_WEB_LOCAL_BROWSER_REQUIRED:'请从连接本机 Host 的 Desktop／本机浏览器打开；远程网页不能把云端回环端口当作本机地址。',ONBOARDING_CLOUD_WEB_RESPONSE_REVIEW:'云端入口校验未通过；没有打开其他地址。',ONBOARDING_SSH_NOT_BOUND:'请先在第 1 页核对主机公钥并保存 SSH 连接。',ONBOARDING_CLOUD_RUNTIME_SOURCE_NOT_READY:'尚无本次受管云端实例；请先完成第 5、6 页的独立安装。',ONBOARDING_CLOUD_IM_UNSUPPORTED:'旧云端归档没有 IM 核对契约；不能用新版控制器覆盖旧实例。',ONBOARDING_CLOUD_HANDOFF_IM_UNSUPPORTED:'目标 Host 尚不支持此 IM 核对契约，未读取本端作为替代。',ONBOARDING_CLOUD_HANDOFF_HOST_NOT_READY:'受管云端 Host 尚未就绪或已离线；请先手动核对运行时。'};
export function ImConnection({request,imClient=absent,onManage,onManageCloud,cloudWebEntry=false,cloud=false}){
 const client=useSyncExternalStore(imClient.subscribe,imClient.getSnapshot,imClient.getSnapshot);
 const [state,setState]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const alive=React.useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 async function inspect(){setBusy(true);setError('');try{const s=await request(cloud?'cloud_im_inventory':'im_inventory',{});if(alive.current)setState(s);}catch(e){if(alive.current){setError(cloudErrors[e?.message]??'未能核对清单，不沿用旧结论，也不会自动重试。');setState(null);}}finally{if(alive.current)setBusy(false);}}
 async function openCloud(){
  let entryId;
  setBusy(true);setError('');
  try{
   if(!['127.0.0.1','localhost','[::1]'].includes(location.hostname))throw Error('ONBOARDING_CLOUD_WEB_LOCAL_BROWSER_REQUIRED');
   const entry=await request('cloud_web_open',{});
   if(typeof entry.entryId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(entry.entryId))throw Error('ONBOARDING_CLOUD_WEB_RESPONSE_REVIEW');
   entryId=entry.entryId;const u=new URL(entry.url);
   if(entry.contract!==1||entry.target?.role!=='cloud'||u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port||u.pathname!=='/'||u.username||u.password||[...u.searchParams.keys()].join()!=='workbench_ticket'||!/^[A-Za-z0-9_-]{43}$/.test(u.searchParams.get('workbench_ticket'))||u.hash!=='#dsh-setup-im')throw Error('ONBOARDING_CLOUD_WEB_RESPONSE_REVIEW');
   if(alive.current)onManageCloud(entry);else {const id=entryId;entryId=null;await request('cloud_web_close',{entryId:id});}
  }catch(e){
   if(entryId)try{await request('cloud_web_close',{entryId});}catch{if(alive.current)setError('入口未打开且关闭未确认；请核对当前 Host，不自动重试。');return;}
   if(alive.current)setError(cloudErrors[e?.message]??'云端原生配置未打开；请核对当前实例与连接。不自动重试，不切到本端配置。');}
  finally{if(alive.current)setBusy(false);}
 }
 return <Panel className="connection-panel" title={cloud?"云端 IM 接入":"本端 IM 接入"} icon="chat" sub={cloud?"只查询本次受管云端实例；不会用本端清单替代。":"可选依赖；不影响 DeepSeek 或原生会话。"}>
  <InfoRow label="最近清单" value={error?'核对失败，不沿用旧结论':state?(labels[state.state]??'待核对').replace('本端',cloud?'云端':'本端'):'尚未手动核对'}/>
  <InfoRow label="实际操作的 Host" value={state?`${state.target.name} · ${state.target.platform}`:cloud?'本次受管云端实例，尚未核对身份':'当前访问的 Host，尚未核对身份'}/>
  {state?.observedAt&&<InfoRow label="记录时间" value={new Date(state.observedAt).toLocaleString()+' · 历史观察，不自动刷新'}/>}
  {state?.channels?.map(row=><InfoRow key={row.channel} label={channels[row.channel]??row.channel} value={`${row.count} 个已登记 · 在线与身份另行核验`}/>)}
  {state?.remoteTarget&&<InfoRow label="受管云端目录" value={state.remoteTarget.root}/>}
  {error&&<Callout tone="warn">{error}</Callout>}
  <Callout>手动核对只读清单，不发送消息、不接管消费者。登记不等于在线、本人身份或双端路由通过。云端原生配置只操作目标 Host；不能由本端结果推断云端已完成。</Callout>
  <div className="connection-actions" role="group" aria-label={cloud?"云端 IM 导览操作":"本端 IM 导览操作"}>
   <Button kind="secondary" icon="reset" disabled={busy} onClick={inspect}>{busy?'正在核对清单':cloud?'手动核对云端 IM':'手动核对本端 IM'}</Button>
   {cloud&&cloudWebEntry&&<Button kind="primary" icon="chat" disabled={busy||!onManageCloud} onClick={openCloud}>打开云端原生 IM 配置</Button>}
   {!cloud&&<Button kind="primary" icon="chat" disabled={!client.available||!onManage||busy} onClick={onManage}>打开本端原生 IM 管理</Button>}
  </div>
  {!cloud&&!client.available&&<p className="fine-print">原生面板服务不可用；可在 DSH 原设置入口检查官方 IM 依赖。导览不会自动安装或修改它。</p>}
  {cloud?<p className="fine-print">清点和打开配置都不会安装依赖或绑定机器人。原生 Web 不是只读沙箱；凭据、绑定及连接在云端原生界面单独操作。</p>:<p className="fine-print">管理页由 IM 插件提供，保留原设置入口。绑定、连接或删除需在原生页明确操作；打开页面本身不授权任何机器人变更。</p>}
 </Panel>;
}
class NativeImBoundary extends React.Component{
 constructor(props){super(props);this.state={failed:false};}
 static getDerivedStateFromError(){return {failed:true};}
 render(){return this.state.failed?<p role="alert">原生 IM 面板暂不可用。请返回导览或使用原设置入口；未自动重试。</p>:this.props.children;}
}
function NativeImContent({bridge}){return bridge.render()??<p role="status">IM 面板提供方已退出，请返回导览重新核对。</p>;}
export function NativeImManager({imClient=absent,onBack}){
 const client=useSyncExternalStore(imClient.subscribe,imClient.getSnapshot,imClient.getSnapshot);
 return <div className="dsh-native-im-shell">
  <div className="dsh-onboarding" style={{height:'auto',flex:'0 0 auto',overflow:'visible'}}><div className="im-manager-heading"><div><h2>当前 Host · 原生 IM 管理</h2><p>这里由已安装的 IM 插件提供；不是云端自动配置、路由接管或业务授权。原设置入口保留。</p></div><Button kind="secondary" icon="back" onClick={onBack}>返回配置导览</Button></div><details className="details im-directory-help"><summary>选择工作区一直加载？<Icon name="down"/></summary><p>本机 Host 可能在等待独立的系统选目录窗口；请检查 Host 所在电脑的前台窗口，锁屏时先解锁。网页里的取消不一定关闭系统窗口；先在系统窗口取消，再重试，避免叠加请求。</p><p>目录属于当前 Host，不属于浏览器所在电脑。远程 Host 应使用它提供的目录浏览能力；不要把本机路径填到云端。修改工作区会影响原生会话，不能仅为文件发送而自动改目录。</p><p>原生工作区设置不等于自有直传授权；普通工作区内的 IM 专用接收目录，也需在第 6 页单独预览确认。</p></details></div>
  <div className="dsh-native-im-frame" data-native-im-manager="true">
   {client.available?<NativeImBoundary key={client.generation}><NativeImContent bridge={imClient}/></NativeImBoundary>:<p role="status">IM 面板服务不可用，请返回导览；其他配置仍可继续。</p>}
  </div>
 </div>;
}

export function CloudImManager({entry,request,onBack}){
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[observation,setObservation]=useState(null);
 useEffect(()=>()=>{void request('cloud_web_close',{entryId:entry.entryId}).catch(()=>{});},[request,entry.entryId]);
 async function inspect(){setBusy(true);setError('');setObservation(null);try{const s=await request('cloud_web_status',{entryId:entry.entryId});if(s?.contract!==1||s.entryId!==entry.entryId||s.scope!=='local_owned_carrier_only'||!['open','closed','closing','cleanup_required','not_found'].includes(s.state))throw Error('INVALID_STATUS');setObservation(s);}catch{setError('未能核对本次承载连接，不沿用旧结论；没有重连、重启或重放配置。');}finally{setBusy(false);}}
 async function close(){setBusy(true);setError('');try{await request('cloud_web_close',{entryId:entry.entryId});onBack();}catch{setError('通道关闭未确认；请重试关闭，不会停止云端 Host 或删除机器人。');}finally{setBusy(false);}}
 const connectionLabel={open:'本机承载进程仍在运行；不证明云端页面或机器人在线。',closed:'本次承载连接已关闭。',closing:'本次承载正在关闭，请手动核对；不要重新提交原生配置。',cleanup_required:'本次承载清理未完成，请先重试关闭；不会重建另一条通道。',not_found:'当前 Host 已不保留该入口，可能已重启或被后续入口替代。'};
 return <div className="dsh-native-im-shell">
  <div className="dsh-onboarding" style={{height:'auto',flex:'0 0 auto',overflow:'visible'}}><div className="im-manager-heading"><div><h2>云端大肥鱼 · 原生 IM 配置</h2><p>仅本次受管实例：{entry.target.root}。原生 Web 可操作，不是只读沙箱；打开不等于已连接或已批准任务。手动核对只观察本机承载，不自动刷新。</p></div><div className="form-actions" role="group" aria-label="云端配置连接操作"><Button kind="soft" icon="reset" disabled={busy} onClick={inspect}>手动核对承载连接</Button><Button kind="secondary" icon="back" disabled={busy} onClick={close}>关闭云端入口，返回导览</Button></div></div>{error&&<p role="alert">{error}</p>}{observation&&<div role="status"><p>{connectionLabel[observation.state]}</p><p>核对时间：{new Date(observation.observedAt).toLocaleString()} · 历史观察</p>{observation.transport?.reason&&<p>进程记录：{observation.transport.reason}；退出码：{observation.transport.exitCode??'未记录'}。记录不代表已确定网络故障原因。</p>}{observation.transport?.stderrCategory&&<p>SSH 诊断分类：{observation.transport.stderrCategory}；仅由进程输出分类，不显示原文或凭据。</p>}</div>}<p className="fine-print">断线后先保留未保存内容，再关闭入口、手动重新打开；不会重放绑定或配置动作。原生页面里的“重连”不能重建已关闭的 SSH 承载。未知操作结果请先核对回执，不要重复提交。</p></div>
  <iframe className="dsh-cloud-im-web" title="受管云端 · 原生 IM 配置" src={entry.url} referrerPolicy="no-referrer"/>
 </div>;
}
