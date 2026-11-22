---
kind: normative
applies_to: 0.2.1
tracks:
  - src/core/types.ts
  - src/extension.ts
---

# 01. 心智模型

## 1. 论点

一次执行卡住 Agent 只有一个原因。 **它的完成，是离开 Agent 当前所处作用域的前提。** 耗时不是原因。

四十分钟的 build 会卡住。所有者是会话的四十分钟 build 不会卡住。两种情况下耗时完全相同。

**推论。**“改成异步”的意思是“给它的完成换一个前提”。“挪到后台”只换掉所有者。换掉负责这次执行的所有者。换掉这个所有者可以退出的时机。

---

## 2. 为什么“后台任务”是错的抽象

这个说法把三个决定捆在一起。每个决定本来独立变化：

1. **所有权** —— 谁必须等待完成，等到哪个边界为止。
2. **I/O 绑定** —— 字节去哪里，以及是否涉及终端。
3. **持久性** —— 那个所有者退出时，进程会怎样。

捆在一起的说法会断言一些蕴含关系，却不把它们说出来。其中有些蕴含并不成立。本项目自己的早期草稿里出现过两条。本文一并纠正：

- **错误：**跨进程持久化需要终端多路复用器。
  **实际：**持久化需要两件事。执行不持有 Pi 名下的文件描述符。执行活在不是 Pi 的会话里。脱离的监督器把日志写进文件，就能同时做到，完全不需要 broker。本机已验证存在：`/usr/bin/setsid`、`/usr/bin/nohup`。
- **错误：**PTY 语义需要终端多路复用器。
  **实际：**PTY 是内核对象。`/usr/bin/script` 就能围绕一条命令分配一个，不涉及任何外部进程（`script -q -f -e -c CMD LOG`）。本机已验证存在。`node-pty` 不在 Pi 的依赖树里，也不需要它。

终端多路复用器买到的能力要窄得多、也具体得多。

**一个长寿命的 broker 持有 PTY master，从而第三方可以稍后附着到同一个终端。**

本项目不卖第三方附着面。它卖的是 master 活在脱离的 `script(1)` 进程里的 PTY。这足以让执行活过 Pi。这不足以让人类接管终端。这个取舍是有意的。见 R3。

---

## 3. 维度 A —— 监督作用域

**作用域是那个负责保证清理、并且在执行仍在运行时不允许退出的所有者。**

| 作用域 | 所有者 | 运行时可否退出 | 所有者退出时 | 完成通知 | 可提升到 |
|---|---|---|---|---|---|
| `session` | Pi 会话 | 可以 —— 轮次自由结束 | `session_shutdown` 时取消（同进程 `/reload` 存活） | `<async-shell-completion>` 后续消息，合并投递 | `workspace` |
| `workspace` | 磁盘上的工作区 | 可以 —— 连 Pi 退出也不管 | 保留运行，由后续 Pi 进程重认领 | 默认无，下次 `session_start` 时呈现 | —— |

`session` 是默认值，也正是 `shell_start` 不阻塞的原因。`workspace` 是唯一活过 Pi 的作用域，可以在启动时选择，也可以通过 `shell_promote` 到达。

### 推导规则 R1 —— 作用域决定谁能回收进程，等待决定谁能继续

如果所有者在执行运行时不能退出，当前这一轮就无法越过它继续。选择 `session` 而不是同步调用，才能让轮次结束。选择 `workspace` 还让 Pi 可以退出。

R1 最初写成“阻塞是作用域的后果”。那句话只在等待与持有消耗同一份资源时成立。它们是两个问题，修正后的规则把两个都讲清楚：

> **作用域决定谁能回收进程。等待决定谁能继续。结束这一轮，是让这两个答案可以不同的机制。**

`session` 作用域意味着对话可以结束，而会话仍然欠这次执行一次清理。`workspace` 作用域意味着连会话退出都不能结束这笔债。`shell_await` 只是为一次工具调用收窄等待。两者都不改变。

这也消解了早期草稿当作独立维度处理的“协调轴”。实际对应关系是：

- 内置 `bash` 阻塞调用，也没有句柄。
- `shell_start` 默认 `session`，这正是它非阻塞的原因。
- `shell_promote` 把运行中的执行提升到 `workspace`。这就是人们口中的“放到后台”，只是叫法诚实些。

