# 01. The Mental Model

## 1. Thesis

An execution blocks an agent for one reason: **its completion is a precondition for leaving the scope that the agent is currently inside**. Duration is not the reason.

A 40-minute build blocks. A 40-minute build whose owner is the session does not block. Both take the same time.

**Corollary.** "Make it asynchronous" does not mean "move it to the background". It means "give its completion a different precondition". That is, change which owner is responsible for the execution, and change when that owner may exit.

---

## 2. Why "background task" is the wrong primitive

The phrase fuses three decisions. Each one varies independently:

1. **Ownership** — who must wait for completion, and at which boundary.
2. **I/O binding** — where the bytes go, and whether a terminal is involved.
3. **Persistence** — what happens to the process when that owner exits.

A fused bundle asserts implications without stating them, and some of those implications are false. Two of them appeared in this project's own earlier draft. This document corrects both:

- **False:** cross-process persistence requires a terminal multiplexer.
  **Actual:** persistence requires that the execution hold no file descriptor owned by Pi, and that it live in a session that is not Pi's. A detached supervisor that writes file-bound logs achieves that with no broker. Verified present on this machine: `/usr/bin/setsid`, `/usr/bin/nohup`.
- **False:** PTY semantics require a terminal multiplexer.
  **Actual:** a PTY is a kernel object. `/usr/bin/script` allocates one around a command, with no external process (`script -q -f -e -c CMD LOG`). Verified present on this machine. `node-pty` is absent from the Pi dependency tree, and it is not needed.

A terminal multiplexer buys something narrower and more specific: **a PTY master owned by a long-lived broker, so that a third party can attach to the same terminal later.** This project does not sell that. It sells a PTY whose master lives in a detached `script(1)` process, which is enough for the execution to outlive Pi and not enough for a human to take the terminal over. The trade is deliberate; see R3.

---

## 3. Dimension A — Supervision Scope

**A scope is the owner that guarantees cleanup and that must not exit while the execution runs.**

| Scope | Owner | Owner may exit while running? | On owner exit | Completion notification | Promotable to |
|---|---|---|---|---|---|
| `session` | The Pi session | Yes — the turn ends freely | Cancelled on `session_shutdown` (survives same-process `/reload`) | `<async-shell-completion>` follow-up, coalesced | `workspace` |
| `workspace` | The workspace on disk | Yes — even Pi exits | Left running; re-adopted by a later Pi process | None by default; surfaced on next `session_start` | — |

`session` is the default, and it is the reason `shell_start` does not block. `workspace` is the only scope that survives Pi, and it is reached either at start or by `shell_promote`.

### Derived rule R1 — Scope decides who may reap; the wait decides who may proceed

If the owner cannot exit while the execution runs, the current turn cannot proceed past that execution. Choosing `session` instead of a synchronous call is what lets the turn end; choosing `workspace` additionally lets Pi exit.

R1 first read "blocking is a consequence of scope". That statement is true only where waiting and owning consume the same resource. They are two questions, and the corrected rule states both:

> **Scope decides who may reap the process. The wait decides who may proceed. Ending the turn is what lets those two answers differ.**

`session` scope means the conversation may end while the session still owes the execution a cleanup. `workspace` scope means even the session's exit does not end that debt. `shell_await` narrows the wait for one tool call. It changes neither.

This dissolves the "coordination axis" that the earlier draft treated as independent. The practical mapping is:

- built-in `bash` blocks the call and has no handle;
- `shell_start` defaults to `session`, which is precisely what makes it non-blocking;
- `shell_promote` moves a live execution to `workspace`. That operation is the honest name for what people call "backgrounding".

### The anti-pattern this rules out

Unsupervised concurrency is the known failure mode of `go func()`, `GlobalScope.launch()` and `tokio::spawn()`. The work has no owner, nothing cancels it, and nobody observes its failure. This model forbids that structure. Every handle has exactly one scope. Escalation is an explicit verb (`shell_promote`). Narrowing is temporary, lasts one tool call (`shell_await`), and never changes ownership.

---

## 4. Dimension B — I/O Binding and Terminal Reach

| Binding | stdio | `isatty()` | Agent can write stdin | Third party can attach | PTY master lives in |
|---|---|---|---|---|---|
| `pipe` | OS pipes owned by a detached supervisor, written to `stdout.log`, `stderr.log`, `combined.log` | No | No | No | — (no PTY) |
| `pty` | PTY slave | **Yes** | Yes (`shell_send`, through a FIFO) | No | A detached `script(1)` process |

### Derived rule R2 — `workspace` + `pty` is reachable

R2 first read: *"`workspace` + `pty` is infeasible; a PTY master cannot outlive Pi."* That is false. A PTY is a kernel object, and its master lives in whichever process holds it. Hold it in a process that is not Pi — a detached `script(1)` — and the PTY outlives Pi exactly as a file-bound pipe does.

