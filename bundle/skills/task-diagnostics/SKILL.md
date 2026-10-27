---
name: task-diagnostics
description: 用户询问双端连接、版本兼容、状态是否最新、队列卡住或回执含义时，读取自有插件只读诊断；不接管普通聊天，不自动修复或重发消息。
---

# 双端协议与恢复诊断

1. 调用一次 task_diagnostics，默认 refresh=true。只诊断，不建立任务、不循环轮询。
2. 分别解释当前 Host、应用层连接、协商的协议／能力版本、队列和最后观测时间。
   SSH 进程存在不等于应用健康，plugin_version 不等于协议版本；对端未升级或缺能力须明确说明。
3. cloud_cached=true、freshness=stale/recent_snapshot 只能描述历史观测。
   离线、unknown、unavailable、重启后的新 instance 都不能推断云端当前空闲或任务完成。
   age_ms 使用本端单调时钟；云端生成时间仅供展示，时钟偏差不产生批准或写权。
4. 任务进度仍按名称 task_catalog → task_status 读取权威结果。
   诊断缓存不能替代任务、审批或仓库门禁实时校验；没有响应就说状态暂不可确认。

## 队列恢复

- 协议、能力或命名空间不兼容：原持久记录等待兼容端，不消耗业务失败次数，不换编号重建。
- 普通临时网络故障：按已有有限退避恢复；超过限制或 needs_review 交人工核对，不清库强行重发。
- broker_saved 仍可能等待对端落盘；peer_saved 只表示持久收件，不代表对端模型已读或执行。
- 通知结果未知、needs_review：核对平台是否已有消息，不自动重发，不让用户重复批准来补回执。
- 诊断只有建议，不自动修改凭据、重启 Host、取消任务、释放 owner/epoch 或批准开发。
- 旧 IM 消费者继续停用；不靠第三方源码补丁或重放旧 inbox 修复。

## 回执分类

依据 receipt_classification.kind 和权威字段，不按聊天措辞猜测：

- intake_local：本端入队；intake_cloud：云端已登记。都不是执行中。
- peer_transport：通信排队／中继保存／对端持久收件。
- schedule：批次调度或控制，暂停不代表已排空。
- proposal_delivery：方案投递。chat_confirmation.state=sent **不是批准回执**。
- approval_ledger：有效批准看 state；权威回执看 chat_confirmation.receipts，二者分别汇报。
- repository_preflight：只读关联或预检；approved 与 read access 均不开放写入。
- notification：通知投递；sent 不证明用户已读，更不能反推任务成功。

送审时指明插件给出的确认端名称、具体方案标题和有效期。
用户回复具体方案可自然语言批准、拒绝、暂缓或提出修改意见，/yes 可选；不要求手写内部编号或点击卡片。
过期或回复错对象不能追认；先说明原因，按用户意愿重新送审，新的方案仍需本人确认。
拒绝待审方案与撤销已批准方案不同；不能把“不批准”说成已撤销。
