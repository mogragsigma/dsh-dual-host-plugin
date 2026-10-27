---
title: "代码架构与问题定位报告"
description: "alpha32 的模块职责、边界、持久状态、关键链路和修改定位"
author: "DSH 双端协作项目"
created: "2026-10-25"
updated: "2026-10-26"
version: "1.0.0"
status: "draft"
category: "architecture"
tags: ["dsh", "dual-host", "alpha32"]
related:
  - "./release-v0.33.0.md"
  - "./existing-setup-alpha32-10.md"
  - "./notification-defaults-alpha32.md"
  - "../CHECKPOINT.md"
  - "./dsh-upgrade-adaptation.md"
  - "./validation-alpha69.md"
  - "./production-acceptance-alpha32-11.md"
  - "./source-export-alpha32-11.md"
  - "./task-focus-preview.md"
  - "./workbench-approval-alpha33.md"
---

# 代码架构与问题定位报告

本报告以 alpha32 架构为基础，已补齐 `0.33.0` 正式源码的介入、审批及原生容器适配。
运行中双端仍为行为等价的 alpha.9；依据源码与分层验收，不是仅依据需求。
正式运行基线与源码脱敏导出清单分开保存，非行为清理不冒充再次部署。阅读顺序：入口 → 所属模块 → 契约与账本 → 测试 → 三制品。
这是维护文档，不改变既有运行配置或授权。

以下第01—04步为历史分步接线记录，现已包含在正式 alpha33.9；撤除通行密钥路线，现有身份复用边界见
[第01步身份复用](identity-reuse-alpha33-2.md)。旧 alpha33.1 仅保留历史设计，不再适用。第02步新增 `intervention-state.js`（纯投影）、`task-interventions.js`（云端观测表），
通过 `task-board.js` 的 `board_interventions` 与 `task_interventions:1` 接入工作台；不改审批或调度状态机。
详见[持久介入事项](interventions-alpha33-3.md)。第03步新增 `workbench-im-identity.js`（既有IM窗口身份）、
`workbench-decisions.js`（准备／解释／保存）、`approval_interaction:1`（独立协商）。
通过原生工作台认证路由和配对链路写原审批账本，不启动执行器；UI能力仅内存保存，不增加通行密钥。
`approval-ledger.js` 新增工作台IM证明与意见读取；来源观测表仍不授予权限。
第03步时，真实浏览器与双角色隔离Host通过，但身份平台使用合成来源。第04步真平台证据见下段；当时原生 Desktop 未验，本轮补验见 `desktop-deployment-alpha33-9.md`。
详见[第03步接线与回退风险](workbench-decisions-alpha33-4.md)。第04步新增 `approval-local-relay.js` 与 `approval_local:1`：本地凭据保留、固定私聊平台请求、持久双端请求账本。
新本地工作台决定可在方案未送 IM 时单独登记回执，不补发历史决定；结果通知目标相同但仍需原通知授权。
真实隔离平台验收与限制见[第04步记录](local-im-approval-alpha33-5.md)。下文 alpha32 仍为正式历史基线。

## 目录

