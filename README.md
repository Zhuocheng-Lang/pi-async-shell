<p align="center">
  <img alt="pi-async-shell logo" src="docs/assets/logo.svg" width="128">
</p>

# pi-async-shell

Durable asynchronous shell commands for Pi. A dev server, slow build, test suite, or interactive CLI returns a handle immediately instead of blocking the turn, writes searchable logs to disk from spawn, accepts PTY keystrokes, and can survive a Pi restart.

[中文说明](README.zh-CN.md)

Status: beta · 0.x, so the API can change in a minor release · Linux only for now.

## Why not just Pi's built-in `bash` or a basic background extension?

Pi's built-in `bash` tool blocks until a process exits and cannot drive a long-lived dev server or an interactive prompt. Most background-task extensions spawn detached children, but force the agent into polling loops, dump multi-kilobyte logs into the context window, lose processes across a Pi restart, or hang when a command asks `[y/N]`.

`pi-async-shell` solves those failure modes directly:

- **Wait for readiness without polling.** `shell_await` blocks until process exit, an output regex (e.g., `Listening on :3000`), or a `$PI_ASYNC_SHELL_EXEC_DIR/ready` marker file. One tool call replaces 7–8 sleep-and-poll turns.
- **Search 200k-line logs without context bloat.** `stdout`, `stderr`, and `combined` streams are file-backed from spawn. `shell_read({ mode: "grep" })` extracts only the matching lines and context instead of pouring megabytes into the model prompt. At the log cap, recording stops while output keeps draining, so a chatty build is never killed for output volume.
- **Drive interactive CLIs and TUIs.** `binding: "pty"` allocates a real disk-backed terminal. The agent waits for a prompt without a trailing newline, sends text or key chords via `shell_send`, and inspects the rendered terminal screen via `stream: "ptyView"`.
- **Survive a Pi crash or restart.** `scope: "workspace"` jobs live outside the Pi process and are automatically adopted by a later session with full log history intact. `shell_promote` upgrades a live session job to workspace ownership in place—no restart, no lost output.
- **Wake the agent on completion.** When an unawaited background command finishes mid-turn, it steers a notification with the exit code and a bounded output excerpt into the agent's next decision. Fast commands that finish within `inlineSettleMs` (default 1000 ms) return their result directly in `shell_start` with no extra `shell_await`. A single-shot `pi -p` or `--mode json` run is not exempt: its settle boundary waits for live, unready session work, so the completion resumes the run instead of dying with the session.

## Measured against `bash` and 8 npm background extensions

Every row below comes from [`bench/REPORT.md`](bench/REPORT.md) (`node bench/run-bench.ts`), running real Pi SDK sessions against `bash` and the 8 most-downloaded background/shell extensions on npm (`pi-background-tasks`, `pi-better-background-tasks`, `pi-background`, `pi-patty-bg-tasks`, `pi-async`, `@tduyng/pi-shell`, `pi-shell-jobs`, `pi-exec-command`):

| Scenario | Built-in `bash` | `pi-async-shell` | The other 8 npm extensions |
|---|---|---|---|
| **Start a dev server & know it is ready** | Blocks forever | **1 call** (`1.30 s` via output-pattern wait) | 6 extensions need **7–8 polling calls**; 2 wait `5.3 s` / `30.3 s` |
| **Find the answer in a 2.5 s noisy command** | `11,913 B` into model context | **`677 B` into model context** (via `shell_read` grep) | 6 extensions pour `6.4 KB–17.4 KB` into context; only 1 other has log grep. 2 show less (`pi-background` 573 B, `pi-patty-bg-tasks` 342 B) because they return less of the output |
| **Answer a `[y/N]` prompt after 4,000 lines** | Cannot send stdin | **Answered in `373 ms`** (`binding: "pty"` + `shell_send`) | 5 fail (no stdin); 2 take `5.4 s` / `30.4 s`; only 1 pipe tool answers fast |
| **A job survives a hard parent exit** | Cannot start one | **`25/25` lines** | Only `pi-patty-bg-tasks` also survives (`25/25`); the other 7 write 0–6 lines |
| **Recover log output after Pi is killed & restarted** | Lost (`0/40` lines) | **Recovered `40/40` lines** (`scope: "workspace"`) | **All 8 lose everything (`0/40` lines)** |
| **Cancel a runaway process tree cleanly** | Only on turn abort | **Signal ladder + no tracked process survived, log kept** | 1 has no cancel tool; 1 loses all output on cancel |

See [bench/REPORT.md](bench/REPORT.md) for the full reproduction methodology, per-package numbers, and capability matrix.

## Install & try in 30 seconds

