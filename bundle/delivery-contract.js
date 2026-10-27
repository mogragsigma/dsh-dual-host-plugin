// Opaque input only: all file, branch and baseline identities come from the
// immutable server preview. This is an approval record, never an execution API.
export function deliveryReference(v){
 if(['commit-execution-reference-v1','push-execution-reference-v1'].includes(v?.kind)){
  const prefix=v.kind==='push-execution-reference-v1'?'push':'commit';
  if(Object.keys(v).sort().join(',')!=='fingerprint,kind,plan_id'||!new RegExp('^'+prefix+'-plan-[a-f0-9-]{36}$').test(v.plan_id??'')||!/^[a-f0-9]{64}$/.test(v.fingerprint??''))throw Error('DELIVERY_INVALID_APPROVAL_REFERENCE');
  return {kind:v.kind,plan_id:v.plan_id,fingerprint:v.fingerprint};
 }
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!['preview_id','fingerprint','commit_message'].includes(k))||typeof v.preview_id!=='string'||!/^delivery-[a-f0-9-]{36}$/.test(v.preview_id)||!/^[a-f0-9]{64}$/.test(v.fingerprint??'')||typeof v.commit_message!=='string'||!v.commit_message.trim()||v.commit_message.length>2000||/[\x00-\x09\x0b-\x1f\x7f]/.test(v.commit_message))throw Error('DELIVERY_INVALID_APPROVAL_REFERENCE');
 return {preview_id:v.preview_id,fingerprint:v.fingerprint,commit_message:v.commit_message};
}
const previewReferenceSchema={type:'object',properties:{preview_id:{type:'string'},fingerprint:{type:'string'},commit_message:{type:'string',minLength:1,maxLength:2000}},required:['preview_id','fingerprint','commit_message'],additionalProperties:false};
export function deliveryLabel(p){
 if(p.kind==='push-execution-v1')return [
  '限定推送授权：仅将已完成本地提交推送至下列唯一远端分支；批准不等于已发送或已被远端接受。',
  '仓库：'+p.repository_url+'（仓库 ID '+p.repository_id+'）','目标分支：'+p.workspace_branch,
  '远端预期旧值：'+(p.expected_remote_oid??'准备时确认该分支不存在'),'已完成本地提交：'+p.commit_oid,'目标树：'+p.tree_oid,
  '测试内容：'+p.tested_content.kind+' / '+p.tested_content.sha256,'准备时间：'+new Date(p.prepared_at).toISOString(),
  '审批计划指纹：'+p.fingerprint,
  '远端旧值是准备时的观察，不保证仍然新鲜。执行前重新核对仓库身份、引用、祖先关系、工作区和进程排空，并以精确旧值条件更新。',
  '最多发送一次；不重写历史、不删除引用、不推标签，不执行 hooks、不生成推送签名。发送未知不得重试，须独立回读核对。',
  '不包含新建提交、开发修改、发布或部署；远端引用已匹配也不代表运行环境已经采用。'
 ].join('\n');
 if(p.kind==='commit-execution-v1')return [
  '限定提交授权：仅云端独立工作区的一次本地提交；批准不等于已执行。',
  '目标分支：'+p.workspace_branch,'预期父提交：'+p.baseline_commit,
  '计算提交OID（尚不证明落盘）：'+p.computed_commit_oid,'目标树：'+p.tree_oid,
  '作者：'+JSON.stringify(p.author),'提交者：'+JSON.stringify(p.committer),'固定提交时间：'+new Date(p.timestamp*1000).toISOString(),
  '精确文件集合：'+p.file_count+' 项；摘要 '+p.files_digest,'测试内容：'+p.tested_content.kind+' / '+p.tested_content.sha256,
  '提交说明：'+JSON.stringify(p.commit_message),'审批计划指纹：'+p.fingerprint,
  '请按任务名称查看对应完整预览；摘要不代表已读全文。仅绑定所列内容和元数据，不授权修改文件。',
  '该适配不执行 Git hooks／filters，不生成签名；引用和索引不是同一原子操作，部分结果须待核对。',
  '实际执行仍须单次额度、排队持权、现场与进程排空门禁；不包含推送、发布或部署。'
 ].join('\n');
 return `拟提交交付（仅记账，不执行）：${p.workspace_branch}\n基线提交：${p.baseline_commit}\n测试内容 SHA256：${p.tested_content_sha256}\n精确文件集合：${p.file_count} 项，其中 ${p.changed_files} 项变化；集合摘要 ${p.files_digest}\n提交说明：${JSON.stringify(p.commit_message)}\n预览指纹：${p.fingerprint}\n请在双端工作台按任务名称查看对应预览和完整文件分页；摘要不代表全文已审阅。批准绑定上述内容，不是当前工作区的持锁保证；审批查询不会自动重验文件。提交执行器关闭，不包含推送、发布或部署。`;
}

export const deliveryReferenceSchema={oneOf:[previewReferenceSchema,{type:'object',properties:{kind:{enum:['commit-execution-reference-v1','push-execution-reference-v1']},plan_id:{type:'string'},fingerprint:{type:'string'}},required:['kind','plan_id','fingerprint'],additionalProperties:false}]};
export const commitExecution=p=>p?.delivery?.kind==='commit-execution-v1';
export const pushExecution=p=>p?.delivery?.kind==='push-execution-v1';
export const deliveryExecution=p=>commitExecution(p)||pushExecution(p);
export const approvalTitle=p=>pushExecution(p)?'【DSH 方案确认 · 限定推送授权】':commitExecution(p)?'【DSH 方案确认 · 限定提交授权】':p.development?'【DSH 方案确认 · 受限开发授权】':'【DSH 方案确认 · 当前仅记账，不执行】';
