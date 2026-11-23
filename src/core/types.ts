// SPDX-FileCopyrightText: 2026 Zhuocheng-Lang
// SPDX-License-Identifier: MPL-2.0

/**
 * The vocabulary of pi-async-shell, in code.
 *
 * Two axes stay separate on purpose: `scope` names the owner that must reap the
 * execution, and `binding` names where its bytes go. See docs/design/01-overview.md.
 */

export type Scope = "session" | "workspace";
export type Binding = "pipe" | "pty";
/**
 * When a completion reaches an agent that is still running. `steer` delivers it
 * before the next LLM call; `settle` holds it for the settle boundary, so the
 * current plan finishes first.
 */
export type Delivery = "steer" | "settle";

export type ShellStatus =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed-out"
  | "lost";

export const TERMINAL_STATUSES: readonly ShellStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "timed-out",
  "lost",
];

export function isTerminal(status: ShellStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export interface ShellStartParams {
  command: string;
  name?: string;
  cwd?: string;
  env?: Record<string, string>;
  scope?: Scope;
  binding?: Binding;
  /** Explicit values also restore a sensitive variable removed by the default filter. */
  timeoutSeconds?: number;
  notifyOnCompletion?: boolean;
  triggerOnCompletion?: boolean;
  /** How a completion reaches a running agent. Default "steer". */
  delivery?: Delivery;
  /** Caller-supplied replay key. Two starts with one request produce one execution. */
  request?: string;
}

export interface ShellAwaitParams {
  ids: string | string[];
  mode?: "all" | "any";
  until?:
    | { kind: "exit" }
    | { kind: "ready" }
    | {
        kind: "pattern";
        regex: string;
        stream?: "combined" | "stdout" | "stderr" | "ptyView";
        since?: number | "now";
      };
  waitMs?: number;
  includeOutputPreview?: boolean;
}

export interface ShellReadParams {
  id: string;
  stream?: "combined" | "stdout" | "stderr" | "ptyView";
  /** "all" is a bounded alias for a head read; page with offset for the rest. */
  mode?: "tail" | "head" | "offset" | "grep" | "all";
  lines?: number;
  maxBytes?: number;
  lineOffset?: number;
  byteOffset?: number;
  pattern?: string;
  context?: number;
  stripAnsi?: boolean;
}

export interface ShellPromoteParams {
  id: string;
  to: "session" | "workspace";
  adopterNotification?: boolean;
}

export interface ShellCancelParams {
  ids: string | string[];
  ladder?: "graceful" | "force";
  graceMs?: number;
}

export interface ShellSendParams {
  id: string;
  text?: string;
  keys?: string[];
  settleMs?: number;
  /** Caller-supplied replay key. A second send with one request sends nothing. */
  request?: string;
}

export interface ShellStatusParams {
  id?: string;
}

export interface LogPaths {
  dir: string;
  stdout: string;
  stderr: string;
  combined: string;
  ptyView?: string;
}

export interface ByteCounts {
  stdout: number;
  stderr: number;
  combined: number;
  capReached: boolean;
}

export interface ProcessIdentity {
  bootId: string;
  pid: number;
  start: number;
}

export interface ShellHandle {
  id: string;
  name: string;
  command: string;
  cwd: string;
  scope: Scope;
  binding: Binding;
  status: ShellStatus;
  pid?: number;
  pgid?: number;
  startedAt: number;
  readyAt?: number;
  endedAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  /** How a pipeline's status was determined, when the command contains one. */
  exitSource?: "pipefail" | "last-command";
  log: LogPaths;
  bytes: ByteCounts;
  error?: string;
  consumedByAwait?: boolean;
  notifyOnCompletion?: boolean;
  triggerOnCompletion?: boolean;
  delivery?: Delivery;
  timeoutSeconds?: number;
}

export interface ShellAwaitResult {
  settled: boolean;
  timedOutWaiting: boolean;
  matched?: { id: string; line: string; byteOffset: number };
  outcomes: ShellHandle[];
  stillRunning: ShellHandle[];
  /**
   * Guidance the text result also carries: a clamped wait, or what to do after
   * a wait that expired. A structured caller reads this field instead of the
   * prose, so both surfaces say the same thing.
   */
  note?: string;
}

/** `shell_start` returns a handle, and reports a settle inline when it has one. */
export interface ShellStartResult extends ShellHandle {
  settledInline?: boolean;
  /** Why the result differs from the request, such as a clamped inline window. */
  note?: string;
}

export interface ShellReadRange {
  startLine?: number;
  endLine?: number;
  startByte?: number;
  endByte?: number;
  nextLine?: number;
  nextByte?: number;
}

export interface ShellReadResult {
  id: string;
  status: ShellStatus;
  stream: "combined" | "stdout" | "stderr" | "ptyView";
  text: string;
  truncated: boolean;
  totalLines: number;
  totalBytes: number;
  range: ShellReadRange;
  fullLogPath: string;
  note?: string;
}

export interface ShellCancelResult {
  id: string;
  status: ShellStatus;
  verifiedGone: boolean;
  leaked?: number[];
  note?: string;
}

export interface ShellSendResult {
  id: string;
  wrote: boolean;
  screen?: string;
}

export interface ShellStatusResult {
  handles: ShellHandle[];
  running: number;
  ready: number;
  workspaceOwner: boolean;
}

/** The durable metadata record written to `meta.json`. */
export interface ShellMeta extends ShellHandle {
  version: 1;
  identity?: ProcessIdentity;
  durable: boolean;
  request?: string;
  adoptAttempts: number;
  createdAt: number;
  updatedAt: number;
}

/** A completion record, persisted for a later Pi process to surface. */
export interface CompletionRecord {
  id: string;
  name: string;
  status: ShellStatus;
  exitCode?: number | null;
  signal?: string | null;
  exitSource?: "pipefail" | "last-command";
  scope: Scope;
  binding: Binding;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  log: LogPaths;
  bytes: ByteCounts;
  error?: string;
  triggerOnCompletion?: boolean;
  delivery?: Delivery;
}
