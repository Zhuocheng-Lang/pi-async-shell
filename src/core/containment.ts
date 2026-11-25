// SPDX-FileCopyrightText: 2026 Zhuocheng-Lang
// SPDX-License-Identifier: MPL-2.0

import {
  bootId,
  descendantsOf,
  groupMembers,
  identityAlive,
  pgidOf,
  processIdentity,
  readProcStat,
  sleep,
  taggedPids,
  type ProcessGroupRef,
} from "./identity.ts";
import type { ProcessIdentity } from "./types.ts";

export const EXEC_TAG_ENV = "PI_ASYNC_SHELL_EXEC";

export interface FenceOptions {
  tag: string;
  identities: readonly ProcessIdentity[];
  /** Process groups the execution owns; catches an env-cleared, reparented child. */
  groups?: readonly ProcessGroupRef[];
  deadlineMs?: number;
  pollMs?: number;
  signal?: NodeJS.Signals;
}

export interface FenceResult {
  ok: boolean;
  remaining: number[];
  rounds: number;
}

/**
 * The fence is the containment guarantee.
 *
 * A process group is escapable: `setsid(2)` puts a child in a new session and a
 * new group, after which `kill(-pgid)` reaches nothing. `nohup ... &` is an
 * ordinary thing for an agent to type. So the group is only the cheap graceful
 * path; the tag is the guarantee. This loop unions tagged processes with the
 * live descendants of every known identity and the live members of every owned
 * process group, re-reads each process start time immediately before signalling
 * so a reused pid is never killed, and repeats until the set is empty or the
 * deadline expires.
 */
export async function fence(options: FenceOptions): Promise<FenceResult> {
  const deadline = Date.now() + (options.deadlineMs ?? 5000);
  const pollMs = options.pollMs ?? 50;
  const signal = options.signal ?? "SIGKILL";
  let rounds = 0;
  let remaining: number[] = [];

  while (Date.now() < deadline) {
    rounds += 1;
    const candidates = new Map<number, ProcessIdentity | undefined>();
    for (const pid of taggedPids(options.tag)) {
      candidates.set(pid, processIdentity(pid));
    }
    const roots = [...options.identities];
    for (const pid of descendantsOf(roots)) {
      if (!candidates.has(pid)) candidates.set(pid, processIdentity(pid));
    }
    // A child that cleared its environment and lost its parent is neither tagged
    // nor a descendant, but it still carries the group id unless it called setsid.
    for (const pid of groupMembers(options.groups ?? [])) {
      if (!candidates.has(pid)) candidates.set(pid, processIdentity(pid));
    }
    // Descendants of tagged processes matter too: a tagged shell may have
    // started a child that cleared its own environment.
    const taggedIdentities = [...candidates.values()].filter(
      (identity): identity is ProcessIdentity => Boolean(identity),
    );
    for (const pid of descendantsOf(taggedIdentities)) {
      if (!candidates.has(pid)) candidates.set(pid, processIdentity(pid));
    }

    remaining = [];
    for (const [pid, captured] of candidates) {
      const current = readProcStat(pid);
      if (!current || current.state === "Z" || current.state === "X") continue;
      if (captured && current.start !== captured.start) continue; // pid was reused
      if (captured && captured.bootId !== bootId()) continue;
      try {
        process.kill(pid, signal);
      } catch {
        continue;
      }
      remaining.push(pid);
    }

    if (remaining.length === 0) return { ok: true, remaining: [], rounds };
    await sleep(pollMs);
  }

  return { ok: remaining.length === 0, remaining, rounds };
}

/** Signal a process group, refusing the values that would hit our own group. */
export function signalGroup(pgid: number | undefined, signal: NodeJS.Signals): boolean {
  if (!pgid || pgid <= 1) return false;
  if (pgid === process.pid) return false;
  if (pgid === pgidOf(process.pid)) return false;
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

export interface VerifyResult {
  gone: boolean;
  remaining: number[];
}

/** Prove absence rather than assume it: a signal is not a containment guarantee. */
export async function verifyGone(
  tag: string,
  identities: readonly ProcessIdentity[],
  groups: readonly ProcessGroupRef[] = [],
): Promise<VerifyResult> {
  const alive = new Set<number>();
  for (const pid of taggedPids(tag)) {
    const stat = readProcStat(pid);
    if (stat && stat.state !== "Z" && stat.state !== "X") alive.add(pid);
  }
  for (const pid of descendantsOf(identities)) {
    const stat = readProcStat(pid);
    if (stat && stat.state !== "Z" && stat.state !== "X") alive.add(pid);
  }
  for (const pid of groupMembers(groups)) {
    const stat = readProcStat(pid);
    if (stat && stat.state !== "Z" && stat.state !== "X") alive.add(pid);
  }
  for (const identity of identities) {
    if (identityAlive(identity)) alive.add(identity.pid);
  }
  return { gone: alive.size === 0, remaining: [...alive] };
}

