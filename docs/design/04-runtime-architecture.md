---
kind: normative
applies_to: 0.2.2
tracks:
  - src/core/spawn.ts
  - src/core/pipe-supervisor.mjs
  - src/core/registry.ts
---

# 04. Runtime Architecture

> This file was named `03-carrier-and-runtime-architecture.md`. It is now `04-runtime-architecture.md`. `carrier` is no longer a concept in this design (see `00-terminology.md` §10). `05-durability-and-containment.md` §8 records the rename, so old links are accounted for.

## 1. Overview

Two bindings, two spawn recipes, one registry. A binding plus a scope is what the word `carrier` used to mean. Keeping the two apart is what allows `workspace` + `pipe` and `workspace` + `pty` to exist at all.

Every execution's output is file-backed from the moment it starts. A `pipe` execution runs under a detached pipe supervisor. The supervisor owns the child's stdout and stderr pipes and writes the log files. A `pty` execution runs under a detached wrapper. The wrapper owns the PTY through `script(1)` and writes the recording to the same directory. Pi stays outside the data path for both bindings. The only scope-dependent part is an fd 3 owner watch. Promotion releases that watch.

The registry, the spawn recipes, containment, cancellation and log management form the core. The core knows nothing about Pi's messaging. A settle produces an event. The extension layer decides whether to deliver it as a follow-up message, as a TUI notification, or not at all. That separation buys testability, not host portability. `pi-coding-agent` is the only target. `05-durability-and-containment.md` explains what was read from elsewhere and what was left there.

```
registry (handles, scopes, waiters, completion log)
   |
   +-- pipe   : detached pipe-supervisor.mjs, child pipes -> stdout/stderr/combined files
   +-- pty    : detached wrapper, script(1) recording -> combined.log, stdin from a FIFO
   |
   +-- log manager : streaming decode, sparse line index, drain-not-kill cap
   +-- supervision : scope exit hooks, cancellation ladder, completion delivery
```

---

## 2. Spawn Recipes

### 2.1 `pipe`

Every pipe execution, at either scope, is one invocation of `src/core/pipe-supervisor.mjs`:

```ts
spawn(process.execPath, [
  pipeSupervisorPath,
  dir,                       // execution directory
  shell,                     // /bin/bash or /bin/sh, or PI_ASYNC_SHELL
  command,
  String(maxLogBytes),       // default 100 MiB
  durable ? "0" : "1",       // 1 = watch the owner, 0 = already durable
], {
  cwd,
  env,                       // filtered ambient env + PI_ASYNC_SHELL_EXEC + PI_ASYNC_SHELL_EXEC_DIR
  detached: true,            // own session and process group
  stdio: durable
    ? ["ignore", "ignore", "ignore"]
    : ["ignore", "ignore", "ignore", "pipe"],   // fd 3 is the owner watch
  windowsHide: true,
})
```

Before the supervisor spawns the command, it writes `pid.json` with its own pid, pgid and start time. It then spawns the command:

```js
const child = spawn(shell, ["-c", command], { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", (chunk) => append(chunk, stdout));
child.stderr.on("data", (chunk) => append(chunk, stderr));
```

`append` writes to `stdout.log` or `stderr.log` and to `combined.log` in arrival order, up to the cap. Past the cap it keeps consuming the pipes and discards the surplus. It writes `log-cap.json` once. When the child closes, the supervisor seals `exit.json` (`exitCode`, `signal`, `endedAt`) and kills itself. No supervisor outlives its sealed outcome.

The fd 3 watch is the only difference between the scopes. A `session` execution gets a pipe from Pi. The supervisor reads one line from it. `release` means ownership moved to the workspace, so the supervisor stops watching and keeps running. EOF means the owning Pi process died, so the supervisor sends `SIGTERM` to its own process group and `SIGKILL` one second later. The supervisor ignores `SIGTERM`, because a group signal also reaches it. It seals `exit.json` and then kills itself.

### 2.2 `pty`

One recipe for both scopes. The wrapper is spawned detached and holds no descriptor of Pi's. It owns the PTY through `script(1)`:

```sh
#!/bin/sh
# $1 = exec dir, $2 = 1 when the owner must not be outlived
d=$1; watch=$2
# identity: pid.json (pid, pgid, start time), write-temp-then-rename
fifo="$d/stdin.fifo"
rm -f "$fifo"
mkfifo "$fifo" || exit 1
exec 4<>"$fifo"                      # read-write: no EOF, and a later writer can attach
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
# exit.json (exit code, end time), write-temp-then-rename
exit "$rc"
```

The launcher inside the PTY sizes the terminal and hands over the command:

```sh
#!/bin/sh
stty rows 24 cols 80 2>/dev/null     # the size recorded at spawn time
exec "$shell" -c "$command"
```

