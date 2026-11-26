// SPDX-FileCopyrightText: 2026 Zhuocheng-Lang
// SPDX-License-Identifier: MPL-2.0

import { existsSync } from "node:fs";

export interface ShellPolicy {
  /** The shell that runs a `pipe` or `pty` command. */
  shell: string;
  /** Where the choice came from, for the prompt and for diagnostics. */
  source: "PI_ASYNC_SHELL" | "fallback";
  /** True when the shell accepts POSIX `-c` scripts. */
  posix: boolean;
}

const POSIX_SHELLS = new Set(["sh", "bash", "dash", "zsh", "ksh", "ash"]);
const PIPEFAIL_SHELLS = new Set(["bash", "zsh", "ksh"]);

/**
 * Match Pi's bash tool: ambient $SHELL selects a login shell, not a script
 * interpreter. Only PI_ASYNC_SHELL deliberately changes the command language.
 */
export function resolveShell(env: NodeJS.ProcessEnv = process.env): ShellPolicy {
  const explicit = env.PI_ASYNC_SHELL?.trim();
  if (explicit) {
    return { shell: explicit, source: "PI_ASYNC_SHELL", posix: isPosix(explicit) };
  }
  if (existsSync("/bin/bash")) return { shell: "/bin/bash", source: "fallback", posix: true };
  return { shell: "/bin/sh", source: "fallback", posix: true };
}

function isPosix(shell: string): boolean {
  const base = shell.split("/").pop() ?? shell;
  return POSIX_SHELLS.has(base);
}

/** True when the chosen interpreter accepts `set -o pipefail`. */
export function supportsPipefail(shell: string): boolean {
  return PIPEFAIL_SHELLS.has(shell.split("/").pop() ?? shell);
}

/** Find a real pipeline, ignoring quotes, escapes, comments, and `||`. */
function hasPipeline(command: string): boolean {
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "#" && (index === 0 || /\s/.test(command[index - 1]))) {
      const newline = command.indexOf("\n", index);
      if (newline < 0) return false;
      index = newline;
      continue;
    }
    if (char === "|" && command[index + 1] !== "|" && command[index - 1] !== "|") return true;
  }
  return false;
}

/**
 * Pipeline status must not silently collapse to the last stage. Bash-like
 * interpreters get pipefail; the POSIX fallback records that only the last
 * stage determines the exit code.
 */
export function applyPipelineStatus(
  policy: ShellPolicy,
  command: string,
): { command: string; exitSource?: "pipefail" | "last-command" } {
  if (!hasPipeline(command)) return { command };
  if (supportsPipefail(policy.shell)) return { command: `set -o pipefail; ${command}`, exitSource: "pipefail" };
  return { command, exitSource: "last-command" };
}

/** The one-line shell policy included in shell_start's description. */
export function describeShellPolicy(policy: ShellPolicy): string {
  const origin = policy.source === "PI_ASYNC_SHELL" ? "explicit PI_ASYNC_SHELL override" : "fixed default that ignores ambient $SHELL";
  return `Commands run with \`${policy.shell} -c <command>\` (${origin}).`;
}
