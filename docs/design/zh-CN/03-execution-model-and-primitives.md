---
kind: normative
applies_to: 0.2.4
tracks:
  - src/core/types.ts
  - src/extension.ts
---

# 03. 执行模型与原语

## 1. 选择流程

按顺序回答三个问题。第一个决定作用域。第二个决定绑定。第三个只决定是否在同一轮内调用 `shell_await`。

1. **它必须活过 Pi 退出吗？** 是 -> `scope: "workspace"`（默认 `notifyOnCompletion: false`）。否 -> `scope: "session"`，即默认值。在单次宿主（`pi -p` 文本或 JSON）中，只需要活到完成唤醒的工作仍属于 `session`：落定边界会等待它。必须活过最终会话关闭的工作才回答“是”。
2. **程序会检测 `isatty()`、发出提示，或驱动 TUI 吗？** 否 -> `binding: "pipe"`。是 -> `binding: "pty"`。两个答案是穷尽的：终端交互属于 Agent，通过 `shell_send` 与 `ptyView` 完成（R3）。
3. **有可以先做的独立工作吗？** 有，就先启动执行，稍后再 `shell_await`。如果没有别的工作，结束轮次比等待更便宜：驻留会话会挂起直到完成，单次宿主则会在落定边界等待待唤醒执行。

两条守卫来自模型本身，而不是策略：

- 每个作用域与每个绑定都能组合。两种绑定都能从 `session` 提升到 `workspace`，无需重启，也没有日志切换（R2、R4）。
- 驻留会话的轮次边界让 `session` 执行继续运行。在单次宿主中，落定边界等待待唤醒执行，并把已就绪或不唤醒 Agent 的工作交给最终关闭回收。没有更窄的作用域，也没有落时错误。需要在一轮之内建立因果屏障时，调用者调用 `shell_await`。调用者保持同一个所有者。

当输出不需要活过本次调用时，预计一两秒内完成的命令应使用内置 `bash`。`shell_start` 会增加一个句柄、一个日志目录与一次工具往返。行内落定窗口（§3.1）消掉了第二次往返。句柄与日志目录仍然存在。两者在 `git status` 上都不划算。

---

## 2. 句柄身份与状态

每次执行都会得到一个形如 `sh_<8 位十六进制>` 的 ID 与一个持久目录。状态是：

```
starting -> running -> { completed | failed | cancelled | timed-out | lost }
                 |
                 +--> ready（里程碑时间戳，不是状态）
```

- 就绪标记出现时，`ready` 最多设置一次。它让终态保持不变，也让进程继续运行。
- `lost` 仅存在于 `scope: "workspace"`。后续 Pi 进程找到了元数据，但无法按 `01-overview.md` 的 C6 证明存活。身份是 `boot_id` + pid + 进程启动时间。
- 元数据记录封存后，终态不可变。所有等待者在那一刻解除等待。
- 终态记录会进入 GC 候选。落定不会删除它。默认保留 24 小时与 100 条终态记录（`04-runtime-architecture.md` §7）。

---

## 3. 契约

### 3.1 `shell_start`

它接纳一次执行并返回句柄。它只等成功接纳：进程已启动，元数据已写入。它唯一可能增加的等待有界且可关闭：`inlineSettleMs`。

```ts
interface ShellStartParams {
  command: string;
  /** 页脚状态与句柄列表用的 2-6 词标签。 */
  name?: string;
  cwd?: string;
  /** 显式值也会恢复被默认过滤器移除的敏感变量。 */
  env?: Record<string, string>;
  /** 本次执行的所有者。默认："session"。 */
  scope?: "session" | "workspace";
  /** stdio 拓扑。默认："pipe"。就绪／提示用途意味着 "pty"。 */
  binding?: "pipe" | "pty";
  /** 墙钟上限。经取消阶梯转入 timed-out。 */
  timeoutSeconds?: number;
  /** 没有 await 消费时投递完成事件。默认：session 为 true，workspace 为 false。 */
  notifyOnCompletion?: boolean;
  /** 该事件在 Pi 空闲时触发时，是否开启后续轮次。默认：true。 */
  triggerOnCompletion?: boolean;
  /** 完成如何到达运行中的 Agent。默认："steer"。 */
  delivery?: "steer" | "settle";
  /** 调用者提供的重放键。同一 request 的两次启动只产生一次执行。 */
  request?: string;
  /** 为立即落定而挂住本次调用。默认 1000；0 表示立刻返回句柄。 */
  inlineSettleMs?: number;
}

interface ShellHandle {
  id: string;
  name: string;
  command: string;
  cwd: string;
  scope: "session" | "workspace";
  binding: "pipe" | "pty";
  status: "starting" | "running" | "completed" | "failed" | "cancelled" | "timed-out" | "lost";
  pid?: number;
  pgid?: number;
  startedAt: number;
  readyAt?: number;
  endedAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  log: { dir: string; stdout: string; stderr: string; combined: string; ptyView?: string };
  bytes: { stdout: number; stderr: number; combined: number; capReached: boolean };
  error?: string;
  consumedByAwait?: boolean;
  notifyOnCompletion?: boolean;
  triggerOnCompletion?: boolean;
  delivery?: "steer" | "settle";
  timeoutSeconds?: number;
}
```

