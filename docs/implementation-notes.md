---
kind: notes
applies_to: 0.2.3
tracks:
  - src/core/registry.ts
  - src/core/records.ts
  - src/core/log-manager.ts
  - src/core/keys.ts
  - src/core/utf8.ts
  - src/core/pattern.ts
  - src/core/spawn.ts
  - src/core/paths.ts
  - src/presentation.ts
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
src/presentation.ts         every string a person or a model reads back, types only below it
src/core/registry.ts        handles, scopes, waiters, completion, cancel ladder, adoption, GC
src/core/spawn.ts           the two spawn recipes, the PTY wrapper, environment filtering
src/core/pipe-supervisor.mjs detached pipe owner: file logs, cap, fd 3 watch, exit record
src/core/recording-writer.mjs bounded pty recording: drain, append to the cap, drop the rest
src/core/records.ts         atomic JSON, log deltas, the stdin FIFO, a replay key's file name
src/core/log-manager.ts     durable output, sparse line index, drain-not-kill cap, read modes
src/core/utf8.ts            where a byte window may end
src/core/keys.ts            key names to the bytes a terminal would have sent
src/core/pattern.ts         the bounded pattern compiler shared by grep and await
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
| R1 — scope decides who reaps; the wait decides who proceeds | `registry.test.ts` (await all/any, expiry does not kill), `extension-e2e.test.ts` ("a default session execution survives agent settling in a resident session", "print mode holds settlement for waking session work", "json mode holds settlement for waking session work", "print mode releases ready and non-waking companions to session shutdown", "a disposed single-shot session releases its hold without reading a stale context"), `registry.test.ts` ("turn scope is rejected instead of acquiring settle-time semantics") |
| R2 — `workspace` + `pty` is reachable | `pty.test.ts` ("workspace + pty is a reachable cell, not a coercion"), `registry.test.ts` ("promotion widens default pipe and pty sessions to workspace"), `pty-durability.test.ts` ("a workspace pty survives a hard Pi exit and is re-adopted", "a promoted pty survives the Pi that promoted it") |
| R3 — no attach surface; terminal interaction is agent-only | `registry.test.ts` ("shell_send refuses on a pipe binding"), `extension-e2e.test.ts` (the seven-tool list is asserted) |
| R4 — `pipe` keeps its data path out of the owner process | `workspace.test.ts` ("a workspace execution survives its parent and is re-adopted"), `pty-durability.test.ts` ("a promoted default pipe survives the Pi that promoted it") |
| C1 — states; readiness is a milestone | `registry.test.ts` ("the ready marker works without any shell_start readiness declaration", "timeoutSeconds settles as timed-out through the ladder") |
| C2 — readiness is a wait condition | `registry.test.ts` ("a ready marker works without any shell_start readiness declaration"), `registry.test.ts` ("an await pattern observes only the selected stream", "a pattern wait with since=now cannot re-match an answered prompt", "an await pattern matches a prompt before a newline arrives") |
| C3 — completion is an event, not a poll | `extension-e2e.test.ts` ("three completions coalesce into one message") |
| A settle is reported once | `extension-e2e.test.ts` ("a command that settles inside the start call returns its result there", "an await that reports the settle does not announce it again", "an await in mode all holds a sibling's settle until both are reported", "an aborted await hands its held settle back to the completion channel", "a command that outlives the inline window keeps the handle and still notifies", "inlineSettleMs: 0 returns at once and leaves the completion channel alone", "inline settle handles undefined and aborted signals without losing notifications") |
| C4 — cancellation ladder + verification | `registry.test.ts` ("cancel proves the tree is gone, including a setsid escapee", "the fence reaches a child that cleared its env and lost its parent", "graceful cancel uses SIGTERM before the fence") |
| C5 — drain, never stop reading | `registry.test.ts` ("the session pipe log cap drains instead of killing or blocking the child", "the workspace pipe log cap drains instead of killing or blocking the child"), `pty.test.ts` ("a pty recording stops at the log cap without killing the command") |
| C6 — `(boot_id, pid, start)` identity | `workspace.test.ts` ("a workspace execution that exited while Pi was away is finalized on adoption", "an unprovable workspace record becomes lost, never completed", "adoption stops at the restart limit and records the reason"), `identity.ts` |
| C7 — terminal interaction never changes semantics | `pty.test.ts` ("ptyView is the rendered screen, not the raw stream", "a ptyView read is a viewport, and only a byte stream names a next page"), `screen.test.ts` (fourteen cases) |
| C8 — replay safety is declared | `registry.test.ts` ("a request id makes shell_start replay-safe"), `pty.test.ts` ("a request id makes shell_send replay-safe") |
| C9 — `shell_await` is the short form | Prompt guidelines; `extension-e2e.test.ts` uses it for a short command |
| C10 — one writer, read-only observers | `workspace.test.ts` ("one writer owns the workspace; a second process is read-only", "workspace locks recover stale or corrupt holders and never release another pid", "a read-only observer never adopts workspace handles", "a read-only observer can inspect but cannot mutate workspace executions") |
| `/reload` handoff | `reload.test.ts` ("a claimed registry keeps its live handles across the reload"), `extension-e2e.test.ts` ("/reload hands live handles to the new activation") |
| Session isolation | `extension-e2e.test.ts` ("a disposed session cannot deliver completions into its replacement") |
| GC safety | `maintenance.test.ts` ("GC removes expired terminal history but never running or current-session records", "GC count eviction keeps the newest terminal records and observes a grace period", "registry initialization creates a non-destructive gitignore") |
| Shell policy, credential filter, Linux guard | `maintenance.test.ts` ("the default command shell is bash, not the ambient non-POSIX login shell", "sensitive ambient variables are filtered and explicit env values win", "non-Linux platforms fail clearly instead of returning an empty process tree") |
| Log reads | `log-manager.test.ts` (index and rebuild, head, tail, offset by line and byte, disjoint grep, maxBytes, ANSI, UTF-8 paging, screen reads, empty log) |

