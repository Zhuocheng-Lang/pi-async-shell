---
kind: normative
applies_to: 0.2.3
tracks:
  - src/core/types.ts
  - src/extension.ts
---

# 00. Terminology

This document fixes the vocabulary of `pi-async-shell` at 0.2.0. Each entry gives three things: the definition, the conflation the term guards against, and the sections that use the term.

Read the sections in order. Section 2 gives the object and its two axes. Sections 3 and 4 define each axis. Sections 5 to 9 define the cross-cutting contracts. Section 10 lists the words this project retired.

---

## 1. How to Read This Glossary

Each entry has three parts:

- **Definition.** The one meaning the term has in this project.
- **Not.** The nearby meaning that the term is often confused with. This part also says why the confusion costs something.
- **Used in.** The sections that depend on the term.

Three rules apply to every term:

1. **One term, one meaning.** A term keeps its meaning in every document. A document that needs a different meaning adds a term.
2. **A synonym is a defect.** `owner` and `scope` are different terms, and `kill` and `reap` are different terms. When two words appear to mean the same thing, one of them is wrong.
3. **Identifiers are code.** `shell_await`, `scope: "workspace"`, `PI_ASYNC_SHELL_EXEC` and `consumedByAwait` name real surfaces. They keep their spelling and their backticks in every language.

This document is normative. It carries no **[Fact]** / **[Inference]** / **[Recommendation]** classification of the kind the evidence documents use. A definition is a decision, not a finding.

---

## 2. The Object and Its Two Axes

### execution

**Definition.** One command started by `shell_start`, together with every process that command creates and the durable record of both.

**Not** a tool call. A tool call starts an execution and returns a handle. The execution continues after the call returns. It can outlive the turn, the session, and Pi itself.

**Used in** `01-overview.md` §1. `03-execution-model-and-primitives.md` §1.

### execution handle

**Definition.** The durable record that names one execution: its id, scope, binding, status, process identity, and log paths.

**Not** the process. A handle outlives its process. `completed` and `lost` both describe a handle whose process is gone, with a known or unknown outcome.

**Used in** `03-execution-model-and-primitives.md` §2 and §3. C1.

### handle id

**Definition.** The identifier `sh_<8 hex chars>` that a handle carries for the life of its record. The runtime never reuses an id.

**Not** a pid. A pid belongs to the kernel and is reused. A handle id belongs to this project and is never reused.

**Used in** `03-execution-model-and-primitives.md` §2.

### supervision scope

**Definition.** The owner that guarantees cleanup of an execution. That owner must not exit while the execution runs. The two values are `session` and `workspace`.

**Not** the I/O binding, and not a timeout or a priority. The earlier design fused scope with binding under the word `carrier`. That fusion produced the false rule "persistence requires a multiplexer". Keeping the two axes apart is the point of this section and of §4.

**Used in** `01-overview.md` §3, R1. `03-execution-model-and-primitives.md` §1. `04-runtime-architecture.md` §6.

### I/O binding

**Definition.** Where the bytes of an execution go, and whether a terminal is involved. The two values are `pipe` and `pty`.

**Not** the supervision scope. The binding decides `isatty()` and stdin writability. It never decides who may exit. A binding and a scope combine freely, in every cell (R2).

**Used in** `01-overview.md` §4, R2 to R4. §4 below.

### the space

**Definition.** The 2 x 2 grid of scope against binding. Four cells, all reachable.

**Not** a taxonomy for its own sake. The grid is the reason the two axes stay separate. Persistence is a property of the scope. `isatty()` is a property of the binding. Neither property implies the other. While `turn` existed, the space was 3 x 2. Removing `turn` in 0.2.0 removed a row, not a cell that the model needed.

**Used in** `01-overview.md` §5.

---

## 3. Dimension A — Supervision Scope

### owner

**Definition.** The thing that the scope names, which owes the execution a cleanup: the Pi session, or the workspace on disk.

**Not** the process that spawned the child. Pi always spawns the child. The owner is the thing that must reap it. Those are different questions.

**Used in** `01-overview.md` §3, R1. C10.

### reap

**Definition.** To end an execution and record its terminal state, so that neither a process nor a record is left unowned.

**Not** to kill. A reap can find the process already gone and still succeed. A kill that leaves the record unsealed is not a reap.

**Used in** `01-overview.md` R1. `05-durability-and-containment.md` §3.

### session

