---
name: task-schedule
description: 原生任务的一次性、周期、明确事件触发、等待输入、依赖与有界并发；先加载 task-direct-link，所有调度仅作用于任务指定模型的只读能力。
---

# 原生持久任务调度

## 一次任务的批次预算（先读）

task_schedule 必须明确传入 max_runs，漏传会被运行时拒绝，不能继承旧默认 4。未说明总批次预算时先用自然语言澄清；任务正文的一句话不能替代持久门禁。

一次任务内保存检查点再继续，仍只调用一次 task_schedule；max_runs 是总 worker 批次数，含重启继续，不是模型请求数。每批模型请求上限固定 6 次。用户说“两批、每批最多六次”，就传 max_runs=2；由 worker_report 的 checkpoint.delay_seconds 安排下一批，主会话立即返回。不需要 interval、workflow 或新增任务。不支持所需额度时说明，不探查源码、配置、数据库或用 shell 补工具。没有单独通知目标时只说成果已保存可查询，不承诺自动回传当前群。

## 入口与授权

- 先按名称用 task_catalog 定位，再 task_status 读取修订；名称不唯一时澄清，不要求用户填写内部 ID。
- task_submit / task_update 的 register 仅登记；只有明确 plan 修订才能按保存的模型策略调度。
- 模型 provider、model 和明确指定的 reasoningEffort 属于当前任务。不可换成入口默认或固定 GLM-5.3。
- 普通即时或单次延迟任务可用 task_schedule；周期、日历时刻、事件用 task_trigger_create。
  同一任务已有未结束触发计划时，不能另外用 task_schedule 偷加批次。
- 开发审批已有独立账本，但任何只读触发、补充输入、恢复或任务完成均不构成开发批准。
  旧 /run、/approve 等测试命令不接管原生 IM；不要求用户记编号。

## 明确计划后才创建触发

- task_trigger_create 接收当前 expected_revision、相同 model_policy、timing 及可选 dependencies。
- timing 必须明确 end_at、max_occurrences（1—366）和每次 max_runs（1—10）。用户没有给出结束范围或预算时先澄清，
  不把“持续跟进”擅自解释为无限循环或默认三次。可说明建议值，得到同意后再登记。
- 时间可传带明确偏移的 ISO 时间，例如 `2026-10-20T09:00:00+08:00`；不猜服务器时区。
- once：rule.at，max_occurrences 必须为 1；立即执行仍使用 task_schedule。
- interval：rule.start_at 与 every_seconds，表示真实经过的秒数，不是墙上钟点。
- weekly：rule.start_at、weekday（周一 1 至周日 7）、hour、minute 和用户明确的 IANA timezone。
  夏令时不存在的时间向后移动，重复时间采用第一次；用户不能接受时需改时间，不隐瞒此策略。
- event：rule.name 是明确事件名，目前仅支持用户直接告知该事件发生；不假装已接入外部 webhook、
  文件监听、第三方消息监听或自动 A2A。后续外部事件能力须另行验证。
- dependencies 是已存在只读批次的精确 job_id；通过任务名和 task_status 取得。
  只在这些批次 completed 后触发；取消、失败、暂停、待输入都不是依赖成功。
  split_suggestions 仍不是实际子任务；真正执行须使用下面的 workflow 工具，并核对其账本。

## 等待、补充与控制

- task_trigger_list 显示计划、预算、错过次数和等待原因；task_trigger_control 控制整个计划。
- 没到时间、等事件、等依赖或输入时没有常驻模型循环，入口受理后立即返回。
- 离线错过多个时间点只合并为最新一次，记录 skipped，不突发补跑全部历史时段。
- 同一计划前一次未完成时不触发下一次；needs_review 不自动重试。
- 单批次等待输入时，读取 checkpoint.question 和 question_run_id，向用户说明问题。
  用户回答后用 task_input，Host 保存当条原文，恢复同一批次预算；不创建新任务绕过次数限制。
- 补充回答不改变模型、任务修订或批准。用户改目标/模型时先明确取消旧计划并确认排空，再 task_update。
- task_control 只处理具体批次，task_trigger_control 处理整个计划；单独暂停的批次不被计划恢复擅自恢复。
- 暂停不是 worker 已排空，也不是写权限。等待输入的暂停恢复仍须等回答，不能凭恢复制造答案。
- 计划过期、预算耗尽、版本不匹配均如实报告，不能清库、换 ID 或延长旧预算绕过。

## 可观察边界

- accepted 是已登记；触发计划 active 是已生效等待；queued 是批次排队；running 才是实际批次。
- waiting_input 为等待用户补充，waiting 为检查点间隔，closed 为计划已结束；不混称整个业务已完成。
- 进程重启后只读批次可按原预算恢复，实际开发仍采用独立待核对机制。
- 只读 worker 是独立根会话，不是独立 OS 进程；不声称系统级故障或账号隔离。

## 按需分解实际子任务

- task_workflow_create 仅用于用户当前明确要求的只读任务；提交当前 expected_revision、相同 model_policy，
  以及 1—6 个节点。每节点有 key、title、instruction、depends_on 和 max_runs（1—10）。
- 总预算 max_total_runs（最多 20）和 end_at（明确时区换算后的毫秒时间）须来自已澄清的用户要求，
  不能把每节点预算相加后当成用户已同意的新总预算。总预算至少覆盖每节点一次，但不保证每节点一定成功。
- 图必须无环，依赖只能指向本图 key；不能塞入命令、不同模型、任意工具或递归子图。
- 每节点是独立真实 job／执行会话，同父任务串行，其他任务可用剩余并发槽。
  父任务保留完整原文、版本和模型，子节点仅补充其工作范围和前置结果。
- 所有 checkpoint、用户补充后的继续、重启重试都消耗同一个共享批次预算；中断不退回已耗次数。
- task_workflow_list 给出父子关系、job、依赖、状态与预算，不能用 split_suggestions 冒充已派发。
- task_workflow_control 暂停／恢复／取消整图。独立暂停的 job 不被整图恢复偷偷启动。
  needs_review、过期、失败或审批中不得盲目恢复；不因点击恢复而批准开发。
- 同一修订不能在单批次、触发计划和子任务图之间来回切换以增加预算。范围变化先安全取消排空，
  再保全用户新请求并 task_update；不清库、换事件 ID 或删除失败记录。
- 当前是一次有界图，不支持递归派生或每个周期自动生成新图；不能向用户声称这些未验功能已经生效。

## 默认通知

定时任务创建后核对 task_notification_status。用户已在导览 3/6 确认并同步的本地／云端默认入口可由新任务继承；不要重复索要机器人 ID，也不要把它说成逐任务批准。旧任务、显式关闭、修改版本和未同步默认值不能自动沿用；本地离线只排队，不阻塞云端执行或换机器人。
