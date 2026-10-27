---
title: "DSH 升级适配手册"
description: "公开扩展点、版本核验、隔离回归、恢复启用和回滚边界"
author: "DSH 双端协作项目"
created: "2026-10-25"
updated: "2026-10-27"
version: "1.0.0"
status: "draft"
category: "runbook"
tags: ["dsh", "dual-host", "alpha32"]
related:
  - "./release-v0.33.0.md"
  - "./integration-alpha33-7.md"
  - "./existing-setup-alpha32-10.md"
  - "./code-architecture.md"
  - "./validation-alpha69.md"
  - "./production-acceptance-alpha32-11.md"
  - "./source-export-alpha32-11.md"
---

# DSH 升级适配手册

本手册用于 DSH 或依赖插件升级，不是自动升级授权。默认先隔离验证，不改 DSH／第三方源码。

## 目录

- [一、版本不是一个数字](#一版本不是一个数字)
- [二、必须核验的公开接口](#二必须核验的公开接口)
- [三、升级操作顺序](#三升级操作顺序)
- [四、回归矩阵与历史教训](#四回归矩阵与历史教训)
- [五、给接手 Agent 的交接清单](#五给接手-agent-的交接清单)

## 一、版本不是一个数字

| 层 | 核对位置 | 当前基线与注意点 |
| --- | --- | --- |
| 源码版本 | `bundle/package.json`、package-lock 根项、`link-contract.js`、`compatibility.json` | 源码 `0.33.0`；已安装仍 alpha.9，本轮未重部署 |
| DSH 运行中版本 | 官方 CLI／Host 实际回执 | 本轮 `0.2.1-rc.3`；安装版本不能代替进程版本 |
| 插件依赖 | `bundle/package.json` / lock | credentials、HTTP／search 等若仍固定 rc.2，不应批量改成 rc.3 |
| peer 声明 | 同上 peerDependencies | 部分 LLM peer 为 rc.2 或 rc.3；可选 Pi 接入不是纯 DeepSeek 必需项 |
| 新云端运行时 | `runtime-package.json` / `runtime-lock.json` | 官方 Host 锁定清单，与插件运行依赖是不同用途 |
| 可选 IM | `runtime-im-package.json` / `runtime-im-lock.json` | 当前新环境 5.6.0，旧 5.0.3 测试是历史证据 |
| 双端协议 | `link-contract.js` | protocol、能力版本、实例与角色均要验证 |
| 受管操作 | 各 `onboarding-*-contract.js`、计划及归档 | 旧签名控制器不因候选代码变新就获得新能力 |
| 用户环境 | 实际全局规则、Skill 根、已启用项、队列和凭据引用 | 只采集去敏摘要；不要输出秘密值 |

以上为当前 alpha33 维护基线；alpha32／alpha69 历史冻结证据保留。当前正式双端已切换至 `0.33.0-alpha.9`。
规则／Skill 也已通过真实安装器建立归属账本，后续升级须使用托管维护流程；插件本体仍为历史手工入口。
不要用 README 版本推断其他用户已经升级，也不要把恢复启用旧版称为部署新版。

## 二、必须核验的公开接口

| 上游扩展点 | 自有适配点 | 通过条件 |
| --- | --- | --- |
| Cordis `inject`／`effect`／`provide` | `native-entry.js`、`onboarding-host.js` | 一个 owner，释放正确；依赖重载不误销毁导览 |
| `agents`／`agentPresets`／`tools`／`sessions`／`llm` | `native-tools.js`、`task-worker.js` | 原生入口不被接管，worker 工具集与模型／预算正确绑定 |
| `systemPrompt.context` | `native-context.js` | 原生上下文追加而非覆盖，minimal 保持其原生无全局加载语义 |
| 全局路径／Skill 发现 | `onboarding-paths.js`、installer | 实际加载路径、OS 变量、冲突与用户内容保护分别验证 |
| `credentials` | `onboarding-state.js`、handoff | 命名空间、schema、修订与秘密隔离不变；无日常凭据回退 |
| `connection.fetch`、客户端 RPC | `onboarding-host.js`、`workbench-host.js` | 原生鉴权、Request 封装、响应结构及能力缺失失败方式一致 |
| 原生 browser／Web 客户端 | `ui-source/workbench-client.js` | Desktop 可导航；普通 Web 无该能力时显式回退，不创建额外任务 |
| 插件管理／退出接口 | `onboarding-self-*.js` | 只操作自己的精确安装项／进程；不靠进程名批量 kill |
| IM service /公开路由 | notification discovery、IM maintenance adapters | 新旧返回结构严格解析；机器人身份和原生消息引用真实可用 |
| 原生 Web auth | `workbench-proxy.js`、cloud web | Cookie／WS／Origin 校验保留，不以 token 拼 URL 长期暴露 |

有意不依赖第三方内部实现。少量历史上游源码夹具只做隔离契约测试，不是运行时补丁或私有 API 兜底。
若公开接口缺失，应关闭相应能力并解释，不扫描磁盘密钥、不 Monkey Patch 上游。

## 三、升级操作顺序

### （一）只读基线

1. 记录本地／云端实际 DSH、插件、IM 版本和进程身份；区分已安装、已启用、已加载。
2. 核对自有包哈希、profile／补丁／lock 文件摘要、全局规则托管段、Skill 归属、凭据引用修订。
3. 记录任务状态计数、活动会话、未知操作与队列；不自动修复 pending／needs_review 历史项。
4. 明确本轮仅兼容调查、隔离测试、恢复旧版还是部署新候选；无授权不扩大范围。

### （二）新隔离 Host

- 使用新目录、独立 HOME／DSH_HOME／DSH_AGENTS_HOME、端口、状态、会话与测试机器人。
- 依赖使用官方安装包；模型／IM／Gitee 凭据仅在另有明确授权时交接，不能从日常配置悄悄借用。
- 先零模型加载检查，再按许可做真实模型和 IM；长任务不是必须用生产任务来验证。
- 只读检查 scope 不能执行真实初始化、断开机器人或重启操作。

### （三）判断停用原因

元数据不匹配、插件加载异常、服务缺失、协议不兼容和配置漂移是不同故障。
若仅精确 peer 声明导致停用，也必须先证明代码在新 Host 上通过原生和自有功能回归。
可在用户批准风险后使用**官方精确版本例外**，限明确插件版本与 Host 版本；不是默认策略。
不得放宽全部 peer、关掉全局校验、改第三方源码或用旧 signed controller 绕过限制。

本轮恢复原 v24 用过的官方命令形态如下，实际执行前必须先核对当前 CLI 帮助和授权：

```bash
dsh plugin --profile desktop allow-version \
  @local/dsh-task-gateway@0.24.0-alpha.21 \
  --dsh-version 0.2.1-rc.3 --accept-risk
# 云端对应 profile web；示例不是运行本命令的授权。
```

### （四）修改和复验

1. 最小化修改自有 seam；同步契约、Skill、托管规则与测试，不能只修一句提示词。
2. 若改 UI，隔离依赖构建并检查生成 diff、CSS 作用域、手动刷新和原生页面兼容。
3. 定向测试先过，再执行实际受影响的原生 Host 场景；截图／API 回执都应去敏保存。
4. 双端至少核验混合版本／能力缺失失败行为，不只测两端同为新版。
5. 导出候选与哈希，不把测试状态、密钥或个人规则打包。

### （五）获批后的环境变更

先复核会话与受管批次空闲，通知保存草稿，做可回滚备份，再切换和正常重启。
必须明确 IM 断开／Host 停机可能中止最后时刻的新原生输入，不承诺完全排空所有渠道。
恢复后核对真实加载、模型目录、任务／审批计数、旧任务未重放、规则／配置保留。
回滚不覆盖升级后新产生的用户数据；需要原操作回执和归属证明，不能整目录无条件覆盖。

## 四、回归矩阵与历史教训

### （一）最低验证矩阵

| 领域 | 正向 | 负向／恢复 |
| --- | --- | --- |
| 原生功能 | standard／PTC／Cordis、原生工具与 IM 普通聊天 | minimal 不额外强塞全局规则；原生权限确认不被吞掉 |
| 安装 | 无全局文件创建、已有文件追加、实际 Skill 加载 | 同名冲突、符号链接、超预算、CRLF、并发修改、回滚不改用户段 |
| 凭据 | 本端保存、云端交接、目标端模型／Gitee 实读 | 本地成功不能代替目标成功；丢响应只核对原事务 |
| 协议 | 双端身份、能力、双向消息 | 旧版本、实例更换、断线、陈旧状态、未知重试屏障 |
| Worker | 模型按任务、真实独立会话、检查点续跑 | 错模型／超预算／无批准阻断；重启不生成新任务 |
| 审批 | 准确引用的批准／拒绝／暂缓／修改意见 | 条件同意不执行旧案；过期、伪造、回执误引用、重复确认 |
| 成果／通知 | 固定仓库链接、非仓库原会话、授权目标发送 | 目标缺失、晚绑定、未知发送；接受不当已读 |
| 文件 | IM／本地／云端六方向 | 越界路径、覆盖、哈希变化、断线、失效引用 |
| Web | 本地按钮到云端原会话，Cookie／WS 正常 | 非 loopback、Origin 不符、错误票据、跨任务会话、无 browser 能力 |
| 维护 | 风险确认后断开／恢复、精确停机 | 配置漂移、未知状态、原操作恢复、无主对象不删除 |
| 交付 | 独立 B 仓库、开发／commit／push 分步批准 | 无授权测试只用合成／临时夹具，不碰真实仓库 |

本轮可移植的 206 项入口见 README；它覆盖最后一组受影响模块，**不是这张全矩阵的替代品**。
真实模型、IM、Git 写入、Host 生命周期场景需要隔离环境和相应授权。

### （二）rc.3／IM 5.6 已遇问题

| 实际问题 | 自有修复位置／原则 | 防回归 |
| --- | --- | --- |
| 精确 rc.2 peer 导致原插件被停用 | 先隔离证实，再获批使用官方精确例外 | 不把元数据放开等同接口测试通过 |
| `listTargets` 从旧 envelope 到数组 | `notification-discovery.js` 双结构校验 | 新旧有效结构都过，畸形数据拒绝 |
| 新导览没有旧工作台手工端口 | 复用已验证的受管 SSH 承载 | 不偷偷用维护者固定端口或 token |
| 普通 Web 没原生 browser 导航 | 客户端显式能力判断和一次性入口回退 | 无副作用地打开原会话，不新建 job |
| Request.url 是内部 dsh.internal | 读取已鉴权 Host header 的有限 loopback 展示值 | 不将任意 Host 作为可信远端 |
| localhost／127 混用被跨站保护拒绝 | 保持当前浏览器 hostname | 不伪造 Origin／Sec-Fetch-Site 或移除 CSRF 校验 |
| 共享 loopback 上无关 Cookie 过多 | 有界 header 与相关 Cookie 过滤 | 不转发其他本机服务 Cookie |
| 全局托管规则变长触及总预算 | 压缩自有段，保留 48 KiB 用户前缀和原总限制 | 不截断用户内容、不扩大限制掩盖问题 |
| Linux 权限夹具受 umask 影响 | 测试子进程用 022，私有临时根仍 0700 | 不放松产品实际权限检查 |
| 总批次被入口错误拆解 | `max_runs` 原样传递，能力协商及三制品约束 | 不建立新周期假装检查点恢复 |

## 五、给接手 Agent 的交接清单

- 你修改的是哪个入口、哪一层、哪个能力版本？另一端未升级时如何拒绝？
- 账本、缓存、展示与外部事实谁是权威？结果未知能否查询原操作？
- 原生服务是否公开、运行中是否实际存在？哪些不是平台安全保证？
- 全局文件与 Skill 的实际路径、归属、用户内容是否保留？
- 候选版本、日常安装版本、已运行版本、回归范围是否分别说明？
- 哪些测试只是 mock、哪些是真实 Host／模型／IM／仓库，是否越过授权？
- 是否留下了错误码、修订、去敏证据、复现步骤和回滚条件，而非只说“已修复”？

交付报告至少写：变更文件、适配理由、测试集合与跳过项、双端版本、配置保留、未完成项及部署状态。

## 六、本记录点的升级注意事项

- 以正式 `candidate-bundle-alpha32-11.json` 或源码 `source-bundle-alpha32-11.json` 区分基线。
  后者仅两项非行为清理，不可悄悄用它重写正式历史散列。
- 当前 `scripts/check-foundation.py` 验证源码导出清单；安全导览入口为 13 文件、208 项。
- 既有配置六页复用通过公开接口读目标端目录、默认通知、Gitee 基线和托管归属；
  应复验通知 target 字段顺序不同、实例重启、凭据变化、未知保存和 CAS 冲突。
- 不把 `bundle/compatibility.json` 内旧 IM 验收提示当作新证据；运行安装、接口版本、真实送达分别核验。
- 源码审计运行 `scripts/audit-source-export.py --index`，检查暂存字节；合成负例按文件哈希复核，
  不为整个 tests 目录放开凭据扫描。
- 上述 alpha32 源码同步是历史证据；当前 alpha33.9 已正式部署，但未进行本轮源码推送。插件市场准备仍暂缓，不能继承旧业务写入授权。

### （三）IM 5.6.0 的断开不代表持续暂停

第07步实际切换发现：官方 ConnectionSupervisor 默认每15秒重新 initialize 已配置机器人，
而 bot.disconnect 仅关闭当前运行实例。已断开回执不能证明后续测试窗口一直没有正式消费者。
不要据此切换同一机器人；需要用户明确的正式 Host 停机窗口，或使用独立机器人。
持续核验实际接收 Host 和会话遥测；发现恢复连接即停止测试消费者，先恢复正常接入。
获准后用正常停止正式 Host 的方式完成第二轮独占验证，结束后先停测试再恢复正式双端。
不以修改原配置或补丁维持暂停；原生 Desktop 候选容器仍须独立补验。
具体证据与恢复边界见 [第07步记录](integration-alpha33-7.md)。


## 六、alpha33 原生容器与审批迁移专项

- 新增 `native-owner-origin.js`：服务端识别官方 Electron Node Host，并核对实际回环 Host／端口；不信任客户端伪造的“Desktop”标志。
- 官方代理会剥离 Origin。工作台审批和报告下载共享受控兼容检查；owner 鉴权仍由官方提供。
- 实测矩阵必须包含：未鉴权、外站 Origin、Web 缺 Origin、原生缺 Origin、原生系统保存与真实文件摘要。
- `approval-feishu.js` 使用公共 credentials.resolve；必须测试轮换、撤销、解析失败，以及不退回其他凭据来源。
- `chatApproval → localApproval` 是明确的路由迁移，不是配置字段改名；保留历史方案、决定、通知目标及禁用绑定证据。
- 接流量前／后回滚分层，不能以整体快照覆盖新决定。正式结论见 `desktop-deployment-alpha33-9.md`。


## 七、正式源码晋级与市场研究边界

`v0.33.0` 仅相对 alpha.9 调整版本和包说明；基础检查使用新的 `source-bundle-v0.33.0.json`，不更新旧冻结清单。
本次已经授权产品 A 仓库提交与推送，尚未授权实际 npm／市场发布。运行版本以健康回执为准，不按仓库标签推断。
详见 `release-v0.33.0.md`。市场分发后的安装归属、官方包入口和回滚必须另作验收，不能复用手工接线结论。
