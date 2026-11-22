---
kind: normative
applies_to: 0.2.1
tracks:
  - src/core/types.ts
  - src/extension.ts
---

# 00. 术语表

本文固定 `pi-async-shell` 在 0.2.0 的词汇。每个条目给出三项：定义、该术语防范的混淆，以及使用该术语的章节。

请按顺序阅读。第 2 节给出对象及其两条轴。第 3、4 节各自定义一条轴。第 5 至 9 节定义横切契约。第 10 节列出本项目已废弃的词。

---

## 1. 如何阅读本术语表

每个条目有三部分：

- **定义。** 该术语在本项目中唯一的意思。
- **不是。** 常被混淆的邻近含义。本部分也说明这种混淆为什么有代价。
- **用于。** 依赖该术语的章节。

三条规则适用于每个术语：

1. **一词一义。** 术语在每份文档中保持同一含义。需要不同含义的文档应新增术语。
2. **同义词是缺陷。** `owner` 与 `scope` 是不同的术语，`kill` 与 `reap` 也是不同的术语。当两个词看起来意思相同时，其中一个是错的。
3. **标识符就是代码。** `shell_await`、`scope: "workspace"`、`PI_ASYNC_SHELL_EXEC` 与 `consumedByAwait` 命名真实接口。它们在所有语言中保留拼写与反引号。

本文是规范性的。它不携带证据文档所用的那类 **[Fact]** / **[Inference]** / **[Recommendation]** 分类。定义是决定，不是发现。

---

## 2. 对象及其两条轴

### execution（执行）

**定义。** 由 `shell_start` 启动的一条命令，连同该命令创建的所有进程，以及两者的持久记录。

**不是** 一次工具调用。工具调用启动一次执行并返回一个句柄。执行在调用返回后继续。它可以活过轮次、会话乃至 Pi 本身。

**用于** `01-overview.md` §1。`03-execution-model-and-primitives.md` §1。

### execution handle（执行句柄）

**定义。** 命名一次执行的持久记录：它的 ID、作用域、绑定、状态、进程身份与日志路径。

**不是** 进程。句柄活过它的进程。`completed` 与 `lost` 都描述这样一种句柄：进程已消失，而结果已知或未知。

**用于** `03-execution-model-and-primitives.md` §2 与 §3。C1。

### handle id（句柄 ID）

**定义。** 形如 `sh_<8 位十六进制>` 的标识符，句柄在其记录的生命周期内一直携带它。运行时从不复用 ID。

**不是** pid。pid 属于内核并且会被复用。句柄 ID 属于本项目，从不被复用。

**用于** `03-execution-model-and-primitives.md` §2。

### supervision scope（监督作用域）

**定义。** 负责保证执行被清理的所有者。执行运行期间，该所有者不得退出。两个取值是 `session` 与 `workspace`。

**不是** I/O 绑定，也不是超时或优先级。早期设计用 `carrier` 一词把作用域与绑定捆在一起。这种捆绑产生了“持久化需要多路复用器”这条错误规则。把两条轴分开正是本节与第 4 节的意义。

**用于** `01-overview.md` §3、R1。`03-execution-model-and-primitives.md` §1。`04-runtime-architecture.md` §6。

### I/O binding（I/O 绑定）

**定义。** 一次执行的字节去哪里，以及是否涉及终端。两个取值是 `pipe` 与 `pty`。

**不是** 监督作用域。绑定决定 `isatty()` 与 stdin 可写性。它从不决定谁可以退出。绑定与作用域在每个格子里都能自由组合（R2）。

**用于** `01-overview.md` §4、R2 至 R4。下文第 4 节。

### the space（空间）

**定义。** 作用域对绑定的 2 × 2 网格。四个格子全部可达。

**不是** 为分类而分类。这个网格正是两条轴保持分开的理由。持久性是作用域的属性。`isatty()` 是绑定的属性。两者互不蕴含。`turn` 存在时空间是 3 × 2。0.2.0 删除 `turn` 去掉的是一行，而不是模型需要的某个格子。

