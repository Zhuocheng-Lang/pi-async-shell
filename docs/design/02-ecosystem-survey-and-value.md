# 02. Ecosystem Survey, Empirical Baseline & Defensible Project Value

Every claim in this document carries a classification. **[Fact]** means the claim was verified directly from source code, official documentation, package metadata, or CLI execution in this workspace. **[Inference]** means the claim follows from verified facts. **[Recommendation]** means the claim is a design decision for `pi-async-shell`.

**Scope of the survey.** The installed-extension survey covers the local Pi installation. Two further competitors, `pi-interactive-shell@0.18.0` and `pi-processes@0.4.3`, are described from their published npm metadata and the README shipped in their release tarballs; they are ecosystem comparisons, not benchmark entries. Download counts, star counts and packages that are neither installed nor named here were not measured, so this document makes no claim about the size or ranking of the surrounding ecosystem.

---

## 1. Current Workspace & Environment Baseline

### 1.1 Repository State
- **[Fact]** Workspace path: `~/Programs/school/pi-async-shell`. The directory was renamed once, from the working title `pi-subterminals`. The rename followed the decision to build asynchronous execution handles rather than subordinate terminals.
- **[Fact]** Version: `0.2.0-beta.1` (`package.json`). License: MIT at that version; the project moved to MPL-2.0 after it. Runtime target: Linux only, Node.js `>=22.19.0`.
- **[Fact]** Version control: colocated Jujutsu (`.jj/`) and Git (`.git/`) repository.
- **[Fact]** The runtime state directory is `.pi/async-shell/`, created lazily under the workspace. The extension writes a local `.gitignore` containing `*` there and never replaces an existing one.

### 1.2 Local Terminal & Shell Environment
- **[Fact]** Installed tmux version: `tmux 3.8`. It is not a dependency of this project; it is listed because the comparison matrix refers to terminal multiplexers.
- **[Fact]** `script(1)`, `setsid(1)`, `mkfifo(1)` and `stty(1)` are present (`util-linux 2.42.4`, `coreutils 9.12`). These are the only external programs the `pty` binding uses.
- **[Fact]** Default user shell environment: `/usr/bin/nu` (Nushell). `pi-background-tasks` classifies this shell as `user-non-posix`. `pi-async-shell` ignores ambient `$SHELL` for command execution: it runs `/bin/bash -c` when `/bin/bash` exists, otherwise `/bin/sh -c`, and `PI_ASYNC_SHELL` is the explicit override. The `pty` wrapper additionally pins `SHELL=/bin/sh` for the `script(1)` layer, because `script` runs its command through `$SHELL`. The POSIX set used for diagnostics is `sh`, `bash`, `dash`, `zsh`, `ksh` and `ash`; `fish` is not in it.

---

## 2. Pi Host Capabilities & Best Practices (`@earendil-works/pi-coding-agent@1.5.2`)

Verified from `~/.pi/agent/pi-base/docs/extensions.md`, `docs/codemode.md`, and `dist/core/tools/bash.js`:

1. **Parallel Tool Execution & Codemode (`docs/extensions.md:575`, `docs/codemode.md`):**
   - **[Fact]** Assistant tool calls in a single turn execute in parallel by default, unless a tool sets `executionMode: "sequential"`.
   - **[Fact]** This user's environment (`~/.pi/agent/settings.json`) enables `"codemode": { "mode": "only", "inlineBudget": 65535 }`. The model interacts with tools by writing async JavaScript in a QuickJS sandbox (`await tools.<name>(args)`). Inside that sandbox, `Promise.all([...])` can invoke multiple tools concurrently within a single model turn.
   - **[Fact]** Tools that declare `outputSchema` and return `structuredContent` pass typed objects directly to `codemode` scripts. They still return human-readable and model-readable `content` text (`docs/extensions.md:2218`).