---

## 3. Implementation Decisions Worth Recording

### 3.1 Every execution's output is file-backed from spawn

The first design gave `session` pipes an in-process tee and only `workspace` pipes a file. That made promotion impossible for the default binding. A live process's descriptors cannot be rebound. A promoted pipe would have kept writing into a pipe whose reader died with Pi.

0.2.0 makes the detached pipe supervisor universal. At both scopes the child's stdout and stderr are pipes owned by `pipe-supervisor.mjs`, which writes `stdout.log`, `stderr.log` and `combined.log`. The only scope difference is the fd 3 owner watch. Promotion writes `release\n` into that watch, and the supervisor stops watching without touching the command. The same process, pid and files continue. No byte is lost at the transition.

Evidence: `pty-durability.test.ts` — "a promoted default pipe survives the Pi that promoted it". `registry.test.ts` — "promotion widens default pipe and pty sessions to workspace".

### 3.2 `ptyView` is a rendered screen, and the runtime writes the recording

util-linux 2.42 `script` writes localized start/done headers into its typescript file even with `-q`. The runtime passes `/dev/null` as that file and binds `script`'s own stdout to `combined.log`, so the headers never reach the log. `stdout.log` and `ptyView.log` are symlinks to that one recording: a PTY merges both streams, so three names for one file is the honest layout.

`shell_read({ stream: "ptyView" })` returns the viewport instead of those bytes. It replays the tail of the recording through the screen model in `src/core/screen.ts`. A carriage return overwrites the line. Cursor addressing redraws in place. An erased line is gone. Output that scrolled past the height is out of view. A prompt that was drawn forty times answers "what is on the screen" with one frame. The raw stream is still available as `combined`.

