import { statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import type { BenchSession } from "./harness.ts";

export interface StartResult {
  id: string;
  ms: number;
  text: string;
}

export interface StatusResult {
  status: string;
  exitCode?: number | null;
  text: string;
  ms: number;
}

export interface ReadResult {
  text: string;
  ms: number;
  totalBytes: number;
}

export interface GrepResult {
  text: string;
  found: boolean;
  ms: number;
}

export interface StartOptions {
  name?: string;
  /** Supervisor scope. Only pi-async-shell distinguishes session/workspace. */
  scope?: "session" | "workspace";
  /** I/O binding. Only implementations with a PTY honour this. */
  binding?: "pipe" | "pty";
  /** Readiness hint; adapters map it to their native start or await API. */
  readiness?: { kind: "pattern"; regex: string };
  notifyOnCompletion?: boolean;
}

/**
 * What an implementation can do, established by probing its registered tools
 * rather than by reading its README. Every flag is backed by a call that either
 * exists or does not.
 */
export interface Caps {
  /** A call can block until the command settles, inside the same turn. */
  inTurnAwait: boolean;
  /** A call can wait for a declared output pattern. */
  readiness: boolean;
  /** The log reader can search, page, or select a stream. */
  grep: boolean;
  /** A running command can receive stdin. */
  stdin: boolean;
  /** A command can be given a real terminal. */
  pty: boolean;
  /** A rendered terminal screen can be read back. */
  screen: boolean;
  /** The agent can stop a running command at all. */
  cancel: boolean;
  /** Completion is delivered as a message that can wake an idle turn. */
  notify: boolean;
}

export interface Impl {
  key: string;
  title: string;
  session: BenchSession;
  caps: Caps;
  start(command: string, options?: StartOptions): Promise<StartResult>;
  awaitAll(ids: string[], timeoutMs: number): Promise<{ ms: number; statuses: string[]; text: string }>;
  awaitReady(id: string, timeoutMs: number): Promise<{ ms: number; ready: boolean; text: string }>;
  waitCompletionFor(ids: string[], timeoutMs: number): Promise<{ ms: number; matched: number; text: string }>;
  readTail(id: string, maxBytes: number): Promise<ReadResult>;
  readHead(id: string, maxBytes: number): Promise<ReadResult>;
  readGrep(id: string, pattern: string): Promise<GrepResult | undefined>;
  readScreen(id: string): Promise<ReadResult | undefined>;
  send(id: string, text: string): Promise<{ wrote: boolean; text: string } | undefined>;
  status(id: string): Promise<StatusResult>;
  statusAll(): Promise<StatusResult>;
  cancel(id: string): Promise<{ text: string; supported: boolean }>;
  logPath(id: string): string | undefined;
}

const NO_CAPS: Caps = {
  inTurnAwait: false,
  readiness: false,
  grep: false,
  stdin: false,
  pty: false,
  screen: false,
  cancel: false,
  notify: false,
};

function logSize(path: string | undefined): number {
  if (!path) return 0;
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Waits for a completion message without knowing which customType an
 * implementation uses: it snapshots the message list, then looks for any new
 * message that mentions one of the ids. This keeps the measurement fair for
 * extensions whose notification type is not in their public API.
 */
async function waitForAnyNotification(
  session: BenchSession,
  ids: string[],
  timeoutMs: number,
): Promise<{ ms: number; matched: number; text: string }> {
  const started = performance.now();
  const baseline = session.messages().length;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const fresh = session.messages().slice(baseline);
    const matched = ids.filter((id) => fresh.some((message) => JSON.stringify(message.content ?? "").includes(id)));
    if (matched.length >= ids.length) {
      const target = fresh.find((message) => JSON.stringify(message.content ?? "").includes(ids[0]!));
      return { ms: performance.now() - started, matched: matched.length, text: JSON.stringify(target?.content ?? "") };
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { ms: performance.now() - started, matched: 0, text: "" };
}

/** Polls a status function until it reports a terminal state or the deadline passes. */
async function pollUntilTerminal(
  statusOf: (id: string) => Promise<StatusResult>,
  ids: string[],
  timeoutMs: number,
  intervalMs = 200,
): Promise<{ ms: number; statuses: string[]; text: string; calls: number }> {
  const started = performance.now();
  const deadline = Date.now() + timeoutMs;
  const terminal = new Set([
    "completed",
    "succeeded",
    "failed",
    "killed",
    "cancelled",
    "exited",
    "done",
    "unknown",
  ]);
  let statuses: string[] = [];
  let text = "";
  let calls = 0;
  while (Date.now() < deadline) {
    statuses = [];
    text = "";
    for (const id of ids) {
      const status = await statusOf(id);
      calls += 1;
      statuses.push(status.status);
      text += status.text;
    }
    if (statuses.every((status) => terminal.has(status))) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return { ms: performance.now() - started, statuses, text, calls };
}

// ------------------------------------------------------------ pi-async-shell

export function createAsyncShellImpl(session: BenchSession): Impl {
  const logs = new Map<string, string>();
  const readinessPatterns = new Map<string, string>();
  return {
    key: "async-shell",
    title: "pi-async-shell",
    session,
    caps: { ...NO_CAPS, inTurnAwait: true, readiness: true, grep: true, stdin: true, pty: true, screen: true, cancel: true, notify: true },
    async start(command, options = {}) {
      const result = await session.callTool(
        "shell_start",
        {
          command,
          scope: options.scope ?? "session",
          name: options.name ?? "bench task",
          ...(options.binding ? { binding: options.binding } : {}),
          ...(options.notifyOnCompletion === undefined ? {} : { notifyOnCompletion: options.notifyOnCompletion }),
        },
        { timeoutMs: 60_000 },
      );
      const id = result.text.match(/sh_[0-9a-f]{8}/)?.[0];
      if (!id) throw new Error(`no handle id in: ${result.text.slice(0, 200)}`);
      if (options.readiness) readinessPatterns.set(id, options.readiness.regex);
      const structured = result.structured as { log?: { combined?: string } } | undefined;
      if (structured?.log?.combined) logs.set(id, structured.log.combined);
      return { id, ms: result.ms, text: result.text };
    },
    async awaitAll(ids, timeoutMs) {
      const result = await session.callTool(
        "shell_await",
        { ids, mode: "all", waitMs: timeoutMs, includeOutputPreview: false },
        { timeoutMs: timeoutMs + 10_000 },
      );
      const structured = result.structured as { outcomes?: { status: string }[] } | undefined;
      return {
        ms: result.ms,
        statuses: (structured?.outcomes ?? []).map((outcome) => outcome.status),
        text: result.text,
      };
    },
    async awaitReady(id, timeoutMs) {
      const result = await session.callTool(
        "shell_await",
        {
          ids: id,
          until: { kind: "pattern", regex: readinessPatterns.get(id) ?? "READY" },
          waitMs: timeoutMs,
          includeOutputPreview: false,
        },
        { timeoutMs: timeoutMs + 10_000 },
      );
      const structured = result.structured as { timedOutWaiting?: boolean; matched?: unknown } | undefined;
      const ready = !structured?.timedOutWaiting && Boolean(structured?.matched);
      return { ms: result.ms, ready, text: result.text };
    },
    waitCompletionFor(ids, timeoutMs) {
      return waitForAnyNotification(session, ids, timeoutMs);
    },
    async readTail(id, maxBytes) {
      const result = await session.callTool("shell_read", { id, mode: "tail", lines: 2000, maxBytes });
      const structured = result.structured as { totalBytes?: number } | undefined;
      return { text: result.text, ms: result.ms, totalBytes: structured?.totalBytes ?? logSize(logs.get(id)) };
    },
    async readHead(id, maxBytes) {
      const result = await session.callTool("shell_read", { id, mode: "head", lines: 2000, maxBytes });
      const structured = result.structured as { totalBytes?: number } | undefined;
      return { text: result.text, ms: result.ms, totalBytes: structured?.totalBytes ?? logSize(logs.get(id)) };
    },
    async readGrep(id, pattern) {
      const result = await session.callTool("shell_read", { id, mode: "grep", pattern, context: 2 });
      const structured = result.structured as { text?: string } | undefined;
      return { text: result.text, found: (structured?.text ?? "").includes(pattern), ms: result.ms };
    },
    async readScreen(id) {
      const result = await session.callTool("shell_read", { id, stream: "ptyView" });
      return { text: result.text, ms: result.ms, totalBytes: result.text.length };
    },
    async send(id, text) {
      const result = await session.callTool("shell_send", { id, text, settleMs: 300 });
      const structured = result.structured as { wrote?: boolean } | undefined;
      return { wrote: structured?.wrote ?? false, text: result.text };
    },
    async status(id) {
      const result = await session.callTool("shell_status", { id });
      const structured = result.structured as { handles?: { status: string; exitCode?: number | null }[] } | undefined;
      const handle = structured?.handles?.[0];
      return { status: handle?.status ?? "unknown", exitCode: handle?.exitCode, text: result.text, ms: result.ms };
    },
    async statusAll() {
      const result = await session.callTool("shell_status", {});
      return { status: "unknown", text: result.text, ms: result.ms };
    },
    async cancel(id) {
      const result = await session.callTool("shell_cancel", { ids: id, ladder: "force" }, { timeoutMs: 30_000 });
      return { text: result.text, supported: true };
    },
    logPath(id) {
      return logs.get(id);
    },
  };
}

// -------------------------------------------------------- pi-background-tasks

export function createBackgroundTasksImpl(session: BenchSession): Impl {
  const logs = new Map<string, string>();
  return {
    key: "bg-tasks",
    title: "pi-background-tasks",
    session,
    caps: { ...NO_CAPS, cancel: true, notify: true },
    async start(command, options = {}) {
      const result = await session.callTool(
        "bg_run",
        {
          command,
          name: options.name ?? "bench task",
          isAgent: false,
          ...(options.notifyOnCompletion === undefined ? {} : { notifyOnCompletion: options.notifyOnCompletion }),
        },
        { timeoutMs: 60_000 },
      );
      const id = result.text.match(/Started background task .*?\(([0-9a-z]+)\)/)?.[1];
      if (!id) throw new Error(`no task id in: ${result.text.slice(0, 200)}`);
      const output = result.text.match(/Output: (.+)/)?.[1]?.trim();
      if (output) logs.set(id, isAbsolute(output) ? output : join(session.cwd, output));
      return { id, ms: result.ms, text: result.text };
    },
    async awaitAll(ids, timeoutMs) {
      // No causal barrier: the only supported path is the turn boundary.
      const result = await waitForAnyNotification(session, ids, timeoutMs);
      return { ms: result.ms, statuses: [], text: result.text };
    },
    async awaitReady() {
      return { ms: 0, ready: false, text: "" };
    },
    waitCompletionFor(ids, timeoutMs) {
      return waitForAnyNotification(session, ids, timeoutMs);
    },
    async readTail(id, maxBytes) {
      const result = await session.callTool("bg_logs", { taskId: id, maxBytes, tail: true });
      return { text: result.text, ms: result.ms, totalBytes: logSize(logs.get(id)) };
    },
    async readHead(id, maxBytes) {
      const result = await session.callTool("bg_logs", { taskId: id, maxBytes, tail: false });
      return { text: result.text, ms: result.ms, totalBytes: logSize(logs.get(id)) };
    },
    async readGrep() {
      return undefined;
    },
    async readScreen() {
      return undefined;
    },
    async send() {
      return undefined;
    },
    async status(id) {
      const result = await session.callTool("bg_status", { taskId: id });
      const status =
        result.text.match(/\b(running|completed|failed|killed|cancelled|timed out)\b/i)?.[1]?.toLowerCase() ?? "unknown";
      const exitCode = result.text.match(/exit=(-?\d+)/i)?.[1];
      return {
        status,
        exitCode: exitCode === undefined ? undefined : Number(exitCode),
        text: result.text,
        ms: result.ms,
      };
    },
    async statusAll() {
      const result = await session.callTool("bg_status", {});
      return { status: "unknown", text: result.text, ms: result.ms };
    },
    async cancel(id) {
      const result = await session.callTool("bg_kill", { taskId: id });
      return { text: result.text, supported: true };
    },
    logPath(id) {
      return logs.get(id);
    },
  };
}

// ------------------------------------------------- pi-better-background-tasks

export function createBetterBackgroundTasksImpl(session: BenchSession): Impl {
  return {
    key: "better-bg",
    title: "pi-better-background-tasks",
    session,
    caps: { ...NO_CAPS, cancel: true, notify: true },
    async start(command, options = {}) {
      const result = await session.callTool(
        "bg_task_spawn",
        { name: options.name ?? "bench task", command },
        { timeoutMs: 60_000 },
      );
      const id = result.text.match(/bgs_[0-9a-f]+/)?.[0];
      if (!id) throw new Error(`no task id in: ${result.text.slice(0, 200)}`);
      return { id, ms: result.ms, text: result.text };
    },
    async awaitAll(ids, timeoutMs) {
      // wait_for_operations registers a wait and returns immediately; the model
      // is not blocked. Polling is the only in-turn path.
      await session.callTool(
        "wait_for_operations",
        { task_ids: ids, continuation_note: "benchmark" },
        { timeoutMs: 15_000 },
      );
      const polled = await pollUntilTerminal((id) => this.status(id), ids, timeoutMs);
      return { ms: polled.ms, statuses: polled.statuses, text: polled.text };
    },
    async awaitReady() {
      return { ms: 0, ready: false, text: "" };
    },
    waitCompletionFor(ids, timeoutMs) {
      return waitForAnyNotification(session, ids, timeoutMs);
    },
    async readTail(id, maxBytes) {
      const lines = Math.max(20, Math.min(2000, Math.floor(maxBytes / 40)));
      const result = await session.callTool("bg_task_log", { id, tail_lines: lines });
      return { text: result.text, ms: result.ms, totalBytes: Buffer.byteLength(result.text, "utf8") };
    },
    async readHead(id, maxBytes) {
      const lines = Math.max(20, Math.min(2000, Math.floor(maxBytes / 40)));
      const result = await session.callTool("bg_task_log", { id, lines });
      return { text: result.text, ms: result.ms, totalBytes: Buffer.byteLength(result.text, "utf8") };
    },
    async readGrep() {
      return undefined;
    },
    async readScreen() {
      return undefined;
    },
    async send() {
      return undefined;
    },
    async status(id) {
      const result = await session.callTool("bg_task_status", { id });
      const raw = result.text.match(/process: (\w+)/)?.[1]?.toLowerCase() ?? "unknown";
      const status = raw === "succeeded" ? "completed" : raw;
      const exitCode = result.text.match(/exit=(-?\d+)/)?.[1];
      return {
        status,
        exitCode: exitCode === undefined ? undefined : Number(exitCode),
        text: result.text,
        ms: result.ms,
      };
    },
    async statusAll() {
      const result = await session.callTool("bg_task_list", {});
      return { status: "unknown", text: result.text, ms: result.ms };
    },
    async cancel(id) {
      const result = await session.callTool("bg_task_stop", { id }, { timeoutMs: 30_000 });
      return { text: result.text, supported: true };
    },
    logPath() {
      return undefined;
    },
  };
}

// -------------------------------------------------------------- pi-background

export function createPiBackgroundImpl(session: BenchSession): Impl {
  const logs = new Map<string, string>();
  return {
    key: "pi-background",
    title: "pi-background",
    session,
    caps: { ...NO_CAPS, cancel: true, notify: true },
    async start(command, options = {}) {
      const result = await session.callTool(
        "bg_run",
        { command, ...(options.readiness ? { wake_on: options.readiness.regex } : {}) },
        { timeoutMs: 60_000 },
      );
      const id = result.text.match(/Started (bg\d+)/)?.[1];
      if (!id) throw new Error(`no job id in: ${result.text.slice(0, 200)}`);
      const log = result.text.match(/log: (\S+\.log)/)?.[1];
      if (log) logs.set(id, log);
      return { id, ms: result.ms, text: result.text };
    },
    async awaitAll(ids, timeoutMs) {
      const polled = await pollUntilTerminal((id) => this.status(id), ids, timeoutMs);
      return { ms: polled.ms, statuses: polled.statuses, text: polled.text };
    },
    async awaitReady() {
      return { ms: 0, ready: false, text: "" };
    },
    waitCompletionFor(ids, timeoutMs) {
      return waitForAnyNotification(session, ids, timeoutMs);
    },
    async readTail(id) {
      const result = await session.callTool("bg_status", { id, lines: 2000 });
      return { text: result.text, ms: result.ms, totalBytes: logSize(logs.get(id)) };
    },
    async readHead(id) {
      // bg_status only ever returns the tail of the log.
      const result = await session.callTool("bg_status", { id, lines: 2000 });
      return { text: result.text, ms: result.ms, totalBytes: logSize(logs.get(id)) };
    },
    async readGrep() {
      return undefined;
    },
    async readScreen() {
      return undefined;
    },
    async send() {
      return undefined;
    },
    async status(id) {
      const result = await session.callTool("bg_status", { id, lines: 5 });
      // "[running, 0s]" while alive; "[exit 0, 0s]" once it has finished.
      const bracket = result.text.match(/\[([^\]]+)\]/)?.[1] ?? "";
      const status = /^exit\b/.test(bracket) ? "completed" : bracket.split(",")[0]!.trim().toLowerCase();
      const exitCode = bracket.match(/^exit (-?\d+)/)?.[1];
      return {
        status: status || "unknown",
        exitCode: exitCode === undefined ? undefined : Number(exitCode),
        text: result.text,
        ms: result.ms,
      };
    },
    async statusAll() {
      const result = await session.callTool("bg_status", {});
      return { status: "unknown", text: result.text, ms: result.ms };
    },
    async cancel(id) {
      const result = await session.callTool("bg_kill", { id }, { timeoutMs: 30_000 });
      return { text: result.text, supported: true };
    },
    logPath(id) {
      return logs.get(id);
    },
  };
}

// -------------------------------------------------------- pi-patty-bg-tasks

export function createPattyImpl(session: BenchSession): Impl {
  const logs = new Map<string, string>();
  return {
    key: "patty",
    title: "pi-patty-bg-tasks",
    session,
    caps: { ...NO_CAPS, inTurnAwait: true, grep: true, cancel: true, notify: true },
    async start(command, options = {}) {
      const result = await session.callTool(
        "bash_bg",
        { command, name: options.name ?? "bench task", notify: options.notifyOnCompletion ?? true },
        { timeoutMs: 60_000 },
      );
      const id = result.text.match(/job-\d+-\d+/)?.[0];
      if (!id) throw new Error(`no job id in: ${result.text.slice(0, 200)}`);
      const log = result.text.match(/written to: (\S+)/)?.[1];
      if (log) logs.set(id, log);
      return { id, ms: result.ms, text: result.text };
    },
    async awaitAll(ids, timeoutMs) {
      let text = "";
      let ms = 0;
      const statuses: string[] = [];
      for (const id of ids) {
        const result = await session.callTool("jobs", { action: "attach", jobId: id, wait: true }, { timeoutMs });
        ms += result.ms;
        text += result.text;
        statuses.push(result.text.match(/Status: (\w+)/)?.[1]?.toLowerCase() ?? "unknown");
      }
      return { ms, statuses, text };
    },
    async awaitReady() {
      return { ms: 0, ready: false, text: "" };
    },
    waitCompletionFor(ids, timeoutMs) {
      return waitForAnyNotification(session, ids, timeoutMs);
    },
    async readTail(id) {
      const result = await session.callTool("jobs", { action: "output", jobId: id });
      return { text: result.text, ms: result.ms, totalBytes: logSize(logs.get(id)) };
    },
    async readHead(id) {
      const result = await session.callTool("jobs", { action: "output", jobId: id });
      return { text: result.text, ms: result.ms, totalBytes: logSize(logs.get(id)) };
    },
    async readGrep(id, pattern) {
      const result = await session.callTool("jobs", { action: "search", jobId: id, pattern });
      return { text: result.text, found: !/No matches/.test(result.text), ms: result.ms };
    },
    async readScreen() {
      return undefined;
    },
    async send() {
      return undefined;
    },
    async status(id) {
      const result = await session.callTool("jobs", { action: "output", jobId: id });
      const status = result.text.match(/\((running|completed|failed|killed)\)/)?.[1]?.toLowerCase() ?? "unknown";
      return { status, text: result.text, ms: result.ms };
    },
    async statusAll() {
      const result = await session.callTool("jobs", { action: "list" });
      return { status: "unknown", text: result.text, ms: result.ms };
    },
    async cancel(id) {
      try {
        const result = await session.callTool("jobs", { action: "kill", jobId: id }, { timeoutMs: 30_000 });
        return { text: result.text, supported: true };
      } catch (error) {
        // jobs kill throws on an already-finished job; that is still a cancel path.
        return { text: String(error).slice(0, 200), supported: true };
      }
    },
    logPath(id) {
      return logs.get(id);
    },
  };
}

// ------------------------------------------------------------------ pi-async

export function createPiAsyncImpl(session: BenchSession): Impl {
  const logs = new Map<string, string>();
  // async_status lists only live tasks: once one settles it disappears, so the
  // last observed state is kept rather than reported as unknown.
  const lastStatus = new Map<string, { status: string; exitCode?: number }>();
  return {
    key: "pi-async",
    title: "pi-async",
    session,
    caps: { ...NO_CAPS, inTurnAwait: true, cancel: true, notify: true },
    async start(command, options = {}) {
      const result = await session.callTool(
        "async_run",
        {
          command,
          name: options.name ?? "bench task",
          ...(options.notifyOnCompletion === undefined ? {} : { notifyOnCompletion: options.notifyOnCompletion }),
        },
        { timeoutMs: 60_000 },
      );
      let id = "";
      try {
        id = (JSON.parse(result.text) as { taskId?: string }).taskId ?? "";
      } catch {
        id = result.text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0] ?? "";
      }
      if (!id) throw new Error(`no task id in: ${result.text.slice(0, 200)}`);
      return { id, ms: result.ms, text: result.text };
    },
    async awaitAll(ids, timeoutMs) {
      const result = await session.callTool("async_wait", { taskIds: ids, timeoutMs }, { timeoutMs: timeoutMs + 10_000 });
      let statuses: string[] = [];
      let outputTail = "";
      try {
        const parsed = JSON.parse(result.text) as {
          results?: { taskId: string; status: string; exitCode?: number; outputTail?: string }[];
        };
        for (const entry of parsed.results ?? []) {
          lastStatus.set(entry.taskId, { status: entry.status, exitCode: entry.exitCode });
        }
        statuses = (parsed.results ?? []).map((entry) => entry.status);
        outputTail = (parsed.results ?? []).map((entry) => entry.outputTail ?? "").join("");
      } catch {
        /* leave the raw text as the result */
      }
      return { ms: result.ms, statuses, text: result.text + outputTail };
    },
    async awaitReady() {
      return { ms: 0, ready: false, text: "" };
    },
    waitCompletionFor(ids, timeoutMs) {
      return waitForAnyNotification(session, ids, timeoutMs);
    },
    async readTail(id, maxBytes) {
      const result = await session.callTool("async_logs", { taskId: id, maxBytes, tail: true });
      const parsed = safeJson(result.text) as { text?: string; fullPath?: string } | undefined;
      if (parsed?.fullPath) logs.set(id, parsed.fullPath);
      return { text: result.text, ms: result.ms, totalBytes: logSize(logs.get(id)) };
    },
    async readHead(id, maxBytes) {
      const result = await session.callTool("async_logs", { taskId: id, maxBytes, tail: false });
      const parsed = safeJson(result.text) as { fullPath?: string } | undefined;
      if (parsed?.fullPath) logs.set(id, parsed.fullPath);
      return { text: result.text, ms: result.ms, totalBytes: logSize(logs.get(id)) };
    },
    async readGrep() {
      return undefined;
    },
    async readScreen() {
      return undefined;
    },
    async send() {
      return undefined;
    },
    async status(id) {
      const result = await session.callTool("async_status", {});
      const parsed = safeJson(result.text) as { taskId: string; status: string; exitCode?: number }[] | undefined;
      const entry = Array.isArray(parsed) ? parsed.find((item) => item.taskId === id) : undefined;
      if (entry) {
        lastStatus.set(id, { status: entry.status, exitCode: entry.exitCode });
        return { status: entry.status, exitCode: entry.exitCode, text: result.text, ms: result.ms };
      }
      const remembered = lastStatus.get(id);
      return {
        status: remembered?.status ?? "unknown",
        exitCode: remembered?.exitCode,
        text: result.text,
        ms: result.ms,
      };
    },
    async statusAll() {
      const result = await session.callTool("async_status", {});
      return { status: "unknown", text: result.text, ms: result.ms };
    },
    async cancel(id) {
      const result = await session.callTool("async_kill", { taskId: id }, { timeoutMs: 30_000 });
      return { text: result.text, supported: true };
    },
    logPath(id) {
      return logs.get(id);
    },
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ pi-shell

export function createPiShellImpl(session: BenchSession): Impl {
  const logs = new Map<string, string>();
  return {
    key: "pi-shell",
    title: "@tduyng/pi-shell",
    session,
    caps: { ...NO_CAPS, inTurnAwait: true, stdin: true, cancel: true },
    async start(command, options = {}) {
      const result = await session.callTool(
        "bg",
        { action: "start", command, stdin: true },
        { timeoutMs: 60_000 },
      );
      const id = result.text.match(/task_id:\s*(\S+)/)?.[1];
      if (!id) throw new Error(`no task id in: ${result.text.slice(0, 200)}`);
      const log = result.text.match(/log: (\S+)/)?.[1];
      if (log) logs.set(id, log);
      return { id, ms: result.ms, text: result.text };
    },
    async awaitAll(ids, timeoutMs) {
      let text = "";
      let ms = 0;
      const statuses: string[] = [];
      for (const id of ids) {
        const result = await session.callTool("bg", { action: "output", task_id: id, wait: "exit" }, { timeoutMs });
        ms += result.ms;
        text += result.text;
        statuses.push(/exited (-?\d+)/.test(result.text) ? "completed" : "running");
      }
      return { ms, statuses, text };
    },
    async awaitReady() {
      return { ms: 0, ready: false, text: "" };
    },
    waitCompletionFor(ids, timeoutMs) {
      return waitForAnyNotification(session, ids, timeoutMs);
    },
    async readTail(id) {
      const result = await session.callTool("bg", { action: "output", task_id: id });
      return { text: result.text, ms: result.ms, totalBytes: logSize(logs.get(id)) };
    },
    async readHead(id) {
      const result = await session.callTool("bg", { action: "output", task_id: id });
      return { text: result.text, ms: result.ms, totalBytes: logSize(logs.get(id)) };
    },
    async readGrep() {
      return undefined;
    },
    async readScreen() {
      return undefined;
    },
    async send(id, text) {
      const result = await session.callTool("bg", { action: "input", task_id: id, text }, { timeoutMs: 15_000 });
      return { wrote: !/no open stdin/i.test(result.text), text: result.text };
    },
    async status(id) {
      const result = await session.callTool("bg", { action: "status" });
      const line = result.text.split("\n").find((entry) => entry.includes(id)) ?? "";
      const raw = line.match(/\b(running|exited|done|killed)\b/)?.[1]?.toLowerCase() ?? "unknown";
      const status = raw === "exited" || raw === "done" ? "completed" : raw;
      const exitCode = line.match(/exited (-?\d+)/)?.[1];
      return {
        status,
        exitCode: exitCode === undefined ? undefined : Number(exitCode),
        text: result.text,
        ms: result.ms,
      };
    },
    async statusAll() {
      const result = await session.callTool("bg", { action: "status" });
      return { status: "unknown", text: result.text, ms: result.ms };
    },
    async cancel(id) {
      const result = await session.callTool("bg", { action: "kill", task_id: id }, { timeoutMs: 30_000 });
      return { text: result.text, supported: true };
    },
    logPath(id) {
      return logs.get(id);
    },
  };
}

// -------------------------------------------------------------- pi-shell-jobs

export function createShellJobsImpl(session: BenchSession): Impl {
  const logs = new Map<string, string>();
  const sessions = new Map<string, number>();
  // A command that finishes inside exec_command has no session to poll, and a
  // session that has been pruned answers with an error rather than a result.
  const finished = new Map<string, { text: string; exitCode?: number }>();
  const poll = async (
    id: string,
  ): Promise<{ text: string; exitCode?: number; terminal: boolean; ms: number }> => {
    const done = finished.get(id);
    if (done) return { text: done.text, exitCode: done.exitCode, terminal: true, ms: 0 };
    try {
      const result = await session.callTool("write_stdin", { session_id: sessions.get(id), yield_time_ms: 250 });
      const structured = result.structured as { exit_code?: number } | undefined;
      return {
        text: result.text,
        exitCode: structured?.exit_code,
        terminal: structured?.exit_code !== undefined,
        ms: result.ms,
      };
    } catch (error) {
      return { text: String(error).slice(0, 160), exitCode: undefined, terminal: true, ms: 0 };
    }
  };
  return {
    key: "shell-jobs",
    title: "pi-shell-jobs",
    session,
    caps: { ...NO_CAPS, inTurnAwait: true, stdin: true, pty: true, cancel: true },
    async start(command, options = {}) {
      const result = await session.callTool(
        "exec_command",
        {
          cmd: command,
          shell: "/bin/sh",
          tty: options.binding === "pty",
          yield_time_ms: 250,
          ...(options.notifyOnCompletion === false ? {} : { on_exit: "wake" }),
        },
        { timeoutMs: 60_000 },
      );
      const structured = result.structured as
        | { session_id?: number; log_path?: string; exit_code?: number }
        | undefined;
      const sessionId = structured?.session_id;
      if (sessionId === undefined) {
        const id = `sj-done-${finished.size + 1}`;
        finished.set(id, { text: result.text, exitCode: structured?.exit_code });
        if (structured?.log_path) logs.set(id, structured.log_path);
        return { id, ms: result.ms, text: result.text };
      }
      const id = String(sessionId);
      sessions.set(id, sessionId);
      if (structured?.log_path) logs.set(id, structured.log_path);
      return { id, ms: result.ms, text: result.text };
    },
    async awaitAll(ids, timeoutMs) {
      let text = "";
      let ms = 0;
      const statuses: string[] = [];
      for (const id of ids) {
        const done = finished.get(id);
        if (done) {
          text += done.text;
          statuses.push("completed");
          continue;
        }
        try {
          const result = await session.callTool(
            "write_stdin",
            { session_id: sessions.get(id), yield_time_ms: Math.min(timeoutMs, 30_000) },
            { timeoutMs: timeoutMs + 10_000 },
          );
          ms += result.ms;
          text += result.text;
          statuses.push(/\[exited\]/.test(result.text) ? "completed" : "running");
        } catch {
          statuses.push("completed");
        }
      }
      return { ms, statuses, text };
    },
    async awaitReady() {
      return { ms: 0, ready: false, text: "" };
    },
    waitCompletionFor(ids, timeoutMs) {
      return waitForAnyNotification(session, ids, timeoutMs);
    },
    async readTail(id) {
      // This design has no log reader: a poll returns only new output.
      const polled = await poll(id);
      return { text: polled.text, ms: polled.ms, totalBytes: logSize(logs.get(id)) };
    },
    async readHead(id) {
      const polled = await poll(id);
      return { text: polled.text, ms: polled.ms, totalBytes: logSize(logs.get(id)) };
    },
    async readGrep() {
      return undefined;
    },
    async readScreen() {
      return undefined;
    },
    async send(id, text) {
      try {
        const result = await session.callTool(
          "write_stdin",
          { session_id: sessions.get(id), chars: text, yield_time_ms: 400 },
          { timeoutMs: 15_000 },
        );
        return { wrote: !/No such session/.test(result.text), text: result.text };
      } catch {
        return { wrote: false, text: "(session is gone)" };
      }
    },
    async status(id) {
      const polled = await poll(id);
      return {
        status: polled.terminal ? "completed" : "running",
        exitCode: polled.exitCode,
        text: polled.text,
        ms: polled.ms,
      };
    },
    async statusAll() {
      const result = await session.callTool("list_sessions", {});
      return { status: "unknown", text: result.text, ms: result.ms };
    },
    async cancel(id) {
      try {
        const result = await session.callTool("kill_session", { session_id: sessions.get(id) }, { timeoutMs: 30_000 });
        return { text: result.text, supported: true };
      } catch (error) {
        return { text: String(error).slice(0, 160), supported: true };
      }
    },
    logPath(id) {
      return logs.get(id);
    },
  };
}

// ------------------------------------------------------------ pi-exec-command

export function createExecCommandImpl(session: BenchSession): Impl {
  const sessions = new Map<string, number>();
  // A command that finishes inside the exec_command call has no session to poll:
  // the call itself carries the whole result.
  const finished = new Map<string, { text: string; exitCode?: number }>();
  return {
    key: "exec-cmd",
    title: "pi-exec-command",
    session,
    caps: { ...NO_CAPS, inTurnAwait: true, stdin: true, pty: true },
    async start(command, options = {}) {
      const result = await session.callTool(
        "exec_command",
        { cmd: command, shell: "/bin/sh", tty: options.binding === "pty", yield_time_ms: 250 },
        { timeoutMs: 60_000 },
      );
      const structured = result.structured as { session_id?: number; exit_code?: number } | undefined;
      const sessionId = structured?.session_id;
      if (sessionId === undefined) {
        const id = `exec-done-${finished.size + 1}`;
        finished.set(id, { text: result.text, exitCode: structured?.exit_code });
        return { id, ms: result.ms, text: result.text };
      }
      const id = String(sessionId);
      sessions.set(id, sessionId);
      return { id, ms: result.ms, text: result.text };
    },
    async awaitAll(ids, timeoutMs) {
      let text = "";
      let ms = 0;
      const statuses: string[] = [];
      for (const id of ids) {
        const done = finished.get(id);
        if (done) {
          text += done.text;
          statuses.push("completed");
          continue;
        }
        const result = await session.callTool(
          "write_stdin",
          { session_id: sessions.get(id), yield_time_ms: Math.min(timeoutMs, 30_000) },
          { timeoutMs: timeoutMs + 10_000 },
        );
        ms += result.ms;
        text += result.text;
        const structured = result.structured as { exit_code?: number } | undefined;
        statuses.push(structured?.exit_code === undefined ? "running" : "completed");
      }
      return { ms, statuses, text };
    },
    async awaitReady() {
      return { ms: 0, ready: false, text: "" };
    },
    waitCompletionFor(ids, timeoutMs) {
      return waitForAnyNotification(session, ids, timeoutMs);
    },
    async readTail(id) {
      const done = finished.get(id);
      if (done) return { text: done.text, ms: 0, totalBytes: Buffer.byteLength(done.text, "utf8") };
      const result = await session.callTool("write_stdin", { session_id: sessions.get(id), yield_time_ms: 250 });
      return { text: result.text, ms: result.ms, totalBytes: Buffer.byteLength(result.text, "utf8") };
    },
    async readHead(id) {
      const done = finished.get(id);
      if (done) return { text: done.text, ms: 0, totalBytes: Buffer.byteLength(done.text, "utf8") };
      const result = await session.callTool("write_stdin", { session_id: sessions.get(id), yield_time_ms: 250 });
      return { text: result.text, ms: result.ms, totalBytes: Buffer.byteLength(result.text, "utf8") };
    },
    async readGrep() {
      return undefined;
    },
    async readScreen() {
      return undefined;
    },
    async send(id, text) {
      const result = await session.callTool(
        "write_stdin",
        { session_id: sessions.get(id), chars: text, yield_time_ms: 400 },
        { timeoutMs: 15_000 },
      );
      return { wrote: true, text: result.text };
    },
    async status(id) {
      const done = finished.get(id);
      if (done) return { status: "completed", exitCode: done.exitCode, text: done.text, ms: 0 };
      const result = await session.callTool("write_stdin", { session_id: sessions.get(id), yield_time_ms: 250 });
      const structured = result.structured as { exit_code?: number } | undefined;
      return {
        status: structured?.exit_code === undefined ? "running" : "completed",
        exitCode: structured?.exit_code,
        text: result.text,
        ms: result.ms,
      };
    },
    async statusAll() {
      return { status: "unknown", text: "(no listing tool)", ms: 0 };
    },
    async cancel() {
      // pi-exec-command registers no kill tool: a runaway pipe cannot be stopped.
      return { text: "(no cancel tool)", supported: false };
    },
    logPath() {
      return undefined;
    },
  };
}

// ------------------------------------------------------------- bash (baseline)

/**
 * Pi's built-in bash tool, as the status quo every extension is measured
 * against. It has no handle, no background execution and no log, so a start
 * blocks until the command finishes and every later call is derived from the
 * one result that came back.
 */
export function createBashImpl(session: BenchSession): Impl {
  const results = new Map<string, { text: string; exitCode?: number }>();
  // The built-in tool is not an extension tool, so it is not in the session's
  // registered-tool map. It is instantiated from the same factory Pi uses.
  const tool = createBashTool(session.cwd);
  let counter = 0;
  return {
    key: "bash",
    title: "Pi built-in bash",
    session,
    caps: { ...NO_CAPS },
    async start(command) {
      const started = performance.now();
      const result = await tool.execute(
        `bench-bash-${Math.random().toString(36).slice(2)}`,
        { command, timeout: 300_000 },
        undefined,
        undefined,
      );
      const ms = performance.now() - started;
      const text = ((result?.content ?? []) as { type?: string; text?: string }[])
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("\n");
      const structured = result?.structuredContent as { exit_code?: number } | undefined;
      counter += 1;
      const id = `bash-${counter}`;
      results.set(id, { text, exitCode: structured?.exit_code });
      return { id, ms, text };
    },
    async awaitAll(ids) {
      // The blocking call already delivered the output; a second copy would be
      // context the agent never had to pay for.
      return { ms: 0, statuses: ids.map(() => "completed"), text: "" };
    },
    async awaitReady() {
      return { ms: 0, ready: false, text: "" };
    },
    async waitCompletionFor(ids, timeoutMs) {
      // The call already returned; there is nothing to wait for.
      return { ms: 0, matched: ids.length, text: ids.map((id) => results.get(id)?.text ?? "").join("") };
    },
    async readTail(id) {
      const text = results.get(id)?.text ?? "";
      return { text, ms: 0, totalBytes: Buffer.byteLength(text, "utf8") };
    },
    async readHead() {
      // There is no separate head read: the one result was already delivered.
      return { text: "", ms: 0, totalBytes: 0 };
    },
    async readGrep() {
      return undefined;
    },
    async readScreen() {
      return undefined;
    },
    async send() {
      return undefined;
    },
    async status(id) {
      const entry = results.get(id);
      // No status tool exists, and the call already blocked until the answer.
      return { status: entry ? "completed" : "unknown", exitCode: entry?.exitCode, text: "", ms: 0 };
    },
    async statusAll() {
      return { status: "unknown", text: "(no listing tool)", ms: 0 };
    },
    async cancel() {
      return { text: "(no cancel path: the call already blocked)", supported: false };
    },
    logPath() {
      return undefined;
    },
  };
}
