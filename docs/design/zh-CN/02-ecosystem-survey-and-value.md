---
kind: empirical
applies_to: 0.2.0-beta.3
tracks:
  - package.json
  - bench/REPORT.md
---

# 02. 生态调研、实证基线与可辩护的项目价值

本文每条主张都带分类。**[事实]** 表示该主张直接来自本工作区中的源代码、官方文档、包元数据或 CLI 执行。**[推断]** 表示该主张由已验证事实推出。**[建议]** 表示这是 `pi-async-shell` 的设计决定。

**调研范围。** 已安装扩展的调研覆盖本机 Pi 安装。另有两个竞争者 `pi-interactive-shell@0.18.0` 与 `pi-processes@0.4.3`，依据其发布的 npm 元数据与发布 tarball 中的 README 描述。两者都是生态比较，不是基准条目。下载量、star 数以及既未安装也未在此命名的包保持未测量。因此本文不对方圆生态的规模或排名作任何主张。

---

## 1. 当前工作区与环境基线

### 1.1 仓库状态
- **[事实]** 工作区路径：`~/Programs/school/pi-async-shell`。该目录曾从工作名 `pi-subterminals` 改名一次。改名发生在决定构建异步执行句柄、而不是从属终端之后。
- **[事实]** 版本：`0.2.0-beta.1`（调查时的 `package.json`）。许可证：该版本为 MIT。此后项目改用 MPL-2.0。运行目标：仅 Linux，Node.js `>=22.19.0`。 <!-- historical -->
- **[事实]** 版本控制：Jujutsu（`.jj/`）与 Git（`.git/`）并存的仓库。
- **[事实]** 运行时状态目录是工作区下的 `.pi/async-shell/`，按需创建。扩展会在其中写一个内容为 `*` 的本地 `.gitignore`。已存在的文件保持内容不变。

### 1.2 本机终端与 Shell 环境
- **[事实]** 已安装 tmux 版本：`tmux 3.8`。它不是本项目的依赖。列出它是因为比较矩阵提到终端多路复用器。
- **[事实]** `script(1)`、`setsid(1)`、`mkfifo(1)` 与 `stty(1)` 均存在（`util-linux 2.42.4`、`coreutils 9.12`）。它们是 `pty` 绑定唯一使用的外部程序。
- **[事实]** 默认用户 shell 环境：`/usr/bin/nu`（Nushell）。`pi-background-tasks` 把该 shell 分类为 `user-non-posix`。在执行命令时，`pi-async-shell` 忽略环境 `$SHELL`。存在 `/bin/bash` 时，它运行 `/bin/bash -c`。否则它运行 `/bin/sh -c`。`PI_ASYNC_SHELL` 是显式覆盖。`pty` 包装器还为 `script(1)` 这一层固定 `SHELL=/bin/sh`，因为 `script` 通过 `$SHELL` 运行命令。用于诊断的 POSIX 集合是 `sh`、`bash`、`dash`、`zsh`、`ksh` 与 `ash`。`fish` 在该集合之外。

---

## 2. Pi 宿主能力与最佳实践（`@earendil-works/pi-coding-agent@1.5.2`）

验证自 `~/.pi/agent/pi-base/docs/extensions.md`、`docs/codemode.md` 与 `dist/core/tools/bash.js`：

1. **并行工具执行与 Codemode（`docs/extensions.md:575`、`docs/codemode.md`）：**
   - **[事实]** 默认情况下，单轮内的助手工具调用并行执行。设置 `executionMode: "sequential"` 的工具是例外。
   - **[事实]** 本用户环境（`~/.pi/agent/settings.json`）启用 `"codemode": { "mode": "only", "inlineBudget": 65535 }`。模型通过在 QuickJS 沙箱中编写异步 JavaScript（`await tools.<name>(args)`）与工具交互。在该沙箱内，`Promise.all([...])` 可以在单次模型轮次中并发调用多个工具。
   - **[事实]** 声明 `outputSchema` 并返回 `structuredContent` 的工具会把类型化对象直接交给 `codemode` 脚本。它们仍返回人类可读、模型可读的 `content` 文本（`docs/extensions.md:2218`）。