**用于** `01-overview.md` §5。

---

## 3. 维度 A —— 监督作用域

### owner（所有者）

**定义。** 作用域命名的那个东西，它欠这次执行一次清理：Pi 会话，或磁盘上的工作区。

**不是** 启动子进程的进程。子进程总是由 Pi 启动。所有者是必须回收它的东西。这是两个不同的问题。

**用于** `01-overview.md` §3、R1。C10。

### reap（回收）

**定义。** 结束一次执行并记录其终态，使进程与记录都不再无人负责。

**不是** 杀死。回收可以发现在已经消失的进程并仍然成功。留下未封存记录的杀死不是回收。

**用于** `01-overview.md` R1。`05-durability-and-containment.md` §3。

### session（会话）

**定义。** 作用域取值，也是默认值。Pi 会话拥有这次执行。轮次可以自由结束。`session_shutdown` 回收执行。同进程的 `/reload` 转移所有权而不是回收。

**不是** “后台任务”。`session` 是默认作用域。它也是 `shell_start` 不阻塞的原因。

**用于** `01-overview.md` §3。`04-runtime-architecture.md` §6.1。

### workspace（工作区）

**定义。** 作用域取值。磁盘上的工作区拥有这次执行。Pi 可以退出，后续 Pi 进程会重认领该执行。

**不是** 一个目录路径。作用域命名的是所有者。所有者由工作区目录连同写锁共同标识。

**用于** `01-overview.md` §3。`04-runtime-architecture.md` §6.2。C10。

### promote（提升）

**定义。** 把运行中的 `session` 执行移到 `workspace` 所有权。提升是单向的，并记录在持久元数据中。提升对两种绑定都无损：同一个进程继续写同一批日志文件。

**不是** “放到后台”。放到后台命名的是用户观察到的效果。`promote` 命名的是产生该效果的所有权变更。设计不提供降级。事后收窄所有权会破坏模型要维护的不变量。

**用于** `01-overview.md` §3。`03-execution-model-and-primitives.md` §3.4。`04-runtime-architecture.md` §2.3。C10。

---

## 4. 维度 B —— I/O 绑定

### pipe（管道）

**定义。** 绑定。stdout 与 stderr 是由脱离的管道监督器持有的两根独立管道。监督器写出 `stdout.log`、`stderr.log` 与按到达顺序的 `combined.log`。

**不是** 去掉了终端的 PTY。`pipe` 完全没有终端。`isatty()` 为假。`shell_send` 拒绝。第三方无法附着。

**用于** `01-overview.md` §4、R4。`04-runtime-architecture.md` §2.1。

### pty（伪终端绑定）

**定义。** 绑定。子进程获得一个 PTY 从端作为控制终端。PTY master 活在脱离的 `script(1)` 进程里，而不是 Pi 里。

**不是** 多路复用器。`script(1)` 提供 PTY，不需要外部 broker，也没有附着协议。

**用于** `01-overview.md` §4、R2。`04-runtime-architecture.md` §2.2。

### PTY

**定义。** 伪终端。由 master 端与 slave 端组成的内核对象，slave 端的行为类似终端设备。

**不是** 终端模拟器，也不是窗口。PTY 是内核状态。终端模拟器是读取 PTY 并绘制屏幕的程序。

**用于** `01-overview.md` §2 与 §4。`04-runtime-architecture.md` §2.2。

### PTY master

**定义。** 必须由某个进程持续读取、子进程才能前进的那一端。它的位置决定持久性。

**不是** socket，也不是名字。master 是文件描述符，文件描述符随持有它的进程死亡。这就是 `pty` 绑定把 master 放进脱离的 `script(1)` 进程、而不是 Pi 的原因（R2）。

**用于** `01-overview.md` R2。`04-runtime-architecture.md` §2.2。

### detached holder（脱离持有者）

**定义。** 自成会话、不继承 Pi 的任何文件描述符、为一次 `pty` 执行持有 PTY master 的进程。由脱离包装器启动的 `script(1)` 就是这样一个进程。

