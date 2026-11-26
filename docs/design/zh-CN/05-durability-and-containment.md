---
kind: empirical
applies_to: 0.2.3
tracks:
  - src/core/containment.ts
  - src/core/identity.ts
  - src/core/workspace-lock.ts
---

# 05. Pi Durable 给了什么启发，以及如何翻译

本项目的目标宿主是 `@earendil-works/pi-coding-agent`。`@earendil-works/pi-durable` 是另一个第一方包（实验性，随 Pi 1.0 发布）。它服务的是可能没有终端、可能被驱逐、可能由多个真人同时驱动的 Agent 应用。本项目只支持目标宿主。阅读 Pi Durable 不是支持它的承诺。

Pi Durable 值得读。它是唯一一个必须严格而书面地回答本项目自身问题的 Pi 代码库。问题就是这一个：**等待工作与拥有工作之间有什么区别？** 它的若干答案可以迁移。其中一个修正了模型。

下文归于 Pi Durable 的内容都来自 `earendil-works/pi` 的 `packages/durable/README.md`。归于 `pi-durable-subagents` 的内容来自那个第三方包。当 Pi Durable 无话可说时，本文转而引用那个包。

---

## 1. 真正重要的主张

> A tool that waits for the outside world ... returns a park instead of a result ... The call then holds no process. Once woken, `execute()` runs again with the same arguments, `api.wake` saying why and `api.checkpoint` holding what it parked with.

Pi Durable 在类型系统里把**等待**与**工作**分开。等待中的调用不是运行中的调用，等待期间不花任何成本。它的 harness 拥有调度器。因此工具可以返回挂起状态。之后由 harness 恢复该状态。

`pi-coding-agent` 没有这样的调度器。工具调用要么运行到结束，要么被中断。没有第三种状态。因此这个机制无法照搬。本文早先的草稿得出“`shell_await` 在这里应该变成 park”的结论，那是错的。

**但 `pi-coding-agent` 已经有自己的 park。本项目一直在用它，只是没有命名。** 结束轮次以零成本挂起对话。完成后续消息就是恢复信号。`api.checkpoint` 就是磁盘上的句柄注册表。本项目从 `scope: session` 加完成事件中得到了 Pi Durable 从 parking 中得到的一切性质。例外是依赖“活过驱逐”的性质。终端里不会发生驱逐。

因此真正的修正更窄、也更有用，而不是“加上 park”：

**`shell_await` 阻塞是对的。它是*不可恢复*的形式。** 它服务的是短到不值得跨轮次边界的等待。更长的等待应结束轮次。这条规则决定“何时该调用 `shell_await`”。它此前缺失。0.2.0 的上限把规则具体化。`waitMs` 默认 30000，最大 50000。这个上限正好落在 codemode 默认 60 秒脚本预算内。

---

## 2. 翻译表

每一行是两个代码库共有的问题，用不同原语解决。右列说明本项目怎么做，而不是它应该照抄什么。

| Pi Durable 的方案 | 问题 | 这里 `pi-coding-agent` 如何解决 |
|---|---|---|
| park：`{ sleep: { signals } }`／`{ wait: { on, policy } }` | 工具调用不能为几分钟而钉住一个进程 | 结束轮次；`<async-shell-completion>` 恢复。`scope: session` 已经是这个 |
| `replay: "safe"` 声明；否则 `interrupted` | 崩溃不能静默重复效果 | C8：`shell_start`／`shell_send` 上的 `request` id、不覆盖发布、诚实的 `unknown` |
| 外部调用前的 `api.memo(key, value)` | 幂等键必须在效果*之前*持久 | 意图记录在 `spawn` 之前写入并 fsync |
| `readOnly: true`；每个存储一个写者 | 两个进程不能同时认领同一份工作 | C10：`.pi/async-shell` 上的写锁，由我们持有 |
| `settings.restartLimit`（默认 5） | 崩溃循环必须终止 | 每个句柄的重认领尝试计数器（5） |
| `output`／`structuredOutput`／`details` | 三个受众，三种形状 | `content`／`structuredContent`／`details`——平台自己的约定 |
| `{ background: true }` 任务边界 | 活过父进程的工作必须显式 | `scope: workspace` + `shell_promote`——已经是模型 |
| `failFast`／`allSettled`／`any` | 扇入需要策略，不是默认值 | `shell_await` 上的 `mode: all\|any` |

八行。两行本来已经正确。一行（C8）是真正的补充。一行（C10）增加了本项目原本打算用协议仲裁的锁。

---

## 3. 对 R1 的修正

`01-overview.md` 最初把 R1 写成“阻塞是作用域的后果”。这句话只在等待与持有消耗同一份资源时成立。Pi Durable 的 park 是反例。它说明即使机制不可用，措辞仍然重要。