2. **内置 `bash` 工具实现（`dist/core/tools/bash.js`、`dist/core/tools/output-accumulator.js`）：**
   - **[事实]** 它在 POSIX 上启动脱离的进程组（`detached: process.platform !== "win32"`、`stdio: ["ignore", "pipe", "pipe"]`）。它阻塞到 `waitForChildProcess(child)` 解除。`signal` 或超时中断该等待。
   - **[事实]** 它通过 `onUpdate` 流式发送增量快照，由 `BASH_UPDATE_THROTTLE_MS` 节流。
   - **[事实]** 它在内存中保留滚动尾部缓冲。当输出超过 `DEFAULT_MAX_BYTES`（50 KiB）或 `DEFAULT_MAX_LINES`（2000 行）时，它把原始字节溢写到临时文件。
   - **[事实]** 它返回 `structuredContent`：`{ output, truncated, full_output_path, exit_code, wall_time_seconds }`（`STRUCTURED_OUTPUT_MAX_BYTES = 1 MiB`）。
   - **[推断]** `codemode` 中的 `Promise.all([tools.bash(...), tools.bash(...)])` 可以并行运行多条有限命令。整个 `codemode` 调用阻塞到**所有**被 await 的命令结束，或直到 60 秒沙箱超时。该调用无法启动服务器或长 build。控制只在轮次之间到达 Agent 或用户。该调用不附着终端。
3. **异步通知与轮次触发（`docs/extensions.md:1602`）：**
   - **[事实]** `pi.sendMessage({ customType, content, display, details }, { triggerTurn, deliverAs })` 向会话注入自定义消息。
   - **[事实]** `deliverAs: "followUp"` 等到当前 Agent 运行没有更多工具调用后投递。`deliverAs: "steer"` 在当前轮次工具批次结束后、下一次 LLM 调用之前投递。Pi 空闲时，`triggerTurn: true` 立即启动一次 LLM 轮次。
   - **[事实]** `agent_end` 不是最终空闲，因为重试、自动压缩或排队消息都能继续运行。`agent_before_settle` 是最后一个可行动边界，`agent_settled` 是最终空闲通知（`docs/extensions.md:214`）。
4. **会话生命周期与 Reload（`docs/extensions.md:254`、`1510`）：**
   - **[事实]** `session_start` 以 `reason: "startup" | "reload" | "new" | "resume" | "fork"` 触发。
   - **[事实]** `session_shutdown` 以 `reason: "quit" | "reload" | "new" | "resume" | "fork"` 触发。
   - **[事实]** 顶层工厂函数不启动任何后台进程或定时器。扩展惰性初始化资源，或在 `session_start` 中初始化。它们在 `session_shutdown` 中幂等清理（`docs/extensions.md:174`）。

---

## 3. 已安装扩展与包

### 3.1 全局扩展（`~/.pi/agent/extensions/`）
通过阅读 `~/.pi/agent/extensions/` 中的每个文件验证：

| 条目 | 用途 | 与 `pi-async-shell` 的重叠 |
|---|---|---|
| `device-net/index.ts` | 通过 ADB 对 Android 内核网络 sysctl 做探测／快照／应用／差异／恢复（`dnet_*` 工具）。 | 无。 |
| `export-md.ts` | `/export-md` 命令，经 `~/.local/bin/pi-md` 导出会话记录为 Markdown。 | 无。 |
| `git-checkpoint.ts` | 在 `turn_start` 创建 `git stash create` 检查点，并在 `session_before_fork` 时提供恢复。 | 无。 |
| `github-issue-autocomplete.ts` | 用 `gh issue list` 在提示编辑器中自动补全 `#<issue>`。 | 无。 |
| `handoff.ts`（+ `.instructions.md`） | `/handoff` 命令，总结当前会话并开启新的聚焦会话。 | 无。 |
| `notify.ts` | 在 `agent_settled` 后 750 ms 仍空闲时发送桌面通知（`notify-send`／OSC 777）。 | **交互提示：** `triggerTurn: true` 的完成消息会唤醒 Agent；`notify.ts` 用 `SETTLE_GRACE_MS = 750` 对快速重启的运行做防抖。 |
| `pi-base-link.ts` | 维护指向当前 Pi 安装目录的 `~/.pi/agent/pi-base` 符号链接。 | 无。 |
| `preset.ts` | `/preset` 命令与 `--preset` 参数，用于切换模型／工具／提示预设。 | 无。 |
| `protected-paths.ts` | 阻止 `write`、`edit` 与 `bash` 重定向写入 `.env*`、`.git/`、`.jj/`、`node_modules/`、`~/.ssh/`、`auth.json`。 | **[建议]** 本机集成同时覆盖 `shell_start` 命令与 `shell_send` 的 PTY 输入，以及 `bash` 重定向。 |
| `read-abort-guard.ts` | 猴子补丁 `FileHandle.createReadStream`，避免 `Promise.all` 中 `signal` 预先中断时抛出未捕获的 `AbortError`。 | **重要运行时教训：** `pi-async-shell` 用 `AbortSignal` 打开的任何文件流都必须防范预先中断的信号。 |
| `tools.ts` | `/tools` 交互式 TUI 开关，按会话分支启用／禁用工具。 | 无。 |