**Definition.** Scope value, and the default. The Pi session owns the execution. The turn may end freely while the session stays open. In a single-shot host (`pi -p` text or JSON), `agent_before_settle` waits for live, unready `session` executions with `notifyOnCompletion` and `triggerOnCompletion` enabled so their completions can continue the run. `session_shutdown` then reaps every remaining `session` execution, including ready companions and executions with either option disabled. A same-process `/reload` transfers ownership instead of reaping.

**Not** "background task". `session` is the default scope. It is also the reason `shell_start` does not block.

**Used in** `01-overview.md` §3. `04-runtime-architecture.md` §6.1.

### workspace

**Definition.** Scope value. The workspace on disk owns the execution. Pi may exit, and a later Pi process re-adopts the execution.

**Not** a directory path. The scope names an owner. The owner is identified by the workspace directory together with the writer lock.

**Used in** `01-overview.md` §3. `04-runtime-architecture.md` §6.2. C10.

### promote

**Definition.** To move a live `session` execution to `workspace` ownership. Promotion is one-directional and recorded in the durable metadata. Promotion is lossless for both bindings: the same process keeps writing the same log files.

**Not** "background". Backgrounding names an effect that the user observes. `promote` names the ownership change that produces the effect. The design offers no demotion. Narrowing ownership after the fact would break the invariants the model exists to keep.

**Used in** `01-overview.md` §3. `03-execution-model-and-primitives.md` §3.4. `04-runtime-architecture.md` §2.3. C10.

---

## 4. Dimension B — I/O Binding

### pipe

**Definition.** Binding. stdout and stderr are separate pipes owned by a detached pipe supervisor. The supervisor writes `stdout.log`, `stderr.log` and an arrival-ordered `combined.log`.

**Not** a PTY with the terminal removed. `pipe` has no terminal at all. `isatty()` is false. `shell_send` refuses. No third party can attach.

**Used in** `01-overview.md` §4, R4. `04-runtime-architecture.md` §2.1.

### pty

**Definition.** Binding. The child receives a PTY slave as its controlling terminal. The PTY master lives in a detached `script(1)` process, not in Pi.

**Not** a multiplexer. `script(1)` supplies the PTY with no external broker and no attach protocol.

**Used in** `01-overview.md` §4, R2. `04-runtime-architecture.md` §2.2.

### PTY

**Definition.** Pseudo-terminal. A kernel object made of a master endpoint and a slave endpoint, where the slave behaves like a terminal device.

**Not** a terminal emulator and not a window. A PTY is kernel state. A terminal emulator is a program that reads a PTY and draws a screen.

**Used in** `01-overview.md` §2 and §4. `04-runtime-architecture.md` §2.2.

### PTY master

**Definition.** The endpoint that some process must keep reading for the child to make progress. Its location decides persistence.

**Not** a socket, and not a name. A master is a file descriptor, and a file descriptor dies with the process that holds it. That is why the `pty` binding puts the master in a detached `script(1)` process rather than in Pi (R2).

**Used in** `01-overview.md` R2. `04-runtime-architecture.md` §2.2.

### detached holder

**Definition.** A process in its own session, with no file descriptor inherited from Pi, that owns the PTY master for a `pty` execution. `script(1)` started by a detached wrapper is one.

**Not** a broker. It serves exactly one execution and offers no client protocol, so nothing can attach to it (R3).

**Used in** `01-overview.md` §2 and R2. `04-runtime-architecture.md` §2.2.

### stdin FIFO

**Definition.** The named pipe a `pty` execution reads its stdin from. The wrapper holds it open read-write. When no writer is attached, the child never sees EOF. Any process — including a later Pi — can open it for writing.

**Not** a control channel. It carries the bytes a terminal would receive. `shell_send` is the only writer. A write with no reader fails rather than blocks.

**Used in** `01-overview.md` R2. `04-runtime-architecture.md` §2.2 and §5.

### viewport

**Definition.** The rendered terminal screen of a `pty` execution, read through `shell_read({stream: "ptyView"})`.

**Not** a log. A viewport contains carriage-return overwrites, cursor addressing and merged streams, exactly as a terminal displayed them. It is not evidence of the byte stream that produced it (C5, `05-durability-and-containment.md` §6). A pattern wait on `ptyView` matches the recording's bytes, not this rendering. The rendering is a `shell_read` operation.

