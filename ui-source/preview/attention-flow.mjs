// Synthetic preview state only. Never imported by a Host, tool or production bundle.
const terminal=new Set(['completed','ended','resolved']);
export const flowKinds=['recovery','input','amendment','capability','notification','unknown'];
export function createFlow(kind,opinion=''){
 if(!flowKinds.includes(kind))throw Error('PREVIEW_KIND');
 return {kind,phase:kind==='recovery'||kind==='unknown'?'checking':kind==='capability'?'configuration':kind==='notification'?'notification':'editing',version:1,planVersion:1,opinion,history:[],returnPhase:null};
}
const action=(id,label,extra={})=>({id,label,...extra});
const end=()=>action('end','不再继续',{tone:'quiet'});
export function flowView(f){
 const base={phase:f.phase,title:'',owner:'系统处理',description:'',facts:[],actions:[],input:false,step:0,terminal:terminal.has(f.phase)};
 const main=(id,label,extra={})=>action(id,label,{tone:'primary',...extra});
 const kind=f.kind;
 const recommendation=kind==='input'?'按你补充的范围继续整理资料。':kind==='amendment'?'按修改后的要求重新送审，不执行旧方案。':'保留已有资料，只补齐报告，不重新检索，也不提交、推送或发布。';
 switch(f.phase){
 case 'checking':return {...base,title:kind==='unknown'?'系统正在核对原记录':'系统正在核对中断批次',description:'先检查已有资料、执行是否停止及剩余授权。现在不需要你批准，也不会自动重跑。',facts:['当前没有可交付的完整报告。','核对是只读动作，不消耗新的执行次数。'],actions:[main('inspect','查看核对结果'),end()]};
 case 'recommendation':return {...base,step:1,owner:'等待你的决定',title:`处理建议 · 第 ${f.planVersion} 版`,description:recommendation,input:true,
  facts:[kind==='recovery'?'模拟核对：资料仍保留，原批次已停止；原次数 1/1 已用完。':'这份建议针对当前任务；原方案和历史记录保留。',kind==='recovery'?'这是一份新的补报告建议，最多新增 1 次生成；不是重置旧预算。':'继续前仍须检查当前范围、有效授权与预算；本页仅演示。',f.opinion?'已纳入你的要求：'+f.opinion:'你可以直接接受建议，也可以先补充要求。'],
  actions:[main('continue',kind==='amendment'?'同意修订并继续（模拟）':'按建议继续（模拟）'),action('revise','更新建议',{requiresText:true}),action('hold','稍后决定'),end()]};
 case 'editing':return {...base,step:1,owner:'等待你补充',title:kind==='input'?'请补充这次的比较范围':'请补充需要修改的地方',description:kind==='input'?'本次只比较国内产品，还是同时包含海外产品？补充后先给你核对建议，不会直接执行。':'旧方案已冻结。写下修改意见后生成新建议，再由你决定是否继续。',input:true,facts:f.opinion?['已收到的意见：'+f.opinion]:[],actions:[main('revise','生成处理建议',{requiresText:true}),end()]};
 case 'held':return {...base,step:1,owner:'等待你方便时决定',title:'已暂缓这份处理建议',description:'没有恢复执行，也没有取消任务。建议和你的意见都已保留；你可以回来继续决定。',actions:[main('reopen','继续查看建议'),end()]};
 case 'queued':return {...base,step:2,title:'已受理，等待执行',description:'你的决定已记录。模拟执行尚未开始，不再要求你重复批准。',facts:['下一步由云端执行端检查当前建议与预算。','没有真实模型请求、文件写入或仓库操作。'],actions:[main('progress','查看执行进展'),end()]};
 case 'running':return {...base,step:2,title:'正在补齐结果',description:'模拟执行端正在按本次建议生成结果；此时不需要人工介入。',facts:f.opinion?['本次采用的补充要求：'+f.opinion]:['复用已保留资料，不重新开展整个任务。'],actions:[main('finish','查看处理结果'),end()]};
 case 'completed':return {...base,step:3,owner:'本次处理已完成',title:'结果已登记，可以查看成果',description:'模拟报告已出现在上方“成果物”。原失败记录保留在诊断中，不再作为本次未处理事项。',facts:['这是合成结果，不是真实云端任务成果。'],actions:[]};
 case 'configuration':return {...base,title:'执行能力尚未就绪',owner:'需要配置维护',description:'这不是审批问题，不需要重复同意。请查看配置要求，或把问题交给维护端处理。',facts:['模拟缺项：受限执行能力没有启用。','这里不会修改配置或开启真实执行权限。'],input:true,actions:[main('maintain','提交维护请求（模拟）'),action('requirements','查看配置要求'),end()]};
 case 'requirements':return {...base,title:'需核对的配置',owner:'需要配置维护',description:'由配置维护者核对目标端模型可用性、受限执行能力与当前授权；不得通过重复审批跳过配置。',facts:['真实配置入口将在后续接线，本轮不操作 Host。'],input:true,actions:[main('maintain','提交维护请求（模拟）'),action('back_configuration','返回'),end()]};
 case 'maintenance':return {...base,title:'证据不足，先交给维护端',owner:'需要维护核对',description:'无法证明原操作已结束或可以安全继续。暂不提供重试／批准按钮。你可以补充线索，让维护端核对原记录。',input:true,actions:[main('maintain','提交维护请求（模拟）'),end()]};
 case 'maintenance_pending':return {...base,title:'维护端已接手',owner:'等待维护端处理',description:'已保存你的说明，当前没有需要你批准的事项。不会自动重发原消息、清锁或恢复执行。',facts:[f.opinion?'补充说明：'+f.opinion:'你不需要研究日志或填写内部编号。'],actions:[main('maintenance_result','查看维护进展'),end()]};
 case 'maintenance_done':return {...base,title:'核对已完成，是否继续？',owner:'等待你的决定',description:kind==='capability'?'模拟维护端已核对配置。已有批准与范围仍须单独检查；这不代表正式能力已启用。':'模拟维护端已核对原操作，历史记录保留。若希望继续，先形成新的处理建议，不重放原操作。',actions:[main('new_plan','查看处理建议'),end()]};
 case 'notification':return {...base,title:'请核对原通知是否收到',owner:'等待你核对',description:'任务成果不会因通知未知而消失。请按实际看到的情况选择；未看到不等于发送失败。',actions:[main('seen','我已看到原消息'),action('unseen','未看到，请核对'),action('end','不再追踪这条通知')]};
 case 'resolved':return {...base,step:3,title:'本次通知核对已结束',owner:'无需你再处理',description:f.resolution==='seen'?'已记录你看到了原消息；没有再次发送，也不改变平台原有证据。':'模拟维护端保留了原投递记录，已结束本次人工核对；没有补发通知。',facts:['只处理这条通知的核对，不取消任务、不改变已有成果。'],actions:[]};
 case 'ending':return {...base,owner:'请确认范围',title:kind==='notification'?'结束这条通知的人工跟进？':'结束这个任务的后续处理？',description:kind==='notification'?'只停止人工跟进，不删除通知记录，不改变任务或成果。':'确认后先核对在途动作，再停止后续执行；已有资料、成果及历史记录都保留。',facts:['这是模拟终止流程，不会操作真实任务。'],actions:[main('confirm_end',kind==='notification'?'确认结束通知跟进（模拟）':'确认结束本任务（模拟）'),action('back','返回继续处理')]};
 case 'ending_check':return {...base,title:'正在核对并结束',description:'已收到结束请求。先确认没有未结束的在途动作，不把“已受理”当成“已经结束”。',actions:[main('end_result','查看结束结果')]};
 case 'ended':return {...base,step:3,owner:'后续处理已结束',title:kind==='notification'?'已停止跟进这条通知':'已结束，不再继续执行',description:kind==='notification'?'只关闭这条通知的人工跟进。任务、成果和原投递记录保持不变。':'模拟结束核对已完成。不会再执行此任务；已有资料和历史记录保留，未把失败改成成功。',actions:[]};
 default:throw Error('PREVIEW_PHASE');
 }
}
export function advanceFlow(original,{action:id,text='',expectedVersion}){
 if(expectedVersion!==original.version)throw Error('PREVIEW_CHANGED');
 const offered=flowView(original).actions.find(a=>a.id===id);
 if(!offered)throw Error('PREVIEW_ACTION');
 if(typeof text!=='string'||text.trim().length>2000||offered.requiresText&&!text.trim())throw Error('PREVIEW_TEXT');
 const f=structuredClone(original);f.version++;const note=text.trim();
 // Any typed requirements supersede the current suggestion, never vanish on Continue.
 if((id==='continue'||id==='revise')&&note){f.opinion=note;f.planVersion++;f.phase='recommendation';}
 else if(id==='inspect')f.phase=f.kind==='recovery'?'recommendation':'maintenance';
 else if(id==='continue')f.phase='queued';
 else if(id==='revise'){throw Error('PREVIEW_TEXT');}
 else if(id==='hold')f.phase='held';
 else if(id==='reopen')f.phase='recommendation';
 else if(id==='progress')f.phase='running';
 else if(id==='finish')f.phase='completed';
 else if(id==='requirements')f.phase='requirements';
 else if(id==='back_configuration')f.phase='configuration';
 else if(id==='maintain'){f.phase='maintenance_pending';if(note)f.opinion=note;}
 else if(id==='maintenance_result'){f.phase=f.kind==='notification'?'resolved':'maintenance_done';}
 else if(id==='new_plan')f.phase='recommendation';
 else if(id==='seen'){f.phase='resolved';f.resolution='seen';}
 else if(id==='unseen')f.phase='maintenance';
 else if(id==='end'){f.returnPhase=f.phase;f.phase='ending';if(note)f.opinion=note;}
 else if(id==='back'){f.phase=f.returnPhase;f.returnPhase=null;}
 else if(id==='confirm_end')f.phase='ending_check';
 else if(id==='end_result')f.phase='ended';
 f.history.push({version:f.version,from:original.phase,to:f.phase,action:offered.label,note,result:flowView(f).title});
 return f;
}
export function flowCue(f){const v=flowView(f);return v.owner;}
