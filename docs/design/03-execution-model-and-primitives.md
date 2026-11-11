# 03. Execution Model and Primitives

## 1. Selection Procedure

The agent answers three questions, in this order. The first sets the scope. The second sets the binding. The third decides only whether to call `shell_await` in the same turn.

1. **Must it survive Pi exiting?** Yes -> `scope: "workspace"` (defaults `notifyOnCompletion: false`). No -> `scope: "session"`, which is the default.
2. **Does the program test `isatty()`, prompt, or drive a TUI?** No -> `binding: "pipe"`. Yes -> `binding: "pty"`. There is no third answer: terminal interaction is the agent's, through `shell_send` and `ptyView` (R3).
3. **Is there independent work to do first?** If yes, start the execution first and `shell_await` later. If there is genuinely nothing else, ending the turn is cheaper than waiting, because the completion event wakes the session.

Two guards follow from the model, not from policy:

- Every scope combines with every binding, and both bindings promote from `session` to `workspace` without a respawn or a log transition (R2, R4).
- A turn boundary never cancels a `session` execution. There is no narrower scope and no settle-time error. A caller that needs a causal barrier inside one turn calls `shell_await`; it does not acquire a different owner.

Commands expected to finish in a second or two belong on built-in `bash`. `shell_start` adds a handle, a log directory and a tool round-trip. None of that pays for itself on `git status`.

---

## 2. Handle Identity and State

Every execution gets an id of the form `sh_<8 hex chars>` and a durable directory. The states are:

```
starting -> running -> { completed | failed | cancelled | timed-out | lost }
                 |
                 +--> ready (milestone timestamp, not a state)
```

- `ready` is set at most once, when the ready marker appears. It does not affect terminal state, and it does not stop the process.
- `lost` exists only for `scope: "workspace"`: a later Pi process found the metadata but could not verify liveness under contract C6 in `01-overview.md` (identity is `boot_id` + pid + process start time).
- Terminal states are immutable once the metadata record is sealed. Any waiter resolves at that instant.
- A terminal record is eligible for GC, not deleted on settle. The default retention is 24 hours and 100 terminal records (`04-runtime-architecture.md` §7).

---

## 3. Contracts

### 3.1 `shell_start`

It admits an execution and returns its handle. It waits for nothing except successful admission: the process is spawned and the metadata is written.

```ts
interface ShellStartParams {
  command: string;
  /** 2-6 word label for the footer status and the handle list. */
  name?: string;
  cwd?: string;
  /** Explicit values also restore a sensitive variable removed by the default filter. */
  env?: Record<string, string>;
  /** Owner of this execution. Default: "session". */
  scope?: "session" | "workspace";
  /** stdio topology. Default: "pipe". Readiness/prompt use implies "pty". */
  binding?: "pipe" | "pty";
  /** Wall-clock limit. Transitions to timed-out via the cancellation ladder. */
  timeoutSeconds?: number;
  /** Deliver a completion event when nothing is awaiting. Default: true for session, false for workspace. */
  notifyOnCompletion?: boolean;
  /** Start a follow-up turn when that event fires while Pi is idle. Default: true. */
  triggerOnCompletion?: boolean;
  /** When a completion reaches a running agent. Default: "steer". */
  delivery?: "steer" | "settle";
  /** Caller-supplied replay key. Two starts with one request produce one execution. */
  request?: string;
}

interface ShellHandle {
  id: string;
  name: string;
  command: string;
  cwd: string;
  scope: "session" | "workspace";
  binding: "pipe" | "pty";
  status: "starting" | "running" | "completed" | "failed" | "cancelled" | "timed-out" | "lost";
  pid?: number;
  pgid?: number;
  startedAt: number;
  readyAt?: number;
  endedAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  log: { dir: string; stdout: string; stderr: string; combined: string; ptyView?: string };
  bytes: { stdout: number; stderr: number; combined: number; capReached: boolean };
  error?: string;
  consumedByAwait?: boolean;
  notifyOnCompletion?: boolean;
  triggerOnCompletion?: boolean;
  delivery?: "steer" | "settle";
  timeoutSeconds?: number;
}
```

There is no `readiness` parameter. A command that can prove its own health creates `$PI_ASYNC_SHELL_EXEC_DIR/ready`; a command that cannot is observed through an output pattern on `shell_await`.

### 3.1a Result channels

Every tool returns three channels, by host convention. `content` is for the model, and it is bounded and human-readable. `structuredContent` is for programs such as `codemode` scripts; it is typed and validated against `outputSchema`. `details` is for the UI. `structuredContent` never enters the session transcript, and the model never reads the raw structured value.

### 3.2 `shell_await`

