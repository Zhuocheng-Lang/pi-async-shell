---
kind: normative
applies_to: 0.2.0
tracks:
  - src/core/spawn.ts
  - src/core/pipe-supervisor.mjs
  - src/core/registry.ts
---

# 04. 运行时架构

> 本文件原名 `03-carrier-and-runtime-architecture.md`。现在叫 `04-runtime-architecture.md`。`carrier` 已不再是本设计中的概念（见 `00-terminology.md` §10）。`05-durability-and-containment.md` §8 记录了改名，旧链接因此有据可查。

## 1. 概览

两种绑定、两套 spawn 配方、一个注册表。绑定加作用域就是 `carrier` 一词过去的意思。把两者分开，才使 `workspace` + `pipe` 与 `workspace` + `pty` 得以存在。

每次执行的输出从启动那一刻起就绑定到文件。`pipe` 执行运行在脱离的管道监督器之下。监督器持有子进程的 stdout 与 stderr 管道，并写出日志文件。`pty` 执行运行在脱离的包装器之下。包装器通过 `script(1)` 持有 PTY，并把录制写进同一目录。两种绑定下 Pi 都留在数据路径之外。唯一随作用域变化的部分是 fd 3 所有者监视。提升会释放该监视。

注册表、spawn 配方、遏制、取消与日志管理构成核心。核心对 Pi 的消息机制一无所知。落定产生事件。扩展层决定把它作为后续消息投递、作为 TUI 通知，还是完全不投递。这种分离买到的是可测试性，不是宿主可移植性。`pi-coding-agent` 是唯一目标。`05-durability-and-containment.md` 说明了从哪里读过什么、又留在了哪里。

```
registry（句柄、作用域、等待者、完成记录）
   |
   +-- pipe   : 脱离的 pipe-supervisor.mjs，子进程管道 -> stdout/stderr/combined 文件
   +-- pty    : 脱离包装器，script(1) 录制 -> combined.log，stdin 来自 FIFO
   |
   +-- log manager : 流式解码、稀疏行索引、排空而不杀死的上限
   +-- supervision : 作用域退出钩子、取消阶梯、完成投递
```

---

## 2. Spawn 配方

### 2.1 `pipe`

两个作用域下的每次管道执行，都是对 `src/core/pipe-supervisor.mjs` 的一次调用：

```ts
spawn(process.execPath, [
  pipeSupervisorPath,
  dir,                       // 执行目录
  shell,                     // /bin/bash 或 /bin/sh，或 PI_ASYNC_SHELL
  command,
  String(maxLogBytes),       // 默认 100 MiB
  durable ? "0" : "1",       // 1 = 监视所有者，0 = 已经持久
], {
  cwd,
  env,                       // 过滤后的环境 + PI_ASYNC_SHELL_EXEC + PI_ASYNC_SHELL_EXEC_DIR
  detached: true,            // 自成会话与进程组
  stdio: durable
    ? ["ignore", "ignore", "ignore"]
    : ["ignore", "ignore", "ignore", "pipe"],   // fd 3 是所有者监视
  windowsHide: true,
})
```

在启动命令之前，监督器先写出自己的 `pid.json`（pid、pgid、启动时间）。然后它启动命令：

```js
const child = spawn(shell, ["-c", command], { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", (chunk) => append(chunk, stdout));
child.stderr.on("data", (chunk) => append(chunk, stderr));
```

`append` 按到达顺序写入 `stdout.log` 或 `stderr.log`，并写入 `combined.log`，直到上限。超过上限后它继续消费管道并丢弃多余字节。它只写一次 `log-cap.json`。子进程关闭后，监督器封存 `exit.json`（`exitCode`、`signal`、`endedAt`），然后杀死自己。没有监督器会活过它已封存的结果。

fd 3 监视是两个作用域唯一的区别。`session` 执行拿到一根来自 Pi 的管道。监督器从它读取一行。`release` 意味着所有权已移到工作区，监督器停止监视并继续运行。EOF 意味着拥有它的 Pi 进程死亡，监督器向自己的进程组发 `SIGTERM`，一秒后发 `SIGKILL`。监督器会忽略 `SIGTERM`，因为组信号也会到达它。它封存 `exit.json` 之后再杀死自己。