**不是** broker。它只服务一次执行，不提供客户端协议，所以没有东西能附着到它上面（R3）。

**用于** `01-overview.md` §2 与 R2。`04-runtime-architecture.md` §2.2。

### stdin FIFO（标准输入 FIFO）

**定义。** `pty` 执行读取 stdin 的命名管道。包装器以读写方式保持它打开。没有写者附着时，子进程也看不到 EOF。任何进程——包括后来的 Pi——都能以写方式打开它。

**不是** 控制通道。它承载终端会收到的字节。`shell_send` 是唯一的写者。没有读者时写入失败而不是阻塞。

**用于** `01-overview.md` R2。`04-runtime-architecture.md` §2.2 与 §5。

### viewport（视口）

**定义。** `pty` 执行渲染后的终端屏幕，通过 `shell_read({stream: "ptyView"})` 读取。

**不是** 日志。视口包含回车覆盖、光标寻址与合并的流，正如终端当时显示的那样。它不是产生它的字节流的证据（C5，`05-durability-and-containment.md` §6）。针对 `ptyView` 的模式等待匹配的是录制的字节，而不是这个渲染结果。渲染是 `shell_read` 的操作。

**用于** `03-execution-model-and-primitives.md` §3.3。`04-runtime-architecture.md` §2.2。

### pipe supervisor（管道监督器）

**定义。** 脱离的 Node 进程 `src/core/pipe-supervisor.mjs`，它持有 `pipe` 执行的 stdout 与 stderr 管道。它写出三个日志文件，在上限之后继续排空，并封存 `exit.json`。

**不是** broker 或守护进程。它只服务一次执行，活在自己的会话里。那次执行落定后，它退出。

**用于** `04-runtime-architecture.md` §2.1 与 §4。

### owner watch（所有者监视）

**定义。** `session` 执行的监督器或 PTY 包装器读取的 fd 3 管道。EOF 意味着拥有它的 Pi 进程死亡，执行必须被拆除。单独一行 `release` 意味着所有权已移到工作区，执行应继续运行。

**不是** 数据通道。它只承载一个控制决定。它存在是因为仅凭一个关闭的文件描述符，“所有者死了”与“所有者提升了我”无法区分。

**用于** `04-runtime-architecture.md` §2.1、§2.2 与 §2.3。

---

## 5. 生命周期、身份与完成（C1、C3、C6）

### settle（落定）

**定义。** 到达终态。执行落定。句柄记录它，所有等待者在那一刻解除等待。

**不是** 退出。`lost` 执行没有退出也会落定。`timed-out` 执行在阶梯之后落定，而不是在某个信号之后。

**用于** `03-execution-model-and-primitives.md` §3.2 与 §4。C1。

### terminal state（终态）

**定义。** `completed`、`failed`、`cancelled`、`timed-out` 或 `lost` 之一。元数据记录封存之后，终态不可变。

**不是** `ready`。就绪是里程碑，就绪的执行之后仍可能失败。

**用于** C1。`03-execution-model-and-primitives.md` §2。

### ready（就绪）

**定义。** 里程碑时间戳 `readyAt`。就绪标记出现时，运行时最多设置它一次。

**不是** 状态。进程可以在未就绪时运行，也可以就绪之后失败。Kubernetes 出于同样理由把它拆成三种探针（C1、C2）。

**用于** C1。`04-runtime-architecture.md` §5。

### lost（丢失）

**定义。** 终态，仅限 `workspace` 作用域。后续 Pi 进程找到了记录，但无法证明其存活。

**不是** `failed`，也不是 `cancelled`。关于退出什么都不知道，设计拒绝凭空编造。

**用于** C1。`04-runtime-architecture.md` §6.2。

### unknown（未知）

**定义。** 被中断的不安全调用在效果无法确定时给出的诚实结果。

