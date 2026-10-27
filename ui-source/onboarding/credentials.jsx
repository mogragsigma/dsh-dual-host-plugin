import React,{useState,useEffect} from 'react';
import {Panel,Button,Callout,Field,CheckRow,InfoRow,Modal} from './components';
const labels={'deepseek-local':'本端 DeepSeek','deepseek-cloud':'预备云端 DeepSeek','token-plan':'本端阿里云 Token Plan','token-plan-cloud':'预备云端 Token Plan','gitee':'本端 Gitee','gitee-cloud':'预备云端 Gitee'};
export function Credentials({request,onReference,category='model'}){
 const repository=category==='repository';
 const [rows,setRows]=useState([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[editing,setEditing]=useState(null),[secret,setSecret]=useState(''),[confirm,setConfirm]=useState(false),[notice,setNotice]=useState('');
 useEffect(()=>{let live=true;request('secret_status',{}).then(r=>{if(live)setRows(r.slots);}).catch(()=>{if(live)setError('凭据状态未读取；请手动核对后再操作。');});return()=>{live=false;};},[]);
 async function refresh(){setBusy(true);setError('');try{setRows((await request('secret_status',{})).slots);}catch{setError('状态核对失败；不自动重试保存。');}finally{setBusy(false);}}
 const close=()=>{if(busy)return;setEditing(null);setSecret('');setConfirm(false);};
 async function submit(remove){
  if(busy||!confirm||!editing||!remove&&!secret)return;
  setBusy(true);setError('');setNotice('');
  const args={slot:editing.slot,expectedRevision:editing.revision,operation:crypto.randomUUID(),confirm:true,...(!remove?{secret}:{})};
  // No localStorage/sessionStorage, draft field or persistent client state holds the Key.
  setSecret('');
  try{const r=await request(remove?'secret_remove':'secret_put',args);setRows(old=>old.map(x=>x.slot===r.slot?r:x));setNotice(remove?'已移除本项目保存的凭据；其他用户凭据不变。':'已存入当前 Host 官方凭据存储；本次保存不验证有效性、不执行云端交接；交接状态请看第 6 页。');setEditing(null);setConfirm(false);}
  catch{setError('操作结果需核对，可能已保存。请先关闭窗口并手动核对状态，不要直接重复保存；不会自动重试。');}
  finally{args.secret=undefined;setBusy(false);}
 }
 const modal=editing?{title:labels[editing.slot]+'凭据',body:<>
  <p>{repository?"只保存本项目 Gitee API 令牌，不收取或复制 SSH 私钥；不授权仓库写入。":"这里只管理本项目独立记录，不覆盖 DEEPSEEK_API_KEY 等已有用户引用。"}“预备云端”槽位暂存于当前 Host；保存不会自动传送到 ECS，实际交接以第 6 页账本为准。</p>
  <Field label={repository?"Gitee 访问令牌":"API Key"} type="password" value={secret} autoComplete="new-password" spellCheck={false} onChange={e=>setSecret(e.target.value)}/>
  <CheckRow title="我确认保存或移除这个独立凭据" checked={confirm} onChange={setConfirm}/>
  {error&&<p role="alert">{error}</p>}
  <div className="form-actions"><Button disabled={busy||!confirm||!secret||!!error} onClick={()=>submit(false)}>保存凭据</Button>{editing.configured&&<Button disabled={busy||!confirm||!!error} onClick={()=>submit(true)}>移除凭据</Button>}<Button kind="text" disabled={busy} onClick={close}>关闭</Button></div>
 </>}:null;
 return <Panel title={repository?"可选 Gitee 凭据":"安全保存 Key"} icon="key" sub={repository?"公开仓库可不填；私有仓库使用独立受管令牌，不能据此获得业务写入授权。":"手动保存到官方 Host 凭据服务；不会调用模型。"}>
  <Callout>官方默认存储为仅属主可读的本机文件，不是插件加密或 OS 身份隔离。不要把 Key 写入普通表单、聊天、规则或 Skill。</Callout>
  {rows.filter(r=>repository?r.slot.startsWith('gitee'):!r.slot.startsWith('gitee')).map(r=><div className="credential-row" key={r.slot}><InfoRow label={labels[r.slot]} value={r.configured?'已保存 · 不代表连通':'未配置'}/><div className="credential-actions" role="group" aria-label={labels[r.slot]+"凭据操作"}><Button kind="soft" icon="key" disabled={busy||!!error||!r.writable} onClick={()=>{setEditing(r);setConfirm(false);setSecret('');}}>管理凭据</Button>{onReference&&<Button kind="secondary" icon="link" disabled={busy||!r.configured||!!error} onClick={()=>onReference(r.slot,r.reference)}>使用此引用</Button>}</div></div>)}
  <div className="form-actions"><Button kind="secondary" icon="reset" disabled={busy} onClick={refresh}>手动核对凭据状态</Button></div>{notice&&<p role="status">{notice}</p>}{error&&!editing&&<p role="alert">{error}</p>}
  <Modal modal={modal} onClose={close}/>
 </Panel>;
}
