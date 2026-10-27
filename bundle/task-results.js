// Conversation entry projection: current cloud ledger only, never a scheduler command.
const object=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
const summary=i=>({task_id:i.task_id,title:i.title,spec_revision:i.spec_revision,state:i.display_state,requested_model:i.requested_model,jobs_total:i.jobs_total,repository:i.repository,approval:i.approval});
export async function taskResults(g,a){
 if(!object(a)||Object.keys(a).some(k=>!['query','after','limit','task_id'].includes(k))||a.task_id!==undefined&&(typeof a.task_id!=='string'||!a.task_id||a.task_id.length>128||Object.keys(a).length!==1))throw Error('INVALID_TASK_RESULTS_QUERY');
 if(!g.board)throw Error('CAPABILITY_UNAVAILABLE');
 const base={authority:'cloud',grants_execution:false,query_only:true,automatic_delivery:false,matching:'current_title_contains_not_semantic'};
 let id=a.task_id;
 if(!id){
  const list=await g.board.call('board_list',a);
  if(list.total!==1||list.items.length!==1)return {...base,observed_at:list.observed_at,items:list.items.map(summary),total:list.total,next_cursor:list.next_cursor,requires_clarification:list.total>1};
  id=list.items[0].task_id;
 }
 const detail=await g.board.call('board_detail',{task_id:id}),i=detail.item;
 return {...base,observed_at:detail.observed_at,requires_clarification:false,total:1,next_cursor:null,items:[{...summary(i),jobs:i.jobs,runs:i.runs,approvals:i.approvals,artifacts:i.artifacts,interventions:i.interventions??null}],guidance:'成果列表不是访问许可。按成果名称选定后用 task_artifact_access 核验页面或会话；文件下载在已登录工作台中明确点击。IM 文件发送另需用户明确请求；不新建、恢复、批准或自动发送任务。'};
}
