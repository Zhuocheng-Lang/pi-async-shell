---
kind: empirical
applies_to: 0.2.2
tracks:
  - src/core/containment.ts
  - src/core/identity.ts
  - src/core/workspace-lock.ts
---

# 05. What Pi Durable Suggests, Translated

The target host of this project is `@earendil-works/pi-coding-agent`. `@earendil-works/pi-durable` is a different first-party package (experimental, shipped with Pi 1.0). It serves agent applications that may have no terminal, may be evicted, and may run under several humans at once. This project supports the target host only. Reading Pi Durable is not a commitment to support it.

Pi Durable is worth reading. It is the one Pi codebase that had to answer this project's own question rigorously and in writing. The question is this: **what is the difference between waiting for work and owning it?** Several of its answers transfer. One of them corrected the model.

Everything attributed to Pi Durable below comes from `packages/durable/README.md` in `earendil-works/pi`. Everything attributed to `pi-durable-subagents` comes from that third-party package. When Pi Durable has nothing to say, this document cites that package instead.

---

## 1. The Claim That Matters

> A tool that waits for the outside world ... returns a park instead of a result ... The call then holds no process. Once woken, `execute()` runs again with the same arguments, `api.wake` saying why and `api.checkpoint` holding what it parked with.

Pi Durable separates **the wait** from **the work** in the type system. A waiting call is not a running call, and it costs nothing while it waits. Its harness owns the scheduler. A tool can therefore return a suspended state. The harness resumes that state later.

`pi-coding-agent` has no such scheduler. A tool call runs to completion or it is aborted. There is no third state. The mechanism therefore cannot be copied. The previous draft of this document was wrong to conclude that `shell_await` should become a park here.

**But `pi-coding-agent` already has its own park. This project was already using it without naming it.** Ending the turn suspends the conversation at zero cost. The completion follow-up is the resume signal. `api.checkpoint` is the handle registry, which is durable on disk. This project gets every property that Pi Durable gets from parking, from `scope: session` plus a completion event. The exceptions are the properties that depend on surviving eviction. A terminal does not evict.

The real correction is therefore narrower and more useful than "add parks":

**`shell_await` blocking is right. It is the *non-resumable* form.** It serves waits short enough that the turn boundary is not worth crossing. Anything longer should end the turn. That rule decides whether a wait belongs in `shell_await` at all. It was missing. The 0.2.0 cap makes the rule concrete. `waitMs` defaults to 30000 and cannot exceed 50000. That ceiling fits inside codemode's 60-second default script budget.

---

## 2. Translation Table

Each row is a problem that both codebases have, solved with different primitives. The right-hand column states what this project does, not what it should copy.

| Pi Durable's solution | The problem | How `pi-coding-agent` solves it here |
|---|---|---|
| park: `{ sleep: { signals } }` / `{ wait: { on, policy } }` | a tool call must not pin a process for minutes | end the turn; `<async-shell-completion>` resumes. `scope: session` already is this |
| `replay: "safe"` declaration; otherwise `interrupted` | a crash must not silently duplicate an effect | C8: `request` id on `shell_start`/`shell_send`, no-replace publication, honest `unknown` |
| `api.memo(key, value)` before the external call | the idempotency key must be durable *before* the effect | the intent record is written and fsynced before `spawn` |
| `readOnly: true`; one writer per storage | two processes must not both adopt the same work | C10: a writer lock over `.pi/async-shell`, held by us |
| `settings.restartLimit` (default 5) | a crash loop must terminate | a per-handle re-adoption attempt counter (5) |
| `output` / `structuredOutput` / `details` | three audiences, three shapes | `content` / `structuredContent` / `details` — the platform's own convention |
| `{ background: true }` task boundary | work outliving its parent must be explicit | `scope: workspace` + `shell_promote` — already the model |
| `failFast` / `allSettled` / `any` | fan-in needs a policy, not a default | `mode: all\|any` on `shell_await` |

Eight rows. Two were already right. One (C8) is a genuine addition. One (C10) adds a lock that this project had been planning to arbitrate by protocol instead.

