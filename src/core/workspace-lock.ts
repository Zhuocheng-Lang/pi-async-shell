// SPDX-FileCopyrightText: 2026 Zhuocheng-Lang
// SPDX-License-Identifier: MPL-2.0

import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { bootId, identityAlive } from "./identity.ts";
import type { RegistryPaths } from "./paths.ts";

export interface LockHolder {
  pid: number;
  start: number;
  bootId: string;
  sessionId: string;
  acquiredAt: number;
}

export interface LockResult {
  owned: boolean;
  holder?: LockHolder;
  reason?: string;
}

/**
 * One writer per workspace (C10). Other processes open the registry read-only,
 * and `shell_promote`, `shell_send` and `shell_cancel` refuse rather than race
 * the owner. A process that cannot take the lock never becomes an owner by
 * accident.
 */
export function acquireWorkspaceLock(paths: RegistryPaths, sessionId: string): LockResult {
  const identity = { bootId: bootId(), pid: process.pid };
  const start = readStart(process.pid);
  if (start === undefined) return { owned: false, reason: "cannot read own process identity" };
  const holder: LockHolder = { ...identity, start, sessionId, acquiredAt: Date.now() };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      writeFileSync(paths.lockFile, JSON.stringify(holder), { flag: "wx" });
      return { owned: true, holder };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") return { owned: false, reason: String(error) };
      const existing = readLock(paths);
      if (!existing) {
        // A torn or empty lock file is stale by definition.
        safeUnlink(paths.lockFile);
        continue;
      }
      if (identityAlive({ bootId: existing.bootId, pid: existing.pid, start: existing.start })) {
        return { owned: false, holder: existing, reason: "another process owns this workspace" };
      }
      safeUnlink(paths.lockFile);
    }
  }
  return { owned: false, reason: "could not acquire the workspace lock" };
}

export function readLock(paths: RegistryPaths): LockHolder | undefined {
  try {
    const raw = readFileSync(paths.lockFile, "utf8");
    const parsed = JSON.parse(raw) as LockHolder;
    if (typeof parsed.pid !== "number" || typeof parsed.start !== "number") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function releaseWorkspaceLock(paths: RegistryPaths): void {
  const existing = readLock(paths);
  if (!existing) return;
  if (existing.pid !== process.pid) return;
  safeUnlink(paths.lockFile);
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* ignore */
  }
}

function readStart(pid: number): number | undefined {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = raw.lastIndexOf(")");
    if (close < 0) return undefined;
    const fields = raw.slice(close + 2).trim().split(/\s+/);
    const start = Number(fields[19]);
    return Number.isFinite(start) ? start : undefined;
  } catch {
    return undefined;
  }
}