The real limitation was the missing spawn recipe, not a property of PTYs. The recipe has three parts:

1. `script(1)` writes its recording straight to the log file, so no descriptor of Pi's is in the data path.
2. The child's stdin is a FIFO that the wrapper holds open read-write, so the child never sees EOF when no writer is attached, and a later Pi process can still attach one.
3. The wrapper is spawned detached, so it is in its own session and Pi's exit sends it no signal.

One recipe serves both scopes. What differs is only the owner watch: a `session` execution is given a pipe from Pi whose EOF tears the PTY down, while a `workspace` execution is not, so it survives and is re-adopted.

### Derived rules R3 and R4

- **R3.** No binding grants a third party a live terminal, and none is meant to. Terminal interaction is `pty` plus `shell_send` for input and `shell_read(stream: "ptyView")` for the rendered screen. `ptyView` replays the recording rather than mirroring a live terminal, so it can never alter supervision, ownership, buffering or exit semantics. A human who wants the terminal itself runs the command under their own multiplexer; this extension does not become one.
- **R4.** `pipe` must keep its data path out of the owner process. The child's stdout and stderr are owned by a detached supervisor that writes the log files; a pipe held by Pi is the failure mode. `pi-background-tasks` cannot survive a hard Pi exit because the child writes into a pipe whose read end dies with Node, and the next write returns `EPIPE`/`SIGPIPE`. This project applies R4 to every pipe execution, not only to `workspace`: the supervisor is detached and file-backed, so a `session` pipe can be promoted later without a respawn.

---

## 5. The Space: 2 Scopes x 2 Bindings

| Scope \ Binding | `pipe` | `pty` |
|---|---|---|
| **`session`** | **Companion process.** Mock server, indexer, watcher that must outlive the turn but not Pi. Promotes to `workspace` without a respawn. | **Agent-driven TUI.** Agent interacts through a FIFO; dies with Pi. Promotes to `workspace` without a respawn. |
| **`workspace`** | **Fire-and-forget batch.** Six-hour build, training run, migration. File-bound logs; survives Pi exit; re-adopted on next start. | **Resident terminal.** Survives Pi exit, is re-adopted on the next start, and the agent can still type into it through the FIFO. |

Four cells, all reachable, no coercion and no broker. The space was 3 x 2 while `turn` existed; 0.2.0 removed that row. A caller that needs a causal barrier inside one turn uses `shell_await`, not a narrower owner.

**The interactive half of the matrix has been reduced deliberately.** An earlier draft carried a third binding, `pane`, backed by Zellij, and an eighth tool, `shell_attach`, which surfaced a pane to a human. Both are gone: the `pane` binding is removed, there is no third-party attach surface, and terminal interaction is limited to `pty` + `shell_send` + `ptyView` replay. Attach was the only capability the multiplexer bought, and it bought it by making the extension responsible for a terminal a human might be sitting in — a presentation concern that does not belong in a supervision model.

---

## 6. Cross-Cutting Contracts

These contracts are orthogonal to both dimensions. Every execution satisfies all ten.

### C1. Lifecycle states, with readiness separated from liveness

`starting -> running -> {completed | failed | cancelled | timed-out | lost}`, plus an *optional* `ready` milestone recorded as a timestamp rather than a state. Readiness is a distinct question from liveness. A process can run and not yet be ready, and it can be ready and later fail. Kubernetes encodes this as three probes for exactly this reason.

`lost` is specific to `workspace` scope: a re-adopted execution whose liveness could not be verified after a Pi restart.

### C2. Readiness is a wait condition, not a spawn option

Scraping stdout for `Listening on` is the fragile form. The robust form is an out-of-band signal: the marker file `$PI_ASYNC_SHELL_EXEC_DIR/ready`, which every command can create after its own health check. The model is `sd_notify(READY=1)` for systemd `Type=notify` units. `shell_start` has no readiness parameter. The marker and output patterns are both conditions on `shell_await`: `until: {kind: "ready"}` and `until: {kind: "pattern", regex, stream, since}`. Regex on output remains available, because most third-party programs will never emit a marker.

### C3. Completion is an event, never a poll

Polling is defensible only when no event source exists. Here one exists. A terminal state produces a durable completion record, and, when notification is enabled, a follow-up message wakes an idle Pi session. `shell_status` exists for deliberate inspection, and it carries an explicit prompt guideline that tells the model not to loop on it.

### C4. Cancellation is a ladder, owned by the tree

Graceful signal, grace period, forced kill, then verification that the tree is gone. Cancelling *the wait* is a different operation from cancelling *the work*. Node draws the same distinction between an aborted `AbortSignal` on a consumer and aborting the underlying operation. Go draws it between cancelling a consumer's context and cancelling the producer's.