Four details are load-bearing. Each one was verified against the kernel rather than assumed:

- **The recording goes to a file.** `script` writes its own stdout. The data path therefore carries no descriptor of Pi's, and Pi's death breaks nothing.
- **stdin is a FIFO held open read-write.** A read-write handle keeps the child's stdin free of EOF. That holds with no writer attached. A later process can also open the same FIFO for writing. `shell_send` opens it `O_WRONLY|O_NONBLOCK`, so a write with no reader fails fast instead of blocking the caller.
- **The size is set explicitly.** stdin is a FIFO, so the kernel hands the slave no window size. `stty size` would answer `0 0`. The runtime records the size in `pty-size`, and the launcher applies it, so the child and the replay agree. When stdout is a TTY, the size comes from Pi's terminal. Otherwise the size comes from `COLUMNS`/`LINES`, clamped to 20-500 columns and 4-200 rows. The default is 80x24.
- **`script` is pinned to a POSIX shell and its job keeps default signal dispositions.** `script` runs its command through `$SHELL -c`. `SHELL=/bin/sh` then keeps a non-POSIX user shell out of the command's parser, exit code and log. Backgrounding a job makes the shell ignore SIGINT and SIGQUIT in it. That would silently disable ^C through the PTY, so the runtime resets the dispositions before `exec`.

A PTY merges stdout and stderr into one recording. `combined.log` is that terminal recording (CRLF, echoed input). `stdout.log` and `ptyView.log` are symlinks to it. `shell_read` normalizes CRLF by default. `ptyView` replays that recording into the screen it produced. The replay is a view of the byte stream, not a replacement.

The runtime detects completion from the atomic appearance of `exit.json`, which the wrapper writes after `script` returns. The wrapper is the process Pi spawned, so the cancellation ladder owns its pid and process group.

The owner pipe (fd 3) is the only scope-dependent part. A `session` execution gets one, so its EOF tears the PTY down. The execution cannot outlive Pi. A `workspace` execution gets no owner pipe, so it survives and is re-adopted.

### 2.3 Promotion

`shell_promote({ to: "workspace" })` changes ownership without touching the process:

1. The registry writes `release\n` into the fd 3 owner watch and closes it. The supervisor or wrapper stops watching. The command receives no signal.
2. It creates a directory symlink `workspace/<id>`. The symlink points at the execution directory under `sessions/`. The workspace adoption scan then sees the record without moving a directory the child still writes into.
3. When the caller supplies `adopterNotification`, the registry sets `notifyOnCompletion` from it. The registry also sets `scope: "workspace"` and `durable: true` in `meta.json`.

Nothing is respawned. No log file changes. No byte is lost. This is why both bindings promote. From the moment of spawn, the process's stdio already belongs to a detached holder rather than to Pi.

---

## 3. Cancellation Ladder

```
graceful:  pty -> write ^C into the stdin FIFO (SIGTERM if it has no reader)
           pipe -> SIGTERM to -pgid
           wait graceMs (default 3s; 1.5s on shutdown, 1s on an abandoned reload handoff)

force:     set = tagged(PI_ASYNC_SHELL_EXEC = id)
                 ∪ liveDescendants(known (pid, start) identities)
                 ∪ liveMembers(owned process groups, since leader start)
                 ∪ liveDescendants(tagged identities)
           re-read start for each pid, then SIGKILL
           repeat scan-and-kill until empty or deadline (5s)

verify:    empty set
           failure -> status failed + descendant-leak diagnostic
```

Signalling a group is a delivery mechanism, not a containment guarantee. `setsid(2)` puts a child in a new session and a new group. After that, `-pgid` reaches nothing. `nohup … &` is an ordinary thing for an agent to type. The group is the cheap graceful path, and it is the only path available where `environ` is unreadable. The tag is the guarantee.

The three views cover three different escapes. The tag survives a reparented child but not `env -i`. The ppid tree survives `env -i` but not reparenting. The owned process group survives both, and only `setsid(2)` defeats it. The `since` bound is the leader's start time. A reused group id therefore cannot match a stranger that predates the execution. `05-durability-and-containment.md` §5 gives the provenance and the required test.

Four more rules are essential:

- The runtime captures the group id and the `(pid, start)` identity at spawn. It reconstructs neither from metadata for a live process. `start` is re-read immediately before each signal, so a reused pid is never killed.
- `signalGroup` refuses a pgid of 0 or 1, Pi's own pid, and Pi's own process group. A mistaken group id cannot signal the agent.
- Aborting a `shell_await` (Escape, or a codemode script abandoning the promise) detaches the waiter only. This ladder stays untouched. Cancelling a consumer is not cancelling a producer.
- Timeout and cancellation wait for *finalized cleanup*, not for a status label. `enforceTimeout` marks the handle `timed-out`, runs the ladder, verifies absence, and only then seals the record. `shell_cancel` waits for the same finalization. While the captured identity is still alive, the exit watcher refuses to finalize. A supervisor's `exit.json` therefore cannot make a still-running tree look settled.

