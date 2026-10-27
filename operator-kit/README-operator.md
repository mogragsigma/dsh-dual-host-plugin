# DSH 双端协作 alpha.21 候选运营工具包

这是自有插件、全局 AGENTS.md、Skill 的**候选显式升级/回滚工具包**，不是自动发布器。
本包面向 v0.24.0-alpha.21，单独保存为 v16，不修改或覆盖旧 v3—v15 归档。
本轮仅候选回归和只读正式预检；正式切换需先通知用户保存草稿并复核空闲，以下命令不构成授权。
命令不会停止或启动 DSH，不更改第三方源码，不代替审批、不执行任务、不重试历史队列。
第15步 S45 限定开发、审批、提交和推送已独立验收，不在升级过程中重跑。
正式服务切换及全项目验收未收口；不能因解包或预检成功宣布全项目交付。

## 支持范围与依赖

- 当前适用于 macOS 与 Linux；Python 使用 PyYAML，事务锁依赖 POSIX fcntl。未验证 Windows 安装器。
- 旧调度 owner 迁移另外需要支持 node:sqlite 的 Node.js；它只导入本项目迁移模块，不加载 DSH。
- 自有插件运行依赖不随包携带；在同机另行准备物理 node_modules 目录，不沿正式/共享软链接安装依赖。
  工具检查直接依赖精确版本及整个目录复制清单，不宣称这是上游签名认证。
- `bundle/` 包含144份运行时文件及三制品模板，包括18份 Skill（17份全局、1份 worker）；
  Linux 监管必需的 `delivery-process.py` 作为精确文件随包携带，不接受任意 Python 通配符。
- `bundle/` 包含运行时及三制品模板；`tools/` 包含只读预检、状态观测、安装事务、停机核验和 owner 迁移。
- 全局规则只更换本项目精确托管块；人格、记忆、其他插件配置、状态路径和凭据配置不做重写。

所有路径均使用绝对路径。下面的占位值须从实际输出取得，不能照抄指纹、路径或猜测端口。

## 1 验包与解包

先用可信来源提供的工具和**单独取得的外部 SHA256** 验证归档；不能运行未知包内的代码来证明它自己可信。

```bash
python3 /trusted/tools/operator_cli.py verify --archive /path/kit.tar.gz --sha256 EXPECTED_SHA256
python3 /trusted/tools/operator_cli.py unpack --archive /path/kit.tar.gz --sha256 EXPECTED_SHA256 --destination /new/private/kit
```

只接受安全的普通文件归档，拒绝链接、越界、重复、未列入清单的内容；目标必须不存在。
解包不执行钩子，不安装、不启动，不包含数据库、机器人账户、模型凭据、node_modules 或旧归档。
外部哈希证明字节一致，不代表数字签名或部署授权。解包中断时保留现场，不覆盖该目录重来。

## 2 只读计划和状态

```bash
python3 /new/private/kit/tools/operator_cli.py plan --home /actual/dsh-home --profile web --candidate /new/private/kit/bundle
python3 /new/private/kit/tools/operator_cli.py inspect-state --state /actual/dsh-home/task-gateway/actual-state
```

保存计划的 fingerprint。计划和观察均不会迁移或启动任务，也不能证明 Host 已停止。

DSH 0.2.1-rc.2 的根 cordis.yml 可能包含加载器回写的运行树。已核验的官方启动代码会重建该文件，
实际配置来自 bundle、profile patch、home patch 及显式覆盖层。工具不修改或回滚这个生成文件。
非空根文件只有在本机 Host 版本及启动源码指纹匹配已审查契约时才作为生成文件处理；
安装/回滚再次核验该契约。上游升级或未知启动器需要重新审查，不提供强制跳过选项。
全局 home patch 的缺失或空内容也被记入输入指纹；非空覆盖层必须单独审查，不能忽略其更高优先级。
歧义入口、开启开发或提交/推送执行、规则漂移、同名 Skill 冲突、未知布局或旧 owner 缺失必须先处理，不自动纠正。
交付账本统计包含 delivery_actions 和 delivery_operations；needs_review 或未闭合操作不会被当作空闲。
这些统计仅是只读观察，不检查封存终态，也不释放任务或充当停机许可。

## 3 绑定实际 Host 身份并人工停止

在 Host 仍运行时捕获身份，输出到本项目私有目录。记录不含环境变量正文或令牌。

```bash
python3 /new/private/kit/tools/operator_cli.py host-record --home /actual/dsh-home --profile web --kind systemd-service --unit dsh-web.service --output /private/cloud-host.json
python3 /new/private/kit/tools/operator_cli.py host-record --home /Users/USER/.dsh --profile desktop --kind macos-desktop --application "/Applications/DeepSeek Harness.app" --output /private/mac-host.json
```