**Used in** `03-execution-model-and-primitives.md` §3.3. `04-runtime-architecture.md` §2.2.

### pipe supervisor

**Definition.** The detached Node process `src/core/pipe-supervisor.mjs` that owns a `pipe` execution's stdout and stderr pipes. It writes the three log files, drains output past the cap, and seals `exit.json`.

**Not** a broker or a daemon. It serves exactly one execution and lives in its own session. When that execution settles, it exits.

**Used in** `04-runtime-architecture.md` §2.1 and §4.

### owner watch

**Definition.** The fd 3 pipe a `session` execution's supervisor or PTY wrapper reads. EOF means the owning Pi process died, and the execution must be torn down. The single line `release` means ownership moved to the workspace, and the execution must keep running.

**Not** a data channel. It carries one control decision. It exists because "the owner died" and "the owner promoted me" are indistinguishable from a closed file descriptor alone.

**Used in** `04-runtime-architecture.md` §2.1, §2.2 and §2.3.

---

## 5. Lifecycle, Identity and Completion (C1, C3, C6)

### settle

**Definition.** To reach a terminal state. The execution settles. The handle records it, and every waiter resolves at that instant.

**Not** to exit. A `lost` execution settles without an exit. A `timed-out` execution settles after the ladder, not after a signal.

**Used in** `03-execution-model-and-primitives.md` §3.2 and §4. C1.

### terminal state

**Definition.** One of `completed`, `failed`, `cancelled`, `timed-out` or `lost`. Once the metadata record is sealed, a terminal state is immutable.

**Not** `ready`. Readiness is a milestone, and a ready execution can still fail.

**Used in** C1. `03-execution-model-and-primitives.md` §2.

### ready

**Definition.** A milestone timestamp, `readyAt`. When the ready marker appears, the runtime sets it at most once.

**Not** a state. A process can run without being ready, and it can be ready and later fail. Kubernetes splits this into three probes for the same reason (C1, C2).

**Used in** C1. `04-runtime-architecture.md` §5.

### lost

**Definition.** Terminal state, `workspace` scope only. A later Pi process found the record but could not prove liveness.

**Not** `failed` and not `cancelled`. Nothing is known about the exit, and the design refuses to invent one.

**Used in** C1. `04-runtime-architecture.md` §6.2.

### unknown

**Definition.** The honest result of an interrupted unsafe call whose effect cannot be determined.

**Not** a handle state. `unknown` describes what is known, not what happened. An `unknown` result never resolves to `completed` by assumption (C8).

**Used in** C8. `05-durability-and-containment.md` §6.

### completion event

**Definition.** The durable record that an execution settled. When no await consumed it and notification is enabled, the runtime delivers it as a message.

**Not** a poll result. `shell_status` reads state and produces no event. Polling is defensible only when no event source exists, and here one does (C3).

**Used in** C3. `03-execution-model-and-primitives.md` §4.

### coalescing

**Definition.** Merging several completion events into one delivery. A busy agent gets one steer before the next LLM call. An idle agent gets one delivery after a short window.

**Not** dropping events. Every record is delivered. What collapses is the number of messages, so that twelve commands finishing together cost one model turn instead of twelve.

**Used in** C3. `03-execution-model-and-primitives.md` §4.

### delivery

**Definition.** When a completion reaches an agent that is still running: `steer` before the next LLM call, or `settle` at the settle boundary.

**Not** a Pi `deliverAs` value. `settle` names this package's own boundary. Pi's `followUp` is delivered at the same tool-batch boundary as a steer message.

**Used in** `03-execution-model-and-primitives.md` §4. `implementation-notes.md` §3.7.

### consumedByAwait

**Definition.** The flag that a `shell_await` already returned this handle's terminal state, so no follow-up event is needed. The inline window of a `shell_start` counts as an await.

**Not** a suppression of the record. The record stays durable. Only the wake-up is suppressed, and a later `shell_read` still finds the output.

**Used in** `03-execution-model-and-primitives.md` §4. `04-runtime-architecture.md` §7.

### inlineSettleMs

**Definition.** The bound on how long `shell_start` holds its own result for a settle. The default is 1000ms. The value `0` returns the handle at once.

**Not** a wait condition. It observes exit only. Readiness and output patterns remain `shell_await` conditions. Expiry cancels nothing.

**Used in** `03-execution-model-and-primitives.md` §3.1.

### process identity