The replay reports what it did. It covers the tail of the recording, so a read whose window did not start at byte 0 reports `truncated`, and its note names the window. A window that holds no line break aligns on a carriage return instead: a progress bar that only draws with `\r` has no newline to align on, and reading "no newline" as "nothing to replay" reported an empty screen for 300 KiB of output. A window with neither boundary says the viewport could not be reconstructed and points at `combined`, because an unreconstructable screen is not an empty one. The geometry comes from the `pty-size` record the spawn wrote, so the replay uses the size the child got; a record that cannot be read is reported as assumed. `shell_send` reaches the viewport through the same path instead of re-entering the tool-facing read, so the screen it returns cannot disagree with a `shell_read`.

The model covers the sequences a terminal UI emits (CR, LF, BS, TAB, CSI cursor motion and erase). It also covers line and character insertion and deletion, and save/restore. It consumes the rest without printing it. The model omits wide characters and the alternate screen buffer. §4 lists both.

### 3.3 `script(1)` runs its command through `$SHELL`

On this machine `$SHELL` is Nushell, so `script -c "<posix command>"` would hand a POSIX script to a non-POSIX parser. The PTY recipe generates a launcher that embeds the command and runs `script -c "sh <launcher>"`. `script` never parses the command itself. The launcher then runs the configured command shell (`/bin/bash` by default, or `PI_ASYNC_SHELL`).

### 3.4 `combined.log` has one writer per binding

A `pipe` execution's combined log is the supervisor's arrival-order tee of stdout and stderr, which is the ordering a terminal would show. A `pty` execution's combined log is the `script(1)` recording, which carries CRLF and echoed input. Both are observations of one stream, not a second source of truth. `shell_read` normalizes CRLF for a line-oriented read.

### 3.5 The ready marker needs a path the program can write

The convention is `$PI_ASYNC_SHELL_EXEC_DIR/ready`, so every spawn exports `PI_ASYNC_SHELL_EXEC_DIR` (and `PI_ASYNC_SHELL_EXEC` for containment). A program writes `touch "$PI_ASYNC_SHELL_EXEC_DIR/ready"`, and the registry observes it on the next poll or await. Without the variable the convention would be unusable from a command that does not know its own execution directory.

### 3.6 The shell policy is fixed, with one explicit override

When the environment sets `PI_ASYNC_SHELL`, `resolveShell` returns that value. Otherwise it returns the first of `/bin/bash` and `/bin/sh` that exists. The runtime ignores ambient `$SHELL`. A login shell is not necessarily a POSIX script interpreter. Inheriting Nushell here would change the command language silently. The `shell_start` description carries the chosen shell and its origin. The POSIX shell set excludes `fish`. Diagnostics classify an explicit `PI_ASYNC_SHELL=fish` as non-POSIX.

Evidence: `maintenance.test.ts` — "the default command shell is bash, not the ambient non-POSIX login shell".

### 3.7 Completion coalescing has a short debounce, and steering is the default

Three commands that settle within a few milliseconds of each other would otherwise produce three messages for one decision. Deliveries therefore wait one 150 ms window. Every record is still delivered. Only the number of messages collapses. A `workspace` record never starts a turn. Its `notifyOnCompletion` defaults to false. The runtime delivers a record surfaced at `session_start` as a next-turn message.

While the agent is running, the runtime steers a record in before the next LLM call. A completion that lands mid-run therefore informs the next decision instead of arriving after the run is over. `delivery: "settle"` holds it for `agent_before_settle`, which injects it with `continue: true` and keeps the run alive for it. This package's settle boundary defines the second mode, not Pi's `deliverAs: "followUp"`. A follow-up message arrives at the same tool-batch boundary as a steer message. It is not an opt-out from mid-run delivery.

Evidence: `extension-e2e.test.ts` — "three completions coalesce into one message". The same file covers "a completion steers into the next LLM call of a running turn". It also covers "delivery settle holds a completion until the run has no more work".

