// Read-only presentation policy. No scheduling, authorization or model dispatch here.
export const sections={overview:'总览',tasks:'任务',attention:'待我决定',changes:'变化',files:'成果',settings:'设置'};
export const settings={connection:'双端连接',models:'模型服务',credentials:'凭据',im:'聊天入口',notifications:'通知',repository:'Git 与远程托管',files:'文件收发',rules:'规则与 Skill',plugins:'插件版本与修复',service:'服务维护',sources:'来源与处理模式',policy:'主动工作策略',observer:'进展监督'};
export const stateNames={queued:'排队中',claimed:'准备执行',running:'推进中',waiting:'等待下次触发',scheduled:'等待触发',waiting_input:'待补充',needs_review:'需要核对',fenced:'需要核对',idle:'本轮已完成',paused:'已暂停',pausing:'正在暂停',resuming:'正在恢复',stopped:'已停止',draining:'正在收拢',cancelled:'已停止',completed:'已完成',scheduled_time:'等待触发',registered:'已受理'};
export function taskState(t){const c=t.continuity;if(c&&!['active','legacy'].includes(c.state))return c.status==='draining'?'draining':c.state;return t.managed_execution?.state??t.display_state??'unknown';}
export function statusLabel(t){const s=taskState(t);return stateNames[s]??'待核对';}
export function needsDecision(t){return ['waiting_input','needs_review','fenced'].includes(taskState(t));}
export function currentTask(t){return t.execution_policy==='cloud-autonomous-v1'||t.managed_execution?.budget?.mode==='unlimited';}
export function taskDraft(t,action,body=''){const id=t.task_id;const prefix=`关于任务「${t.title}」（任务 ID：${id}，当前第 ${t.spec_revision??'未知'} 版）：\n`;const actions={followup:body,pause:'暂停该任务，保留已有成果和上下文。',resume:'继续该任务；先核对原状态，不复活已停止任务，不重跑已完成工作。',stop:'停止该任务的后续执行，保留已有记录与成果。',signal:body,query:'查询任务的整体进展、待处理指示和当前成果，不重新执行。'};if(!Object.hasOwn(actions,action))throw Error('UNKNOWN_UI_ACTION');return prefix+actions[action];}
export function signalDraft(t,s){return taskDraft(t,'signal',`我明确通知计划「${s.timing.rule.name}」（计划 ID：${s.id}）的条件已经满足。请发送一次该命名信号，不将普通补充当成触发。`);}
export function usageLabel(b){if(!b)return '尚无用量记录';return b.mode==='unlimited'?`${b.used??0} 次已记录请求 · 无调用次数上限`:`${b.used??0} 次已记录请求 · 历史限制记录` ;}
export function scheduleLabel(s){const r=s.timing?.rule??{};return r.kind==='event'?`等待「${r.name}」`:r.kind==='weekly'?`每周 · ${r.timezone??r.tz??'以保存时区为准'}`:r.kind==='interval'?'按间隔执行':r.kind==='once'?'指定时间执行':'依赖触发';}
export function lifecycleActions(t){const s=taskState(t);if(['stopped','cancelled'].includes(s))return [];return ['paused','pausing','resuming'].includes(s)?['resume','stop']:['pause','stop'];}

export function selectedTask(detail,id){return id&&detail?.item?.task_id===id?detail.item:null;}