**Definition.** The triple `(boot_id, pid, start)`, where `start` is field 22 of `/proc/<pid>/stat`. Liveness is proven against this triple.

**Not** a pid. The kernel reuses a pid after a reboot and after a wrap. Adopting a stranger's process to report its exit code is worse than reporting `lost` (C6).

**Used in** C6. `04-runtime-architecture.md` §6.2. `05-durability-and-containment.md` §7.

### sealed metadata

**Definition.** The `meta.json` record after its terminal state is written, by write-temp-then-rename.

**Not** a mutable status field. Sealing is what makes a terminal state immutable. The atomic rename is what stops a reader from observing a half-written record.

**Used in** `03-execution-model-and-primitives.md` §2. `04-runtime-architecture.md` §6.2 and §7.

---

## 6. Readiness and Wait Conditions (C2)

### readiness marker

**Definition.** The file `$PI_ASYNC_SHELL_EXEC_DIR/ready`. Every execution receives `PI_ASYNC_SHELL_EXEC_DIR` in its environment. A command creates the marker after its own health check succeeds.

**Not** a spawn option. `shell_start` has no readiness parameter. The marker is a fact on disk that `shell_await(until: {kind: "ready"})` observes (C2).

**Used in** C2. `03-execution-model-and-primitives.md` §3.2. `04-runtime-architecture.md` §5.

### output pattern

**Definition.** A regular expression over a declared stream, matched against new bytes from a recorded offset. The `since: "now"` option stops a repeated await from re-matching an answered prompt.

**Not** robust. A pattern is the fallback form, and the design says so. It exists because most third-party programs will never emit a marker. A partial final line is still output, so a prompt without a trailing newline can satisfy a pattern.

**Used in** C2. `03-execution-model-and-primitives.md` §3.2. `04-runtime-architecture.md` §5.

### wait condition

**Definition.** One of `exit`, `ready` or `pattern`, passed to `shell_await` as `until`. It decides what the caller is waiting for. It never decides who owns the execution.

**Not** a cancellation. A wait condition that expires leaves the execution running (C4, C9).

**Used in** C2 and C9. `03-execution-model-and-primitives.md` §3.2.

### `sd_notify(READY=1)`

**Definition.** The systemd convention in which a service writes `READY=1` to a socket to announce that it can serve.

**Not** available here. This project copies the shape of the convention, not its API. The marker file is the local equivalent.

**Used in** C2. `01-overview.md` §7.

### `Type=notify`

**Definition.** The systemd unit type that waits for `sd_notify` before it treats the service as started.

**Not** a systemd dependency. It is the analogue that justifies treating readiness as a protocol rather than as a guess.

**Used in** C2. `04-runtime-architecture.md` §5.

---

## 7. Cancellation, Containment and Output (C4, C5)

### cancellation ladder

**Definition.** Graceful signal, grace period, forced kill, then verification that the tree is gone.

**Not** a single kill. A kill delivers a signal. The ladder verifies absence. When verification fails, it reports `failed` with a descendant-leak diagnostic.

**Used in** C4. `04-runtime-architecture.md` §3.

### containment

**Definition.** The guarantee that after a cancel, or after a `session` owner exit, no process from the execution still runs.

**Not** cancellation. Cancellation asks a process to stop. Containment proves that it did. Signalling a process group is a delivery mechanism, not a containment guarantee (C4, `05-durability-and-containment.md` §5).

**Used in** C4. `04-runtime-architecture.md` §3. `05-durability-and-containment.md` §5.

### fence

**Definition.** The scan-and-kill loop that enforces containment. It collects tagged processes and their descendants, the live descendants of every known identity, and the live members of every owned process group. It signals those processes and repeats until the set is empty or a deadline expires.

**Not** a signal to a process group. A group is escapable. `setsid(2)` moves a child into a new session and a new group, after which `-pgid` reaches nothing.

**Used in** `04-runtime-architecture.md` §3. `05-durability-and-containment.md` §5.

### process tag

**Definition.** The environment variable `PI_ASYNC_SHELL_EXEC=<id>`, injected at spawn and inherited by every descendant.

**Not** an identity. A tag says "this process belongs to execution X". Identity says "this is the same process as before". Containment needs both, and the design adopts both rather than either.

**Used in** `04-runtime-architecture.md` §3. `05-durability-and-containment.md` §5.

### drain

