// SPDX-FileCopyrightText: 2026 Zhuocheng-Lang
// SPDX-License-Identifier: MPL-2.0

import type { ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  symlinkSync,
  watch,
  writeFileSync,
  writeSync,
  type FSWatcher,
} from "node:fs";
import { open, rename } from "node:fs/promises";
import { join } from "node:path";
import { fence, signalGroup, verifyGone } from "./containment.ts";
import {
  assertLinux,
  bootId,
  identityAlive,
  processIdentity,
  sleep,
  type ProcIdentity,
  type ProcessGroupRef,
} from "./identity.ts";
import {
  DEFAULT_MAX_LOG_BYTES,
  readLog,
  readScreenLog,
  type ReadOutcome,
} from "./log-manager.ts";
import {
  collectRegistryGarbage,
  DEFAULT_GC_MAX_RECORDS,
  DEFAULT_GC_RETENTION_MS,
  ensureRegistryDirs,
  execDirFor,
  logPathsFor,
  registryPaths,
  type RegistryPaths,
} from "./paths.ts";
import { readinessMarkerExists } from "./readiness.ts";
import { resolveShell, type ShellPolicy } from "./shell-policy.ts";
import {
  fifoPath,
  ptyLauncher,
  resolvePtySize,
  spawnPipe,
  spawnPty,
  writeWrapper,
} from "./spawn.ts";
import {
  isTerminal,
  type Binding,
  type CompletionRecord,
  type Scope,
  type ShellAwaitParams,
  type ShellAwaitResult,
  type ShellCancelParams,
  type ShellCancelResult,
  type ShellHandle,
  type ShellMeta,
  type ShellPromoteParams,
  type ShellReadParams,
  type ShellReadResult,
  type ShellSendParams,
  type ShellSendResult,
  type ShellStartParams,
  type ShellStatus,
  type ShellStatusResult,
} from "./types.ts";

export const DEFAULT_WAIT_MS = 30_000;
export const MAX_WAIT_MS = 50_000;
const GC_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_GRACE_MS = 3_000;
const MAX_ADOPT_ATTEMPTS = 5;

export interface RegistryOptions {
  cwd: string;
  sessionId: string;
  env?: NodeJS.ProcessEnv;
  maxLogBytes?: number;
  shell?: ShellPolicy;
  onSettle?: (handle: ShellHandle, record: CompletionRecord) => void;
  onReady?: (handle: ShellHandle) => void;
  onChange?: () => void;
  /** Diagnostics that must not be silent, such as an R2 coercion. */
  onDiagnostic?: (message: string, handle?: ShellHandle) => void;
}

interface Execution {
  handle: ShellHandle;
  meta: ShellMeta;
  tag: string;
  durable: boolean;
  child?: ChildProcess;
  identity?: ProcIdentity;
  identities: ProcIdentity[];
  cancelRequested: boolean;
  finalized: boolean;
  timeoutTimer?: NodeJS.Timeout;
  exitWatcher?: FSWatcher;
  exitPoll?: NodeJS.Timeout;
  logPoll?: NodeJS.Timeout;
  /** The control pipe whose EOF tells a supervisor that its owner is gone. */
  owner?: Writable;
}

type StreamName = "combined" | "stdout" | "stderr";

function now(): number {
  return Date.now();
}

function nextId(): string {
  return `sh_${randomBytes(4).toString("hex")}`;
}

function normalizeIds(ids: string | string[]): string[] {
  return Array.isArray(ids) ? ids : [ids];
}