### 3.2 已安装 Pi 包（`~/.pi/agent/settings.json` 与 `~/.pi/agent/npm/node_modules/`）
验证自全部 16 个已配置包的 `package.json` 与源文件：

| 包 | 版本 | 角色 | 与 `pi-async-shell` 的重叠 |
|---|---|---|---|
| `pi-background-tasks` | `2.6.10` | 后台 shell 作业（`bg_run`、`bg_status`、`bg_logs`、`bg_kill`、`/bg`、`/tasks`），外加只读委派 Agent（`bg_delegate`）、带证明的 Pi 运行（`bg_run_pi_attested`）与 5 模型 Fusion 工作流（`fusion_*`）。 | **主要比较对象**（§4 深入分析）。 |
| `@agent-sh/computer-use-linux` | `0.7.54` | 通过 AT-SPI 可访问性树、Wayland/X11 截图、窗口聚焦与键鼠合成做桌面 GUI 观察／控制。 | 正交（桌面 GUI 对 shell 执行句柄）。 |
| `@narumitw/pi-goal` | `0.55.3` | 自主多轮 `/goal` 契约循环，含 `goal_complete`、`goal_blocked`、`goal_wait(resume_after_ms)`。 | 互补（`goal_wait` 暂停活动 `/goal` 循环等待外部事件）。 |
| `pi-lens` | `4.5.0` | LSP 导航、诊断与 ast-grep 工具。 | 无。 |
| `pi-fovea` | `0.33.2` | 仓库图素描与热扩散聚焦（`fovea_*`）。 | 无。 |
| `pi-web-access` | `0.48.0` | Web 搜索与内容抓取（`web_search`、`fetch_content` 等）。 | 无。 |
| `pi-vcc-codemode` | `0.1.6` | 保留记录的结构化压缩器与 `vcc_recall`。 | 无。 |
| `pi-memory-sessions` | `1.0.0` | 跨会话 SQLite FTS 召回（`session_search`、`session_read`）。 | 无。 |
| `pi-codemode-snippets` | `0.2.5` | 把带 `// @snippet:` 的 `.js` codemode 脚本提升为工具。 | 无。 |
| `pi-cache-optimizer` | `2.10.6` | 提示缓存键稳定化与统计。 | 无。 |
| `pi-context-view` | `0.8.4` | 上下文 token 分解查看器。 | 无。 |
| `pi-commandcode-provider` | `0.8.4` | 自定义模型提供者。 | 无。 |
| `@juicesharp/rpiv-ask-user-question` | `2.15.0` | `ask_user_question` 结构化问卷工具。 | 无。 |
| `@juicesharp/rpiv-todo` | `2.15.0` | `todo` 任务列表覆盖层工具。 | 无。 |
| `@narumitw/pi-btw` | `0.63.8` | `/btw` 侧问题覆盖层。 | 无。 |
| `@narumitw/pi-tui-kit` | `0.70.0` | Pi TUI 的 UI 组件库。 | 需要时可复用的 UI 构件。 |

### 3.3 Pi 内置扩展示例（`~/.pi/agent/pi-base/examples/extensions/`）
- **[事实]** `interactive-shell.ts` 拦截 `user_bash`（`!vim`、`!htop`、`!git rebase -i`）。它调用 `tui.stop()`，然后运行 `spawnSync(shell, ["-c", command], { stdio: "inherit" })`。命令退出后，它重启 TUI。交互命令运行期间，Pi TUI 完全挂起。这个示例与 §5.1 的 `pi-interactive-shell` 包无关。它明确写出一条限制：*"This only intercepts user `!` commands, not agent bash tool calls."*

---

## 4. `pi-background-tasks@2.6.10` 深入审计

验证自 `~/.pi/agent/npm/node_modules/pi-background-tasks/src/` 与 `docs/`：