### C5. Output is durable and the drain never stops

A log cap must never terminate the process, and it must never stop draining the pipe. On Linux a pipe holds 64 KiB by default, and after that the child blocks in `write(2)`. A cap that pauses reading turns a logging policy into a hang. Every `pipe` execution's output is file-backed through the detached supervisor, which continues to drain while it discards the bytes beyond the cap. A `pty` recording is written by `script(1)` directly to disk, so it has no pipe to pause and no cap: the file grows until an operator or the filesystem stops it.

### C6. Identity is stable and PID-reuse-safe

Every execution has an id, a durable metadata record, and enough identity to prove liveness later. A bare pid is not enough. After a crash the identity is `(boot_id, pid, process start time from /proc/<pid>/stat field 22)`. PID reuse is the real difficulty of persistence, and it is independent of binding. That independence is further evidence that persistence needs its own vocabulary, rather than a place on the binding axis.

### C7. Terminal interaction is agent-only and never load-bearing

There is no human attach surface. The agent reaches a terminal through `shell_send` (input) and `shell_read(stream: "ptyView")` (the rendered screen), and neither changes scope, ownership, buffering or exit semantics. A replay is a view of a recording, so reading the screen can never alter what the program sees.

### C8. Replay safety is declared, not guessed

Every mutating tool states whether re-running it after a crash is indistinguishable from running it once. `shell_read` and `shell_status` are safe. `shell_start` and `shell_send` are not, because a second build is a second build and a second answer is a second keystroke. An interrupted unsafe call yields an honest `unknown` result, never a silent duplicate. Where the host offers a replay policy, that policy is the declaration. Where it does not, an explicit request id gives the same protection through no-replace publication.

### C9. `shell_await` is the short form; ending the turn is the long one

A tool call in `pi-coding-agent` cannot be suspended, so `shell_await` blocks for as long as it waits. It is therefore correct only for waits short enough that crossing a turn boundary would cost more than it saves. `waitMs` defaults to 30000 and is capped at 50000, which leaves room in codemode's 60-second default script budget. Do a wait measured in minutes by ending the turn. The conversation suspends at zero cost, the completion event resumes it, and the handle registry on disk is the checkpoint. The rule itself is the deliverable. A wait measured in minutes is not a `shell_await`; it is the long form.

### C10. One writer per workspace; observers are read-only

Exactly one process may adopt `workspace` handles for a given directory. Other processes open the registry read-only, and they may read status and logs. `shell_promote`, `shell_send` and `shell_cancel` refuse rather than race the owner. Adoption requires the writer lock, and a process that cannot take the lock never becomes an owner by accident.

---

## 7. Prior Art Each Decision Comes From

| Decision | Where it comes from |
|---|---|
| Completion gates the **owner's** exit, not the command's duration | Structured concurrency: Smith 2018, *Go statement considered harmful*; Trio nurseries; Kotlin `coroutineScope`; Swift task groups; Python 3.11 `asyncio.TaskGroup`; Java `StructuredTaskScope` (JEP 453, previewed in JDK 21) |
| Escalating an execution to a wider owner must be explicit and supervised | The same lineage, which exists chiefly to eliminate `GlobalScope.launch()` / bare `go func()` leaks |
| Cancellation is a ladder owned by a process tree | POSIX job control: `setsid(2)`, process groups, `kill(-pgid)`, `SIGTERM` then `SIGKILL` |
| Separating stdio binding from controlling terminal | POSIX job control and `daemon(7)`: new session, stdio off the controlling terminal, disposition reset |
| A PTY master outlives its creator when the holder is detached and its stdio is file-bound | `script(1)` plus `setsid(2)`; the `daemon(7)` checklist; `dtach` and `abduco` for the narrower claim that a PTY can be handed to a later client |
| Readiness as an explicit protocol | `sd_notify(READY=1)`, systemd `Type=notify` |
| started / ready / alive are three questions | Kubernetes `startupProbe` / `readinessProbe` / `livenessProbe` |
| Do not poll; await an event | `etcd` watch, Kubernetes watch, and Pi's own `agent_settled` boundary |
| Backpressure must be drained or the child blocks | Pipe capacity semantics; `SIGPIPE`/`EPIPE`; `fpathconf(_PC_PIPE_BUF)` |
| Driving interactive programs by pattern/response | `expect`, `pexpect`; the mature form is a declarative expect spec, of which `shell_await(until: pattern)` + `shell_send` is the manual loop |
| Cancel the wait != cancel the work | `AbortSignal` versus the operation handle; Go context on a consumer versus on a producer; stated outright by Pi Durable: *"Cancelling a wait only cancels that wait, never the work."* |
| A wait and an ownership are different questions | Pi Durable's **park**: *"A tool that waits ... returns a park instead of a result ... The call then holds no process."* The mechanism is unavailable here; the distinction is not |
| Replay safety is declared per operation | Pi Durable's `replay: "safe"`, with `interrupted` as the honest outcome otherwise |
| One writer, many read-only observers | Pi Durable's storage ownership and `readOnly: true` sessions; the rule transfers, the implementation is our own lock |
| Crash loops must terminate | Pi Durable's `restartLimit`, and systemd's `StartLimitBurst` before it; here the re-adoption attempt counter |
| A process tree is discovered, not assumed | `pi-durable-subagents`: `DSA_EXEC` environment tagging plus `(pid, start)` identity and a scan-and-kill fence loop |