---

## 4. Durable Output and Backpressure

Layout under `.pi/async-shell/{sessions/<sessionId>-<pid>|workspace}/<id>/`:

| File | Written by | Meaning |
|---|---|---|
| `meta.json` | registry, atomic rename | handle, scope, binding, status, identity, byte counts |
| `stdout.log` | supervisor (pipe) or symlink to `combined.log` (pty) | stdout bytes |
| `stderr.log` | supervisor (pipe) or empty for pty | stderr bytes |
| `combined.log` | supervisor (pipe) or the bounded recording writer (pty) | arrival-ordered stream / terminal recording |
| `ptyView.log` | symlink to `combined.log` (pty only) | recording replayed as a screen |
| `pty-size` | registry (pty only) | rows and columns given to the PTY |
| `pid.json` | supervisor or wrapper | pid, pgid, start time, written before the command |
| `exit.json` | supervisor or wrapper | exit code, signal, end time |
| `completion.json` | registry | the durable completion record |
| `log-cap.json` | supervisor or recording writer | the cap was reached |
| `stdin.fifo`, `pty-wrapper.sh`, `pty-launcher.sh`, `recording-writer.mjs` | wrapper (FIFO) and registry (scripts and writer), pty only | the terminal's stdin and spawn recipe |
| `.surfaced` | registry (workspace only) | this completion was delivered once |

The cap is a *logging* policy, so it must not become a *process* policy. When `PI_ASYNC_SHELL_MAX_LOG_BYTES` (default 100 MiB) is reached:

1. The supervisor stops appending beyond the cap.
2. It **keeps draining the pipes**, discarding the surplus.
3. The supervisor writes `log-cap.json` and sets `bytes.capReached` in metadata.
4. The process is untouched.

Step 2 is the step that is easy to get wrong. Linux pipes hold 64 KiB by default. A cap implemented as "stop reading" turns a full pipe into a blocked child. It also turns a logging decision into a hang. This is the single largest behavioural difference from `pi-background-tasks`, whose 20 MiB cap kills the task (`registry.ts:72`, `background-task-runtime.md`).

The cap covers every execution, on both bindings. A `pipe` execution is capped by its supervisor, which owns the pipes at both scopes. A `pty` recording is capped by a bounded writer between `script(1)` and `combined.log`: the writer reads without ever stopping, appends at most the cap, drops the rest and writes `log-cap.json` ([ADR 0007](../adr/0007-bound-the-pty-recording-without-touching-the-process.md)). The retained bytes are the beginning of the recording, because a prefix keeps every cached byte offset in the line index and a rotating file would not. util-linux's own `--output-limit` was measured and rejected: it ends the session, which would turn a full log into a failed command.

Line and byte indexing uses sparse checkpoints every 256 lines. `mode: "offset"` can therefore `pread` instead of scanning. A read checks `signal.aborted` *before* it opens the file. Passing a pre-aborted signal to `createReadStream` raises an unhandled `error` event. That is the bug that `~/.pi/agent/extensions/read-abort-guard.ts` exists to patch.

---

## 5. Readiness and Wait Conditions

`shell_start` takes no readiness option. Readiness is observed, not configured:

| Condition | Mechanism | Analogue |
|---|---|---|
| `until: {kind: "ready"}` | The command creates `$PI_ASYNC_SHELL_EXEC_DIR/ready` | `sd_notify(READY=1)` / `Type=notify` |
| `until: {kind: "pattern", regex, stream, since}` | Regex over the declared stream (default `combined`) from a recorded offset | `expect` |
| `until: {kind: "exit"}` | The execution reaches a terminal state | `wait(2)` |

The registry checks the marker on every log poll. A log poll runs every 250 ms for an owned execution and 500 ms for an adopted one. When an await evaluates, the registry checks the marker again. The first observation sets `readyAt`, persists it, and fires `onReady` for the UI. The marker is out of band, so a change in output formatting cannot break it. A command that never creates one is never ready.

A pattern wait is incremental. The registry records a byte offset (0 by default, the current file size for `since: "now"`, or a caller-supplied number). It reads the new bytes, splits them into lines, and keeps the last partial line for the next chunk. A line match reports the line and its byte offset. A partial final line is still output, so a prompt that ends without a newline can satisfy the pattern while the process keeps running. If the execution settles without a match, the wait is satisfied with no `matched` value. The caller learns that the command ended instead of waiting forever.

