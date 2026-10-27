---
name: task-intake
description: 历史受管入口 Skill 的兼容指引；转向 task-direct-link，不选择已退役的 dsh-task-intake 模式，不恢复测试命令或旧 IM 收件流程。
---

# 旧入口兼容指引

当前唯一受管入口流程是原生 DSH 会话中的 task-direct-link。先加载该 Skill，按本机全局 AGENTS.md 与 task_identity 处理。
旧 dsh-task-intake 受限工作模式已退役。历史会话和数据仍保留；如旧会话无法继续，说明需由用户选择合适的原生模式，不擅自更改其会话设置。
不要按历史 /task、/run 或 /approve 示例操作；不要求用户输入内部编号。
普通聊天、本地即时操作保留原生能力。入口只登记或调度，不替 worker 执行长期工作。
自有持久保障从 task_submit 入库开始，不宣称所有 IM 原始消息已进入旧 durable inbox。
本版本没有真实开发写入或发布能力，旧名称不能重新授予这些能力。