function writeJsonAtomicSync(path: string, value: unknown): void {
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, JSON.stringify(value, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function readDeltaSync(path: string, offset: number): { text: string; nextOffset: number } {
  try {
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      if (size <= offset) return { text: "", nextOffset: offset };
      const length = Math.min(size - offset, 256 * 1024);
      const buffer = Buffer.allocUnsafe(length);
      const read = readSync(fd, buffer, 0, length, offset);
      return { text: buffer.subarray(0, read).toString("utf8"), nextOffset: offset + read };
    } finally {
      closeSync(fd);
    }
  } catch {
    return { text: "", nextOffset: offset };
  }
}

const KEY_BYTES: Record<string, string> = {
  enter: "\r",
  return: "\r",
  tab: "\t",
  escape: "\u001b",
  esc: "\u001b",
  space: " ",
  backspace: "\u007f",
  up: "\u001b[A",
  down: "\u001b[B",
  right: "\u001b[C",
  left: "\u001b[D",
  home: "\u001b[H",
  end: "\u001b[F",
  "ctrl c": "\u0003",
  "ctrl d": "\u0004",
  "ctrl z": "\u001a",
  "ctrl l": "\u000c",
  "ctrl a": "\u0001",
  "ctrl e": "\u0005",
};

export function keyToBytes(key: string): string {
  const normalized = key.trim().toLowerCase();
  if (KEY_BYTES[normalized]) return KEY_BYTES[normalized];
  if (normalized.length === 1) return key;
  return key;
}

export class ShellRegistry {
  readonly cwd: string;
  readonly sessionId: string;
  readonly paths: RegistryPaths;
  readonly shell: ShellPolicy;
  readonly maxLogBytes: number;
  readonly env: NodeJS.ProcessEnv;
  readonly options: RegistryOptions;

  private executions = new Map<string, Execution>();
  private listeners = new Set<() => void>();
  private closed = false;
  private workspaceOwned = false;
  private workspaceHolderPid?: number;
  private gcTimer?: NodeJS.Timeout;

  constructor(options: RegistryOptions) {
    assertLinux();
    this.options = options;
    this.cwd = options.cwd;
    this.sessionId = options.sessionId;
    this.env = options.env ?? process.env;
    this.shell = options.shell ?? resolveShell(this.env);
    this.maxLogBytes = options.maxLogBytes ?? Number(this.env.PI_ASYNC_SHELL_MAX_LOG_BYTES ?? DEFAULT_MAX_LOG_BYTES);
    this.paths = registryPaths(this.cwd, this.sessionId, process.pid);
    ensureRegistryDirs(this.paths);
    this.collectGarbage();
    this.gcTimer = setInterval(() => this.collectGarbage(), GC_INTERVAL_MS);
    this.gcTimer.unref?.();
  }

  private collectGarbage(): void {
    try {
      collectRegistryGarbage(this.paths, {
        retentionMs: Number(this.env.PI_ASYNC_SHELL_GC_RETENTION_MS ?? DEFAULT_GC_RETENTION_MS),
        maxTerminalRecords: Number(this.env.PI_ASYNC_SHELL_GC_MAX_RECORDS ?? DEFAULT_GC_MAX_RECORDS),
        protectedIds: new Set([...this.executions.keys()]),
      });
    } catch (error) {
      this.options.onDiagnostic?.("registry GC failed: " + (error as Error).message);
    }
  }

  // ---------------------------------------------------------------- lifecycle

  get handles(): ShellHandle[] {
    return [...this.executions.values()].map((exec) => ({ ...exec.handle }));
  }

  get(id: string): ShellHandle | undefined {
    const exec = this.executions.get(id);
    if (exec) return { ...exec.handle };
    return this.readMeta(id)?.handle;
  }

  private emit(): void {
    this.options.onChange?.();
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        /* a broken listener must not break the registry */
      }
    }
  }

  private subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // -------------------------------------------------------------------- start

  async start(params: ShellStartParams): Promise<ShellHandle> {
    if (this.closed) throw new Error("registry is closed");
    if (!params.command || !params.command.trim()) throw new Error("shell_start requires a command");

    const scope: Scope = params.scope ?? "session";
    if (scope !== "session" && scope !== "workspace") {
      throw new Error("shell_start scope must be session or workspace");
    }
    const binding: Binding = params.binding ?? "pipe";

    if (params.request) {
      const replay = this.findRequest(params.request);
      if (replay) return replay;
    }

    const id = nextId();
    const dir = execDirFor(this.paths, scope, id);
    mkdirSync(dir, { recursive: true });
    const log = logPathsFor(dir, binding);
    const startedAt = now();
    const name = params.name?.trim() || defaultName(params.command);
    const durable = scope === "workspace";

    const handle: ShellHandle = {
      id,
      name,
      command: params.command,
      cwd: params.cwd ?? this.cwd,
      scope,
      binding,
      status: "starting",
      startedAt,
      log,
      bytes: { stdout: 0, stderr: 0, combined: 0, capReached: false },
      consumedByAwait: false,
      notifyOnCompletion: params.notifyOnCompletion ?? scope !== "workspace",
      triggerOnCompletion: params.triggerOnCompletion ?? true,
      delivery: params.delivery ?? "steer",
      timeoutSeconds: params.timeoutSeconds,
    };

    const meta: ShellMeta = {
      ...handle,
      version: 1,
      durable,
      request: params.request,
      adoptAttempts: 0,
      createdAt: startedAt,
      updatedAt: startedAt,
    };
    // The intent record is written and fsynced before the effect (C8).
    writeJsonAtomicSync(join(dir, "meta.json"), meta);
    if (params.request) this.writeRequestRecord(params.request, id);

    const exec: Execution = {
      handle,
      meta,
      tag: id,
      durable,
      identities: [],
      cancelRequested: false,
      finalized: false,
    };
    this.executions.set(id, exec);

    try {
      if (binding === "pipe") await this.startPipe(exec, params, durable);
      else await this.startPty(exec, params, durable);
    } catch (error) {
      await this.finalize(exec, "failed", { error: (error as Error).message });
      throw error;
    }

    exec.handle.status = "running";
    exec.meta.status = "running";
    exec.meta.pid = exec.handle.pid;
    exec.meta.pgid = exec.handle.pgid;
    exec.meta.identity = exec.identity;
    // The intent record was fsynced before the effect (C8). This update only
    // refines it with the pid, so it does not need a second fsync on the
    // admission path; a crash here leaves a record the liveness check classifies.
    await this.persist(exec, { sync: false });

    if (params.timeoutSeconds && params.timeoutSeconds > 0) {
      exec.timeoutTimer = setTimeout(() => {
        void this.enforceTimeout(exec);
      }, params.timeoutSeconds * 1000);
      exec.timeoutTimer.unref?.();
    }
    this.emit();
    return { ...exec.handle };
  }

  private async startPipe(exec: Execution, params: ShellStartParams, durable: boolean): Promise<void> {
    const ctx = {
      id: exec.handle.id,
      command: params.command,
      cwd: params.cwd ?? this.cwd,
      env: this.env,
      envOverrides: params.env,
      shell: this.shell.shell,
      dir: exec.handle.log.dir,
      combinedPath: exec.handle.log.combined,
      maxLogBytes: this.maxLogBytes,
    };
    const spawned = spawnPipe(ctx, durable);
    exec.child = spawned.child;
    exec.owner = spawned.owner;
    exec.durable = durable;
    exec.handle.pid = spawned.child.pid;
    if (spawned.child.pid) {
      exec.identity = processIdentity(spawned.child.pid);
      if (exec.identity) exec.identities.push(exec.identity);
      exec.handle.pgid = exec.identity?.pgid;
    }
    exec.meta.identity = exec.identity;
    spawned.child.on("error", (error) => {
      void this.finalize(exec, "failed", { error: error.message });
    });
    this.watchExitRecord(exec);
    this.startLogPoll(exec, 250);
  }

  /**
   * `pty` at every scope. The wrapper detaches, `script(1)` holds the PTY, the
   * recording goes straight to the log file, and stdin is a FIFO. Nothing in the
   * data path belongs to this process, so the execution survives Pi (R2).
   *
   * A non-workspace execution must still die with its owner, so it is given a
   * pipe whose EOF means "Pi is gone"; a workspace execution is adopted instead
   * and gets no such pipe.
   */
  private async startPty(exec: Execution, params: ShellStartParams, durable: boolean): Promise<void> {
    const dir = exec.handle.log.dir;
    const size = resolvePtySize(this.env);
    // The size is decided here because nothing inside the PTY can discover it:
    // stdin is a FIFO, so the kernel gives the slave no size at all.
    writeFileSync(join(dir, "pty-size"), `${size.rows} ${size.cols}\n`);
    writeWrapper(dir, "pty-launcher.sh", ptyLauncher(this.shell.shell, params.command, size));
    const ctx = {
      id: exec.handle.id,
      command: params.command,
      cwd: params.cwd ?? this.cwd,
      env: this.env,
      envOverrides: params.env,
      shell: this.shell.shell,
      dir,
      combinedPath: exec.handle.log.combined,
    };
    const spawned = spawnPty(ctx, { watch: !durable });
    exec.child = spawned.child;
    exec.owner = spawned.owner;
    exec.handle.pid = spawned.child.pid;
    if (spawned.child.pid) {
      exec.identity = processIdentity(spawned.child.pid);
      if (exec.identity) exec.identities.push(exec.identity);
      exec.handle.pgid = exec.identity?.pgid;
    }
    spawned.child.on("error", (error) => {
      void this.finalize(exec, "failed", { error: error.message });
    });
    // The bytes land in the file, not in a pipe we hold, so there is no data
    // event to subscribe to. The exit record is the durable half of completion.
    this.watchExitRecord(exec);
    this.startLogPoll(exec, 250);
  }

  private observeReady(exec: Execution): void {
    if (!exec.handle.readyAt && readinessMarkerExists(exec.handle.log.dir)) this.markReady(exec);
  }


  private markReady(exec: Execution): void {
    if (exec.handle.readyAt || isTerminal(exec.handle.status)) return;
    exec.handle.readyAt = now();
    exec.meta.readyAt = exec.handle.readyAt;
    void this.persist(exec);
    this.options.onReady?.({ ...exec.handle });
    this.emit();
  }

  private statusForExit(exec: Execution, code: number | null, signal: string | null): ShellStatus {
    if (exec.handle.status === "timed-out") return "timed-out";
    if (exec.cancelRequested) return "cancelled";
    if (code === 0 && !signal) return "completed";
    return "failed";
  }

  private async enforceTimeout(exec: Execution): Promise<void> {
    if (isTerminal(exec.handle.status)) return;
    exec.handle.status = "timed-out";
    exec.meta.status = "timed-out";
    exec.cancelRequested = true;
    await this.graceful(exec);
    const settled = await this.waitForSettle(exec, DEFAULT_GRACE_MS);
    if (!settled) await this.forceKill(exec);
    let verify = await verifyGone(exec.tag, exec.identities, this.groupsOf(exec));
    if (!verify.gone) {
      await this.forceKill(exec);
      verify = await verifyGone(exec.tag, exec.identities, this.groupsOf(exec));
    }
    await this.finalize(exec, "timed-out", {
      error: verify.gone ? undefined : `descendant leak after timeout: ${verify.remaining.join(", ")}`,
    });
  }

  // ----------------------------------------------------------------- finalize

  private async finalize(
    exec: Execution,
    status: ShellStatus,
    detail: { exitCode?: number | null; signal?: string | null; error?: string } = {},
  ): Promise<void> {
    if (exec.finalized) return;
    exec.finalized = true;
    if (exec.timeoutTimer) clearTimeout(exec.timeoutTimer);
    exec.exitWatcher?.close();
    if (exec.exitPoll) clearInterval(exec.exitPoll);
    if (exec.logPoll) clearInterval(exec.logPoll);
    // Closing the owner pipe tells either supervisor that its owner is gone.
    exec.owner?.end();
    exec.owner = undefined;

    exec.handle.status = status;
    exec.handle.endedAt = exec.handle.endedAt ?? now();
    if (detail.exitCode !== undefined) exec.handle.exitCode = detail.exitCode;
    if (detail.signal !== undefined) exec.handle.signal = detail.signal;
    if (detail.error) exec.handle.error = detail.error;
    exec.meta.status = status;
    exec.meta.endedAt = exec.handle.endedAt;
    exec.meta.exitCode = exec.handle.exitCode ?? null;
    exec.meta.signal = exec.handle.signal ?? null;
    exec.meta.error = exec.handle.error;

    this.refreshBytesFromFiles(exec);

    // The exit record is the durable half of completion; write it even when the
    // process was reaped by us, so a later Pi process can classify the record.
    const exitPath = join(exec.handle.log.dir, "exit.json");
    if (!existsSync(exitPath)) {
      try {
        writeJsonAtomicSync(exitPath, {
          exitCode: exec.handle.exitCode ?? null,
          endedAt: exec.handle.endedAt,
          status,
          signal: exec.handle.signal ?? null,
        });
      } catch {
        /* the sealed meta record still carries the outcome */
      }
    }

    const record: CompletionRecord = {
      id: exec.handle.id,
      name: exec.handle.name,
      status,
      exitCode: exec.handle.exitCode ?? null,
      signal: exec.handle.signal ?? null,
      scope: exec.handle.scope,
      binding: exec.handle.binding,
      startedAt: exec.handle.startedAt,
      endedAt: exec.handle.endedAt ?? now(),
      durationMs: (exec.handle.endedAt ?? now()) - exec.handle.startedAt,
      log: exec.handle.log,
      bytes: exec.handle.bytes,
      error: exec.handle.error,
      triggerOnCompletion: exec.handle.triggerOnCompletion,
      delivery: exec.handle.delivery,
    };
    try {
      writeJsonAtomicSync(join(exec.handle.log.dir, "completion.json"), record);
    } catch {
      /* ignore */
    }

    await this.persist(exec);
    this.options.onSettle?.({ ...exec.handle }, record);
    this.emit();
  }

  private refreshBytesFromFiles(exec: Execution): void {
    const combined = sizeOf(exec.handle.log.combined);
    exec.handle.bytes = {
      stdout: sizeOf(exec.handle.log.stdout),
      stderr: sizeOf(exec.handle.log.stderr),
      combined,
      capReached: existsSync(join(exec.handle.log.dir, "log-cap.json")),
    };
    exec.meta.bytes = exec.handle.bytes;
  }

  private async persist(exec: Execution, options: { sync?: boolean } = {}): Promise<void> {
    exec.meta.updatedAt = now();
    exec.meta.bytes = exec.handle.bytes;
    exec.meta.readyAt = exec.handle.readyAt;
    exec.meta.identity = exec.identity;
    await writeJsonAtomic(join(exec.handle.log.dir, "meta.json"), exec.meta, options.sync !== false);
  }

  // -------------------------------------------------------------------- await

  async awaitHandles(params: ShellAwaitParams, signal?: AbortSignal): Promise<ShellAwaitResult> {
    const ids = normalizeIds(params.ids);
    const execs = ids.map((id) => this.requireExecution(id));
    const mode = params.mode ?? "all";
    const until = params.until ?? { kind: "exit" };
    const waitMs = Math.max(0, Math.min(MAX_WAIT_MS, params.waitMs ?? DEFAULT_WAIT_MS));
    const includePreview = params.includeOutputPreview !== false;

    const satisfied = new Map<string, { line?: string; byteOffset?: number }>();
    const patternState = new Map<
      string,
      { regex: RegExp; stream: StreamName | "ptyView"; offset: number; carry: string }
    >();

    if (until.kind === "pattern") {
      for (const exec of execs) {
        let regex: RegExp;
        try {
          regex = new RegExp(until.regex);
        } catch (error) {
          throw new Error(`invalid await pattern: ${(error as Error).message}`);
        }
        const stream = until.stream ?? "combined";
        const path = this.streamPath(exec, stream);
        let offset = 0;
        if (until.since === "now") offset = sizeOf(path);
        else if (typeof until.since === "number") offset = until.since;
        patternState.set(exec.handle.id, { regex, stream, offset, carry: "" });
      }
    }

    const check = (exec: Execution): boolean => {
      const id = exec.handle.id;
      if (satisfied.has(id)) return true;
      if (until.kind === "ready") {
        this.observeReady(exec);
        if (exec.handle.readyAt || exec.finalized) {
          satisfied.set(id, {});
          return true;
        }
        return false;
      }
      if (until.kind === "pattern") {
        const state = patternState.get(id);
        if (!state) return false;
        const path = this.streamPath(exec, state.stream);
        const delta = readDeltaSync(path, state.offset);
        const available = delta.text;
        const nextOffset = delta.nextOffset;
        if (available.length > 0) {
          const base = state.offset - Buffer.byteLength(state.carry, "utf8");
          state.offset = nextOffset;
          const text = state.carry + available;
          const lines = text.split("\n");
          // The last element may be a partial line; keep it for the next chunk.
          state.carry = lines.pop() ?? "";
          let cursor = base;
          for (const rawLine of lines) {
            const line = rawLine.replace(/\r$/, "");
            if (line && state.regex.test(line)) {
              satisfied.set(id, { line, byteOffset: cursor });
              return true;
            }
            cursor += Buffer.byteLength(rawLine, "utf8") + 1;
          }
        }
        // Prompts commonly end without a newline. The current tail is still
        // output, so it can satisfy a pattern while the process keeps running.
        const tail = state.carry.replace(/\r$/, "");
        if (tail && state.regex.test(tail)) {
          satisfied.set(id, {
            line: tail,
            byteOffset: state.offset - Buffer.byteLength(state.carry, "utf8"),
          });
          return true;
        }
        if (exec.finalized) {
          satisfied.set(id, {});
          return true;
        }
        return false;
      }
      if (exec.finalized) {
        satisfied.set(id, {});
        return true;
      }
      return false;
    };

    return await new Promise<ShellAwaitResult>((resolve) => {
      let done = false;
      const finish = (timedOutWaiting: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsubscribe();
        signal?.removeEventListener("abort", onAbort);
        const outcomes: ShellHandle[] = [];
        const stillRunning: ShellHandle[] = [];
        for (const exec of execs) {
          if (exec.finalized) {
            outcomes.push({ ...exec.handle });
            exec.handle.consumedByAwait = true;
            exec.meta.consumedByAwait = true;
            void this.persist(exec);
          } else {
            stillRunning.push({ ...exec.handle });
          }
        }
        let matched: ShellAwaitResult["matched"];
        for (const [id, value] of satisfied) {
          if (value.line !== undefined) {
            matched = { id, line: value.line, byteOffset: value.byteOffset ?? 0 };
            break;
          }
        }
        resolve({
          settled: outcomes.length === execs.length,
          timedOutWaiting,
          matched,
          outcomes,
          stillRunning,
        });
      };

      const evaluate = () => {
        if (done) return;
        for (const exec of execs) check(exec);
        const allSatisfied =
          mode === "all" ? execs.every((exec) => satisfied.has(exec.handle.id)) : satisfied.size > 0;
        if (allSatisfied) finish(false);
      };

      const onAbort = () => {
        // Aborting a wait detaches the waiter only. It never enters the
        // cancellation ladder: cancelling a consumer is not cancelling a producer.
        finish(true);
      };

      const unsubscribe = this.subscribe(evaluate);
      const timer = setTimeout(() => finish(true), waitMs);
      timer.unref?.();
      if (signal) {
        if (signal.aborted) {
          finish(true);
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      evaluate();
      void includePreview;
    });
  }

  // --------------------------------------------------------------------- read

  async read(params: ShellReadParams, signal?: AbortSignal): Promise<ShellReadResult> {
    if (signal?.aborted) throw new Error("shell_read aborted before opening the log");
    const exec = this.executions.get(params.id);
    const handle = exec?.handle ?? this.readMeta(params.id)?.handle;
    if (!handle) throw new Error(`unknown handle: ${params.id}`);
    let stream = params.stream ?? "combined";
    let note: string | undefined;

    if (stream === "ptyView" && handle.log.ptyView) {
      // A terminal recording is replayed into a viewport: the caller asked what
      // is on the screen, not which bytes the program wrote to get there.
      const outcome = await readScreenLog(handle.log.ptyView, params, readScreenSize(handle.log.dir));
      return {
        id: handle.id,
        status: handle.status,
        stream: "ptyView",
        text: outcome.text,
        truncated: outcome.truncated,
        totalLines: outcome.totalLines,
        totalBytes: outcome.totalBytes,
        range: outcome.range,
        fullLogPath: handle.log.ptyView,
        note: outcome.note,
      };
    }
    if (stream === "ptyView") {
      stream = "combined";
      note = "this binding has no terminal view; returning combined";
    }
    if (handle.binding !== "pipe" && stream === "stderr" && sizeOf(handle.log.stderr) === 0) {
      note = "stderr is merged into the PTY stream for this binding";
    }
    if (handle.scope === "workspace" && handle.binding === "pipe" && (stream === "stdout" || stream === "stderr")) {
      const own = sizeOf(stream === "stdout" ? handle.log.stdout : handle.log.stderr);
      if (own === 0) {
        note = "workspace pipe binds both streams to combined.log; returning combined";
        stream = "combined";
      }
    }

    const path = this.streamPathFromHandle(handle, stream);
    if (signal?.aborted) throw new Error("shell_read aborted before opening the log");
    const outcome: ReadOutcome = await readLog(path, { ...params, stream });
    return {
      id: handle.id,
      status: handle.status,
      stream,
      text: outcome.text,
      truncated: outcome.truncated,
      totalLines: outcome.totalLines,
      totalBytes: outcome.totalBytes,
      range: outcome.range,
      fullLogPath: path,
      note: note ?? outcome.note,
    };
  }

  private streamPath(exec: Execution, stream: string): string {
    return this.streamPathFromHandle(exec.handle, stream);
  }

  private streamPathFromHandle(handle: ShellHandle, stream: string): string {
    switch (stream) {
      case "stdout":
        return handle.log.stdout;
      case "stderr":
        return handle.log.stderr;
      case "ptyView":
        return handle.log.ptyView ?? handle.log.combined;
      default:
        return handle.log.combined;
    }
  }

  // ------------------------------------------------------------------- cancel

  async cancel(params: ShellCancelParams): Promise<ShellCancelResult[]> {
    const ids = normalizeIds(params.ids);
    const results: ShellCancelResult[] = [];
    for (const id of ids) {
      const exec = this.executions.get(id);
      if (!exec) {
        const meta = this.readMeta(id);
        if (meta) {
          results.push({
            id,
            status: meta.handle.status,
            verifiedGone: true,
            note: "not owned by this process; nothing to cancel",
          });
          continue;
        }
        throw new Error(`unknown handle: ${id}`);
      }
      if (isTerminal(exec.handle.status)) {
        results.push({ id, status: exec.handle.status, verifiedGone: true });
        continue;
      }
      exec.cancelRequested = true;
      const ladder = params.ladder ?? "graceful";
      if (ladder === "graceful") {
        await this.graceful(exec);
        const settled = await this.waitForSettle(exec, params.graceMs ?? DEFAULT_GRACE_MS);
        if (!settled) await this.forceKill(exec);
      } else {
        await this.forceKill(exec);
      }
      let verify = await verifyGone(exec.tag, exec.identities, this.groupsOf(exec));
      if (!verify.gone) {
        await this.forceKill(exec);
        verify = await verifyGone(exec.tag, exec.identities, this.groupsOf(exec));
      }
      if (!isTerminal(exec.handle.status)) {
        await this.finalize(exec, verify.gone ? "cancelled" : "failed", {
          error: verify.gone ? undefined : `descendant leak: ${verify.remaining.join(", ")}`,
        });
      }
      results.push({
        id,
        status: exec.handle.status,
        verifiedGone: verify.gone,
        leaked: verify.gone ? undefined : verify.remaining,
        note: verify.gone ? undefined : "cancellation could not prove the tree is gone",
      });
    }
    return results;
  }

  private async graceful(exec: Execution): Promise<void> {
    // A terminal binding gets the interrupt a human would type. It reaches the
    // child through the PTY line discipline, which is the only path that also
    // works when a later Pi process owns the execution.
    if (exec.handle.binding === "pty" && (await writeFifo(fifoPath(exec.handle.log.dir), "\u0003"))) return;
    signalGroup(exec.handle.pgid, "SIGTERM");
  }

  /**
   * The process groups this execution owns, bounded by the leader's start time.
   * The group is the detached wrapper, so it can reach neither Pi's group nor a
   * stranger's reused id.
   */
  private groupsOf(exec: Execution): ProcessGroupRef[] {
    if (!exec.handle.pgid) return [];
    return [{ pgid: exec.handle.pgid, since: exec.identities[0]?.start ?? 0 }];
  }

  private async forceKill(exec: Execution): Promise<void> {
    signalGroup(exec.handle.pgid, "SIGKILL");
    await fence({
      tag: exec.tag,
      identities: exec.identities,
      groups: this.groupsOf(exec),
      deadlineMs: 5000,
    });
  }

  private waitForSettle(exec: Execution, ms: number): Promise<boolean> {
    if (exec.finalized) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (value: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(value);
      };
      const unsubscribe = this.subscribe(() => {
        if (exec.finalized) finish(true);
      });
      const timer = setTimeout(() => finish(exec.finalized), ms);
      timer.unref?.();
    });
  }

  // ------------------------------------------------------------------ promote

  async promote(params: ShellPromoteParams): Promise<ShellHandle> {
    const exec = this.requireExecution(params.id);
    if (isTerminal(exec.handle.status)) throw new Error("cannot promote a settled execution");
    if (params.to === "session") {
      if (exec.handle.scope === "workspace") {
        throw new Error("promotion is one-directional: a workspace execution cannot narrow to session");
      }
      exec.handle.scope = "session";
      exec.meta.scope = "session";
      await this.persist(exec);
      this.emit();
      return { ...exec.handle };
    }

    if (exec.handle.scope === "workspace") return { ...exec.handle };
    exec.handle.scope = "workspace";
    exec.meta.scope = "workspace";
    exec.durable = true;
    exec.meta.durable = true;
    // Both bindings use an owner watch. Promotion releases that watch without
    // respawning the command or changing its log files.
    this.releaseOwnerWatch(exec);
    if (params.adopterNotification !== undefined) {
      exec.handle.notifyOnCompletion = params.adopterNotification;
      exec.meta.notifyOnCompletion = params.adopterNotification;
    }
    // The record must be visible to the workspace adoption scan without moving
    // the directory the child is already writing into.
    const link = join(this.paths.workspaceDir, exec.handle.id);
    if (!existsSync(link)) {
      try {
        symlinkSync(exec.handle.log.dir, link, "dir");
      } catch {
        /* adoption also scans session directories for workspace records */
      }
    }
    await this.persist(exec);
    this.emit();
    return { ...exec.handle };
  }

  /**
   * Hand an execution over to the workspace. The supervisor's watchdog reads one
   * line from the owner pipe: "release" means the PTY keeps running, EOF means
   * the owner died and the PTY must be torn down. Nothing else can tell those
   * two events apart, so the release is explicit.
   */
  private releaseOwnerWatch(exec: Execution): void {
    const owner = exec.owner;
    if (!owner) return;
    try {
      owner.end("release\n");
    } catch {
      /* the wrapper is already gone; the execution is settling anyway */
    }
    exec.owner = undefined;
  }

  // --------------------------------------------------------------------- send

  async send(params: ShellSendParams): Promise<ShellSendResult> {
    const exec = this.requireExecution(params.id);
    if (exec.handle.binding === "pipe") {
      throw new Error("shell_send refuses on pipe: there is no terminal and no stdin");
    }
    if (isTerminal(exec.handle.status)) throw new Error("execution has settled");
    if (params.request) {
      const replay = this.readRequestRecord(params.request);
      if (replay) {
        // A second answer is a second keystroke. Return the first result instead.
        return { id: exec.handle.id, wrote: false };
      }
    }
    // A pty's stdin is a FIFO, so the write does not need this process to own
    // the execution: it works from a Pi that adopted the handle after a restart.
    const fifo = fifoPath(exec.handle.log.dir);
    let wrote = true;
    if (params.text) wrote = (await writeFifo(fifo, params.text)) && wrote;
    for (const key of params.keys ?? []) {
      wrote = (await writeFifo(fifo, keyToBytes(key))) && wrote;
    }
    await sleep(Math.max(0, Math.min(10_000, params.settleMs ?? 500)));
    if (params.request) this.writeRequestRecord(params.request, params.id, "send");
    let screen: string | undefined;
    try {
      const view = await this.read({ id: params.id, stream: "ptyView", mode: "tail", lines: 80 });
      screen = view.text;
    } catch {
      /* the screen is a convenience, not the contract */
    }
    return { id: params.id, wrote, screen };
  }

  // ------------------------------------------------------------------- status

  status(params?: { id?: string }): ShellStatusResult {
    let handles: ShellHandle[];
    if (params?.id) {
      const handle = this.get(params.id);
      handles = handle ? [handle] : [];
    } else {
      handles = [...this.handles, ...this.workspaceRecords()];
    }
    return {
      handles,
      running: handles.filter((handle) => handle.status === "running" || handle.status === "starting").length,
      ready: handles.filter((handle) => Boolean(handle.readyAt)).length,
      workspaceOwner: this.workspaceOwned,
    };
  }

  /**
   * Completion records that settled while no Pi process was watching. Each one
   * is surfaced once: a marker file records that it has been delivered.
   */
  workspaceCompletions(): CompletionRecord[] {
    // Surfacing writes a marker, so only the writer does it (C10).
    if (!this.workspaceOwned) return [];
    const out: CompletionRecord[] = [];
    for (const record of this.scanWorkspaceRecords()) {
      const { dir, meta } = record;
      if (meta.notifyOnCompletion === false) continue;
      const completionPath = join(dir, "completion.json");
      const surfacedPath = join(dir, ".surfaced");
      if (existsSync(surfacedPath)) continue;
      const completion = readJson<CompletionRecord>(completionPath);
      if (!completion) continue;
      out.push(completion);
      try {
        writeJsonAtomicSync(surfacedPath, { surfacedAt: now(), by: process.pid });
      } catch {
        /* the record stays on disk */
      }
    }
    return out;
  }

  private workspaceRecords(): ShellHandle[] {
    const out: ShellHandle[] = [];
    for (const record of this.scanWorkspaceRecords()) {
      if (this.executions.has(record.handle.id)) continue;
      out.push(record.handle);
    }
    return out;
  }

  // -------------------------------------------------------------- turn scope

  // ------------------------------------------------------- workspace adoption

  setWorkspaceOwner(owned: boolean, holderPid?: number): void {
    this.workspaceOwned = owned;
    this.workspaceHolderPid = holderPid;
  }

  get workspaceOwnerPid(): number | undefined {
    return this.workspaceHolderPid;
  }

  private scanWorkspaceRecords(): { handle: ShellHandle; dir: string; meta: ShellMeta }[] {
    const records: { handle: ShellHandle; dir: string; meta: ShellMeta }[] = [];
    const seen = new Set<string>();
    const add = (dir: string) => {
      const meta = readJson<ShellMeta>(join(dir, "meta.json"));
      if (!meta || meta.version !== 1) return;
      if (seen.has(meta.id)) return;
      seen.add(meta.id);
      records.push({ handle: metaToHandle(meta), dir, meta });
    };
    for (const entry of safeReaddir(this.paths.workspaceDir)) {
      if (entry.startsWith(".")) continue;
      add(join(this.paths.workspaceDir, entry));
    }
    // Promoted handles keep their directory under sessions/ and link into
    // workspace/. Scan session records too, so a promotion is never invisible.
    for (const session of safeReaddir(join(this.paths.root, "sessions"))) {
      for (const entry of safeReaddir(join(this.paths.root, "sessions", session))) {
        const dir = join(this.paths.root, "sessions", session, entry);
        const meta = readJson<ShellMeta>(join(dir, "meta.json"));
        if (meta?.scope === "workspace") add(dir);
      }
    }
    return records;
  }

  async adoptWorkspace(): Promise<{ adopted: string[]; lost: string[]; finalized: string[] }> {
    if (!this.workspaceOwned) {
      // C10: a process that cannot take the writer lock never becomes an owner
      // by accident. It may still read status and logs.
      return { adopted: [], lost: [], finalized: [] };
    }
    const adopted: string[] = [];
    const lost: string[] = [];
    const finalized: string[] = [];
    for (const record of this.scanWorkspaceRecords()) {
      const { handle, dir, meta } = record;
      if (this.executions.has(handle.id)) continue;
      if (isTerminal(handle.status)) continue;

      const exit = readJson<{ exitCode?: number | null; endedAt?: number; status?: ShellStatus }>(
        join(dir, "exit.json"),
      );
      if (exit) {
        const status: ShellStatus =
          exit.status ??
          (exit.exitCode === 0 ? "completed" : exit.exitCode === null ? "lost" : "failed");
        const exec = this.restoreExecution(handle, meta, dir);
        await this.finalize(exec, status, { exitCode: exit.exitCode ?? null });
        finalized.push(handle.id);
        continue;
      }

      meta.adoptAttempts = (meta.adoptAttempts ?? 0) + 1;
      if (meta.adoptAttempts > MAX_ADOPT_ATTEMPTS) {
        const exec = this.restoreExecution(handle, meta, dir);
        await this.finalize(exec, "lost", { error: "restart limit exceeded while re-adopting" });
        lost.push(handle.id);
        continue;
      }

      let alive = false;
      if (meta.identity) alive = identityAlive(meta.identity);
      if (!alive) {
        // The child holding the log fd corroborates liveness even when /proc is
        // unreadable or the identity check is inconclusive.
        alive = await this.logIsAdvancing(handle);
      }

      if (!alive) {
        const exec = this.restoreExecution(handle, meta, dir);
        await this.finalize(exec, "lost", {
          error: "liveness could not be proven after a Pi restart",
        });
        lost.push(handle.id);
        continue;
      }

      const exec = this.restoreExecution(handle, meta, dir);
      exec.handle.status = "running";
      exec.meta.status = "running";
      await this.persist(exec);
      this.watchExitRecord(exec);
      this.startLogPoll(exec, 500);
      adopted.push(handle.id);
    }
    if (adopted.length > 0 || lost.length > 0 || finalized.length > 0) this.emit();
    return { adopted, lost, finalized };
  }

  private restoreExecution(handle: ShellHandle, meta: ShellMeta, dir: string): Execution {
    const exec: Execution = {
      handle: { ...handle },
      meta: { ...meta },
      tag: handle.id,
      durable: true,
      identities: meta.identity ? [meta.identity] : [],
      identity: meta.identity,
      cancelRequested: false,
      finalized: false,
    };
    this.executions.set(handle.id, exec);
    void dir;
    return exec;
  }

  private async logIsAdvancing(handle: ShellHandle): Promise<boolean> {
    const path = handle.log.combined;
    try {
      const first = statSync(path);
      await sleep(120);
      const second = statSync(path);
      return second.size > first.size || second.mtimeMs > first.mtimeMs;
    } catch {
      return false;
    }
  }

  private watchExitRecord(exec: Execution): void {
    const exitPath = join(exec.handle.log.dir, "exit.json");
    const pidPath = join(exec.handle.log.dir, "pid.json");
    const check = () => {
      if (exec.finalized) return;
      if (!exec.identity) {
        const pidRecord = readJson<{ pid: number; pgid: number; starttime: number }>(pidPath);
        if (pidRecord) {
          exec.handle.pid = pidRecord.pid;
          exec.handle.pgid = pidRecord.pgid;
          exec.identity = { bootId: bootId(), pid: pidRecord.pid, start: pidRecord.starttime };
          exec.identities.push(exec.identity);
          exec.meta.identity = exec.identity;
        }
      }
      this.refreshBytesFromFiles(exec);
      this.observeReady(exec);
      const exit = readJson<{
        exitCode?: number | null;
        endedAt?: number;
        status?: ShellStatus;
        signal?: string | null;
        error?: string;
      }>(exitPath);
      if (exit) {
        // The supervisor writes exit.json just before it exits. Do not let an
        // await or a cancellation ladder finish while that identity is live.
        if (exec.identity && identityAlive(exec.identity)) {
          this.emit();
          return;
        }
        const status = exit.status ?? this.statusForExit(exec, exit.exitCode ?? null, exit.signal ?? null);
        void this.finalize(exec, status, {
          exitCode: exit.exitCode ?? null,
          signal: exit.signal ?? null,
          error: exit.error,
        });
      } else {
        this.emit();
      }
    };
    try {
      exec.exitWatcher = watch(exec.handle.log.dir, () => check());
      exec.exitWatcher.on("error", () => undefined);
    } catch {
      /* the poll fallback is enough */
    }
    exec.exitPoll = setInterval(check, 250);
    exec.exitPoll.unref?.();
    check();
  }

  /**
   * A file-backed binding has no data event: the bytes reach the file without
   * passing through this process. The poll is what keeps the byte counts, the
   * readiness ring and the UI in step with a file only the child is writing.
   */
  private startLogPoll(exec: Execution, intervalMs: number): void {
    exec.logPoll = setInterval(() => {
      if (exec.finalized) return;
      this.refreshBytesFromFiles(exec);
      this.observeReady(exec);
      this.emit();
    }, intervalMs);
    exec.logPoll.unref?.();
  }

  // ----------------------------------------------------------------- shutdown

  async shutdown(reason: "quit" | "reload" | "new" | "resume" | "fork"): Promise<void> {
    if (this.closed) return;
    if (reason === "reload") return; // the handoff keeps everything alive
    this.closed = true;
    const ids = [...this.executions.values()]
      .filter((exec) => exec.handle.scope !== "workspace" && !isTerminal(exec.handle.status))
      .map((exec) => exec.handle.id);
    if (ids.length > 0) {
      await this.cancel({ ids, ladder: "graceful", graceMs: 1500 });
    }
    for (const exec of this.executions.values()) {
      exec.exitWatcher?.close();
      if (exec.exitPoll) clearInterval(exec.exitPoll);
      if (exec.logPoll) clearInterval(exec.logPoll);
      if (exec.timeoutTimer) clearTimeout(exec.timeoutTimer);
    }
    if (this.gcTimer) clearInterval(this.gcTimer);
    this.listeners.clear();
  }

  /** Called when a reload handoff is never claimed. */
  async abandonHandoff(): Promise<void> {
    // Workspace handles have no owner exit that fences them; they stay
    // adoptable. Only the in-process scopes follow the cancellation ladder.
    const ids = [...this.executions.values()]
      .filter((exec) => exec.handle.scope !== "workspace" && !isTerminal(exec.handle.status))
      .map((exec) => exec.handle.id);
    if (ids.length > 0) await this.cancel({ ids, ladder: "graceful", graceMs: 1000 });
    this.closed = true;
    if (this.gcTimer) clearInterval(this.gcTimer);
    this.listeners.clear();
  }

  /** Rebind callbacks after a /reload claim. */
  rebind(options: Partial<RegistryOptions>): void {
    Object.assign(this.options, options);
  }

  // ------------------------------------------------------------------ helpers

  requireExecution(id: string): Execution {
    const exec = this.executions.get(id);
    if (exec) return exec;
    const record = this.readMeta(id);
    if (record) {
      throw new Error(`handle ${id} is not owned by this Pi process (status: ${record.handle.status})`);
    }
    throw new Error(`unknown handle: ${id}`);
  }

  private readMeta(id: string): { handle: ShellHandle; meta: ShellMeta } | undefined {
    for (const record of this.scanWorkspaceRecords()) {
      if (record.handle.id === id) return { handle: record.handle, meta: record.meta };
    }
    const dir = join(this.paths.sessionDir, id);
    const meta = readJson<ShellMeta>(join(dir, "meta.json"));
    if (meta) return { handle: metaToHandle(meta), meta };
    return undefined;
  }

  private readRequestRecord(request: string): { id: string; kind?: string } | undefined {
    return readJson<{ id: string; kind?: string }>(
      join(this.paths.requestsDir, `${sanitizeRequest(request)}.json`),
    );
  }

  private findRequest(request: string): ShellHandle | undefined {
    const record = this.readRequestRecord(request);
    if (!record) return undefined;
    return this.get(record.id);
  }

  private writeRequestRecord(request: string, id: string, kind: "start" | "send" = "start"): void {
    const path = join(this.paths.requestsDir, `${sanitizeRequest(request)}.json`);
    if (existsSync(path)) return; // no-replace publication
    try {
      writeJsonAtomicSync(path, { id, request, kind, createdAt: now() });
    } catch {
      /* a replay record is best-effort; the handle id is still authoritative */
    }
  }
}

