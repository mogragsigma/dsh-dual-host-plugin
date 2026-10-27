# 大肥鱼 bot — DSH 本地与云端协作

`@mogragsigma/dsh-dual-host-plugin` · `0.33.1` · 作者：mogragsigma

> 面向 DeepSeek Harness（DSH）的双端协作插件。本地负责日常对话与工作台入口，
> 云端负责持久任务、独立 worker、审批账本与受控交付。
> 技术验收基线为官方 DSH `0.2.1-rc.3`；不保证其他 Host 版本或未经验证的平台。

## 安装

### 插件市场（推荐）

在 DSH 的插件市场中搜索「大肥鱼 bot」或包名，一键安装。
本包含原生依赖 `koffi`，pnpm 默认会拦截其构建脚本；插件市场会提示
「允许构建脚本并重试」，点击即可完成安装。

### 命令行

```sh
dsh plugin --profile web add @mogragsigma/dsh-dual-host-plugin --allow-build=koffi
```

若所用 pnpm 不支持 `--allow-build`，可在目标 profile 的 `pnpm-workspace.yaml` 中加入：

```yaml
allowBuilds:
  koffi: true
```

安装后按当前 Host 的方式重载 profile 或重启。Desktop 与 Web 请选择各自实际使用的 profile。

## 组成与能力

本包包含自有插件、全局 `AGENTS.md` 托管模板和 20 个 Skill
（19 个按全局托管安装，`task-worker` 仅用于独立执行会话）。
提供六页配置导览、本地／云端协作、独立 worker、按任务选模型、持久任务和审批账本、
成果入口、文件收发及工作台。普通原生模式与工具仍由 DSH 提供，不修改其源码。
新安装默认仅显示导览，不启动业务 worker、机器人消费者或仓库写入。
配置、配对、真实身份确认、任务批准、开发、commit、push 与发布是不同授权，不能互相替代。

## 配置

安装后在“大肥鱼 bot”中按六页导览配置。云端实例、模型、IM 与可选用户成果仓库均由用户拥有。
不要求用户获取产品源码仓库权限；任务成果仓库与产品源码仓库相互独立。
基础模型接入使用 DeepSeek 官方 API Key；可选第三方模型与 IM 通过其官方插件公开能力接入。
没有配置模型或 IM 时不伪称调用或消息回归已通过。

## 规则与数据保护

全局规则按实际 Host 路径保护性追加，或明确确认后创建；不会覆盖用户原规则。
Skill 安装先检查冲突及文件归属；未知改动、同名文件或符号链接冲突会阻止覆盖。
凭据、运行账本和用户会话不在发行包内。安装、升级或卸载包不等于授权删除用户数据。

## 旧包名迁移

历史包名 `@local/dsh-task-gateway` 与本包是不同包管理身份，不可直接认为常规版本升级。
不要同时启用旧、新包。原生管理精确关系、托管文件归属和历史数据应先在隔离副本中核对。
本包不改内部凭据命名空间、不清除旧队列、不重试旧任务，也不自动改写正式 profile。
旧归档的版本接收器仍拒绝跨包身份／元数据变化，不绕过原安全契约。

## 许可与素材

采用 `LICENSE` 中的自定义源码可见许可《mogragsigma 源码可见·免费自用·禁止转售许可 1.0》：
允许任何个人和组织免费使用（含企业内部使用），未经书面授权禁止转售、收费再分发或收费对外托管。
不是 MIT／Apache-2.0／OSI 开源许可。许可以中文文本为准，`LICENSE.en.md` 为英文参考译本。
第三方组件见 `THIRD_PARTY_NOTICES.md`，素材见 `ASSET_NOTICE.md`。

## 支持与问题反馈

- 产品源码及说明：[Gitee 项目](https://gitee.com/wenheng-Zhang/dsh-dual-host-plugin)
- 反馈：[Issues](https://gitee.com/wenheng-Zhang/dsh-dual-host-plugin/issues)
- 公开可达性以仓库实际状态为准。

提交问题前移除 API Key、机器人密钥、用户消息、内网地址、签名及私有任务数据。
本项目是独立插件，不代表 DeepSeek 或依赖作者的官方产品。