A `pipe` keeps separate `stdout.log` and `stderr.log`, so `stream: "stderr"` cannot be satisfied by a `stdout` line. A `pty` merges both streams into one recording. Its `stdout.log` is a link to that recording, so both names observe the same bytes there. For a `pty`, `stream: "ptyView"` in a pattern wait reads the same recording file as `combined`. `shell_read` applies the screen model, not a wait.

---

## 6. Reload Handoff and Re-Adoption

### 6.1 Same process, `/reload`

`session_shutdown(reason: "reload")` transfers live handles to a process-global slot, `Symbol.for("pi-async-shell.reload-hub.v1")`, keyed by `(pid, sessionId, realpath(cwd))` with a 30s claim deadline. Child processes, streams, waiters and cumulative byte counts move. Nothing restarts, and no byte is lost. A fresh activation that never claims the slot lets it expire. The handles then follow the normal cancellation ladder rather than staying unowned.

### 6.2 Cross process, `scope: "workspace"`

On `session_shutdown(reason: quit|new|resume|fork)` the runtime leaves workspace handles running and releases its watchers. On the next `session_start` in the same workspace, the runtime acquires the writer lock and scans the workspace records, including promoted session records. It classifies each record:

| Observation | Result |
|---|---|
| `exit.json` present | finalise to `completed`/`failed` with the recorded code and signal |
| No `exit.json`, identity alive or the log still advancing | restore as `running`, resume tailing |
| No `exit.json`, liveness unprovable | `lost` |
| More than five adoption attempts | `lost` with a restart-limit diagnostic |

Liveness identity is `(boot_id, pid, starttime)`. A bare pid is insufficient. After a reboot the kernel reuses the number space. Adopting a stranger's process to report its exit code is worse than reporting `lost`. `starttime` comes from `/proc/<pid>/stat` field 22. It is stable for the lifetime of the process.

For any `workspace` execution, the child holding the log fd corroborates liveness as well. If the file's size or mtime advances over a 120 ms sample, the writer is alive, even when `/proc` is unreadable. A `pty` execution that is merely idle — waiting at a prompt — is alive by identity and quiet in the log. The runtime therefore checks identity first.

A completion that settled while no Pi process was watching, and whose notification is enabled, is surfaced once at `session_start` as an `<async-shell-workspace>` message. The writer records `.surfaced` in the execution directory, so a later session does not repeat it. Only the lock owner surfaces records. A read-only observer never writes the marker.

The writer lock is `.pi/async-shell/workspace/.lock`, created with `O_EXCL` and a holder identity. A lock whose holder is no longer alive is stale and is replaced. A process that cannot take the lock opens the registry read-only. It may read status and logs, while `shell_promote`, `shell_send` and `shell_cancel` refuse rather than race the owner.

---

## 7. Storage and Garbage Collection

`ensureRegistryDirs` creates `.pi/async-shell/`, `sessions/`, `workspace/` and `requests/`, and writes a `.gitignore` containing `*` with the no-replace flag. The no-replace flag leaves an existing `.gitignore` unchanged.

GC runs when the registry is constructed and then hourly. It removes only sealed, terminal records:

| Rule | Default | Knob |
|---|---|---|
| Terminal record age | 24 hours | `PI_ASYNC_SHELL_GC_RETENTION_MS` |
| Terminal record count | 100 | `PI_ASYNC_SHELL_GC_MAX_RECORDS` |
| Count-eviction grace | 5 minutes of age | fixed |

Running records, nonterminal records, records protected by a loaded handle, and records in the current session directory stay untouched. A crashed owner leaves live workspace processes in place. When a record is removed, its promoted symlink is removed too. An empty session directory is pruned. Orphan request records older than the retention window and not naming a known execution are removed in the same pass.

---

## 8. Implementation Order

**Phase 1 — registry, `pipe`, `session` scope.** The phase ships the handle registry, sealed metadata, and the detached pipe supervisor. That supervisor owns file-bound logs and the drain-not-kill cap. It ships `shell_start`/`await`/`read`/`cancel`/`status`, completion coalescing, `consumedByAwait` suppression, and `/reload` handoff. It ships the containment fence that makes cancellation mean something.

**Phase 2 — `pty`.** The phase ships the detached `script(1)` recipe, the stdin FIFO, `shell_send`, the ready marker and pattern waits, wrapper markers, and `ptyView` reads.

**Phase 3 — `workspace` scope.** The phase ships workspace adoption and `shell_promote`. It ships the re-adoption scan, `lost` handling, and PID-reuse-safe identity. It ships the writer lock, GC, and the `/async-shell` list.

Each phase is independently shippable. Phase 1 already satisfies the original three requirements, without a PTY and without cross-process persistence.

**0.2.0** removed `turn` scope and its settle-time error. It removed `shell_start.readiness`. It made the pipe supervisor universal, so both bindings promote losslessly. It added the Linux/procfs guards, the credential filter, the ready marker, partial-line pattern waits, and the GC pass.
