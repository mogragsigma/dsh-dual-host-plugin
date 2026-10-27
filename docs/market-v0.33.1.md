---
title: "v0.33.1 发行包与隔离验收报告"
description: "最终许可、包身份变更、实际归档、官方联网安装与隔离验收边界"
author: "mogragsigma"
created: "2026-10-27"
updated: "2026-10-27"
version: "1.1.0"
status: "review"
---

# v0.33.1 发行包与隔离验收报告

> 结论：许可、包元数据、实际归档与官方 DSH 插件管理器联网全新安装／移除／重装已通过。
> 尚未执行 npm publish，也未提交插件市场收录或迁移现有正式环境。
> 本文是发布前证据，不替代用户的发布授权。

## 目录

- 变更范围
- 许可文本（最终）
- 打包清单
- 隔离验收
- 发布前门禁
- 下一步与恢复位置

## 变更范围

来源为产品源码 v0.33.0、提交 `b65491e10abda2c5949e7a445b4bd3dcef6a46d2`。
本轮在独立副本准备 `@mogragsigma/dsh-dual-host-plugin@0.33.1`，未修改原始 Git 工作区。

- 作者、版权署名使用 `mogragsigma`。
- 本轮相对上一轮候选（归档于 `history/20261027-pre-publish/`）只改发行元数据与文档，不改运行代码：
  - 移除 `private: true` 防护，新增 `publishConfig.access: "public"`，作为发布准备；
    **发布动作本身仍待用户明确授权**，本轮未执行 `npm publish`。
  - `LICENSE` 由英文审阅草案改为**中文控制文本**；新增 `LICENSE.en.md` 英文参考译本；
    删除 `LICENSE.zh-CN.md` 审阅摘要。
  - `README.md` 改写为发行版说明（安装命令、构建脚本放行说明、最终许可、支持入口）。
  - `THIRD_PARTY_NOTICES.md`、`ASSET_NOTICE.md` 的 `status` 由 `draft` 改为 `final`。
  - `tests/market-v0331.test.mjs` 的发布态契约断言同步更新（`private` 移除、许可文件改名）；
    这是发布准备的预期变更，不是放宽产品运行代码。
- 主入口、安装／卸载识别、云端解析目录和 UI 文案仍使用新完整包名。
- 内部凭据及状态命名空间不随包名改动，旧数据不能被自动认领。
- 247 个既有 bundle 文件字节未变；12 个既有文件变化仅涉及包身份、版本元数据、锁文件封装及生成 UI。
- 新增 bundle 文件 6 个：`LICENSE`、`LICENSE.en.md`、`README.md`、`ASSET_NOTICE.md`、
  `THIRD_PARTY_NOTICES.md`、`distribution-lock.json`；不再包含 `LICENSE.zh-CN.md`。
- 任务、审批、执行、仓库、通知、A2A 核心代码不变，锁定的依赖版本不变。
- 全局规则、Skill、图片字节均不变；未覆盖真实用户规则，未调用生产凭据。
- 更新导航索引和候选专用测试入口，不覆盖历史冻结快照。

旧完整包名与新完整包名不同，不能视为普通同名升级。候选仍拒绝旧包身份；
已有正式环境需要单独确认切换方案，不能同时启用两份插件，也不能跳过官方包归属核对。
本轮没有进行正式环境迁移。

## 许可文本（最终）

2026-10-27 由许可方确认定稿，采用《mogragsigma 源码可见·免费自用·禁止转售许可 1.0》：

- 中文文本为准；`LICENSE.en.md` 为英文参考译本，不一致时以中文文本为准。
- 任何个人和组织都可以免费安装、运行、研究、备份和修改，含企业内部使用与内部商业工作；不要求分成。
- 仅因使用本软件产生的成果，不被施加分成、非商业限制或权利转让；不保证成果权属或权利清洁。
- 未经另行书面授权，禁止转售、出租、商业再许可、收费再分发以及收费对外托管。
- 允许免费再分发；须附本许可与声明、标明修改、不得冒充官方版本。
- 本许可仅规范软件本身的复制、分发与对外提供；单独的安装、培训或技术支持服务不属于调整范围。
- 违反第四条或第五条时授权自动终止；适用中华人民共和国法律，争议由许可方住所地有管辖权的人民法院管辖。
- 第三方组件与素材声明独立生效；本包不随附 node_modules。