### 这套模型排除的反模式

无监督并发是 `go func()`、`GlobalScope.launch()` 和 `tokio::spawn()` 的已知失效模式。这项工作没有所有者。没有任何东西取消它。也没有人观察它的失败。本模型在结构上禁止这种写法。每个句柄恰好一个作用域。升级是一个显式动词（`shell_promote`）。收窄是临时的，只持续一次工具调用（`shell_await`），且永不改变所有权。

---

## 4. 维度 B —— I/O 绑定与终端可达性

| 绑定 | stdio | `isatty()` | Agent 可写 stdin | 第三方可附着 | PTY master 在谁手里 |
|---|---|---|---|---|---|
| `pipe` | 由脱离监督器持有的 OS 管道，写入 `stdout.log`、`stderr.log`、`combined.log` | 否 | 否 | 否 | ——（没有 PTY） |
| `pty` | PTY 从端 | **是** | 是（`shell_send`，经 FIFO） | 否 | 脱离的 `script(1)` 进程 |

### 推导规则 R2 —— `workspace` + `pty` 可行

R2 最初读到的是：“`workspace` + `pty` 不可行；PTY master 无法活过 Pi。”这个说法是错的。PTY 是内核对象，master 活在持有它的那个进程里。把它交给一个不是 Pi 的进程——脱离的 `script(1)`——PTY 就与绑了文件的管道一样活过 Pi。真正的限制是当时缺少 spawn 配方，而不是 PTY 的性质。

配方有三部分：

1. `script(1)` 把录制直接写进日志文件，所以数据路径上没有 Pi 的文件描述符。
2. 子进程的 stdin 是一个由包装器以读写方式保持打开的 FIFO。没有写者附上时，子进程看不到 EOF。后来的 Pi 进程仍能接上一个。
3. 包装器以脱离方式启动，自成会话，Pi 退出不会给它发任何信号。

同一套配方服务两个作用域。区别只在于所有者监视。`session` 执行会拿到一根来自 Pi 的管道，那根管道的 EOF 就拆掉 PTY。`workspace` 执行不拿所有者管道，所以它存活并被重认领。

### 推导规则 R3 与 R4

- **R3.** 绑定把终端访问给 Agent，把第三方排除在外。终端交互就是 `pty` 加 `shell_send`（输入）与 `shell_read(stream: "ptyView")`（渲染后的屏幕）。`ptyView` 重放录制而不是镜像活终端。因此重放永远不能改变监督、所有权、缓冲或退出语义。想要终端本身的人，用自己的多路复用器跑那条命令。本扩展不充当那个多路复用器。
- **R4.** `pipe` 必须让数据路径离开所有者进程。子进程的 stdout 与 stderr 由脱离的监督器持有，监督器写出日志文件。由 Pi 持有的管道才是失效模式。`pi-background-tasks` 无法活过 Pi 强退。子进程写进一个读端随 Node 一起消失的管道。下一次写入就收到 `EPIPE`／`SIGPIPE`。本项目把 R4 应用于每一次管道执行，而不只是 `workspace`。监督器是脱离且绑定到文件的，所以 `session` 管道之后可以无需重启地提升。

---

## 5. 空间：两作用域 × 两绑定

| 作用域 \ 绑定 | `pipe` | `pty` |
|---|---|---|
| **`session`** | **伴随进程。** mock server、索引器、watcher，必须活过这一轮但不该活过 Pi。无需重启即可提升到 `workspace`。 | **Agent 驱动的 TUI。** Agent 经 FIFO 交互；随 Pi 结束。无需重启即可提升到 `workspace`。 |
| **`workspace`** | **放养批处理。** 六小时 build、训练、迁移。文件日志；活过 Pi 退出；下次启动重认领。 | **常驻终端。** 活过 Pi 退出；下次启动被重认领；Agent 仍能通过 FIFO 往里打字。 |

四格全部可达，没有强制改绑，也没有 broker。`turn` 存在时空间是 3 × 2。0.2.0 删掉了那一行。需要在一轮之内建立因果屏障的调用者使用 `shell_await`，而不是更窄的所有者。

**交互这一半的矩阵是被有意缩小的。**