**Definition.** To keep reading a pipe and discard the bytes beyond the log cap, so that the child never blocks in `write(2)`.

**Not** to stop reading. Stopping reading is how a logging policy becomes a hang. A Linux pipe holds 64 KiB by default, and the child blocks on the next write (C5).

**Used in** C5. `04-runtime-architecture.md` §4.

### backpressure

**Definition.** The condition in which a full pipe blocks the writer until a reader makes room.

**Not** a reason to stop draining. Backpressure is the mechanism that makes drain-not-kill necessary. It is also the mechanism that punishes a cap implemented as a pause.

**Used in** C5. `01-overview.md` §7.

### log cap

**Definition.** `PI_ASYNC_SHELL_MAX_LOG_BYTES`, default 100 MiB. When the pipe supervisor reaches the cap, it stops appending, keeps draining the pipes, and writes `log-cap.json`.

**Not** a process policy. Reaching the cap never ends the execution. This is the single largest behavioural difference from `pi-background-tasks`, whose 20 MiB cap kills the task. The cap covers every `pipe` execution, at both scopes, because every pipe execution is file-backed through the supervisor. It does not cover a `pty` recording: `script(1)` writes that file directly, so it grows until an operator or the filesystem stops it.

**Used in** C5. `04-runtime-architecture.md` §4.

### durable output

**Definition.** The on-disk logs `stdout.log`, `stderr.log`, `combined.log` and `ptyView.log` under the execution directory.

**Not** the model's context. A bounded, requested slice enters the context through `shell_read`. The full log stays on disk.

**Used in** C5. `03-execution-model-and-primitives.md` §3.3.

### garbage collection (GC)

**Definition.** The startup and hourly sweep that removes expired terminal records, their logs, promoted links, and orphan request records from `.pi/async-shell`.

**Not** a reaper. GC never touches a running, nonterminal, protected, or current-session record. A crashed owner must not turn a live workspace process into garbage.

**Used in** `04-runtime-architecture.md` §7. `03-execution-model-and-primitives.md` §2.

---

## 8. Durability Across Processes (C6, C8, C10)

### adopt

**Definition.** To take ownership of an existing `workspace` execution from a previous Pi process, after proving liveness.

**Not** to restart. Adoption continues the same process and appends to the same logs. The process never learns that its owner changed.

**Used in** `04-runtime-architecture.md` §6.2. C10.

### re-adoption

**Definition.** The adoption scan that runs at `session_start` over the workspace records, including promoted session records. It classifies each record as finalised, restored as running, or `lost`.

**Not** recovery of a crashed Pi session. The session is gone. The execution is not. The scan exists to find out which of the three cases holds.

**Used in** `04-runtime-architecture.md` §6.2. `01-overview.md` §3 and §5. C10.

### writer lock

**Definition.** The exclusive lock at `.pi/async-shell/workspace/.lock` that a process must hold before it adopts `workspace` handles.

**Not** a protocol convention. A process that cannot take the lock never becomes an owner by accident, and it opens the registry read-only instead.

**Used in** C10. `05-durability-and-containment.md` §2.

### one-writer

**Definition.** The rule that exactly one process adopts `workspace` handles for a given directory. Other processes may read status and logs.

**Not** single-reader. Many readers are allowed. Only writers are exclusive, and `shell_promote`, `shell_send` and `shell_cancel` refuse rather than race the owner.

**Used in** C10. `05-durability-and-containment.md` §2.

### replay safety

**Definition.** A per-operation declaration of whether re-running the operation after a crash is indistinguishable from running it once.

**Not** a guess, and not a property of a tool family. `shell_read` and `shell_status` are safe. `shell_start` and `shell_send` are not, because a second build is a second build and a second answer is a second keystroke (C8).

**Used in** C8. `05-durability-and-containment.md` §2.

### request id

**Definition.** A caller-supplied identifier that makes an unsafe operation replay-safe through no-replace publication.

**Not** a handle id. A request id names an attempt. A handle id names an execution. Two attempts with one request id produce one execution.

**Used in** C8. `05-durability-and-containment.md` §2.

### intent record

**Definition.** The durable, fsynced note written before the external effect, so that a crash leaves evidence of what was attempted.

**Not** the completion record. The intent record precedes the effect. The completion record follows it. A crash between the two is exactly the case that `unknown` describes.

**Used in** C8. `05-durability-and-containment.md` §2.

### no-replace publication

