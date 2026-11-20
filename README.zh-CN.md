# pi-async-shell

让慢命令不再阻塞 Pi，保留可检索日志，并在 Pi 重启后接管 workspace 任务。

pi-async-shell 提供七个受监管的 Shell 工具，覆盖并行构建、开发服务器、日志检索、交互式 PTY 程序，以及从 session 到持久 workspace 任务的无损提升。

```
当前版本：0.2.0-beta.1 · 仅支持 Linux · [English](README.md)
```

## 三分钟上手

要求：Linux、Node.js 22.19 或更高版本、Pi。PTY 还使用 script(1)、mkfifo(1) 和 stty(1)。

只在本轮 Pi 调用中试用，不修改配置：

```sh
pi -e npm:pi-async-shell@0.2.0-beta.1
```

安装到日常环境：

```sh
pi install npm:pi-async-shell@0.2.0-beta.1
```

试用本地检出：

```sh
pi -e /absolute/path/to/pi-async-shell
```

然后直接告诉 Pi：

```text
用 pi-async-shell 在 3000 端口启动开发服务器。
等到它打印本地地址后运行测试。
只显示测试失败及前后几行上下文。
```

对应的工具调用顺序如下：

```ts
// 1. 启动返回句柄；若命令在 1s 内落定，则同一次调用直接返回结果。
shell_start({
  command: "pnpm run dev -- --port 3000",
  name: "dev server"
});

// 2. 等待服务器输出就绪，而不是等待服务器退出。
shell_await({
  ids: "sh_1234abcd",
  until: { kind: "pattern", regex: "Local:.*3000" },
  waitMs: 15000
});

// 3. 在这个因果屏障之后运行依赖任务。
shell_start({ command: "pnpm test", name: "test suite" });
shell_await({ ids: "sh_test_id", waitMs: 50000 });
shell_read({
  id: "sh_test_id",
  mode: "grep",
  pattern: "FAIL|Error|error",
  context: 3
});
```

包内附带 async-shell Skill，包含服务器、就绪标记、测试、提升和 PTY 工作流。

## 输出不固定时使用 ready 标记

每个命令都会获得 PI_ASYNC_SHELL_EXEC_DIR。健康检查真正通过后，在该目录创建 ready 文件：

```sh
pnpm run dev &
server_pid=$!
until curl -fsS http://localhost:3000/health >/dev/null; do sleep 0.2; done
touch "$PI_ASYNC_SHELL_EXEC_DIR/ready"
wait "$server_pid"
```

通过 shell_await 等待标记：

```ts
shell_await({
  ids: "sh_1234abcd",
  until: { kind: "ready" },
  waitMs: 15000
});
```

shell_start.readiness 已不存在。输出正则和 ready 文件都是等待条件，不是启动参数。正则也能匹配尚未换行的交互提示。

## 所有权与 I/O 独立选择

| 设置 | 行为 |
|---|---|
| scope: session（默认） | 跨轮次和 /reload 存活，随所属 Pi 会话结束。 |
| scope: workspace | 跨 Pi 进程重启存活，可由后续进程接管。 |
| binding: pipe（默认） | 分别保存 stdout、stderr，并保存 combined；没有 stdin。 |
| binding: pty | 提供真实终端，通过 shell_send 输入，通过 ptyView 读取渲染屏幕。 |

当 session 命令必须活过 Pi 时，调用 shell_promote({ id, to: "workspace" })。pipe 与 pty 都无需重启进程或迁移日志。

scope turn 已移除。正常结束轮次不会取消 session 命令。

## 七个工具

| 工具 | 用途 |
|---|---|
| shell_start | 以 session/workspace 所有权和 pipe/pty I/O 启动。 |
| shell_await | 等待退出、ready 标记或输出正则。 |
| shell_read | 有界读取 tail、head、offset 或 grep 结果。 |
| shell_promote | 将存活任务提升到 workspace 所有权。 |
| shell_send | 通过持久 stdin FIFO 向 pty 写入文本或按键。 |
| shell_cancel | 执行信号阶梯并验证进程树已清理。 |
| shell_status | 查看当前句柄；不要用它轮询。 |

shell_await 的 waitMs 默认 30000，最大 50000，为 codemode 默认 60 秒脚本预算留出余量。更长的等待应结束轮次并依靠完成通知。等待超时或中止绝不会取消命令。

## 完成通知如何到达 Agent

没有 await 消费的命令结束时会产生一条完成消息。Agent 仍在运行时，这条消息在下一次 LLM 调用之前以 steer 方式送达，因此中途结束的构建会影响下一个决定，而不是等到整轮结束后才出现。