**不是** 句柄状态。`unknown` 描述已知什么，而不是发生了什么。`unknown` 结果绝不会按假设变成 `completed`（C8）。

**用于** C8。`05-durability-and-containment.md` §6。

### completion event（完成事件）

**定义。** 执行已落定的持久记录。没有 await 消费它且通知已启用时，运行时把它作为消息投递。

**不是** 轮询结果。`shell_status` 读取状态，不产生事件。只有在没有事件源时轮询才可辩护，而这里有事件源（C3）。

**用于** C3。`03-execution-model-and-primitives.md` §4。

### coalescing（合并）

**定义。** 把多个完成事件合并成一次投递。忙的 Agent 在下一次 LLM 调用之前得到一次 steer。空闲的 Agent 经过一个很短的窗口后得到一次投递。

**不是** 丢弃事件。每条记录都会投递。合并的是消息条数，使同时完成的十二条命令只花一次模型轮次，而不是十二次。

**用于** C3。`03-execution-model-and-primitives.md` §4。

### delivery（投递时机）

**定义。** 完成事件如何到达仍在运行的 Agent：`steer` 在下一次 LLM 调用之前，或 `settle` 在 settle 边界。

**不是** Pi 的 `deliverAs` 取值。`settle` 是本包自己的边界。Pi 的 `followUp` 与 steer 消息在同一工具批次边界投递。

**用于** `03-execution-model-and-primitives.md` §4。`implementation-notes.md` §3.7。

### consumedByAwait（已被 await 消费）

**定义。** 标记：某个 `shell_await` 已经返回该句柄的终态，因此不需要后续事件。`shell_start` 的行内窗口算作一次 await。

**不是** 抑制记录。记录仍然持久。被抑制的只是唤醒，之后的 `shell_read` 仍能找到输出。

**用于** `03-execution-model-and-primitives.md` §4。`04-runtime-architecture.md` §7。

### inlineSettleMs（行内落定窗口）

**定义。** `shell_start` 为自己的结果最多挂住多久来等待落定。默认是 1000ms。取值 `0` 立刻返回句柄。

**不是** 等待条件。它只观察退出。就绪与输出模式仍然是 `shell_await` 的条件。到期不取消任何东西。

**用于** `03-execution-model-and-primitives.md` §3.1。

### process identity（进程身份）

**定义。** 三元组 `(boot_id, pid, start)`，其中 `start` 是 `/proc/<pid>/stat` 的第 22 字段。存活证明针对这个三元组。

**不是** pid。内核在重启后与回绕后都会复用 pid。认领一个陌生进程来报告它的退出码，比报告 `lost` 更糟（C6）。

**用于** C6。`04-runtime-architecture.md` §6.2。`05-durability-and-containment.md` §7。

### sealed metadata（封存元数据）

**定义。** 终态写入之后的 `meta.json` 记录，通过写临时文件再改名完成。

**不是** 可变状态字段。封存使终态不可变。原子改名使读者不会观察到写了一半的记录。

**用于** `03-execution-model-and-primitives.md` §2。`04-runtime-architecture.md` §6.2 与 §7。

---

## 6. 就绪与等待条件（C2）

### readiness marker（就绪标记）

**定义。** 文件 `$PI_ASYNC_SHELL_EXEC_DIR/ready`。每次执行的环境里都有 `PI_ASYNC_SHELL_EXEC_DIR`。命令在自己的健康检查成功后创建该标记。

**不是** spawn 选项。`shell_start` 没有就绪参数。标记是磁盘上的事实，由 `shell_await(until: {kind: "ready"})` 观察（C2）。

**用于** C2。`03-execution-model-and-primitives.md` §3.2。`04-runtime-architecture.md` §5。

### output pattern（输出模式）

**定义。** 针对声明流的正则表达式，从记录的偏移开始匹配新字节。`since: "now"` 选项使重复 await 不会再次匹配已应答的提示。

**不是** 稳健形式。模式是兜底形式，设计也这么说。它存在是因为大多数第三方程序永远不会发出标记。未换行的最后一行仍是输出，所以没有尾随换行的提示也能满足模式。