### 3.8 `/async-shell` is a list plus a select menu

The design describes a list plus per-handle actions. 0.2.0 renders the list through `ctx.ui.notify` and offers `read tail` / `cancel` through `ctx.ui.select`, plus the `run`, `cancel`, and `read` subcommands. The footer status widget matches the design. A full overlay would be presentation work that does not change any contract.

### 3.9 The `pty` recipe is detached, file-bound and FIFO-fed

The first `pty` recipe spawned `script` with three pipes owned by Pi. That made the PTY a child of the Pi process in every way that matters. A `kill -9` left `script` and its grandchild alive with their output silently discarded. No later Pi process could reach them. The old design text turned that accident into a rule ("a PTY master cannot outlive Pi"), which was wrong.

The recipe now binds `script`'s stdout to a bounded writer that writes `combined.log`. The child gets a FIFO for stdin, held open read-write by the wrapper. The whole tree runs in its own session. Nothing in the data path belongs to Pi. The execution therefore survives a hard exit, and a later Pi process can still type into it. Two details separate working from silently broken. The launcher applies the size recorded at spawn time (`stty rows/cols`), because a FIFO stdin leaves the slave at `0 0`. The backgrounded `script` job resets SIGINT/SIGQUIT, because a background job inherits them ignored and ^C would otherwise never reach the child.

### 3.10 Adoption requires the writer lock

Unless this process owns the workspace lock, `adoptWorkspace()` returns nothing. An observer still reads status and logs from disk, but it never becomes an owner by accident (C10). Starting or promoting into the workspace, sending to a workspace terminal, and cancelling a live workspace execution require the same writer lock. Surfacing a workspace completion also writes a `.surfaced` marker, so it is writer-only for the same reason.

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

### 3.15 A result note belongs in both channels

By host convention, `content` is what the model reads and `structuredContent` is what a program reads. The clamping notices (`waitMs` above 50 s, `inlineSettleMs` above 10 s) and the end-the-turn advice after a full-length wait existed only in `content`, so a `codemode` script that read `tools.shell_await(...)` lost them: it saw a bounded wait with no explanation and no instruction about what to do next. Both results now carry a `note` field with the same text, and `ShellStartResult` and `ShellAwaitResult` name it in the type.

Evidence: `extension-e2e.test.ts` — "oversized wait and inline-settle values are clamped with a visible note", "an expired wait carries its guidance in structured content".

### 3.16 A terminal keeps the signal dispositions its command was born with

The PTY wrapper runs `script(1)` in the foreground. That placement is the whole
mechanism, not a style choice. POSIX sets SIGINT and SIGQUIT to `SIG_IGN` in the
child of an asynchronous list, and a non-interactive shell cannot reset a signal
it inherited as ignored: in `dash`, which is `/bin/sh` on Debian and Ubuntu,
`trap - INT QUIT` is a no-op. A backgrounded `script` therefore hands every
process under the terminal an `^C` it cannot take. The byte still travels: it
reaches the line discipline, the recording shows the echoed `^C`, and the
foreground process group stays alive. A graceful cancel then has nothing left but
the grace period, so it always costs the full `graceMs` before the escalation.

Only the owner watcher is asynchronous now. It runs `kill` and nothing else, so
the disposition it inherits cannot reach a command. The wrapper traps SIGTERM so
that a group signal cannot take it down before it seals `exit.json`; a trap does
not propagate to children, which keep the default. The watcher is stopped with
SIGKILL rather than SIGTERM, because SIGTERM is the signal that means "the owner
is gone", and a cleanup that used it once looked exactly like owner loss.

Evidence: `pty.test.ts` — "a pty does not hand its command an ignored SIGINT", "a pty cancel interrupts the terminal instead of waiting out the grace period"; `pty-durability.test.ts` — "a workspace pty survives a hard Pi exit and is re-adopted".

### 3.17 A record is only replayed for the key and the tool that wrote it