2. **Built-in `bash` Tool Implementation (`dist/core/tools/bash.js`, `dist/core/tools/output-accumulator.js`):**
   - **[Fact]** It spawns a detached process group on POSIX (`detached: process.platform !== "win32"`, `stdio: ["ignore", "pipe", "pipe"]`). It blocks until `waitForChildProcess(child)` resolves, or until `signal`/timeout aborts.
   - **[Fact]** It streams incremental snapshots through `onUpdate`, throttled by `BASH_UPDATE_THROTTLE_MS`.
   - **[Fact]** It keeps a rolling tail buffer in memory, and it spills raw bytes to a temp file only when output exceeds `DEFAULT_MAX_BYTES` (50 KiB) or `DEFAULT_MAX_LINES` (2000 lines).
   - **[Fact]** It returns `structuredContent` with `{ output, truncated, full_output_path, exit_code, wall_time_seconds }` (`STRUCTURED_OUTPUT_MAX_BYTES = 1 MiB`).
   - **[Inference]** `Promise.all([tools.bash(...), tools.bash(...)])` in `codemode` can run multiple finite commands in parallel. However, the entire `codemode` call blocks until **all** awaited commands finish, or until the 60s sandbox timeout expires. It cannot start a server or a long build, it cannot return control to the agent or the user across turns, and it cannot attach a terminal.
3. **Asynchronous Notifications & Turn Triggering (`docs/extensions.md:1602`):**
   - **[Fact]** `pi.sendMessage({ customType, content, display, details }, { triggerTurn, deliverAs })` injects a custom message into the session.
   - **[Fact]** `deliverAs: "followUp"` waits until the current agent run has no more tool calls, then delivers. `deliverAs: "steer"` delivers after the current turn's tool batch finishes and before the next LLM call. `triggerTurn: true` starts an LLM turn immediately when Pi is idle.
   - **[Fact]** `agent_end` is not final-idle, because retries, auto-compaction or queued messages can continue the run. `agent_before_settle` is the final actionable boundary, and `agent_settled` is the final idle notification (`docs/extensions.md:214`).
4. **Session Lifecycle & Reload (`docs/extensions.md:254`, `1510`):**
   - **[Fact]** `session_start` fires with `reason: "startup" | "reload" | "new" | "resume" | "fork"`.
   - **[Fact]** `session_shutdown` fires with `reason: "quit" | "reload" | "new" | "resume" | "fork"`.
   - **[Fact]** Extensions must not spawn background processes or timers in the top-level factory function. They must initialize resources lazily or in `session_start`, and they must clean up idempotently in `session_shutdown` (`docs/extensions.md:174`).

---

## 3. Installed Extensions & Packages

### 3.1 Global Extensions (`~/.pi/agent/extensions/`)
Verified by reading every file in `~/.pi/agent/extensions/`:

| Entry | Purpose | Overlap with `pi-async-shell` |
|---|---|---|
| `device-net/index.ts` | Android kernel network sysctl probe/snapshot/apply/diff/restore via ADB (`dnet_*` tools). | None. |
| `export-md.ts` | `/export-md` command to export session transcript to Markdown via `~/.local/bin/pi-md`. | None. |
| `git-checkpoint.ts` | Creates `git stash create` checkpoints at `turn_start` and offers restore on `session_before_fork`. | None. |
| `github-issue-autocomplete.ts` | Autocompletes `#<issue>` in the prompt editor using `gh issue list`. | None. |
| `handoff.ts` (+ `.instructions.md`) | `/handoff` command to summarize current session and start a new focused session. | None. |
| `notify.ts` | Sends desktop notification (`notify-send` / OSC 777) 750 ms after `agent_settled` if still idle. | **Interaction note:** `triggerTurn: true` completion messages wake the agent; `notify.ts` debounces rapid run restarts via `SETTLE_GRACE_MS = 750`. |
| `pi-base-link.ts` | Maintains `~/.pi/agent/pi-base` symlink to the active Pi installation directory. | None. |
| `preset.ts` | `/preset` command and `--preset` flag to switch model/tool/prompt presets. | None. |
| `protected-paths.ts` | Blocks `write`, `edit`, and `bash` redirects to `.env*`, `.git/`, `.jj/`, `node_modules/`, `~/.ssh/`, `auth.json`. | **[Recommendation]** The local integration covers `shell_start` commands and `shell_send` PTY input as well as `bash` redirections. |
| `read-abort-guard.ts` | Monkey-patches `FileHandle.createReadStream` to avoid uncaught `AbortError` when `signal` is pre-aborted in `Promise.all`. | **Important runtime lesson:** any file stream that `pi-async-shell` opens with an `AbortSignal` must guard against pre-aborted signals. |
| `tools.ts` | `/tools` interactive TUI toggle to enable/disable tools per session branch. | None. |

