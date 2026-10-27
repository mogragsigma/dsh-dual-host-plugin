---
title: "第三方组件声明"
description: "记录锁定依赖的声明许可及第三方权利边界"
author: "mogragsigma"
created: "2026-10-27"
updated: "2026-10-27"
version: "1.0.0"
status: "final"
---

# 第三方组件声明

自有 LICENSE 不替代任何第三方组件的许可，也不限制其原许可赋予接收者的权利。
本安装包不包含 node_modules；运行依赖由官方包管理器按声明获取，其自身版权、LICENSE 与 NOTICE 应保留。
官方 DSH Host、可选 IM、模型及网络服务均不是本项目自有代码。

## 锁文件声明清单

以下来自本包锁文件，仅为声明清单，不等同于全部递归依赖、可选原生二进制和最终部署物的法律审计。
新云端运行时与可选 IM 的独立锁文件随包提供，应与实际安装依赖一并复核。
本次发布前已核对本包直接依赖锁文件的许可字段；未随本包分发的可选组件按下文单独说明，
不得以本表覆盖上游版权声明。

| 组件 | 锁定版本 | 锁文件许可字段 |
| --- | --- | --- |
| `@deepseek-ai/cordis` | `4.0.5` | MIT |
| `@deepseek-ai/cosmokit` | `1.8.6` | MIT |
| `@deepseek-ai/dsh-agent` | `0.2.1-rc.2` | MIT |
| `@deepseek-ai/dsh-anonymous-user-id` | `0.2.1-rc.2` | MIT |
| `@deepseek-ai/dsh-atomic-write` | `0.2.1-rc.2` | MIT |
| `@deepseek-ai/dsh-attachment` | `0.2.1-rc.2` | MIT |
| `@deepseek-ai/dsh-brand` | `0.2.1-rc.2` | MIT |
| `@deepseek-ai/dsh-credentials` | `0.2.1-rc.2` | MIT |
| `@deepseek-ai/dsh-deepseek-llm-api-extensions` | `0.2.1-rc.2` | MIT |
| `@deepseek-ai/dsh-fs` | `0.2.1-rc.2` | MIT |
| `@deepseek-ai/dsh-home-paths` | `0.2.1-rc.2` | MIT |
| `@deepseek-ai/dsh-http-proxy` | `0.2.1-rc.2` | MIT |
| `@deepseek-ai/dsh-launch-environment` | `0.2.1-rc.2` | MIT |
| `@deepseek-ai/dsh-llm` | `0.2.1-rc.2` | MIT |
| `@deepseek-ai/dsh-llm-deepseek` | `0.2.1-rc.2` | MIT |
| `@deepseek-ai/dsh-sandbox` | `0.2.1-rc.2` | MIT |
| `@deepseek-ai/dsh-scope` | `0.2.1-rc.2` | MIT |
| `@deepseek-ai/dsh-session` | `0.2.1-rc.2` | MIT |
| `@deepseek-ai/dsh-session-projection` | `0.2.1-rc.2` | MIT |
| `@deepseek-ai/dsh-system-prompt` | `0.2.1-rc.2` | MIT |
| `@deepseek-ai/dsh-timeout` | `0.2.1-rc.2` | MIT |
| `@deepseek-ai/dsh-typert-protocol` | `0.2.1-rc.2` | MIT |
| `@deepseek-ai/dsh-util-crypto` | `0.2.1-rc.2` | MIT |
| `@deepseek-ai/dsh-util-values` | `0.2.1-rc.2` | MIT |
| `@deepseek-ai/dsh-web` | `0.2.1-rc.2` | MIT |
| `@deepseek-ai/dsh-web-fetch-http` | `0.2.1-rc.2` | MIT |
| `@deepseek-ai/dsh-web-search-deepseek` | `0.2.1-rc.2` | MIT |
| `@deepseek-ai/schemastery` | `3.18.5` | MIT |
| `@js-temporal/polyfill` | `0.5.1` | ISC |
| `@koromix/koffi-darwin-arm64` | `3.1.1` | MIT |
| `@koromix/koffi-darwin-x64` | `3.1.1` | MIT |
| `@koromix/koffi-freebsd-arm64` | `3.1.1` | MIT |
| `@koromix/koffi-freebsd-ia32` | `3.1.1` | MIT |
| `@koromix/koffi-freebsd-x64` | `3.1.1` | MIT |
| `@koromix/koffi-linux-arm64` | `3.1.1` | MIT |
| `@koromix/koffi-linux-ia32` | `3.1.1` | MIT |
| `@koromix/koffi-linux-loong64` | `3.1.1` | MIT |
| `@koromix/koffi-linux-riscv64` | `3.1.1` | MIT |
| `@koromix/koffi-linux-x64` | `3.1.1` | MIT |
| `@koromix/koffi-openbsd-ia32` | `3.1.1` | MIT |
| `@koromix/koffi-openbsd-x64` | `3.1.1` | MIT |
| `@koromix/koffi-win32-arm64` | `3.1.1` | MIT |
| `@koromix/koffi-win32-ia32` | `3.1.1` | MIT |
| `@koromix/koffi-win32-x64` | `3.1.1` | MIT |
| `@standard-schema/spec` | `1.1.0` | MIT |
| `acorn` | `8.15.0` | MIT |
| `eventsource-parser` | `3.1.1` | MIT |
| `ipaddr.js` | `2.5.0` | MIT |
| `jsbi` | `4.3.2` | Apache-2.0 |
| `koffi` | `3.1.1` | MIT |
| `undici` | `8.11.2` | MIT |
| `zod` | `4.4.3` | MIT |

## 云端与可选 IM 的独立锁文件

- `runtime-lock.json`：708 条组件记录，锁文件许可字段均存在。包含 LGPL、MPL 等不同许可，不能套用本项目许可。
- `runtime-im-lock.json`：828 条组件记录。`qrcode-terminal@0.12.0` 未填包许可字段；
  同版本已缓存组件的 LICENSE 为 Apache-2.0，不能把字段缺失当作无许可。
- `@tencent-connect/qqbot-connector@1.2.0` 的包声明为 `UNLICENSED`，缓存包未见 LICENSE。
  这是可选上游 IM 的依赖，不是本 tgz 中再分发的代码；不据此授予 QQ 组件再分发或商用权利。
  宣称覆盖全部 IM 渠道或重新分发包含该组件的部署物之前，应向上游确认授权范围。
- 本次发布未改任何依赖版本、第三方文件或上游许可；元数据检查不等同完整法律审计。

## 规范依据

自定义许可使用 npm 支持的 `SEE LICENSE IN LICENSE` 声明；
[官方 package.json 文档](https://docs.npmjs.com/cli/v10/configuring-npm/package-json/)说明其格式。
禁止转售的许可不符合 OSI 的自由再分发条件，因此使用“源码可见”而不是“开源许可”描述；
参见 [Open Source Definition](https://opensource.org/osd)。