It narrows one or more executions into the current tool call. It **never changes ownership and never kills anything on timeout**. This is the `errgroup.Wait` / `TaskGroup` / `StructuredTaskScope` surface.

This call blocks for as long as it waits, because a tool call in `pi-coding-agent` cannot be suspended. It is therefore the **short form**. For a wait long enough that crossing a turn boundary is cheaper, end the turn instead, and let the completion event resume the conversation (`01-overview.md` C9).

```ts
interface ShellAwaitParams {
  ids: string | string[];
  /** all = every handle satisfies the condition; any = first one wins. Default: all. */
  mode?: "all" | "any";
  /** Wait condition. Default: { kind: "exit" }. */
  until?:
    | { kind: "exit" }
    | { kind: "ready" }
    | {
        kind: "pattern";
        regex: string;
        stream?: "combined" | "stdout" | "stderr" | "ptyView";
        since?: number | "now";
      };
  /** Cap on this call's blocking time. Default 30000, max 50000. Expiry does not terminate anything. */
  waitMs?: number;
  /** Include a bounded tail preview per handle. Default: true. */
  includeOutputPreview?: boolean;
}

interface ShellAwaitResult {
  settled: boolean;              // every requested handle reached a terminal state
  timedOutWaiting: boolean;      // the wait ended by deadline or abort, not by satisfaction
  matched?: { id: string; line: string; byteOffset: number };
  outcomes: ShellHandle[];       // handles that were terminal when the wait returned
  stillRunning: ShellHandle[];   // handles not terminal then, including a pattern match on a live one
}
```

The three conditions:

- `exit` is satisfied when the execution reaches a terminal state.
- `ready` is satisfied when `$PI_ASYNC_SHELL_EXEC_DIR/ready` exists, or when the execution settles without creating it. A command that exits before readiness is not waited on forever.
- `pattern` is satisfied by a line, or by a partial final line, that matches the regex on the declared stream. `since: "now"` records the current end-of-stream offset before it waits, so a repeated await in an `expect` loop cannot re-match a prompt that was already answered. A match reports the line and its byte offset; a wait that ends because the execution settled reports no match.

`mode: "any"` returns as soon as one handle satisfies the condition; `mode: "all"` waits for every handle. A handle that settles while the caller is awaiting it is marked `consumedByAwait`, so no completion message duplicates it.

`stream: "ptyView"` in a pattern wait reads the terminal recording's bytes, which for a `pty` execution is the same file as `combined`; a `pipe` falls back to `combined`. The rendered screen is a `shell_read` view, not a wait stream.

### 3.3 `shell_read`

Bounded retrieval. The hard cap per call is 2000 lines or 50 KiB, whichever comes first.

```ts
interface ShellReadParams {
  id: string;
  /** ptyView is the rendered terminal screen, binding pty only; not a substitute for the byte log. */
  stream?: "combined" | "stdout" | "stderr" | "ptyView";
  mode?: "tail" | "head" | "offset" | "grep";
  lines?: number;      // default 200, max 2000
  maxBytes?: number;   // default 16384, max 51200
  lineOffset?: number; // 1-based, mode=offset
  byteOffset?: number; // 0-based, mode=offset
  pattern?: string;    // regex, mode=grep
  context?: number;    // default 2, max 20, mode=grep
  stripAnsi?: boolean; // default true
}

interface ShellReadResult {
  id: string;
  status: ShellHandle["status"];
  stream: "combined" | "stdout" | "stderr" | "ptyView";
  text: string;
  truncated: boolean;
  totalLines: number;
  totalBytes: number;
  range: { startLine?: number; endLine?: number; startByte?: number; endByte?: number; nextLine?: number; nextByte?: number };
  fullLogPath: string;
  note?: string;
}
```

A `pipe` execution has separate `stdout.log` and `stderr.log` as well as `combined.log`. If a `workspace` `pipe` execution's requested `stdout` or `stderr` file is empty, `shell_read` returns `combined` with a note; the supervisor still writes separate files at both scopes. A `pty` execution merges both streams into one recording: `stdout.log` and `ptyView.log` are links to `combined.log`, and a read of `stderr` reports that it is merged. `ptyView` on a `pipe` handle falls back to `combined` with a note.

### 3.4 `shell_promote`

It moves a live `session` execution to `workspace` ownership. This is the operation people call "backgrounding", named honestly.

```ts
interface ShellPromoteParams {
  id: string;
  to: "session" | "workspace";
  /** workspace only: set notifyOnCompletion on the promoted record. Omitted: leave the current value. */
  adopterNotification?: boolean;
}
```