### `pi-background-tasks` 做得好的地方
1. **直接的进程组 spawn（`src/core/registry.ts`）：** 它用 Node `spawn()` 配 `stdio: ["ignore", "pipe", "pipe"]` 与脱离的 POSIX 进程组。它还有严格的 POSIX 停止路径：向 `-pgid` 发 `SIGTERM`，3 秒宽限，向 `-pgid` 发 `SIGKILL`，再用 `ESRCH` 验证。
2. **完成投递（`docs/concepts/completion-delivery.md`）：** 它在输出流关闭且元数据原子写入之后，通过 `pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })` 发出 `<background-task-notification>`。
3. **同进程 reload 存活（`src/core/reload-shell-owner.ts`）：** 它把选择 `surviveReload: true` 的 shell 执行通过进程全局 `Symbol.for('pi-background-tasks.reload-shell-owner.v1')` 租约中心跨 `/reload` 转移。交接超时是 30 秒。
4. **激活 shell 策略（`src/core/shell-policy.ts`）：** 它把 `<pi_background_shell_policy>` 注入系统提示。模型由此知道 `bg_run` 用的是 `/usr/bin/nu -c`、`bash -c` 还是 `sh -c`。

### `pi-background-tasks` 的结构性局限与范围差异
1. **没有因果 `await`／屏障原语：**
   - **[事实]** 对 shell 工作，`pi-background-tasks` 只提供 `bg_run`、`bg_status`、`bg_logs` 与 `bg_kill`。它的提示准则禁止轮内等待：*"After a default bg_run launch, continue only independent useful work... otherwise briefly acknowledge it if useful, then end the current turn."*
   - **[推断]** 设想一个 `codemode` 脚本或多步轮次。Agent 启动 3 个并行任务。或者它启动一个服务器，等待 `"Listening on port 3000"`，然后想在**同一轮**内执行下一步依赖操作。此时 `pi-background-tasks` 强制一次完整轮次边界与一次额外 LLM 往返。另一种可能是它诱导模型进入被禁止的 sleep／轮询循环。
2. **破坏性的 20 MiB 输出上限会杀死运行中的进程：**
   - **[事实]** `MAX_OUTPUT_BYTES = Number(process.env['PI_BG_MAX_OUTPUT_BYTES'] ?? 20 * 1024 * 1024)`（`src/core/registry.ts:72`）。当任务合并输出超过 20 MiB 时，运行时追加错误通知。然后它**杀死任务进程树**，并把任务标记为 `failed`（`docs/subsystems/background-task-runtime.md:107`）。
   - **[推断]** 啰嗦的 build、带 trace 日志的测试套件与长时间运行的 dev server 会在中途死亡，只因为它们产生日志。
3. **粗糙的日志读取（只有 `head`／`tail`）与合并流：**
   - **[事实]** `bg_logs` 只支持 `{ taskId, maxBytes, tail: boolean }`（`src/extension.ts:212`）。它把 `stdout` 与 `stderr` 合并进单个 `.output` 文件。它没有行偏移分页、没有字节偏移游标，也没有流选择（`stdout` 对 `stderr`）。它没有任务日志内的正则或字面搜索。
4. **没有 PTY、没有交互输入、没有外部终端视图、没有跨进程持久化：**
   - **[事实]** `src/extension.ts:62-68` 写道：*"Explicit background shell jobs only... No PID/file adoption, process-restart survival, or crash recovery."* `stdio[0]` 硬编码为 `'ignore'`。
5. **重量级多用途捆绑：**
   - **[事实]** `pi-background-tasks` 一半以上的代码用于启动子 Pi Agent。目标是 `bg_delegate`、`bg_run_pi_attested`，以及 5 模型 `fusion_reason`／`fusion_investigate`／`fusion_research`／`fusion_validate` 工作流。
   - **[事实]** 其内部 `pi.events` 总线（`pi-background-tasks:request:v1`、`src/core/extension-api.ts:116`）只暴露 `capabilities | run | status | logs | kill`。它在该总线上明确拒绝 `surviveReload`（`docs/subsystems/background-task-runtime.md:80`）。

### 共存：保留 Agent 与 Fusion 工具，禁用重叠的 shell 面

本包让 `pi-background-tasks` 保持原样。它的命令与内部状态保持完整。两个扩展只在后台 shell 执行上重叠。**[建议]** 禁用四个重叠工具，保留其余：