**Definition.** Writing a result under the request id only when no result exists there. A replay then returns the first result instead of producing a second effect.

**Not** an overwrite. An overwrite would make a replay indistinguishable from a first run, which is the failure that replay safety exists to prevent.

**Used in** C8. `05-durability-and-containment.md` §2.

---

## 9. Waiting: The Short Form and the Long Form (C9)

### `shell_await` short form

**Definition.** A bounded wait inside one tool call. `waitMs` defaults to 30000 and is capped at 50000.

**Not** the general way to wait. A tool call in `pi-coding-agent` cannot be suspended, so `shell_await` blocks for as long as it waits. It is correct only when crossing a turn boundary would cost more than the wait. The 50000 cap leaves room in codemode's 60-second default script budget. A wait measured in minutes belongs to the long form, not to `shell_await` (C9).

**Used in** C9. `03-execution-model-and-primitives.md` §3.2.

### ending the turn long form

**Definition.** The long wait: end the turn and let the completion event resume the conversation. In a resident session, the event arrives after the turn ends. In a single-shot host, the extension holds `agent_before_settle` until each pending wake-up settles or becomes ready, injects the settled records, and continues the run. The on-disk registry is the checkpoint in both cases.

**Not** giving up, and not a general way to outlive a single-shot host (`pi -p`). In a resident session, ending the turn suspends the conversation at zero cost and serves as the local equivalent of Pi Durable's park (`05-durability-and-containment.md` §1). In a single-shot host, only a live, unready `session` execution with notification and triggering enabled holds settlement. Ready companions and executions with either option disabled do not hold it; final `session_shutdown` reaps them. An execution that must outlive that shutdown belongs to `workspace`.

**Used in** C9. `01-overview.md` R1.

### wait and work

**Definition.** Two separate questions. Cancelling a wait is not cancelling the work. Aborting a `shell_await` detaches the waiter and does not enter the cancellation ladder.

**Not** a nicety. This is the distinction that stops an Escape key from killing a build. It is the one rule that three independent codebases arrived at separately (`05-durability-and-containment.md` §7).

**Used in** C4. `01-overview.md` §7. `04-runtime-architecture.md` §3.

---

## 10. Retired and Forbidden Terms

These words are forbidden. Each one is listed with its replacement.

### carrier

**Retired.** `carrier` named the fused pair (scope, binding) and implied that persistence required a multiplexer. Use `supervision scope` and `I/O binding`. When a sentence needs both, name the cell.

The file `03-carrier-and-runtime-architecture.md` is now `04-runtime-architecture.md`. The rename is recorded in `05-durability-and-containment.md` §8.

### background task

**Retired as a design term.** It fuses ownership, I/O binding and persistence into one word, and each of the three varies independently. Use `scope` and `binding`. The phrase survives only in the name of the external package `pi-background-tasks`, where it is a proper noun.

### park

**Not used here.** `park` is Pi Durable's suspended-call mechanism. `pi-coding-agent` has no scheduler, so this project has no park. Ending the turn serves that role, and `05-durability-and-containment.md` §1 explains the difference.

### "blocking" as a property of a command

**Retired.** Blocking is a relation between a command's completion and an owner's exit. It is not a property of the command, and no command is blocking in itself.

### viewport as log

**Retired.** A viewport shows what a terminal displayed. A log records the bytes that were written. Use `viewport` for the first and `durable output` for the second. Keep the two separate.

### turn

**Retired scope, removed in 0.2.0.** `turn` named the current agent turn as owner. A still-running execution at settle time became an error. It was removed with its settle-time forced kill and its error continuation. Use `session`, which survives the turn, or `workspace`, which survives Pi. A caller that needs a causal barrier inside one turn calls `shell_await`, and acquires no narrower owner.

### readiness declaration

**Retired spawn option, removed in 0.2.0.** `shell_start.readiness` accepted `marker`, `pattern` or `immediate` at spawn time. Readiness is now a wait condition: the marker is `$PI_ASYNC_SHELL_EXEC_DIR/ready`, and patterns are passed to `shell_await`. `immediate` is gone with the declaration. A caller that does not need to wait does not wait.

### "a pipe cannot be promoted"

**Retired rule, removed in 0.2.0.** It was true only while a session pipe's stdio was a pipe held by Pi. Every pipe execution now runs under a detached supervisor with file-bound logs. Promotion therefore releases the owner watch and keeps the same process and the same files.