- [一、架构边界](#一架构边界)
- [二、入口与模块地图](#二入口与模块地图)
- [三、通信与交互契约](#三通信与交互契约)
- [四、持久数据与关键流程](#四持久数据与关键流程)
- [五、问题定位与变更影响](#五问题定位与变更影响)
- [六、已知耦合与维护原则](#六已知耦合与维护原则)

## 一、架构边界

系统分为两套 DSH Host 和外部渠道／仓库。两端安装同一插件包，以真实角色配置区分职责。
云端 Coordinator 是任务与审批权威；本地镜像与 UI 快照是观察，不是分布式写入许可。

三条平台通路必须分开：

1. 用户 → Desktop／Web／IM → 原生入口 → 自有工具：交办、查询、确认。
2. 本地插件 ↔ SSH 承载 ↔ 云端插件：配对、任务协议、持久消息与文件传输。
3. 云端受控交付 → Git CLI／SSH／API → 用户 B 仓库：可选成果读写，不承担通信或锁。

A 仓库只保存产品源码，不参与运行任务。IM 的平台账号、Host 配对身份、Git 身份与审批批准人也不能互相替代。
下文所有文件均相对仓库根；完整直接依赖可搜索 [模块索引](module-index.json)。

## 二、入口与模块地图

### （一）公开入口与两种运行路径

| 文件 | 职责 | 修改注意 |
| --- | --- | --- |
| `bundle/package.json` | 包出口、Web client、依赖与 peer 声明 | `.` 指向 `native-entry.js`；不是直接装载 `index.js` |
| `bundle/cordis.patch.yml` | 官方插件选择时挂载自有原生入口 | 空配置只发现能力，不视为安装／执行同意 |
| `bundle/native-entry.js` | 单 Host 单 owner、身份校验、导览生命周期与业务运行时接线 | `WeakMap` 防重复挂载；拒绝旧入口，不能重新开第二个 IM consumer |
| `bundle/onboarding-host.js` | 六页导览服务聚合、POST RPC 分发、服务发现 | 导览 owner 不应随着执行服务热重载而销毁 |
| `bundle/index.js` | `Gateway` 业务聚合根；云端账本、本地 DirectLink、接口服务 | 不在此堆入 UI／路径安装逻辑；不绕过 admission 与 maintenance |
| `bundle/native-tools.js`、`native-context.js` | 原生工具与追加上下文 | 不能接管原生所有消息、修改预置模式或替换用户规则 |

**新安装路径**：无旧 gateway 配置 → 导览 owner → 经确认的云端 runtime 与本地配对 → 挂载 Gateway。
相关文件为 `onboarding-task-runtime.js`、`onboarding-task-runtime-native.js`、
`onboarding-cloud-task-runtime.js`、`onboarding-local-pair.js`、`onboarding-local-pair-native.js`。

**历史显式配置路径**：已含 role／stateDir／tokenFile → 仍经维护 admission 延迟启动 Gateway。
此路径保留兼容，不表示新用户需要手写这些字段。不要混用两条路径生成两个运行时。

### （二）业务功能模块

| 功能块 | 核心文件（`bundle/` 下） | 责任边界 |
| --- | --- | --- |
| 任务定义与上下文 | `task-envelope.js`、`task-catalog.js`、`task-context.js` | 原文、理解摘要、任务修订分离；名称不是权威关联键 |
| 忙闲与写入所有权 | `store.js`、`repository-writer.js` | task owner、epoch、revision、busy、意图队列与基线 |
| 协议协商 | `link-contract.js`、`diagnostics.js` | 方法映射到能力版本；实例变化与兼容失败阻断操作 |
| 双向可靠消息 | `peer-mailbox.js`、`durable-inbox.js`、`recovery.js` | 持久收发、去重、失败分类；未知不当成功 |
| A2A 委派 | `task-a2a.js`、`a2a-dispatches.js`、`a2a-worker.js`、`a2a-endpoint.js` | 委派预算、执行绑定，不是把聊天文本当可信命令 |
| 调度与模型 | `task-scheduler.js`、`task-jobs.js`、`task-worker.js`、`model-selection.js` | 独立会话、有界请求、检查点、目标端模型解析 |
| 周期与子任务 | `task-triggers.js`、`task-trigger-time.js`、`task-workflows.js` | 未来／周期触发、输入等待、受控子任务 |
| 可信审批 | `approval-ledger.js`、`approval-chat.js`、`approval-feishu.js`、`approval-semantics.js`、`approval-semantic-model.js` | 可信来源及引用先验证，再解释语义；不是语义模型自行批准 |
| 审批回执 | `approval-reference.js`、`approval-receipts.js`、`approval-guidance.js` | 方案与结果区分、引用归属、账本驱动回执 |
| 仓库关联／只读 | `repository-catalog.js`、`repository-gitee.js`、`repository-managed.js` | 仓库登记、读取、任务关联分别处理 |
| 受控开发 | `development-runtime.js`、`development-gate.js`、`development-workspace.js`、`development-worker.js` | 审批与真实路径、基线、文件／命令、模型、预算共同约束 |
| 提交推送 | `delivery-runtime.js`、`delivery-preview.js`、`delivery-commit.js`、`delivery-push.js`、`delivery-journal.js` | commit／push 独立批准和状态；未知结果核对，不重新造提交 |
| 成果 | `task-artifacts.js`、`delivery-artifacts.js`、`artifact-media.js` | 成果归属、介绍、存在性、仓库链接或原执行会话 |
| 通知 | `notification-defaults.js`、`onboarding-notification-defaults.js`、`notification-discovery.js`、`notification-targets.js`、`task-notifications.js`、`im-delivery.js` | 导览默认本地/云端选择、仅新定时任务继承、队列去重；接收目标和路由分别验证 |
| 文件直传 | `peer-files.js`、`peer-file-fs.js`、`peer-file-review.js`、`peer-file-migration.js` | 授权根、快照／哈希、分块、拒绝覆盖与队列恢复 |
| 文件与原生媒体 | `native-file-reference.js`、`onboarding-file-transfer.js`、`notification-artifacts.js` | IM 文件引用归属与 Host 文件的桥接，不能任意读取附件路径 |
| 来源研究 | `task-sources.js`、`source-search.js`、`source-web.js`、`search-contract.js` | 来源证明与辅助模型预算，不扩大文件／网络授权 |
| 工作台与状态 | `workbench-host.js`、`workbench-proxy.js`、`task-board*.js` | 快照、会话入口、任务／审批／交付视图，不执行后台业务 |

### （三）导览与安装模块

| 模块族 | 主入口及关键文件 | 关键约束 |
| --- | --- | --- |
| 既有双端复用 | `onboarding-existing-host.js`、`onboarding-existing-setup.js` | 认证只读观察、目标端模型解析、通知规范化比较、独立确认；不认领旧 Host |
| 字段与路径 | `onboarding-schema.js`、`onboarding-paths.js`、`onboarding-boundary.js` | 格式有效不等于连通；候选路径不等于实际加载；拒绝危险根路径 |
| 持久草稿／秘密 | `onboarding-state.js`、`onboarding-models.js`、`onboarding-token-plan.js` | 公开 credentials 服务；普通草稿不能带秘密值 |
| 规则／Skill 安装 | `onboarding-installer.js`、`onboarding-install-fs.js` | 计划快照、保护追加、归属清单、冲突拒绝、失败回滚 |
| 云端初始化 | `onboarding-cloud.js`、`onboarding-native-host.js`、`onboarding-runtime-program.js` | SSH 预检、官方包、受管归档与原控制器；不执行任意模型脚本 |
| 跨端凭据 | `onboarding-handoff.js`、`onboarding-handoff-remote.js`、`onboarding-cloud-models.js` | 目标身份／计划／修订绑定；未知先核对原操作 |
| IM 与 Gitee | `onboarding-im.js`、`onboarding-cloud-im.js`、`onboarding-repositories.js`、`onboarding-cloud-repositories.js` | 通过公开服务适配；目标端检查，不用本地成功冒充云端成功 |
| 运行时授权 | `onboarding-task-runtime-contract.js`、`onboarding-cloud-task-runtime.js` | contract 4 显式只读 worker 选择；旧 schema 不自动启用 worker |
| SSH 与 Web | `onboarding-ssh.js`、`onboarding-ssh-forward.js`、`onboarding-cloud-web.js` | 保留主机密钥验证；工作台只走已验证承载与会话归属 |
| 维护协调 | `onboarding-activity.js`、`onboarding-coordinated-hold.js`、`onboarding-maintenance-record.js` | 自有任务 hold 与原生输入不是同一范围 |
| IM／Host 生命周期 | `onboarding-im-maintenance*.js`、`onboarding-self-stop.js`、`onboarding-self-disable.js`、`onboarding-self-remove.js` | 显式风险确认、独立恢复确认，不能宣称无损停机 |
| 版本与恢复 | `onboarding-runtime-version*.js`、`onboarding-runtime-repair*.js`、`onboarding-runtime-uninstall*.js`、`onboarding-runtime-reclaim*.js` | 原事务与归属精确处理；不强行重写旧签名控制器 |

这里文件数量较多，是因为本端操作、跨端客户端、目标端验证和失败恢复被分开。
维护时先定位对应层，不要为了“统一入口”删除目标端重复校验。

### （四）界面、规则与构建

- `ui-source/workbench-client.js`：工作台入口与视图，`labels.js` 提供展示映射。
- `ui-source/onboarding/app.jsx`：六页组合；各 `*.jsx` 是表单与确认界面，`*-flow.js` 承载局部交互状态。
- `ui-source/onboarding/field-help.js`：字段含义、来源、必填性、跳过影响。
- `ui-source/onboarding/rpc.js`：前端请求与错误边界；不能自行写服务器状态。
- `scripts/build-onboarding.mjs` → `ui-source/onboarding.generated.js`。
- `scripts/build-ui.py` → `bundle/workbench-client.js`；CSS 限定 `.dtu`／`.dsh-onboarding`。
- `bundle/global-rules/AGENTS.md` 的 Host 占位符由安装计划替换，不在源码写死真实用户路径。

## 三、通信与交互契约

### （一）入口到工具

原生 DSH 处理 Desktop／Web／IM 会话；插件通过公开工具和上下文扩展业务，不依赖第三方源码补丁。
自然语言首先明确目标、任务、模型与约束；工具返回内部 ID，模型不要求用户背诵它们。
界面经 DSH `connection.fetch` 的 POST RPC 访问 `task-onboarding/control` 等自有接口，
遵守原生鉴权和跨站保护，不能因受限而直接拼内部未认证 URL。

### （二）Host 到 Host

`Gateway` 的 HTTP 监听为 `127.0.0.1`；显式配置路径使用 bearer 与 SSH connector，
新导览路径使用受管配对／SSH 传输并继续验证目标与授权。
`link-contract.js` 维护 protocol 范围、`CAPABILITIES`、`METHODS` 与协商失败分类。
版本号相同不能替代能力校验；能力缺失、角色不符、实例改变和维护屏障均应停止相关动作。

本地向云端发请求，云端 broker 保存反向消息，本地读取并确认，实现逻辑双向通信。
状态 TTL、观察时间与实例只帮助诊断；云端看到最近联系不证明 Mac 此刻空闲。
文件走 offer／pull／chunk／commit／read／ack 契约，并持久化哈希、归属和状态。
`protocol.js` 的旧群聊签名通知是历史提示协议，**不是现行直连入口或审批协议**。

### （三）Web 与外部平台

云端工作台复用已确认 SSH 承载，经一次性票据换取访问，并保留原生 Cookie／WebSocket 校验。
官方 HTTP 桥内的 `Request.url` 可能是 `dsh.internal`；本机展示名从已通过原生鉴权的 Host header 限定读取。
`localhost` 与 `127.0.0.1` 不能随意混用；不重写 Origin／Sec-Fetch-Site 绕过原生防护。
浏览器 Cookie 的转发也有过滤，不向云端泄露同一 loopback 上其他服务的 Cookie。

Gitee 的只读 API、Git SSH 与 IM 平台接口是独立权限域。SSH 登录 ECS 不证明有仓库写权限；
Gitee API 读成功不证明 push 成功；平台接受通知不证明手机已读。

## 四、持久数据与关键流程

### （一）权威状态位置

| 状态 | 归属模块／存储 | 含义 |
| --- | --- | --- |
| 配置、秘密与计划记录 | `onboarding-state.js` 等，DSH credentials 命名空间 | 使用 kind、owner、schema、revision 与操作 ID 校验；秘密值不展示 |
| 收发与本端网关 | `<stateDir>/gateway.sqlite` | inbox、peer outbox／broker／inbox、文件传输等本端状态 |
| 云端任务与业务账本 | `<stateDir>/coordinator/tasks.sqlite` | task、ingress、intents、任务修订、审批、成果、通知、交付等扩展表 |
| 任务批次与调度 | `<stateDir>/scheduler/jobs.sqlite` | jobs、runs、controls、inputs、events、模型请求预留与检查点 |
| 受管安装／维护 | 归属清单、原计划／控制器和各操作回执 | 精确恢复／卸载依据，不靠进程名、目录存在或最近时间推断所有权 |

表由各类构造器与迁移逻辑管理，不应手工 SQL 改 `approved`、`completed` 或清掉 `needs_review`。
sqlite 文件与 WAL 一起属于运行态；备份需遵守停机／一致性策略，不能仅复制主文件声称完整。

### （二）真实只读任务闭环

1. 原生入口用自有工具登记原文／摘要，按目标端目录解析模型，保存任务修订。
2. 云端任务运行时已明确授权后，调度器将任务登记为 job；这一步不是实际完成。
3. `NativeTaskWorker` 创建独立原生会话，挂载只读 preset，绑定 job／run／claim／模型与预算。
4. 每批输出检查点或报告；等待时释放活动 worker，重启后根据原 job 继续，不新建周期冒充恢复。
5. 成果核验归属并登记；UI 打开原执行会话。授权通知只覆盖绑定之后的事件。

原生入口未被占用的证明与后台完成的证明要分别保存；一次探针通过不能代替真实 IM 链路。

### （三）开发、审批与交付

1. 任务按需关联 B 仓库，读取基线与权限，生成明确方案和修订。
2. 可信聊天引用具体方案；插件验证身份和引用，语义分类后写入批准／拒绝／暂缓／需修改。
3. 账本驱动权威回执；语义判断或原生 IM 口头回复不能替代该回执。
4. 开发运行时核验门禁，取得当前任务的写入所有权；对端在忙碌时排队，空闲后核对基线交接。
5. commit 与 push 各自预览、审批和执行；commit 已完成不表示远端已接收。
6. 失去响应先查 journal 和远端事实，保留未知状态；不能重复执行外部写入赌结果。

当前新导览默认只读闭环不自动启用上述开发交付链路。

### （四）安装与恢复

路径检测 → 计划预览 → 用户确认 → 归属／基线再次核验 → 执行 → 真实回执。
失败回滚只恢复能证明属于本操作且未被他人修改的对象；已漂移文件和用户新增内容必须保留。
跨端超时分为“未发送”“未知”“目标已应用”等状态，不能统一显示失败并提供盲目重试。

## 五、问题定位与变更影响

| 症状／改动 | 首查文件 | 对应测试入口或关键词 |
| --- | --- | --- |
| 新安装只有导览、没有任务工具 | `native-entry.js`、`onboarding-task-runtime*.js` | `onboarding-task-runtime.test.mjs`；检查显式授权而非直接开开关 |
| 角色串端、云端配置写到本地 | `onboarding-identity.js`、`onboarding-cloud-*.js` | `three-party-rules.test.mjs`、onboarding cloud / handoff tests |
| “ds flash”解析失败或模型被换 | `model-selection.js`、`native-tools.js` | `model-selection.test.mjs`；目标端目录和策略回执 |
| 总批次被误当请求次数 | `task-scheduler.js`、`native-tools.js`、`link-contract.js` | `native-schedule-budget.test.mjs`，同步 Skill／全局规则 |
| 重启后卡住或出现重复执行 | `task-jobs.js`、`recovery.js`、`peer-mailbox.js` | scheduler / recovery / inbox tests；只读检查原 claim 和回执 |
| 条件同意仍执行旧方案 | `approval-semantics.js`、`approval-ledger.js` | approval semantic / chat / ledger tests；核对修订失效 |
| 原生 IM 接口升级后报错 | `notification-discovery.js`、`onboarding-im-maintenance-native.js` | `notification-discovery.test.mjs`；区分数组与 RPC envelope |
| 任务完成但未通知 | `task-notifications.js`、`notification-targets.js` | 目标授权时间、start_seq、no_authorized_target；不补发旧事件 |
| Gitee 绑定正确但无权限 | `onboarding-handoff*.js`、`repository-managed.js` | 目标端凭据／读取回执；不借用本地或日常令牌 |
| 成果按钮打不开、跨站拒绝 | `workbench-host.js`、`workbench-proxy.js`、`onboarding-cloud-web.js` | managed-browser-navigation / cloud-web / carrier-headers tests |
| 文件传一半或覆盖风险 | `peer-files.js`、`peer-file-fs.js`、`onboarding-file-transfer.js` | peer-file / file-transfer / file-review tests；核对源快照和目标归属 |
| 全局规则未生效或用户内容漂移 | `onboarding-paths.js`、`onboarding-installer.js` | `onboarding-install.test.mjs`；真实原生加载与哈希保护分别验证 |
| 停机／维护一直 busy | `onboarding-activity.js`、`onboarding-coordinated-hold.js` | `onboarding-maintenance.test.mjs`；避免把维护请求本身当业务 busy |
| UI 按钮重叠或样式污染原生 | `ui-source/`、`scripts/build-ui.py` | 构建后隔离 Host 实际窄宽屏、键盘和 reduced-motion 检查 |
| commit／push 状态不明 | `delivery-journal.js`、`delivery-push-recovery.js` | delivery recovery tests；CLI 查原提交与远端引用，不浏览器补操作 |

快速本地查询示例：

```bash
rg -n '错误码或工具名称' bundle ui-source tests
python3 scripts/build-module-index.py --check
python3 scripts/check-foundation.py
python3 scripts/run-onboarding-regression.py
```

变更审查至少覆盖：契约与输入校验、账本／迁移、UI 回执、Skill、全局规则、正负向测试。
不是每次都要改六层，但应明确哪些层不受影响，不能只改提示词掩盖运行时错误。

## 六、已知耦合与维护原则

- `index.js` 与 `onboarding-host.js` 是较大的组合根，主要负责装配。局部新逻辑应下沉到相应模块，
  但本次报告不授权顺便重构它们。
- 历史显式配置和新导览路径并存；新导览不能用旧路径的默认端口、root 用户假设或手写配置冒充通用适配。
- 历史 `legacy-feishu-adapter.js`、`protocol.js` 与旧工具仍在仓库，公开入口明确拒绝恢复旧消费者。
- `compatibility.json` 保留多阶段声明，不能作为实时验收数据库；后续版本宜保持独立验证清单。
- 导览维修不能改写原签名归档骗过能力判断；不兼容就新计划／明确迁移或保留人工处理。
- 未建立操作系统级身份隔离；插件门禁只约束自有工具路径，不能阻止其他插件或用户直接调用 Shell。
- 原生 Host 缺少“封闭所有输入”的公开接口。空闲检查之后的新消息仍可能被停机中止，必须告知风险。

## 七、alpha32 新增路径与定位

| 现象 | 优先检查 | 不应采取的处理 |
| --- | --- | --- |
| 两端通知内容相同但显示不同步 | `onboarding-existing-setup.js` 的固定字段投影、revision、operation、target | 对原始 JSON 插入顺序做哈希比较，或重置用户通知授权 |
| 定时任务默认发错端或缺少通知 | 导览 grant → `notification_default_policy` → `notification_default_tasks` → 单任务 binding → 持久 outbox | 修改第三方 IM 或将机器人自身视为接收对话 |
| Mac 恢复后通知仍排队 | `onboarding-activity.js` 的固定同步标签、原通知 attempt 与端侧 inbox | 重跑 worker、换通知 ID、给原结果再发一遍 |
| 预期一批却生成多批 | `native-tools.js` 的 `max_runs` 必填校验及 `native-schedule-budget` 测试 | 以全局默认值替代本次明确预算 |
| 模型结束却没有成果报告 | `task-worker.js` 的原生结束信号和 `WORKER_MODEL_OUTPUT_LIMIT` | 将输出截断当成功，或自动提高预算 |
| 升级后规则安装拒绝 | 安装器真实 20 文件归属、用户前缀与模板总字节限制 | 旧标题替换、截断用户原文、伪造安装账本 |
| 本地工具核验通过但 UI 不可跳转 | 任务/实例新鲜度、手动刷新、会话归属与工作台承载 | 自动刷新全部任务或直接使用未鉴权 URL |

`existing_setup_preview` 在确认前只取证，`existing_setup_apply` 仅保存自有 grant。
`onboarding-draft-v1` 不因复用分支而改 schema；`onboarding-existing-setup-v1` 保存选择和裁剪证据，
不存 Key、原始会话或完整凭据。重启后历史回执不等于当前在线，未知保存先查询原操作。

alpha.11 源码清理未改以上调用链。文件发送的敏感目录名采用等价正则字符转义，保护范围不变；
角色 PNG 仅移除来源元数据容器，图像数据块和尺寸字节保持，仍需独立核验商业使用条件。

## 第05步异常介入候选

`intervention-actions.js` 管理建议／身份／确认凭证；`intervention-job-control.js` 在 jobs 事务内保留旧预算、结束旧批次并创建有界补充。
通过 `intervention_actions:1` 独立协商，不向模型暴露审批令牌或动作，不回退旧 job_control。
`TaskBoard` 显示原始观测和处理回执的当前进度；UI 源为 `intervention-action-view.js`，不要手改生成文件。
诊断优先查 intervention_operations → controls 原回执 → job/run；unknown 只能读原事务，不能重放。
适用范围、跨库崩溃处理与实际证据见 [第05步说明](./intervention-actions-alpha33-6.md)。

## 第06步成果与对话查询候选

`task_results → task-results.js → TaskBoard` 提供只读名称匹配与快照，多个匹配只返回候选。
`task_artifact_access → TaskArtifacts.access` 保留固定版本 Gitee／所属执行会话核验，不返回文件正文。
工作台明确下载走 `task-artifacts/control(download) → artifact_download → TaskArtifacts.download`，
仅通过配对通道返回有效报告；浏览器 `artifact-download-client.mjs` 再核对摘要并交给保存。
该下载方法未注册成模型工具，不接受路径／URL，不赋予审批或仓库写入权限。
失败回执需保留官方 RPC 的 `code/message/details` 三项，缺项会使真正的文件错误变成容器技术报错。
候选与未验边界见 `artifact-access-alpha33-7.md`；正式环境没有随源码修改而切换。


## alpha33 原生 Desktop 与本地审批路由

当前正式双端为 `v0.33.0-alpha.9`，部署与验收范围见 `desktop-deployment-alpha33-9.md`。

- 主入口：工作台 → 官方 owner 鉴权 → `workbench-host.js` → 工作台身份／决定服务 → 云端审批账本。
- 辅助入口：云端协调器 → 自有认证 A2A → 本地审批端点 → 现有 IM 私聊；原文与引用通过官方平台读取核验，非模型自行批准。
- `native-owner-origin.js` 封装官方原生 Host 的缺 Origin 兼容，仅供已注册的官方 owner 路由使用；不是可独立鉴权的函数。
- `task-artifacts.js` 共享该前置检查后仍执行原成果归属／修订／哈希／权限验证。不能把桌面兼容例外用于任意 HTTP 服务。
- `approval-feishu.js` 通过公共 credentials 服务解析明确本地引用，轮换／撤销清理缓存；云端不保存本地机器人秘密。
- 全局规则与 Skill 仅做行为指导；实际身份、审批、执行、交付门禁仍由插件及持久账本分别强制。
- 存量切换仅调整自有入口和明确的审批路由，规则通过保护性维护升级；禁止重写第三方配置或整库覆盖新业务。


## v0.33.0 正式源码与运行安装的区别

- `package.json`、锁文件根项、`compatibility.json` 与协议 VERSION 统一为 `0.33.0`；包描述改为中性能力说明。
- 相对 alpha.9 的核心模块、全局规则和 Skill 字节不变。包仍 `private: true`，市场分发包名和许可证尚未决策。
- 官方 Host／IM 版本未升级；本次源码同步不是又一次生产部署。基础核验以 `source-bundle-v0.33.0.json` 为准。
- 新增 `run-intervention-regression.py` 固定 45 个已审查测试文件，并补充元数据晋级检查，避免通配运行历史测试。
- `tests/package.json` 显式拥有历史身份与 YAML 测试依赖，不将它们加入运行包；不通过生产依赖寻找测试解析器。
- 发布验收与交接见 `release-v0.33.0.md`。市场发布前必须独立验证实际分发包的新装与升级，不以本次改号代替。