/**
 * Write to a pty execution's stdin FIFO.
 *
 * The open is non-blocking on purpose: a FIFO with no reader would otherwise
 * block this process forever, and "nobody is listening" is a fact the caller
 * needs, not a hang. A full pipe buffer is retried briefly, because the reader
 * on the other side drains continuously.
 */
async function writeFifo(path: string, text: string): Promise<boolean> {
  let fd: number;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_NONBLOCK);
  } catch {
    return false;
  }
  try {
    const buffer = Buffer.from(text, "utf8");
    let offset = 0;
    let stalls = 0;
    while (offset < buffer.length) {
      try {
        offset += writeSync(fd, buffer, offset, buffer.length - offset);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EAGAIN" || stalls++ > 200) return false;
        await sleep(5);
      }
    }
    return true;
  } finally {
    closeSync(fd);
  }
}

/** The PTY size the launcher recorded, so a replay uses the real width. */
function readScreenSize(dir: string): { cols?: number; rows?: number } {
  try {
    const [rows, cols] = readFileSync(join(dir, "pty-size"), "utf8").trim().split(/\s+/).map(Number);
    if (rows && cols && Number.isFinite(rows) && Number.isFinite(cols)) return { rows, cols };
  } catch {
    /* the screen model's defaults are the fallback */
  }
  return {};
}

function sanitizeRequest(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96);
}

function defaultName(command: string): string {
  const first = command.trim().split(/\s+/).slice(0, 3).join(" ");
  return first.length > 40 ? `${first.slice(0, 37)}...` : first;
}

function metaToHandle(meta: ShellMeta): ShellHandle {
  const { version, identity, durable, request, adoptAttempts, createdAt, updatedAt, ...handle } = meta;
  void version;
  void identity;
  void durable;
  void request;
  void adoptAttempts;
  void createdAt;
  void updatedAt;
  return handle;
}

function safeReaddir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

async function writeJsonAtomic(path: string, value: unknown, sync = true): Promise<void> {
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(JSON.stringify(value, null, 2));
    if (sync) await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
}