修正后，用目标宿主自己的术语表述：

> **作用域决定谁能回收进程。等待决定谁能继续。只要会话保持打开，或单次宿主的落定边界正在等待一个待唤醒执行，结束这一轮就能让这两个答案不同。**

`session` 作用域意味着只要驻留会话保持打开，当前轮次就可以结束，同时会话仍然欠这次执行一次清理。在单次宿主（`pi -p` 文本或 JSON）中，`agent_before_settle` 等待仍存活、未就绪且同时启用通知与触发的 `session` 工作，直到它退出或就绪。已落定记录继续本次运行；已就绪与不唤醒 Agent 的工作不会拖住落定边界。最终 `session_shutdown` 回收所有剩余的 `session` 执行。`workspace` 作用域意味着连会话退出都不能结束这笔债。`shell_await` 为一次工具调用收窄*等待*。两者都不改变。

---

## 4. 借用到哪里停止

下面每一条在 Pi Durable 里合理，在这里是错的。列出来是为了让边界显式，而不是隐含。

| 不采用 | 为什么在那里对、在这里错 |
|---|---|
| 带 CRC 帧、密集序号与断尾修复的持久任务日志 | 它们的日志是多步 LLM 工作的记录系统，那些工作可能被重放与审计。`session` 作用域的 shell 命令需要一条原子元数据记录，不是日志。 |
| 拥有存储的独立调度器进程 | 它们的 harness 必须活过每个对话并活过驱逐。这里的扩展与 Agent 在同一个 Pi 进程里。守护进程会增加 IPC、生命周期与失效模式，为不需要它的作用域买持久性。 |
| 把 `readOnly: true` 当作会话模式 | 规则可迁移。实现在这里不存在，所以 C10 规定我们自己的锁。 |
| park、signal、checkpoint、`abandonOnRestart` | 这些是 harness 自己的词汇。没有调度器就采用这些词只是装饰。 |
| 模型池、休眠、评估器沙箱、按对话的环境 | 按构造就不在范围内。 |

---

## 5. 两个第一方项目都没解决的那件事

Pi Durable 的持久性是**记录**的持久性。它的执行抽象是环境（`exec()`、`openBinaryReader()`、`cleanup()`）。关于结束工作的全部文档化说法是：

> Abort the context to end one call. `cleanup()` is for shutting the environment down.

在其已发布 README 中搜索进程遏制相关词，只返回*任务*孤儿化，那是另一回事。没有进程组捕获，没有后代遍历，也没有围栏。同样没有“我们启动了某个东西然后失去了它”的状态。`pi-coding-agent` 自己的 `bash` 工具处于同样位置。它在中断时杀死进程树。它没有“活过调用的进程”这个概念。

这个空洞正是本项目的工作。唯一已发布的处理在 `pi-durable-subagents` 里。那个包向每次 spawn 注入 `DSA_EXEC=<execId>`。后代继承这个标签。终止时扫描 `/proc/*/environ` 找标签。它合并从每个已知 `(pid, start)` 身份经 `ppid` 到达的活动后代。它重复扫描与 `SIGKILL` 直到并集为空或到达截止时间。运行时在每次发信号前立即重读身份，所以复用的 pid 永远不会被杀。

它的接口文档把这一点变成必需的测试。这项要求正是它可信的原因：

> a child that runs `setsid sleep` and is then SIGKILLed is still fenced by its tag.

这个测试存在，是因为进程组可逃逸。`setsid(2)` 创建新会话与新进程组。之后再向 `-pgid` 发信号什么也触不到。那曾是本项目取消阶梯里的真实漏洞。一个通过 `nohup ... &` 启动服务器的执行，会报告干净的取消。服务器会继续运行。

采用的做法：进程组**与**标签，而不是二选一。进程组是廉价的优雅路径。它是在 `environ` 不可读时唯一可用的路径。标签是遏制保证。取消与超时在每个作用域都会触发围栏。所有者退出只对 `session` 触发围栏，因为 `workspace` 句柄没有所有者监视。这个机制让 `session` 无泄漏，又让 `workspace` 可被认领。

---

## 6. 诚实的局限

