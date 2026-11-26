import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShellRegistry, type RegistryOptions } from "../src/core/registry.ts";

const temporaryDirectories = new Set<string>();

/** Every fixture directory belongs to the test file that created it. */
export function tempCwd(prefix = "pas-test-"): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.add(path);
  return path;
}

// Registry finalization deliberately outlives individual tool calls. Clean at
// process exit, after those fire-and-forget persistence writes have finished.
process.once("exit", () => {
  for (const path of temporaryDirectories) rmSync(path, { recursive: true, force: true });
  temporaryDirectories.clear();
});

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