没有 `readiness` 参数。命令能证明自身健康时，它创建 `$PI_ASYNC_SHELL_EXEC_DIR/ready`。不能的命令通过 `shell_await` 上的输出模式观察。

**行内落定窗口。** 在接纳所需的时间里就结束的命令只花一次工具调用，而不是两次。因此 `shell_start` 会为自己的结果最多挂住 `inlineSettleMs`（默认 1000ms），同时等待该执行落定。执行落定时，这次调用返回终态句柄与其输出尾部。工具结果本身就是投递，所以落定只到达一次。执行没有落定时，这次调用按原样返回句柄，并释放认领。稍后才落定的命令仍会通过完成通道（§4）到达 Agent。`structuredContent.settledInline` 说明程序收到的是哪一种。

该窗口是便利，不是持久性保证。到期不取消任何东西，也没有任何执行因为某次启动调用不再等待而改变状态。实测从接纳到落定的延迟约为 `pipe` 50ms、`pty` 260ms。默认值覆盖了它该覆盖的范围。

### 3.1a 结果通道

按宿主约定，每个工具返回三个通道。`content` 服务于模型，它有界且人类可读。`structuredContent` 服务于 `codemode` 脚本之类的程序。它有类型，并按 `outputSchema` 校验。`details` 服务于 UI。`structuredContent` 从不进入会话记录。模型读取有类型的值，而不是原始结构化值。

### 3.2 `shell_await`

它把一次或多次执行收窄进当前工具调用。**它保持所有权不变，超时不杀死任何东西。** 这是 `errgroup.Wait`／`TaskGroup`／`StructuredTaskScope` 那一面。

这次调用会一直阻塞到它等完，因为 `pi-coding-agent` 里的工具调用无法挂起。因此它是**短形式**。等待长到跨一次轮次边界更便宜时，结束轮次。让完成事件把对话接回来（`01-overview.md` C9）。

```ts
interface ShellAwaitParams {
  ids: string | string[];
  /** all = 每个句柄都满足条件；any = 第一个满足即返回。默认：all。 */
  mode?: "all" | "any";
  /** 等待条件。默认：{ kind: "exit" }。 */
  until?:
    | { kind: "exit" }
    | { kind: "ready" }
    | {
        kind: "pattern";
        regex: string;
        stream?: "combined" | "stdout" | "stderr" | "ptyView";
        since?: number | "now";
      };
  /** 本次调用阻塞时间的上限。默认 30000，最大 50000。过期不终止任何东西。 */
  waitMs?: number;
  /** 每个句柄附带一段有界尾部预览。默认：true。 */
  includeOutputPreview?: boolean;
}

interface ShellAwaitResult {
  settled: boolean;              // 所有请求的句柄都到达终态
  timedOutWaiting: boolean;      // 等待因截止或中断结束，而不是因满足条件
  matched?: { id: string; line: string; byteOffset: number };
  outcomes: ShellHandle[];       // 等待返回时已处于终态的句柄
  stillRunning: ShellHandle[];   // 当时未终态的句柄，包括被模式匹配到的活动句柄
}
```

三种条件：

- 执行到达终态时，`exit` 满足。
- `$PI_ASYNC_SHELL_EXEC_DIR/ready` 存在时，`ready` 满足。执行未创建标记就落定时，该条件同样满足。在就绪前退出的命令会结束等待。
- 声明流上匹配正则的一行满足 `pattern`。未换行的最后一行同样满足。`since: "now"` 在等待前记录当前流末尾偏移。因此 `expect` 循环中的重复 await 不会再次匹配已应答的提示。匹配会报告该行及其字节偏移。因执行落定而结束的等待不报告匹配。

`mode: "any"` 在任一 handle 满足条件时立即返回。`mode: "all"` 等待每个 handle。调用者 await 期间落定的 handle 会被标记 `consumedByAwait`。没有完成消息重复它。

