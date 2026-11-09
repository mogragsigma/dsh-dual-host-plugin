# R1 纯接收核心

开发候选 `0.34.0-alpha.1`，正式版本仍为 `0.33.4`。仅用于隔离验收，未发布。
R1 不开启 observe/auto，不创建任务，不产生 Input/wake/Eval，不接真实 IM 或平台订阅。

## 依据与复用

- 已通过 F24 的限定接收、稳定身份与持久去重，F31 的来源接入与执行授权分离。
- DeepSeek 固定原型 `6337fc823ce20251c8de8085948165c81aaa701e` 的
  `core/intake.ts`、`core/engine.ts`、`app/source-context.ts`：参考接收事务及有限来源接口。
  **未移植原型代码**；未接入其中的任务关联、addInput、queueForEval、wake 或 notify。
- 复用已有 Gateway 数据库、原生 owner、维护屏障和 `recovery.tx`；不另建事件服务/任务权威。
- 旧任务内资料来源 `task-sources`、mailbox、人工信号保持原语义，不能当作新事件接收入口。

## 接口与数据

`bundle/source-intake.js` 是唯一新增产品模块。由 Gateway 内部装配，无公开 RPC、模型工具或用户队列管理页。
可信程序先调用 `bind(sourceId, adapterId)`，得到只含以下动作的有限接口：

| 动作 | 说明 |
| --- | --- |
| `receiveBatch({expectedCursor,nextCursor,configRevision,events})` | 整批校验、事务、去重及游标 CAS；COMMIT 后才回执 |
| `read({after,limit})` | 按接收序号分页；来源引用及资料不是执行许可 |
| `status()` | 当前 cursor、已提交配置修订、数量、成功时间及稳定错误码 |

绑定入口比准备稿多一个 `bind`，用于把 Adapter 身份固定到程序装配，而不是让事件正文自选来源。
单条事件必填 `id/scope/occurredAt/actor/thread/text`，可选无账户密码的 HTTP(S) `url`；未知字段拒绝。
actor 的 `human` 只是原始声明，不证明人类批准。可靠编辑修订由 Adapter 编入稳定原始 ID。
同文不同 ID、跨来源同 ID 均保留；同键不同内容拒收整批，不能静默覆盖。

仅在第一次获准接收时，在既有 `gateway.sqlite` 创建：

- `source_intake_events`：来源/原始 ID 唯一键、规范化指纹、首次处置、接收时间、可选正文。
- `source_intake_state`：schema 标记、固定命名空间/Adapter 身份、配置修订、cursor、最小健康状态。

schema 为 1；不修改整个共享数据库的 `user_version`。未知版本拒绝，不清库或自动降迁移。
范围外记录仅保留身份、指纹、过滤处置及接收时间，不存正文或 actor/thread 引用。
过滤不改变内容指纹：调整范围后重读同一事件不会产生虚假冲突，也不补存历史过滤正文。
重新读取相同 ID 不等于重新处理；内容编辑必须有可靠修订身份。

## 配置、限制与生命周期

`sourceIntake.enabled` 默认关闭，`sources` 缺省不绑定来源。每个来源是：
`{id, adapterId, namespace, enabled, revision, scopes}`。scope 是明确的精确匹配对象，不是任意路径通配符。
每批在事务内重新复核开关、配置及当前 cursor；旧配置读取的批次不能直接提交。
sourceId/namespace/adapterId 是持久身份，不能借改显示配置给旧数据换归属。

- 每批最多 64 条、单正文 64 KiB、批正文合计 1 MiB、分页最多 100 条、cursor 最多 2048 字节。
- 整库最多 100,000 条来源记录（含过滤事实）；容量不足拒收，不自动删除数据。
- 这些是接收实现护栏，不是 F22 用户文件传输上限，也不是无限存储或大规模性能保证。
- 不透明 cursor 只做相等比较；Adapter 每次提交必须给不同的下一位置，不能当时间字符串排序。
- 无内部轮询、后台重试或 Agent；测试 Adapter 是显式单次拉取，ACK 只在 receiveBatch 成功后发生。
- Gateway 维护 hold 阻止新批次；关闭先关闭接收能力，再由原 owner 关闭共享数据库。
- 禁用不删除记录。重新启用只接收事实，不能重放批准或启动旧任务。

SQLite 忙、只读、空间不足、损坏、cursor/内容冲突、配置变更都有稳定错误码。
错误详情不向状态接口输出堆栈或凭据；存储不可写时，失败健康信息只能在当前实例内观察。
修复 `recovery.tx` 的回滚错误覆盖：SQLite 已自动回滚时，保留原始错误（例如 FULL），不误报成功。

## 验证与回退

具名集合：`python3 scripts/run-r1-regression.py`，只能在隔离启动器中执行。
包含内存与限定文件两种测试 Adapter、临时 SQLite、进程退出、配置变更、维护及依赖负例。
测试 helper 不进入 npm 包；平台接线、真实凭据、真实模型及业务通知均不在本阶段范围。

新表是加法迁移。停用接收后，0.33.4 Gateway 能打开/关闭同一隔离库且不改变新表。
回退只换代码，不以旧整库覆盖新事实；不能在当前宿主上回退到只声明旧 DSH 的 0.33.3。
接收回执只证明本地持久保存，不代表执行、通知送达、用户已读或外部 exactly-once。