```json
{
  "defaultTools": [
    "+codemode",
    "+tool_search",
    "-bg_run",
    "-bg_status",
    "-bg_logs",
    "-bg_kill"
  ]
}
```

把这些条目合并进现有的 `defaultTools` 数组。`bg_delegate`、`bg_run_pi_attested` 与 `fusion_*` 保持可用。这条建议针对工具面重叠，不针对信任。两个扩展可以同时安装，彼此都不读取对方的状态。

---

## 5. 其他生态竞争者（不在基准场内）

`bench/REPORT.md` 的基准测量固定场：八个后台／任务包，加上 Pi 内置 `bash` 与 `pi-async-shell`。下面两个包只是生态比较。调研读自它们发布的发布物，它们的数字不在基准里。

### 5.1 `pi-interactive-shell@0.18.0`

- **[事实]** npm 描述：*"Run AI coding agents in pi TUI overlays with interactive, hands-free, and dispatch supervision"*（`pi-interactive-shell@0.18.0`）。
- **[事实]** 它在可观察的 TUI 覆盖层里运行交互式 CLI。用户观看，可以打字接管，Agent 可以查询状态并发送输入。PTY 支持使用 `zigpty` 预编译二进制。
- **[事实]** 四种模式。`interactive` 是默认模式，持有稳定的 `sessionId` 用于输入／状态。`hands-free` 用 `sessionId` 轮询，并接收安静更新。`dispatch` 完成时经 `triggerTurn` 通知。`monitor` 在结构化监视触发器事件时通知。
- **[事实]** 运行中的后台会话与监视器能活过 `/reload`，并在新扩展实例下重新出现。退出 Pi 或切换会话仍会终止它们。
- **[推断]** 它的轴与本项目不同。`pi-interactive-shell` 优化人类可见的终端监督：一个人可以观看并接管的覆盖层。它不是持久化层。它没有工作区认领，也没有后续 Pi 进程可以认领的跨进程句柄。`pi-async-shell` 优化持久、仅 Agent 的执行：文件日志、就绪标记、输出模式等待与工作区恢复。需要人在终端前的用户使用 `pi-interactive-shell`。需要 build 活过 Pi 的用户使用 `pi-async-shell`。

### 5.2 `pi-processes@0.4.3`

- **[事实]** npm 描述：*"Codex-inspired process execution for Pi on macOS and Linux"*（`pi-processes@0.4.3`）。
- **[事实]** 它用受管进程接口替换 Pi 的 `bash` 工具。不带模式的调用委托给内置执行器。显式 `foreground`、`background` 或 `service` 模式创建受管进程。PTY 支持是可选的（`node-pty`），每次非空 PTY 输入写入都需要批准。
- **[事实]** 其工具面是 `process_wait`、`process_output`、`process_list` 与 `process_kill`。等待最多覆盖八个进程，由事件驱动（`until: all|any`）。读取接受游标或尾部。kill 向自有进程组发 SIGTERM，500 ms 后发 SIGKILL。
- **[事实]** 保留有上限：最多 32 条记录、每个运行时 32 MiB 原始输出、每个进程 8 MiB。达到上限时，已完成的记录从最旧的开始驱逐。只有当全部槽位都在运行或被读者钉住时，准入才失败。
- **[事实]** 其 README 写道：*“SIGKILL/crash can leave temporary logs behind; there is no restart recovery.”*
- **[推断]** `pi-processes` 是等待与输出轴上最接近的竞争者。它有轮内等待、进程管理器与有界保留。它在持久化、就绪、日志检索与平台上不同。它没有工作区认领。其 README 说服务启动不是就绪。游标与尾部读取取代持久日志上的正则搜索。其平台集合是 macOS 与 Linux，而本项目仅 Linux。

---

## 6. 持久 PTY 配方的实证验证

`pty` 绑定建立在 `script(1)`、`mkfifo(1)`、`stty(1)` 与 Node 的 `detached` spawn 之上。下表中的每条主张都在本环境实际运行配方验证过，不是从文档读取：