A `request` key becomes a file name, and the sanitizer is lossy: `"build one"`
and `"build/one"` both reduce to `build_one`. Replaying on the sanitized name
alone would answer the second call with the first call's handle, so the command
never runs and the tool reports success. A key the sanitizer changed therefore
carries a digest of the exact string the caller passed. The tool is part of the
name as well, because `shell_start` and `shell_send` share one key space and a
start record must never answer for a keystroke.

Evidence: `registry.test.ts` — "two request keys that sanitize alike stay two executions"; `pty.test.ts` — "a start request key and a send request key are separate namespaces".

### 3.18 A pty recording is bounded by a writer, not by `script(1)`

`script(1)` used to write the recording into `combined.log` itself, so the file
grew for as long as the terminal ran. util-linux has a limit of its own, and it
was measured before it was rejected: `--output-limit` ends the session at the
limit, so the command dies with the recording and the exit code reports a full
disk as a command failure. That is the one thing C5 forbids.

The recording therefore passes through `src/core/recording-writer.mjs`. The
writer reads without stopping, appends at most `maxLogBytes`, drops the rest and
writes `log-cap.json` — the same file, the same cap and the same meaning the pipe
supervisor gives them. `script`'s status travels out of the pipeline through
`$d/script.rc`, because POSIX reports the last stage of a pipeline, and the
writer's own status never decides the execution's status.

The retained bytes are the beginning of the recording. A prefix keeps every byte
offset the line index has cached, which front truncation and rotation would both
break, and it matches the pipe path, which keeps the head and drops the tail too.

Evidence: `pty.test.ts` — "a pty recording stops at the log cap without killing the command"; `pty-durability.test.ts` — "an unpromoted session pty stops when its owner is killed".

---

### 3.19 A module is split by change reason, not by layer

`node scripts/dsm.mjs` builds the import matrix, partitions it by strongly
connected component and reports propagation cost. It is a report, not a gate: it
runs in `pnpm dsm` and not in `pnpm verify`, and `docs/adr/0008-read-coupling-from-a-matrix.md`
records why no analyser dependency was added for it.

The matrix orders a module before the modules that depend on it, so a
below-diagonal mark is structure and an above-diagonal mark is a feedback edge.
The tree has none of the second kind. What it had was two nodes holding 52% of
the lines, and one of them carried five unrelated change reasons. Four of them
were already leaves, so they moved out unchanged: `keys.ts` (the key table),
`utf8.ts` (the window boundary both readers need), `records.ts` (atomic JSON,
log deltas, the FIFO, a replay key's name) and `presentation.ts` (every string a
person or a model reads back).

The fourth is worth naming. Formatting sat at the top of the graph, inside the
file that registers the tools, so a wording change ran through the module every
other module depends on. It now imports types and nothing else, and
`readOutcomeExcerpt` takes the one method it needs (`LogReader.read`) instead of
the registry that happens to have it.

The centre did not move, and the matrix says so: `registry.ts` still has
fan-out 12 and `extension.ts` still reaches 19 of 22 modules. Both are
orchestrators. Splitting them further is not a refactor — the state machine, the
write lock and the adoption path share one invariant — so `docs/rfcs/` is where
### 3.20 A pair of files is a claim the history can check

`node scripts/cochange.mjs` reads the part of the tree the import graph cannot
see: two files that changed in the same commit. It is a report and not a gate,
like the matrix, and `pnpm cochange` runs it;
`docs/adr/0009-read-change-coupling-from-the-history.md` records why a
whole-tree commit is cut out and why a pair seen once stays below the threshold.

The history is short enough to state in full, and it is stated at the split of
0.2.3, `965667f4`, so that a commit count in this section does not have to be
rewritten by every commit after it. Forty-one commits were reachable from git
HEAD then, which is `jj log -r '::@-'` without jj's virtual root, and the
working-copy commit was excluded because it carries a session as a single commit.
Eighteen of them touched `src/`, nine of those with two or more files, and two of
those touched most of the tree — the import and the split. The matrix therefore
rests on nine observations, and the report says so above every table.