systemd 记录绑定实际 MainPID 的 DSH_HOME/profile/Web端口、有效单元和环境文件哈希、cgroup v2。
当前拒绝未适配的 cgroup v1 布局，不把找不到 cgroup 当作进程已排空。
Desktop 适配当前默认 `~/.dsh` 的 desktop profile；记录应用可执行文件身份和进程。
其他安装位置、启动器或身份布局不静默套用，先适配再验收。

**由用户确认草稿保存、会话空闲，并正常退出 Desktop / 停止服务。工具绝不代替此步骤。**
随后可执行一次核验，但它的输出不是以后可复用的“已停机”许可：

```bash
python3 /new/private/kit/tools/operator_cli.py check-stopped --host-record /private/cloud-host.json --host-sha256 RECORD_SHA256
```

每次 prepare/apply/rollback 都重新持有停机 lease、检查进程/单元/cgroup、占用必要端口，关键写入前后再复核。
PID 被复用、服务重新启动、单元/环境变化或端口未释放都会拒绝；这不是对抗同账号管理员的 OS 安全隔离。

## 4 旧调度 owner 迁移

仅旧云端调度库缺 owner 时需要。先产生只读迁移计划，绑定原实际端口、配置哈希、数据库身份与历史快照。

```bash
python3 /new/private/kit/tools/operator_cli.py owner-plan --home /actual/dsh-home --profile web --candidate /new/private/kit/bundle --plan-fingerprint PLAN_FP --output /private/owner-plan.json
python3 /new/private/kit/tools/operator_cli.py owner-adopt --home /actual/dsh-home --profile web --candidate /new/private/kit/bundle --plan-fingerprint PLAN_FP --migration-plan /private/owner-plan.json --migration-sha256 OWNER_PLAN_SHA --backup /actual/dsh-home/task-gateway/migrations/OPERATION/before.sqlite --host-record /private/cloud-host.json --host-sha256 RECORD_SHA256
```

迁移明确写入本项目 owner 元数据并建立一致备份，不调用 recover、不改历史任务、不开始执行。
Python 占用其他 Host 端口，迁移模块排他占用原 scheduler 端口；绝不拿一个任意空闲端口替代原锁。
若进程中断，保留原迁移计划和备份，以同一计划核对/续接；不能生成新计划重置历史或删除证据。
owner 已存在且匹配时不需要迁移；不匹配应停止排查，不覆盖其他主机所有权。

## 5 准备与安装

```bash
python3 /new/private/kit/tools/operator_cli.py prepare --home /actual/dsh-home --profile web --candidate /new/private/kit/bundle --plan-fingerprint PLAN_FP --dependencies /physical/node_modules --host-record /private/cloud-host.json --host-sha256 RECORD_SHA256
python3 /new/private/kit/tools/operator_cli.py apply --transaction /returned/transaction/path --fingerprint TX_FP --host-record /private/cloud-host.json --host-sha256 RECORD_SHA256
```

prepare 保存不可变 payload、原始三制品和一致状态备份；不激活候选。请单独保存返回的事务路径和 fingerprint。
apply 先复核整个文件集合，再原子替换规则/Skill，最后切换本项目入口，保留原文件权限。
事务进程中断后查询同一事务，不删除它另建一个；已写文件与确认丢失通过固定 before/after 哈希识别。

```bash
python3 /new/private/kit/tools/operator_cli.py status --transaction /returned/transaction/path --fingerprint TX_FP
```

`applied` 只说明文件事务完成，**不代表已启动或实际采用**。之后由运营者正常启动，并分别验证三制品、
原生功能、双端兼容、任务与回执状态。此工具不抢占原生会话或自动打开开发写入。

## 6 保留数据回滚

重新正常停止同一 Host，再使用同一事务和外部 fingerprint：

```bash
python3 /new/private/kit/tools/operator_cli.py rollback --transaction /returned/transaction/path --fingerprint TX_FP --host-record /private/cloud-host.json --host-sha256 RECORD_SHA256
```

回滚不恢复旧数据库，不删除新历史、不重置预算、不重放消息。存在新任务/新非空队列、原结构变化或用户改动时拒绝。
旧 v0.16.0-alpha.3 → v0.24.0-alpha.2 精确策略保持不变，不因版本较新自动继承。
本工具另含 `current_rollback_policy.py`：独立审查的 v0.16.0-alpha.3 → v0.24.0-alpha.14 策略，
同时绑定两端完整源码清单。只容许保留新 `notification_meta` 的一条初始化游标，期望值来自
封存的升级前 `job_events` 最大序号，绝不根据当前行反推“合法值”。源版本、目标版本、代码指纹、
原表结构/历史、备份或游标任何不符仍拒绝；新业务数据、审批、队列、交付记录不在例外内。
alpha.17 另由 `alpha17_rollback_policy.py` 单独绑定源和目标完整代码指纹，沿用同一初始化语义，
不修改 alpha.14 策略，不允许其他版本继承例外。新增交付成果来自只读账本投影，没有新增成果写库迁移。
不会删该行、恢复旧库、迁移新任务给旧版执行或自动重放。完整真实 Host 验收必须查独立记录，
不能把工具存在或包验证成功等同于已验证任意目标环境。

