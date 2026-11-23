---
kind: notes
applies_to: 0.2.2
tracks:
  - src/core/registry.ts
  - src/core/log-manager.ts
  - src/extension.ts
---

# Implementation Notes

**Status:** 0.2.0. The full test suite passes. The type checker is clean. The comparison benchmark in [`bench/REPORT.md`](../bench/REPORT.md) reproduces every claim the design makes about scope, binding, output, and persistence. §6 records what changed in 0.2.0.

This document records what the code does and the decisions that are easy to get wrong. It names the test that proves each contract and the limits a reader knows before relying on the package.

---

## 1. What exists

| Phase (from `04-runtime-architecture.md` §8) | State |
|---|---|
| Phase 1 — registry, `pipe`, `session` scope, log manager, await, cancel, containment, reload handoff | Implemented |
| Phase 2 — `pty`, `shell_send`, ready marker and pattern waits, the durable FIFO recipe, `ptyView` | Implemented |
| Phase 3 — `workspace` scope, re-adoption, `lost`, writer lock, GC, `/async-shell` | Implemented |
| 0.2.0 — universal pipe supervisor, lossless promotion, Linux/procfs guards, credential filter, ready marker, partial-line patterns | Implemented |

Layout:

```text
src/extension.ts            Pi wiring: 7 tools, lifecycle hooks, /async-shell, footer status
src/core/registry.ts        handles, scopes, waiters, completion, cancel ladder, adoption, GC
src/core/spawn.ts           the two spawn recipes, the PTY wrapper, environment filtering
src/core/pipe-supervisor.mjs detached pipe owner: file logs, cap, fd 3 watch, exit record
src/core/log-manager.ts     durable output, sparse line index, drain-not-kill cap, read modes
src/core/screen.ts          terminal replay: escape parsing, cursor addressing, viewport
src/core/containment.ts     tag + identity + group fence, group signalling, absence verification
src/core/identity.ts        boot id, /proc/<pid>/stat field 22, descendant walk, tag and group scans
src/core/shell-policy.ts    /bin/bash then /bin/sh, PI_ASYNC_SHELL override, prompt line
src/core/readiness.ts       the $PI_ASYNC_SHELL_EXEC_DIR/ready marker
src/core/paths.ts           registry layout, .gitignore, garbage collection
src/core/reload-hub.ts      process-global /reload handoff slot with a claim deadline
src/core/workspace-lock.ts  one-writer lock with stale-holder detection
tests/                      process, durability, and real Pi SDK tests driven by a faux provider
bench/                      comparison harness, scenarios, and the generated report
```

---

## 2. Evidence

Run:

```bash
node scripts/link-host.mjs   # link the Pi host packages into ./node_modules
pnpm typecheck               # tsc --noEmit
pnpm test                    # node --test --test-concurrency=1 tests/
pnpm bench                   # writes bench/REPORT.md and bench/out/results.json
```

Contract-to-evidence map:

| Contract | Evidence |
|---|---|
| R1 — scope decides who reaps; the wait decides who proceeds | `registry.test.ts` (await all/any, expiry does not kill), `extension-e2e.test.ts` ("a default session execution survives agent settling"), `registry.test.ts` ("turn scope is rejected instead of acquiring settle-time semantics") |
| R2 — `workspace` + `pty` is reachable | `pty.test.ts` ("workspace + pty is a reachable cell, not a coercion", "a live pty can be promoted to workspace"), `pty-durability.test.ts` ("a workspace pty survives a hard Pi exit and is re-adopted", "a promoted pty survives the Pi that promoted it") |
| R3 — no attach surface; terminal interaction is agent-only | `pty.test.ts` ("shell_send refuses on a pipe binding"), `extension-e2e.test.ts` (the seven-tool list is asserted) |
| R4 — `pipe` keeps its data path out of the owner process | `workspace.test.ts` ("a workspace execution survives its parent and is re-adopted"), `pty-durability.test.ts` ("a promoted default pipe survives the Pi that promoted it") |
| C1 — states; readiness is a milestone | `pty.test.ts` ("a marker file declares readiness out of band"), `registry.test.ts` ("timeoutSeconds settles as timed-out through the ladder") |
| C2 — readiness is a wait condition | `registry.test.ts` ("a ready marker works without any shell_start readiness declaration"), `registry.test.ts` ("an await pattern observes only the selected stream", "a pattern wait with since=now cannot re-match an answered prompt", "an await pattern matches a prompt before a newline arrives") |
| C3 — completion is an event, not a poll | `extension-e2e.test.ts` ("three completions coalesce into one message") |
| A settle is reported once | `extension-e2e.test.ts` ("a command that settles inside the start call returns its result there", "an await that reports the settle does not announce it again", "an await in mode all holds a sibling's settle until both are reported", "an aborted await hands its held settle back to the completion channel", "a command that outlives the inline window keeps the handle and still notifies", "inlineSettleMs: 0 returns at once and leaves the completion channel alone", "inline settle handles undefined and aborted signals without losing notifications") |
| C4 — cancellation ladder + verification | `registry.test.ts` ("cancel proves the tree is gone, including a setsid escapee", "the fence reaches a child that cleared its env and lost its parent", "graceful cancel uses SIGTERM before the fence") |
| C5 — drain, never stop reading | `registry.test.ts` ("the session pipe log cap drains instead of killing or blocking the child", "the workspace pipe log cap drains instead of killing or blocking the child") |
| C6 — `(boot_id, pid, start)` identity | `workspace.test.ts` ("an unprovable workspace record becomes lost, never completed"), `identity.ts` |
| C7 — terminal interaction never changes semantics | `pty.test.ts` ("ptyView is the rendered screen, not the raw stream"), `screen.test.ts` (ten cases) |
| C8 — replay safety is declared | `registry.test.ts` ("a request id makes shell_start replay-safe"), `pty.test.ts` ("a request id makes shell_send replay-safe") |
| C9 — `shell_await` is the short form | Prompt guidelines; `extension-e2e.test.ts` uses it for a short command |
| C10 — one writer, read-only observers | `workspace.test.ts` ("one writer owns the workspace; a second process is read-only", "a read-only observer never adopts workspace handles") |
| `/reload` handoff | `reload.test.ts` ("a claimed registry keeps its live handles across the reload"), `extension-e2e.test.ts` ("/reload hands live handles to the new activation") |
| GC safety | `maintenance.test.ts` ("GC removes expired terminal history but never running or current-session records", "GC count eviction keeps the newest terminal records and observes a grace period", "registry initialization creates a non-destructive gitignore") |
| Shell policy, credential filter, Linux guard | `maintenance.test.ts` ("the default command shell is bash, not the ambient non-POSIX login shell", "sensitive ambient variables are filtered and explicit env values win", "non-Linux platforms fail clearly instead of returning an empty process tree") |
| Log reads | `log-manager.test.ts` (index, head, tail, offset by line and byte, grep, maxBytes, ANSI, empty log) |

---

## 3. Implementation Decisions Worth Recording

### 3.1 Every execution's output is file-backed from spawn

The first design gave `session` pipes an in-process tee and only `workspace` pipes a file. That made promotion impossible for the default binding. A live process's descriptors cannot be rebound. A promoted pipe would have kept writing into a pipe whose reader died with Pi.

0.2.0 makes the detached pipe supervisor universal. At both scopes the child's stdout and stderr are pipes owned by `pipe-supervisor.mjs`, which writes `stdout.log`, `stderr.log` and `combined.log`. The only scope difference is the fd 3 owner watch. Promotion writes `release\n` into that watch, and the supervisor stops watching without touching the command. The same process, pid and files continue. No byte is lost at the transition.

Evidence: `pty-durability.test.ts` — "a promoted default pipe survives the Pi that promoted it". `workspace.test.ts` — "a promoted default pipe record enters the workspace scan".

### 3.2 `ptyView` is a rendered screen, and the runtime writes the recording

util-linux 2.42 `script` writes localized start/done headers into its typescript file even with `-q`. The runtime passes `/dev/null` as that file and binds `script`'s own stdout to `combined.log`, so the headers never reach the log. `stdout.log` and `ptyView.log` are symlinks to that one recording: a PTY merges both streams, so three names for one file is the honest layout.