本包直接依赖锁文件有 52 条组件记录：50 MIT、1 ISC、1 Apache-2.0，均有许可字段。
云端运行时锁文件 708 条、可选 IM 锁文件 828 条另行列明；它们不是本 tgz 中打包的第三方实现。
可选 IM 的 `qrcode-terminal@0.12.0` 缺元数据许可字段，但同版本缓存 LICENSE 为 Apache-2.0。
可选 QQ 组件 `@tencent-connect/qqbot-connector@1.2.0` 标为 `UNLICENSED`，未见随包 LICENSE。
不能用本项目许可替上游授予权利；公开文案不宣称覆盖全部 IM 渠道。

## 打包清单

- 包：`@mogragsigma/dsh-dual-host-plugin@0.33.1`。
- 归档：`mogragsigma-dsh-dual-host-plugin-0.33.1.tgz`。
- 内容：264 个文件，解压后 6,560,799 字节；压缩后 3,617,855 字节。
- SHA-256：`920c4a0db8bbaa4fa234967c3fd9ad161f82db7c84d3039c0bb7d89d34636571`。
- 机器可读逐文件 SHA-256 清单：`PACKAGE-MANIFEST-v0.33.1.json`。
- 上一轮候选归档：`history/20261027-pre-publish/`（SHA-256 `2f0592d750be4f14e4d039b9992a67b03399fb211b79b104c3ca84621e1c9384`）。

包含：插件 JS、官方加载声明、六页导览及工作台客户端、全局规则托管模板、Skill、
内部 worker 规则、素材、兼容声明、独立运行时声明及锁文件、许可和包说明。
兼容范围仅声明已测试的 DSH `0.2.1-rc.3`，不放宽到未经验证的所有版本。

排除：node_modules、测试、维护工具、私有目录、运行时状态、数据库、会话、机器人或模型凭据、
日志、个人 SSH 私钥、真实测试数据、符号链接。
扫描未发现规则集覆盖的敏感形态；自动扫描不被视为对所有可能秘密的绝对保证。

npm 自动排除 `package-lock.json`，因此随包加入字节等同的 `distribution-lock.json`。
自有云端归档器只将其恢复为原本要求的 `plugin/package-lock.json` 归档条目；
不运行安装脚本、不变更依赖、不写回包文件。两个锁文件冲突时拒绝。
原来的大小、数量、链接及身份校验保留；实际源目录与 tgz 的云端传输清单完全相同。

## 隔离验收

