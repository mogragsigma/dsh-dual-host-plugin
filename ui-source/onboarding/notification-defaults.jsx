import React,{useState,useRef,useEffect} from 'react';
import {Panel,Button,Field,InfoRow,CheckRow,Callout} from './components';
const hostName=h=>h==='cloud'?'云端机器人':'本地机器人';
const states={active:'已同步云端',pending_pair_or_sync:'已保存，等待双端配对／同步',pending_or_review:'同步未确认，请手动核对',not_configured:'尚未设置，可跳过'};
export function NotificationDefaults({request}){
 const [host,setHost]=useState('local'),[items,setItems]=useState(null),[selected,setSelected]=useState(''),[state,setState]=useState(null),[plan,setPlan]=useState(null),[checked,setChecked]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[uncertain,setUncertain]=useState(null);
 const lock=useRef(false),alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const chosen=items?.find(x=>x.candidate_id===selected&&x.eligible);
 async function act(action){
  if(lock.current)return;lock.current=true;setBusy(true);setError('');
  try{
   if(action==='discover'){
    setPlan(null);setChecked(false);setItems(null);setSelected('');
    const r=await request('notification_defaults_discover',{host});if(!alive.current)return;
    const rows=r.items??[];setItems(rows);const valid=rows.filter(x=>x.eligible);if(valid.length===1)setSelected(valid[0].candidate_id);
    if(r.state==='unavailable')setError('此端暂不具备经过核验的 IM 通知能力。请先配置对应机器人，不会改用另一端。');
   }else if(action==='status'||action==='sync'){
    const r=await request('notification_defaults_'+action,{});if(!alive.current)return;setState(r);
    if(uncertain&&(r.operation===uncertain.id||r.revision>=uncertain.revision))setUncertain(null);
   }else if(action==='enable'||action==='disable'){
    if(uncertain||action==='enable'&&!chosen)return;setPlan(null);setChecked(false);
    const r=await request('notification_defaults_preview',action==='enable'?{enabled:true,host,candidate_id:chosen.candidate_id,label:chosen.label}:{enabled:false});if(alive.current)setPlan(r);
   }else if(action==='apply'){
    if(!plan||!checked||uncertain||plan.expiresAt<=Date.now())return;
    const sent=plan;setPlan(null);setChecked(false);setUncertain({id:sent.id,revision:sent.revision});
    const r=await request('notification_defaults_apply',{id:sent.id,fingerprint:sent.fingerprint,confirm:true});if(!alive.current)return;
    setState(r);if(r.operation===sent.id)setUncertain(null);
   }
  }catch(e){if(alive.current)setError(/^ONBOARDING_CLOUD_/.test(e?.message??'')?'云端尚未就绪或不支持此契约。可先完成第 5、6 页，再返回此处；不会从本端读取替代。':'本次结果未确认。若已保存，请先手动核对；不自动重发，也不更换机器人或收件位置。');}
  finally{lock.current=false;if(alive.current)setBusy(false);}
 }
 return <Panel title="默认收发入口" icon="chat" className="connection-panel" sub="可选。选择本地或云端机器人作为日常交办入口，并将云端新定时任务的结果发回其绑定对话。不会关闭另一端原生 IM。只发完成／失败摘要，不自动上传全部附件，不授予开发、提交或推送权限。">
  <Field label="默认机器人所在端"><select value={host} disabled={busy||!!uncertain} onChange={e=>{setHost(e.target.value);setItems(null);setSelected('');setPlan(null);setChecked(false);}}><option value="local">本地机器人</option><option value="cloud">云端机器人</option></select></Field>
  <div className="connection-actions"><Button kind="secondary" icon="reset" disabled={busy||!!uncertain} onClick={()=>act('discover')}>读取{hostName(host)}与对话</Button><Button kind="secondary" disabled={busy} onClick={()=>act('status')}>核对已保存设置</Button></div>
  {items&&<Field label="机器人与返回对话" hint="只列出该端 IM 公开接口已保存的目标。首次使用请先与机器人私聊，并在原生 IM 管理中保存通知目标，再重新读取。"><select value={selected} disabled={busy||!!uncertain} onChange={e=>{setSelected(e.target.value);setPlan(null);setChecked(false);}}><option value="">{items.length?'请选择已核验的对话':'尚无已保存对话'}</option>{items.map((x,i)=><option key={x.candidate_id??i} value={x.candidate_id??''} disabled={!x.eligible}>{x.account} · {x.label} · {x.kind==='group'?'群聊':'私聊'}{x.eligible?'':'（不可用）'}</option>)}</select></Field>}
  <InfoRow label="当前默认" value={state?.enabled?`${hostName(state.target.host)} · ${state.target.label}`:state?'未启用默认通知':'尚未核对'}/>
  {state&&<InfoRow label="云端记账" value={states[state.publication.state]??'待核对'}/>}
  <p className="fine-print">本地入口：Mac 离线时通知排队；云端入口：不依赖 Mac 在线。选择只有确认保存后才生效。</p>
  <div className="connection-actions"><Button kind="primary" disabled={busy||!!uncertain||!chosen} onClick={()=>act('enable')}>预览默认入口</Button><Button kind="secondary" disabled={busy||!!uncertain||!state?.enabled} onClick={()=>act('disable')}>停用默认通知</Button>{state?.revision>0&&<Button kind="secondary" disabled={busy||!!uncertain} onClick={()=>act('sync')}>手动核对云端同步</Button>}</div>
  {plan&&<section className="connection-confirm" aria-label="待确认默认收发入口"><h3>{plan.enabled?'启用默认入口':'停用默认通知'}</h3>{plan.target&&<InfoRow label="结果返回" value={`${hostName(plan.target.host)} · ${plan.target.label}`}/>}<p>仅新建的云端定时任务继承。更改将停止旧默认绑定的待发通知，但不修改任务明确指定的通知；已发送的消息无法撤回，不补发历史任务。</p><CheckRow checked={checked} disabled={busy} onChange={setChecked} title="我确认此默认收发设置，不授权开发或发布"/><div className="connection-actions"><Button kind="primary" disabled={busy||!checked||plan.expiresAt<=Date.now()} onClick={()=>act('apply')}>确认保存默认设置</Button><Button kind="secondary" disabled={busy} onClick={()=>{setPlan(null);setChecked(false);}}>取消</Button></div></section>}
  {uncertain&&<Callout tone="warn">保存回执尚未确认。请核对原设置，不要重复确认或将失败当作未保存。</Callout>}
  {error&&<p role="alert" className="connection-error">{error}</p>}
 </Panel>;
}