模式等待中，`stream: "ptyView"` 读取终端录制的字节。对 `pty` 执行来说，这与 `combined` 是同一个文件。`pipe` 回退到 `combined`。渲染后的屏幕是 `shell_read` 的视图，不是等待流。

### 3.3 `shell_read`

有界检索。每次调用的硬上限是 2000 行或 50 KiB，先到者为准。`mode: "all"` 是一次 head 读取的有界别名。它来自真实会话中 agent 的假设，因此用满一次读取预算作答，并附注给出 `nextLine` 与 `nextByte`；超出部分用 `mode: "offset"` 翻页。

`ptyView` 读取是例外。它返回的是视口行，不是文件行，因此不给出下一页：`nextByte` 与 `nextLine` 缺席，附注说明视口不可翻页。回放只覆盖录制的尾部，所以窗口化回放会报告 `truncated`，附注指出窗口范围。窗口内没有换行时，回放改以回车对齐。两者都没有时，附注说明视口无法重建，并指向 `combined`。

```ts
interface ShellReadParams {
  id: string;
  /** ptyView 是渲染后的终端屏幕，仅 pty 绑定；不能替代字节日志。 */
  stream?: "combined" | "stdout" | "stderr" | "ptyView";
  mode?: "tail" | "head" | "offset" | "grep" | "all";
  lines?: number;      // 默认 200，最大 2000
  maxBytes?: number;   // 默认 16384，最大 51200
  lineOffset?: number; // 1 起，mode=offset
  byteOffset?: number; // 0 起，mode=offset
  pattern?: string;    // 正则，mode=grep
  context?: number;    // 默认 2，最大 20，mode=grep
  stripAnsi?: boolean; // 默认 true
}

interface ShellReadResult {
  id: string;
  status: ShellHandle["status"];
  stream: "combined" | "stdout" | "stderr" | "ptyView";
  text: string;
  truncated: boolean;
  totalLines: number;
  totalBytes: number;
  range: { startLine?: number; endLine?: number; startByte?: number; endByte?: number; nextLine?: number; nextByte?: number };
  fullLogPath: string;
  note?: string;
}
```

`pipe` 执行有独立的 `stdout.log`、`stderr.log` 与 `combined.log`。如果 `workspace` 的 `pipe` 执行所请求的 `stdout` 或 `stderr` 文件为空，`shell_read` 会返回 `combined` 并附注。监督器仍为两个作用域写出独立文件。`pty` 执行把两个流合并进一份录制。`stdout.log` 与 `ptyView.log` 是指向 `combined.log` 的链接，因此读取 `stderr` 会报告它已合并。`pipe` 句柄上的 `ptyView` 回退到 `combined` 并附注。

### 3.4 `shell_promote`

它把运行中的 `session` 执行移到 `workspace` 所有权。这就是人们口中的“放到后台”，只是叫法诚实些。

```ts
interface ShellPromoteParams {
  id: string;
  /** `"workspace"` 是唯一的方向，省略 `to` 也表示它。 */
  to?: "workspace";
  /** 设置提升后记录的 notifyOnCompletion。省略：保持当前值。 */
  adopterNotification?: boolean;
}
```

提升是单向的，运行时把它记录在持久元数据中。已落定的执行不再可提升。`to: "workspace"` 是这次移动，省略 `to` 的调用执行同一次移动。设计不提供降级，因为事后收窄所有权需要重建模型要维护的不变量。`to: "session"` 曾经对已经是 `session` 的执行被当作无操作接受；它命名了一个提升从未有过的方向，现已退役。schema 只提供 `"workspace"`，仍请求 `"session"` 的调用方会得到原因，而不是静默成功（[ADR 0006](../../adr/0006-retire-session-promotion.md)）。要停止已提升的执行，使用 `shell_cancel`。

提升对两种绑定都无损。执行保留同一个进程、同一批日志文件与同一个 pid。运行时释放 fd 3 所有者监视，写入工作区链接，并在元数据中持久化 `scope: "workspace"`。运行时不重启任何东西。转换时不会丢字节。

### 3.5 `shell_cancel`

```ts
interface ShellCancelParams {
  ids: string | string[];
  /** graceful：向进程组发 SIGTERM，或向 PTY 写入 ^C，然后等待 graceMs。force：直接 SIGKILL。 */
  ladder?: "graceful" | "force";
  graceMs?: number;  // 默认 3000
}
```

它只在树缺席被*验证*之后才返回，而不是仅仅发过信号。验证失败会以 `failed` 加后代泄漏诊断呈现。取消本进程不拥有的执行会返回 `verifiedGone: true` 并附注没有可取消的东西。陌生进程收不到任何信号。

### 3.6 `shell_send`