`shell_read({ stream: "ptyView" })` returns the viewport instead of those bytes. It replays the tail of the recording through the screen model in `src/core/screen.ts`. A carriage return overwrites the line. Cursor addressing redraws in place. An erased line is gone. Output that scrolled past the height is out of view. A prompt that was drawn forty times answers "what is on the screen" with one frame. The raw stream is still available as `combined`.

The model covers the sequences a terminal UI emits (CR, LF, BS, TAB, CSI cursor motion and erase). It also covers line and character insertion and deletion, and save/restore. It consumes the rest without printing it. The model omits wide characters and the alternate screen buffer. §4 lists both.

### 3.3 `script(1)` runs its command through `$SHELL`

On this machine `$SHELL` is Nushell, so `script -c "<posix command>"` would hand a POSIX script to a non-POSIX parser. The PTY recipe generates a launcher that embeds the command and runs `script -c "sh <launcher>"`. `script` never parses the command itself. The launcher then runs the configured command shell (`/bin/bash` by default, or `PI_ASYNC_SHELL`).

### 3.4 `combined.log` has one writer per binding

A `pipe` execution's combined log is the supervisor's arrival-order tee of stdout and stderr, which is the ordering a terminal would show. A `pty` execution's combined log is the `script(1)` recording, which carries CRLF and echoed input. Both are observations of one stream, not a second source of truth. `shell_read` normalizes CRLF for a line-oriented read.

### 3.5 The ready marker needs a path the program can write

The convention is `$PI_ASYNC_SHELL_EXEC_DIR/ready`, so every spawn exports `PI_ASYNC_SHELL_EXEC_DIR` (and `PI_ASYNC_SHELL_EXEC` for containment). A program writes `touch "$PI_ASYNC_SHELL_EXEC_DIR/ready"`, and the registry observes it on the next poll or await. Without the variable the convention would be unusable from a command that does not know its own execution directory.

### 3.6 The shell policy is fixed, with one explicit override

When the environment sets `PI_ASYNC_SHELL`, `resolveShell` returns that value. Otherwise it returns the first of `/bin/bash` and `/bin/sh` that exists. The runtime ignores ambient `$SHELL`. A login shell is not necessarily a POSIX script interpreter. Inheriting Nushell here would change the command language silently. The active tools' prompt guidelines carry the chosen shell and its origin. The POSIX shell set excludes `fish`. Diagnostics classify an explicit `PI_ASYNC_SHELL=fish` as non-POSIX.

Evidence: `maintenance.test.ts` — "the default command shell is bash, not the ambient non-POSIX login shell".

### 3.7 Completion coalescing has a short debounce, and steering is the default

Three commands that settle within a few milliseconds of each other would otherwise produce three messages for one decision. Deliveries therefore wait one 150 ms window. Every record is still delivered. Only the number of messages collapses. A `workspace` record never starts a turn. Its `notifyOnCompletion` defaults to false. The runtime delivers a record surfaced at `session_start` as a next-turn message.

While the agent is running, the runtime steers a record in before the next LLM call. A completion that lands mid-run therefore informs the next decision instead of arriving after the run is over. `delivery: "settle"` holds it for `agent_before_settle`, which injects it with `continue: true` and keeps the run alive for it. This package's settle boundary defines the second mode, not Pi's `deliverAs: "followUp"`. A follow-up message arrives at the same tool-batch boundary as a steer message. It is not an opt-out from mid-run delivery.

Evidence: `extension-e2e.test.ts` — "three completions coalesce into one message". The same file covers "a completion steers into the next LLM call of a running turn". It also covers "delivery settle holds a completion until the run has no more work".

### 3.8 `/async-shell` is a list plus a select menu

The design describes a list plus per-handle actions. 0.2.0 renders the list through `ctx.ui.notify` and offers `read tail` / `cancel` through `ctx.ui.select`, plus the `run`, `cancel`, and `read` subcommands. The footer status widget matches the design. A full overlay would be presentation work that does not change any contract.