**用于** C2。`03-execution-model-and-primitives.md` §3.2。`04-runtime-architecture.md` §5。

### wait condition（等待条件）

**定义。** `exit`、`ready` 或 `pattern` 之一，作为 `until` 传给 `shell_await`。它决定调用者在等什么。它从不决定谁拥有执行。

**不是** 取消。过期的等待条件让执行继续运行（C4、C9）。

**用于** C2 与 C9。`03-execution-model-and-primitives.md` §3.2。

### `sd_notify(READY=1)`

**定义。** systemd 约定：服务向 socket 写入 `READY=1`，宣告自己可以服务。

**不是** 本项目可用的 API。本项目复制该约定的形状，而不是它的 API。标记文件是本地等价物。

**用于** C2。`01-overview.md` §7。

### `Type=notify`

**定义。** systemd 单元类型，在把服务视为已启动之前等待 `sd_notify`。

**不是** systemd 依赖。它是“把就绪当作协议而非猜测”的先例。

**用于** C2。`04-runtime-architecture.md` §5。

---

## 7. 取消、遏制与输出（C4、C5）

### cancellation ladder（取消阶梯）

**定义。** 优雅信号、宽限期、强制杀死，然后验证进程树已消失。

**不是** 单次杀死。杀死只投递信号。阶梯验证缺席。验证失败时，它以 `failed` 加后代泄漏诊断报告。

**用于** C4。`04-runtime-architecture.md` §3。

### containment（遏制）

**定义。** 取消之后，或 `session` 所有者退出之后，执行中的任何进程都不再运行的保证。

**不是** 取消。取消请求进程停止。遏制证明它已经停止。向进程组发信号是投递机制，不是遏制保证（C4，`05-durability-and-containment.md` §5）。

**用于** C4。`04-runtime-architecture.md` §3。`05-durability-and-containment.md` §5。

### fence（围栏）

**定义。** 执行遏制的扫描—击杀循环。它收集带标签的进程及其后代、每个已知身份的活动后代，以及每个自有进程组的活动成员。它向这些进程发信号，并重复直到集合为空或到达截止时间。

**不是** 向进程组发一次信号。进程组是可逃逸的。`setsid(2)` 把子进程放进新会话与新进程组，之后 `-pgid` 什么也触不到。

**用于** `04-runtime-architecture.md` §3。`05-durability-and-containment.md` §5。

### process tag（进程标签）

**定义。** 环境变量 `PI_ASYNC_SHELL_EXEC=<id>`，在 spawn 时注入，并被每个后代继承。

**不是** 身份。标签说“这个进程属于执行 X”。身份说“这与之前是同一个进程”。遏制两者都需要，设计两者都采用。

**用于** `04-runtime-architecture.md` §3。`05-durability-and-containment.md` §5。

### drain（排空）

**定义。** 继续读取管道并丢弃超过日志上限的字节，使子进程永远不会阻塞在 `write(2)`。

**不是** 停止读取。停止读取正是把日志策略变成挂起的方式。Linux 管道默认只缓冲 64 KiB，子进程在下一次写入时阻塞（C5）。

**用于** C5。`04-runtime-architecture.md` §4。

### backpressure（反压）

**定义。** 管道写满后，写者在读者腾出空间之前被阻塞的状态。

**不是** 停止排空的理由。反压正是“排空而不杀死”必要的机制。它也是惩罚“用暂停实现上限”的机制。

**用于** C5。`01-overview.md` §7。

### log cap（日志上限）

**定义。** `PI_ASYNC_SHELL_MAX_LOG_BYTES`，默认 100 MiB。管道监督器到达上限后，停止追加、继续排空管道，并写出 `log-cap.json`。

**不是** 进程策略。到达上限从不结束执行。这是与 `pi-background-tasks` 最大的行为差异，后者的 20 MiB 上限会杀死任务。上限覆盖两个作用域下的每一次 `pipe` 执行，因为每次管道执行都通过监督器绑定到文件。它不覆盖 `pty` 录制：`script(1)` 直接写那个文件，所以它会一直增长，直到运维手段或文件系统叫停。