早先的草稿有第三种绑定 `pane`（由 Zellij 支撑）和第八个工具 `shell_attach`（把面板呈现给人类）。两者都已删除。`pane` 绑定移除。没有第三方附着面。终端交互只限 `pty` + `shell_send` + `ptyView` 重放。附着是多路复用器唯一买来的能力。它买来这个能力的代价，是让扩展为一个人类可能正坐着的终端负责。附着是呈现问题，而呈现不属于监督模型。

---

## 6. 横切契约

这些契约与两个维度都正交。每次执行都要同时满足全部十条。

### C1. 生命周期状态：就绪与存活分离

`starting -> running -> {completed | failed | cancelled | timed-out | lost}`，外加一个**可选**的 `ready` 里程碑，记为时间戳而不是状态。就绪与存活是两个不同的问题。进程可以在运行但尚未就绪。它也可以就绪之后才失败。Kubernetes 正是为此把它拆成三种探针。

`lost` 专属于 `workspace` 作用域：一个被重认领的执行，在 Pi 重启后无法证明其存活。

### C2. 就绪是等待条件，不是 spawn 选项

扫描 stdout 找 `Listening on` 是脆弱形式。稳健形式是带外信号：标记文件 `$PI_ASYNC_SHELL_EXEC_DIR/ready`，每条命令都能在自己的健康检查成功后创建它。对标 systemd `Type=notify` 单元的 `sd_notify(READY=1)`。`shell_start` 没有就绪参数。标记与输出模式都是 `shell_await` 的条件：`until: {kind: "ready"}` 与 `until: {kind: "pattern", regex, stream, since}`。正则仍然保留，因为大多数第三方程序永远不会发出标记。

### C3. 完成是事件，从不是轮询

只有在没有事件源时，轮询才算可辩护。这里有事件源。终态产生持久完成记录。通知启用时，后续消息唤醒空闲的 Pi 会话。`shell_status` 供刻意查看，其提示准则要求等待事件，而不是循环轮询。

### C4. 取消是阶梯，由进程树拥有

优雅信号、宽限期、强制杀、然后验证树确实消失。取消*等待*与取消*工作*是两个不同操作。Node 在消费者的 `AbortSignal` 与被中止的操作之间画的就是这条线。Go 在消费者 context 与生产者 context 之间画的也是。

### C5. 输出持久，并且排空永不停

日志上限绝不杀死进程。它也绝不停止排空管道。Linux 管道默认只缓冲 64 KiB，超过后子进程阻塞在 `write(2)`。一个靠暂停读取实现的上限，把日志策略变成了挂起。每一次 `pipe` 执行的输出都通过脱离监督器绑定到文件，监督器继续排空，只丢弃超出上限的字节。`pty` 录制由 `script(1)` 直接写盘。它没有可暂停的管道，也没有上限。文件一直长到运维手段或文件系统叫停为止。

### C6. 身份稳定且抗 PID 复用

每次执行都有一个 ID、一条持久元数据记录，以及足以稍后证明存活的身份。裸 PID 不够。崩溃之后身份是 `(boot_id, pid, 来自 /proc/<pid>/stat 第 22 字段的进程启动时间)`。PID 复用是持久化真正的难点，而它与绑定无关。这进一步说明持久性需要自己的词汇，而不是挂在某个载体名下。

### C7. 终端交互只属于 Agent，且从不承重

没有人类附着面。Agent 通过 `shell_send`（输入）与 `shell_read(stream: "ptyView")`（渲染后的屏幕）接触终端。两者都不改变作用域、所有权、缓冲或退出语义。重放是对录制的观察，所以读屏幕永远不可能改变程序看到的东西。

### C8. 可重放性是声明的，不是猜的

每个会改变状态的工具都要声明：崩溃后重跑它，是否与只跑一次不可区分。`shell_read` 与 `shell_status` 安全。`shell_start` 与 `shell_send` 不安全，因为第二次 build 就是第二次 build，第二次应答就是第二次击键。被中断的不安全调用给出诚实的 `unknown` 结果，绝不静默重复。宿主提供重放策略时，那就是声明。不提供时，显式的 request id 通过“不覆盖发布”提供同等保护。