### 3.2 Installed Pi Packages (`~/.pi/agent/settings.json` & `~/.pi/agent/npm/node_modules/`)
Verified from `package.json` and the source files of all 16 configured packages:

| Package | Version | Role | Overlap with `pi-async-shell` |
|---|---|---|---|
| `pi-background-tasks` | `2.6.10` | Background shell jobs (`bg_run`, `bg_status`, `bg_logs`, `bg_kill`, `/bg`, `/tasks`), plus read-only delegated agents (`bg_delegate`), attested Pi runs (`bg_run_pi_attested`), and 5-model Fusion workflows (`fusion_*`). | **Primary comparison target** (analyzed in depth in §4). |
| `@agent-sh/computer-use-linux` | `0.7.54` | Desktop GUI observation/control via AT-SPI accessibility tree, Wayland/X11 screenshots, window focus, and key/mouse synthesis. | Orthogonal (desktop GUI vs. shell execution handles). |
| `@narumitw/pi-goal` | `0.55.3` | Autonomous multi-turn `/goal` contract loop with `goal_complete`, `goal_blocked`, and `goal_wait(resume_after_ms)`. | Complementary (`goal_wait` pauses an active `/goal` loop awaiting external events). |
| `pi-lens` | `4.5.0` | LSP navigation, diagnostics, and ast-grep tools. | None. |
| `pi-fovea` | `0.33.2` | Repository graph sketching and heat-diffusion focus (`fovea_*`). | None. |
| `pi-web-access` | `0.48.0` | Web search and content fetching (`web_search`, `fetch_content`, etc.). | None. |
| `pi-vcc-codemode` | `0.1.6` | Transcript-preserving structured compactor and `vcc_recall`. | None. |
| `pi-memory-sessions` | `1.0.0` | Cross-session SQLite FTS recall (`session_search`, `session_read`). | None. |
| `pi-codemode-snippets` | `0.2.5` | Promotes `.js` codemode scripts with `// @snippet:` into tools. | None. |
| `pi-cache-optimizer` | `2.10.6` | Prompt cache key stabilization and stats. | None. |
| `pi-context-view` | `0.8.4` | Context token breakdown viewer. | None. |
| `pi-commandcode-provider` | `0.8.4` | Custom model provider. | None. |
| `@juicesharp/rpiv-ask-user-question` | `2.15.0` | `ask_user_question` structured questionnaire tool. | None. |
| `@juicesharp/rpiv-todo` | `2.15.0` | `todo` task list overlay tool. | None. |
| `@narumitw/pi-btw` | `0.63.8` | `/btw` side-question overlay. | None. |
| `@narumitw/pi-tui-kit` | `0.70.0` | UI component library for Pi TUI. | Reusable UI building blocks if needed. |

### 3.3 Built-in Pi Extension Examples (`~/.pi/agent/pi-base/examples/extensions/`)
- **[Fact]** `interactive-shell.ts` intercepts `user_bash` (`!vim`, `!htop`, `!git rebase -i`). It calls `tui.stop()`, runs `spawnSync(shell, ["-c", command], { stdio: "inherit" })`, and restarts the TUI when the command exits. It states explicitly: *"This only intercepts user `!` commands, not agent bash tool calls."* While the interactive command runs, the Pi TUI is fully suspended. This example is unrelated to the `pi-interactive-shell` package in §5.1.

---

## 4. Deep Audit of `pi-background-tasks@2.6.10`

Verified from `~/.pi/agent/npm/node_modules/pi-background-tasks/src/` and `docs/`:

### What `pi-background-tasks` Does Well
1. **Direct process-group spawning (`src/core/registry.ts`):** It uses Node `spawn()` with `stdio: ["ignore", "pipe", "pipe"]` and detached POSIX process groups. It also has a rigorous POSIX stop path: `SIGTERM` to `-pgid`, 3s grace, `SIGKILL` to `-pgid`, then `ESRCH` verification.
2. **Completion delivery (`docs/concepts/completion-delivery.md`):** It emits `<background-task-notification>` through `pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })`, after the output stream closes and the metadata write is atomic.
3. **Same-process reload survival (`src/core/reload-shell-owner.ts`):** It transfers opted `surviveReload: true` shell executions across `/reload` through a process-global `Symbol.for('pi-background-tasks.reload-shell-owner.v1')` lease hub with a 30s handoff timeout.
4. **Activation shell policy (`src/core/shell-policy.ts`):** It injects `<pi_background_shell_policy>` into the system prompt, so the model knows whether `bg_run` uses `/usr/bin/nu -c`, `bash -c` or `sh -c`.

### Structural Limitations & Divergent Scope of `pi-background-tasks`
1. **No causal `await` / barrier primitive:**
   - **[Fact]** `pi-background-tasks` provides only `bg_run`, `bg_status`, `bg_logs` and `bg_kill` for shell work. Its prompt guidelines forbid waiting in-turn: *"After a default bg_run launch, continue only independent useful work... otherwise briefly acknowledge it if useful, then end the current turn."*
   - **[Inference]** Consider a `codemode` script or a multi-step turn. The agent launches 3 parallel tasks, or starts a server and waits for `"Listening on port 3000"`, and then wants to run the next dependent step in the **same turn**. In that case `pi-background-tasks` forces a full turn boundary and an extra LLM round-trip. Alternatively it tempts the model into forbidden sleep/poll loops.
2. **Destructive 20 MiB output cap kills the running process:**
   - **[Fact]** `MAX_OUTPUT_BYTES = Number(process.env['PI_BG_MAX_OUTPUT_BYTES'] ?? 20 * 1024 * 1024)` (`src/core/registry.ts:72`). When a task's combined output exceeds 20 MiB, the runtime appends an error notice, **kills the task process tree**, and marks the task `failed` (`docs/subsystems/background-task-runtime.md:107`).
   - **[Inference]** Verbose builds, test suites with trace logging and long-running dev servers are killed mid-flight, only because they produce logs.
3. **Coarse log reading (`head` / `tail` only) and merged streams:**
   - **[Fact]** `bg_logs` supports only `{ taskId, maxBytes, tail: boolean }` (`src/extension.ts:212`). It merges `stdout` and `stderr` into a single `.output` file. It has no line-offset paging, no byte-offset cursor, no stream selection (`stdout` vs `stderr`), and no regex or literal search within task logs.
4. **No PTY, no interactive input, no external terminal view, no cross-process persistence:**
   - **[Fact]** `src/extension.ts:62-68` states: *"Explicit background shell jobs only... No PID/file adoption, process-restart survival, or crash recovery."* `stdio[0]` is hardcoded to `'ignore'`.
5. **Heavyweight multi-purpose bundle:**
   - **[Fact]** Over half of `pi-background-tasks` is dedicated to child Pi agent spawning (`bg_delegate`, `bg_run_pi_attested`, and the 5-model `fusion_reason` / `fusion_investigate` / `fusion_research` / `fusion_validate` workflows).
   - **[Fact]** Its internal `pi.events` bus (`pi-background-tasks:request:v1`, `src/core/extension-api.ts:116`) exposes only `capabilities | run | status | logs | kill`. It rejects `surviveReload` on that bus explicitly (`docs/subsystems/background-task-runtime.md:80`).

### Coexistence: Keep the Agent and Fusion Tools, Disable the Overlapping Shell Surface

`pi-background-tasks` is not replaced by this package, and its commands and internal state stay intact. The two extensions overlap only on background shell execution. **[Recommendation]** Disable the four overlapping tools and keep the rest:

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

