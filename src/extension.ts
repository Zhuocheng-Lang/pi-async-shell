// SPDX-FileCopyrightText: 2026 Zhuocheng-Lang
// SPDX-License-Identifier: MPL-2.0

/**
 * pi-async-shell — supervised asynchronous shell executions for Pi.
 *
 * The extension layer is deliberately thin. The registry knows nothing about Pi's
 * messaging; it produces events, and this file decides whether an event becomes a
 * follow-up message, a TUI notification, or nothing at all.
 */
import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { StringEnum, type JsonObject } from "@earendil-works/pi-ai";
import { Type, type TUnsafe } from "typebox";
import { realpathSync } from "node:fs";
import { assertLinux } from "./core/identity.ts";
import { DEFAULT_WAIT_MS, MAX_WAIT_MS, ShellRegistry } from "./core/registry.ts";
import { claimHandoff, handoffKey, publishHandoff } from "./core/reload-hub.ts";
import { acquireWorkspaceLock, releaseWorkspaceLock } from "./core/workspace-lock.ts";
import { describeShellPolicy, resolveShell } from "./core/shell-policy.ts";
import {
  completionMessage,
  describeHandle,
  formatBytes,
  formatDuration,
  outcomeExcerpt,
  sendHeadline,
  startText,
} from "./presentation.ts";
import {
  isTerminal,
  type CompletionRecord,
  type ShellAwaitResult,
  type ShellCancelResult,
  type ShellHandle,
  type ShellSendResult,
  type ShellStartResult,
  type ShellStatusResult,
} from "./core/types.ts";

const COMPLETION_TYPE = "async-shell-completion";
const STATUS_KEY = "async-shell";
const HANDOFF_TTL_MS = 30_000;
/**
 * How long `shell_start` holds its own call open for an immediate settle. A
 * command that outlives the window keeps the handle it always returned.
 */
const DEFAULT_INLINE_SETTLE_MS = 1_000;
const MAX_INLINE_SETTLE_MS = 10_000;

interface ExtensionState {
  pi: ExtensionAPI;
  ctx?: ExtensionContext;
  registry?: ShellRegistry;
  handoffKey?: string;
  busy: boolean;
  pending: CompletionRecord[];
  uiTimer?: NodeJS.Timeout;
  flushTimer?: NodeJS.Timeout;
  delivered: Set<string>;
  /**
   * Ids an open wait is holding, with a reference count. A settle for a claimed
   * id is held rather than announced, because that call is the delivery.
   */
  settleClaims: Map<string, number>;
  /** Settles that arrived under a claim, held until that call decides. */
  heldSettles: Map<string, CompletionRecord>;
  /** Suppress idle delivery while a single-shot settle boundary waits for work. */
  holdingSingleShot: boolean;
  shellPolicyText: string;
}

const state: ExtensionState = {
  // SAFETY: piAsyncShell assigns state.pi before any lifecycle event or tool can
  // read it; the placeholder only avoids making every consumer optional.
  pi: undefined as unknown as ExtensionAPI,
  busy: false,
  pending: [],
  delivered: new Set(),
  settleClaims: new Map(),
  heldSettles: new Map(),
  holdingSingleShot: false,
  shellPolicyText: "",
};

// --------------------------------------------------------------------- schemas

/**
 * `StringEnum` builds the `{ type: "string", enum: [...] }` shape that every
 * provider accepts, but the object it returns carries no TypeBox `~kind`
 * brand, so TypeBox's `Static` reads it as `unknown` and every enum parameter
 * arrives in a handler untyped. `Type.Unsafe` adds the static type as a hidden
 * property, so the JSON that reaches the model is byte-identical while the
 * handler sees the literal union.
 */
function stringEnum<T extends readonly string[]>(
  values: T,
  options?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
  return Type.Unsafe<T[number]>(StringEnum(values, options));
}

const scopeEnum = stringEnum(["session", "workspace"] as const);
const bindingEnum = stringEnum(["pipe", "pty"] as const);
const deliveryEnum = stringEnum(["steer", "settle"] as const);
const statusEnum = stringEnum([
  "starting",
  "running",
  "completed",
  "failed",
  "cancelled",
  "timed-out",
  "lost",
] as const);
const streamEnum = stringEnum(["combined", "stdout", "stderr", "ptyView"] as const);

const logSchema = Type.Object({
  dir: Type.String(),
  stdout: Type.String(),
  stderr: Type.String(),
  combined: Type.String(),
  ptyView: Type.Optional(Type.String()),
});

const bytesSchema = Type.Object({
  stdout: Type.Number(),
  stderr: Type.Number(),
  combined: Type.Number(),
  capReached: Type.Boolean(),
});

const handleSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  command: Type.String(),
  cwd: Type.String(),
  scope: scopeEnum,
  binding: bindingEnum,
  status: statusEnum,
  pid: Type.Optional(Type.Number()),
  pgid: Type.Optional(Type.Number()),
  startedAt: Type.Number(),
  readyAt: Type.Optional(Type.Number()),
  endedAt: Type.Optional(Type.Number()),
  exitCode: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  signal: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  log: logSchema,
  bytes: bytesSchema,
  error: Type.Optional(Type.String()),
  exitSource: Type.Optional(stringEnum(["pipefail", "last-command"] as const)),
  consumedByAwait: Type.Optional(Type.Boolean()),
  notifyOnCompletion: Type.Optional(Type.Boolean()),
  triggerOnCompletion: Type.Optional(Type.Boolean()),
  delivery: Type.Optional(deliveryEnum),
  timeoutSeconds: Type.Optional(Type.Number()),
});