`pnpm cochange` prints this, with eleven pairs held back by the threshold:

| A | B | n | P(B given A) | P(A given B) | Jaccard |
|---|---|---|---|---|---|
| `registry.ts` | `extension.ts` | 4 | 66.7% | 80.0% | 0.57 |
| `types.ts` | `extension.ts` | 2 | 66.7% | 40.0% | 0.33 |
| `registry.ts` | `types.ts` | 2 | 33.3% | 66.7% | 0.29 |

The first row is the one that settles a question. Read it as the tool prints it,
with A the first name: 66.7% of the commits that touched `registry.ts` touched
`extension.ts`, and 80.0% of the commits that touched `extension.ts` touched
`registry.ts`. The direction is `extension.ts` pulling `registry.ts`, so neither
file is a thin shell over the other. Rows two and three are the same claim about
`types.ts`: two of its three commits also touched `extension.ts` and two also
touched `registry.ts`, one with each and one with both, so no edit to it stood
alone. Fan-in ten is a blast radius rather than a tidy pile of declarations.

Eight pairs have no import edge between them and every one of them is a single
commit, which is a hypothesis and not a finding. Four of them are disconnected in
the graph, and each has a mechanism: `paths.ts` with `pipe-supervisor.mjs` (the
runtime directory, and the mode the supervisor opens files with), `spawn.ts` with
`recording-writer.mjs` (the symlink the wrapper is launched through), and
`ansi.ts` with `screen.ts` (one escape grammar, parsed twice). That is the rule
§3.19 needed: the two modules the DSM shows as isolated are the two this tree
runs as separate processes, so an island in the import graph is not independence.

`pnpm cochange --scope src,tests` adds the test coupling, and one row dominates
it: `tests/extension-e2e.test.ts` and `src/extension.ts` changed in seven of
seven commits, at 100% in both directions. `--max-share 1` keeps the import and
the split, and that is how the filters were chosen: they lift three pairs to
n=3 whose whole evidence is those two commits.

`tests/cochange.test.ts` pins the machinery and not the numbers above, because a
history that grows moves them. It states the arithmetic once — one co-change
count in, the two rates and Jaccard out — then the three filters that decide
which commits and which paths may make a pair, then the four names the import
graph can give one. A rename has no instance in this history, so the test builds
the two commits that would expose the bug, a `git mv` and an edit to the other
file, and reads them back through the same code: without the alias rewrite the
pair is seen once instead of twice. The stages are exported and the stages that
read git take the repository directory, which is what makes a fixture possible;
the CLI is spawned only for the exit codes and the two payloads, and its output
is byte-identical before and after that change. The end-to-end tests run against
this history and allow it to grow: they pin the rank order, the pair the table
above leans on, and that every rate in the payload follows from the payload's own
counts.

Evidence: `cochange.test.ts` — "P(B|A), P(A|B) and Jaccard all follow from the
one count", "a renamed file keeps one history under the name it carries today",
"the report on this repository derives every rate from its own counts".

## 4. Known limits of 0.2.0