Promotion is one-directional and recorded in the durable metadata, and a settled execution is not eligible for promotion. `to: "workspace"` is the effective move; `to: "session"` is accepted only when the execution is already `session`, and narrowing a `workspace` execution is refused. The design offers no demotion, because narrowing ownership after the fact would require re-establishing invariants that the model exists to preserve. To stop a promoted execution, use `shell_cancel`.

Promotion is lossless for both bindings. The execution keeps the same process, the same log files and the same pid; the runtime releases the fd 3 owner watch, writes a workspace link, and persists `scope: "workspace"` in the metadata. Nothing is respawned, and no byte is lost at the transition.

### 3.5 `shell_cancel`

```ts
interface ShellCancelParams {
  ids: string | string[];
  /** graceful: SIGTERM to the group, or ^C into a PTY, then wait graceMs. force: skip straight to SIGKILL. */
  ladder?: "graceful" | "force";
  graceMs?: number;  // default 3000
}
```

It resolves only after tree absence has been *verified*, not merely signalled. A verification failure surfaces as `failed` with a descendant-leak diagnostic. Cancelling an execution this process does not own returns `verifiedGone: true` with a note that there is nothing to cancel; it never signals a stranger's process.

### 3.6 `shell_send`

It writes into the stdin FIFO of a `pty` execution. It refuses on `pipe`, and it refuses once the execution has settled. The write does not need the calling process to own the execution, so it works from a Pi that adopted the handle after a restart.

```ts
interface ShellSendParams {
  id: string;
  text?: string;
  keys?: string[];            // e.g. ["Enter"], ["Down", "Enter"], ["Ctrl c"]
  /** Wait this long for the screen to change, then return the screen. Default 500ms, max 10000ms. */
  settleMs?: number;
  /** Caller-supplied replay key. A second send with one request sends nothing. */
  request?: string;
}
```

`wrote: false` means the bytes did not reach the child: either the FIFO has no reader yet, or this request id already sent once. The returned `screen` is the rendered `ptyView` after `settleMs`, and it is a convenience, not the contract.

`shell_send` plus `shell_await(until: {kind: "pattern", since: "now"})` is the manual form of the `expect` loop. The mature declarative form is a sequence of `(pattern, response)` steps. It is not in 0.2.0, for two reasons. It is strictly more tool surface for the same reachable behaviour. And a wrong pattern in a declarative spec fails silently, while a wrong pattern in an await produces a timeout that the agent can see.

### 3.7 `shell_status`

Point-in-time inspection of one handle or of all handles. Its prompt guideline forbids polling in a loop. Synchronisation is `shell_await`, and idle waiting is ending the turn. The result reports `running`, `ready` and whether this process owns the workspace writer lock.

---

## 4. Completion Semantics

Five facts determine whether a completion event is delivered:

| Fact | Effect |
|---|---|
| A `shell_await` on this handle returns its terminal state | `consumedByAwait = true`; no follow-up event |
| `notifyOnCompletion` is true and no await consumed it | enqueue a completion record |
| The agent is busy, `delivery: "steer"` (default) | records are coalesced and steered before the next LLM call |
| The agent is busy, `delivery: "settle"` | records are coalesced and injected once at `agent_before_settle` |
| The agent is idle | one follow-up message after a 150 ms coalescing window; `triggerOnCompletion` decides whether a turn starts |
| Owner is `workspace` and Pi exits first | record persists; surfaced on the next `session_start` when notification is enabled |

Coalescing matters. A batch of twelve commands that finish within a second would otherwise produce twelve wake-ups and twelve model turns for one decision. A `workspace` record never starts a turn by itself: `notifyOnCompletion` defaults to false for that scope, and a record that is surfaced at `session_start` is delivered as a next-turn message.

Steering is the default because a completion is information for the next decision, not a postscript to the run. `delivery: "settle"` keeps the earlier behaviour for a plan that must not be interrupted: the record is held and injected at `agent_before_settle` with `continue: true`, so the run stays alive for it. The second mode is defined by this package's settle boundary rather than by Pi's `deliverAs: "followUp"`, because a follow-up message is delivered at the same tool-batch boundary as a steer message and therefore is not an opt-out from mid-run delivery.

---

## 5. Surfaces

- `/async-shell` — list of handles with id, name, status, exit code, duration, scope, binding, readiness, bytes and log cap, plus `read tail` / `cancel` through `ctx.ui.select`.
- `/async-shell run <cmd>` — user-initiated, `scope: session`, `notifyOnCompletion: true`, `triggerOnCompletion: false`. It reports back but does not fire a model turn.
- `/async-shell cancel <id>` and `/async-shell read <id>` — direct actions without the menu.
- Footer widget: `async-shell: 3 running, 1 ready`; clears when no handle is running or starting.