### 3.9 The `pty` recipe is detached, file-bound and FIFO-fed

The first `pty` recipe spawned `script` with three pipes owned by Pi. That made the PTY a child of the Pi process in every way that matters. A `kill -9` left `script` and its grandchild alive with their output silently discarded. No later Pi process could reach them. The old design text turned that accident into a rule ("a PTY master cannot outlive Pi"), which was wrong.

The recipe now binds `script`'s stdout to `combined.log`. The child gets a FIFO for stdin, held open read-write by the wrapper. The whole tree runs in its own session. Nothing in the data path belongs to Pi. The execution therefore survives a hard exit, and a later Pi process can still type into it. Two details separate working from silently broken. The launcher applies the size recorded at spawn time (`stty rows/cols`), because a FIFO stdin leaves the slave at `0 0`. The backgrounded `script` job resets SIGINT/SIGQUIT, because a background job inherits them ignored and ^C would otherwise never reach the child.

### 3.10 Adoption requires the writer lock

Unless this process owns the workspace lock, `adoptWorkspace()` returns nothing. An observer still reads status and logs from disk, but it never becomes an owner by accident (C10). Surfacing a workspace completion also writes a `.surfaced` marker, so it is writer-only for the same reason.

### 3.11 Sensitive environment variables are filtered by default