### C9. `shell_await` 是短形式，结束这一轮是长形式

`pi-coding-agent` 里的工具调用无法挂起，所以 `shell_await` 会一直阻塞到它等完。这使得它只在“等待短到跨一次轮次边界更不划算”时才正确。`waitMs` 默认 30000，上限 50000，为 codemode 默认 60 秒脚本预算留出空间。以分钟计的等待靠结束这一轮完成。对话零成本挂起。完成事件把它接回来。磁盘上的句柄注册表就是检查点。把这条写成规则才是重点。以分钟计的等待不属于 `shell_await`。它属于长形式。

### C10. 一个工作区一个写者，其余只读

同一目录下，恰好一个进程可以认领 `workspace` 句柄。其他进程以只读方式打开注册表，可以读取状态与日志。`shell_promote`、`shell_send` 与 `shell_cancel` 会直接拒绝，而不是与所有者竞争。认领需要拿到写锁。拿不到写锁的进程绝不会意外成为所有者。

---

## 7. 每条决定的先例

| 决定 | 出处 |
|---|---|
| 完成门槛挂在**所有者**的退出上，而非命令的时长上 | 结构化并发：Smith 2018《Go statement considered harmful》；Trio nursery；Kotlin `coroutineScope`；Swift task group；Python 3.11 `asyncio.TaskGroup`；Java `StructuredTaskScope`（JEP 453，JDK 21 起预览） |
| 把执行升级到更宽的所有者必须显式且有监督 | 同一条脉络，它存在的首要目的就是消灭 `GlobalScope.launch()`／裸 `go func()` 造成的泄漏 |
| 取消是由进程树拥有的阶梯 | POSIX 作业控制：`setsid(2)`、进程组、`kill(-pgid)`、先 `SIGTERM` 后 `SIGKILL` |
| 把 stdio 绑定与控制终端分离 | POSIX 作业控制与 `daemon(7)`：新会话、stdio 离开控制终端、信号处置复位 |
| 只要持有者脱离且 stdio 绑到文件，PTY master 就能活过它的创建者 | `script(1)` 加 `setsid(2)`；`daemon(7)` 清单；以及 `dtach`、`abduco` 代表的更窄命题：PTY 可以交给后来的客户端 |
| 就绪是显式协议 | `sd_notify(READY=1)`、systemd `Type=notify` |
| 已启动／已就绪／仍存活是三个问题 | Kubernetes `startupProbe`／`readinessProbe`／`livenessProbe` |
| 不要轮询，等待事件 | `etcd` watch、Kubernetes watch、以及 Pi 自己的 `agent_settled` 边界 |
| 反压必须排空，否则子进程阻塞 | 管道容量语义；`SIGPIPE`／`EPIPE`；`fpathconf(_PC_PIPE_BUF)` |
| 用模式／应答驱动交互式程序 | `expect`、`pexpect`；其成熟形态是声明式的 expect 规格，而 `shell_await(until: pattern)` 加 `shell_send` 是手工版本 |
| 取消等待 ≠ 取消工作 | `AbortSignal` 与操作句柄之别；Go context 挂在消费者还是生产者；以及 Pi Durable 的原话：*“Cancelling a wait only cancels that wait, never the work.”* |
| 等待与所有权是两个问题 | Pi Durable 的 **park**：*“A tool that waits ... returns a park instead of a result ... The call then holds no process.”* 机制在这里不可用，但这个区分可用 |
| 可重放性按操作声明 | Pi Durable 的 `replay: "safe"`，否则以 `interrupted` 作为诚实的结局 |
| 一个写者，多个只读观察者 | Pi Durable 的存储所有权与 `readOnly: true` 会话；规则可迁移，实现是我们自己的锁 |
| 崩溃循环必须终止 | Pi Durable 的 `restartLimit`，以及更早的 systemd `StartLimitBurst`；这里是重认领尝试计数器 |
| 进程树是被发现的，不是被假设的 | `pi-durable-subagents`：`DSA_EXEC` 环境标签，配合 `(pid, start)` 身份与扫描—击杀循环 |

---

## 8. 相对上一稿改了什么