---

## 3. The Refinement to R1

`01-overview.md` first stated R1 as "blocking is a consequence of scope". That statement is true only where waiting and owning consume the same resource. Pi Durable's park is the counter-example. It shows why the phrasing matters, even where the mechanism is unavailable.

Corrected, and now stated in the target host's own terms:

> **Scope decides who may reap the process. The wait decides who may proceed. Ending the turn is what lets those two answers differ.**

`session` scope means the conversation may end. The session still owes the execution a cleanup. `workspace` scope means even the session's exit does not end that debt. `shell_await` narrows the *wait* for one tool call. It changes neither.

---

## 4. Where the Borrowing Stops

Each of these is reasonable in Pi Durable and wrong here. Listing them keeps the boundary explicit rather than implied.

| Not taken | Why it is right there and wrong here |
|---|---|
| A durable task journal with CRC framing, dense sequence numbers and torn-tail repair | Their journal is the system of record for multi-step LLM work that may be replayed and audited. A `session`-scoped shell command needs an atomic metadata record, not a log. |
| A separate scheduler process that owns storage | Their harness must outlive every conversation and survive eviction. Here the extension lives inside the same Pi process as the agent. A daemon would add IPC, a lifecycle and a failure mode, to buy durability for scopes that do not need it. |
| `readOnly: true` as a session mode | The rule transfers. The implementation does not exist here, so C10 specifies our own lock. |
| Parks, signals, checkpoints, `abandonOnRestart` | These are the harness's own vocabulary. Adopting the words without the scheduler would be decoration. |
| Model pools, hibernation, evaluator sandbox, per-conversation environments | Out of scope by construction. |

---

## 5. The One Thing Neither First-Party Project Solves

Pi Durable's durability is the durability of a **record**. Its execution abstraction is the environment (`exec()`, `openBinaryReader()`, `cleanup()`). The documented story for ending work is this:

> Abort the context to end one call. `cleanup()` is for shutting the environment down.

A search of its published README for process-containment terms returns only *task* orphaning, which is a different thing. There is no process-group capture, no descendant walk, and no fence. There is also no state for "we started something and lost it". `pi-coding-agent`'s own `bash` tool is in the same position. It kills a process tree on abort. It has no notion of a process that outlives the call.

That gap is this project's job. The only published treatment of it is in `pi-durable-subagents`. That package injects `DSA_EXEC=<execId>` into every spawn. Descendants inherit the tag. Termination then scans `/proc/*/environ` for the tag. It unions the live descendants reached by `ppid` from every known `(pid, start)` identity. It repeats scan-and-`SIGKILL` until the union is empty or a deadline expires. The runtime re-reads identity immediately before each signal, so a reused pid is never killed.

Its interface document turns that into a required test. The requirement is what makes it credible:

> a child that runs `setsid sleep` and is then SIGKILLed is still fenced by its tag.

The test exists because a process group is escapable. `setsid(2)` creates a new session and a new group. A signal to `-pgid` afterwards reaches nothing. That was a real hole in this project's own cancellation ladder. An execution that started a server through `nohup ... &` would have reported a clean cancel. The server would have kept running.

Adopted: group **and** tag, not either. The group is the cheap graceful path. It is the only path where `environ` is unreadable. The tag is the containment guarantee. Cancel and timeout trigger fencing at every scope. Owner exit triggers it only for `session`, because a `workspace` handle has no owner watch. That mechanism makes `session` leak-free and leaves `workspace` adoptable.

---

## 6. Honest Limits

