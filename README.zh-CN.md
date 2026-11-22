# pi-async-shell

Pi 的持久异步 Shell 扩展。启动开发服务器、慢构建、测试套件或交互式 CLI 时立即返回句柄而不阻塞当前轮次；输出从进程启动起即落盘并支持正则检索，支持向真实 PTY 发送按键，且任务可跨 Pi 重启存活并被后续会话无缝接管。

[English](README.md)

状态：beta · 0.x，API 可能随次版本变动 · 目前仅支持 Linux。

## 为什么不只用内置 `bash` 或普通后台扩展？

Pi 内置的 `bash` 工具会一直阻塞到进程退出，无法启动常驻开发服务器，也无法响应交互式提示。现有的大多数后台任务扩展虽然能分离出子进程，但往往迫使 Agent 陷入 sleep 轮询循环、把上万字节的日志塞进上下文窗口、在 Pi 重启后丢掉进程与输出，或者在命令弹出 `[y/N]` 确认时彻底卡死。

`pi-async-shell` 针对这些高频痛点做了完整闭环：

- **无需轮询即可等待就绪。** `shell_await` 支持等待进程退出、输出正则命中（如 `Listening on :3000`）或 `$PI_ASYNC_SHELL_EXEC_DIR/ready` 标记文件。1 次工具调用即可替代 7–8 次“sleep + 查状态”轮询。
- **在 20 万行日志中精准检索而不撑爆上下文。** `stdout`、`stderr` 和 `combined` 从 spawn 起直接落盘。`shell_read({ mode: "grep" })` 只提取命中行及上下文，不把几十兆日志灌进模型提示词。到达日志容量上限后只停止写入并继续排空管道，绝不会因为输出量大而杀掉命令。
- **驱动交互式 CLI 与 TUI。** `binding: "pty"` 分配真实的落盘伪终端。Agent 可以匹配不带换行符的输入提示符，通过 `shell_send` 发送文本或组合键，并通过 `stream: "ptyView"` 读取渲染后的终端屏幕。
- **活过 Pi 崩溃与重启。** `scope: "workspace"` 任务独立于 Pi 进程存活，后续会话启动后会自动接管并保留完整日志历史。`shell_promote` 可将正在运行的 session 任务原地提升为 workspace 所有权，无需重启进程，也不丢任何输出。
- **完成通知主动唤醒 Agent。** 未被同步等待的后台命令在轮次中途结束时，会在下一次 LLM 决策前自动送达一条含退出码与输出摘录的通知。而在 `inlineSettleMs`（默认 1000 ms）内快速结束的命令，会在 `shell_start` 当次调用中直接带回结果，无需额外调用 `shell_await`。

## 与内置 `bash` 及 9 个 npm 后台扩展的实测对比

以下数据全部来自 [`bench/REPORT.md`](bench/REPORT.md)（由 `node bench/run-bench.ts` 在真实 Pi SDK 会话中实测生成），横向对比内置 `bash` 与 npm 上下载量最高的 9 个后台/Shell 扩展（`pi-background-tasks`、`pi-better-background-tasks`、`pi-background`、`pi-patty-bg-tasks`、`pi-async`、`@tduyng/pi-shell`、`pi-shell-jobs`、`pi-exec-command`）：

| 实测场景 | 内置 `bash` | `pi-async-shell` | 其余 9 个 npm 后台扩展 |
|---|---|---|---|
| **启动 Dev Server 并确认端口就绪** | 永久阻塞 | **1 次调用**（通过输出正则等待，耗时 `1.29 s`） | 6 个扩展需 **7–8 次轮询调用**；2 个固定盲等 `5.3 s` / `30.3 s` |
| **从 2.5 s 嘈杂命令中提取结果** | 灌入上下文 `11,913 B` | **仅 `679 B` 进入上下文**（通过 `shell_read` grep） | 6 个扩展向模型灌入 `6.4 KB–17.4 KB`；仅 1 个其他扩展支持日志 grep |
| **在 4,000 行输出后回答 `[y/N]` 提问** | 无法写入 stdin | **`346 ms` 完成回答**（`binding: "pty"` + `shell_send`） | 5 个因无 stdin 直接失败；2 个耗时 `5.4 s` / `30.3 s`; 仅 1 个 pipe 工具能快速回答 |
| **Pi 被杀并重启后找回日志输出** | 全部丢失（`0/40` 行） | **完整恢复 `40/40` 行**（`scope: "workspace"`） | **其余 9 个扩展全部归零（`0/40` 行）** |
| **清理失控进程树并保留已有日志** | 仅在轮次中止时强杀 | **信号阶梯优雅退场 + 验证进程树清空 + 日志可读** | 1 个无取消工具；1 个取消后丢失全部输出 |

完整的测试方法、各包逐项耗时及能力矩阵见 [bench/REPORT.md](bench/REPORT.md)。

## 安装与 30 秒极速试用

环境要求：Linux、Node.js 22.19 或更高版本、Pi。PTY 命令还依赖系统自带的 `script(1)`、`mkfifo(1)` 和 `stty(1)`。