Merge these entries with the existing `defaultTools` array. `bg_delegate`, `bg_run_pi_attested` and `fusion_*` remain available. The recommendation is about tool-surface overlap, not about trust: both extensions can be installed at once, and neither reads the other's state.

---

## 5. Additional Ecosystem Competitors (Not in the Benchmark Field)

The benchmark in `bench/REPORT.md` measures a fixed field of eight background/task packages plus Pi's built-in `bash` and `pi-async-shell`. The two packages below are ecosystem comparisons only: they were read from their published release artifacts, and their numbers are not in the benchmark.

### 5.1 `pi-interactive-shell@0.18.0`

- **[Fact]** npm description: *"Run AI coding agents in pi TUI overlays with interactive, hands-free, and dispatch supervision"* (`pi-interactive-shell@0.18.0`).
- **[Fact]** It runs interactive CLIs in an observable TUI overlay. The user watches, can take over by typing, and the agent can query status and send input. PTY support uses `zigpty` prebuilt binaries.
- **[Fact]** Four modes: `interactive` (default; stable `sessionId` for input/status), `hands-free` (poll with `sessionId` plus quiet updates), `dispatch` (notification on completion via `triggerTurn`), and `monitor` (notification on structured monitor trigger events).
- **[Fact]** Running background sessions and monitors survive `/reload` and reappear under the new extension instance. Quitting Pi or switching sessions still terminates them.
- **[Inference]** The axis is different from this project's. `pi-interactive-shell` optimizes human-visible terminal supervision: an overlay a person can watch and take over. It is not a durability layer: it has no workspace adoption and no cross-process handle that a later Pi process can adopt. `pi-async-shell` optimizes durable, agent-only execution: file-backed logs, a ready marker, output-pattern waits, and workspace recovery. A user who needs a human at the terminal should use `pi-interactive-shell`; a user who needs a build to survive Pi should use `pi-async-shell`.

### 5.2 `pi-processes@0.4.3`

- **[Fact]** npm description: *"Codex-inspired process execution for Pi on macOS and Linux"* (`pi-processes@0.4.3`).
- **[Fact]** It replaces Pi's `bash` tool with a managed process interface: calls without a mode delegate to the built-in executor, and explicit `foreground`, `background` or `service` modes create managed processes. PTY support is optional (`node-pty`), and every non-empty PTY input write requires approval.
- **[Fact]** Its tool surface includes `process_wait` (event-driven wait for up to eight processes, `until: all|any`), `process_output` (cursor or tail reads), `process_list`, and `process_kill` (SIGTERM to the owned process group, SIGKILL after 500 ms).
- **[Fact]** Retention is capped: at most 32 records, 32 MiB of raw output per runtime, and 8 MiB per process. Completed records are evicted oldest-first when the cap is reached, and admission fails only when all slots are running or pinned by readers.
- **[Fact]** Its README states: *"SIGKILL/crash can leave temporary logs behind; there is no restart recovery."*
- **[Inference]** `pi-processes` is the closest competitor on the wait-and-output axis: it has an in-turn wait, a process manager, and bounded retention. It differs on durability (no workspace adoption), on readiness (its README says service startup is not readiness), on log retrieval (cursor/tail rather than regex search over a durable log), and on platform (macOS and Linux, where this project is Linux-only).

---

## 6. Empirical Verification of the Durable PTY Recipe

The `pty` binding is built on `script(1)`, `mkfifo(1)`, `stty(1)` and Node's `detached` spawn. Each claim below was verified by running the recipe in this environment, not read from documentation:

| Claim | How it was verified | Result |
|---|---|---|
| The child owns a real terminal | `test -t 0` and `test -t 1` inside the PTY | **[Fact]** Both true; `tty` names a `/dev/pts` device |
| A FIFO stdin still yields a working terminal | Write `hello\n` to the FIFO from a second process while the child is blocked in `read` | **[Fact]** The child received the line and echoed `got:hello` |
| The size must be set explicitly | `stty size` inside a PTY whose stdin is a FIFO | **[Fact]** `0 0` without the `stty rows/cols` line, and the recorded size with it |
| The exit code survives the wrapper | `exit 7` in the child | **[Fact]** `exit.json` records `7`; `script -e` propagates it |
| ^C through the FIFO interrupts the child | Write `0x03` to the FIFO while the child sleeps | **[Fact]** The child dies with `130` — but only when the backgrounded `script` job has its SIGINT disposition reset, which is why the wrapper runs `trap - INT QUIT` before `exec` |
| The PTY outlives a hard parent exit when it has no owner watch (`workspace`) | `kill -9` the process that spawned the wrapper | **[Fact]** Wrapper, `script` and child all survive; output keeps landing in the log; a new process can still write to the FIFO |
| A watched PTY is torn down when its owner dies (`session`) | Give the wrapper a pipe from the owner and `kill -9` the owner | **[Fact]** The wrapper reads EOF and kills `script`; `exit.json` records the signal |

Two of these results changed the design. The `0 0` size would have made every replay and every TUI render at the wrong width, silently. The ignored SIGINT would have made graceful cancellation a no-op for `pty` executions, also silently.

---

## 7. Honest Comparison Matrix & Defensible Project Value

### 7.1 Comparison Across Alternatives

`bench` marks a package that is in the benchmark field. `ecosystem` marks a package described from its published artifacts only. A capability is marked `partial` when the package can do part of the thing but not the contract this project states.

| Capability | Pi Built-in `bash` (bench) | `pi-background-tasks@2.6.10` (bench) | `pi-interactive-shell@0.18.0` (ecosystem) | `pi-processes@0.4.3` (ecosystem) | `pi-async-shell` (bench) |
|---|---|---|---|---|---|
| **Zero-overhead sync execution for short commands** | **Yes (Best)** | No (extra tool/lifecycle overhead) | No (overlay lifecycle) | Yes (delegates to built-in without a mode) | **Delegates to built-in `bash`** |
| **Non-blocking start** | No | Yes (`bg_run`) | Yes (`interactive_shell`) | Yes (`mode: "background"` / `"service"`) | **Yes (`shell_start`)** |
| **In-turn causal synchronization** | Blocks unconditionally | No (forces turn end) | No (poll/status queries) | Yes (`process_wait`) | **Yes (`shell_await`: exit, ready marker, output pattern)** |
| **Output-pattern wait** | No | No | Partial (monitor stream triggers) | No | **Yes** |
| **Idle turn wake-up on completion** | N/A | Yes | Yes (dispatch/monitor) | Yes (background mode) | **Yes (coalesced, suppressed when awaited)** |
| **Durable log retention without killing verbose jobs** | Temp file on truncation (blocks until exit) | **No** (kills at 20 MiB) | Bounded session output; saved logs expire after 24 hours | Bounded (32 MiB runtime, 8 MiB per process) | **Yes (100 MiB pipe cap drains without killing; PTY recording uncapped)** |
| **Random-access & filtered log reading** | Via `read` on temp file after exit | `head` / `tail` only; merged stream | Output queries, not a durable log | Cursor/tail reads, no regex search | **Yes (`head`/`tail`/`offset`/`grep` + separate `stdout`/`stderr`/`combined`)** |
| **PTY allocation & interactive input** | No (`stdin: ignore`) | No (`stdin: ignore`) | Yes (overlay, human takeover) | Yes (optional `node-pty`, per-write approval) | **Yes (`binding: "pty"`, `shell_send`)** |
| **Rendered screen read for the agent** | No | No | Partial (bounded terminal text and screen excerpts) | No (control sequences removed) | **Yes (`stream: "ptyView"`)** |
| **Live human terminal view / takeover** | No | TUI read-only log viewer (`/tasks`) | **Yes (the point of the package)** | `/processes` manager, no live terminal takeover | **No, deliberately** — there is no attach surface (R3) |
| **Cross-Pi-process survival & re-adoption** | No | No (same-process `/reload` only) | No (quitting Pi terminates sessions) | No (README: no restart recovery) | **Yes (`scope: "workspace"`, both bindings)** |
| **Readiness marker** | No | No | Partial (file-watch monitors) | No (README: service startup is not readiness) | **Yes (`$PI_ASYNC_SHELL_EXEC_DIR/ready`)** |
| **Platform** | POSIX | POSIX | Node.js (PTY via `zigpty`) | macOS, Linux | **Linux only** |
| **Scope purity (no subagents / multi-LLM workflows)** | Yes | **No** (bundles `bg_delegate`, `bg_run_pi_attested`, `fusion_*`) | No (bundles agent spawn) | Yes | **Yes (strictly shell execution & terminal handles)** |