`filterEnvironment` drops keys matching `*_API_KEY`, `*_API_SECRET`, `*_SECRET_KEY`, `*_ACCESS_TOKEN`, `*_AUTH_TOKEN`, `*_SESSION_TOKEN`, `*_PRIVATE_KEY`. It also drops an exact set of common cloud and registry tokens: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AZURE_CLIENT_SECRET`, `DOCKER_AUTH_CONFIG`, `GH_TOKEN`, `GITHUB_TOKEN`, `GITLAB_TOKEN`, `GOOGLE_APPLICATION_CREDENTIALS`, `HF_TOKEN`, `NPM_TOKEN`. Explicit `shell_start.env` values win, which is also how a caller restores one variable deliberately. The filter is not a sandbox. A command still has the user's filesystem and network permissions. Tool arguments can enter the session transcript.

Evidence: `maintenance.test.ts` — "sensitive ambient variables are filtered and explicit env values win".

### 3.12 GC removes only sealed, terminal records

The registry creates `.pi/async-shell/.gitignore` containing `*` with the no-replace flag, then runs GC at construction and hourly. It removes terminal records older than 24 hours, and terminal records beyond the newest 100 once they are at least five minutes old. GC leaves untouched a running or nonterminal record, a record protected by a loaded handle, and a record in the current session directory. The same pass removes orphan request records older than the retention window.

Evidence: `maintenance.test.ts` — the three GC and gitignore tests.

### 3.13 A settle is claimed by the call that reports it

For `inlineSettleMs`, `shell_start` holds its own result. A command that ends immediately then costs one tool round trip instead of two. The ordering is the whole design. `finalize` hands the record to `onSettle` before any waiter observes the terminal state. A wait that starts afterwards is therefore too late to suppress the completion message.

The fix is a claim taken before the wait, not a flag applied after it. A call that will report outcomes claims every id it names, and `onSettle` holds a record for a claimed id instead of queueing it. A held record starts no coalescing window, so a settle that lands while the call still waits for a sibling cannot leave as a completion message. When the call returns and it was not aborted, it consumes the terminal outcomes it reports: the held record is dropped, any record already in the queue is withdrawn, and the id is marked delivered. Releasing the claim returns whatever it still holds to the completion channel. That release is what keeps an abort, an expired wait, a readiness wait and a `mode: "any"` wait whose other handles settle later correct. Claims are reference-counted, because two waits can name one handle.

An aborted wait is not a delivery, because its result may never reach the model. `awaitHandles` therefore marks `consumedByAwait` only for a waiter that can still report: an abort returns the outcomes it observed and leaves the flag, its metadata and the completion record alone.

The same rule covers a `workspace` record. An await that consumed one already delivered it as a tool result, so `workspaceCompletions` marks the record `.surfaced` instead of offering it at the next `session_start` as news from an unwatched execution.

No execution changes state because a call stopped waiting.

Evidence: `extension-e2e.test.ts` — "an await in mode all holds a sibling's settle until both are reported", "an aborted await hands its held settle back to the completion channel"; `workspace.test.ts` — "a workspace completion an await reported is not surfaced again".

### 3.14 Timeout and await observe finalized cleanup, not status labels

`enforceTimeout` sets the `timed-out` label early. The runtime seals the record only after the graceful signal, the grace period, the fence and `verifyGone`. While the captured identity is still alive, the exit watcher refuses to finalize. A supervisor's `exit.json` therefore cannot make a still-running tree look settled. `shell_cancel` waits for the same `finalized` event rather than for a status string. This is what makes "cancel returns after the tree is gone" true rather than aspirational.

---

## 4. Known limits of 0.2.0

- **Linux only.** Process identity, containment, the PTY recipe and the pipe supervisor's `/proc/self/stat` read are load-bearing. On a non-Linux platform the runtime fails with an explicit error. When procfs is unreadable, it fails the same way rather than returning an empty process tree.
- **The writer lock is advisory.** The lock uses `O_EXCL` plus a liveness check on the holder's identity. A process that ignores the lock can still write.
- **`pty` has no separate stderr.** A PTY is one stream. `stderr.log` stays empty, and `shell_read` says so.
- **A `pty`'s `combined.log` is the terminal recording.** The child owns a real PTY. The file therefore carries CRLF and echoed input rather than the child's raw bytes. Reads normalize CRLF. `stripAnsi: false` returns the recording verbatim.
- **The pipe cap does not apply to a `pty` recording.** `script(1)` writes the file directly. There is no pipe to pause and no writer to stop, so the file grows. Nothing kills the process. Nothing bounds the file either. For a long-lived, verbose PTY program, use `timeoutSeconds` and storage monitoring.
- **`ptyView` is a viewport, not a scrollback.** The replay window is the tail of the recording (256 KiB minimum). The screen model omits wide characters and the alternate screen buffer. A TUI that paints with wide glyphs can render narrower than the real terminal did.
- **A `workspace` handle without an exit record and without provable liveness is `lost`.** It is never reported as `completed`.
- **Containment has a detection floor.** The fence unions three views: environment tag, ppid tree, and owned process groups. A child that runs `env -i` and outlives its parent is still found. One case stays out of reach: a child that also calls `setsid(2)` between scans. It has no tag, no parent edge, and no group of ours.
- **`shell_await` blocks the tool call.** A tool call cannot be suspended here. A long wait therefore ends the turn and lets the completion message resume it. `waitMs` defaults to 30 s and caps at 50 s.
- **Completion coalescing uses a fixed 150 ms idle window.** Three commands that settle together produce one wake-up. The window does not adapt.
- **The credential filter is a default, not a guarantee.** The filter misses an unusually named variable. It also misses a secret on a command line.

---

## 5. Benchmark Summary

Full report: [`bench/REPORT.md`](../bench/REPORT.md). Each implementation loads alone into a real Pi SDK session, and the harness invokes its registered tools directly. The numbers therefore compare the implementations rather than a model. The field holds Pi's built-in `bash`, `pi-async-shell`, and eight packages: `pi-background-tasks@2.6.10`, `pi-better-background-tasks@0.18.0`, `pi-background@0.4.4`, `pi-patty-bg-tasks@1.1.6`, `pi-async@0.4.4`, `@tduyng/pi-shell@0.0.6`, `pi-shell-jobs@0.1.2`, and `pi-exec-command@0.3.10`.

The first table asks what someone adopting this would notice. The second asks why the difference exists. Both quote the committed run.

| What a user gets | pi-async-shell | pi-background-tasks |
|---|---|---|
| A dev server started in one turn answers in the next | yes, 1 call to know it is ready | yes, 8 log polls |
| A prompt after a 4000-line burst can be answered | yes, PTY, answered | no, prompt visible, no stdin |
| One 2.5 s command: time, context, calls to the answer | 2535.5 ms, 679 B, 3 calls | 2519.7 ms, 12.9 KB, 3 calls |
| Cancel a runaway: output kept, nothing left running | yes, 0 leftovers | yes, 0 leftovers |
| Output recovered after the agent is killed and restarted | yes, 40/40 lines | no, no handle, no log |
| A task survives a hard parent exit | yes, 25/25 lines | no, 4/25 lines |

| Mechanism | pi-async-shell | pi-background-tasks |
|---|---|---|
| In-turn causal barrier | yes (0 turn boundaries) | no (1 turn boundary) |
| 30 MiB log does not kill the process | yes, 31.4 MB logged | no, killed at 20 MiB |
| One line of a 200k-line log is reachable | yes, 363 bytes, 1 call | no, 102 KB, 2 calls |
| Three parallel commands overlap | yes, 447 ms | yes, 426 ms |

Two rows are not a contest, and the report says so. Both implementations leave nothing running after a cancel. Both keep a dev server reachable across a turn boundary. What differs in the dev-server row is the cost of knowing the server is up, not whether it works. `patty` also survives a hard parent exit (25/25 lines). It is the only other package in the field that does.

The harness measures admission latency after one unmeasured warmup call. The percentiles therefore describe the start path rather than module loading:

| Admission | pi-async-shell | pi-background-tasks | pi-better-background-tasks |
|---|---|---|---|
| median | 1.6 ms | 3.1 ms | 96.3 ms |
| p95 | 2.1 ms | 3.5 ms | 118 ms |
| first call in the process | 1.5 ms | 2.1 ms | 100 ms |

The median is the stable number, and even it moves with machine load. The committed report quotes the run it came from. The first call in a process is module loading and JIT, not admission.

---

## 6. What Changed in 0.2.0

### Removed

- **`turn` scope**, its `agent_before_settle` forced cancellation, and the `async-shell-error` continuation injection. A turn boundary no longer kills a `session` execution.
- **`shell_start.readiness`** and the `marker` / `pattern` / `immediate` declaration. The ready marker is `$PI_ASYNC_SHELL_EXEC_DIR/ready`, and patterns are `shell_await` conditions.
- **`cancelOnFirstFailure`**, which only had meaning inside a turn-scoped group.
- **The rule that a `pipe` execution cannot be promoted.** It described parent-held pipes, not the model.

### Added

- **A universal detached pipe supervisor** with file logs, an fd 3 owner watch, and an explicit `release` line. Both bindings promote to `workspace` without a respawn.
- **A single readiness marker** at `$PI_ASYNC_SHELL_EXEC_DIR/ready`, and output-pattern waits that can match a partial, non-newline prompt.
- **Linux and procfs guards** with explicit errors on unsupported systems.
- **Automatic `.pi/async-shell/.gitignore`** plus startup and hourly GC for expired terminal records and orphan request keys.
- **Default credential filtering** with explicit `shell_start.env` overrides.
- **A bundled async-shell skill** for server, test, readiness, promotion, and PTY workflows.
- **Publishing metadata** and a dry-run-verified npm package layout.

### Changed

- Commands use `/bin/bash -c` by default, falling back to `/bin/sh`. Ambient `$SHELL` no longer selects a non-POSIX command interpreter. `PI_ASYNC_SHELL` is the explicit override.
- Both pipe scopes use detached, file-backed logging. The pipe log cap drains surplus output without killing or blocking the command.
- `shell_await` `waitMs` now defaults to 30000 and has a maximum of 50000 to fit codemode's 60-second default budget.
- Tool schemas and prompt guidance use the smaller `session`/`workspace` contract.
- Benchmark readiness now comes from `shell_await` output patterns. The harness regenerates `bench/REPORT.md`.

### Fixed

- Active prompt guidelines carry the shell policy.
- Timeout and cancellation waits observe finalized cleanup rather than premature terminal labels or supervisor exit records.
- Promoted executions retain durable metadata and workspace adoption links.
- Long-lived children no longer inherit common LLM keys, tokens, and credential variables by default.
- The local protected-paths integration covers `shell_start` commands and `shell_send` PTY input as well as `bash` redirections.