| shell_start 设置 | 效果 |
|---|---|
| delivery: steer（默认） | 记录在下一次 LLM 调用之前到达运行中的 Agent。 |
| delivery: settle | 记录等到 settle 边界，让当前计划先走完。 |
| notifyOnCompletion: false | 不产生完成消息；记录仍留在磁盘上。 |
| triggerOnCompletion: false | 空闲会话只保存记录，不开启轮次。 |

同一 150 ms 窗口内结束的记录合并为一条消息。被 shell_await 消费的句柄不再产生完成消息，workspace 记录也不会自行开启轮次。

## 与 pi-background-tasks 共存

pi-background-tasks 还提供委派 Agent 和 Fusion 工作流。保留这些工具，只在 ~/.pi/agent/settings.json 屏蔽与本包重叠的 Shell 任务入口：

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

把这些条目合并进现有 defaultTools 数组。bg_delegate、bg_run_pi_attested 和 fusion_* 仍然可用。本包不会替换 background-task 扩展，因此其命令和内部状态不受影响。

如果需要人类实时观看并接管 TUI，pi-interactive-shell 更合适。pi-processes 提供 macOS/Linux 上 Codex 风格的托管执行。pi-async-shell 聚焦 Linux 持久性、文件日志、就绪等待与 workspace 恢复。

## 环境、存储与边界

- 命令默认通过 /bin/bash -c 执行，回退 /bin/sh。登录 Shell 不一定是 POSIX 脚本解释器，因此忽略环境里的 $SHELL。只有显式设置 PI_ASYNC_SHELL 才覆盖命令 Shell。
- spawn 前默认过滤常见凭据变量，包括 *_API_KEY、*_API_SECRET、*_SECRET_KEY、*_ACCESS_TOKEN、*_AUTH_TOKEN、*_SESSION_TOKEN 以及常见云服务/令牌名称。shell_start.env 可以显式覆盖过滤。工具参数可能进入会话记录，未经授权不要放入真实凭据。
- 运行状态位于 .pi/async-shell/。扩展会创建内容为 * 的局部 .gitignore，不覆盖已有内容。
- pipe 日志默认上限 100 MiB（PI_ASYNC_SHELL_MAX_LOG_BYTES）。达到上限后停止追加日志，但继续排空 stdout/stderr，不会因输出过多而阻塞或杀掉命令。
- PTY 记录由 script(1) 直写磁盘，不使用 pipe 上限。对长期且大量输出的 PTY 程序设置 timeoutSeconds，并监控磁盘。
- 结算时间接近的完成消息会合并成一条。合并窗口默认 150 ms，可用 PI_ASYNC_SHELL_COALESCE_MS 调整；设为 0 则每条单独发送。
- GC 在注册表启动时运行，之后每小时运行。默认清理超过 24 小时的已终止记录；超过 100 条时，也会清理经过五分钟宽限的旧记录。运行中、非终止、受保护及当前会话记录绝不回收。可通过 PI_ASYNC_SHELL_GC_RETENTION_MS 和 PI_ASYNC_SHELL_GC_MAX_RECORDS 调整。
- 取消不是回滚，环境过滤也不是安全沙箱。命令仍拥有用户的文件系统与网络权限。

## 开发与验证

```sh
pnpm install          # TypeScript、Node 类型定义，以及固定版本的 Pi 宿主包
pnpm verify           # 类型检查加完整测试套件
pnpm pack --dry-run   # 列出发布 tarball 会包含的文件
```

无需全局安装任何东西：类型检查器和 Pi 宿主包都是 devDependencies，版本固定为套件验证过的版本。基准测试需要先多做两步，见 [bench/README.md](bench/README.md)。

测试使用真实进程和真实 Pi SDK 会话，并通过 faux provider 驱动模型调用。覆盖默认 Shell、凭据过滤、就绪、无换行提示、日志上限、GC 安全、取消、硬杀存活、提升、workspace 接管、reload 转交与工具 Schema。

[bench/REPORT.md](bench/REPORT.md) 是与 Pi 内置 bash 及九个后台/任务扩展的生成式对比报告。[docs/implementation-notes.md](docs/implementation-notes.md) 说明运行时实现。[docs/design/](docs/design/) 保存术语、取舍和生态背景。

## 许可证

MPL-2.0，完整文本见 [LICENSE](LICENSE)。

Mozilla Public License 2.0 是文件级 copyleft：可以在闭源或专有产品中使用、也可以原样分发 pi-async-shell，只需保留许可证声明。如果修改了某个文件并对外分发，该文件的源码需以 MPL-2.0 提供。许可证包含贡献者的明示专利授权。

版权所有 (c) 2026 Zhuocheng-Lang。源文件带有 `SPDX-License-Identifier: MPL-2.0` 头。贡献按同一许可证接受，见 [CONTRIBUTING.md](CONTRIBUTING.md)。