### 7.2 Why `pi-async-shell` Exists (Defensible Value Proposition)

`pi-async-shell` is **not** a clone of `pi-background-tasks`, **not** a TUI overlay, and **not** a thin wrapper around a terminal multiplexer. It is an independent, sharply scoped extension. It rests on three core guarantees that no existing tool in the Pi ecosystem provides together:

1. **Full-Spectrum Non-Blocking Coordination (`start` + `await` + `completion`):**
   The agent is never forced to block on a slow command, and it is never forced to end its turn when it needs a causal barrier. In `codemode`, the agent can fan out three commands with `shell_start` and edit files while they run. It then synchronizes with `shell_await({ ids: [...], mode: "all" })`, or waits for a server readiness line with `shell_await({ ids: srv.id, until: {kind: "pattern", regex: "Listening on"} })`, all within a single turn. Alternatively it ends the turn, and the completion event wakes it when it is idle.
2. **Two orthogonal choices instead of one bundled primitive:**
   Ownership (`scope`) decides when the agent stops waiting and when the process is reaped. I/O binding decides `isatty()` and stdin writability. The two are independent. Persistence needs no multiplexer, provided the data path is owned by a detached holder rather than by the owner process. A PTY needs no multiplexer either, because `/usr/bin/script` supplies one — and it needs no broker to outlive Pi, because the process holding the PTY master can be detached. Every scope combines with every binding, and both bindings promote without a respawn.
3. **Non-Destructive, Queryable Output Persistence:**
   Every execution writes durable disk logs (`stdout`, `stderr` and ordered `combined`), and it does not kill the process when the logs grow large. Retrieval is surgical: `tail`, `head`, line/byte `offset`, `grep` regex filtering, and replayed `viewport` snapshots for `pty` executions. Only the slices that decide the next step enter the LLM context.

---

## 8. Benchmark Evidence

`bench/REPORT.md` is generated by `node bench/run-bench.ts`. It loads each implementation alone into a real Pi SDK session and invokes the registered tools directly, so model latency is excluded while the code path a model would reach stays in. The field is Pi's built-in `bash`, `pi-async-shell`, and eight packages: `pi-background-tasks@2.6.10`, `pi-better-background-tasks@0.18.0`, `pi-background@0.4.4`, `pi-patty-bg-tasks@1.1.6`, `pi-async@0.4.4`, `@tduyng/pi-shell@0.0.6`, `pi-shell-jobs@0.1.2`, and `pi-exec-command@0.3.10`.

`pi-interactive-shell@0.18.0` and `pi-processes@0.4.3` are not in that field. They are described in §5 from their published artifacts, and no number in `bench/REPORT.md` belongs to them.

The benchmark pins `SHELL` and `PI_ASYNC_SHELL` to `/bin/sh`, so every implementation runs the same command language. The runtime default remains `/bin/bash` when `PI_ASYNC_SHELL` is unset.

The report answers two questions separately: what a user gets (a dev server usable in the next turn, a prompt answered after a 4000-line burst, one 2.5 s command's cost, a cancel that leaves nothing running, survival of a hard parent exit, recovery after the agent is killed) and which mechanism produces the difference (in-turn barrier, a 30 MiB log that does not kill, one line reachable in a 200k-line log, three parallel commands, completion notification). `docs/implementation-notes.md` §5 summarizes the current run; the report is authoritative.