它向 `pty` 执行的 stdin FIFO 写入。它在 `pipe` 上拒绝，执行落定后也拒绝。写入不要求调用进程拥有执行。因此从重启后认领句柄的 Pi 里也能工作。

```ts
interface ShellSendParams {
  id: string;
  text?: string;
  keys?: string[];            // 例如 ["Enter"]、["Down", "Enter"]、["Ctrl c"]
  /** 等这么久让屏幕变化，然后返回屏幕。默认 500ms，最大 10000ms。 */
  settleMs?: number;
  /** 调用者提供的重放键。同一 request 的第二次发送不发送任何东西。 */
  request?: string;
}
```

`wrote: false` 意味着字节没有到达子进程。要么 FIFO 还没有读者，要么该 request id 已经发送过一次。返回的 `screen` 是 `settleMs` 之后的 `ptyView` 渲染结果。它是便利，不是契约。

`shell_send` 加 `shell_await(until: {kind: "pattern", since: "now"})` 是 `expect` 循环的手工形式。成熟形态是一串 `(pattern, response)` 步骤。0.2.0 不提供它，原因有二。它严格增加工具面，而可达行为相同。声明式规格里的错误模式会静默失败。await 里的错误模式会产生 Agent 看得见的超时。

### 3.7 `shell_status`

对一个句柄或所有句柄做时点检查。它的提示准则禁止循环轮询。同步靠 `shell_await`。空闲等待靠结束轮次。结果报告 `running`、`ready`，以及本进程是否持有工作区写锁。

---

## 4. 完成语义

以下事实决定是否投递完成事件：

| 事实 | 效果 |
|---|---|
| 对该句柄的 `shell_await` 返回了它的终态 | `consumedByAwait = true`；不投递后续事件 |
| 落定发生在某次 `shell_start` 的行内窗口内 | 启动结果携带它；不投递后续事件 |
| `notifyOnCompletion` 为真且没有 await 消费它 | 入队一条完成记录 |
| Agent 正忙，`delivery: "steer"`（默认） | 记录被合并，在下一次 LLM 调用之前 steer 投递 |
| Agent 正忙，`delivery: "settle"` | 记录被合并，在 `agent_before_settle` 时一次投递 |
| Agent 在驻留会话中空闲 | 150 ms 合并窗口后投递一条后续消息；`triggerOnCompletion` 决定是否开启轮次 |
| 单次宿主到达 `agent_before_settle` | 仍存活、未就绪且同时启用通知与触发的 `session` 工作拖住边界，直到退出或就绪；已落定记录连同 `continue: true` 注入 |
| 所有者是 `session` 且最终 `session_shutdown` 触发 | 所有剩余执行都经取消阶梯回收，包括已就绪与不唤醒 Agent 的工作 |
| 所有者是 `workspace` 且 Pi 先退出 | 记录持久化；通知启用时在下次 `session_start` 呈现 |

单次宿主的等待要求同时满足：`scope: "session"`、状态仍存活、没有 `readyAt`、`notifyOnCompletion !== false`、`triggerOnCompletion !== false`。内部等待只观察退出或就绪，不设置 `consumedByAwait`；正常完成通道仍负责投递。服务一旦就绪，即使继续运行也不再拖住边界。

合并很重要。一批十二条命令在一秒内完成，否则会产生十二次唤醒与十二次模型轮次，只为做一个决定。`workspace` 记录不会自行开启轮次。该作用域的 `notifyOnCompletion` 默认为 false，在 `session_start` 呈现的记录作为下一轮消息投递。

默认 steer。完成是下一个决定的信息，而不是整轮结束后的附注。`delivery: "settle"` 保留旧行为，供不允许被打断的计划使用。记录被暂存，在 `agent_before_settle` 时连同 `continue: true` 注入，使这一轮为它继续存活。第二种模式由本包的 settle 边界定义，而不是 Pi 的 `deliverAs: "followUp"`。follow-up 消息与 steer 消息在同一工具批次边界投递。它不是中途投递的退出开关。

---

## 5. 界面

- `/async-shell` —— 句柄列表，含 ID、名称、状态、退出码、时长、作用域、绑定、就绪、字节与日志上限。它通过 `ctx.ui.select` 提供 `read tail`／`cancel`。
- `/async-shell run <cmd>` —— 用户发起，`scope: session`、`notifyOnCompletion: true`、`triggerOnCompletion: false`。它会回报，但不触发模型轮次。
- `/async-shell cancel <id>` 与 `/async-shell read <id>` —— 不经菜单的直接操作。
- 页脚组件：`async-shell: 3 running, 1 ready`。没有运行中或启动中的句柄时清除。
