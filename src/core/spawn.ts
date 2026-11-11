// SPDX-FileCopyrightText: 2026 Zhuocheng-Lang
// SPDX-License-Identifier: MPL-2.0

import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Writable } from "node:stream";
import { EXEC_TAG_ENV } from "./containment.ts";
import { assertLinux } from "./identity.ts";

const IDENTITY_LINES = [
  "st=$(cut -d' ' -f22 /proc/$$/stat 2>/dev/null || echo 0)",
  "pg=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')",
  "printf '{\"pid\":%s,\"pgid\":%s,\"starttime\":%s}\\n' \"$$\" \"$pg\" \"$st\" > \"$d/pid.tmp\" && mv \"$d/pid.tmp\" \"$d/pid.json\"",
];

const EXIT_RECORD_LINES = [
  "now=$(date +%s%3N 2>/dev/null || echo $(( $(date +%s) * 1000 )))",
  "printf '{\"exitCode\":%s,\"endedAt\":%s}\\n' \"$rc\" \"$now\" > \"$d/exit.tmp\" && mv \"$d/exit.tmp\" \"$d/exit.json\"",
];

/**
 * script(1) writes straight to the log, a read-write FIFO keeps stdin open,
 * and fd 3 distinguishes owner loss from an explicit promotion release.
 */
export const PTY_WRAPPER = [
  "#!/bin/sh",
  "# $1 = exec dir, $2 = 1 when the owner must not be outlived",
  "d=$1; watch=$2",
  ...IDENTITY_LINES,
  'fifo="$d/stdin.fifo"',
  'rm -f "$fifo"',
  'mkfifo "$fifo" || exit 1',
  'exec 4<>"$fifo"',
  '( trap - INT QUIT; exec script -q -f -e -c "sh $d/pty-launcher.sh" /dev/null <&4 > "$d/combined.log" 2>&1 ) &',
  "spid=$!",
  'wd=""',
  'if [ "$watch" = "1" ]; then',
  '  ( read -r release <&3; if [ "$release" = "release" ]; then exit 0; fi; kill -TERM "$spid" 2>/dev/null; sleep 1; kill -KILL "$spid" 2>/dev/null ) &',
  "  wd=$!",
  "fi",
  'wait "$spid"',
  "rc=$?",
  '[ -n "$wd" ] && kill "$wd" 2>/dev/null',
  ...EXIT_RECORD_LINES,
  'exit "$rc"',
  "",
].join("\n");

export interface PtySize {
  cols: number;
  rows: number;
}

const DEFAULT_PTY_COLS = 80;
const DEFAULT_PTY_ROWS = 24;

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function resolvePtySize(env: NodeJS.ProcessEnv = process.env): PtySize {
  const fromTty = process.stdout.isTTY;
  const cols = fromTty ? Number(process.stdout.columns) : Number(env.COLUMNS);
  const rows = fromTty ? Number(process.stdout.rows) : Number(env.LINES);
  return {
    cols: clampInt(cols, 20, 500, DEFAULT_PTY_COLS),
    rows: clampInt(rows, 4, 200, DEFAULT_PTY_ROWS),
  };
}

export function ptyLauncher(shell: string, command: string, size: PtySize): string {
  return [
    "#!/bin/sh",
    "stty rows " + size.rows + " cols " + size.cols + " 2>/dev/null",
    "exec " + shQuote(shell) + " -c " + shQuote(command),
    "",
  ].join("\n");
}

export function shQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export function writeWrapper(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

export function fifoPath(dir: string): string {
  return join(dir, "stdin.fifo");
}

export interface SpawnContext {
  id: string;
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Explicit tool parameters win over the default credential filter. */
  envOverrides?: NodeJS.ProcessEnv;
  shell: string;
  dir: string;
  combinedPath: string;
  maxLogBytes?: number;
}

const SENSITIVE_SUFFIX = /(?:^|_)(?:API_KEY|API_SECRET|SECRET_KEY|ACCESS_TOKEN|AUTH_TOKEN|SESSION_TOKEN|PRIVATE_KEY)$/;
const SENSITIVE_EXACT = new Set([
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AZURE_CLIENT_SECRET",
  "DOCKER_AUTH_CONFIG",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "HF_TOKEN",
  "NPM_TOKEN",
]);

export function isSensitiveEnvironmentKey(key: string): boolean {
  const normalized = key.toUpperCase();
  return SENSITIVE_SUFFIX.test(normalized) || SENSITIVE_EXACT.has(normalized);
}

/** Keep ordinary development configuration, drop credentials by default. */
export function filterEnvironment(
  env: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const filtered: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !isSensitiveEnvironmentKey(key)) filtered[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete filtered[key];
    else filtered[key] = value;
  }
  return filtered;
}

function childEnv(ctx: SpawnContext): NodeJS.ProcessEnv {
  return {
    ...filterEnvironment(ctx.env, ctx.envOverrides),
    [EXEC_TAG_ENV]: ctx.id,
    PI_ASYNC_SHELL_EXEC_DIR: ctx.dir,
  };
}

export interface SpawnedPipe {
  child: ChildProcess;
  durable: boolean;
  owner?: Writable;
}

/**
 * Every pipe execution has the same detached supervisor and file-bound logs.
 * Session scope adds only an fd 3 owner watch, so promotion needs no respawn.
 */
export function spawnPipe(ctx: SpawnContext, durable: boolean): SpawnedPipe {
  assertLinux();
  const supervisor = fileURLToPath(new URL("./pipe-supervisor.mjs", import.meta.url));
  const child = spawn(
    process.execPath,
    [supervisor, ctx.dir, ctx.shell, ctx.command, String(ctx.maxLogBytes ?? 10 * 1024 * 1024), durable ? "0" : "1"],
    {
      cwd: ctx.cwd,
      env: childEnv(ctx),
      detached: true,
      stdio: durable ? ["ignore", "ignore", "ignore"] : ["ignore", "ignore", "ignore", "pipe"],
      windowsHide: true,
    },
  );
  child.unref();
  const owner = durable ? undefined : (child.stdio[3] as Writable | null) ?? undefined;
  owner?.on("error", () => undefined);
  return { child, durable, owner };
}

export interface SpawnedPty {
  child: ChildProcess;
  owner?: Writable;
}

export function spawnPty(ctx: SpawnContext, options: { watch: boolean }): SpawnedPty {
  assertLinux();
  const wrapper = writeWrapper(ctx.dir, "pty-wrapper.sh", PTY_WRAPPER);
  linkToCombined(ctx.dir, "stdout.log");
  linkToCombined(ctx.dir, "ptyView.log");
  const child = spawn("/bin/sh", [wrapper, ctx.dir, options.watch ? "1" : "0"], {
    cwd: ctx.cwd,
    // script(1)'s intermediate parser is always POSIX; pty-launcher.sh starts
    // the configured command shell afterwards.
    env: { ...childEnv(ctx), SHELL: "/bin/sh" },
    detached: true,
    stdio: options.watch ? ["ignore", "ignore", "ignore", "pipe"] : ["ignore", "ignore", "ignore"],
    windowsHide: true,
  });
  child.unref();
  const owner = options.watch ? (child.stdio[3] as Writable | null) ?? undefined : undefined;
  owner?.on("error", () => undefined);
  return { child, owner };
}

function linkToCombined(dir: string, name: string): void {
  const target = join(dir, name);
  if (existsSync(target)) return;
  try {
    symlinkSync("combined.log", target);
  } catch {
    /* a missing link costs a stream name, not the execution */
  }
}