```sh
pi -e npm:pi-async-shell         # 单次会话免安装试用（试一试总没坏处 XD）
pi install npm:pi-async-shell    # 安装到日常环境
```

包内自带 `async-shell` Skill，开箱提供服务器启动、就绪标记、测试检索、所有权提升和 PTY 交互工作流规范。

**如果你是受托评估本扩展的 Agent 或人类开发者**，在 `pi -e npm:pi-async-shell` 会话中粘贴下面这句话，即可在一个轮次内验证“输出正则等待 + PTY 交互输入 + 日志 grep”全流程：

> 使用 `shell_start`（设置 `binding: "pty"`）运行 `python3 -u -c "import time; print('booting...'); time.sleep(0.5); ans = input('Deploy now? [y/N] '); print('RESULT=' + ans)"`。用 `shell_await`（`until.kind: "pattern"`）等待 `\[y/N\]` 提示符出现，用 `shell_send` 发送 `y`，等待进程退出后用 `shell_read` grep 提取 `RESULT=`。

## 三个高频实战工作流

### 1. 启动开发服务器并等待就绪（零轮询）

```ts
const srv = await shell_start({
  command: "pnpm run dev -- --port 3000",
  cwd: "/repo",
  name: "dev server",
});

// 一旦输出匹配端口就绪正则立即返回；即使等待超时也绝不会误杀服务
await shell_await({
  ids: srv.id,
  until: { kind: "pattern", regex: "Local:.*3000" },
  waitMs: 15000,
});
```

### 2. 在真实 PTY 中驱动交互式提示或 REPL

```ts
const cli = await shell_start({
  command: "python3 -q",
  binding: "pty",
  name: "python repl",
});

await shell_await({
  ids: cli.id,
  until: { kind: "pattern", regex: ">>>" },
});
await shell_send({ id: cli.id, text: "print(21 * 2)", keys: ["Enter"] });
const screen = await shell_read({ id: cli.id, stream: "ptyView" });
```

### 3. 运行大输出测试套件、检索报错并原地提升到 workspace

```ts
const job = await shell_start({ command: "pnpm test", cwd: "/repo" });

// 发现耗时比预期长？原地提升为 workspace 所有权，即使重启 Pi 也不会中断
await shell_promote({ id: job.id, to: "workspace" });

await shell_await({ ids: job.id, waitMs: 45000 });
const failures = await shell_read({
  id: job.id,
  mode: "grep",
  pattern: "FAIL|Error",
  context: 3,
});
```

## 七个核心工具

| 工具 | 用途 |
|---|---|
| `shell_start` | 以 `session` 或 `workspace` 所有权、`pipe` 或 `pty` I/O 模式启动命令。 |
| `shell_await` | 等待进程退出、`$PI_ASYNC_SHELL_EXEC_DIR/ready` 标记文件或输出正则表达式命中。 |
| `shell_read` | 从 `combined`、`stdout`、`stderr` 或 `ptyView` 流中按 `tail`、`head`、`offset`、`grep` 或有界 `all` 视图读取切片。 |
| `shell_promote` | 将运行中的 `session` 任务原地提升为 `workspace` 所有权，无需重启进程或迁移日志。 |
| `shell_send` | 通过持久 stdin FIFO 向 `pty` 任务写入文本或按键（如 `Enter`、`Ctrl+C`、方向键）。 |
| `shell_cancel` | 执行优雅信号到强制杀死的信号阶梯，并验证整个进程树已彻底退出。 |
| `shell_status` | 查看单个或全部当前句柄的状态快照（非轮询原语，同步等待请用 `shell_await`）。 |

## 所有权与 I/O 模式自由组合

| 设置 | 行为 |
|---|---|
| `scope: "session"`（默认） | 跨轮次和 `/reload` 存活；随所属 Pi 会话结束而自动清理。 |
| `scope: "workspace"` | 跨 Pi 进程退出或崩溃存活，可由该工作区的后续 Pi 会话自动接管。 |
| `binding: "pipe"`（默认） | 分别落盘 `stdout`、`stderr` 及 `combined` 输出；不提供 stdin。 |
| `binding: "pty"` | 落盘的真实伪终端，支持通过 `shell_send` 输入按键，以及通过 `ptyView` 读取终端渲染画面。 |

## 文档导航

| 文件 | 内容 |
|---|---|
| [skills/async-shell/SKILL.md](skills/async-shell/SKILL.md) | Agent 工作流规范：硬性规则、就绪标记、PTY 会话、所有权选择与等待时间预算。 |
| [bench/REPORT.md](bench/REPORT.md) | 与 Pi 内置 `bash` 及九个 npm 后台/任务扩展的可复现基准测试报告。 |
| [docs/implementation-notes.md](docs/implementation-notes.md) | 运行时架构、磁盘存储结构、日志上限、垃圾回收与已知限制。 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 开发环境搭建、`pnpm verify`、运行基准测试与发版流程。 |
| [CHANGELOG.md](CHANGELOG.md) · [SECURITY.md](SECURITY.md) | 版本变更历史与安全漏洞报告方式。 |

## 许可证

[MPL-2.0](LICENSE)