const awaitResultSchema = Type.Object({
  settled: Type.Boolean(),
  timedOutWaiting: Type.Boolean(),
  matched: Type.Optional(
    Type.Object({ id: Type.String(), line: Type.String(), byteOffset: Type.Number() }),
  ),
  outcomes: Type.Array(handleSchema),
  stillRunning: Type.Array(handleSchema),
  note: Type.Optional(Type.String()),
});

const readResultSchema = Type.Object({
  id: Type.String(),
  status: statusEnum,
  stream: streamEnum,
  text: Type.String(),
  truncated: Type.Boolean(),
  totalLines: Type.Number(),
  totalBytes: Type.Number(),
  range: Type.Object({
    startLine: Type.Optional(Type.Number()),
    endLine: Type.Optional(Type.Number()),
    startByte: Type.Optional(Type.Number()),
    endByte: Type.Optional(Type.Number()),
    nextLine: Type.Optional(Type.Number()),
    nextByte: Type.Optional(Type.Number()),
  }),
  fullLogPath: Type.String(),
  note: Type.Optional(Type.String()),
});

const cancelResultSchema = Type.Object({
  results: Type.Array(
    Type.Object({
      id: Type.String(),
      status: statusEnum,
      verifiedGone: Type.Boolean(),
      leaked: Type.Optional(Type.Array(Type.Number())),
      note: Type.Optional(Type.String()),
    }),
  ),
});

const statusResultSchema = Type.Object({
  handles: Type.Array(handleSchema),
  running: Type.Number(),
  ready: Type.Number(),
  workspaceOwner: Type.Boolean(),
});

/** `shell_start` returns a handle, and reports a settle inline when it has one. */
const startResultSchema = Type.Object({
  ...handleSchema.properties,
  settledInline: Type.Optional(Type.Boolean()),
  note: Type.Optional(Type.String()),
});

// ------------------------------------------------------------------- utilities

/** Structured content must not carry explicit undefined values. */
function compact<T>(value: T): T {
  if (Array.isArray(value)) {
    // SAFETY: in this branch T is an array, and compacting each element keeps
    // the same array shape while removing undefined object properties.
    return value.map((item) => compact(item)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined) continue;
      out[key] = compact(entry);
    }
    // SAFETY: compact is called only with JSON-shaped tool results. In this
    // branch T is an object record, and rebuilding it preserves that shape.
    return out as T;
  }
  return value;
}

/** JSON-safe structured content: no undefined values, no class instances. */
function json(value: unknown): JsonObject {
  // SAFETY: every call site supplies a tool-result object; compact recursively
  // removes undefined values and class instances, leaving JSON-compatible data.
  return compact(value) as unknown as JsonObject;
}

/**
 * Take a claim on the ids a wait will report.
 *
 * A settle reaches `onSettle` before any waiter can observe it, so its record
 * exists before the wait returns. A claim holds that record instead of queueing
 * it, and a held record starts no coalescing window: a settle that lands while
 * the call still waits for a sibling must not leave as a completion message.
 * The count is per id, because two calls can name one handle.
 */
function claimSettles(ids: string[]): void {
  for (const id of ids) state.settleClaims.set(id, (state.settleClaims.get(id) ?? 0) + 1);
}

/**
 * Report these outcomes from this call.
 *
 * The call that describes a settle is its delivery: the held record is dropped,
 * a record that already reached the queue is withdrawn, and the id is marked
 * delivered, so the run is reported once. `shell_start` and `shell_await` both
 * report outcomes, so both consume.
 */
function consumeSettles(handles: ShellHandle[], consumed: Set<string>): void {
  for (const handle of handles) {
    state.heldSettles.delete(handle.id);
    state.delivered.add(handle.id);
    state.pending = state.pending.filter((record) => record.id !== handle.id);
    consumed.add(handle.id);
  }
}

/**
 * Drop a claim.
 *
 * A held record this call did not report — the wait was aborted, it expired, it
 * was satisfied by a sibling, or it observed readiness rather than a settle —
 * goes back to the completion channel, which still has to announce that run.
 */
function releaseSettles(ids: string[], consumed: Set<string>): void {
  for (const id of ids) {
    const count = state.settleClaims.get(id) ?? 0;
    if (count > 1) {
      state.settleClaims.set(id, count - 1);
      continue;
    }
    state.settleClaims.delete(id);
    if (!consumed.has(id)) releaseHeldSettle(id);
  }
}

/**
 * Hold a `shell_start` call open long enough for a command to finish inside it.
 *
 * The id is claimed for as long as the call waits, and a record that arrives
 * under the claim is held, not dropped: the call either reports it inline or
 * hands it back to the completion channel. A command that outlives the window
 * keeps its handle and announces its own completion exactly as before.
 */
async function holdForSettle(
  registry: ShellRegistry,
  handle: ShellHandle,
  inlineSettleMs: number,
  signal?: AbortSignal,
): Promise<ShellHandle | undefined> {
  // An aborted tool call must not consume the settle: its result may never
  // reach the model, and the completion channel still has to report the run.
  if (inlineSettleMs <= 0 || signal?.aborted) return undefined;
  const consumed = new Set<string>();
  claimSettles([handle.id]);
  try {
    const outcome = await registry.awaitHandles(
      { ids: handle.id, waitMs: inlineSettleMs, includeOutputPreview: false },
      signal,
    );
    if (signal?.aborted) return undefined;
    const settled = outcome.outcomes.find((candidate) => candidate.id === handle.id);
    if (!settled) return undefined;
    consumeSettles([settled], consumed);
    return settled;
  } finally {
    releaseSettles([handle.id], consumed);
  }
}