**用于** C5。`04-runtime-architecture.md` §4。

### durable output（持久输出）

**定义。** 执行目录下的磁盘日志 `stdout.log`、`stderr.log`、`combined.log` 与 `ptyView.log`。

**不是** 模型上下文。通过 `shell_read` 进入上下文的是有界、按需的切片。完整日志留在磁盘上。

**用于** C5。`03-execution-model-and-primitives.md` §3.3。

### garbage collection（GC，垃圾回收）

**定义。** 启动时与每小时执行的清扫，从 `.pi/async-shell` 删除过期的终态记录、它们的日志、提升链接与孤儿请求记录。

**不是** 回收器。GC 从不触碰运行中、非终态、受保护或当前会话的记录。崩溃的所有者不能把活动的工作区进程变成垃圾。

**用于** `04-runtime-architecture.md` §7。`03-execution-model-and-primitives.md` §2。

---

## 8. 跨进程持久性（C6、C8、C10）

### adopt（认领）

**定义。** 在证明存活之后，从先前的 Pi 进程接管一次既有 `workspace` 执行。

**不是** 重启。认领继续同一个进程并追加到同一批日志。进程从不知道自己的所有者变了。

**用于** `04-runtime-architecture.md` §6.2。C10。

### re-adoption（重认领）

**定义。** `session_start` 时对工作区记录（包括被提升的会话记录）执行的认领扫描。它把每条记录分类为已终结、恢复为运行中，或 `lost`。

**不是** 恢复崩溃的 Pi 会话。会话已经没了。执行还在。扫描的存在就是为了判断这三种情况中的哪一种成立。

**用于** `04-runtime-architecture.md` §6.2。`01-overview.md` §3 与 §5。C10。

### writer lock（写锁）

**定义。** `.pi/async-shell/workspace/.lock` 上的排他锁，进程在认领 `workspace` 句柄之前必须持有它。

**不是** 协议约定。拿不到锁的进程绝不会意外成为所有者，它以只读方式打开注册表。

**用于** C10。`05-durability-and-containment.md` §2。

### one-writer（单写者）

**定义。** 同一目录下恰好一个进程认领 `workspace` 句柄的规则。其他进程可以读取状态与日志。

**不是** 单读者。允许多个读者。只有写者是排他的，`shell_promote`、`shell_send` 与 `shell_cancel` 会拒绝，而不是与所有者竞争。

**用于** C10。`05-durability-and-containment.md` §2。

### replay safety（可重放性）

**定义。** 按操作声明：崩溃后重跑该操作，是否与只跑一次不可区分。

**不是** 猜测，也不是工具族的属性。`shell_read` 与 `shell_status` 安全。`shell_start` 与 `shell_send` 不安全，因为第二次 build 就是第二次 build，第二次应答就是第二次击键（C8）。

**用于** C8。`05-durability-and-containment.md` §2。

### request id（请求 ID）

**定义。** 调用者提供的标识符，通过不覆盖发布使不安全操作变得可重放安全。

**不是** 句柄 ID。请求 ID 命名一次尝试。句柄 ID 命名一次执行。同一个请求 ID 的两次尝试只产生一次执行。

**用于** C8。`05-durability-and-containment.md` §2。

### intent record（意图记录）

**定义。** 在外部效果之前写下的、已 fsync 的持久记录，使崩溃留下“尝试过什么”的证据。

**不是** 完成记录。意图记录先于效果。完成记录后于效果。两者之间的崩溃正是 `unknown` 描述的情况。

**用于** C8。`05-durability-and-containment.md` §2。

### no-replace publication（不覆盖发布）

**定义。** 只在请求 ID 下尚无结果时写入结果。重放随后返回第一次的结果，而不是产生第二次效果。

**不是** 覆盖。覆盖会让重放与首次运行不可区分，而这正是可重放性要防止的失败。

