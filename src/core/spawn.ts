// SPDX-FileCopyrightText: 2026 Zhuocheng-Lang
// SPDX-License-Identifier: MPL-2.0

import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Writable } from "node:stream";
import { EXEC_TAG_ENV } from "./containment.ts";
import { assertLinux } from "./identity.ts";
import { clampPtySize, type PtySize } from "./types.ts";

/**
 * The terminal geometry is declared once, in the vocabulary module, because the
 * screen replay needs it too and this module owns a child process.
 */
export type { PtySize } from "./types.ts";

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
 *
 * `script` runs in the foreground on purpose. POSIX sets SIGINT and SIGQUIT to
 * SIG_IGN in the child of an asynchronous list, and a non-interactive shell that
 * inherited an ignored signal cannot reset it: `trap - INT QUIT` is a no-op in
 * dash, which is /bin/sh on Debian and Ubuntu. A backgrounded `script` therefore
 * hands the recorded terminal an unkillable SIGINT, so ^C reaches the pty line
 * discipline and the byte arrives, but the foreground process group never takes
 * the signal. Only the watcher is asynchronous now; it runs `kill` and nothing
 * else, so the disposition it inherits cannot reach a command.
 *
 * The trap keeps this shell alive long enough to seal exit.json. A shell trap
 * does not propagate: children still receive the default disposition.
 */
export const PTY_WRAPPER = [
  "#!/bin/sh",
  "# $1 = exec dir, $2 = 1 when the owner must not be outlived, $3 = log cap",
  "d=$1; watch=$2; cap=$3",
  ...IDENTITY_LINES,
  'fifo="$d/stdin.fifo"',
  'rm -f "$fifo" "$d/script.rc"',
  'mkfifo -m 600 "$fifo" || exit 1',
  'exec 4<>"$fifo"',
  "# script(1) truncates the log it is handed, so the owner-only mode has to be",
  "# set on a file that already exists. The shell's own umask is left alone: it",
  "# would otherwise follow every command the user runs.",
  '( umask 077; : >> "$d/combined.log" )',
  "# Only TERM is trapped: the group signals this runtime sends are TERM and",
  "# KILL, and trapping INT or QUIT would take them away from script(1).",
  "trap ':' TERM",
  'wd=""',
  'if [ "$watch" = "1" ]; then',
  '  ( trap ":" TERM; read -r release <&3; if [ "$release" = "release" ]; then exit 0; fi; kill -TERM 0 2>/dev/null; sleep 1; kill -0 $$ 2>/dev/null && kill -KILL 0 2>/dev/null ) &',
  "  wd=$!",
  "fi",
  "# The launcher path travels in the environment: nesting it inside the -c",
  "# string is what broke a workspace whose path contains a space.",
  "#",
  "# The recording goes through a bounded writer instead of straight into the",
  "# file. script(1) terminates the session at --output-limit, which would let a",
  "# full log kill the command; the writer stops appending and keeps reading, so",
  "# the cap costs output and never the process. Its own status is carried out",
  "# of the pipeline because POSIX reports the last stage's status.",
  `{ script -q -f -e -c 'sh "$PI_ASYNC_SHELL_EXEC_DIR/pty-launcher.sh"' /dev/null <&4 2>&1; echo $? > "$d/script.rc"; } | "$PI_ASYNC_SHELL_NODE" "$d/recording-writer.mjs" "$d" "$cap"`,
  'rc=$(cat "$d/script.rc" 2>/dev/null || echo 1)',
  "# The watcher treats SIGTERM as owner loss, so stopping it here has to be a",
  "# signal it cannot confuse with that. SIGTERM would fire its trap, interrupt",
  "# the read, and make a normal exit look like the owner died.",
  '[ -n "$wd" ] && kill -KILL "$wd" 2>/dev/null',
  ...EXIT_RECORD_LINES,
  'exit "$rc"',
  "",
].join("\n");

/** Matches the registry's `PI_ASYNC_SHELL_MAX_LOG_BYTES` default. */
const DEFAULT_PTY_LOG_BYTES = 100 * 1024 * 1024;

export function resolvePtySize(env: NodeJS.ProcessEnv = process.env): PtySize {
  const fromTty = process.stdout.isTTY;
  return clampPtySize({
    cols: fromTty ? Number(process.stdout.columns) : Number(env.COLUMNS),
    rows: fromTty ? Number(process.stdout.rows) : Number(env.LINES),
  });
}

/** The file in an execution directory that carries the geometry the launcher applied. */
export const PTY_SIZE_FILE = "pty-size";

/** Record the geometry so a replay uses the size the child actually got. */
export function writePtySize(dir: string, size: PtySize): void {
  writeFileSync(join(dir, PTY_SIZE_FILE), `${size.rows} ${size.cols}\n`);
}

/**
 * Read the geometry the child ran at.
 *
 * `undefined` is the honest answer for a missing or unreadable record. A caller
 * that defaults silently presents its own 80x24 as the terminal's size, and the
 * viewport it returns is wrapped at a width the program never saw.
 */
export function readPtySize(dir: string): PtySize | undefined {
  try {
    const [rows, cols] = readFileSync(join(dir, PTY_SIZE_FILE), "utf8").trim().split(/\s+/).map(Number);
    if (!Number.isFinite(rows) || !Number.isFinite(cols)) return undefined;
    return clampPtySize({ cols, rows });
  } catch {
    return undefined;
  }
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
  // /bin/sh is named explicitly, so the wrapper never needs to be executable by
  // anyone else, and an owner-only file cannot be swapped before it runs.
  writeFileSync(path, body, { mode: 0o700 });
  chmodSync(path, 0o700);
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
    // The wrapper runs the recording writer by absolute path: a `node` from
    // PATH could be a different runtime than the one loading this extension.
    PI_ASYNC_SHELL_NODE: process.execPath,
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
  linkRecordingWriter(ctx.dir);
  linkToCombined(ctx.dir, "stdout.log");
  linkToCombined(ctx.dir, "ptyView.log");
  const child = spawn("/bin/sh", [
    wrapper,
    ctx.dir,
    options.watch ? "1" : "0",
    String(ctx.maxLogBytes ?? DEFAULT_PTY_LOG_BYTES),
  ], {
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

/**
 * A pty recording is written by the bounded writer, never by `script(1)`
 * itself, so the cap is a logging policy rather than a process policy.
 */
function linkRecordingWriter(dir: string): void {
  const target = join(dir, "recording-writer.mjs");
  if (existsSync(target)) return;
  try {
    symlinkSync(fileURLToPath(new URL("./recording-writer.mjs", import.meta.url)), target);
  } catch {
    /* a missing writer surfaces as an execution that records nothing */
  }
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