### 2.2 `pty`

两个作用域共用一套配方。包装器以脱离方式启动，不持有 Pi 的任何描述符。它通过 `script(1)` 持有 PTY：

```sh
#!/bin/sh
# $1 = 执行目录，$2 = 1 表示所有者不得被活过
d=$1; watch=$2
# 身份：pid.json（pid、pgid、启动时间），写临时文件再改名
fifo="$d/stdin.fifo"
rm -f "$fifo"
mkfifo "$fifo" || exit 1
exec 4<>"$fifo"                      # 读写：没有 EOF，后来的写者也能接上
( trap - INT QUIT; exec script -q -f -e -c "sh $d/pty-launcher.sh" /dev/null <&4 > "$d/combined.log" 2>&1 ) &
spid=$!
wd=""
if [ "$watch" = "1" ]; then
  ( read -r release <&3; if [ "$release" = "release" ]; then exit 0; fi; kill -TERM "$spid" 2>/dev/null; sleep 1; kill -KILL "$spid" 2>/dev/null ) &
  wd=$!
fi
wait "$spid"
rc=$?
[ -n "$wd" ] && kill "$wd" 2>/dev/null
# exit.json（退出码、结束时间），写临时文件再改名
exit "$rc"
```

PTY 内的启动器设置终端尺寸并交出命令：

```sh
#!/bin/sh
stty rows 24 cols 80 2>/dev/null     # spawn 时记录的尺寸
exec "$shell" -c "$command"
```

四个细节是承重的。每一个都针对内核实际验证过，而不是假设：

- **录制写进文件。** `script` 写自己的 stdout。数据路径因此不携带 Pi 的描述符，Pi 死亡也不会中断任何东西。
- **stdin 是以读写方式保持打开的 FIFO。** 读写句柄让子进程的 stdin 不出现 EOF。没有写者时也如此。后来的进程还能以写方式打开同一个 FIFO。`shell_send` 以 `O_WRONLY|O_NONBLOCK` 打开它，所以没有读者时写入快速失败，而不是阻塞调用者。
- **尺寸显式设置。** stdin 是 FIFO，所以内核不会给从端任何窗口尺寸。`stty size` 会回答 `0 0`。运行时把尺寸记录在 `pty-size`，启动器应用它，使子进程与重放一致。stdout 是 TTY 时，尺寸来自 Pi 的终端。否则尺寸来自 `COLUMNS`／`LINES`，钳制在 20-500 列与 4-200 行。默认是 80x24。
- **`script` 固定到 POSIX shell，且其作业保留默认信号处置。** `script` 通过 `$SHELL -c` 运行命令。`SHELL=/bin/sh` 于是把非 POSIX 用户 shell 挡在命令解析器、退出码与日志之外。把作业放到后台会让 shell 在其中忽略 SIGINT 与 SIGQUIT。这会静默禁用经 PTY 的 ^C，所以运行时在 `exec` 前复位处置。

PTY 把 stdout 与 stderr 合并进一份录制。`combined.log` 就是那份终端录制（CRLF、回显输入）。`stdout.log` 与 `ptyView.log` 是指向它的符号链接。`shell_read` 默认规范化 CRLF。`ptyView` 把该录制重放成它产生的屏幕。这种重放是字节流的视图，不是替代品。

运行时通过 `exit.json` 的原子出现检测完成，该文件由包装器在 `script` 返回后写出。包装器是 Pi 启动的进程，所以取消阶梯拥有它的 pid 与进程组。

所有者管道（fd 3）是唯一随作用域变化的部分。`session` 执行拿到一根，其 EOF 拆掉 PTY。该执行不能活过 Pi。`workspace` 执行不拿所有者管道，所以它存活并被重认领。

### 2.3 提升

`shell_promote({ to: "workspace" })` 在不触碰进程的情况下改变所有权：

1. 注册表向 fd 3 所有者监视写入 `release\n` 并关闭它。监督器或包装器停止监视。命令不会收到信号。
2. 它创建目录符号链接 `workspace/<id>`。该符号链接指向 `sessions/` 下的执行目录。工作区认领扫描于是能看到记录，而不移动子进程仍在写入的目录。
3. 调用者提供 `adopterNotification` 时，注册表用它设置 `notifyOnCompletion`。注册表还在 `meta.json` 中设置 `scope: "workspace"` 与 `durable: true`。

