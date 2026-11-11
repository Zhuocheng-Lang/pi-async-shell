// SPDX-FileCopyrightText: 2026 Zhuocheng-Lang
// SPDX-License-Identifier: MPL-2.0

import { readFileSync, readdirSync } from "node:fs";
import type { ProcessIdentity } from "./types.ts";

let cachedBootId: string | undefined;

export function assertLinux(platform: NodeJS.Platform = process.platform): void {
  if (platform !== "linux") {
    throw new Error(
      `pi-async-shell supports Linux only (received ${platform}); process identity and containment require procfs.`,
    );
  }
}

function procfsFailure(error: unknown): Error {
  return new Error("pi-async-shell requires a readable /proc filesystem on Linux", { cause: error });
}

/**
 * The boot id is half of process identity. A pid alone is not enough: after a
 * reboot the kernel reuses the number space, and adopting a stranger's process
 * to report its exit code is worse than reporting `lost`.
 */
export function bootId(): string {
  assertLinux();
  if (cachedBootId) return cachedBootId;
  try {
    cachedBootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch (error) {
    throw procfsFailure(error);
  }
  return cachedBootId;
}

interface ProcStat {
  pid: number;
  state: string;
  ppid: number;
  pgid: number;
  start: number;
}

/**
 * `/proc/<pid>/stat` field 22 is the process start time. The comm field can
 * contain spaces and parentheses, so parsing starts after the last ')'.
 */
export function readProcStat(pid: number): ProcStat | undefined {
  assertLinux();
  let raw: string;
  try {
    raw = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return undefined;
  }
  const close = raw.lastIndexOf(")");
  if (close < 0) return undefined;
  const fields = raw.slice(close + 2).trim().split(/\s+/);
  // fields[0] is field 3 (state); field 22 is fields[19].
  const state = fields[0];
  const ppid = Number(fields[1]);
  const pgid = Number(fields[2]);
  const start = Number(fields[19]);
  if (!Number.isFinite(ppid) || !Number.isFinite(pgid) || !Number.isFinite(start)) return undefined;
  return { pid, state, ppid, pgid, start };
}

export interface ProcIdentity extends ProcessIdentity {
  /** The process group at capture time; the cheap containment fallback. */
  pgid?: number;
}

export function processIdentity(pid: number): ProcIdentity | undefined {
  const stat = readProcStat(pid);
  if (!stat) return undefined;
  return { bootId: bootId(), pid, start: stat.start, pgid: stat.pgid };
}

export function pgidOf(pid: number): number | undefined {
  return readProcStat(pid)?.pgid;
}

/** True when the identity still names the same live process. */
export function identityAlive(identity: ProcessIdentity | undefined): boolean {
  if (!identity) return false;
  if (identity.bootId !== bootId()) return false;
  const stat = readProcStat(identity.pid);
  if (!stat) return false;
  if (stat.state === "Z" || stat.state === "X") return false;
  return stat.start === identity.start;
}

export interface ProcEntry {
  pid: number;
  ppid: number;
  pgid: number;
  start: number;
  state: string;
}

/** A process group this execution owns, and the earliest start time it may contain. */
export interface ProcessGroupRef {
  pgid: number;
  /** Start time of the group leader in /proc/<pid>/stat clock ticks. */
  since: number;
}

export function listProcesses(): ProcEntry[] {
  assertLinux();
  const out: ProcEntry[] = [];
  let names: string[];
  try {
    names = readdirSync("/proc");
  } catch (error) {
    throw procfsFailure(error);
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const stat = readProcStat(Number(name));
    if (!stat) continue;
    out.push({ pid: stat.pid, ppid: stat.ppid, pgid: stat.pgid, start: stat.start, state: stat.state });
  }
  return out;
}

/** Every live descendant of the given roots, by ppid walk. */
export function descendantsOf(roots: readonly ProcessIdentity[]): number[] {
  const procs = listProcesses();
  const byParent = new Map<number, ProcEntry[]>();
  for (const proc of procs) {
    const list = byParent.get(proc.ppid);
    if (list) list.push(proc);
    else byParent.set(proc.ppid, [proc]);
  }
  const seen = new Set<number>();
  const queue: number[] = [];
  for (const root of roots) {
    if (root.bootId !== bootId()) continue;
    const stat = readProcStat(root.pid);
    if (!stat || stat.start !== root.start) continue;
    queue.push(root.pid);
  }
  while (queue.length > 0) {
    const pid = queue.shift() as number;
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const child of byParent.get(pid) ?? []) {
      if (child.state === "Z" || child.state === "X") continue;
      queue.push(child.pid);
    }
  }
  return [...seen];
}

/**
 * Live members of the given process groups.
 *
 * The tag and the ppid walk both fail for the same adversarial shape: a child
 * that clears its environment *and* outlives its parent. Reparenting to init
 * erases the ppid edge, and `env -i` erases the tag, but the process group
 * survives unless the child calls `setsid(2)`. The `since` bound keeps a reused
 * group id from matching a stranger that predates the execution.
 */
export function groupMembers(groups: readonly ProcessGroupRef[]): number[] {
  const wanted = new Map<number, number>();
  const own = pgidOf(process.pid);
  for (const group of groups) {
    if (!Number.isFinite(group.pgid) || group.pgid <= 1) continue;
    if (own !== undefined && group.pgid === own) continue;
    const seen = wanted.get(group.pgid);
    if (seen === undefined || group.since < seen) wanted.set(group.pgid, group.since);
  }
  if (wanted.size === 0) return [];
  const out: number[] = [];
  for (const proc of listProcesses()) {
    if (proc.pid === process.pid) continue;
    if (proc.state === "Z" || proc.state === "X") continue;
    const since = wanted.get(proc.pgid);
    if (since === undefined) continue;
    if (proc.start < since) continue; // predates the execution: a reused group id
    out.push(proc.pid);
  }
  return out;
}

/** Processes whose environment carries `PI_ASYNC_SHELL_EXEC=<tag>`. */
export function taggedPids(tag: string): number[] {
  assertLinux();
  const needle = `PI_ASYNC_SHELL_EXEC=${tag}`;
  const out: number[] = [];
  let names: string[];
  try {
    names = readdirSync("/proc");
  } catch (error) {
    throw procfsFailure(error);
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let env: string;
    try {
      env = readFileSync(`/proc/${name}/environ`, "utf8");
    } catch {
      continue;
    }
    if (env.split("\u0000").includes(needle)) out.push(Number(name));
  }
  return out;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