/**
 * A held record belongs to the call that owns the claim. Reaching here without
 * a delivery means that call returned without one — it was aborted, or the
 * settle lost the race — so the completion channel reports the run instead.
 */
function releaseHeldSettle(id: string): void {
  const held = state.heldSettles.get(id);
  if (!held) return;
  state.heldSettles.delete(id);
  enqueueCompletion(held);
}

function requireRegistry(): ShellRegistry {
  assertLinux();
  if (!state.registry) {
    throw new Error("pi-async-shell has no active session registry; start a Pi session first");
  }
  return state.registry;
}

// ------------------------------------------------------------------ completion

function enqueueCompletion(record: CompletionRecord): void {
  if (state.delivered.has(record.id)) return;
  state.pending.push(record);
  scheduleFlush();
}

/**
 * The one place a settle becomes a message. A record is skipped when the caller
 * opted out or an await already reported it; a record that settles while a
 * start call holds the claim is held for that call to deliver or hand back.
 */
function handleSettle(handle: ShellHandle, record: CompletionRecord): void {
  if (!handle.consumedByAwait && handle.notifyOnCompletion !== false) {
    // An open start call decides this record's fate, so it is held rather than
    // announced. Dropping it here would lose the run when that call is aborted.
    if (state.settleClaims.has(handle.id)) state.heldSettles.set(handle.id, record);
    else enqueueCompletion(record);
  }
  updateUi();
}

/**
 * How long a settle waits for its siblings before one message carries them all.
 * Settles that share a window travel together; a window of 0 sends each one on
 * its own.
 */
function coalesceWindowMs(): number {
  const raw = process.env.PI_ASYNC_SHELL_COALESCE_MS;
  const parsed = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 150;
}

/**
 * Coalescing is not just a turn-boundary concern. Three commands that settle
 * within a few milliseconds of each other would otherwise produce three
 * messages for one decision. A running agent waits the same short window as an
 * idle one: the record is steered at the next LLM call either way.
 */
function scheduleFlush(): void {
  if (state.flushTimer) return;
  state.flushTimer = setTimeout(() => {
    state.flushTimer = undefined;
    // Nothing awaits this timer, and a rejection here would reach the host as
    // an unhandled rejection instead of a delivered completion.
    void flushCompletions().catch(() => undefined);
  }, coalesceWindowMs());
  state.flushTimer.unref?.();
}

async function flushCompletions(): Promise<void> {
  if (state.flushTimer) {
    clearTimeout(state.flushTimer);
    state.flushTimer = undefined;
  }
  if (state.pending.length === 0 || state.holdingSingleShot) return;
  // A record that asked to settle is left for agent_before_settle, which keeps
  // the run alive for it. Everything else goes out now.
  const records = state.busy
    ? state.pending.filter((record) => record.delivery !== "settle")
    : state.pending.slice();
  if (records.length === 0) return;
  state.pending = state.pending.filter((record) => !records.includes(record));
  for (const record of records) state.delivered.add(record.id);
  const text = await completionMessage(records, state.registry);
  // triggerOnCompletion decides whether an idle session starts a turn. A
  // workspace record defaults to no notification at all, so it never wakes one.
  const shouldTrigger = records.some(
    (record) => record.scope !== "workspace" && record.triggerOnCompletion !== false,
  );
  // A running agent gets the record before its next LLM call, so a completion
  // that lands mid-run informs the next decision instead of arriving after the
  // run is over. Only the idle case can start a turn, so only it triggers one.
  try {
    state.pi.sendMessage(
      {
        customType: COMPLETION_TYPE,
        content: text,
        display: true,
        details: { ids: records.map((record) => record.id) },
      },
      { deliverAs: state.busy ? "steer" : "followUp", triggerTurn: shouldTrigger && !state.busy },
    );
  } catch {
    // A delivery failure must not lose the durable record on disk.
    for (const record of records) state.pending.push(record);
  }
  updateUi();
}

// ------------------------------------------------------------------------- UI

function updateUi(): void {
  if (state.uiTimer) return;
  state.uiTimer = setTimeout(() => {
    state.uiTimer = undefined;
    const ctx = state.ctx;
    const registry = state.registry;
    if (!ctx || !registry) return;
    try {
      const status = registry.status();
      const active = status.handles.filter(
        (handle) => handle.status === "running" || handle.status === "starting",
      );
      if (active.length === 0) {
        ctx.ui.setStatus(STATUS_KEY, undefined);
        return;
      }
      const ready = active.filter((handle) => handle.readyAt).length;
      const bits = [`${active.length} running`];
      if (ready > 0) bits.push(`${ready} ready`);
      ctx.ui.setStatus(STATUS_KEY, `async-shell: ${bits.join(", ")}`);
    } catch {
      /* status is decoration */
    }
  }, 200);
  state.uiTimer.unref?.();
}

// --------------------------------------------------------------------- registry

function createRegistry(ctx: ExtensionContext): ShellRegistry {
  const cwd = realpathSync(ctx.cwd);
  const sessionId = ctx.sessionManager.getSessionId();
  const registry = new ShellRegistry({
    cwd,
    sessionId,
    env: process.env,
    onSettle: handleSettle,
    onReady: () => updateUi(),
    onChange: () => updateUi(),
    onDiagnostic: (message) => {
      try {
        state.ctx?.ui.notify(`async-shell: ${message}`, "warning");
      } catch {
        /* ignore */
      }
    },
  });
  const lock = acquireWorkspaceLock(registry.paths, sessionId);
  registry.setWorkspaceOwner(lock.owned, lock.holder?.pid);
  return registry;
}