- **Cancellation is not rollback.** Stopping `pnpm publish`, a migration or a `git push` half-way does not undo what already ran. Processes are contained. Effects are not transactional.
- **Containment has a detection floor.** A process can clear its tag and leave the tree before the next scan. That process is not found. The scan interval is the bound, and the document states it rather than hiding it.
- **A kill list is not proof of death.** It records what the runtime tagged and tracked. Identity rechecks may skip a pid that exited and was reused. That direction errs safe.
- **`lost` is a real outcome.** A `workspace` handle can have no exit record. When liveness stays unproven, the answer is `lost`, never `completed`.
- **`unknown` is a real outcome.** A `shell_start` or `shell_send` interrupted after its intent record leaves the effect unknown. The honest answer is `unknown`, never a silent duplicate.
- **A terminal viewport is not a log.** What a terminal displayed includes overwrites and cursor addressing. It is not evidence of the byte stream.
- **The pipe cap is not a PTY cap.** A `pipe` execution stops recording at `PI_ASYNC_SHELL_MAX_LOG_BYTES` and keeps draining. `script(1)` writes a `pty` recording directly to disk. It grows until an operator or the filesystem stops it. Nothing kills the process in either case.
- **The wait is bounded by the host.** `shell_await` cannot exceed 50000 ms. A tool call cannot be suspended. A longer wait is ending the turn, not a longer `waitMs`.
- **The runtime is Linux-only.** Process identity, containment and the PTY recipe depend on procfs, process groups and `script(1)`. A non-Linux platform fails with an explicit error instead of returning an empty process tree.

---

## 7. Convergence Worth Noting

Three codebases, four agreements. Independent arrival at the same rule is the best available evidence that the model in `01-overview.md` is not arbitrary.

| Rule | Pi Durable | `pi-durable-subagents` | `pi-async-shell` |
|---|---|---|---|
| Cancelling a wait is not cancelling the work | *"Cancelling a wait only cancels that wait, never the work."* | `stop` is the only way to end a command; aborting a waiter does not | C4 |
| Outliving the owner is an explicit boundary | `{ background: true }` | `run --wake caller` | `scope: workspace` / `shell_promote` |
| Fan-in needs a policy, not a default | `allSettled` / `failFast` / `any` | `tasks` parallel, first failure stops the branch | `mode: all\|any` |
| Process identity is `(pid, start)` | not applicable (no process layer) | a required test | C6 |

The single disagreement is instructive. Pi Durable makes a wait cost nothing by suspending the task. Here a wait costs a tool call. That is a property of the host, not a design flaw. It is the reason the documents describe `shell_await` as the short form. Ending the turn is the long form.

---

## 8. Document History and Renames

The document set was renumbered to make room for the glossary at `00`. Two renames matter for old links.

1. **`03-carrier-and-runtime-architecture.md` is now `04-runtime-architecture.md`.** The word `carrier` is retired. It named the fused pair (scope, binding) and implied that persistence required a multiplexer. `00-terminology.md` §10 records the retirement. Every link to the old filename resolves to the new one.
2. **This document was `04-durability-and-containment.md`.** It is now `05-durability-and-containment.md`. The content keeps its subject and its structure.

The full old-to-new map:

| Old filename | New filename |
|---|---|
| — (new) | `00-terminology.md` |
| `00-overview.md` | `01-overview.md` |
| `01-ecosystem-survey-and-value.md` | `02-ecosystem-survey-and-value.md` |
| `02-execution-model-and-primitives.md` | `03-execution-model-and-primitives.md` |
| `03-carrier-and-runtime-architecture.md` | `04-runtime-architecture.md` |
| `04-durability-and-containment.md` | `05-durability-and-containment.md` |

The same map applies to `docs/design/zh-CN/`, with the same filenames.

### 8.1 Removals in 0.2.0

Three rules in the earlier document set described a runtime that no longer exists. They are recorded here so a reader of an old link is not left with a rule that the code contradicts:

- **`turn` scope, and the settle-time forced kill that enforced it.** A turn boundary no longer cancels anything. `session` is the narrowest scope, and it survives the turn.
- **`shell_start.readiness` and the `marker` / `pattern` / `immediate` declaration.** Readiness is a wait condition. The marker at `$PI_ASYNC_SHELL_EXEC_DIR/ready` is one form. Patterns passed to `shell_await` are the other.
- **"A `pipe` execution cannot be promoted."** That was true only while Pi held a session pipe's stdio. Every pipe execution now runs under a detached supervisor with file-bound logs. Promotion releases the owner watch and keeps the process, the pid and the files.