不会重启任何东西。没有日志文件改变。也不会丢字节。这就是两种绑定都能提升的原因。从 spawn 那一刻起，进程的 stdio 就属于脱离持有者，而不是 Pi。

---

## 3. 取消阶梯

```
graceful:  pty -> 向 stdin FIFO 写入 ^C（无读者时改用 SIGTERM）
           pipe -> 向 -pgid 发 SIGTERM
           等待 graceMs（默认 3s；shutdown 1.5s，被放弃的 reload 交接 1s）

force:     set = tagged(PI_ASYNC_SHELL_EXEC = id)
                 ∪ liveDescendants(已知 (pid, start) 身份)
                 ∪ liveMembers(自有进程组，since 为组长启动时间)
                 ∪ liveDescendants(带标签身份)
           对每个 pid 重读 start，然后 SIGKILL
           重复扫描—击杀直到为空或到达截止时间（5s）

verify:    集合为空
           失败 -> 状态 failed + 后代泄漏诊断
```

向进程组发信号是投递机制，不是遏制保证。`setsid(2)` 把子进程放进新会话与新进程组。此后 `-pgid` 什么也触不到。`nohup … &` 是 Agent 会随手打出的东西。进程组是廉价的优雅路径，也是在 `environ` 不可读时唯一可用的路径。标签才是保证。

三个视图覆盖三种不同的逃逸。标签能活过被重新托管的子进程，但活不过 `env -i`。ppid 树能活过 `env -i`，但活不过重新托管。自有进程组两者都能活过，只有 `setsid(2)` 能击败它。`since` 边界是组长的启动时间。复用的组 ID 因此不会匹配早于本次执行的陌生进程。`05-durability-and-containment.md` §5 给出出处与必需的测试。

另外四条规则是必需的：

- 运行时在 spawn 时捕获组 ID 与 `(pid, start)` 身份。对活动进程，它不从元数据重建这两者。每次发信号前立即重读 `start`，所以复用的 pid 永远不会被杀。
- `signalGroup` 拒绝 pgid 为 0 或 1、Pi 自己的 pid，以及 Pi 自己的进程组。错误的组 ID 无法向 Agent 发信号。
- 中断 `shell_await`（Escape，或 codemode 脚本放弃 promise）只分离等待者。这个阶梯不受影响。取消消费者不是取消生产者。
- 超时与取消等待的是*已终结的清理*，不是状态标签。`enforceTimeout` 先把句柄标成 `timed-out`，运行阶梯，验证缺席，然后才封存记录。`shell_cancel` 等待同一个终结事件。捕获的身份仍存活时，退出监视器拒绝终结。所以监督器的 `exit.json` 不能让仍在运行的树看起来已落定。

---

## 4. 持久输出与反压

`.pi/async-shell/{sessions/<sessionId>-<pid>|workspace}/<id>/` 下的布局：

| 文件 | 写入者 | 含义 |
|---|---|---|
| `meta.json` | 注册表，原子改名 | 句柄、作用域、绑定、状态、身份、字节计数 |
| `stdout.log` | 监督器（pipe）或指向 `combined.log` 的链接（pty） | stdout 字节 |
| `stderr.log` | 监督器（pipe），pty 下为空 | stderr 字节 |
| `combined.log` | 监督器（pipe）或 `script(1)`（pty） | 按到达顺序的流／终端录制 |
| `ptyView.log` | 指向 `combined.log` 的链接（仅 pty） | 重放为屏幕的录制 |
| `pty-size` | 注册表（仅 pty） | 给 PTY 的行列数 |
| `pid.json` | 监督器或包装器 | pid、pgid、启动时间，在命令之前写出 |
| `exit.json` | 监督器或包装器 | 退出码、信号、结束时间 |
| `completion.json` | 注册表 | 持久完成记录 |
| `log-cap.json` | 监督器 | 已到达上限 |
| `stdin.fifo`、`pty-wrapper.sh`、`pty-launcher.sh` | 包装器（FIFO）与注册表（脚本），仅 pty | 终端的 stdin 与 spawn 配方 |
| `.surfaced` | 注册表（仅 workspace） | 该完成已投递过一次 |

