// SPDX-FileCopyrightText: 2026 Zhuocheng-Lang
// SPDX-License-Identifier: MPL-2.0

/**
 * pi-async-shell — supervised asynchronous shell executions for Pi.
 *
 * The extension layer is deliberately thin. The registry knows nothing about Pi's
 * messaging; it produces events, and this file decides whether an event becomes a
 * follow-up message, a TUI notification, or nothing at all.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum, type JsonObject } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { realpathSync } from "node:fs";
import { assertLinux } from "./core/identity.ts";
import { DEFAULT_WAIT_MS, MAX_WAIT_MS, ShellRegistry } from "./core/registry.ts";
import { claimHandoff, handoffKey, publishHandoff } from "./core/reload-hub.ts";
import { acquireWorkspaceLock, releaseWorkspaceLock } from "./core/workspace-lock.ts";
import { describeShellPolicy, resolveShell } from "./core/shell-policy.ts";
import type {
  CompletionRecord,
  ShellAwaitResult,
  ShellCancelResult,
  ShellHandle,
  ShellSendResult,
  ShellStatusResult,
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
  shellPolicyText: string;
}

const state: ExtensionState = {
  pi: undefined as unknown as ExtensionAPI,
  busy: false,
  pending: [],
  delivered: new Set(),
  settleClaims: new Map(),
  heldSettles: new Map(),
  shellPolicyText: "",
};

// --------------------------------------------------------------------- schemas

const scopeEnum = StringEnum(["session", "workspace"] as const);
const bindingEnum = StringEnum(["pipe", "pty"] as const);
const deliveryEnum = StringEnum(["steer", "settle"] as const);
const statusEnum = StringEnum([
  "starting",
  "running",
  "completed",
  "failed",
  "cancelled",
  "timed-out",
  "lost",
] as const);
const streamEnum = StringEnum(["combined", "stdout", "stderr", "ptyView"] as const);

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
  exitSource: Type.Optional(StringEnum(["pipefail", "last-command"] as const)),
  consumedByAwait: Type.Optional(Type.Boolean()),
  notifyOnCompletion: Type.Optional(Type.Boolean()),
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
});

// ------------------------------------------------------------------- utilities

/** Structured content must not carry explicit undefined values. */
function compact<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => compact(item)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined) continue;
      out[key] = compact(entry);
    }
    return out as T;
  }
  return value;
}

/** JSON-safe structured content: no undefined values, no class instances. */
function json(value: unknown): JsonObject {
  return compact(value) as unknown as JsonObject;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

function describeHandle(handle: ShellHandle): string {
  const parts = [handle.id, `"${handle.name}"`, handle.status];
  if (handle.exitCode !== undefined && handle.exitCode !== null) parts.push(`exit ${handle.exitCode}`);
  if (handle.signal) parts.push(`signal ${handle.signal}`);
  if (handle.endedAt) parts.push(formatDuration(handle.endedAt - handle.startedAt));
  else parts.push(`${formatDuration(Date.now() - handle.startedAt)} so far`);
  parts.push(`scope ${handle.scope}`, `binding ${handle.binding}`);
  if (handle.readyAt) parts.push("ready");
  parts.push(`${formatBytes(handle.bytes.combined)} logged`);
  if (handle.bytes.capReached) parts.push("log cap reached");
  if (handle.error) parts.push(`error: ${handle.error}`);
  if (handle.exitSource === "pipefail") parts.push("pipeline status: pipefail");
  else if (handle.exitSource === "last-command") parts.push("pipeline status: last stage only");
  return parts.join(" · ");
}

/** A bounded, human-readable excerpt of the log for an outcome message. */
function outcomeExcerpt(text: string | undefined, failed: boolean): string[] {
  const lines = (text ?? "")
    .split("\n")
    .map((line) => line.replace(/\s+$/, "").slice(0, 500))
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];
  const tail = lines.slice(-10);
  const tailBlock = ["  --- tail ---", ...tail.map((line) => `  ${line}`)];
  if (!failed) return tailBlock;
  const errorIndex = lines.findIndex((line) => /error|fail|fatal|exception|panic|Traceback/i.test(line));
  if (errorIndex < 0) return tailBlock;
  const from = Math.max(0, errorIndex - 2);
  const to = Math.min(lines.length, errorIndex + 8);
  const block = ["  --- first error ---", ...lines.slice(from, to).map((line) => `  ${line}`)];
  const tailFrom = Math.max(to, lines.length - 6);
  if (tailFrom < lines.length) {
    block.push("  --- tail ---", ...lines.slice(tailFrom).map((line) => `  ${line}`));
  }
  return block;
}

