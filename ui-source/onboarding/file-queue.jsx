import React,{useState,useRef} from 'react';
import {Button,CheckRow,InfoRow,Callout,Badge} from './components';
const labels={outgoing:'发件',incoming:'收件',broker:'云端中继'},sideName={cloud:'云端',local:'本地'};
const reasons={PEER_FILE_SCOPE_CHANGED:'发送范围已调整，原记录已挂起',PEER_FILE_UNAVAILABLE:'传输失败，需要人工核对',PEER_FILE_PEER_REVIEW_REQUIRED:'对端尚未确认恢复',ONBOARDING_FILES_QUEUE_HISTORY_MISSING:'缺少可信的原阶段记录，暂只能保留',ONBOARDING_FILES_QUEUE_RETRY_BUDGET:'重试预算已耗尽，不能通过恢复重置',ONBOARDING_FILES_QUEUE_METADATA_REVIEW:'原记录信息需要核对'};
const errors={ONBOARDING_FILES_QUEUE_DISABLE_REQUIRED:'请先停用此端文件直传，再逐项复核。',ONBOARDING_FILES_QUEUE_HISTORY_MISSING:'缺少可信阶段证明，不能猜测恢复；可以继续保留。',ONBOARDING_FILES_QUEUE_SIZE_LIMIT:'文件超过当前上限，尚未恢复。',ONBOARDING_FILES_QUEUE_RETRY_BUDGET:'预算已耗尽，不会重置次数。',ONBOARDING_FILES_QUEUE_DESTINATION_EXISTS:'收件位置已有文件，未覆盖或认领。',ONBOARDING_FILES_QUEUE_BYTES_CHANGED:'已保存字节发生变化，保持挂起。',ONBOARDING_FILES_QUEUE_CHANGED:'队列或快照与预览不一致，请手动重新查询。',ONBOARDING_FILES_QUEUE_NOT_HELD:'此记录已不是挂起状态，请核对原回执。',ONBOARDING_FILES_RECOVERY_REQUIRED:'原决定仍需核对，不能用新决定覆盖未知结果。',ONBOARDING_CLOUD_FILES_QUEUE_UNSUPPORTED:'原云端归档不支持队列复核，未替换控制器或降级。',ONBOARDING_CLOUD_HANDOFF_FILES_QUEUE_UNSUPPORTED:'目标 Host 不支持当前队列复核合同，未执行。',ONBOARDING_FILES_QUEUE_CLOSED:'原请求已关闭，迟到确认不会执行。',ONBOARDING_FILES_ALREADY_APPLIED:'原决定已记账，请手动核对，不当作取消。'};
const nativeOutcome=s=>({operation:{state:s.receipt?'applied':s.closed?'closed':'needs_review'},receipt:s.receipt,freshness:'remote_checked'});
export function FileQueue({request,cloud=false}){
 const [list,setList]=useState(null),[result,setResult]=useState(null),[plan,setPlan]=useState(null),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[intent,setIntent]=useState(null);
 const flight=useRef(false),prefix=cloud?'cloud_file_transfer_':'file_transfer_',side=cloud?'云端':'本端',phase=result?.operation?.state,unknown=!!intent&&!result||['sending','closing','needs_review'].includes(phase);
 const storageKey=id=>'dsh-own-file-queue-review:'+id;
 function remember(p){const v={id:p.id,fingerprint:p.fingerprint,name:p.review.name};try{sessionStorage.setItem(storageKey(list.runtimeId),JSON.stringify(v));}catch{throw Error('UI_REQUEST_INDEX_UNAVAILABLE');}setIntent(v);return v;}
 function restore(q){try{const raw=sessionStorage.getItem(storageKey(q.runtimeId));if(!raw)return;const v=JSON.parse(raw);if(typeof v.id!=='string'||!/^[a-f0-9-]{36}$/.test(v.id)||typeof v.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(v.fingerprint))throw Error();if(v.id!==intent?.id){setIntent(v);setResult(null);}}catch{throw Error('UI_REQUEST_INDEX_UNAVAILABLE');}}
 async function act(action,row){if(flight.current)return;flight.current=true;setBusy(true);setError('');let dispatched=false;try{
  if(action==='list'){setPlan(null);setConfirmed(false);const v=await request(prefix+'queueList',{}),q=cloud?v.queue:v;setList(q);if(cloud)setResult(await request(prefix+'queueReviewStatus',{refresh:false}));else restore(q);}
  if(action==='resume'||action==='retain'){setPlan(null);setConfirmed(false);setPlan(await request(prefix+'queueReviewPreview',{item:row.item,decision:action}));}
  if(action==='apply'){
   if(!plan||!confirmed)return;const p=plan;setPlan(null);setConfirmed(false);if(!cloud)remember(p);setResult({operation:{state:'sending'},receipt:null,freshness:'cached'});
   dispatched=true;const v=await request(prefix+'queueReviewApply',{id:p.id,fingerprint:p.fingerprint,confirm:true});setResult(cloud?v:nativeOutcome({receipt:v,closed:false}));setList(null);
  }
  if(action==='status'){
   const v=await request(prefix+'queueReviewStatus',cloud?{refresh:true}:{operation:intent.id,fingerprint:intent.fingerprint});setResult(cloud?v:nativeOutcome(v));setPlan(null);setConfirmed(false);
  }
  if(action==='closePreview'){setConfirmed(false);setPlan(cloud?await request(prefix+'queueReviewClosePreview',{}):{kind:'queue_review_close',name:intent.name,reference:intent});}
  if(action==='close'){
   if(!plan||!confirmed)return;const p=plan;setPlan(null);setConfirmed(false);setResult(r=>({...r,operation:{...r?.operation,state:'closing'}}));
   const v=await request(prefix+'queueReviewClose',cloud?{id:p.id,fingerprint:p.fingerprint,confirm:true}:{operation:p.reference.id,fingerprint:p.reference.fingerprint,confirm:true});setResult(cloud?v:nativeOutcome(v));
  }
 }catch(e){setPlan(null);setConfirmed(false);if(action==='list')setList(null);if(['status','close'].includes(action)||action==='apply'&&dispatched)setResult(r=>({...r,operation:{...r?.operation,state:'needs_review'},freshness:'check_failed'}));setError(errors[e.message]??(e.message==='UI_REQUEST_INDEX_UNAVAILABLE'?'无法保存或读取本端请求索引，尚未发出新的确认。请核对浏览器存储权限。':'核验未完成。请手动查询原决定；不会自动重发、删除或启用。'));}finally{flight.current=false;setBusy(false);}}
 return <section className="connection-utility file-queue" aria-label={side+'挂起文件复核'}>
  <div className="file-queue-heading"><div><h3>挂起文件，逐项决定</h3><p>按文件名核对。保留不删除，恢复不等于送达。</p></div><Badge>手动查询</Badge></div>
  <div className="connection-actions"><Button kind="secondary" icon="file" disabled={busy} onClick={()=>act('list')}>查看{side}挂起文件</Button><Button kind="secondary" icon="reset" disabled={busy||!cloud&&!intent} onClick={()=>act('status')}>核对{side}原决定回执</Button></div>
  {list&&<><p className="fine-print">{list.enabled?'当前文件直传已启用，请先在上方独立停用；此处暂不能确认恢复。':'此端已停用。逐项确认后仍保持停用；另行启用才会传输。'}</p><div className="file-queue-list">
   {list.items.map(row=><article className="file-queue-card" key={JSON.stringify(row.item)} aria-label={row.name??'信息待核对的文件'}><div className="file-queue-heading"><h4>{row.name??'文件信息待核对'}</h4><Badge>{labels[row.item.queue]}</Badge></div>
    <p>{row.from?sideName[row.from]+' → '+sideName[row.to]:'方向待核对'} · {row.size===null?'大小待核对':row.size+' 字节'}</p><p>{reasons[row.reason]??'记录仍处于待核对状态'}{row.retained?' · 已选择继续保留':''}</p>
    <p className="fine-print">{row.recoveryCheck==='requires_byte_validation'?'恢复预览还会检查已保存字节、当前上限及目标冲突。':reasons[row.recoveryCheck]??'需保留并人工核对。'}{row.attempts!==null?' 已用重试 '+row.attempts+' 次，不会重置。':''}</p>
    <div className="connection-actions"><Button kind="secondary" icon="pause" disabled={busy||unknown||list.enabled} onClick={()=>act('retain',row)}>预览继续保留</Button><Button kind="primary" icon="play" disabled={busy||unknown||list.enabled||row.recoveryCheck!=='requires_byte_validation'} onClick={()=>act('resume',row)}>预览恢复此文件</Button></div>
   </article>)}
   {!list.items.length&&<Callout>当前没有挂起记录。这不代表所有传输已经送达；成果和收件状态需分别核验。</Callout>}
  </div></>}
  {result&&<div className="connection-result" role="status"><InfoRow label="原决定" value={{not_started:'尚无本端发起的云端决定',sending:'已发起 · 结果待核对',needs_review:'结果未知 · 不自动重发',closing:'关闭请求待核对',closed:'原请求已关闭 · 未因此改变队列',applied:'决定已记账 · 不是送达回执'}[phase]??'需核对'}/>{result.receipt&&<InfoRow label="决定当时的结果" value={result.receipt.decision==='retain'?'继续保留，文件与队列不删除':'恢复原队列，仍需另行启用并核验送达'}/>}<p className="fine-print">{result.freshness==='remote_checked'?'已查询目标端回执。回执不是当前传输进度。':'尚未取得目标端新鲜回执；缓存不能证明当前状态。'}</p></div>}
  {unknown&&<div className="connection-actions"><Button kind="secondary" icon="shield" disabled={busy} onClick={()=>act('closePreview')}>预览关闭未知{side}决定</Button></div>}
  {plan&&<section className="connection-confirm" aria-label={side+'单文件决定确认'}><h3>{plan.kind==='queue_review_close'?'关闭未知请求，不撤销已完成决定':plan.review.decision==='resume'?'只恢复这一个文件的原队列':'继续保留这一个文件'}</h3>
   <InfoRow label="文件" value={plan.review?.name??plan.name??'信息待核对'}/>{(plan.remoteTarget??plan.target)&&<InfoRow label="绑定云端环境" value={(plan.remoteTarget??plan.target).root}/>}
   {plan.review&&<><InfoRow label="方向" value={plan.review.from?sideName[plan.review.from]+' → '+sideName[plan.review.to]:'待核对'}/><InfoRow label="大小" value={plan.review.size===null?'待核对':plan.review.size+' 字节'}/><Callout>{plan.review.decision==='resume'?'只处理原快照和原文件 ID，不重新读取旧来源，不重置次数；仍保持停用，对端须独立确认。':'只记录保留决定，不删除文件、快照或队列，也不执行文件。'}</Callout></>}
   {plan.kind==='queue_review_close'&&<Callout>只阻断这个未知请求的迟到应用。若原决定已完成，会显示真实回执，不假报取消；不改变现有启用状态。</Callout>}
   <CheckRow title={plan.kind==='queue_review_close'?'我确认只关闭未知文件决定，保留现有授权':'我确认只处理此文件，保持停用且不重置次数'} checked={confirmed} disabled={busy} onChange={setConfirmed}/>
   <div className="connection-actions"><Button kind="primary" icon="check" disabled={busy||!confirmed} onClick={()=>act(plan.kind==='queue_review_close'?'close':'apply')}>{plan.kind==='queue_review_close'?'确认关闭原请求':plan.review.decision==='resume'?'确认恢复原队列':'确认继续保留'}</Button><Button kind="secondary" disabled={busy} onClick={()=>{setPlan(null);setConfirmed(false);}}>取消</Button></div>
  </section>}
  {error&&<p className="connection-error" role="alert">{error}</p>}
 </section>;
}