上限是*日志*策略，所以绝不能变成*进程*策略。到达 `PI_ASYNC_SHELL_MAX_LOG_BYTES`（默认 100 MiB）时：

1. 监督器停止在上限之后追加。
2. 它**继续排空管道**，丢弃多余字节。
3. 监督器写出 `log-cap.json`，并在元数据中设置 `bytes.capReached`。
4. 进程不受影响。

第 2 步是最容易做错的一步。Linux 管道默认只缓冲 64 KiB。把上限实现成“停止读取”，会把写满的管道变成阻塞的子进程。它还会把日志决定变成挂起。这是与 `pi-background-tasks` 最大的行为差异，后者的 20 MiB 上限会杀死任务（`registry.ts:72`、`background-task-runtime.md`）。

上限覆盖每一次 `pipe` 执行，因为监督器在两个作用域都持有管道。`pty` 录制由 `script(1)` 直接写盘。没有可暂停的管道，也没有可停止的写者，所以文件一直增长，直到运维手段或文件系统叫停。

行与字节索引每 256 行设一个稀疏检查点。`mode: "offset"` 因此可以 `pread`，而不是扫描。读取在打开文件*之前*检查 `signal.aborted`。把预先中断的信号传给 `createReadStream` 会抛出未处理的 `error` 事件。这正是 `~/.pi/agent/extensions/read-abort-guard.ts` 要补的 bug。

---

## 5. 就绪与等待条件

`shell_start` 上没有就绪选项。就绪是被观察的，不是被配置的：

| 条件 | 机制 | 对标 |
|---|---|---|
| `until: {kind: "ready"}` | 命令创建 `$PI_ASYNC_SHELL_EXEC_DIR/ready` | `sd_notify(READY=1)`／`Type=notify` |
| `until: {kind: "pattern", regex, stream, since}` | 从记录的偏移开始，对声明流（默认 `combined`）做正则匹配 | `expect` |
| `until: {kind: "exit"}` | 执行到达终态 | `wait(2)` |

注册表在每次日志轮询时检查标记。自有执行每 250 ms 轮询一次，已认领执行每 500 ms 轮询一次。await 求值时，注册表再检查一次标记。第一次观察到就设置 `readyAt`、持久化它，并为 UI 触发 `onReady`。标记是带外的，所以输出格式变化不能破坏它。从不创建标记的命令就是永远不就绪。

模式等待是增量的。注册表记录一个字节偏移（默认 0，`since: "now"` 时为当前文件大小，或调用者提供的数字）。它读取新字节，切成行，并把最后一段不完整的行留给下一个块。行匹配报告该行及其字节偏移。未换行的最后一行仍是输出，所以没有尾随换行的提示可以在进程继续运行时满足模式。如果执行在未匹配的情况下落定，等待以没有 `matched` 值的方式满足。调用者得知命令已结束，而不是永远等待。

`pipe` 保留独立的 `stdout.log` 与 `stderr.log`，所以 `stream: "stderr"` 不能被 `stdout` 行满足。`pty` 把两个流合并进一份录制。它的 `stdout.log` 是指向该录制的链接，所以两个名字在那里观察同一批字节。对 `pty` 来说，模式等待中的 `stream: "ptyView"` 读取与 `combined` 相同的录制文件。屏幕模型由 `shell_read` 应用，而不是由等待应用。

---

## 6. Reload 交接与重认领

### 6.1 同进程 `/reload`

`session_shutdown(reason: "reload")` 把活动句柄转移到进程全局槽位 `Symbol.for("pi-async-shell.reload-hub.v1")`，键为 `(pid, sessionId, realpath(cwd))`，认领截止 30 秒。子进程、流、等待者与累计字节计数一起转移。没有东西重启，也不丢字节。从未认领槽位的新激活会让它过期。句柄随后走正常取消阶梯，而不是保持无主。

### 6.2 跨进程 `scope: "workspace"`