/**
 * Work that must finish or become ready before a single-shot session settles.
 * A ready execution is a companion service: readiness, not its eventual exit,
 * is the milestone the agent needed. Notification and triggering must both be
 * enabled; otherwise no completion wake-up can occur.
 */
function wakingSessionHandles(registry: ShellRegistry): ShellHandle[] {
  return registry.handles.filter(
    (handle) =>
      handle.scope === "session" &&
      !isTerminal(handle.status) &&
      handle.readyAt === undefined &&
      handle.notifyOnCompletion !== false &&
      handle.triggerOnCompletion !== false,
  );
}

/**
 * The host's mode, or undefined once it invalidated this context.
 *
 * A host that disposes the session while the boundary waits still emits the
 * boundary that follows the continuation, and every getter on that context
 * throws. An unreadable mode is no reason to hold anything.
 */
function hostMode(ctx: ExtensionContext): ExtensionContext["mode"] | undefined {
  try {
    return ctx.mode;
  } catch {
    return undefined;
  }
}

/**
 * Print and JSON hosts dispose the session as soon as the prompt settles. Hold
 * that boundary for pending wake-ups so shutdown cannot reap the work before
 * its completion continues the run. Readiness also satisfies the wait, which
 * keeps companion services from holding a single-shot host open forever.
 *
 * This is observation, not tool-facing delivery: the completion channel remains
 * responsible for reporting every settle, so the internal wait consumes none.
 *
 * The host runs this boundary between runs, so `ctx.signal` is undefined here
 * and there is no abort to observe: a wait that is still in flight ends when the
 * work it watches settles or becomes ready, or when this activation stops owning
 * the registry (`session_shutdown`, a replacement session). Read the context
 * before the first await, because a host that disposes the session mid-hold
 * invalidates it and every later read throws.
 */
async function holdSingleShotForSessionWork(ctx: ExtensionContext): Promise<void> {
  const mode = hostMode(ctx);
  if (mode !== "print" && mode !== "json") return;
  const registry = state.registry;
  if (!registry) return;
  const signal = ctx.signal;
  state.holdingSingleShot = true;
  try {
    while (!signal?.aborted && state.registry === registry) {
      const handles = wakingSessionHandles(registry);
      if (handles.length === 0) return;
      await registry.awaitHandles(
        {
          ids: handles.map((handle) => handle.id),
          mode: "all",
          until: { kind: "ready" },
          waitMs: MAX_WAIT_MS,
          includeOutputPreview: false,
        },
        signal,
        { consumeSettles: false },
      );
    }
  } finally {
    state.holdingSingleShot = false;
  }
}

function surfaceWorkspaceCompletions(registry: ShellRegistry): void {
  const records = registry.workspaceCompletions();
  if (records.length === 0) return;
  const text = [
    "<async-shell-workspace>",
    `${records.length} workspace execution(s) settled while no Pi process was watching:`,
    ...records.map(
      (record) =>
        `${record.id} "${record.name}" ${record.status} after ${formatDuration(record.durationMs)} · log: ${record.log.combined}`,
    ),
    "Use shell_read to inspect the output.",
    "</async-shell-workspace>",
  ].join("\n");
  try {
    state.pi.sendMessage(
      { customType: "async-shell-workspace", content: text, display: true, details: {} },
      { deliverAs: "nextTurn" },
    );
  } catch {
    /* the records stay on disk */
  }
}

// ------------------------------------------------------------------------ tools

const promptSnippet =
  "Start, await, read, promote, send to, cancel, or inspect asynchronous shell executions";

const toolPromptGuidelines = {
  shell_start: [
    "Use shell_start for slow commands, parallel commands, durable logs, or work that outlives the turn. Keep bash for commands that finish within two seconds and need no log.",
    "Use shell_read instead of tail, head, grep, or wc output pipes. Output pipes can truncate the durable log or replace the exit status.",
    "Pass cwd instead of prefixing the command with cd.",
    "When a later action needs an external state change, start one command that exits on that change. Set timeoutSeconds on that command. When no later action needs the new state, report the verified result and stop.",
  ],
  shell_await: [
    "Finish independent work before waiting. Use at most one long wait in each codemode script. Reserve time within the 60-second script budget. When a full-length wait expires, end the turn and let completion delivery resume the work.",
    "Wait only for an outcome that a later action uses. Otherwise, report the verified result and stop.",
  ],
  shell_read: [
    "Use grep to locate output. Use offset to page through results. Read only the slices needed for the next action.",
    "When inspecting an interactive terminal, use ptyView after sending input.",
  ],
  shell_cancel: [
    "Use shell_cancel only to stop work. Cancellation leaves filesystem and external side effects in place.",
  ],
  shell_status: [
    "Use shell_status once for each deliberate inspection. Use shell_await instead of status polling. When completion delivery is pending, end the turn.",
  ],
};