---

## 8. What Changed From the Previous Draft

1. The earlier 2x2 is gone. Its vertical axis bundled PTY semantics with cross-process persistence, which produced the false rule "persistence requires a carrier process". Persistence is now `scope: workspace`, available to `pipe` bindings, which is the common case.
2. The horizontal axis is no longer independent. Ownership determines blocking (R1). "Blocking vs non-blocking" is now derived rather than chosen.
3. PTY and multiplexer are separated. `pty` is a kernel facility reachable with `script(1)`, and it needs no broker at any scope.
4. Readiness, expected-prompt interaction, `lost` state, and PID-reuse-safe identity are now first-class, because the prior-art table shows each of them is standard practice that the earlier draft omitted.
5. **A wait and an ownership are now separate questions** (C9, refined R1), and **a workspace has one writer** (C10). Both come from reading `@earendil-works/pi-durable`, which is not a host this project supports. See `05-durability-and-containment.md` for the translation into `pi-coding-agent` terms.
6. **The vocabulary is now fixed in one place** (`00-terminology.md`), and the documents are numbered `00` to `05`. `carrier` is retired as a term, and `03-carrier-and-runtime-architecture.md` is now `04-runtime-architecture.md`. The rename is recorded in `05-durability-and-containment.md` §8 so that old links are accounted for.
7. **The `pane` binding and the `shell_attach` tool are removed, and the old R2 claim is retracted.** A PTY master does outlive Pi when the process holding it is detached and its stdio is file-bound, so `workspace` + `pty` needs no broker. The multiplexer was only ever buying third-party attach, and attach is out of scope (R3).

### 8.1 Changes in 0.2.0

- **`turn` scope is removed**, with its settle-time forced cancellation and its error continuation. A turn boundary never kills a `session` execution. A caller that needs a barrier inside one turn uses `shell_await`.
- **`shell_start.readiness` is removed.** The marker is `$PI_ASYNC_SHELL_EXEC_DIR/ready`, and patterns are `shell_await` conditions. `immediate` readiness is gone with the declaration.
- **Every `pipe` execution's output is file-backed through a detached supervisor**, so a `session` pipe promotes to `workspace` without a respawn. The earlier rule that a pipe cannot be promoted was a consequence of parent-held pipes, not of the model.
- **The pipe cap covers every pipe scope** and drains without killing. The earlier claim that a file-backed pipe has no cap described the old `workspace`-only file binding; the supervisor now owns the cap for both scopes. A `pty` recording remains uncapped.
- **`cancelOnFirstFailure` is removed** with `turn` scope; it cancelled siblings inside a turn group that no longer exists.
- **The default command shell is `/bin/bash` then `/bin/sh`**, and ambient `$SHELL` is ignored. `PI_ASYNC_SHELL` is the explicit override.

---

## 9. Document Map

- **[00. Terminology](00-terminology.md)** — the definition of every load-bearing term, the conflation each one guards against, and the words this project retired.
- **[01. The Mental Model](01-overview.md)** — the two axes, the 2 x 2 space, the derived rules R1 to R4, and the ten cross-cutting contracts C1 to C10.
- **[02. Ecosystem Survey and Value](02-ecosystem-survey-and-value.md)** — verified facts about Pi 1.5.2 and the installed extensions and packages, including `pi-background-tasks@2.6.10`, `pi-interactive-shell@0.18.0` and `pi-processes@0.4.3`, with an honest comparison.
- **[03. Execution Model and Primitives](03-execution-model-and-primitives.md)** — the seven tool contracts, selection procedure, state machine, and completion semantics.
- **[04. Runtime Architecture](04-runtime-architecture.md)** — how each binding is spawned, how containment is enforced, how output stays durable, how reload and re-adoption work, and how storage is collected.
- **[05. What Pi Durable Suggests](05-durability-and-containment.md)** — a translation table from Pi Durable's mechanisms to `pi-coding-agent` primitives, the refinement it forced on R1, where the borrowing stops, and the process-containment gap neither first-party project covers.