| 主张 | 验证方式 | 结果 |
|---|---|---|
| 子进程拥有真实终端 | 在 PTY 内运行 `test -t 0` 与 `test -t 1` | **[事实]** 两者皆真；`tty` 指向 `/dev/pts` 设备 |
| FIFO stdin 仍能得到可用终端 | 子进程阻塞在 `read` 时，从第二个进程向 FIFO 写入 `hello\n` | **[事实]** 子进程收到该行并回显 `got:hello` |
| 尺寸必须显式设置 | 在 stdin 为 FIFO 的 PTY 内运行 `stty size` | **[事实]** 没有 `stty rows/cols` 行时是 `0 0`，有它时是记录的尺寸 |
| 退出码能穿过包装器 | 子进程执行 `exit 7` | **[事实]** `exit.json` 记录 `7`；`script -e` 传播它 |
| 经 FIFO 的 ^C 能中断子进程 | 子进程睡眠时向 FIFO 写入 `0x03` | **[事实]** 子进程以 `130` 退出——但只有在后台 `script` 作业复位 SIGINT 处置时才成立，这就是包装器在 `exec` 前运行 `trap - INT QUIT` 的原因 |
| 没有所有者监视时（`workspace`），PTY 能活过硬父进程退出 | 对启动包装器的进程执行 `kill -9` | **[事实]** 包装器、`script` 与子进程全部存活；输出继续落进日志；新进程仍能写 FIFO |
| 被监视的 PTY（`session`）在所有者死亡时被拆除 | 给包装器一根来自所有者的管道，并对所有者执行 `kill -9` | **[事实]** 包装器读到 EOF 并杀死 `script`；`exit.json` 记录信号 |

其中两个结果改变了设计。`0 0` 尺寸会让每次重放与每个 TUI 都以错误宽度渲染，而且是静默的。被忽略的 SIGINT 会让 `pty` 执行的优雅取消变成空操作，同样是静默的。

---

## 7. 诚实的比较矩阵与可辩护的项目价值

### 7.1 跨方案比较

`bench` 表示该包在基准场内。`ecosystem` 表示仅依据其发布物描述的包。当包能做一部分、但做不到本项目声明的契约时，能力标为 `部分`。

| 能力 | Pi 内置 `bash`（bench） | `pi-background-tasks@2.6.10`（bench） | `pi-interactive-shell@0.18.0`（ecosystem） | `pi-processes@0.4.3`（ecosystem） | `pi-async-shell`（bench） |
|---|---|---|---|---|---|
| **短命令的零开销同步执行** | **是（最佳）** | 否（额外工具／生命周期开销） | 否（覆盖层生命周期） | 是（无模式时委托内置） | **委托给内置 `bash`** |
| **非阻塞启动** | 否 | 是（`bg_run`） | 是（`interactive_shell`） | 是（`mode: "background"`／`"service"`） | **是（`shell_start`）** |
| **轮内因果同步** | 无条件阻塞 | 否（强制结束轮次） | 否（轮询／状态查询） | 是（`process_wait`） | **是（`shell_await`：退出、就绪标记、输出模式）** |
| **输出模式等待** | 否 | 否 | 部分（监视流触发器） | 否 | **是** |
| **完成时唤醒空闲轮次** | 不适用 | 是 | 是（dispatch／monitor） | 是（background 模式） | **是（合并投递，已被 await 时抑制）** |
| **完整日志保留且不杀死啰嗦作业** | 截断时写临时文件（阻塞到退出） | **否**（20 MiB 杀死） | 会话输出有界；保存的日志 24 小时后过期 | 有界（运行时 32 MiB，每进程 8 MiB） | **是（100 MiB 管道上限排空而不杀死；PTY 录制无上限）** |
| **随机访问与过滤日志读取** | 退出后对临时文件 `read` | 只有 `head`／`tail`；合并流 | 输出查询，不是持久日志 | 游标／尾部读取，无正则搜索 | **是（`head`／`tail`／`offset`／`grep` + 独立 `stdout`／`stderr`／`combined`）** |
| **PTY 分配与交互输入** | 否（`stdin: ignore`） | 否（`stdin: ignore`） | 是（覆盖层，人类接管） | 是（可选 `node-pty`，逐次写入批准） | **是（`binding: "pty"`、`shell_send`）** |
| **给 Agent 的渲染屏幕读取** | 否 | 否 | 部分（有界终端文本与屏幕摘录） | 否（控制序列被移除） | **是（`stream: "ptyView"`）** |
| **活的终端人类视图／接管** | 否 | 只读 TUI 日志查看器（`/tasks`） | **是（该包的核心）** | `/processes` 管理器，无活终端接管 | **否，有意如此**——没有附着面（R3） |
| **跨 Pi 进程存活与重认领** | 否 | 否（仅同进程 `/reload`） | 否（退出 Pi 终止会话） | 否（README：无重启恢复） | **是（`scope: "workspace"`，两种绑定）** |
| **就绪标记** | 否 | 否 | 部分（文件监视） | 否（README：服务启动不是就绪） | **是（`$PI_ASYNC_SHELL_EXEC_DIR/ready`）** |
| **平台** | POSIX | POSIX | Node.js（PTY 经 `zigpty`） | macOS、Linux | **仅 Linux** |
| **作用域纯粹性（无子 Agent／多 LLM 工作流）** | 是 | **否**（捆绑 `bg_delegate`、`bg_run_pi_attested`、`fusion_*`） | 否（捆绑 Agent spawn） | 是 | **是（严格限于 shell 执行与终端句柄）** |