| 检查 | 结果与证据范围 |
| --- | --- |
| 真实 npm pack | 通过：实际生成 tgz（264 文件），不是 dry-run，也未 publish |
| 候选边界审计 | 通过：打包文件逐字节匹配候选源文件，0 个禁止项；变更限于许可、README、声明、包元数据与发布态测试契约 |
| 定向市场回归 | 通过：950 通过、0 失败、1 历史跳过（951 项）；发布态测试契约更新后重跑 |
| 导览安全回归 | 通过：208 通过、0 失败；与上一组部分重叠，不累计为独立总数 |
| 官方插件管理器联网全新安装 | 通过：全新隔离 HOME／DSH_HOME／profile，从 registry.npmjs.org 解析 30 个包，退出码 0；需 `allowBuilds: koffi: true` |
| 官方插件管理器移除／重装 | 通过：移除后 bundle 条目从组合配置消失；重装后重新出现 |
| 组合配置观察 | 通过：`dsh --profile <probe> --dump-config` 出现 1 个本包入口（`dual-host-onboarding`） |
| npm CLI 安装 | 通过：`npm install <tgz>`，50 个包，退出码 0 |
| npm publish 预演 | 通过：`npm publish <tgz> --dry-run --access public`，264 文件、public access（未实际发布） |
| koffi 构建脚本策略（本轮新发现） | 未放行时 `dsh plugin add` 报 `ERR_PNPM_IGNORED_BUILDS`（koffi）并退出 1；放行后退出 0。不跑构建脚本时 koffi 仍可正常加载。属 pnpm 11 默认安全策略，不是本包缺陷；插件市场客户端内置「允许构建脚本并重试」；README 已写明 `--allow-build=koffi` |
| 官方 Host 离线包加载 | 上一轮 264 文件包通过；本轮只改文档与元数据，未重跑，不冒充本轮结果 |
| 插件归属观察 | 官方插件管理器观察到 1 个新命名包、1 个入口，版本为 0.33.1 |
| 导览 HTTP／原生预设／全局规则与 Skill／minimal 边界／实际规则卸载重装 | 上一轮通过；本轮未重跑，不重复声明为本轮结果 |
| npm 账号与包名 | `npm whoami` 为 `mogragsigma`；2FA 未开启；包名在 registry 返回 404（未占用）。未执行 publish |
| Gitee 公开可达性 | **未通过**：匿名 API 404、页面 403、匿名 `git ls-remote` 需要凭据，产品仓库当前对公开用户不可访问；npm 主页与 Issues 链接在公开化前不可用 |
| 默认动作安全 | 模型调用 0；未绑定 taskGateway，未启动任务、开发、提交、推送 |
| 历史冻结跳过项 | S65 旧 UI-only 快照不适用本候选；另有当前包清单及逐文件边界审核 |

安装验收使用隔离的 `DSH_HOME`、profile、pnpm store 与 npm cache，未读写正式 Mac profile；
测试中的 `--config.store-dir` 只用于隔离缓存目录，不改变安装语义。
购买、模型、IM、Git 写入、Host 停机与正式部署均未执行。

## 发布前门禁

1. ✅ npm 作用域：用户名为 `mogragsigma`（个人 scope），2FA 未开启，包名未占用。
2. ✅ 联网后官方 DSH 插件管理器全新安装／移除／重装：通过；构建脚本放行方式已写入 README。
3. ⏳ 平台范围：Linux／pnpm 实际安装形态与 Windows 未验证，不宣称全平台支持。
4. ⏳ 公开可达性：Gitee 产品仓库与 Issues 当前对匿名用户不可访问；发布前应公开化或改用公开镜像。
5. ⏳ 旧包名迁移：未开始；首次发布新包不要求，但旧 `@local/dsh-task-gateway` 实例仍需单独方案。
6. ⏳ 正式发布：尚未执行 `npm publish`；需用户明确授权后执行，并在发布后回读 registry 并从 registry 重装验证。

不以这次准备任务替代任何发布或正式部署审批。

## 下一步与恢复位置

1. 用户确认发布后执行 `npm publish <tgz> --access public`（或从 `bundle/` 目录发布），
   再以 `npm view`、dist-tags 与 integrity 回读，并从 registry 执行 `dsh plugin add` 复验。
2. 插件市场收录：`awesome-dsh-plugin` 目录要求 `https://github.com/<owner>/<repo>` 形式的公开仓库、
   `dsh-plugin` topic、仓库创建满 1 天且 `package.json` 声明 `dsh.bundle`；
   发布后按 `data/plugins/<owner>__<repo>.yml` 提交 PR。当前产品源码在 Gitee，需另建公开 GitHub 镜像。
3. 补验 Linux／pnpm 安装形态与旧包名迁移方案；Gitee／GitHub 可见性由用户决定。
4. 候选源码、包、清单和证据分开放置；旧候选归档在 `history/20261027-pre-publish/`。
5. 本轮未改 DSH 或第三方源码，未操作正式 Mac／ECS profile，未调用模型／IM／Git 写入。

规范参考：[npm package.json](https://docs.npmjs.com/cli/v10/configuring-npm/package-json/)、
[scoped public packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/)、
[Open Source Definition](https://opensource.org/osd)。
