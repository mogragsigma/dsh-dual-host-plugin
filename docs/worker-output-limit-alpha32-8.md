---
title: "alpha32.8 Worker 输出耗尽诊断"
description: "真实重装验收暴露的输出截断问题、定向修复与未解决边界"
author: "DSH 双端协作项目"
created: "2026-10-25"
updated: "2026-10-25"
version: "1.0.0"
status: "draft"
category: "guide"
tags: ["worker", "diagnostics", "regression"]
---

# alpha32.8 Worker 输出耗尽诊断

## 真实问题

正式重装后的只读任务使用任务指定 DeepSeek Flash／high，按 60 秒计划独立运行。
全局规则和 worker Skill 已实际加载；第二次响应的原生结束原因是 `max-tokens`，
输出额度 2048 token 被耗尽，尚未生成成果或提交报告。
旧版只报告 `WORKER_REPORT_REQUIRED`，不能准确解释原因。
该失败保持原账本、单批预算和待核对状态；没有重跑或伪造成功。

## 修复范围

- `bundle/task-worker.js`：观察真实流的 `finish` 信号并保留原生数据；截断记录为 `WORKER_MODEL_OUTPUT_LIMIT`。
- `bundle/link-contract.js`：仅对白名单精确错误给出人工核对分类，不建议后台重试。
- `bundle/task-board.js`：展示原始已记录分类，不重写旧失败。
- `bundle/task-notifications.js`：解释输出额度含思考，明确批次未完成、未自动重试或换模型。
- 全局 AGENTS.md 托管模板与 `task-worker` Skill：保持原模型／预算，不以文字计划代替成果。

没有改 DSH、第三方源码、开发授权、模型选择、预算、历史状态或默认重试策略。
即使模型曾提交报告，随后流被截断也不会把该批次认证为成功。
普通入口会话不受 worker 流观察器影响。

## 回归与部署状态

新增失败用例在修复前失败；修复后 Mac／ECS 各 67 项定向回归通过，
另各 208 项安装维护回归通过（测试集有重叠，不相加）。
规则模板在 CRLF、48 KiB 原有用户内容及总 60 KiB 边界下通过，未扩大预算。
冻结候选清单为 `candidate-bundle-alpha32-8.json`。

**alpha.8 尚未正式部署，正式双端仍为 alpha.7。**此修复只改善诊断，
不解决 2048 输出 token 在 high 推理下可能不足的问题。
后续若改变输出预算，必须单独定义新任务策略、持久预算与旧任务兼容边界，
不能靠换任务 ID、静默降级思考程度或重放旧任务来取得绿色结果。