/** Completion and await messages carry the outcome, not just a log path. */
async function readOutcomeExcerpt(
  registry: ShellRegistry | undefined,
  id: string,
  status: ShellHandle["status"],
  lines = 20,
): Promise<string[]> {
  if (!registry) return [];
  try {
    const read = await registry.read({ id, mode: "tail", lines, stream: "combined" });
    return outcomeExcerpt(read.text, status === "failed" || status === "timed-out");
  } catch {
    return [];
  }
}

/**
 * `wrote: false` means the bytes did not reach the child: either the stdin FIFO
 * has no reader yet, or this request id already sent once.
 */
function sendHeadline(result: ShellSendResult): string {
  if (result.wrote) return `Sent to ${result.id}`;
  return `Nothing written to ${result.id} (no reader on its stdin, or this request was already sent)`;
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

/** A start result is a handle; a settled one also carries its output. */
function startText(
  handle: ShellHandle,
  inlineSettleMs: number | undefined,
  preview: string | undefined,
  note?: string,
): string {
  const lines = [`Started ${describeHandle(handle)}`];
  if (note) lines.push(`  note: ${note}`);
  if (inlineSettleMs !== undefined) {
    lines.push(
      `Settled inside the ${formatDuration(inlineSettleMs)} inline window, so the result is here and no shell_await is needed.`,
    );
    lines.push(...outcomeExcerpt(preview, handle.status === "failed" || handle.status === "timed-out"));
  }
  lines.push(`log: ${handle.log.combined}`);
  return lines.join("\n");
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

async function completionMessage(records: CompletionRecord[]): Promise<string> {
  const lines = ["<async-shell-completion>"];
  for (const record of records) {
    const outcome =
      record.status === "completed"
        ? "completed"
        : record.status === "cancelled"
          ? "cancelled"
          : record.status === "timed-out"
            ? "timed out"
            : record.status === "lost"
              ? "lost (liveness could not be proven)"
              : `failed${record.exitCode !== null && record.exitCode !== undefined ? ` (exit ${record.exitCode})` : ""}`;
    lines.push(
      `${record.id} "${record.name}" ${outcome} after ${formatDuration(record.durationMs)} · scope ${record.scope} · binding ${record.binding}`,
    );
    if (record.error) lines.push(`  error: ${record.error}`);
    if (record.exitSource === "pipefail") lines.push("  pipeline status: pipefail (any stage failure fails the command)");
    else if (record.exitSource === "last-command") lines.push("  pipeline status: last stage only (shell has no pipefail)");
    lines.push(`  exit: ${record.exitCode ?? "unknown"}`);
    if (record.signal) lines.push(`  signal: ${record.signal}`);
    lines.push(...(await readOutcomeExcerpt(state.registry, record.id, record.status)));
    lines.push(`  log: ${record.log.combined} (${formatBytes(record.bytes.combined)})`);
  }
  lines.push("Read output with shell_read; do not re-run a command that already completed.");
  lines.push("</async-shell-completion>");
  return lines.join("\n");
}

async function flushCompletions(): Promise<void> {
  if (state.flushTimer) {
    clearTimeout(state.flushTimer);
    state.flushTimer = undefined;
  }
  if (state.pending.length === 0) return;
  // A record that asked to settle is left for agent_before_settle, which keeps
  // the run alive for it. Everything else goes out now.
  const records = state.busy
    ? state.pending.filter((record) => record.delivery !== "settle")
    : state.pending.slice();
  if (records.length === 0) return;
  state.pending = state.pending.filter((record) => !records.includes(record));
  for (const record of records) state.delivered.add(record.id);
  const text = await completionMessage(records);
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

const basePromptGuidelines = [
  "Use shell_start for commands that are slow, that should run in parallel, that must outlive the turn, or whose full log matters; keep bash for commands that finish in a second or two and need no log.",
  "shell_start returns a handle immediately, except that a command settling within inlineSettleMs (default 1000) returns its status and output tail in that same call; then there is nothing to await. Do independent work first, then call shell_await; do not sleep or poll shell_status in a loop.",
  "shell_await uses waitMs up to 50000 (default 30000); larger values are clamped and noted, not rejected. Use one long wait per script, leave room in codemode's 60-second budget, then end the turn and let completion delivery wake you.",
  "Do not pipe command output to tail, head, grep, or wc: it caps the durable log before shell_read can search it, and on a shell without pipefail it also replaces the source exit code. Run the command whole and use shell_read with mode tail, grep, or offset.",
  "Use shell_start.cwd instead of prefixing the command with cd, so the record and the process agree on the working directory.",
  "Pipelines in a bash-like shell run with pipefail; any stage failure fails the command. A POSIX fallback reports only the last stage, and the handle names the exitSource.",
  "shell_read returns a bounded slice. Use mode grep or offset to find what matters; mode all is a bounded head read with paging guidance in its note.",
  "shell_send requires binding pty; a pipe execution has no terminal and refuses stdin.",
  "shell_read with stream ptyView returns the rendered screen of a pty execution; use it after shell_send to see what a terminal UI is showing.",
  "shell_cancel verifies that the process tree is gone; cancellation stops processes but does not roll back their effects.",
  "A completion reaches a running agent as a steer message before the next LLM call; shell_start delivery: \"settle\" holds it until the run settles. Do not end the turn only to learn that a command finished.",
];

export default function piAsyncShell(pi: ExtensionAPI): void {
  assertLinux();
  state.pi = pi;
  const shellPolicy = resolveShell(process.env);
  state.shellPolicyText = describeShellPolicy(shellPolicy);
  const promptGuidelines = [state.shellPolicyText, ...basePromptGuidelines];

  // ---------------------------------------------------------------- lifecycle

  pi.on("session_start", async (event, ctx) => {
    assertLinux();
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
    state.pending = [];
    state.settleClaims.clear();
    state.heldSettles.clear();
    state.ctx?.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.on("agent_start", async () => {
    state.busy = true;
  });

  pi.on("agent_before_settle", async (event) => {
    state.busy = false;
    const entries: unknown[] = [];
    let continueTurn = false;

    if (state.pending.length > 0) {
      const records = state.pending.splice(0, state.pending.length);
      for (const record of records) state.delivered.add(record.id);
      entries.push({
        type: "custom_message",
        customType: COMPLETION_TYPE,
        content: await completionMessage(records),
        display: true,
      });
      continueTurn = true;
    }

    if (entries.length === 0) return undefined;
    return { entries: [...event.entries, ...entries], continue: continueTurn } as never;
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
    description: `Start a session or workspace command with pipe or pty I/O. Returns a handle, unless the command settles within inlineSettleMs, in which case this call returns its outcome and output tail. ${shellPolicy.shell} -c runs the command; explicit env values override the default credential filter.`,
    promptSnippet,
    promptGuidelines,
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to run" }),
      name: Type.Optional(Type.String({ description: "2-6 word label for the dock and the handle list" })),
      cwd: Type.Optional(Type.String()),
      env: Type.Optional(Type.Record(Type.String(), Type.String())),
      scope: Type.Optional(scopeEnum),
      binding: Type.Optional(bindingEnum),
      timeoutSeconds: Type.Optional(Type.Number()),
      notifyOnCompletion: Type.Optional(Type.Boolean()),
      triggerOnCompletion: Type.Optional(Type.Boolean()),
      delivery: Type.Optional(deliveryEnum),
      request: Type.Optional(Type.String()),
      inlineSettleMs: Type.Optional(
        Type.Number({
          minimum: 0,
          description: `Hold this call open this long for a settle. Default ${DEFAULT_INLINE_SETTLE_MS}; 0 returns the handle at once. Values above ${MAX_INLINE_SETTLE_MS} are clamped, not rejected.`,
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
      const handle = await registry.start(params as never);
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
      return {
        content: [
          {
            type: "text" as const,
            text: startText(reported, settled ? inlineSettleMs : undefined, preview, inlineNote),
          },
        ],
        structuredContent: json(settled ? { ...settled, settledInline: true } : handle),
        details: { id: reported.id, settled: Boolean(settled) },
      };
    },
  });

  pi.registerTool({
    name: "shell_await",
    label: "Await async shell",
    description:
      "Wait for exit, $PI_ASYNC_SHELL_EXEC_DIR/ready, or an output regex. Timeout never cancels. waitMs defaults to 30000 and is clamped to 50000 rather than rejected; values above the cap leave a note in the result. In codemode, end the turn after a full-length wait and rely on completion delivery.",
    promptGuidelines,
    parameters: Type.Object({
      ids: Type.Union([Type.String(), Type.Array(Type.String())]),
      mode: Type.Optional(StringEnum(["all", "any"] as const)),
      until: Type.Optional(
        Type.Union([
          Type.Object({ kind: Type.Literal("exit") }),
          Type.Object({ kind: Type.Literal("ready") }),
          Type.Object({
            kind: Type.Literal("pattern"),
            regex: Type.String(),
            stream: Type.Optional(StringEnum(["combined", "stdout", "stderr", "ptyView"] as const)),
            since: Type.Optional(Type.Union([Type.Number(), Type.Literal("now")])),
          }),
        ]),
      ),
      waitMs: Type.Optional(
        Type.Number({ minimum: 0, description: "Default 30000; values above 50000 are clamped, not rejected" }),
      ),
      includeOutputPreview: Type.Optional(Type.Boolean()),
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
        result = await registry.awaitHandles({ ...params, waitMs } as never, signal);
        // An aborted call may never reach the model, so its outcome is not a
        // delivery: the completion channel still has to report the run.
        if (!signal?.aborted) consumeSettles(result.outcomes, consumed);
      } finally {
        releaseSettles(ids, consumed);
      }
      const lines: string[] = [];
      if (requestedWaitMs > MAX_WAIT_MS) {
        lines.push(
          `waitMs ${requestedWaitMs} clamped to ${MAX_WAIT_MS}; a completion message still wakes you when the command settles.`,
        );
      }
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
      if (result.timedOutWaiting) {
        if (waitMs >= MAX_WAIT_MS) {
          lines.push(
            "The full-length wait expired. Nothing was killed. End the turn; a completion message will wake you when the command settles. Do not issue another blocking await for the same work.",
          );
        } else {
          lines.push(
            "The wait expired. Nothing was killed. End the turn if the remaining work is long, or await again.",
          );
        }
      }
      return {
        content: [{ type: "text" as const, text: lines.join("\n") || "nothing to await" }],
        structuredContent: json(result),
        details: { settled: result.settled },
      };
    },
  });

  pi.registerTool({
    name: "shell_read",
    label: "Read async shell log",
    description:
      "Read a bounded slice of an execution's durable output. Streams: combined, stdout, stderr, ptyView. Modes: tail, head, offset, grep, all (a bounded head read with paging guidance in the note). Hard cap: 2000 lines or 50 KiB per call. ptyView is the rendered terminal screen (a viewport, not a scrollback); combined is the byte stream.",
    promptGuidelines,
    parameters: Type.Object({
      id: Type.String(),
      stream: Type.Optional(streamEnum),
      mode: Type.Optional(StringEnum(["tail", "head", "offset", "grep", "all"] as const)),
      lines: Type.Optional(Type.Number()),
      maxBytes: Type.Optional(Type.Number()),
      lineOffset: Type.Optional(Type.Number()),
      byteOffset: Type.Optional(Type.Number()),
      pattern: Type.Optional(Type.String()),
      context: Type.Optional(Type.Number()),
      stripAnsi: Type.Optional(Type.Boolean()),
    }),
    outputSchema: readResultSchema,
    async execute(_toolCallId, params, signal) {
      const registry = requireRegistry();
      const result = await registry.read(params as never, signal);
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
      "Move a live execution to a wider supervision scope. This is the honest name for backgrounding. Promotion is one-directional and audited.",
    promptGuidelines,
    parameters: Type.Object({
      id: Type.String(),
      to: StringEnum(["session", "workspace"] as const),
      adopterNotification: Type.Optional(Type.Boolean()),
    }),
    outputSchema: handleSchema,
    async execute(_toolCallId, params) {
      const registry = requireRegistry();
      const handle = await registry.promote(params as never);
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
      "Write stdin text or key chords into a pty execution. Refuses on pipe, because a pipe has no terminal. The write goes to the execution's stdin FIFO, so it works from a later Pi process too.",
    promptGuidelines,
    parameters: Type.Object({
      id: Type.String(),
      text: Type.Optional(Type.String()),
      keys: Type.Optional(Type.Array(Type.String())),
      settleMs: Type.Optional(Type.Number()),
      request: Type.Optional(Type.String()),
    }),
    outputSchema: Type.Object({
      id: Type.String(),
      wrote: Type.Boolean(),
      screen: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      const registry = requireRegistry();
      const result: ShellSendResult = await registry.send(params as never);
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
      "Cancel one or more executions: graceful signal, grace period, forced kill, then verification that the process tree is gone. Cancellation is not rollback.",
    promptGuidelines,
    parameters: Type.Object({
      ids: Type.Union([Type.String(), Type.Array(Type.String())]),
      ladder: Type.Optional(StringEnum(["graceful", "force"] as const)),
      graceMs: Type.Optional(Type.Number()),
    }),
    outputSchema: cancelResultSchema,
    async execute(_toolCallId, params) {
      const registry = requireRegistry();
      const results: ShellCancelResult[] = await registry.cancel(params as never);
      const text = results
        .map(
          (result) =>
            `${result.id}: ${result.status}${result.verifiedGone ? " · tree verified gone" : ` · leak: ${(result.leaked ?? []).join(", ")}`}${result.note ? ` · ${result.note}` : ""}`,
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
    description:
      "Point-in-time inspection of one handle or of all handles. This is not a polling primitive: synchronise with shell_await, and wait idly by ending the turn.",
    promptGuidelines,
    parameters: Type.Object({ id: Type.Optional(Type.String()) }),
    outputSchema: statusResultSchema,
    async execute(_toolCallId, params) {
      const registry = requireRegistry();
      const result: ShellStatusResult = registry.status(params as never);
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
      ctx.ui.notify(lines.join("\n"), "info");
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