- **取消不是回滚。** 中途停止 `pnpm publish`、迁移或 `git push` 不会撤销已经运行的部分。进程被遏制。效果不是事务性的。
- **遏制有检测下限。** 进程可以清掉标签并在下次扫描前离开进程树。这样的进程不会被找到。扫描间隔就是边界，文档把它写出来而不是藏起来。
- **击杀列表不是死亡证明。** 它记录的是运行时标记与跟踪的东西。身份重读可能跳过一个已退出并被复用的 pid。这个方向偏安全。
- **`lost` 是真实结果。** `workspace` 句柄可能没有退出记录。当存活无法证明时，答案就是 `lost`，绝不是 `completed`。
- **`unknown` 是真实结果。** `shell_start` 或 `shell_send` 在意图记录之后被中断，效果仍然未知。诚实的答案是 `unknown`，绝不是静默重复。
- **终端视口不是日志。** 终端显示的内容包含覆盖与光标寻址。它不是字节流的证据。
- **上限是同一策略覆盖两种绑定。** `pipe` 执行在 `PI_ASYNC_SHELL_MAX_LOG_BYTES` 停止记录并继续排空管道。`pty` 录制在同一个上限停止增长，因为有界写者位于 `script(1)` 与文件之间并持续读取。两种情况都不会杀死进程；`util-linux` 自带、会杀死进程的 `--output-limit` 已被否决（ADR 0007）。
- **等待受宿主限制。** `shell_await` 不能超过 50000 ms。工具调用无法挂起。更长的等待靠结束轮次，而不是增大 `waitMs`。驻留会话挂起直到完成；单次宿主在 `agent_before_settle` 等待仍存活、未就绪且同时启用通知与触发的 `session` 执行，然后投递记录并继续运行。已就绪与不唤醒 Agent 的工作仍由最终关闭回收；必须活过该退出的工作属于 `workspace`。
- **运行时仅 Linux。** 进程身份、遏制与 PTY 配方依赖 procfs、进程组与 `script(1)`。非 Linux 平台以显式错误失败，而不是返回空进程树。

---

## 7. 值得注意的趋同

三个代码库，四条一致。独立得出同一条规则，是“`01-overview.md` 的模型并非任意”所能得到的最好证据。

| 规则 | Pi Durable | `pi-durable-subagents` | `pi-async-shell` |
|---|---|---|---|
| 取消等待不是取消工作 | *“Cancelling a wait only cancels that wait, never the work.”* | `stop` 是结束命令的唯一方式；中断等待者不会 | C4 |
| 活过所有者是显式边界 | `{ background: true }` | `run --wake caller` | `scope: workspace`／`shell_promote` |
| 扇入需要策略，不是默认值 | `allSettled`／`failFast`／`any` | `tasks` 并行，首个失败停止分支 | `mode: all\|any` |
| 进程身份是 `(pid, start)` | 不适用（没有进程层） | 一项必需测试 | C6 |

唯一的分歧很有启发性。Pi Durable 通过挂起任务让等待零成本。这里的等待花一次工具调用。这是宿主的性质，不是设计缺陷。它正是文档把 `shell_await` 称为短形式的原因。结束轮次是长形式。

---

## 8. 文档历史与改名

文档集重新编号，为 `00` 的术语表腾出位置。两个改名对旧链接有意义。

1. **`03-carrier-and-runtime-architecture.md` 现名 `04-runtime-architecture.md`。** `carrier` 一词已废弃。它命名了（作用域，绑定）这一融合对，并暗示持久化需要多路复用器。`00-terminology.md` §10 记录该废弃。所有指向旧文件名的链接都解析到新文件。
2. **本文原为 `04-durability-and-containment.md`。** 现在叫 `05-durability-and-containment.md`。内容保留主题与结构。

完整旧到新映射：

| 旧文件名 | 新文件名 |
|---|---|
| ——（新增） | `00-terminology.md` |
| `00-overview.md` | `01-overview.md` |
| `01-ecosystem-survey-and-value.md` | `02-ecosystem-survey-and-value.md` |
| `02-execution-model-and-primitives.md` | `03-execution-model-and-primitives.md` |
| `03-carrier-and-runtime-architecture.md` | `04-runtime-architecture.md` |
| `04-durability-and-containment.md` | `05-durability-and-containment.md` |

同一映射适用于 `docs/design/zh-CN/`，文件名相同。

### 8.1 0.2.0 删除的规则

早先的文档集中有三条规则描述的是已不存在的运行时。记录在此，使读到旧链接的人不会留下与代码矛盾的规则：

- **`turn` 作用域，以及执行它的落定时的强制杀死。** 轮次边界不再取消任何东西。`session` 是最窄的作用域，它活过轮次。
- **`shell_start.readiness` 与 `marker`／`pattern`／`immediate` 声明。** 就绪是等待条件。`$PI_ASYNC_SHELL_EXEC_DIR/ready` 的标记是一种形式。传给 `shell_await` 的模式是另一种。
- **“`pipe` 执行不能提升。”** 它只在 Pi 持有会话管道 stdio 时为真。现在每次管道执行都运行在带文件日志的脱离监督器之下。提升只是释放所有者监视，进程、pid 与文件都保持不变。
