// Generated into bundle/workbench-client.js by scripts/build-ui.py.
// Public DSH slots only. Views never own scheduling, approval, IM, or write permissions.
window.__ModuleLoader__.load({id:'@mogragsigma/dsh-dual-host-plugin',factory:require=>{
 const React=require('react'),h=React.createElement;
 let onboardingView,onboardingRpc,onboardingCreateImBridge,onboardingNativeImManager,onboardingCloudImManager;function getOnboardingView(){if(onboardingView)return onboardingView;
 /*ONBOARDING*/
 onboardingRpc=DSHOnboarding.callOnboarding;onboardingCreateImBridge=DSHOnboarding.createImClientBridge;onboardingNativeImManager=DSHOnboarding.NativeImManager;onboardingCloudImManager=DSHOnboarding.CloudImManager;return onboardingView=DSHOnboarding.Onboarding;}
 const panel='dsh-cloud-workbench',boardPanel='dsh-dual-tasks',boardTab='@mogragsigma/dsh-dual-host-plugin/tasks';
 const css=/*STYLE*/"";
 /*LABELS*/
 /*APPROVAL_WORKBENCH_CLIENT*/
 /*TASK_FOCUS*/
 /*TASK_FOCUS_VIEW*/
 const time=x=>Number.isFinite(x)&&x>0?new Date(x).toLocaleString('zh-CN',{hour12:false}):'时间未记录';
 const paths={panels:'M3 4h18v16H3zM9 4v16M9 10h12',laptop:'M5 4h14v12H5zM3 16h18l1 4H2l1-4Z',cloud:'M6 18a5 5 0 1 1 1-10 6 6 0 0 1 11-1 5.5 5.5 0 0 1 0 11H6Z',link:'M9 8H7a4 4 0 0 0 0 8h2M15 8h2a4 4 0 0 1 0 8h-2M8 12h8',refresh:'M20 10a8 8 0 0 0-14-5L3 8m0-5v5h5M4 14a8 8 0 0 0 14 5l3-3m0 5v-5h-5',timeline:'M5 3v18M3 6h4M3 12h4M3 18h4M11 6h10M11 12h7M11 18h10',window:'M3 4h18v16H3zM3 9h18M6 6.5h.1M9 6.5h.1',search:'M16 16l5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',arrow:'M5 12h14M13 6l6 6-6 6',external:'M14 3h7v7M21 3 11 13M11 4H4v16h16v-7',file:'M5 3h9l5 5v13H5V3ZM14 3v6h5M8 13h8M8 17h6',git:'M6 3v12a4 4 0 0 0 4 4h4M6 7h9a3 3 0 0 0 3-3M3 3h6M15 19h6M16 3h4',shield:'M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3ZM8 12l3 3 5-6',help:'M12 17h.01M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2-3 4M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z',close:'M5 5l14 14M19 5 5 19',message:'M4 4h16v12H9l-5 4V4Z',box:'M3 7l9-4 9 4v11l-9 4-9-4V7ZM3 7l9 5 9-5M12 12v10'};
 function Icon({name='panels',size=20}){return h('svg',{width:size,height:size,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.65,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true},h('path',{d:paths[name]??paths.panels}));}
 const icon=name=>h(Icon,{name});
 const companion=(role,extra='')=>h('div',{className:'companion '+extra,'data-companion':role,'aria-hidden':true});
 const text=(content,className='muted small')=>h('p',{className},content);
 const button=(title,onClick,disabled=false,cls='',name)=>h('button',{type:'button',className:'button '+cls,onClick,disabled},name?icon(name):null,title);
 const badge=state=>h('span',{className:'badge '+(['running','completed','a2a_running','a2a_completed','development_handed_off','development_tested'].includes(state)?'good':['waiting_approval','needs_review','waiting_capability','a2a_draining','a2a_needs_review','a2a_drain_unknown','a2a_expired','development_review','development_evidence_missing','development_approval_review','development_runtime_unavailable','development_draining','delivery_review','delivery_draining','delivery_state_unavailable'].includes(state)?'wait':'neutral')},label(state));
 const state=t=>t.display_state??(t.coordination.blocked?'task_blocked':t.coordination.busy?'task_busy':t.jobs[0]?.reason??'registered');
 function InfoHelp({title,children}){
  const dialog=React.useRef(),trigger=React.useRef(),id=React.useId(),[expanded,setExpanded]=React.useState(false);
  return h(React.Fragment,null,h('button',{type:'button',ref:trigger,className:'info-help','aria-label':title+'说明','aria-haspopup':'dialog','aria-controls':id,'aria-expanded':expanded,onClick:()=>{dialog.current.showModal();setExpanded(true);}},icon('help')),
   h('dialog',{id,ref:dialog,className:'about-dialog help-dialog','aria-label':title+'说明',onClose:()=>{setExpanded(false);trigger.current?.focus();},onClick:e=>{if(e.target===e.currentTarget)dialog.current.close();}},h('div',{className:'dialog-header'},h('h2',null,title),h('button',{type:'button',className:'icon-button','aria-label':'关闭说明',onClick:()=>dialog.current.close()},icon('close'))),text(children,'')));
 }
 const moduleHead=(title,description,role)=>h('header',{className:'module-header'},h('div',{className:'heading-with-help'},h('h2',null,title),description?h(InfoHelp,{title},description):null),companion(role));
 // Presentation only: paginate the bounded snapshot already supplied by the Host.
 function PaginatedTimeline({items,render,label,empty,limit=5}){
  const [page,setPage]=React.useState(0),total=items.length,pages=Math.max(1,Math.ceil(total/limit)),current=Math.min(page,pages-1);
  React.useEffect(()=>setPage(0),[items]);
  return h('div',{className:'paged-timeline'},h('ol',{className:'timeline','aria-label':label},...items.slice(current*limit,(current+1)*limit).map(render)),!total?text(empty,'empty-list'):null,
   h('nav',{className:'pagination','aria-label':label+'翻页'},button('上一页',()=>setPage(current-1),current===0),text(`已加载 ${total} 条 · ${current+1}/${pages} 页`),button('下一页',()=>setPage(current+1),current===pages-1)));
 }
 function repositoryNotice(r){
  if(!r||r.state==='unbound')return null;
  const errors={
   REPOSITORY_ACCESS_DENIED:['访问权限待核对','上次核验未获访问权限；历史成功记录不证明当前仍可访问。'],
   REPOSITORY_NOT_FOUND_OR_PRIVATE:['仓库／分支不可见','仓库或分支不存在，或当前凭据不可见；不能据此断言已被删除。'],
   REPOSITORY_BASELINE_CHANGED:['关联基线已变化','仓库身份、分支或基线变化；需要重新核对关联与审批。'],
   REPOSITORY_IDENTITY_MISMATCH:['仓库身份不匹配','返回的仓库身份不匹配；不能沿用旧关联授权。'],
   REPOSITORY_RATE_LIMIT:['核验遇到限流','平台限制了请求；核验未完成，不代表权限被撤销。'],
   REPOSITORY_PROVIDER_UNAVAILABLE:['仓库服务暂不可达','上次未能连接仓库服务；当前访问能力未知。'],
   REPOSITORY_RESPONSE_INVALID:['核验响应异常','上次返回的数据无法核验；不代表仓库可正常访问。'],
   REPOSITORY_RESPONSE_TOO_LARGE:['核验响应超限','上次返回的数据超过核验限制；尚未确认当前访问能力。'],
   REPOSITORY_BRANCH_RESPONSE_INVALID:['分支核验异常','上次分支响应无法核验；不沿用为当前基线。']
  };
  if(r.error){const pair=errors[r.error]??['核验失败待核对','上次核验失败，原因未能安全识别；不要据此重试写入。'];return {label:pair[0],detail:pair[1]};}
  if(r.state==='changed')return {label:'关联已变化',detail:'仓库关联已变化，需要重新核对关联与审批。'};
  if(!r.verification_fresh)return {label:'历史核验待更新',detail:'仅有历史核验记录；当前访问权限与基线尚未重新核验。'};
  return null;
 }
 function RepositoryEvidence({repository:r}){
  const notice=repositoryNotice(r);
  return h('details',{className:'evidence'},h('summary',null,'Gitee 关联详情（可选）'),
   text(r.state==='unbound'?'未关联仓库，不影响任务展示或只读规划。':`${r.url} · ${r.branch}`),
   r.url?text(`关联第 ${r.revision} 版 · ${r.state} · ${r.verification_fresh?'近期核验':'历史核验，未在线刷新'} ${time(r.verified_at)} · 基线 ${r.base_sha?.slice(0,12)??'未知'} · ${r.workspace==='managed_binding_recorded'?'受管检出另行核验':'未登记受管检出'}；仓库关联本身不授权写入`):null,
   notice?text(notice.label+'：'+notice.detail,'warning'):null,
   notice?text('页面刷新只读取已保存记录，不重新访问 Gitee；可按任务名称请求重新核验仓库。'):null);
 }
 function useSnapshot(reader){
  const [snap,setSnap]=React.useState(null),[error,setError]=React.useState(null),[busy,setBusy]=React.useState(false);
  const seq=React.useRef(0),alive=React.useRef(true),args=React.useRef(null),read=React.useRef(reader);read.current=reader;
  React.useEffect(()=>{alive.current=true;return()=>{alive.current=false;seq.current++;};},[]);
  async function load(next){
   args.current=next;const n=++seq.current;setBusy(true);
   try{const value=await read.current(next);if(alive.current&&n===seq.current){setSnap({value,at:performance.now()});setError(null);}}
   catch(e){if(alive.current&&n===seq.current)setError(e);}
   finally{if(alive.current&&n===seq.current)setBusy(false);}
  }
  function reset(){seq.current++;setSnap(null);setError(null);setBusy(false);args.current=null;}
  return {snap,error,busy,load,reset,args};
 }
 // Only a local expiry label timer. Never fetch, replay, or navigate from a timer.
 function useFresh(snap,error){
  const [expired,setExpired]=React.useState(true);
  React.useEffect(()=>{
   if(!snap){setExpired(true);return;}
   const remaining=30000-(performance.now()-snap.at);setExpired(remaining<=0);
   const timer=setTimeout(()=>setExpired(true),Math.max(0,remaining));return()=>clearTimeout(timer);
  },[snap]);
  return !!snap&&!error&&!expired&&performance.now()-snap.at<30000;
 }
 function Menu({role,launch,showAbout,opening}){
  const [expanded,setExpanded]=React.useState(false),root=React.useRef(),trigger=React.useRef();
  React.useEffect(()=>{if(!expanded)return;const outside=e=>{if(!root.current?.contains(e.target))setExpanded(false);};document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside);},[expanded]);
  const close=()=>{setExpanded(false);trigger.current?.focus();};
  return h('div',{className:'host-picker',ref:root,onKeyDown:e=>{
   if(e.key==='Escape'){e.preventDefault();close();}
   if(e.key==='Tab')setExpanded(false);
   if(expanded&&['ArrowDown','ArrowUp','Home','End'].includes(e.key)){
    e.preventDefault();const items=[...root.current.querySelectorAll('[role=menuitem]:not(:disabled)')],i=items.indexOf(document.activeElement);
    items[e.key==='Home'?0:e.key==='End'?items.length-1:(i+(e.key==='ArrowUp'?-1:1)+items.length)%items.length]?.focus();
   }
  }},h('button',{className:'button host-trigger',ref:trigger,'aria-label':'访问端与工作台菜单','aria-haspopup':'menu','aria-expanded':expanded,onClick:()=>setExpanded(!expanded)},icon(role==='cloud'?'cloud':'laptop'),role==='cloud'?'云端访问端':role==='local'?'本地访问端':'访问端待核验'),expanded?h('div',{className:'host-menu',role:'menu','aria-label':'工作台入口'},text('身份由当前 Host 决定，不能在页面伪装切换'),h('button',{role:'menuitem',disabled:opening,onClick:()=>{close();launch();}},icon('window'),role==='cloud'?'返回云端原生会话':'打开云端 Web'),h('button',{role:'menuitem',onClick:()=>{close();showAbout();}},icon('shield'),'界面与权限说明')):null);
 }
 function About({dialog,role}){return h('dialog',{ref:dialog,'aria-label':'界面与权限说明',className:'about-dialog'},h('div',{className:'dialog-header'},h('h2',null,'连接与操作边界'),h('button',{className:'icon-button','aria-label':'关闭说明',onClick:()=>dialog.current.close()},icon('close'))),
  h('ul',{className:'mini-list'},h('li',null,'当前访问端',h('strong',null,role==='cloud'?'云端':role==='local'?'本地':'待核验')),h('li',null,'通信路径',h('strong',null,'自有插件直连')),h('li',null,'工作区入口',h('strong',null,role==='cloud'?'原生会话导航':'本地安全代理')),h('li',null,'状态获取',h('strong',null,'手动刷新'))),
  text('本地与云端使用同一套界面。刷新按钮读取新快照；没有展示轮询，也不会暂停底层心跳、消息恢复或持久调度。',''),
  text('状态、配对和打开原生 Web 均不等于审批；工作台内保存决定须验证身份，实际执行仍须逐任务核验审批、预算与门禁；自动发布关闭。原生 Web 保留 DSH 原有权限，不是全局只读沙箱。',''),
  text('成果文件、执行会话、任务检查点分别展示。Gitee 绑定不等于已有成果；未登记文件不生成成果链接；仅已登记报告可明确点击下载；Gitee 成果使用页面入口，不内嵌预览或自动上传。',''),
  text('角色参考你提供的蓝色大肥鱼形象制作，用于模块识别；不是官方授权标识，也不代表任务状态。',''));
 }
 function safeGiteeURL(value){const u=new URL(value);if(u.protocol!=='https:'||u.hostname!=='gitee.com'||u.port||u.username||u.password||u.search||u.hash||!/^\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\/(?:blob\/[a-f0-9]{40}\/.+|commit\/[a-f0-9]{40})$/.test(u.pathname))throw Error('ARTIFACT_URL_REJECTED');return u.href;}
 const artifactErrors={CAPABILITY_UNAVAILABLE:'两端尚未提供这项成果能力，请核对版本与启用状态。',CAPABILITY_VERSION_INCOMPATIBLE:'两端成果能力版本不一致，请先核对版本。',ARTIFACT_STALE_DOWNLOAD:'成果版本或运行状态已变化，请刷新核对；本次未下载。',ARTIFACT_PAGE_ONLY:'该成果只支持 Gitee 页面入口，未下载文件。',ARTIFACT_BROWSER_ORIGIN_REQUIRED:'当前访问来源无法核验，未提供下载；请使用受支持的已登录工作台。',ARTIFACT_BROWSER_CRYPTO_REQUIRED:'当前容器不能核验文件摘要，未下载；可查看执行会话。',ARTIFACT_DOWNLOAD_CHANGED:'下载内容与选定成果不一致，已停止保存。',ARTIFACT_DOWNLOAD_INVALID:'下载响应不可信，已停止保存。',ARTIFACT_PROVIDER_COMMIT_INVALID:'远端提交、树或父提交不匹配',ARTIFACT_DELIVERY_EVIDENCE_INVALID:'交付证据不完整，不能提供入口',ARTIFACT_FILE_MISSING:'文件已不存在',ARTIFACT_FILE_CHANGED:'文件内容或大小已改变',ARTIFACT_FILE_REPLACED:'文件已被替换',ARTIFACT_FILE_PERMISSIONS:'文件权限或链接不安全',ARTIFACT_DIRECTORY_UNSAFE:'成果目录归属不安全',ARTIFACT_PROVIDER_FILE_INVALID:'远端文件类型或内容不可信',REPOSITORY_NOT_FOUND_OR_PRIVATE:'远端文件不存在或当前凭据不可见',REPOSITORY_ACCESS_DENIED:'远端读权限失效',REPOSITORY_PROVIDER_UNAVAILABLE:'远端暂时不可用',REPOSITORY_RATE_LIMIT:'远端请求受限',ARTIFACT_SESSION_UNAVAILABLE:'执行会话映射不可用'};
 const artifactStates={delivery_evidence_invalid:'交付证据已失效，禁止跳转',needs_verification:'待点击核验',verified:'本次核验通过',pending_run:'等待批次持久完成',failed_run:'批次未成功，成果不可访问',stale_revision:'任务已修订，成果已失效',owner_mismatch:'文件归属不匹配',repository_changed:'仓库关联已改变',file_changed:'文件内容已改变',unavailable:'当前不可访问'};
 /*ARTIFACT_DOWNLOAD_CLIENT*/
 function ArtifactFiles({item,access,open,fresh,download}){
  const [observed,setObserved]=React.useState({}),[busy,setBusy]=React.useState(null),[error,setError]=React.useState('');const alive=React.useRef(true),generation=React.useRef(0),locked=React.useRef(false);
  React.useEffect(()=>{alive.current=true;generation.current++;setObserved({});setBusy(null);setError('');return()=>{alive.current=false;generation.current++;};},[item]);
  const items=item.artifacts?.items??[];
  async function act(a,action){
   if(busy||locked.current||!fresh)return;locked.current=true;const gen=generation.current;setBusy(a.id);setError('');
   try{
    if(action==='download'){
     // No model context sees these bytes; a response from an abandoned task cannot trigger a save.
     if(download){await download(a);return;}
     const r=await access('download',{task_id:item.task_id,artifact_id:a.id,expected_revision:item.spec_revision,expected_sha256:a.sha256});
     const bytes=await decodeArtifactDownload(r,a);
     if(!alive.current||gen!==generation.current)return;
     const saved=saveArtifactDownload(bytes,a.name);setObserved(old=>({...old,[a.id]:{...r,content:undefined,download_message:saved.message}}));return;
    }
    const r=await access(action,{task_id:item.task_id,artifact_id:a.id});if(!alive.current||gen!==generation.current)return;
    if(r.url)r.url=safeGiteeURL(r.url);setObserved(old=>({...old,[a.id]:r}));
    if(r.artifact.state==='verified'&&action==='session'){
     if(!/^task-worker-[a-f0-9-]{36}$/.test(r.session_id??''))throw Error('ARTIFACT_SESSION_UNAVAILABLE');await open(r.session_id);
    }
   }catch(e){if(alive.current&&gen===generation.current){if(artifactErrors[e.message])setObserved(old=>({...old,[a.id]:{artifact:{...a,state:'unavailable'},error:e.message}}));else{setObserved(old=>({...old,[a.id]:{artifact:{...a,state:'unavailable'}}}));setError('成果入口暂不可用；未确认本次保存或跳转，请核对连接后再手动操作。');}}}
   finally{locked.current=false;if(alive.current&&gen===generation.current)setBusy(null);}
  }
  if(!items.length)return h('div',{className:'empty-artifact'},h('strong',null,item.artifacts?.state==='evidence_unavailable'?'交付成果证据待核对':'暂无已登记成果'),text('成果登记后会在这里显示。执行未结束或失败时，不把检查点冒充成果。'));
  return h('section',{className:'artifact-files','aria-label':'已登记成果'},...items.map(a=>{
   const r=observed[a.id],state=r?.artifact.state??a.state,delivered=a.kind==='gitee_delivery',gitee=a.kind==='gitee'||delivered;
   const intro=a.description??(a.kind==='gitee'?'此成果关联仓库中已存在的文件。尚未填写内容介绍；请在 Gitee 查看原文件。':'独立 worker 留存的任务报告。尚未填写内容介绍；请查看对应执行会话。');
   return h('article',{className:'artifact-card',key:a.id},h('h4',null,icon(gitee?'git':'file'),a.name),text(intro,'artifact-introduction'),
    h('details',{className:'artifact-provenance'},h('summary',null,'来源与版本'),text('所属任务：'+item.title+' · 第 '+a.spec_revision+' 版'),
    a.kind==='report'&&item.delivery?.execution?.total>0?text('报告登记于 '+time(a.created_at)+'；说明反映当时阶段，后续提交与推送请看交付账本。'):null,
    text((delivered?'本任务交付 · 推送账本记录':a.kind==='gitee'?'Gitee 已有文件 · 非本次生成':'独立 worker 报告 · 非仓库成果')+(a.description?' · 介绍来源：'+(a.description_source==='delivery_ledger'?'交付账本':a.description_source==='direct_user'?'用户原文':'worker'):' · 介绍待补充')),
    gitee?text((delivered?a.repository.branch:a.repository.path)+' · 提交 '+a.repository.commit.slice(0,12)):null),
    h('p',{className:state==='verified'?'small':'small muted',role:'status'},artifactStates[state]??state,r?.checked_at?' · '+time(r.checked_at):null),
    r?.error?text((artifactErrors[r.error]??r.error)+' · 本次未提供文件或跳转','warning'):null,r?.download_message?text(r.download_message,'small'):null,
    h('div',{className:'artifact-actions'},!gitee?button(busy===a.id?'处理中…':'下载文件',()=>act(a,'download'),!!busy||!fresh||!['needs_verification','verified'].includes(state),'','file'):null,button(busy===a.id?'核验中…':'重新核验',()=>act(a,'check'),!!busy||!fresh),gitee?button('核验 Gitee 入口',()=>act(a,'gitee'),!!busy||!fresh,'','shield'):button('查看执行会话',()=>act(a,'session'),!!busy||!fresh,'','message'),r?.url&&state==='verified'&&fresh&&!busy?h('a',{className:'button primary',href:r.url,target:'_blank',rel:'noopener noreferrer',referrerPolicy:'no-referrer'},icon('external'),'在 Gitee 查看'):null));
  }),item.artifacts?.delivery_unavailable||item.artifacts?.delivery_error?text('部分交付证据不完整，未生成跳转入口；请先核对交付账本。','warning'):null,item.artifacts?.truncated?text('仅显示最近 100 项成果；历史条目仍可按任务查询。'):null,text('报告可明确点击下载，保存前重新核验归属、版本、权限与摘要；不自动下载或上传。Gitee 成果只跳转固定版本页面，使用你的登录独立鉴权。'),error?text(error,'warning'):null);
 }
 function TaskConversationQuery({item}){
  const [shown,setShown]=React.useState(false),[message,setMessage]=React.useState('');const field=React.useRef(null),alive=React.useRef(true);
  React.useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const query='请查询任务'+JSON.stringify(item.title)+'的当前进度、成果物和待我处理的事项。只查询，不恢复、批准或重试任务。';
  async function copy(){try{await navigator.clipboard.writeText(query);if(alive.current)setMessage('已复制。请粘贴到你选择的 DSH 对话或本地机器人聊天；尚未发送。');}catch{if(alive.current){field.current?.select();setMessage('自动复制不可用，请复制下方文字。没有发送消息。');}}}
  return h('div',{className:'task-query-helper'},button(shown?'收起对话提问':'在对话中查询',()=>setShown(!shown),false,'plain','message'),shown?h('div',null,text('可在任意现有 DSH 会话或已配置的机器人对话提问，不要求固定 session。同名任务会先请你区分；审批仍在本任务工作台处理。','small'),h('textarea',{'aria-label':'对话查询文字',ref:field,readOnly:true,value:query,rows:3}),button('复制提问',copy,false,'','message'),message?text(message,'small'):null):null);
 }
 function NotificationArtifact({taskId,delivery,request,fresh}){
  const entry=useSnapshot(async()=>{const r=await request('notification-artifact-access',{task_id:taskId,notification_id:delivery.id});if(r.url)r.url=safeNotificationURL(r);return r;}),live=useFresh(entry.snap,entry.error),r=entry.snap?.value,a=delivery.artifact_delivery?.artifact;
  return h('div',{className:'notification-artifact'},text(a?.name??'已登记成果','artifact-introduction'),text(a?.description??'介绍待补充'),
   button(entry.busy?'核验中…':'核验手机成果入口',()=>entry.load(),entry.busy||!fresh||delivery.state!=='accepted','','shield'),
   entry.error?text('本次未提供入口：'+entry.error.message,'warning'):null,
   r&&live&&fresh&&!entry.busy?r.url?h('a',{className:'button primary',href:r.url,target:'_blank',rel:'noopener noreferrer',referrerPolicy:'no-referrer'},icon('external'),r.kind==='gitee'?'在 Gitee 查看':r.link_scope==='message_position'?'在飞书查看此成果':'打开原飞书会话'):text('请在'+(r.sender_host==='local'?'本地':'云端')+'工作台核验发送端记录；不冒充已核实外部消息。'):null,
   r&&live&&fresh?text('核验时间：'+time(r.provider_checked_at??r.checked_at)+' · 外部账户独立鉴权，不代表已读'):null,
   text('上传副本由飞书权限控制；停止通知不能撤回已经上传的文件。页面不自动发送或上传。'));
 }
 function safeNotificationURL(r){
  if(r.kind==='gitee')return safeGiteeURL(r.url);
  const u=new URL(r.url),q=u.searchParams;
  if(r.kind!=='feishu_attachment'||u.protocol!=='https:'||u.hostname!=='applink.feishu.cn'||u.port||u.username||u.password||u.hash||u.pathname!=='/client/chat/open'||[...q.keys()].some(k=>!['openChatId','position'].includes(k))||q.getAll('openChatId').length!==1||!/^oc_[A-Za-z0-9_-]{4,128}$/.test(q.get('openChatId')??'')||q.has('position')&&(q.getAll('position').length!==1||!/^[0-9]{1,16}$/.test(q.get('position'))))throw Error('ARTIFACT_URL_REJECTED');
  return u.href;
 }
 function Notifications({item,request,viewerRole,fresh}){
  const n=item.notifications,b=n?.binding,scan=useSnapshot(args=>request('notification-discover',args));
  const states={media_queued:'成果等待发送端',media_leased:'成果已领取',media_dispatching:'上传或发送中／等待回执',queued:'等待发送端',leased:'已领取，等待发送',dispatching:'发送中／等待回执',accepted:'接口已接受',needs_review:'需要核对',cancelled:'已取消'};
  const reasons={NOTIFICATION_ENDPOINT_STATE_LOST:'发送端持久记录缺失，无法排除已发送；先核对，不重发',NOTIFICATION_UPLOAD_RESULT_UNKNOWN:'上传结果未知；未必已经发消息，先核对，禁止盲重试',NOTIFICATION_MEDIA_CAPABILITY_UNAVAILABLE:'所选渠道未提供图片／文件能力，不会降级成文本发送',NOTIFICATION_MEDIA_PREFLIGHT_WAIT:'成果发送前检查暂不可用，有限等待',NOTIFICATION_ARTIFACT_OR_PROVIDER_UNAVAILABLE:'成果或渠道不可用，需要核对，未自动重试',NOTIFICATION_AWAITING_LOCAL_ENDPOINT:'等待本地发送端领取；不能仅凭队列判定 Mac 离线',NOTIFICATION_AWAITING_CLOUD_ENDPOINT:'等待云端发送端领取',NOTIFICATION_ENDPOINT_PROCESSING:'发送端已领取，尚未越过发送边界',NOTIFICATION_WAITING_FOR_RECEIPT:'发送可能已发生，正在等待持久回执',NOTIFICATION_SEND_RESULT_UNKNOWN:'结果未知，请先核对外部会话，不要重发',NOTIFICATION_CAPABILITY_UNAVAILABLE:'当前渠道或账号不支持所需的受检发送能力',NOTIFICATION_ROUTE_CHANGED:'目标身份或路由已变化，需要重新核验',NOTIFICATION_AUTHORIZATION_ENDED:'通知授权或任务修订已变更',NOTIFICATION_SUPERSEDED_SNAPSHOT:'已由更新的进度或结果快照替代',NOTIFICATION_BACKOFF:'发送前暂时拒绝，正在有限退避'};
  const events={artifact:'成果交付',result:'结果',attention:'待你处理',progress:'进度'};
  const discovery=scan.snap?.value;
  return h('section',{className:'evidence notifications','aria-label':'任务通知与回执'},h('div',{className:'planning-heading'},h('h3',null,icon('message'),'任务通知与回执'),h('span',{className:'badge neutral'},'手动读取 · 不发送')),
   text('这是投递状态，不是审批记录；接口接受不代表已读，批次结束也不等于长期目标完成。'),
   !n?text('当前连接未提供通知账本，不能判断是否已经发送。'):!n.managed?text('历史任务尚未迁入任务级通知契约；不会自动改投或补发。'):!b?text('此任务未授权通知目标。结果仍可查询，不会发送到默认群。'):h('div',{className:'notification-binding'},h('strong',null,b.target?.label??'目标当前不可用'),h('span',{className:'badge '+(b.effective?'good':'wait')},b.effective?'通知已启用':b.state==='disabled'?'通知已停用':'授权需重新核对'),text(`${b.target?.host==='local'?'由本地发送':'由云端发送'} · 任务第 ${b.task_revision} 版 · 绑定第 ${b.revision} 版`),text('通知内容：'+(b.policy?.events??[]).map(e=>events[e]??e).join('、')+(b.policy?.events.includes('progress')?` · 进度至少间隔 ${b.policy.progress_interval_seconds} 秒`:''))),
   h('ol',{className:'timeline inner-timeline notification-timeline','aria-label':'通知投递时间线'},...(n?.deliveries??[]).map(d=>h('li',{className:'timeline-row',key:d.id},h('article',{className:'notification-card'},h('div',{className:'plan-card-heading'},h('h4',null,events[d.category]??'任务状态'),h('span',{className:'badge '+(d.state==='accepted'?'good':d.state==='needs_review'?'wait':'neutral')},states[d.state]??'未知状态')),text(time(d.created)+' · '+(d.host==='local'?'本地发送端':'云端发送端')),d.proof?text(d.proof==='provider_message'?'有平台消息号；不代表送达或已读':'仅 SDK 成功返回；没有平台消息号，尚未核实聊天可见'):null,d.artifact_delivery?h(NotificationArtifact,{taskId:item.task_id,delivery:d,request,fresh}):null,d.waiting_reason?text(reasons[d.waiting_reason]??('等待原因：'+d.waiting_reason),'notification-reason'):null,d.review?h('div',{className:'notification-review'},text('人工核对：'+({seen:'反馈已看到',not_seen:'反馈未看到（不等于未发送）',not_checked:'尚未查看'}[d.review.observation]??'未说明')+' · '+(d.review.state==='closed'?'已结案，不重发':'仍待核对')),text(d.review.note),text('原始平台证据未改变；人工反馈不是平台回执。')):d.state==='needs_review'?text('请先核对外部会话；可用任务名说明已看到、未看到或无需重发，当前不会自动重试。','warning'):null)))),
   n&&!n.deliveries?.length?text('暂无任务级投递记录。此处不会读取或重放旧聊天记录。'):null,
   h('details',{className:'notification-discovery'},h('summary',null,'发现可用通知目标'),text('只读取 IM 已保存的目标及当前能力，不读取聊天历史、不发送测试消息、不修改 IM 设置。目标存在不等于获准接收此任务。'),
    h('div',{className:'notification-actions'},button(scan.busy?'核验中…':'读取云端目标',()=>scan.load({host:'cloud'}),scan.busy),button('读取本地目标',()=>scan.load({host:'local'}),scan.busy||viewerRole!=='local')),
    viewerRole!=='local'?text('本地目标请在 Mac 的大肥鱼bot手动读取；云端不会冒充离线 Mac。'):null,
    scan.error?text('目标未更新：'+scan.error.message,'warning'):null,
    discovery?text('读取时间：'+time(discovery.observed_at)+' · '+(discovery.host==='local'?'本地':'云端')+' · '+(discovery.state==='available'?'已读取':discovery.state==='partial'?'部分能力不可用':'当前不可用')):null,
    ...(discovery?.accounts??[]).filter(a=>a.state==='unavailable').map((a,i)=>h('p',{key:i,className:'small warning'},`${a.name??a.channel??'账号'}：${a.error??'账号未就绪或不支持受检发送'}`)),
    discovery?.items?.length?h('ul',{className:'notification-targets'},...discovery.items.map((x,i)=>h('li',{key:x.candidate_id??i},h('strong',null,x.label),text(`${x.account} · ${x.channel} · ${x.kind==='group'?'群聊':x.kind==='user'?'私聊':'其他目标'}`),text(x.eligible?(x.receipt_mode==='message'?'支持受检文本及平台消息号':'支持受检文本；仅 SDK 接受回执'):'当前不能添加为受检通知目标')))):discovery?text(discovery.state==='available'?'未发现已保存的通知目标；不是平台没有会话。':'未取得完整候选，不能当作没有目标。'):null,
    discovery?.truncated?text('候选超过展示上限；请缩小 IM 中已保存目标范围后重新读取。'):null,
    text('在对话中按目标名称添加为本项目通知目标，再明确要通知哪个任务及哪些事件。重名时先澄清，不需要手填内部编号。'),text('公开 IM 服务能力按账号核验；图片／文件仅限显式配置的自有飞书通道，须逐成果另行授权。其他渠道不自动降级或切换。')));
 }
 const endpointName=role=>role==='local'?'本地大肥鱼':role==='cloud'?'云端大肥鱼':'未知端';
 const a2aRequestState=s=>({queued:'等待指定端领取',claimed:'已领取 · 尚未执行',running:'独立执行中',stopping:'停止中 · 尚未排空',completed:'答复已记账',needs_review:'待核对 · 不自动重试',timed_out:'应答超时',paused:'排队已暂停',cancelled:'已停止'}[s]??'未知状态');
 function Collaboration({item,openA2A,viewerRole,fresh}){
  const a=item.a2a,[busy,setBusy]=React.useState(false),[error,setError]=React.useState(null);
  async function view(r){setBusy(true);setError(null);try{await openA2A({...r,task_id:item.task_id},viewerRole);}catch{setError('未能打开所属执行会话；会话可能尚未保存、已移除或连接不可用。没有重试任务。');}finally{setBusy(false);}}
  const budget=(used,max,title)=>h('div',{className:'plan-budget'},h('div',{className:'budget-caption'},h('strong',null,title),h('span',null,`${used} / ${max}`)),h('meter',{min:0,max,value:used,'aria-label':title}),text('已用额度，不是完成百分比；失败与未知结果不退款。'));
  return h('section',{className:'evidence a2a-section','aria-label':'双端协作'},h('div',{className:'planning-heading'},h('h3',null,icon('link'),'双端协作'),h('span',{className:'badge neutral'},'独立会话 · 手动读取')),
   text('每一轮只在指定端执行；对端答复不是你的批准。这里只读，不开始、恢复或授权开发。'),error?text(error,'warning'):null,
   !a?.available?text('此连接暂未提供协作账本，不能视为没有协作。'):!a.total?text('尚无双端协作授权；普通任务不需要启用 A2A。'):null,
   ...(a?.items??[]).map(g=>h('article',{className:'plan-card',key:g.id},h('div',{className:'plan-card-heading'},h('h4',null,`任务第 ${g.spec_revision} 版${g.spec_revision!==item.spec_revision?' · 历史授权':''}`),badge(g.state)),text('授权截至 '+time(g.budget.end_at)),g.reason?text('等待／停止原因：'+g.reason,'notification-reason'):null,
    h('div',{className:'a2a-budgets'},budget(g.budget.turns,g.budget.max_turns,'共享轮次已用'),budget(g.budget.model_requests,g.budget.max_model_requests,'模型派发预留')),
    text('本地请求模型：'+model(g.models.local)),text('云端请求模型：'+model(g.models.cloud)),
    h('ol',{className:'timeline inner-timeline a2a-timeline','aria-label':'双端关联答复时间线'},...g.requests.map((r,index)=>h('li',{className:'timeline-row',key:r.id},h('article',{className:'a2a-card'},h('div',{className:'plan-card-heading'},h('h4',null,`第 ${index+1} 轮 · ${endpointName(r.to)}`),h('span',{className:'badge neutral'},a2aRequestState(r.state))),text(time(r.created)+' · '+(r.parent_id?'承接第 '+(g.requests.findIndex(x=>x.id===r.parent_id)+1)+' 轮答复':'首条请求')),
     text(r.drained?'该轮执行已排空；不是当前整端空闲。':r.state==='queued'||r.state==='claimed'?'尚未取得执行完成证据。':'尚未证实排空；不得据此交接写入。'),r.error?text('等待／失败原因：'+r.error,'warning'):null,
     r.result?h('div',{className:'a2a-result'},h('strong',null,'已登记答复'),text(r.result.summary,'artifact-introduction'),r.result.followup?text('交给对端的后续请求：'+r.result.followup):null,...r.result.evidence.map((e,i)=>text(`来源：${endpointName(e.host)} · ${e.title} · ${e.size} 字节 · ${time(e.read_at)}`))):text('尚无已登记答复；不以预算消耗推定完成。'),
     r.late_result?h('details',null,h('summary',null,'迟到答复 · 仅留证，不继续执行'),text(r.late_result.summary,'artifact-introduction')):null,
     h('details',{className:'a2a-models'},h('summary',null,`实际模型观测 · ${r.model_calls.length} 条`),text('派发意图不等于成功；流结束也不代表任务或工具成功。进行中记录可能尚未送达云端。'),...r.model_calls.map((m,i)=>h('div',{className:'record',key:i},text(model(m)),text(({stream_ended:'模型流已结束',stream_failed:'模型流失败',stream_interrupted:'模型流被中断',unknown_after_restart:'重启后结果未知'}[m.stage]??'派发阶段未知')+' · '+(m.finish_kind??'没有结束标记')),text(time(m.started_at)+(m.ended_at?' → '+time(m.ended_at):''))))),
     r.session_id?(r.to==='local'&&viewerRole!=='local'?text('本地执行会话请在本地工作台查看；云端不冒充 Mac。'):button(busy?'核验会话…':'查看'+(r.to==='local'?'本地':'云端')+'执行会话',()=>view(r),busy||!fresh,'','message')):text('尚无所属会话，不生成导航入口。'))))),
    !g.requests.length?text('授权已登记，尚未开始。'):null)),
   a?.total>a?.items.length?text(`展示最近及待核对授权 ${a.items.length} / ${a.total} 项，当前修订优先。`):null);
 }
 const peerState=s=>({pending:'本端已入队 · 待云端受理',cloud_queued:'云端已排队 · 未持权',claiming:'领取写入权 · 回执未定',active:'本端已保存票据 · 不是执行证明',finishing:'正在确认交接',reviewing:'正在核对恢复回执',needs_review:'本端回执待核对 · 不重发',completed:'本端已记下完成回执',cancelled:'本端请求已取消'}[s]??'本端状态未知');
 const devEvent=e=>({queued:'写入请求已登记',acquired:'取得受管写入权',write_tool_called:'写入调用已记账',write_intent:'写入意图已保存',write_applied:'文件写入已记账',test_intent:'测试意图已保存',test_drained:'受管测试进程已关闭',tested:e.passed?'固定测试已通过':'固定测试未通过',blocked:'保留围栏 · 等待核对',safe_point:'受管 I/O 交接完成',bridge_review_applied:'原请求已核对 · 票据换代',rejected:'写入请求已停止'}[e.type]??'账本事件');
 function Development({item,peer,fresh,viewerRole}){
  const d=item.development;
  return h('section',{className:'evidence development-section','aria-label':'受管写入与交接'},
   h('div',{className:'planning-heading'},h('h3',null,icon('shield'),'受管写入与交接'),h('span',{className:'badge neutral'},fresh?'只读账本快照':'历史快照 · 不判断空闲')),
   text('排队、持权、测试与交接分别记账。持权不表示模型正在执行；完成只限受管云端 I/O，不等于整个任务或本地进程树结束。'),
   !d?.available?text('当前连接未提供写入请求账本，不能视为没有请求。'):!d.total?text('没有受管写入请求；普通任务和无仓库任务照常展示。'):null,
   ...(d?.items??[]).map(r=>h('article',{key:r.id,className:'plan-card development-card'},h('div',{className:'plan-card-heading'},h('h4',null,endpointName(r.node)+' · 受管写入'),badge(r.state)),
    text(`任务第 ${r.spec_revision??'未知'} 版${r.spec_revision!==item.spec_revision?' · 历史修订':''} · 登记于 ${time(r.created)}`),
    text('请求模型：'+model(r.requested_model)),text('审批观测：'+label(r.approval_state)+' · 每次执行仍重新核验'),
    h('dl',{className:'development-facts'},h('dt',null,'工作区'),h('dd',null,r.workspace==='identity_missing'?'缺少身份记录 · 待核对':'云端受管检出 · 身份已记账，未在刷新时重验'),h('dt',null,'测试排空'),h('dd',null,!r.operations.available?'缺少操作记录':r.operations.unclosed?`${r.operations.unclosed} 个操作未关闭 · 禁止据此交接`:r.operations.total?`${r.operations.total} 个操作已关闭 · 不是整端空闲`:'尚无测试操作记录 · 不据此判断排空'),h('dt',null,'写入预算'),h('dd',null,r.budget?`同一审批累计记录 ${r.budget.writes_recorded} / ${r.budget.max_writes??'?'} 次 · 调用已用 ${r.budget.write_calls??'未知'} 次`:'无法核验预算，不推定有剩余额度')),
    r.test?text(r.test.passed&&r.test.matches_file?(r.test.validator==='approved-commands-v1'?`批准验收命令 ${r.test.required_commands??'未知'} 项通过 · 交接以账本状态为准`:`固定测试 ${r.test.cases??'未知'} 项通过 · 交接以账本状态为准`):'测试未通过或对应文件版本已变化','notification-reason'):text('尚无固定测试结果。'),
    r.error?text('原因：'+r.error,'warning'):null,
    r.attention?h('div',{className:'notification-reason'},h('strong',null,r.attention.historical?'历史停止记录 · 不代表当前状态':'需要你处理'),text(r.attention.summary),text(r.attention.question),text(`停止时账本：写入调用 ${r.attention.write_budget?.calls_used??'未知'}/${r.attention.write_budget?.limit??'未知'} · 命令 ${r.attention.command_budget?.used??'未知'}/${r.attention.command_budget?.limit??'未知'} · 模型 ${r.attention.model_budget?.used??'未知'}/${r.attention.model_budget?.limit??'未知'}`)):null,
    h('details',{className:'development-events'},h('summary',null,`写入与交接时间线 · 最近 ${r.timeline.length} 条`),h('ol',{className:'timeline inner-timeline','aria-label':'受管写入事件时间线'},...r.timeline.map(e=>h('li',{className:'timeline-row',key:e.seq},h('article',{className:'notification-card'},h('strong',null,devEvent(e)),text(time(e.at)),e.type==='bridge_review_applied'?text('保留原请求与已用预算，不是重新批准。'):null,e.code?text(e.code):null))))))),
   d?.total>d?.items.length?text(`展示 ${d.items.length} / ${d.total} 个请求，持权与未结束请求优先。`):null,
   peer?.available&&peer.items.length?h('div',{className:'development-local'},h('h4',null,'本端回执 · 不替代云端账本'),...peer.items.map(p=>h('div',{className:'record',key:p.id},text(peerState(p.state),'notification-reason'),text('本端更新：'+time(p.updated)),text(d?.items.some(r=>r.id===p.cloud_request_id&&r.node===viewerRole)?'已关联上方云端请求；两端状态仍须分别核对。':'尚未在当前云端快照中核验对应请求。'),p.unresolved_calls?text(`${p.unresolved_calls} 条调用回执待核对，不重放写入。`):null))):viewerRole==='cloud'&&d?.items.some(r=>r.node==='local')?text('本地收件回执只能在本地 Host 查看；云端不推定 Mac 在线。'):null);
 }
 function DeliveryFile({preview,file,request,revisionMatches}){
  const page=useSnapshot(args=>request('delivery-file-page',{task_id:preview.task_id,preview_id:preview.id,fingerprint:preview.fingerprint,path:file.path,limit:4096,...args}));
  const value=page.snap?.value;
  return h('div',{className:'delivery-page'},
   h('div',{className:'pagination'},button('查看修改前全文',()=>page.load({side:'before',offset:0}),page.busy||!revisionMatches),button('查看修改后全文',()=>page.load({side:'after',offset:0}),page.busy||!revisionMatches)),
   text('手动逐页读取；每页重新核验原预览和文件，不自动翻页，不表示你已完整审阅。'),
   page.error?text('本页未能重新核验：'+page.error.message+'。未改文件；已有内容仅为上次读取。','warning'):null,
   page.busy?text('正在核对本页…'):null,
   value?h('div',{'aria-live':'polite'},text((value.side==='before'?'修改前':'修改后')+' · 核验于 '+time(value.checked_at)),
    value.state==='binary_or_invalid_utf8'?text('二进制或非 UTF-8，不转换为伪文本。','warning'):value.state==='absent'?text('该侧文件不存在。'):h('div',null,
     text(`Unicode 字符区间 ${value.offset}–${value.end_offset} / ${value.total_codepoints}`),h('pre',null,value.text||'（空文件）'),
     h('div',{className:'pagination'},button('上一页',()=>page.load({side:value.side,offset:Math.max(0,value.offset-4096)}),page.busy||value.offset===0||!revisionMatches),button('重新核验本页',()=>page.load({side:value.side,offset:value.offset}),page.busy||!revisionMatches),button('下一页',()=>page.load({side:value.side,offset:value.next_offset}),page.busy||value.next_offset===null||!revisionMatches)))):null);
 }
 function DeliveryActions({value,fresh}){
  const names={queued:'等待提交',active:'提交处理中',needs_review:'结果待核对',completed:'已记录本地提交',not_applied:'已核验未应用',cancelled:'已取消',evidence_invalid:'记录证据异常'};
  const pushNames={queued:'等待推送',active:'推送处理中',completed:'远端引用回读已记录'};
  const reasons={delivery_review:'任务或交付待核对',task_busy:'当前任务忙碌',delivery_resource_review:'同仓库交付待核对',delivery_resource_busy:'同仓库交付占用',development_resource_draining:'开发进程尚未排空',development_resource_review:'同仓库开发待核对',development_resource_busy:'同仓库开发占用',development_fifo:'等待前序开发',delivery_fifo:'等待前序交付'};
  const events={queued:'进入队列',acquired:'取得受管占用',dispatched:'记录派发意向',operation_intent:'记录操作意向',operation_spawned:'子进程启动',operation_drained:'操作已闭合',needs_review:'进入待核对',readback_completed:'本地提交回读已记录',not_applied_confirmed:'未应用核验已记录',cancelled:'取消排队',recovery_applied:'运营核对已记录',remote_readback_failed:'独立远端回读未核实，继续待核对',other:'交付账本事件'};
  return h('div',{className:'delivery-actions'},h('h4',null,'交付动作与回读'),
   text('计算提交号不是已创建提交；本地提交、远端接收、运行环境采用分别核验。这里不执行或恢复任务。'),
   !value?.available?text('当前连接未提供交付动作账本；不能据此断言没有提交。'):h('div',null,
    text(value.execution_enabled?'提交执行配置已开启；仍需独立可信审批与排队门禁。':'提交执行开关关闭；已保存的历史记录仍可查看。'),
    text(value.push_execution_enabled?'推送开关已开启；仍需独立推送批准、现场核验与排队门禁。':'推送执行开关关闭；提交批准不会授权推送。'),
    !fresh?text('历史快照 · 请手动刷新，不据此判断当前占用。','warning'):null,
    !value.items.length?text('尚无已登记交付动作。'):null,
    ...value.items.map(a=>h('article',{className:'plan-card',key:a.id},h('div',{className:'plan-card-heading'},h('strong',null,(a.kind==='push'?pushNames[a.state]:null)??names[a.state]??'未知状态'),text(time(a.created))),
     a.revision_matches===false?text('工作区修订已变化 · 以下为历史动作。','warning'):null,
     a.branch?text('目标分支：'+a.branch):null,
     a.computed_commit_oid?text('计算提交号（不证明落盘）：'+a.computed_commit_oid):null,
     a.kind==='push'?h('div',null,text('本动作绑定的提交：'+a.source_commit_oid),text('目标仓库：'+a.repository_url),
      text('批准的远端基线：'+(a.expected_remote_oid??'分支须不存在')),
      a.remote_ref_oid?text('远端引用历史回读：'+a.remote_ref_oid+' · '+time(a.remote_observed_at)):text('尚无远端引用匹配的完整回读证据。')):
      a.commit_oid?text('本地提交回读：'+a.commit_oid+' · '+time(a.commit_observed_at)):text('没有可展示的完整提交回读证据。'),
     a.waiting_reason?text(reasons[a.waiting_reason]??'等待条件核验','notification-reason'):a.state==='queued'?text(a.kind==='push'?'等待独立推送能力与审批核验；提交开关不能授权推送。':value.execution_enabled?'等待独立交付执行器核验；并非已获得执行权。':'等待运营开启提交执行能力。'):null,
     a.unclosed_operations?text('仍有 '+a.unclosed_operations+' 项操作未闭合；不自动重试或清锁。','warning'):null,
     a.error?text('核对代码：'+a.error,'warning'):null,
     text(a.kind==='push'&&a.remote_acceptance==='ref_observed'?'远端引用：历史回读匹配 · 环境采用：未核验；不代表发布或部署，本页不重新检查远端。':'本动作不证明远端接收或环境采用；推送结果见独立推送记录，本页不检查远端。'),
     h('details',null,h('summary',null,'交付事件时间线'),h('ol',{className:'timeline inner-timeline','aria-label':'交付动作时间线'},...a.timeline.map(e=>h('li',{className:'timeline-row',key:e.seq},h('article',{className:'notification-card'},h('strong',null,a.kind==='push'&&e.type==='readback_completed'?'远端引用回读已记录':events[e.type]??'账本事件'),text(time(e.at))))))))),
    value.total>value.items.length?text(`展示 ${value.items.length} / ${value.total} 个动作，未结束动作优先。`):null));
 }
 function Delivery({item,fresh,request}){
  const d=item.delivery,p=d?.latest;
  return h('section',{className:'evidence delivery-section','aria-label':'交付预览'},
   h('div',{className:'planning-heading'},h('h3',null,icon('file'),'交付预览'),h('span',{className:'badge neutral'},'仅查看 · 不提交')),
   text('测试工作区、提交版本、远端接收和运行环境采用分开记录；此处刷新只读取保存的预览，不重新检查文件。'),
   !p?text(d?.available?'尚无交付预览。可按任务名称告诉大肥鱼“查看这个任务的交付预览”；无仓库任务仍可查看上方成果和执行会话。':'当前连接未提供交付预览；原任务与成果入口不受影响。'):h('div',null,
    text(`登记于 ${time(p.created)} · 任务第 ${p.spec_revision} 版`),
    !fresh||!d.revision_matches?text('历史快照 · 不用于当前交付判断','warning'):null,
    h('dl',{className:'development-facts'},h('dt',null,'仓库'),h('dd',null,p.repository.url),h('dt',null,'开发分支'),h('dd',null,p.workspace_branch),h('dt',null,'基线提交'),h('dd',null,p.baseline_commit),h('dt',null,'测试版本'),h('dd',null,(p.tested_content.kind==='file_sha256'?'批准文件 SHA256：':'工作区清单 SHA256：')+p.tested_content.sha256),h('dt',null,'提交版本'),h('dd',null,'预览生成时尚未创建；后续结果见交付动作'),h('dt',null,'远端接收'),h('dd',null,'预览生成时尚未推送；后续结果见交付动作'),h('dt',null,'环境采用'),h('dd',null,'未核验 · 不由推送状态推断')),
    text(p.tested_content.test.required_commands?`批准验收命令 ${p.tested_content.test.required_commands.length} 项通过（检查当时）`:`固定测试 ${p.tested_content.test.cases} 项通过（检查当时）`),
    text('来源开发审批：'+label(p.source_approval.observed_state)+'（登记时观测）· 历史证据，不授予交付权'),
    h('details',{className:'delivery-files'},h('summary',null,`批准文件与差异摘要 · ${p.files.length} 项`),...p.files.map(f=>h('article',{className:'plan-card',key:f.path},
     h('h4',null,f.path),text((f.changed?'有内容变化':'无内容变化')+' · 批准动作 '+({create:'新增',modify:'修改',delete:'删除'}[f.approved_action]??'未知')),
     text('原 SHA256：'+(f.before_sha256??'不存在')),text('现 SHA256：'+(f.after_sha256??'不存在')),
     f.comparison.format==='binary_or_invalid_utf8'?text('二进制或非 UTF-8：不展示文本差异；不能据此声称完整审阅。','warning'):h('div',null,text('单区段比较 · 不是可执行补丁'),text(`末尾换行：修改前${f.comparison.before_ends_newline?'有':'无'} / 修改后${f.comparison.after_ends_newline?'有':'无'}`),f.comparison.truncated?text('内容已截断；未显示部分不代表已经审阅。','warning'):null,h('strong',null,'修改前'),h('pre',null,f.comparison.before||'（空）'),h('strong',null,'修改后'),h('pre',null,f.comparison.after||'（空）')),h(DeliveryFile,{key:p.fingerprint+':'+f.path,preview:p,file:f,request,revisionMatches:d.revision_matches})))),
    text('预览不是批准或持锁保证；提交需独立门禁，不包含推送、发布或部署。','notification-reason')),h(DeliveryActions,{value:d?.execution,fresh}));
 }
 function Planning({item}){
  const p=item.planning;
  const budget=(used,max,description)=>h('div',{className:'plan-budget'},h('div',{className:'budget-caption'},h('strong',null,description),h('span',null,`${Number.isFinite(used)?used:'?'} / ${Number.isFinite(max)?max:'?'}`)),Number.isFinite(used)&&Number.isFinite(max)&&max>0?h('meter',{min:0,max,value:Math.max(0,Math.min(used,max)),'aria-label':description+'，已用 '+used+'，上限 '+max}):null);
  const rule=r=>r.kind==='once'?'单次 · '+time(r.at):r.kind==='interval'?`每 ${r.every_seconds} 秒 · 固定间隔`:r.kind==='weekly'?`每周${['','一','二','三','四','五','六','日'][r.weekday]??'?'} ${String(r.hour).padStart(2,'0')}:${String(r.minute).padStart(2,'0')} · ${r.timezone??'时区未知'}`:r.kind==='event'?'事件 · '+(r.name??'名称未知'):'触发类型未知';
  const version=x=>`第 ${x.spec_revision} 版${x.spec_revision!==item.spec_revision?' · 历史修订':''} · 只读`;
  return h('section',{className:'evidence planning','aria-label':'计划与子任务'},h('div',{className:'planning-heading'},h('h3',null,icon('timeline'),'计划与子任务'),h('span',{className:'badge neutral'},'只读快照')),
   text('预算表示已用执行批次，不是完成百分比。等待期间不占用主会话；暂停不等于已经排空。'),
   !p?text('当前连接未提供计划视图，不能判定没有计划。','planning-empty'):null,
   p&&!p.available.schedules?text('此 Host 暂未提供持久触发记录。','planning-empty'):null,
   p&&!p.available.workflows?text('此 Host 暂未提供子任务图记录。','planning-empty'):null,
   p&&p.available.schedules&&p.available.workflows&&!p.schedules_total&&!p.workflows_total?text('没有持久计划或子任务图。普通单批次任务仍可正常执行，无需关联 Gitee。','planning-empty'):null,
   ...(p?.schedules??[]).map(x=>h('article',{className:'plan-card',key:x.id},h('div',{className:'plan-card-heading'},h('h4',null,'触发计划'),badge(x.state)),text(version(x)),text(rule(x.rule),'plan-rule'),budget(x.budget.emitted,x.budget.max_occurrences,'已触发次数'),text(`每次最多 ${x.budget.max_runs??'?'} 批 · 错过合并 ${x.skipped} 次`),text('截至 '+time(x.budget.end_at)+(x.next_due?' · 下次计划 '+time(x.next_due):'')),text('请求模型：'+model(x.model_policy)),x.dependencies.length?text('前置任务：'+x.dependencies.map(d=>d.title+'（'+label(d.status)+'）').join('、')):null)),
   ...(p?.workflows??[]).map(x=>h('article',{className:'plan-card',key:x.id},h('div',{className:'plan-card-heading'},h('h4',null,'子任务图 · '+x.nodes.length+' 个节点'),badge(x.state)),text(version(x)),budget(x.budget.used_runs,x.budget.max_runs,'共享批次已用'),text('截至 '+time(x.budget.end_at)),text('共同请求模型：'+model(x.model_policy)),
    h('ol',{className:'timeline inner-timeline child-timeline','aria-label':'子任务依赖列表'},...x.nodes.map(n=>h('li',{className:'timeline-row',key:n.id},h('article',{className:'child-card'},h('div',{className:'plan-card-heading'},h('h4',null,n.title),badge(n.state)),text(`本节点已用 ${n.attempts} / ${n.max_runs} 批 · 计入共享预算`),text(n.dependencies.length?'依赖：'+n.dependencies.map(d=>d.title+'（'+label(d.status)+'）').join('、'):'无前置子任务'),n.question?text('等待你补充：'+n.question,'input-question'):null)))))),
   p&&(p.schedules_total>p.schedules.length||p.workflows_total>p.workflows.length)?text(`每类最多显示 ${p.display_limit} 条，未结束项优先；全部记录仍保留。`):null);
 }
 const emptyRows=[];
 function WorkbenchUI({onboarding,request,call,open,openSidebar,appearance,artifactAccess,openA2A,navigationError,compact=false,visible=true,initialView='tasks',decisionAdapter,discussTask,downloadArtifact,attentionPreview}){
  const [executionView,setExecutionView]=React.useState('runs'),[lastDecision,setLastDecision]=React.useState(null);
  const [view,setView]=React.useState(initialView),[selected,setSelected]=React.useState(null),[query,setQuery]=React.useState(''),[filter,setFilter]=React.useState({query:'',after:0}),[keyboard,setKeyboard]=React.useState(false),[mascot,setMascot]=React.useState(null),[opening,setOpening]=React.useState(false),[navError,setNavError]=React.useState('');
  const list=useSnapshot(args=>request('list',{...args,limit:20})),detail=useSnapshot(id=>request('detail',{task_id:id})),workspace=useSnapshot(()=>call('status',{}));
  const initial=React.useRef(false),workspaceRead=React.useRef(false),alive=React.useRef(true),dialog=React.useRef(),root=React.useRef();
  const id=React.useId(),detailTarget=React.useRef();
  React.useEffect(()=>{alive.current=true;appearance().then(v=>{if(alive.current&&typeof v.mascot==='string'&&v.mascot.startsWith('blob:'))setMascot(v.mascot);}).catch(()=>{});return()=>{alive.current=false;};},[]);
  React.useEffect(()=>{if(visible&&!initial.current){initial.current=true;list.load(filter);}},[visible]);
  React.useEffect(()=>{if(view==='workspace'&&!workspaceRead.current){workspaceRead.current=true;workspace.load({});}},[view]);
  const fresh=useFresh(list.snap,list.error),detailRecent=useFresh(detail.snap,detail.error),workspaceFresh=useFresh(workspace.snap,workspace.error);
  const data=list.snap?.value,item=detail.snap?.value.item,ws=workspace.snap?.value,viewer=list.error?.viewer??data?.viewer;
  const role=viewer?.role??data?.viewer_role??ws?.viewer_role;
  const detailFresh=detailRecent&&fresh&&!list.busy&&!detail.busy&&detail.snap?.value.instance_id===data?.instance_id;
  const pending=list.error?.pending??data?.pending??[],devPeer=list.error?.development_peer??data?.development_peer;
  const runtimeLabel=data?.development?(data.development.runtime_enabled?'受管开发已配置 · 执行仍须过门禁':'受管开发未启用'):'执行能力待核验';
  const busy=list.busy||detail.busy||workspace.busy;
  function choose(taskId){setSelected(taskId);detail.reset();detail.load(taskId);setView('tasks');}
  function search(e){e.preventDefault();const f={query,after:0};setFilter(f);setSelected(null);detail.reset();list.load(f);}
  function page(after){const f={...filter,after};setFilter(f);setSelected(null);detail.reset();list.load(f);}
  function refresh(){setNavError('');list.load(filter);if(selected)detail.load(selected);if(workspaceRead.current)workspace.load({});}
  async function launch(session_id){setOpening(true);setNavError('');try{await open(session_id);}catch(e){if(alive.current)setNavError('未能打开原生工作区：'+e.message+'。没有创建或重试任务。');}finally{if(alive.current)setOpening(false);}}
  async function sidebar(){try{await openSidebar();}catch{if(alive.current)setNavError('请先选择已有会话，再打开双端任务侧栏；不会自动创建会话。');}}
  function hostCard(hostRole){
   const host=viewer?.role===hostRole?viewer:data?.host?.role===hostRole?data.host:null,peer=viewer?.connection;
   return h('article',{key:hostRole,className:'host-block '+hostRole+'-host mascot-zone'},h('div',{className:'host-copy'},h('div',{className:'host-caption'},icon(hostRole==='cloud'?'cloud':'laptop'),hostRole==='cloud'?'云端端点':'本地端'),h('h2',null,hostRole==='cloud'?'云端大肥鱼':'本地大肥鱼'),

    h('span',{className:'host-state'},host?`${fresh?'快照':'历史／本端观测'}：${host.active_runs} 个受管批次 · ${host.a2a?.active_runs??'未知'} 个协作执行`:'仅有握手观测 · 忙闲未知'),
    text(host?`v${host.plugin_version} · ${time(host.observed_at)}`:`对端版本 ${peer?.peer_version??'未知'}`),
    text(host?.connection?`${fresh?'链路观测':'历史链路'}：${label(host.connection.state)}`:`握手状态：${label(peer?.state)}`)),companion(hostRole,'host-companion'));
  }
  function run(r,workspaceMode=false){
   return h('li',{key:r.id,className:'timeline-row'},h('article',{className:'session-card'},h('div',{className:'session-head'},h('time',null,time(r.started)+' 开始'),badge(r.status)),workspaceMode?h('h3',null,r.title):null,
    workspaceMode?text('请求模型：'+model(r.requested_model)):text('实际模型：'+(r.actual_models?.items?.length?r.actual_models.items.map(m=>`${m.provider??'未知厂商'} / ${m.model}`).join('；'):r.actual_models?.state==='not_observed'?'未发现原生请求上下文记录':'尚无法核验')),
    workspaceMode&&r.checkpoint?.summary?h('details',null,h('summary',null,'当前批次检查点（非本次运行成果）'),h('pre',null,r.checkpoint.summary)):null,
    h('div',{className:'session-actions'},button('查看执行会话',()=>launch(r.session_id),opening||!(workspaceMode?workspaceFresh:detailFresh),'','message'),workspaceMode?button('任务与成果',()=>choose(r.task_id),!workspaceFresh,'','box'):null)));
  }
  function taskList(){return h('section',{className:'module tasklist mascot-zone',hidden:compact&&!!selected},moduleHead('任务时间线','可输入部分任务名称，例如“模型”可找到“每周模型能力更新”。按连续文字包含匹配，忽略英文大小写和首尾空格，不做语义搜索或错字纠正。输入后点击“查找”或按 Enter；清空后再次查找显示全部任务。结果按当前修订时间排列，未记录时间的历史任务置后。','tasks'),
   h('form',{className:'module-tools',onSubmit:search},h('label',{className:'search-box'},icon('search'),h('input',{'aria-label':'按任务名称查找',placeholder:'按任务名称查找',maxLength:120,value:query,onChange:e=>setQuery(e.target.value)})),h('button',{className:'button',type:'submit',disabled:busy},'查找')),
   h('ol',{className:'timeline','aria-label':'任务修订时间线'},...(data?.items??[]).map(t=>h('li',{key:t.task_id,className:'timeline-row'},h('button',{className:'task-card','aria-pressed':selected===t.task_id,onClick:()=>choose(t.task_id)},
    h('span',{className:'card-top'},h('time',null,time(t.created)+' · 修订'),badge(state(t))),h('h3',null,t.title),
    h('span',{className:'card-foot'},h('span',null,icon(t.repository.state==='unbound'?'file':'git'),t.repository.state==='unbound'?'不依赖仓库':'Gitee · '+t.repository.branch),h('span',null,attentionPreview?.cue?attentionPreview.cue(t):taskAttention(t).length?'有待处理事项':'查看成果与进度')),repositoryNotice(t.repository)?text(repositoryNotice(t.repository).label,'warning small'):null))),
    !data?.items?.length?h('li',{className:'empty-list'},list.busy?'正在核对…':data?'没有匹配任务；无需先关联仓库。':'等待连接，不将未知显示为空任务。'):null),
   h('div',{className:'pagination'},button('上一页',()=>page(Math.max(0,filter.after-20)),filter.after===0||busy),text(data?(data.items.length?`${filter.after+1}–${Math.min(filter.after+20,data.total)} / ${data.total}`:`本页 0 条 / 共 ${data.total} 条`):'尚无快照'),button('下一页',()=>page(data.next_cursor),data?.next_cursor==null||busy)));
  }
  function taskDetail(){return h('section',{className:'module detail-panel',ref:detailTarget,'aria-label':'任务详情'},
   selected?button('返回任务列表',()=>{setSelected(null);detail.reset();},false,'back-button'):null,
   !selected?h('div',{className:'empty-detail'},companion('files'),h('h2',null,'选择任务查看详情'),text('成果、审批与执行记录随任务展示。')):null,
   detail.error?text('详情未更新：'+detail.error.message,'warning'):null,
   selected&&!item?text(detail.error?'暂无可核验详情':'正在读取任务详情…','empty-list'):null,
   item?h(React.Fragment,null,h('header',{className:'detail-head mascot-zone'},h('div',{className:'meta'},'任务详情 · 第 '+(item.spec_revision??'历史')+' 版',badge(state(item))),h('h2',null,item.title),text(`${detailFresh?'详情观测':'历史详情 · 导航停用'}：${time(detail.snap.value.observed_at)}`),companion('files')),
    h('div',{className:'detail-body'},h('div',{className:'detail-title'},h('h3',null,icon('box'),'成果物'),h('span',{className:'muted small'},'成果与会话分开')),
     h(ArtifactFiles,{key:'artifacts-'+item.task_id,item,access:artifactAccess,open,fresh:detailFresh,download:downloadArtifact}),
     h(TaskConversationQuery,{key:'query-'+item.task_id,item}),
     lastDecision?.task_id===item.task_id?h('div',{className:'decision-result',role:'status'},h('strong',null,(decisionAdapter?.preview?'模拟结果 · ':'')+(lastDecision.operation_state&&lastDecision.plan?'处理意见已记账':label(lastDecision.state))),text((lastDecision.plan?'当时操作回执：':'')+lastDecision.message),text('本次决定已记录；当前任务状态以刷新后的快照为准。')):null,
     attentionPreview?.render?.({item,fresh:detailFresh,onChanged:()=>{setLastDecision(null);refresh();}})??h(TaskAttention,{key:'attention-'+item.task_id,item,fresh:detailFresh,adapter:decisionAdapter,discuss:discussTask,onRecorded:r=>{setLastDecision({...r,task_id:item.task_id});refresh();},inspect:()=>detailTarget.current?.querySelector('.detail-more')?.click()}),
     h(TaskDiagnostics,{key:'diagnostics-'+item.task_id,item},
     h('div',{className:'detail-grid'},
      h('dl',{className:'fact with-companion mascot-zone'},h('dt',null,'请求模型'),h('dd',null,model(item.requested_model??item.development_summary?.current?.requested_model??item.jobs[0]?.requested_model),h('small',null,'配置意图，不等于已调用')),companion('model')),
      h('dl',{className:'fact'},h('dt',null,'执行与等待'),h('dd',null,label(state(item)),h('small',null,`工作区${item.coordination.blocked?'阻塞':item.coordination.busy?'忙碌':'未占用'} · 持有端 ${endpointName(item.coordination.owner)}；不是主会话忙闲`))),
      h('dl',{className:'fact'},h('dt',null,'审批边界'),h('dd',null,item.approvals[0]?label(item.approvals[0].state):'尚无审批方案',h('small',null,item.approvals[0]?.execution_boundary==='requires_runtime_gate'?'批准不等于执行，仍须通过受管门禁':'当前未开放受管执行'))),
      h('dl',{className:'fact with-companion mascot-zone'},h('dt',null,'仓库关联'),h('dd',null,item.repository.state==='unbound'?'未关联仓库':'Gitee · '+item.repository.branch,h('small',null,repositoryNotice(item.repository)?.label??(item.repository.state==='unbound'?'可选，不影响任务展示':'关联不等于已有文件成果'))),companion('repository'))),
     h(Delivery,{item,fresh:detailFresh,request}),
     h(Development,{item,peer:detail.snap.value.development_peer,fresh:detailFresh,viewerRole:role}),
     h(Collaboration,{key:'collaboration-'+item.task_id,item,openA2A,viewerRole:role,fresh:detailFresh}),
     h(Planning,{item}),
     h(Notifications,{key:'notifications-'+item.task_id,item,request,fresh:detailFresh,viewerRole:detail.snap.value.viewer_role}),
     h('section',{className:'evidence'},h('h3',null,'普通批次会话与实际模型'),text('原生请求上下文不证明网络调用已发起或完成；在线记录可能尚未落盘。会话入口不是文件下载。'),
      h(PaginatedTimeline,{items:item.runs,render:r=>run(r),label:'任务执行开始时间线',empty:'尚无普通批次会话；双端协作会话见上方时间线。'}),
      item.runs_total>10?text(`展示最近 10 / ${item.runs_total} 次运行，模型只读取最近 3 次。`):null),
     h('details',{className:'evidence'},h('summary',null,`批次与等待原因 · ${item.jobs_total}`),!item.jobs.length?text('已登记，尚未创建执行批次。'):null,...item.jobs.map(j=>h('article',{key:j.id,className:'record'},j.lineage?.kind==='child'?h('strong',null,'子任务：'+j.lineage.title):j.lineage?.kind==='occurrence'?h('strong',null,'触发计划批次'):null,badge(j.reason),text(`${label(j.status)} · 尝试 ${j.attempts}/${j.max_runs}${j.reason==='scheduled_time'?' · '+time(j.due):''}`),text('批次请求模型：'+model(j.requested_model)),j.error?text(j.error,'warning'):null,j.input_question?text('等待你补充：'+j.input_question,'warning'):null,j.checkpoint?h(React.Fragment,null,text('当前批次检查点（非每次运行的历史成果）'),h('pre',null,j.checkpoint)):null)),item.jobs_total>50?text('最多显示 50 个批次，优先显示未结束批次。'):null,
      item.coordination.write_queue?.length?text('历史写入／交接队列：'+item.coordination.write_queue.map(q=>`${q.node} · ${q.status} · ${q.count} 项`).join('；')+'。此视图不处理历史队列、不授予写入。'):null),
     h('details',{className:'evidence'},h('summary',null,'审批账本与权威回执'),!item.approvals.length?text('尚无审批方案；未授权开发。'):null,...item.approvals.map(a=>h('article',{className:'record',key:a.id},h('strong',null,label(a.state)),text(a.summary,''),text(`方案第 ${a.spec_revision} 版 · 原记账 ${label(a.recorded_state)} · 有效至 ${time(a.expires)}`),text(`审批模型：${model(a.requested_model)} · 范围 ${a.scopes.join(' / ')} · 仓库关联第 ${a.repository_revision} 版`),a.delivery?text(a.delivery.kind==='push-execution-v1'?`精确推送授权方案（批准不代表远端已接受）：${a.delivery.fingerprint} · 目标 ${a.delivery.repository_url} / ${a.delivery.workspace_branch} · 提交 ${a.delivery.commit_oid} · 远端旧值 ${a.delivery.expected_remote_oid??'分支须不存在'} · 不提交/发布/部署`:`${a.delivery.kind==='commit-execution-v1'?'精确提交授权方案（批准不代表已执行）':'仅记账交付预览'}：${a.delivery.fingerprint} · 拟提交分支 ${a.delivery.workspace_branch} · 不推送/发布/部署`):null,text(`方案投递：${label(a.proposal_delivery)}；决定回执：${a.receipt?label(a.receipt.state):'尚无回执'}`),a.receipt?text(`回执内状态 ${label(a.receipt.snapshot_state)} · ${time(a.receipt.snapshot_at)}；不是当前批准的替代依据。`):null))),
     h(RepositoryEvidence,{repository:item.repository}))
    )):null);
  }
  function cloudWorkspace(){return h(React.Fragment,null,
   workspace.error?text('云端状态读取失败：'+workspace.error.message+'；已有内容仅为历史快照。','warning'):null,
   h('section',{className:'module execution-module mascot-zone'},
    h('header',{className:'module-header'},h('div',{className:'heading-with-help'},h('h2',null,'执行结果与会话'),h(InfoHelp,{title:'执行结果与会话'},'普通批次按开始时间排列，最多读取最近 50 次；协作会话单列，不混作普通 worker 批次。分页只浏览已加载快照，手动刷新后返回第一页。成果介绍与入口在任务详情中，打开工作区不授予执行权限。')),h('div',{className:'execution-tools'},button(role==='cloud'?'返回云端会话':'打开云端 Web',()=>launch(),opening,'','window'),companion('cloud'))),
    h('div',{className:'execution-toolbar'},h('div',{className:'execution-switch','aria-label':'执行类型'},...['runs','a2a'].map(v=>h('button',{key:v,type:'button','aria-pressed':executionView===v,onClick:()=>setExecutionView(v)},v==='runs'?'普通批次':'双端协作会话',h('span',{className:'count'},v==='runs'?(ws?.runs?.length??'—'):(ws?.a2a?.items?.length??'—'))))),
     text(ws?`${workspaceFresh?'执行快照':'历史执行快照 · 会话导航停用'} · ${time(ws.observed_at)}`:'尚未取得执行快照')),
    executionView==='runs'?h(PaginatedTimeline,{key:'runs',items:ws?.runs??emptyRows,render:r=>run(r,true),label:'执行会话开始时间线',empty:workspace.busy?'正在读取…':'暂无普通 worker 批次会话；协作会话单独展示。'}):
     h(PaginatedTimeline,{key:'a2a',items:ws?.a2a?.items??emptyRows,label:'最近双端协作会话',empty:!ws?.a2a?.available?'协作执行账本尚不可用。':'尚无双端协作执行会话。',render:r=>h('li',{className:'timeline-row',key:r.id},h('article',{className:'session-card'},h('div',{className:'session-head'},h('time',null,time(r.created)),h('span',{className:'badge neutral'},a2aRequestState(r.state))),h('h3',null,r.title),text(endpointName(r.to)+' · 任务第 '+r.spec_revision+' 版'),text('请求模型：'+model(r.requested_model)),button('查看协作答复与会话入口',()=>choose(r.task_id),!workspaceFresh,'','link')))})));
  }
  return h('section',{ref:root,className:'dtu'+(compact?' compact':'')+(keyboard?' keyboard':''),'aria-label':compact?'双端任务侧栏':'大肥鱼bot',style:mascot?{'--mascot':`url("${mascot}")`}:undefined,
   onKeyDownCapture:()=>setKeyboard(true),onPointerDownCapture:()=>setKeyboard(false),onPointerUp:e=>{if(e.pointerType==='touch'&&!e.target.closest('button,input,select,a,summary'))e.target.closest('.mascot-zone')?.classList.toggle('greet');}},
   h('div',{className:'surface'},h('header',{className:'page-header'},h('div',{className:'workbench-brand mascot-zone'},companion('local','brand-companion'),h('h1',null,compact?'双端任务':'大肥鱼bot')),
    h('div',{className:'header-actions'},!compact?button('连接与边界',()=>dialog.current.showModal(),false,'boundary-trigger','help'):null,!compact?h(Menu,{role,launch,opening,showAbout:()=>dialog.current.showModal()}):null,onboarding?button('配置导览',onboarding,false,'','settings'):null,button(busy?'核对中…':'刷新状态',refresh,busy,'primary','refresh'))),
    h('div',{className:'snapshot-line',role:'status'},h('span',null,data?`${fresh?'最近快照':'历史快照／不可用于判断空闲'} · ${time(data.observed_at)}`:'尚未取得云端任务账本'),h('span',null,'手动刷新 · '+runtimeLabel+' · 自动发布关闭')),
    h('div',{className:'host-strip',hidden:compact&&!!selected},hostCard('local'),hostCard('cloud')),
    list.error?text('未取得新状态：'+list.error.message+'。不自动重试任务，不视为对端空闲。','warning'):null,
    navError||navigationError?.()?text(navError||navigationError(),'warning'):null,
    pending.length?h('details',{className:'pending'},h('summary',null,`本端未完成受理记录（最近 ${pending.length} 条，不等于云端任务）`),...pending.map(p=>h('p',{key:p.id},`${p.title} · ${label(p.status)}${p.error?' · '+p.error:''}`))):null,
    devPeer?.available&&devPeer.items.length?h('details',{className:'pending development-local','aria-label':'本端写入交办'},h('summary',null,`本端写入交办 · ${devPeer.total} 条持久记录`),text('仅本端收发状态，不代表云端空闲或写入成功。'),...devPeer.items.map(p=>h('article',{className:'record',key:p.id},h('strong',null,data?.items.find(t=>t.task_id===p.task_id)?.title??'任务名称待云端核验'),text(peerState(p.state)),text(time(p.updated)+(p.error?' · '+p.error:'')),p.task_id?button('查看关联任务',()=>choose(p.task_id),!fresh):null))):null,
    !compact?h('div',{className:'view-toolbar'},h('nav',{className:'section-tabs',role:'tablist','aria-label':'工作台视图','data-view':view,onKeyDown:e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const next=e.key==='Home'?'tasks':e.key==='End'?'workspace':view==='tasks'?'workspace':'tasks';setView(next);root.current.querySelector(`[data-tab="${next}"]`)?.focus();}}},h('span',{className:'tab-indicator','aria-hidden':true}),...['tasks','workspace'].map(v=>h('button',{key:v,role:'tab',id:id+'-'+v,'data-tab':v,'aria-controls':id+'-view','aria-selected':view===v,tabIndex:view===v?0:-1,onClick:()=>setView(v)},icon(v==='tasks'?'timeline':'window'),v==='tasks'?'任务与状态':'云端工作区',v==='tasks'&&data?h('span',{className:'count'},data.total):null))),button('在侧栏查看',sidebar,false,'plain')):null,
    h('section',{id:id+'-view',role:compact?'region':'tabpanel','aria-label':compact?'任务列表与详情':undefined,'aria-labelledby':compact?undefined:id+'-'+view},view==='tasks'?h('div',{className:'task-layout'+(selected?' has-selection':'')},taskList(),taskDetail()):cloudWorkspace()),
    h('footer',{className:'page-footer'},text(decisionAdapter?.confirm?'云端权威账本 · 身份核验后逐项确认 · 执行另受门禁约束':'云端权威账本 · 快照不代表当前空闲 · 本视图只读'),compact?null:button('界面说明',()=>dialog.current.showModal(),false,'plain')),
    h(About,{dialog,role}))) ;
 }
 // Plain local Web Hosts do not ship Desktop's native browser tab. Only an
 // already verified managed ticket may use same-tab browser navigation.
 function managedBrowserEntry(result,page){
  if(!['http:','https:'].includes(page.protocol)||!['localhost','127.0.0.1','[::1]'].includes(page.hostname)||!/^[-a-f0-9]{36}$/.test(result.entryId??''))return null;
  let u;try{u=new URL(result.url);}catch{return null;}
  if(u.protocol!=='http:'||!['127.0.0.1','localhost'].includes(u.hostname)||u.hostname!==page.hostname||u.pathname!=='/'||u.username||u.password||[...u.searchParams.keys()].join()!=='workbench_ticket'||!u.searchParams.get('workbench_ticket')||u.hash&&!/^#dsh-worker=(?:task-worker|a2a)-[a-f0-9-]{36}$/.test(u.hash))return null;
  return u.href;
 }
 function apply(ctx){
  const style=document.createElement('style');style.textContent=css;document.head.append(style);ctx.effect(()=>()=>style.remove());
  let navigationError=null,appearancePromise,assetUrl,disposed=false;
  async function call(method,args){const r=await ctx.connection.rpc.call('/api','task-workbench/control',{method,args});if(!r?.ok)throw Error(r?.error?.code??'WORKBENCH_UNAVAILABLE');return r.value;}
  const appearance=()=>appearancePromise??=(onboardRequest('appearance',{}).then(value=>{
   if(disposed)throw Error('WORKBENCH_CLOSED');
   if(typeof value.mascot!=='string'||value.mascot.length>6000000||!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value.mascot))throw Error('INVALID_WORKBENCH_APPEARANCE');
   // CSS variables have browser size limits: keep the large PNG in a Blob, not
   // a multi-megabyte CSS token. One object URL per plugin instance, revoked below.
   const raw=atob(value.mascot.slice(22)),bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));
   assetUrl=URL.createObjectURL(new Blob([bytes],{type:'image/png'}));return {mascot:assetUrl};
  }).catch(e=>{appearancePromise=null;throw e;}));
  async function open(session_id,fallback=boardPanel,a2a){
   navigationError=null;
   const result=await call('open',session_id?{session_id,...a2a?{a2a}:{}}:{});
   if(result.role==='cloud'){if(session_id){await call('session',{session_id});await ctx.sessions.refresh();ctx.uiWorkspace.openSession(session_id);}else ctx.layout.selectPanel(null);return;}
   const webEntry=managedBrowserEntry(result,location),right=ctx.get('sidebarRight');if(!right?.openTab){if(webEntry){location.assign(webEntry);return;}throw Error('当前界面没有启用原生浏览器容器');}
   const url=new URL(result.url);if(url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname)||url.pathname!=='/'||!url.searchParams.has('workbench_ticket'))throw Error('工作台入口校验失败');
   ctx.layout.selectPanel(null);await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
   try{await right.openTab('browser',{params:{url:result.url}});}catch(e){if(webEntry&&['sidebarRight: no session surface is mounted','sidebarRight: no tab type is registered as \"browser\"'].includes(e.message)){location.assign(webEntry);return;}navigationError=e.message==='sidebarRight: no session surface is mounted'?'请先从左侧打开一个已有会话，再返回大肥鱼bot打开云端 Web；当前没有原生会话容器，未新建或重试任务。':e.message==='sidebarRight: no tab type is registered as "browser"'?'当前 Host 尚未启用原生浏览器面板；没有创建或重试任务。':'原生浏览器面板未能打开；没有创建或重试任务。';ctx.layout.selectPanel(fallback);throw e;}
  }
  async function request(method,args){if(method==='detail')method='interventions';const r=await ctx.connection.rpc.call('/api','task-board/control',{method,args});if(!r?.ok){const e=Error(r?.error?.code??'TASK_BOARD_UNAVAILABLE');e.viewer=r?.error?.details?.viewer;e.pending=r?.error?.details?.pending;e.development_peer=r?.error?.details?.development_peer;throw e;}return r.value;}
  async function openSidebar(){const right=ctx.get('sidebarRight');if(!right?.openTab)throw Error('TASK_BOARD_SIDEBAR_UNAVAILABLE');ctx.layout.selectPanel(null);await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));try{await right.openTab('dsh-dual-tasks');}catch(e){ctx.layout.selectPanel(boardPanel);throw e;}}
  async function artifactAccess(method,args){const r=await ctx.connection.rpc.call('/api','task-artifacts/control',{method,args});if(!r?.ok)throw Error(r?.error?.code??'ARTIFACT_UNAVAILABLE');return r.value;}
  async function openA2A(r,viewerRole){
   if(!['local','cloud'].includes(r.to)||!/^a2a-[a-f0-9-]{36}$/.test(r.session_id??''))throw Error('WORKBENCH_SESSION_NOT_FOUND');
   if(viewerRole==='local'&&r.to==='cloud')return open(r.session_id,boardPanel,{task_id:r.task_id,request_id:r.id});
   if(viewerRole!==r.to)throw Error('WORKBENCH_SESSION_WRONG_HOST');
   const result=await call('a2a-session',{task_id:r.task_id,request_id:r.id,session_id:r.session_id});
   await ctx.sessions.refresh();ctx.uiWorkspace.openSession(result.session_id);
  }
  async function onboardRequest(method,args){getOnboardingView();return onboardingRpc((...params)=>ctx.connection.rpc.call(...params),method,args);}
  getOnboardingView();const imClient=onboardingCreateImBridge();
  ctx.inject(['dshImClient'],sub=>{const detach=imClient.attach(sub.dshImClient);sub.effect(()=>detach);});
  let setupImRequested=false;const setupImListeners=new Set();
  function HomeUI(p){
   const [imOpen,setImOpen]=React.useState(()=>setupImRequested),[cloudEntry,setCloudEntry]=React.useState(null),[cloudWebEntry,setCloudWebEntry]=React.useState(false);
   React.useEffect(()=>{const fn=()=>{setMode('onboarding');setImOpen(true);};setupImListeners.add(fn);return()=>setupImListeners.delete(fn);},[]);
   const [cloudFileQueueReview,setCloudFileQueueReview]=React.useState(false);
   const [managedFileQueueReview,setManagedFileQueueReview]=React.useState(false);
   const [cloudFileMigration,setCloudFileMigration]=React.useState(false);
   const [managedFileMigration,setManagedFileMigration]=React.useState(false);
   const [cloudFileTransfer,setCloudFileTransfer]=React.useState(false);
   const [managedFileTransfer,setManagedFileTransfer]=React.useState(false);
   const [notificationDefaults,setNotificationDefaults]=React.useState(false);
   const [existingPairInspection,setExistingPairInspection]=React.useState(false);
   const [existingSetup,setExistingSetup]=React.useState(false);
   const [localPeerBinding,setLocalPeerBinding]=React.useState(false),[taskRuntime,setTaskRuntime]=React.useState(false),[cloudTaskRuntime,setCloudTaskRuntime]=React.useState(false),[repositoryRegistry,setRepositoryRegistry]=React.useState(false),[cloudRepositoryRegistry,setCloudRepositoryRegistry]=React.useState(false),[repositoryCheck,setRepositoryCheck]=React.useState(false),[cloudRepositoryCheck,setCloudRepositoryCheck]=React.useState(false),[cloudGiteeHandoff,setCloudGiteeHandoff]=React.useState(false),[cloudEnabled,setCloudEnabled]=React.useState(false),[sourcePreparation,setSourcePreparation]=React.useState(false),[nativeHostInstallation,setNativeHostInstallation]=React.useState(false),[modelBinding,setModelBinding]=React.useState(false),[tokenPlanBinding,setTokenPlanBinding]=React.useState(false),[cloudCredentialHandoff,setCloudCredentialHandoff]=React.useState(false),[cloudModelBinding,setCloudModelBinding]=React.useState(false),[cloudTokenPlanHandoff,setCloudTokenPlanHandoff]=React.useState(false),[cloudTokenPlanBinding,setCloudTokenPlanBinding]=React.useState(false),[cloudImInventory,setCloudImInventory]=React.useState(false),[optionalImInstallation,setOptionalImInstallation]=React.useState(false);
   const [maintenanceSessionContract,setMaintenanceSessionContract]=React.useState(0);
   const [selfDisableContract,setSelfDisableContract]=React.useState(0),[selfRemoveContract,setSelfRemoveContract]=React.useState(0),[selfStopContract,setSelfStopContract]=React.useState(0),[selfStopMutation,setSelfStopMutation]=React.useState(false);
   const [imMaintenanceContract,setImMaintenanceContract]=React.useState(0),[imMaintenanceMutation,setImMaintenanceMutation]=React.useState(false);
   const [maintenanceContract,setMaintenanceContract]=React.useState(0),[maintenanceMutation,setMaintenanceMutation]=React.useState(false);
   const [persistenceEnabled,setPersistenceEnabled]=React.useState(false);
   const [installationEnabled,setInstallationEnabled]=React.useState(false),[mode,setMode]=React.useState('loading'),[configured,setConfigured]=React.useState(false),[failure,setFailure]=React.useState(false);
   React.useEffect(()=>{let live=true;onboardRequest('describe',{}).then(x=>{if(live){setExistingSetup(x.capabilities?.existingSetupContract===1);setExistingPairInspection(x.capabilities?.existingPairInspectionContract===1);setTaskRuntime([2,3,4].includes(x.capabilities?.managedTaskRuntimeContract));setCloudFileQueueReview(x.capabilities?.cloudFileQueueReviewContract===1);setManagedFileQueueReview(x.capabilities?.managedFileQueueReviewContract===2);setCloudFileMigration(x.capabilities?.cloudFileScopeMigrationContract===1);setManagedFileMigration(x.capabilities?.managedFileScopeMigrationContract===1);setCloudFileTransfer(x.capabilities?.cloudFileTransferContract===1);setManagedFileTransfer(x.capabilities?.managedFileTransferContract===2);setLocalPeerBinding(x.capabilities?.localPeerBinding===true);setCloudTaskRuntime(x.capabilities?.cloudTaskRuntime===true);setRepositoryRegistry(x.capabilities?.repositoryRegistryContract===2);setCloudRepositoryRegistry(x.capabilities?.cloudRepositoryRegistry===true);setRepositoryCheck(x.capabilities?.repositoryCheckContract===1);setCloudRepositoryCheck(x.capabilities?.cloudRepositoryCheck===true);setCloudGiteeHandoff(x.capabilities?.cloudGiteeHandoff===true);setInstallationEnabled(x.capabilities?.rulesInstall===true);setMaintenanceContract([1,2].includes(x.capabilities?.rulesMaintenancePreviewContract)?x.capabilities.rulesMaintenancePreviewContract:0);setMaintenanceMutation(x.capabilities?.rulesMaintenanceMutation===true);setMaintenanceSessionContract(x.capabilities?.maintenanceRecordContract===2&&x.capabilities?.maintenanceRecordQueryContract===1?2:0);setSelfDisableContract(x.capabilities?.selfDisableContract===1&&x.capabilities?.selfDisableQueryContract===1?1:0);setSelfRemoveContract(x.capabilities?.selfRemoveContract===1&&x.capabilities?.selfRemoveQueryContract===1?1:0);setSelfStopContract(x.capabilities?.selfStopQueryContract===1?1:0);setSelfStopMutation(x.capabilities?.selfStopContract===1);setImMaintenanceContract(x.capabilities?.imMaintenanceQueryContract===1?1:0);setImMaintenanceMutation(x.capabilities?.imMaintenanceContract===1);setPersistenceEnabled(x.capabilities?.draftPersistence===true);setCloudEnabled(x.capabilities?.remoteDetection===true);setSourcePreparation(x.capabilities?.sourcePreparation===true);setNativeHostInstallation(x.capabilities?.nativeHostInstallation===true);setModelBinding(x.capabilities?.modelBinding===true);setTokenPlanBinding(x.capabilities?.tokenPlanBinding===true);setCloudCredentialHandoff(x.capabilities?.cloudCredentialHandoff===true);setCloudModelBinding(x.capabilities?.cloudModelBinding===true);setCloudTokenPlanHandoff(x.capabilities?.cloudTokenPlanHandoff===true);setCloudTokenPlanBinding(x.capabilities?.cloudTokenPlanBinding===true);setCloudImInventory(x.capabilities?.cloudImInventory===true);setNotificationDefaults(x.capabilities?.notificationDefaultsContract===1);setOptionalImInstallation(x.capabilities?.optionalImInstallation===true);setCloudWebEntry(x.capabilities?.cloudWebEntry===true);setConfigured(x.configured);setMode(x.configured&&!setupImRequested?'workbench':'onboarding');}}).catch(()=>{if(live)setFailure(true);});return()=>{live=false;};},[]);
   if(failure)return h('section',{className:'dsh-onboarding'},text('配置能力未能核验；没有检测环境、应用配置或自动重试。'));
   if(mode==='loading')return h('section',{className:'dsh-onboarding'},text('正在读取插件能力…'));
   if(mode==='workbench')return h(WorkbenchUI,{...p,onboarding:()=>setMode('onboarding')});
   return h(React.Fragment,null,h('div',{style:{height:'100%',display:imOpen||cloudEntry?'none':undefined}},h(getOnboardingView(),{request:onboardRequest,appearance,imClient,onManageIm:()=>setImOpen(true),onManageCloudIm:setCloudEntry,cloudWebEntry,installationEnabled,maintenanceContract,maintenanceMutation,maintenanceSessionContract,selfDisableContract,selfRemoveContract,selfStopContract,selfStopMutation,imMaintenanceContract,imMaintenanceMutation,persistenceEnabled,cloudEnabled,sourcePreparation,nativeHostInstallation,modelBinding,tokenPlanBinding,cloudCredentialHandoff,cloudModelBinding,cloudTokenPlanHandoff,cloudTokenPlanBinding,cloudImInventory,notificationDefaults,existingPairInspection,existingSetup,optionalImInstallation,repositoryCheck,cloudRepositoryCheck,cloudGiteeHandoff,repositoryRegistry,cloudRepositoryRegistry,taskRuntime,cloudTaskRuntime,localPeerBinding,cloudFileMigration,managedFileMigration,cloudFileTransfer,cloudFileQueueReview,managedFileQueueReview,managedFileTransfer,onExit:configured?()=>setMode('workbench'):undefined})),imOpen?h(onboardingNativeImManager,{imClient,onBack:()=>{if(location.hash==='#dsh-setup-im')history.replaceState(null,'',location.pathname+location.search);setupImRequested=false;setImOpen(false);}}):null,cloudEntry?h(onboardingCloudImManager,{entry:cloudEntry,request:onboardRequest,onBack:()=>setCloudEntry(null)}):null);
  }
  const decisionAdapter=createWorkbenchDecisionAdapter(call);
  const props=()=>({request,call,open,openA2A,openSidebar,appearance,artifactAccess,decisionAdapter,navigationError:()=>navigationError});
  ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key:boardPanel,inject:props},HomeUI));
  // Old main key remains a navigation alias; only ONE left entry is registered.
  ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key:panel,inject:()=>({...props(),initialView:'workspace'})},WorkbenchUI));
  ctx.slots.inject('sidebar.panellist',()=>ctx.slots.register({name:'sidebar.panellist',id:boardPanel,order:5,label:'大肥鱼bot'},Icon));
  ctx.inject(['sidebarRightTabs','sidebarRight'],sub=>{
   sub.effect(()=>sub.sidebarRightTabs.register({id:boardTab,kind:'dsh-dual-tasks',title:()=> '双端任务',guide:[{id:'tasks',order:6,title:()=> '双端任务',description:()=> '任务、审批与成果入口',icon:Icon}]}));
   function SidebarBody({useTabInfo}){const {tab}=useTabInfo();return h(WorkbenchUI,{...props(),compact:true,visible:tab.visible});}
   sub.slots.inject('sidebar.right.pane.tab',()=>sub.slots.register({name:'sidebar.right.pane.tab',key:boardTab},SidebarBody));
  });
  async function navigate(){
   if(location.hash==='#dsh-setup-im'){setupImRequested=true;for(const fn of setupImListeners)fn();if(!disposed)ctx.layout.selectPanel(boardPanel);return;}
   const match=/^#dsh-worker=((?:task-worker|a2a)-[a-f0-9-]{36})$/.exec(location.hash);if(!match)return;
   history.replaceState(null,'',location.pathname+location.search);
   try{const result=await call('session',{session_id:match[1]});await ctx.sessions.refresh();if(!disposed)ctx.uiWorkspace.openSession(result.session_id);}catch(e){navigationError='执行会话导航失败：'+String(e.message).slice(0,180);if(!disposed)ctx.layout.selectPanel(boardPanel);}
  }
  const timer=setTimeout(navigate,0);window.addEventListener('hashchange',navigate);
  ctx.effect(()=>()=>{disposed=true;clearTimeout(timer);window.removeEventListener('hashchange',navigate);if(assetUrl)URL.revokeObjectURL(assetUrl);});
 }
 return {name:'task-workbench',inject:['connection','slots','layout','uiWorkspace','sessions'],apply};
}});
