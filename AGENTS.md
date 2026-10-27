> **v0.33.1 独立发行候选（2026-10-27）**：新包名 `@mogragsigma/dsh-dual-host-plugin`，
> 作者／版权署名 `mogragsigma`。当前候选、许可和安装边界以
> [发行候选报告](docs/market-v0.33.1.md)为准；下面保留 v0.33.0 历史记录，不代表本候选已发布。
> 原始 Git 工作区和正式环境不变。官方插件管理器联网全新安装／移除／重装已通过
> （DSH `0.2.1-rc.3`＋registry.npmjs.org；`koffi` 构建脚本需 `allowBuilds` 放行，README 已说明）。
> `private` 防护已移除并加入 `publishConfig.access: public`，但**尚未执行 npm publish**；
> 发布、市场收录与旧包名迁移仍需用户分别确认。

# 本项目维护边界

- 当前源码正式版为 `0.33.0`，运行中正式双端仍为 `0.33.0-alpha.9`（本轮仅元数据晋级，不重部署），默认 IM 端可选本地或云端；不是空白系统安装证明。
  先读 README、`docs/notification-defaults-alpha32.md`、`docs/code-architecture.md`、
  `docs/dsh-upgrade-adaptation.md` 和冻结历史 `docs/validation-alpha69.md`；不混用验收结论。
- 仅修改自有插件、全局规则托管模板、Skill、相应构建／测试与文档，不改 DSH 或第三方源码。
- 根目录本文件只约束维护 Agent；产品全局规则来自 `bundle/global-rules/AGENTS.md`，不能覆盖用户原文件。
- 路径取目标 Host 实际配置；不写入维护者的绝对路径、真实主机、账号、令牌或个人规则。
- 不提交 private、运行时目录、凭据、数据库、会话、日志、node_modules 或符号链接。
- 默认不正式部署、不发布，不操作日常配置。源码提交／推送需当前用户授权，不能继承业务任务的批准。
- A 线是本仓库产品源码；B 线为独立用户任务成果仓库。不得混用身份、权限、提交或验收证据。
- Gitee 通过 CLI／SSH／命令行 API 操作，不用浏览器作为执行或验收依赖；不复制私钥。
- 当前安全定向回归为 `scripts/run-intervention-regression.py` 和 `scripts/run-onboarding-regression.py`；禁止未经审查通配运行历史 tests。
- 不手改生成的 `bundle/workbench-client.js`；改 `ui-source/` 后使用隔离构建依赖生成。
- `docs/candidate-bundle-alpha69.json` 是冻结历史基线，不为掩盖漂移而更新。
  下一版本需新基线、新版本声明、新验收；本记录点的导出测试适配不改变冻结 bundle。
- 新增／修改模块后更新 `docs/module-index.json`。不要只修全局规则来绕过运行时安全门禁。
- 兼容声明、安装、启用、实时服务、任务受理、批准、实际执行、提交、远端接收和用户已读分别证明。
- 未知结果先查询原事务／操作回执；不清库、不重置预算、不重放旧消息，不绕过签名归档和能力协商。
- `operator-kit/` 及旧协议模块为历史保留，不作为新导览默认路径，不恢复旧 IM 消费者。
- 不把本次定向 208 项称为全部历史约 2000 项回归，不把隔离候选称为正式上线。
- S67 正式规则／Skill 已迁为真实安装器管理的 20 文件归属账本；今后只用公开托管维护流程，
  不重跑仅识别旧中文标题的切换脚本。插件本体仍是历史手工接线，不能伪造官方包归属。
- 当前六页导览的云端管理仅支持其新建受管实例；未通过既有生产 Host 原地接管验收。

- alpha.9 的既有双端核验仅是只读证据。模型/IM 清单和路径解析不证明真实调用、送达或加载；不能据此跳过六页确认、认领旧 Host 或称完整重装通过。

- alpha.10 的六页复用只保存自有确认记录，不修改原草稿结构或原生配置。已配对不等于安装归属；回执不是持续在线／执行授权。alpha.11 修复真实通知视图字段顺序误判，正式六页复用及回执跨重启已通过；详见 `docs/existing-setup-alpha32-10.md`。

- 当前收尾证据以 `docs/desktop-deployment-alpha33-9.md` 为准；旧分段中的待办为历史状态，不应重放旧任务。

- 当前源码同步按 `docs/release-v0.33.0.md` 核验，源码导出与正式冻结清单分开；不要以更新说明为由重部署。
- 当前用户要求：允许产品 A 仓库的 v0.33.0 commit／push；不动 B 仓库。同步后研究市场要求，尚不提交市场或 npm 发布。
- 交付快照不得含已禁用的外部工具品牌描述、真实凭据或私有运行数据；敏感目录拒绝规则仍须完整保留。

- alpha33 原生 Origin 例外只适用于已鉴权的官方 Electron Node Host 精确回环地址；Web 缺少 Origin 仍拒绝。升级 DSH 时必须重验，不删除安全检查。
- alpha33 路由迁移后旧绑定被禁用；接流量后禁止用旧整库覆盖新身份或决定。回退方案见 `docs/desktop-migration-alpha33-8.md`。
