// SPDX-FileCopyrightText: 2026 Zhuocheng-Lang
// SPDX-License-Identifier: MPL-2.0

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isTerminal, type ShellMeta } from "./types.ts";

export interface RegistryPaths {
  /** `.pi/async-shell` under the workspace. */
  root: string;
  /** Directory that owns this process's session-scoped executions. */
  sessionDir: string;
  /** Directory of workspace-scoped executions. */
  workspaceDir: string;
  /** Replay-safe request records. */
  requestsDir: string;
  lockFile: string;
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96);
}

export function registryPaths(cwd: string, sessionId: string, pid: number): RegistryPaths {
  const root = join(resolve(cwd), ".pi", "async-shell");
  return {
    root,
    sessionDir: join(root, "sessions", `${safeSegment(sessionId)}-${pid}`),
    workspaceDir: join(root, "workspace"),
    requestsDir: join(root, "requests"),
    lockFile: join(root, "workspace", ".lock"),
  };
}

export function ensureRegistryDirs(paths: RegistryPaths): void {
  mkdirSync(paths.root, { recursive: true });
  // Never replace a user's rule. A new runtime root starts fully ignored.
  try {
    writeFileSync(join(paths.root, ".gitignore"), "*\n", { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  mkdirSync(paths.sessionDir, { recursive: true });
  mkdirSync(paths.workspaceDir, { recursive: true });
  mkdirSync(paths.requestsDir, { recursive: true });
}

export function execDirFor(paths: RegistryPaths, scope: string, id: string): string {
  const base = scope === "workspace" ? paths.workspaceDir : paths.sessionDir;
  return join(base, id);
}

export function logPathsFor(dir: string, binding: string): {
  dir: string;
  stdout: string;
  stderr: string;
  combined: string;
  ptyView?: string;
} {
  return {
    dir,
    stdout: join(dir, "stdout.log"),
    stderr: join(dir, "stderr.log"),
    combined: join(dir, "combined.log"),
    ptyView: binding === "pipe" ? undefined : join(dir, "ptyView.log"),
  };
}

export const DEFAULT_GC_RETENTION_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_GC_MAX_RECORDS = 100;
const COUNT_EVICTION_GRACE_MS = 5 * 60 * 1000;

export interface GarbageCollectionOptions {
  now?: number;
  retentionMs?: number;
  maxTerminalRecords?: number;
  /** Loaded handles keep their logs even after they settle. */
  protectedIds?: ReadonlySet<string>;
}

export interface GarbageCollectionResult {
  removedExecutions: string[];
  removedRequests: number;
}

interface StoredRecord {
  id: string;
  dir: string;
  timestamp: number;
}

function readMeta(dir: string): ShellMeta | undefined {
  try {
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as ShellMeta;
    return meta.version === 1 && meta.id ? meta : undefined;
  } catch {
    return undefined;
  }
}

function directories(path: string): string[] {
  try {
    return readdirSync(path)
      .filter((name) => !name.startsWith("."))
      .map((name) => join(path, name))
      .filter((entry) => {
        try {
          return lstatSync(entry).isDirectory();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

function storedRecords(paths: RegistryPaths): StoredRecord[] {
  const dirs = [
    ...directories(join(paths.root, "sessions")).flatMap((session) => directories(session)),
    ...directories(paths.workspaceDir),
  ];
  const seen = new Set<string>();
  const records: StoredRecord[] = [];
  for (const dir of dirs) {
    const meta = readMeta(dir);
    if (!meta || seen.has(meta.id)) continue;
    seen.add(meta.id);
    if (!isTerminal(meta.status)) continue;
    const timestamp = meta.endedAt ?? meta.updatedAt ?? meta.createdAt;
    if (!Number.isFinite(timestamp)) continue;
    records.push({ id: meta.id, dir, timestamp });
  }
  return records;
}

function removePromotedLink(paths: RegistryPaths, id: string, removedDir: string): void {
  const link = join(paths.workspaceDir, id);
  try {
    if (!lstatSync(link).isSymbolicLink()) return;
    const target = resolve(paths.workspaceDir, readlinkSync(link));
    if (target === removedDir || !existsSync(link)) unlinkSync(link);
  } catch {
    /* a later pass can retry a stale link */
  }
}

/**
 * Collect only sealed, terminal records. Nonterminal metadata is never treated
 * as dead: a crashed owner must not turn a live workspace process into garbage.
 */
export function collectRegistryGarbage(
  paths: RegistryPaths,
  options: GarbageCollectionOptions = {},
): GarbageCollectionResult {
  const now = options.now ?? Date.now();
  const requestedRetention = options.retentionMs ?? DEFAULT_GC_RETENTION_MS;
  const requestedMax = options.maxTerminalRecords ?? DEFAULT_GC_MAX_RECORDS;
  const retentionMs = Number.isFinite(requestedRetention) ? Math.max(0, requestedRetention) : DEFAULT_GC_RETENTION_MS;
  const maxRecords = Number.isFinite(requestedMax) ? Math.max(0, Math.trunc(requestedMax)) : DEFAULT_GC_MAX_RECORDS;
  const protectedIds = options.protectedIds ?? new Set<string>();
  const records = storedRecords(paths);
  const knownIds = new Set(records.map((record) => record.id));
  // Running records are absent from storedRecords, so discover their ids too.
  for (const dir of [
    ...directories(join(paths.root, "sessions")).flatMap((session) => directories(session)),
    ...directories(paths.workspaceDir),
  ]) {
    const id = readMeta(dir)?.id;
    if (id) knownIds.add(id);
  }

  const eligible = records
    .filter((record) => dirname(record.dir) !== paths.sessionDir && !protectedIds.has(record.id))
    .sort((a, b) => b.timestamp - a.timestamp);
  const removedExecutions: string[] = [];
  eligible.forEach((record, index) => {
    const age = Math.max(0, now - record.timestamp);
    const expired = age > retentionMs;
    const overCount = index >= maxRecords && age > COUNT_EVICTION_GRACE_MS;
    if (!expired && !overCount) return;
    try {
      rmSync(record.dir, { recursive: true, force: false });
      removedExecutions.push(record.id);
      knownIds.delete(record.id);
      removePromotedLink(paths, record.id, record.dir);
      const parent = resolve(record.dir, "..");
      if (parent !== paths.workspaceDir && parent !== paths.sessionDir && readdirSync(parent).length === 0) {
        rmdirSync(parent);
      }
    } catch {
      /* concurrent collectors and active readers are both safe reasons to keep it */
    }
  });

  let removedRequests = 0;
  let requestNames: string[] = [];
  try {
    requestNames = readdirSync(paths.requestsDir).filter((name) => name.endsWith(".json"));
  } catch {
    /* no request directory */
  }
  for (const name of requestNames) {
    const path = join(paths.requestsDir, name);
    try {
      const record = JSON.parse(readFileSync(path, "utf8")) as { id?: string; createdAt?: number };
      const timestamp = record.createdAt ?? statSync(path).mtimeMs;
      if (now - timestamp <= retentionMs || (record.id && knownIds.has(record.id))) continue;
      unlinkSync(path);
      removedRequests += 1;
    } catch {
      /* malformed or concurrently replaced records remain for the next pass */
    }
  }
  return { removedExecutions, removedRequests };
}