- **Linux only.** Process identity, containment, the PTY recipe and the pipe supervisor's `/proc/self/stat` read are load-bearing. On a non-Linux platform the runtime fails with an explicit error. When procfs is unreadable, it fails the same way rather than returning an empty process tree.
- **The writer lock is advisory.** The lock uses `O_EXCL` plus a liveness check on the holder's identity. A process that ignores the lock can still write.
- **`pty` has no separate stderr.** A PTY is one stream. `stderr.log` stays empty, and `shell_read` says so.
- **A `pty`'s `combined.log` is the terminal recording.** The child owns a real PTY. The file therefore carries CRLF and echoed input rather than the child's raw bytes. Reads normalize CRLF. `stripAnsi: false` returns the recording verbatim.
- **A `pty` recording is capped by a writer, and a capped recording is a prefix.** `PI_ASYNC_SHELL_MAX_LOG_BYTES` (default 100 MiB) bounds `combined.log` on both bindings, and neither binding kills the process at the cap. For a `pty`, a writer between `script(1)` and the file appends up to the cap and then discards, so the retained bytes are the first ones the terminal produced. After `capReached`, `mode: "tail"` and `ptyView` describe the end of that prefix, not the end of the program's output. `util-linux`'s `--output-limit` would bound the file too, by ending the session at the limit; that is why it is not used.
- **`ptyView` is a viewport, not a scrollback.** The replay window is the tail of the recording (256 KiB minimum), and a windowed replay reports `truncated` so a reconstructed screen is never read as a complete log. A `ptyView` read names no next page: `nextByte` and `nextLine` are absent, because viewport rows are not file lines. The screen model omits wide characters and the alternate screen buffer. A TUI that paints with wide glyphs can render narrower than the real terminal did.
- **A `workspace` handle without an exit record and without provable liveness is `lost`.** It is never reported as `completed`.
- **Containment has a detection floor.** The fence unions three views: environment tag, ppid tree, and owned process groups. A child that runs `env -i` and outlives its parent is still found. One case stays out of reach: a child that also calls `setsid(2)` between scans. It has no tag, no parent edge, and no group of ours.
- **`shell_await` blocks the tool call.** A tool call cannot be suspended here. A long wait ends the turn and lets the completion message resume it. `waitMs` defaults to 30 s and caps at 50 s.
- **Single-shot settlement holds pending wake-ups only.** In `print` and `json` modes, `agent_before_settle` waits for live, unready `session` executions with `notifyOnCompletion !== false` and `triggerOnCompletion !== false`. The internal wait observes exit or readiness in 50 s rounds without setting `consumedByAwait`; settled records enter the normal boundary message and continue the run. The host runs this boundary between runs, so `ctx.signal` is undefined there and no abort can arrive: the wait ends when its work settles or becomes ready, or when this activation stops owning the registry. It reads the context before its first `await` and treats an unreadable context as no reason to hold, because a host that disposes the session mid-hold still emits the boundary that follows the continuation. A ready companion and a non-waking execution hold nothing. Final `session_shutdown` still reaps every remaining `session` execution. Evidence: `extension-e2e.test.ts` — the print/JSON waking-work tests, the companion shutdown test and the disposed-session hold test.
- **A wait starts only when a later action depends on its outcome.** Every wake-up this package can deliver comes from an execution that settled, so an external refresh — a registry index, a CDN cache, a CI queue — has no event to wait on. The prompt guidelines and the skill ask for the causal test before any wait: when nothing later in the task needs the new state, the verified result is the answer, and a poll and a watcher are both waste. When something does depend on it, one command that exits on the change, with `timeoutSeconds`, plus one `shell_await` is the whole mechanism; a second blocking await only spends the turn.
- **Completion coalescing uses a fixed 150 ms idle window.** Three commands that settle together produce one wake-up. The window does not adapt.
- **A pattern match runs on the main thread.** `shell_read` `mode: "grep"` and `shell_await` `until.kind: "pattern"` compile and run a JavaScript regular expression in the event loop, and Node cannot interrupt one. The guard rejects a source longer than 512 characters and a quantifier applied to a group that already repeats, which is the shape the classic blowups need. It is a floor, not a proof: a pattern under both limits that avoids the nested form can still be quadratic on a very large log.
- **A `pty` records one stream.** `stderr.log` stays empty, because `script(1)` writes everything into one recording. Both the read and the wait map `stderr` onto `combined` and say so, rather than opening an empty file: a wait on a file that can never grow can only expire.
- **Runtime state is owner-only.** `.pi/async-shell` and the directories under it are created `0700`, the FIFO `0600`, and the log files `0600`. The mode is not a boundary against a process running as the same user, and a runtime root on a filesystem without POSIX modes keeps whatever it has.
- **The credential filter is a default, not a guarantee.** The filter misses an unusually named variable. It also misses a secret on a command line.