在 `session_shutdown(reason: quit|new|resume|fork)` 时，运行时让工作区句柄继续运行，并释放自己的监视器。同一工作区的下一次 `session_start`，运行时取得写锁并扫描工作区记录，包括被提升的会话记录。它分类每条记录：

| 观察 | 结果 |
|---|---|
| `exit.json` 存在 | 按记录的退出码与信号终结为 `completed`／`failed` |
| 没有 `exit.json`，身份存活或日志仍在推进 | 恢复为 `running`，继续跟踪 |
| 没有 `exit.json`，存活无法证明 | `lost` |
| 认领尝试超过五次 | `lost`，附重启上限诊断 |

存活身份是 `(boot_id, pid, starttime)`。裸 pid 不够。重启后内核复用号段。认领一个陌生进程来报告它的退出码，比报告 `lost` 更糟。`starttime` 来自 `/proc/<pid>/stat` 第 22 字段。它在进程生命周期内稳定。

对任何 `workspace` 执行，持有日志 fd 的子进程也会佐证存活。如果文件大小或 mtime 在 120 ms 采样内推进，写者就活着，即使 `/proc` 不可读。仅仅空闲——停在提示符——的 `pty` 执行按身份是活的，日志是安静的。所以运行时先检查身份。

在无人观察时落定、且通知已启用的完成，会在 `session_start` 以 `<async-shell-workspace>` 消息呈现一次。写者在执行目录记录 `.surfaced`，使后续会话不重复它。只有锁持有者呈现记录。只读观察者从不写标记。

写锁是 `.pi/async-shell/workspace/.lock`，用 `O_EXCL` 与持有者身份创建。持有者已不存活的锁是陈旧的，会被替换。拿不到锁的进程以只读方式打开注册表。它可以读取状态与日志，而 `shell_promote`、`shell_send` 与 `shell_cancel` 会拒绝，而不是与所有者竞争。

---

## 7. 存储与垃圾回收

`ensureRegistryDirs` 创建 `.pi/async-shell/`、`sessions/`、`workspace/` 与 `requests/`，并写入内容为 `*` 的 `.gitignore`，使用不覆盖标志。不覆盖标志让已存在的 `.gitignore` 保持不变。

GC 在注册表构造时运行，之后每小时运行。它只删除已封存的终态记录：

| 规则 | 默认 | 旋钮 |
|---|---|---|
| 终态记录年龄 | 24 小时 | `PI_ASYNC_SHELL_GC_RETENTION_MS` |
| 终态记录数量 | 100 | `PI_ASYNC_SHELL_GC_MAX_RECORDS` |
| 数量驱逐宽限 | 记录至少 5 分钟 | 固定 |

运行中记录、非终态记录、被已加载句柄保护的记录，以及当前会话目录中的记录都不受影响。崩溃的所有者会让活动的工作区进程留在原处。记录被删除时，它的提升符号链接也删除。空的会话目录会被清理。超过保留窗口且不指向已知执行的孤儿请求记录在同一趟中删除。

---

## 8. 实现顺序

**阶段 1 —— 注册表、`pipe`、`session` 作用域。** 该阶段交付句柄注册表、封存元数据，以及脱离的管道监督器。该监督器持有文件日志与排空而不杀死的上限。它交付 `shell_start`／`await`／`read`／`cancel`／`status`、完成合并、`consumedByAwait` 抑制与 `/reload` 交接。它交付让取消有意义的遏制围栏。

**阶段 2 —— `pty`。** 该阶段交付脱离的 `script(1)` 配方、stdin FIFO、`shell_send`、就绪标记与模式等待、包装器标记，以及 `ptyView` 读取。

**阶段 3 —— `workspace` 作用域。** 该阶段交付工作区认领与 `shell_promote`。它交付重认领扫描、`lost` 处理与抗 PID 复用的身份。它交付写锁、GC 与 `/async-shell` 列表。

每个阶段都可独立发布。阶段 1 已经满足最初的三项需求，不需要 PTY，也不需要跨进程持久化。

**0.2.0** 删除了 `turn` 作用域及其落定时的错误。它删除了 `shell_start.readiness`。它让管道监督器成为通用设施，使两种绑定都无损提升。它新增 Linux／procfs 守卫、凭据过滤器、就绪标记、部分行模式等待，以及 GC 清扫。
