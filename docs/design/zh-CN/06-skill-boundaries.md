---
kind: normative
applies_to: 0.2.4
tracks:
  - skills/async-shell/SKILL.md
  - skills/async-shell-maintainer/SKILL.md
  - tests/skill-boundaries.test.ts
---

# 06. Skill 边界

## 1. 目的

本包发布两个 skill。async-shell 服务于使用扩展的人。async-shell-maintainer 服务于修改扩展的人。

这种拆分保护日常提示词预算，也让贡献者指南有一个明确的归属。

此边界约束 skill 正文。公开工具 schema 和结果字段仍由执行契约管理。

## 2. 按任务所有权路由

| 任务目标 | Skill | 示例 |
|---|---|---|
| 在消费仓库中使用扩展 | async-shell | shell_start、shell_await、shell_read、shell_send |
| 修改、调试、记录或发布扩展本身 | async-shell-maintainer | src/、tests/、docs/、package.json |
| 一个请求同时覆盖两类目标 | 按目标拆分 | 消费工作用 async-shell，包工作用 async-shell-maintainer |

仓库所有权和任务意图决定 skill，命令名不决定。消费项目的 pnpm test 使用 async-shell。本包自己的 pnpm test 使用 async-shell-maintainer。

用户故障排查属于 async-shell，即使 Agent 需要读取日志。修改故障恢复行为属于 async-shell-maintainer。

## 3. 内容所有权

| 内容 | 所有者 | 权威契约 |
|---|---|---|
| 工具选择、调用、就绪、PTY、作用域、完成选项和有界读取 | async-shell | docs/design/03-execution-model-and-primitives.md |
| 丢失执行、只读工作区和截断日志的用户排查 | async-shell | docs/design/05-durability-and-containment.md |
| 贡献者设置、修改流程、验证和发布 | async-shell-maintainer | CONTRIBUTING.md |
| 生命周期钩子和投递内部机制 | async-shell-maintainer | docs/implementation-notes.md |
| 进程、日志、writer lock 和 GC 内部机制 | async-shell-maintainer | docs/design/04-runtime-architecture.md |
| 提示词契约和 skill 维护 | async-shell-maintainer | docs/design/06-skill-boundaries.md |

贡献者条目只放在 skills/async-shell-maintainer/SKILL.md，不进入 skills/async-shell/SKILL.md。完整机制以权威契约为准，维护 skill 只保留简短摘要。

## 4. 公共行为与内部机制

日常 skill 可以描述可观察行为而不写内部名称，包括 print/JSON 落定、完成投递和 capped log 的前缀语义。

内部钩子和机制名称只进入维护材料，例如 agent_before_settle、session_shutdown、consumedByAwait、pipe-supervisor.mjs、recording-writer.mjs 和 script(1)。

用户排查字段保留在日常材料中。lost、workspaceOwner 和 bytes.capReached 会影响用户决策，并不因此成为维护导向内容。

工具 schema 和结果字段仍是公共契约。此边界只限制 skill 正文。

## 5. 修改流程

1. 把目标分类为消费工作或包工作。
2. 当用户需要新的行动或判断时，更新 async-shell。
3. 当贡献者流程变化时，更新 async-shell-maintainer 和 CONTRIBUTING.md。
4. 当机制变化时，更新 docs/design/ 和 docs/implementation-notes.md。async-shell-maintainer 只保留简短摘要。
5. 保持两个 frontmatter description 互不重叠。
6. 同步更新两个语言版本，保持结构和代码标识一致。
7. 修改任一 skill 或本契约后，运行 pnpm verify。

## 6. 证据

Evidence: `skill-boundaries.test.ts` — "daily and maintainer skills have disjoint routing and ownership".