---

## 5. Benchmark Summary

Full report: [`bench/REPORT.md`](../bench/REPORT.md). Each implementation loads alone into a real Pi SDK session, and the harness invokes its registered tools directly. The numbers therefore compare the implementations rather than a model. The field holds Pi's built-in `bash`, `pi-async-shell`, and eight packages: `pi-background-tasks@2.6.10`, `pi-better-background-tasks@0.18.0`, `pi-background@0.4.4`, `pi-patty-bg-tasks@1.1.6`, `pi-async@0.4.4`, `@tduyng/pi-shell@0.0.6`, `pi-shell-jobs@0.1.2`, and `pi-exec-command@0.3.10`.

The first table asks what someone adopting this would notice. The second asks why the difference exists. Both quote the committed run, generated on 2026-11-25 by `node bench/run-bench.ts` against `@earendil-works/pi-coding-agent@1.6.0`, with a load average of 2.79 when the run started. It is a run of the code in this repository, so the `pi-async-shell` rows include `inlineSettleMs` and pipeline status.

| What a user gets | pi-async-shell | pi-background-tasks |
|---|---|---|
| A dev server started in one turn answers in the next | yes, 1 call to know it is ready | yes, 8 log polls |
| A prompt after a 4000-line burst can be answered | yes, PTY, answered | no, prompt visible, no stdin |
| One 2.5 s command: time, context, calls to the answer | 2555 ms, 677 B, 3 calls | 2523.7 ms, 12.9 KB, 3 calls |
| Cancel a runaway: output kept, nothing left running | yes, 0 leftovers | yes, 0 leftovers |
| Output recovered after the agent is killed and restarted | yes, 40/40 lines | no, no handle, no log |
| A task survives a hard parent exit | yes, 25/25 lines | no, 4/25 lines |

| Mechanism | pi-async-shell | pi-background-tasks |
|---|---|---|
| In-turn causal barrier | yes (0 turn boundaries) | no (1 turn boundary) |
| 30 MiB log does not kill the process | yes, 31.4 MB logged | no, killed at 20 MiB |
| One line of a 200k-line log is reachable | yes, 362 bytes, 1 call | no, 102 KB, 2 calls |
| Three parallel commands overlap | yes, 452 ms | yes, 433 ms |

Two rows are not a contest, and the report says so. Both implementations leave nothing running after a cancel. Both keep a dev server reachable across a turn boundary. What differs in the dev-server row is the cost of knowing the server is up, not whether it works. `patty` also survives a hard parent exit (25/25 lines). It is the only other package in the field that does.

The harness measures admission latency after one unmeasured warmup call. The percentiles therefore describe the start path rather than module loading:

| Admission | pi-async-shell | pi-background-tasks | pi-better-background-tasks |
|---|---|---|---|
| median | 5.8 ms | 6.8 ms | 106.2 ms |
| p95 | 9.2 ms | 12.1 ms | 153.7 ms |
| first call in the process | 6.0 ms | 4.9 ms | 111.6 ms |

The median is the stable number, and even it moves with machine load. The committed run started at a load average of 2.79 and recorded 5.8 ms for `pi-async-shell`; the run before it, at 3.74, recorded 6.5 ms, and an isolated rerun of the same ten samples under no other load measured 3.3 ms. The report quotes the run it came from, and the load it started under, rather than the friendliest number. The first call in a process is module loading and JIT, not admission.

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
- The `protected-paths` extension in this machine's global Pi extensions covers `bash` redirections. It is a local extension, not part of this package, and it does not see `shell_start` commands or `shell_send` input.
