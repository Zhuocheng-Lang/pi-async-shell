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

/** The one-line shell policy included in the active tools' prompt guidelines. */
export function describeShellPolicy(policy: ShellPolicy): string {
  const origin = policy.source === "PI_ASYNC_SHELL" ? "explicit PI_ASYNC_SHELL override" : "fixed default; ambient $SHELL is ignored";
  return `shell_start runs commands with \`${policy.shell} -c <command>\` (${origin}).`;
}