export default function piAsyncShell(pi: ExtensionAPI): void {
  assertLinux();
  state.pi = pi;
  const shellPolicy = resolveShell(process.env);
  state.shellPolicyText = describeShellPolicy(shellPolicy);

  // ---------------------------------------------------------------- lifecycle

  pi.on("session_start", async (event, ctx) => {
    assertLinux();
    if (event.reason !== "reload") {
      // Extension modules can be reused by another session in the same process.
      // Delivery state belongs to one activation; a reload is the exception
      // because its pending records and delivered ids must survive the handoff.
      if (state.flushTimer) clearTimeout(state.flushTimer);
      if (state.uiTimer) clearTimeout(state.uiTimer);
      state.flushTimer = undefined;
      state.uiTimer = undefined;
      state.busy = false;
      state.holdingSingleShot = false;
      state.pending = [];
      state.delivered.clear();
    }
    // No tool call survives an activation, so no claim can either. A record
    // that settles after this point must be able to announce itself.
    state.settleClaims.clear();
    state.heldSettles.clear();
    state.ctx = ctx;
    const cwd = realpathSync(ctx.cwd);
    const sessionId = ctx.sessionManager.getSessionId();
    const key = handoffKey(process.pid, sessionId, cwd);
    state.handoffKey = key;

    if (event.reason === "reload") {
      const claimed = claimHandoff<ShellRegistry>(key);
      if (claimed) {
        state.registry = claimed;
        claimed.rebind({
          onSettle: handleSettle,
          onReady: () => updateUi(),
          onChange: () => updateUi(),
        });
        updateUi();
        return;
      }
    }

    const registry = createRegistry(ctx);
    state.registry = registry;
    const adopted = await registry.adoptWorkspace();
    if (adopted.adopted.length > 0) {
      ctx.ui.notify(
        `async-shell: re-adopted ${adopted.adopted.length} workspace execution(s)`,
        "info",
      );
    }
    if (adopted.lost.length > 0) {
      ctx.ui.notify(
        `async-shell: ${adopted.lost.length} workspace execution(s) are lost (liveness unprovable)`,
        "warning",
      );
    }
    surfaceWorkspaceCompletions(registry);
    updateUi();
  });

  pi.on("session_shutdown", async (event) => {
    const registry = state.registry;
    if (!registry) return;
    if (event.reason === "reload" && state.handoffKey) {
      publishHandoff(state.handoffKey, registry, HANDOFF_TTL_MS, () => {
        void registry.abandonHandoff();
      });
      return;
    }
    await registry.shutdown(event.reason);
    releaseWorkspaceLock(registry.paths);
    state.registry = undefined;
    if (state.flushTimer) clearTimeout(state.flushTimer);
    if (state.uiTimer) clearTimeout(state.uiTimer);
    state.flushTimer = undefined;
    state.uiTimer = undefined;
    state.busy = false;
    state.holdingSingleShot = false;
    state.pending = [];
    state.delivered.clear();
    state.settleClaims.clear();
    state.heldSettles.clear();
    state.ctx?.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.on("agent_start", async () => {
    state.busy = true;
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    state.busy = false;
    await holdSingleShotForSessionWork(ctx);
    const entries: SessionBoundaryDraft[] = [];
    let continueTurn = false;

    if (state.pending.length > 0) {
      const records = state.pending.splice(0, state.pending.length);
      for (const record of records) state.delivered.add(record.id);
      entries.push({
        type: "custom_message",
        customType: COMPLETION_TYPE,
        content: await completionMessage(records, state.registry),
        display: true,
      });
      continueTurn = true;
    }

    if (entries.length === 0) return undefined;
    return { entries: [...event.entries, ...entries], continue: continueTurn };
  });

  pi.on("agent_settled", async () => {
    state.busy = false;
    if (state.pending.length > 0) scheduleFlush();
    updateUi();
  });

  // ------------------------------------------------------------------- tools

  pi.registerTool({
    name: "shell_start",
    label: "Start async shell",
    description: `Start a session or workspace command with pipe or pty I/O. When the command outlives inlineSettleMs, return its handle. When the command settles within inlineSettleMs, return its outcome and output tail. ${state.shellPolicyText}`,
    promptSnippet,
    promptGuidelines: toolPromptGuidelines.shell_start,
    parameters: Type.Object({
      command: Type.String({
        description:
          "Shell command to run. Bash-like shells apply pipefail to pipelines. The POSIX fallback records last-command in exitSource.",
      }),
      name: Type.Optional(Type.String({ description: "Label for the dock and handle list. Use 2-6 words." })),
      cwd: Type.Optional(
        Type.String({ description: "Working directory. The default is the Pi session's cwd." }),
      ),
      env: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description:
            "Extra environment values. Explicit values override the default credential filter.",
        }),
      ),
      scope: Type.Optional(
        stringEnum(["session", "workspace"] as const, {
          description:
            "Scope selects ownership and lifetime. Session scope, the default, ties cleanup to the Pi session. Workspace scope survives Pi restarts. In print/JSON mode, both notifyOnCompletion and triggerOnCompletion must be true for live unready session work to hold settlement. Readiness releases this hold.",
        }),
      ),
      binding: Type.Optional(
        stringEnum(["pipe", "pty"] as const, {
          description:
            "Select I/O topology. The pipe default captures stdout and stderr separately. Use pty for terminal interaction through shell_send and ptyView.",
        }),
      ),
      timeoutSeconds: Type.Optional(
        Type.Number({
          minimum: 0,
          description:
            "Cancel through the graceful ladder after this many seconds. Report the outcome as timed-out rather than failed.",
        }),
      ),
      notifyOnCompletion: Type.Optional(
        Type.Boolean({
          description:
            "When the execution settles, deliver a completion message. The default is true for session scope and false for workspace scope.",
        }),
      ),
      triggerOnCompletion: Type.Optional(
        Type.Boolean({
          description:
            "Allow completion messages to resume an idle turn. The default is true. A false value reports completions without waking the agent.",
        }),
      ),
      delivery: Type.Optional(
        stringEnum(["steer", "settle"] as const, {
          description:
            "Select completion timing for a running agent. The steer default delivers before the next LLM call. The settle value holds completion until the run settles.",
        }),
      ),
      request: Type.Optional(
        Type.String({
          description:
            "Replay key for this call. When the key repeats, return the first handle without running another command. Use letters, digits, dot, dash, or underscore.",
        }),
      ),
      inlineSettleMs: Type.Optional(
        Type.Number({
          minimum: 0,
          description: `Hold this call open for a settle up to this duration. The default is ${DEFAULT_INLINE_SETTLE_MS}. Zero returns the handle immediately. The tool clamps values above ${MAX_INLINE_SETTLE_MS} to ${MAX_INLINE_SETTLE_MS} and adds a note.`,
        }),
      ),
    }),
    outputSchema: startResultSchema,
    async execute(_toolCallId, params, signal) {
      const registry = requireRegistry();
      const requestedInlineSettleMs = params.inlineSettleMs ?? DEFAULT_INLINE_SETTLE_MS;
      const inlineSettleMs = Math.max(0, Math.min(MAX_INLINE_SETTLE_MS, requestedInlineSettleMs));
      const inlineNote =
        requestedInlineSettleMs > MAX_INLINE_SETTLE_MS
          ? `inlineSettleMs ${requestedInlineSettleMs} clamped to ${MAX_INLINE_SETTLE_MS}; the command keeps its handle if it outlives that window.`
          : undefined;
      const handle = await registry.start(params);
      const settled = await holdForSettle(registry, handle, inlineSettleMs, signal);
      const reported = settled ?? handle;
      let preview: string | undefined;
      if (settled) {
        try {
          const tail = await registry.read({ id: settled.id, mode: "tail", lines: 20 });
          preview = tail.text;
        } catch {
          /* the preview is a convenience, not the contract */
        }
      }
      // The note travels in structured content too: a caller that reads only
      // structuredContent would otherwise miss the clamp it has to know about.
      const structured: ShellStartResult = {
        ...reported,
        ...(settled ? { settledInline: true } : {}),
        note: inlineNote,
      };
      return {
        content: [
          {
            type: "text" as const,
            text: startText(reported, settled ? inlineSettleMs : undefined, preview, inlineNote),
          },
        ],
        structuredContent: json(structured),
        details: { id: reported.id, settled: Boolean(settled) },
      };
    },
  });

  pi.registerTool({
    name: "shell_await",
    label: "Await async shell",
    description:
      "Wait for exit, $PI_ASYNC_SHELL_EXEC_DIR/ready, or an output regex. A timeout ends only the wait. The execution continues.",
    promptGuidelines: toolPromptGuidelines.shell_await,
    parameters: Type.Object({
      ids: Type.Union([Type.String(), Type.Array(Type.String())], {
        description: "One handle id, or a list of them.",
      }),
      mode: Type.Optional(
        stringEnum(["all", "any"] as const, {
          description: "The all value waits for every id. The any value returns after the first id satisfies until.",
        }),
      ),
      until: Type.Optional(
        Type.Union(
          [
            Type.Object({ kind: Type.Literal("exit") }),
            Type.Object({ kind: Type.Literal("ready") }),
            Type.Object({
              kind: Type.Literal("pattern"),
              regex: Type.String({
                description:
                  "JavaScript regular expression. The matcher limits length and nested quantifiers because it runs on the main thread.",
              }),
              stream: Type.Optional(
                stringEnum(["combined", "stdout", "stderr", "ptyView"] as const, {
                  description:
                    "Select the output stream to match. The combined default includes both pipe streams. A pty records one stream, so every value reads its recording.",
                }),
              ),
              since: Type.Optional(
                Type.Union([Type.Number(), Type.Literal("now")], {
                  description:
                    "Select the first byte to match. The default is zero. The now value starts at the current end of the stream.",
                }),
              ),
            }),
          ],
          {
            description:
              "Select the condition that ends the wait. The exit default waits for settlement. The ready value waits for the $PI_ASYNC_SHELL_EXEC_DIR/ready marker without ending the execution. The pattern value waits for a matching output line. A pty records one stream. Reads and waits map stderr to combined.",
          },
        ),
      ),
      waitMs: Type.Optional(
        Type.Number({
          minimum: 0,
          description: `The default is ${DEFAULT_WAIT_MS}. The tool clamps values above ${MAX_WAIT_MS} to ${MAX_WAIT_MS} and adds a note.`,
        }),
      ),
      includeOutputPreview: Type.Optional(
        Type.Boolean({ description: "Include the last 20 lines of each settled handle. Default true." }),
      ),
    }),
    outputSchema: awaitResultSchema,
    async execute(_toolCallId, params, signal) {
      const registry = requireRegistry();
      const requestedWaitMs = params.waitMs ?? DEFAULT_WAIT_MS;
      const waitMs = Math.max(0, Math.min(MAX_WAIT_MS, requestedWaitMs));
      const ids = Array.isArray(params.ids) ? params.ids : [params.ids];
      const consumed = new Set<string>();
      // The claim exists before the wait starts. A settle that lands mid-wait is
      // held for this call, which is the only call that can report it once.
      claimSettles(ids);
      let result: ShellAwaitResult;
      try {
        result = await registry.awaitHandles({ ...params, waitMs }, signal);
        // An aborted call may never reach the model, so its outcome is not a
        // delivery: the completion channel still has to report the run.
        if (!signal?.aborted) consumeSettles(result.outcomes, consumed);
      } finally {
        releaseSettles(ids, consumed);
      }
      // Both notes belong to structured content as well. A codemode caller
      // reads structuredContent, and a clamp or an end-the-turn instruction
      // that only exists in the prose never reaches it.
      const clampNote =
        requestedWaitMs > MAX_WAIT_MS
          ? `waitMs ${requestedWaitMs} clamped to ${MAX_WAIT_MS}; a completion message still wakes you when the command settles.`
          : undefined;
      const timeoutNote = result.timedOutWaiting
        ? waitMs >= MAX_WAIT_MS
          ? "The full-length wait expired. Nothing was killed. End the turn; a completion message will wake you when the command settles. Do not issue another blocking await for the same work."
          : "The wait expired. Nothing was killed. End the turn if the remaining work is long, or await again."
        : undefined;
      // The registry's own note says why a stream was remapped, and belongs with
      // the guidance this call already carries.
      const note = [result.note, clampNote, timeoutNote].filter(Boolean).join(" ") || undefined;
      const lines: string[] = [];
      if (clampNote) lines.push(clampNote);
      if (result.matched) {
        lines.push(`Pattern matched in ${result.matched.id}: ${result.matched.line}`);
      }
      for (const handle of result.outcomes) {
        lines.push(describeHandle(handle));
        if (params.includeOutputPreview !== false) {
          try {
            const preview = await registry.read({ id: handle.id, mode: "tail", lines: 20 });
            lines.push(
              ...outcomeExcerpt(
                preview.text,
                handle.status === "failed" || handle.status === "timed-out",
              ),
            );
          } catch {
            /* preview is optional */
          }
        }
      }
      for (const handle of result.stillRunning) {
        lines.push(`still running: ${describeHandle(handle)}`);
      }
      if (timeoutNote) lines.push(timeoutNote);
      return {
        content: [{ type: "text" as const, text: lines.join("\n") || "nothing to await" }],
        structuredContent: json(note ? { ...result, note } : result),
        details: { settled: result.settled },
      };
    },
  });

  pi.registerTool({
    name: "shell_read",
    label: "Read async shell log",
    description:
      "Read a bounded slice of an execution's durable output or a PTY's rendered screen. Each call returns at most 2000 lines or 50 KiB.",
    promptGuidelines: toolPromptGuidelines.shell_read,
    parameters: Type.Object({
      id: Type.String({ description: "Handle id." }),
      stream: Type.Optional(
        stringEnum(["combined", "stdout", "stderr", "ptyView"] as const, {
          description:
            "The combined default reads the byte stream. The stdout and stderr values select pipe streams. The ptyView value reads the rendered terminal viewport rather than scrollback.",
        }),
      ),
      mode: Type.Optional(
        stringEnum(["tail", "head", "offset", "grep", "all"] as const, {
          description:
            "tail is the default. offset pages from lineOffset or byteOffset, grep filters by pattern, and all is a bounded head read: on a byte stream its note names the next page, and on ptyView it returns the viewport, which has no page to continue.",
        }),
      ),
      lines: Type.Optional(
        Type.Number({ minimum: 1, maximum: 2000, description: "Lines to return. Default 200, capped at 2000." }),
      ),
      maxBytes: Type.Optional(
        Type.Number({ minimum: 64, maximum: 51200, description: "Byte budget for the result. Default 16 KiB, capped at 50 KiB." }),
      ),
      lineOffset: Type.Optional(
        Type.Number({ minimum: 1, description: "With mode offset: the 1-based line to start from." }),
      ),
      byteOffset: Type.Optional(
        Type.Number({ minimum: 0, description: "With mode offset: the byte to start from. Wins over lineOffset." }),
      ),
      pattern: Type.Optional(
        Type.String({
          description:
            "When mode is grep, provide a JavaScript regular expression. The matcher limits length and nested quantifiers because it runs on the main thread.",
        }),
      ),
      context: Type.Optional(
        Type.Number({ minimum: 0, maximum: 20, description: "With mode grep: lines of context around each match. Default 2." }),
      ),
      stripAnsi: Type.Optional(
        Type.Boolean({ description: "Strip escape sequences from returned text. The default is true." }),
      ),
    }),
    outputSchema: readResultSchema,
    async execute(_toolCallId, params, signal) {
      const registry = requireRegistry();
      const result = await registry.read(params, signal);
      const header = `${result.id} ${result.stream} · ${result.status} · ${result.totalLines} lines / ${formatBytes(result.totalBytes)}${
        result.truncated ? " · truncated" : ""
      }`;
      const footer = `full log: ${result.fullLogPath}${result.note ? `\nnote: ${result.note}` : ""}`;
      return {
        content: [
          {
            type: "text" as const,
            text: [header, result.text || "(no output)", footer].join("\n"),
          },
        ],
        structuredContent: json(result),
        details: { id: result.id, truncated: result.truncated },
      };
    },
  });

  pi.registerTool({
    name: "shell_promote",
    label: "Promote async shell",
    description:
      "Move a live session execution to workspace scope without restarting it. Promotion is one-directional and audited.",
    parameters: Type.Object({
      id: Type.String({ description: "Handle id of a live execution." }),
      to: Type.Optional(
        stringEnum(["workspace"] as const, {
          description:
            "Omit this value. Promotion only widens ownership to workspace. Session executions already have the narrower scope. Workspace executions reject narrowing.",
        }),
      ),
      adopterNotification: Type.Optional(
        Type.Boolean({ description: "Set notifyOnCompletion on the promoted handle." }),
      ),
    }),
    outputSchema: handleSchema,
    async execute(_toolCallId, params) {
      const registry = requireRegistry();
      const handle = await registry.promote(params);
      return {
        content: [{ type: "text" as const, text: `Promoted ${describeHandle(handle)}` }],
        structuredContent: json(handle),
        details: { id: handle.id },
      };
    },
  });

  pi.registerTool({
    name: "shell_send",
    label: "Send to async shell",
    description:
      "Write stdin text or key chords to a pty execution. Pipe executions reject stdin because they have no terminal. A later Pi process can write through the execution's stdin FIFO.",
    parameters: Type.Object({
      id: Type.String({ description: "Handle id of a pty execution." }),
      text: Type.Optional(Type.String({ description: "Literal input, written as given." })),
      keys: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Key chords: Enter, Tab, Escape, Backspace, Delete, Insert, arrows, Home, End, PageUp, PageDown, F1-F12, and Ctrl+<letter> in any case or separator. An unknown name is an error, not literal text.",
        }),
      ),
      settleMs: Type.Optional(
        Type.Number({
          minimum: 0,
          maximum: 10000,
          description: "Wait this long before reading the screen back. Default 500, capped at 10000.",
        }),
      ),
      request: Type.Optional(
        Type.String({
          description:
            "Replay key for this call. A second shell_send with the same key writes nothing. Independent of shell_start request keys.",
        }),
      ),
    }),
    outputSchema: Type.Object({
      id: Type.String(),
      wrote: Type.Boolean(),
      screen: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      const registry = requireRegistry();
      const result: ShellSendResult = await registry.send(params);
      return {
        content: [
          {
            type: "text" as const,
            text: [sendHeadline(result), result.screen ?? ""].filter(Boolean).join("\n"),
          },
        ],
        structuredContent: json(result),
        details: { id: result.id },
      };
    },
  });

  pi.registerTool({
    name: "shell_cancel",
    label: "Cancel async shell",
    description:
      "Cancel one or more executions through the graceful or forced ladder. The tool verifies that no tracked process remains.",
    promptGuidelines: toolPromptGuidelines.shell_cancel,
    parameters: Type.Object({
      ids: Type.Union([Type.String(), Type.Array(Type.String())], {
        description: "One handle id, or a list of them.",
      }),
      ladder: Type.Optional(
        stringEnum(["graceful", "force"] as const, {
          description:
            "The graceful default sends the user's interrupt or SIGTERM to the group. It waits graceMs before escalating. The force value starts at SIGKILL.",
        }),
      ),
      graceMs: Type.Optional(
        Type.Number({
          minimum: 0,
          description: "How long graceful waits before it escalates. Default 3000, capped at 30000.",
        }),
      ),
    }),
    outputSchema: cancelResultSchema,
    async execute(_toolCallId, params) {
      const registry = requireRegistry();
      const results: ShellCancelResult[] = await registry.cancel(params);
      const text = results
        .map(
          (result) =>
            `${result.id}: ${result.status}${result.verifiedGone ? " · no tracked process survived" : ` · leak: ${(result.leaked ?? []).join(", ")}`}${result.note ? ` · ${result.note}` : ""}`,
        )
        .join("\n");
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: json({ results }),
        details: { ids: results.map((result) => result.id) },
      };
    },
  });

  pi.registerTool({
    name: "shell_status",
    label: "Async shell status",
    description: "Inspect one handle or all handles at a point in time.",
    promptGuidelines: toolPromptGuidelines.shell_status,
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "One handle id. Omit to list every handle and workspace record." })),
    }),
    outputSchema: statusResultSchema,
    async execute(_toolCallId, params) {
      const registry = requireRegistry();
      const result: ShellStatusResult = registry.status(params);
      const lines = result.handles.map((handle) => describeHandle(handle));
      const header = `${result.running} running · ${result.ready} ready · workspace ${
        result.workspaceOwner ? "owned by this process" : "read-only"
      }`;
      return {
        content: [{ type: "text" as const, text: [header, ...lines].join("\n") }],
        structuredContent: json(result),
        details: { running: result.running },
      };
    },
  });

  // ----------------------------------------------------------------- commands

  pi.registerCommand("async-shell", {
    description: "List async shell executions, or run / cancel / read one",
    handler: async (args, ctx) => {
      const registry = state.registry;
      if (!registry) {
        ctx.ui.notify("async-shell: no active session registry", "warning");
        return;
      }
      const trimmed = args.trim();
      if (trimmed.startsWith("run ")) {
        const command = trimmed.slice(4);
        const handle = await registry.start({
          command,
          scope: "session",
          notifyOnCompletion: true,
          triggerOnCompletion: false,
        });
        ctx.ui.notify(`async-shell: started ${handle.id} (${handle.binding})`, "info");
        return;
      }
      if (trimmed.startsWith("cancel ")) {
        const id = trimmed.slice(7).trim();
        const results = await registry.cancel({ ids: id, ladder: "graceful" });
        ctx.ui.notify(`async-shell: ${results.map((result) => `${result.id} ${result.status}`).join(", ")}`, "info");
        return;
      }
      if (trimmed.startsWith("read ")) {
        const id = trimmed.slice(5).trim();
        const result = await registry.read({ id, mode: "tail", lines: 40 });
        ctx.ui.notify(result.text || "(no output)", "info");
        return;
      }
      const status = registry.status();
      if (status.handles.length === 0) {
        ctx.ui.notify("async-shell: no executions in this session", "info");
        return;
      }
      const lines = status.handles.map((handle) => describeHandle(handle));
      if (!ctx.hasUI) {
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }
      const choice = await ctx.ui.select(
        `async-shell (${status.running} running)`,
        status.handles.map((handle) => `${handle.id} · ${handle.name} · ${handle.status}`),
      );
      if (!choice) return;
      const id = choice.split(" ")[0] as string;
      const action = await ctx.ui.select(`${id}`, ["read tail", "cancel"]);
      if (action === "read tail") {
        const result = await registry.read({ id, mode: "tail", lines: 40 });
        ctx.ui.notify(result.text || "(no output)", "info");
      } else if (action === "cancel") {
        const results = await registry.cancel({ ids: id, ladder: "graceful" });
        ctx.ui.notify(`async-shell: ${results[0]?.status ?? "unknown"}`, "info");
      }
    },
  });

}