**用于** C8。`05-durability-and-containment.md` §2。

---

## 9. 等待：短形式与长形式（C9）

### `shell_await` 短形式

**定义。** 一次工具调用内部的有界等待。`waitMs` 默认 30000，上限 50000。

**不是** 通用的等待方式。`pi-coding-agent` 里的工具调用无法挂起，所以 `shell_await` 会一直阻塞到它等完。它只在“跨一次轮次边界比等待更贵”时才正确。50000 的上限为 codemode 默认 60 秒脚本预算留出空间。以分钟计的等待属于长形式，不属于 `shell_await`（C9）。

**用于** C9。`03-execution-model-and-primitives.md` §3.2。

### 结束轮次的长形式

**定义。** 长等待：结束这一轮，让完成事件把对话接回来，并让磁盘上的注册表充当检查点。

**不是** 放弃。结束轮次以零成本挂起对话。它使长等待免费。它也是 Pi Durable 的 park 在本地的等价物（`05-durability-and-containment.md` §1）。

**用于** C9。`01-overview.md` R1。

### wait and work（等待与工作）

**定义。** 两个独立的问题。取消等待不是取消工作。中断 `shell_await` 只分离等待者，不进入取消阶梯。

**不是** 细节。正是这个区分阻止 Escape 键杀死一次 build。它也是三个独立代码库各自得出的同一条规则（`05-durability-and-containment.md` §7）。

**用于** C4。`01-overview.md` §7。`04-runtime-architecture.md` §3。

---

## 10. 已废弃与禁用的术语

这些词被禁用。每个都列出替代说法。

### carrier

**已废弃。** `carrier` 命名（作用域，绑定）这一融合对，并暗示持久化需要多路复用器。请使用 `supervision scope` 与 `I/O binding`。需要同时指两者时，直接点名那个格子。

文件 `03-carrier-and-runtime-architecture.md` 现名 `04-runtime-architecture.md`。改名记录见 `05-durability-and-containment.md` §8。

### background task（后台任务）

**作为设计术语已废弃。** 它把所有权、I/O 绑定与持久性融进一个词，而三者各自独立变化。请使用 `scope` 与 `binding`。该说法只作为外部包 `pi-background-tasks` 的专有名称保留。

### park

**本项目不使用。** `park` 是 Pi Durable 的挂起调用机制。`pi-coding-agent` 没有调度器，所以本项目没有 park。结束轮次承担这个角色，区别见 `05-durability-and-containment.md` §1。

### 把“阻塞”当作命令的属性

**已废弃。** 阻塞是命令完成与所有者退出之间的关系。它不是命令的属性，没有命令本身是阻塞的。

### 把视口当日志

**已废弃。** 视口显示终端曾显示的内容。日志记录曾写入的字节。前者用 `viewport`，后者用 `durable output`。两者保持分开。

### turn

**已废弃的作用域，0.2.0 删除。** `turn` 把当前 Agent 轮次当作所有者。落定时仍在运行的执行变成错误。它连同落定时的强制杀死与错误续跑一起被删除。请使用 `session`（活过轮次）或 `workspace`（活过 Pi）。需要在一轮之内建立因果屏障的调用者调用 `shell_await`，并且不取得更窄的所有者。

### readiness declaration（就绪声明）

**已废弃的 spawn 选项，0.2.0 删除。** `shell_start.readiness` 曾在 spawn 时接受 `marker`、`pattern` 或 `immediate`。就绪现在是等待条件：标记是 `$PI_ASYNC_SHELL_EXEC_DIR/ready`，模式传给 `shell_await`。`immediate` 随声明一起消失。不需要等待的调用者直接不等待。

### “管道不能提升”

**已废弃的规则，0.2.0 删除。** 它只在会话管道的 stdio 是由 Pi 持有的管道时为真。现在每次管道执行都运行在带文件日志的脱离监督器之下。因此提升只是释放所有者监视，进程与文件都保持不变。