1. 早先的 2×2 已取消。它的纵轴把 PTY 语义与跨进程持久化捆在一起，由此得出了“持久化必须依赖某个载体进程”这条错误规则。持久化现在是 `scope: workspace`，对 `pipe` 绑定同样可用，而后者才是常见情况。
2. 横轴不再独立。所有权决定阻塞方式（R1）。“阻塞与非阻塞”现在是被推导的，不是被选择的。
3. PTY 与多路复用器已分离。`pty` 是用 `script(1)` 就能拿到的内核设施，在任何作用域都不需要 broker。
4. 就绪、期望式提示交互、`lost` 状态、抗 PID 复用的身份都已升为一等公民。先例表显示它们各自都是上一稿漏掉的常规实践。
5. **等待与所有权现在是两个问题**（C9、修正后的 R1），**一个工作区只有一个写者**（C10）。两条都来自阅读 `@earendil-works/pi-durable`，而它不是本项目支持的宿主。翻译成 `pi-coding-agent` 术语的过程见 `05-durability-and-containment.md`。
6. **词汇统一到一处**（`00-terminology.md`），文档重新编号为 `00` 至 `05`。`carrier` 已作为术语废弃，`03-carrier-and-runtime-architecture.md` 现名 `04-runtime-architecture.md`。改名记录见 `05-durability-and-containment.md` §8，旧链接因此有据可查。
7. **`pane` 绑定与 `shell_attach` 工具已删除，旧的 R2 主张已撤回。**
   只要持有 PTY master 的进程是脱离的、stdio 绑到文件，master 就能活过 Pi。所以 `workspace` + `pty` 不需要 broker。多路复用器唯一买来的能力是第三方附着，而附着已不在范围内（R3）。

### 8.1 0.2.0 的变化

- **删除 `turn` 作用域**，连同落定时的强制取消与错误续跑。轮次边界不再杀死 `session` 执行。需要在一轮之内建立屏障的调用者使用 `shell_await`。
- **删除 `shell_start.readiness`。**标记是 `$PI_ASYNC_SHELL_EXEC_DIR/ready`，模式是 `shell_await` 的条件。`immediate` 就绪随声明一起消失。
- **每次 `pipe` 执行的输出都通过脱离监督器绑定到文件**。因此 `session` 管道无需重启即可提升到 `workspace`。早先“管道不能提升”的规则是父进程持有管道的后果，不是模型的规则。
- **管道上限覆盖两个作用域**，并且排空而不杀死。早先“文件绑定的管道没有上限”描述的是旧的仅 `workspace` 文件绑定。现在监督器为两个作用域持有上限。`pty` 录制仍然不受上限约束。
- **删除 `cancelOnFirstFailure`**，随 `turn` 作用域一起消失。它取消的是已不存在的轮次组内的兄弟任务。
- **默认命令 shell 是 `/bin/bash`，否则 `/bin/sh`**，环境 `$SHELL` 被忽略。`PI_ASYNC_SHELL` 是显式覆盖。

---

## 9. 文档地图

- **[00. 术语表](00-terminology.md)** —— 每个承重术语的定义。它还点出各自防范的混淆，以及本项目已废弃的词。
- **[01. 心智模型](01-overview.md)** —— 两条轴与 2 × 2 空间。它还承载推导规则 R1 至 R4 与十条横切契约 C1 至 C10。
- **[02. 生态调研与项目价值](02-ecosystem-survey-and-value.md)** —— 关于 Pi 1.5.2 的已验证事实。它覆盖本机已安装的扩展与包，含 `pi-background-tasks@2.6.10`、`pi-interactive-shell@0.18.0`、`pi-processes@0.4.3`，以及诚实的比较。
- **[03. 执行模型与原语](03-execution-model-and-primitives.md)** —— 七个工具契约与选择流程。它还承载状态机与完成语义。
- **[04. 运行时架构](04-runtime-architecture.md)** —— 各绑定如何 spawn、遏制如何执行。它还覆盖输出如何保持持久、reload 与重认领如何工作，以及存储如何回收。
- **[05. Pi Durable 给了什么启发](05-durability-and-containment.md)** —— 它的机制构成的翻译表。它把这些机制映射到 `pi-coding-agent` 原语。它还记录它迫使 R1 做出的修正，以及借用在哪里停止。它点出两个第一方项目都没覆盖的进程遏制空白。