Requirements: Linux, Node.js 22.19 or later, and Pi. PTY commands also use `script(1)`, `mkfifo(1)`, and `stty(1)`.

```sh
pi -e npm:pi-async-shell         # try in a single session (trying it never hurts XD)
pi install npm:pi-async-shell    # install for daily use
```

The package ships two skills. `async-shell` covers consumer workflows such as servers, readiness markers, tests, promotion, and PTY sessions. `async-shell-maintainer` covers development and maintenance of this package.

**Evaluating this extension as an agent or human?** Paste this prompt into a `pi -e npm:pi-async-shell` session to verify readiness waiting, PTY interaction, and log search in one turn:

> Use `shell_start` with `binding: "pty"` to run `python3 -u -c "import time; print('booting...'); time.sleep(0.5); ans = input('Deploy now? [y/N] '); print('RESULT=' + ans)"`. Wait for the `\[y/N\]` prompt with `shell_await` (`until.kind: "pattern"`), answer `y` with `shell_send`, wait for exit, and grep for `RESULT=` with `shell_read`.

## Three high-leverage workflows

### 1. Start a dev server and wait for readiness (zero polling)

```ts
const srv = await shell_start({
  command: "pnpm run dev -- --port 3000",
  cwd: "/repo",
  name: "dev server",
});

// Returns as soon as the port banner appears; timeout never kills the server
await shell_await({
  ids: srv.id,
  until: { kind: "pattern", regex: "Local:.*3000" },
  waitMs: 15000,
});
```

### 2. Drive an interactive prompt or REPL over a real PTY

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

### 3. Run a noisy test suite, grep failures, and promote to workspace

```ts
const job = await shell_start({ command: "pnpm test", cwd: "/repo" });

// Running longer than expected? Promote in place so it survives a Pi restart
await shell_promote({ id: job.id, to: "workspace" });

await shell_await({ ids: job.id, waitMs: 45000 });
const failures = await shell_read({
  id: job.id,
  mode: "grep",
  pattern: "FAIL|Error",
  context: 3,
});
```

## The seven tools

| Tool | Purpose |
|---|---|
| `shell_start` | Start a command with `session` or `workspace` ownership and `pipe` or `pty` I/O. |
| `shell_await` | Wait for exit, a `$PI_ASYNC_SHELL_EXEC_DIR/ready` marker, or an output regular expression. |
| `shell_read` | Read `tail`, `head`, `offset`, `grep` hits, or a bounded `all` view from `combined`, `stdout`, `stderr`, or `ptyView`. |
| `shell_promote` | Upgrade live `session` work to `workspace` ownership without respawning or losing logs. |
| `shell_send` | Write text or key chords (`Enter`, `Ctrl+C`, arrows, etc.) to a `pty` through its durable stdin FIFO. |
| `shell_cancel` | Run the graceful-to-force signal ladder and verify that the entire process tree is gone. |
| `shell_status` | Inspect one handle or all active handles (point-in-time snapshot, not a polling primitive). |

## Choose ownership and I/O independently

| Setting | Behavior |
|---|---|
| `scope: "session"` (default) | Survives across turns and `/reload`; in a single-shot `pi -p` run, live unready work holds the settle boundary until it completes or becomes ready; cleaned up when the owning Pi session exits. |
| `scope: "workspace"` | Survives a Pi process exit or crash and is adopted by the next session in that workspace. |
| `binding: "pipe"` (default) | Separate `stdout` and `stderr` files plus `combined` output. Refuses stdin. |
| `binding: "pty"` | Real disk-backed pseudo-terminal, key input via `shell_send`, and rendered viewport reads via `ptyView`. |

## Documentation

| File | Content |
|---|---|
| [skills/async-shell/SKILL.md](skills/async-shell/SKILL.md) | Consumer recipes: hard rules, readiness markers, PTY sessions, ownership, wait budgets. |
| [skills/async-shell-maintainer/SKILL.md](skills/async-shell-maintainer/SKILL.md) | Contributor routing, verification commands, and internal implementation map. |
| [docs/design/06-skill-boundaries.md](docs/design/06-skill-boundaries.md) | Routing and ownership boundary between consumer and maintainer skills. |
| [bench/REPORT.md](bench/REPORT.md) | Reproducible benchmark against Pi's `bash` tool and eight npm background/task extensions. |
| [docs/implementation-notes.md](docs/implementation-notes.md) | Runtime architecture, on-disk storage, log cap, garbage collection, known limits. |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Development setup, `pnpm verify`, running benchmarks, release steps. |
| [CHANGELOG.md](CHANGELOG.md) · [SECURITY.md](SECURITY.md) | Release history and vulnerability reporting. |

## License

[MPL-2.0](LICENSE)
