# 大肥鱼 bot — DSH 本地与云端协作插件

面向 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的双端协作插件：
在本地对话或 IM 中自然语言交办，云端独立 worker 持续处理有界任务，
在统一工作台查看成果并处理需要你决定的事项。

- npm 包：`@mogragsigma/dsh-dual-host-plugin`（发布内容为本仓库 `bundle/` 目录）
- 兼容基线：官方 DSH `0.2.1-rc.3`
- 许可：自定义源码可见许可（以中文文本为准），允许免费自用，禁止转售与收费对外托管
- 本仓库是产品源码仓库；`bundle/` 为 npm 发布内容，`docs/` 为设计与验收文档

## 安装

```sh
# 插件市场（推荐）：在 DSH 插件市场搜索「大肥鱼 bot」一键安装

# 命令行
dsh plugin --profile web add @mogragsigma/dsh-dual-host-plugin --allow-build=koffi
```

本包含原生依赖 `koffi`，pnpm 11 默认会拦截依赖的构建脚本；插件市场会提示
「允许构建脚本并重试」，点击即可完成安装。若所用 pnpm 不支持 `--allow-build`，
可在目标 profile 的 `pnpm-workspace.yaml` 中加入：

```yaml
allowBuilds:
  koffi: true
```

Desktop 与 Web 请选择各自实际使用的 profile；安装后按当前 Host 的方式重载或重启。

## 能力

- **双端协作**：本地与云端各装同一套自有插件，按角色与配对区分职责；不要求两个机器人同群
- **持久任务**：云端独立 worker、有界批次与预算、检查点与重启恢复；入口不持续占用
- **按任务选模型**：以目标端实际模型目录唯一匹配为准，简称可用，歧义先澄清
- **审批账本**：工作台自然语言意见、已绑定 IM 身份核验、持久账本与权威回执；
  批准、排队、执行、测试、交付、已读分别证明
- **成果与文件**：任务成果查询、受控下载与原执行会话入口；IM／本地／云端三端文件收发
- **六页配置导览**：连接云端、模型服务、聊天与审批、成果与仓库、安装计划、配置与验收
- **全局规则与 Skill**：保护性追加或确认后创建，不覆盖用户原规则；冲突先阻止

## 兼容与边界

- 仅声明已测试的官方 DSH `0.2.1-rc.3`；其他 Host 版本或平台需自行验证
- 不修改 DSH 内核或第三方 IM 插件源码
- 不承诺操作系统级隔离、全平台支持或全部 IM 渠道能力一致
- 开发、commit、push、发布分别授权；源码可见不等于授权分发、部署或商业托管
- 本项目是独立插件，不代表 DeepSeek 或依赖作者的官方产品

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| `bundle/` | 插件包（npm 发布内容）：自有插件、全局规则模板、Skill、工作台客户端、许可与声明 |
| `ui-source/` | 工作台与六页导览前端源码（`bundle/` 内为生成结果，不手改） |
| `scripts/` | 构建、模块索引与定向回归脚本 |
| `tests/` | 合成测试；测试依赖声明见 `tests/package.json` |
| `docs/` | 设计、兼容、验收与发行文档 |
| `operator-kit/` | 历史运营工具，仅供维护参考 |

## 开发与测试

- 需要 Node.js 22 与 Python 3；测试使用隔离 HOME／DSH_HOME 与合成服务，不读取日常配置
- 定向回归（先阅读脚本清单，不通配执行历史测试）：

```sh
python3 scripts/run-market-regression.py
python3 scripts/run-onboarding-regression.py
```

## 许可

本仓库根目录 `LICENSE` 为中文控制文本，`LICENSE.en.md` 为英文参考译本；
npm 包内 `bundle/LICENSE` 与内容相同。核心规则：

- 允许任何个人和组织免费安装、运行、研究、备份和修改，含企业内部使用与内部商业工作
- 未经另行书面授权，禁止转售、出租、商业再许可、收费再分发和收费对外托管
- 允许免费再分发；须附许可与声明、标明修改、不得冒充官方版本
- 不是 MIT／Apache-2.0／OSI 开源许可；许可以中文文本为准

第三方组件声明见 `bundle/THIRD_PARTY_NOTICES.md`，素材声明见 `bundle/ASSET_NOTICE.md`。

## 反馈

- Issues：本仓库
- Gitee 镜像：<https://gitee.com/wenheng-Zhang/dsh-dual-host-plugin>（可见性以该站实际状态为准）

提交问题前请移除 API Key、机器人密钥、用户消息、内网地址、签名及私有任务数据。
