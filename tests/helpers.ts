import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShellRegistry, type RegistryOptions } from "../src/core/registry.ts";

export function tempCwd(prefix = "pas-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function makeRegistry(cwd: string, options: Partial<RegistryOptions> = {}): ShellRegistry {
  return new ShellRegistry({
    cwd,
    sessionId: options.sessionId ?? "test-session",
    env: { ...process.env, PI_ASYNC_SHELL: "/bin/sh", ...(options.env ?? {}) },
    ...options,
  });
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 25,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function removeDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}