### 7.2 `pi-async-shell` 为什么存在（可辩护的价值主张）

`pi-async-shell` 是一个独立、范围锐利的扩展。它不是 `pi-background-tasks` 的克隆，不是 TUI 覆盖层，也不是终端多路复用器的薄包装。它建立在 Pi 生态中没有任何现有工具能同时提供的三条核心保证上：

1. **全谱非阻塞协调（`start` + `await` + `completion`）：**
   设计既不强制阻塞在慢命令上，也不在因果屏障处强制轮次边界。在 `codemode` 中，Agent 可以用 `shell_start` 扇出三条命令，并在它们运行时编辑文件。然后用 `shell_await({ ids: [...], mode: "all" })` 同步，或用 `shell_await({ ids: srv.id, until: {kind: "pattern", regex: "Listening on"} })` 等待服务器就绪行，全部在同一轮内完成。另一种做法是结束轮次。空闲时由完成事件唤醒它。
2. **两个正交选择，而不是一个捆绑原语：**
   所有权（`scope`）决定 Agent 何时停止等待、进程何时被回收。I/O 绑定决定 `isatty()` 与 stdin 可写性。两者独立。持久化不需要多路复用器，只要数据路径由脱离的持有者拥有，而不是由所有者进程拥有。PTY 也不需要多路复用器，因为 `/usr/bin/script` 就提供一个。它不需要 broker 就能活过 Pi，因为持有 PTY master 的进程可以脱离。每个作用域与每个绑定都能组合，两种绑定都能无需重启地提升。
3. **非破坏、可查询的输出持久化：**
   每次执行都写持久磁盘日志（`stdout`、`stderr` 与有序 `combined`）。日志变大时，进程继续运行。检索是外科式的：`tail`、`head`、行／字节 `offset`、`grep` 正则过滤，以及 `pty` 执行重放出的 `viewport` 快照。只有决定下一步的切片进入 LLM 上下文。

---

## 8. 基准证据

`bench/REPORT.md` 由 `node bench/run-bench.ts` 生成。脚本把每个实现单独加载进真实 Pi SDK 会话，并直接调用注册工具。模型延迟排除在外，模型会走的代码路径保留在内。场内有 Pi 内置 `bash`、`pi-async-shell` 与八个包：`pi-background-tasks@2.6.10`、`pi-better-background-tasks@0.18.0`、`pi-background@0.4.4`、`pi-patty-bg-tasks@1.1.6`、`pi-async@0.4.4`、`@tduyng/pi-shell@0.0.6`、`pi-shell-jobs@0.1.2` 与 `pi-exec-command@0.3.10`。

`pi-interactive-shell@0.18.0` 与 `pi-processes@0.4.3` 在该场之外。§5 依据发布物描述它们，`bench/REPORT.md` 中没有任何数字属于它们。

基准把 `SHELL` 与 `PI_ASYNC_SHELL` 固定为 `/bin/sh`，使每个实现运行相同的命令语言。`PI_ASYNC_SHELL` 未设置时，运行时默认仍是 `/bin/bash`。

报告分别回答两个问题。第一个是用户得到什么。它覆盖下一轮可用的 dev server。它还覆盖 4000 行爆发后仍能应答的提示，以及一条 2.5 秒命令的成本。接着是取消后不留残余、硬父进程退出后存活、Agent 被杀后恢复。第二个是哪种机制产生差异。机制是轮内屏障、30 MiB 日志不杀死，以及 20 万行日志中一行可达。三条命令并行与完成通知加入它们。当前运行的摘要见 `docs/implementation-notes.md` §5。报告本身是权威。