回滚后的版本目录、备份和新增空表保留；事务明确新增的 Skill 文件可撤销，但不批量删除用户目录。
`rolled_back` 仍不代表旧 Host 已正常启动；运营者须再次验证。任何报错都先查看原事务，不自动重试业务任务。


## v11 版本范围

当前包运行时为 alpha.21。alpha.2、alpha.14、alpha.17 策略按原字节保留；
新增 `alpha18_rollback_policy.py`，仅接受独立核验后的精确四元组。
相对 alpha.17，11 份文件变化包括只读审批引用定位、能力协商、回执分类、规则与版本元数据。
数据库构造/迁移没有变化，审查依据为第45阶段 `results/operator-v11-runtime-diff.json`。
只读引用不能证明当前消息已核验，不接管 IM，也不将旧任务的审批转为新任务权限。
打包入口新增全局规则托管区检查，防止把托管区之外的规则误打包；不扩大全局配置修改范围。
实际双端生命周期验收查独立记录，不把合成测试等同于正式实例升级成功。

## 配置新增项的显式回滚核对

默认 `rollback` 仍按精确字节检查漂移，不会自动覆盖 DSH 界面保存的配置。对于原 profile patch
条目语义完全未变、只在末尾新增静态非本项目条目的情况，可先生成只读核对计划：

```bash
python3 /new/private/kit/tools/operator_cli.py rollback-review --transaction TRANSACTION_PATH --fingerprint TRANSACTION_SHA256 --host-record HOST_RECORD --host-sha256 HOST_RECORD_SHA256
```

输出只含输入/目标哈希、保留新增项数量、回退的本项目引用数量和核对指纹，不输出配置或令牌。
人工审查后显式提供该指纹，才执行：

```bash
python3 /new/private/kit/tools/operator_cli.py rollback --transaction TRANSACTION_PATH --fingerprint TRANSACTION_SHA256 --host-record HOST_RECORD --host-sha256 HOST_RECORD_SHA256 --patch-review-fingerprint REVIEW_FINGERPRINT
```

此路径仅反转原事务已审查的本项目路径；当前文件的其他字节（包括原条目格式、注释和新增设置）保留。
现有条目语义变化、动态 YAML、别名、重复键、新增项目引用、ID 冲突或指纹过期仍拒绝。
全局 AGENTS、Skill、原始依赖及数据库检查不放宽；不把任意文件漂移解释成无关变化。

首次执行前在事务私有目录保存核对输入（可能含敏感配置，仅本机 0600，不归档或上传），
后续恢复必须继续提供同一个核对指纹。崩溃后不需重新改写已恢复的 patch，不自动重新批准。
核对流程不停止/启动服务、不替代正式变更授权、不修改 DSH/第三方源码。
目前这不是任意编辑的三方合并器；不满足上述条件时保持待人工核对。

DSH GUI 可能把很长的双引号路径折行；本工具先核验解码后的路径，再仅规范化本项目路径标量，其他字节保留。v8首次实测在此处只读拒绝，v9已补充该实际序列化形式的回归；未放宽原条目语义一致要求。

## v13 systemd 停止状态指纹修复

ExecStart 的完整命令、参数与 ignore_errors 保持钉住，仅排除严格识别的时间、PID 和退出结果尾部。
未知格式或多个命令拒绝；环境、unit/drop-in 文件、实际进程、cgroup 和端口检查保持。
旧 systemd Host 记录不复用；必须服务运行时重新捕获 contract 2 记录，再正常停止并核验。
实际 Ubuntu systemd 运行中使用 status=0/0，正常退出使用 status=0；两者均仅属执行结果。
此修复不修改 DSH、systemd unit 或第三方源码，不改变业务能力开关。v11、v12 归档保留。


## 本轮审批解释修复的配置前提

alpha.21 将直接决定的语义与独立来源核验分离，不添加代理授权白名单，不重解历史回复。
隔离实测：现有 GLM-5.3 / low 仍把代理输入说明解释为待澄清；同一模型 high 的四类有界输入通过。
升级工具默认保留用户配置，不会自动把旧 low 改为 high。正式启用本轮修复须另有明确运营授权，
仅调整 ECS 自有插件 chatApproval.semantic.policy.reasoningEffort，并保存可回滚的前后配置。
这不是 worker 固定模型设置；不改变任务模型或授予开发／提交／推送权限。不得修改 DSH 或第三方源码。
已经记录的待澄清仍保留，须核对后有新的有效回复，不能改数据库、重放旧消息或以短口令绕过。
