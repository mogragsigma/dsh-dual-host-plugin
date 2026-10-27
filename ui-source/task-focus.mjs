// Presentation only. These observations are never execution or approval grants.
export function taskAttention(item, now = Date.now()) {
  if (!item) return [];
  if(item.interventions?.schema===1&&item.interventions.initialized)return item.interventions.items.filter(e=>['open','unverified'].includes(e.lifecycle)).map(e=>{
    const approval=(item.approvals??[]).find(a=>a.id===e.source_id);
    const decision=e.lifecycle==='open'&&e.source_kind==='approval'&&e.category==='decision'&&approval?.spec_revision===item.spec_revision&&Number.isFinite(approval.expires)&&approval.expires>now&&['pending','held','clarification_required'].includes(approval.state);
    return {...e,intervention_id:e.id,id:e.source_id,kind:decision?'approval':e.category==='decision'?'verification':e.category,
      title:e.lifecycle==='unverified'?'先核对原处理事项':e.category==='decision'&&!decision?'先核对方案当前状态':e.title,
      owner:e.lifecycle==='unverified'||e.category==='decision'&&!decision?'system':e.owner,
      description:e.category==='decision'&&!decision?'原方案已变化、过期或本次未能核实；请刷新核对，不重复批准。':e.reason,
      next:e.category==='decision'&&!decision?'刷新并读取原方案及账本，再判断是否仍需你决定。':e.next,action:decision?'decision':'inspect',approval:decision?approval:null,
      feedback:e.user_opinion?{user_text:e.user_opinion}:null};
  });
  const result = [], revision = item.spec_revision;
  const add = (kind, id, title, description, extra = {}) => result.push({kind, id, title, description, ...extra});
  for (const a of item.approvals ?? (item.approval ? [item.approval] : [])) {
    if (a.spec_revision !== revision || !Number.isFinite(a.expires) || a.expires <= now) continue;
    if (['pending', 'held', 'clarification_required'].includes(a.state)) {
      add('approval', a.id, a.state === 'held' ? '这份方案已暂缓' : a.state === 'clarification_required' ? '请澄清你的决定' : '有一份方案待你决定', a.summary,
        {approval: a, action: 'decision', revision});
    } else if (a.state === 'changes_requested') {
      add('amendment', a.id, '方案需要修改后重审', '旧方案不能执行；请在讨论中补充或核对修改意见。', {action: 'discuss', feedback:a.feedback});
    } else if (a.state === 'confirmation_review') {
      add('review', a.id, '审批核验尚未完成', '先核对原决定，不重复批准、不重新送审绕过未知结果。', {action: 'inspect'});
    }
  }
  for (const j of item.jobs ?? []) {
    const current = j.spec_revision === revision;
    if (current && j.status === 'waiting_input') add('input', j.id, '需要你补充信息', j.input_question || '具体问题暂未提供，请先查询任务。', {action: 'answer', revision});
    if (['needs_review', 'failed', 'interrupted'].includes(j.status)) add('review', j.id, current ? '执行遇到问题，先核对原因' : '历史批次仍有待核对记录',
      j.error === 'WORKER_REPORT_REQUIRED' ? '该批次未留下完整报告；这不是待审批方案，不会直接重新执行。' : j.error === 'WORKER_MODEL_OUTPUT_LIMIT' ? '模型输出达到上限，报告未完整生成；需讨论处理方案。' : '执行结果尚不能确认，不能把批准方案当作重新执行的许可。',
      {action: 'inspect', error: j.error ?? null, historical: !current});
    if (current && j.status === 'waiting_capability') add('configuration', j.id, '执行能力需要核对', '先核对所需能力与配置；不需要为此重复批准旧方案。', {action: 'inspect'});
  }
  for (const n of item.notifications?.deliveries ?? []) {
    if (n.state === 'needs_review' && n.review?.state !== 'closed') add('notification', n.id, '一条通知的发送结果待核对', '核对是否看到原消息；未看到不等于发送失败，不自动重发。', {action: 'inspect'});
  }
  const state = item.display_state ?? '';
  if (!result.length && state === 'waiting_approval') add('review', 'missing-proposal', '等待审批，但尚无可核验的当前方案', '请刷新或查询原方案；不能用历史方案或空白确认代替。', {action: 'inspect'});
  if (!result.length && state === 'waiting_input') add('review', 'missing-question', '待补充问题尚未读取', '先核对当前问题，不把普通回复送给错误的批次。', {action: 'inspect'});
  if (!result.length && state === 'waiting_capability') add('configuration', 'missing-capability', '执行能力尚未就绪', '已批准不等于已开始；请核对所需能力，不重复批准。', {action: 'inspect'});
  if (!result.length && /review|unknown|unavailable|evidence_missing|task_blocked/.test(state)) {
    add('review', 'task-observation', '任务状态需要核对', '当前证据不足以确定下一步；查看诊断记录，不自动重试、清锁或放行。', {action: 'inspect'});
  }
  return result;
}

export function decisionSelection(item, attention, text, shortcut, now = Date.now()) {
  const a = (item.approvals ?? (item.approval ? [item.approval] : [])).find(x => x.id === attention.id);
  if (!a || a.spec_revision !== item.spec_revision || a.expires <= now ||
      !['pending', 'held', 'clarification_required'].includes(a.state)) throw Error('APPROVAL_SNAPSHOT_CHANGED');
  if (typeof text !== 'string' || text.trim().length > 2000 || !text.trim() && !['approve', 'reject', 'hold'].includes(shortcut)) throw Error('DECISION_TEXT_REQUIRED');
  // Keep text even when a shortcut is pressed: the server must resolve conditions,
  // never erase an amendment in favour of the approve button.
  return {task_id: item.task_id, request_id: a.id, expected_revision: item.spec_revision,
    observed_state: a.state, text: text.trim(), shortcut: shortcut ?? null};
}
