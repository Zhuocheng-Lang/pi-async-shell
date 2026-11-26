import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { assertLinux } from "../src/core/identity.ts";
import {
  collectRegistryGarbage,
  ensureRegistryDirs,
  registryPaths,
  type RegistryPaths,
} from "../src/core/paths.ts";
import { describeShellPolicy, resolveShell } from "../src/core/shell-policy.ts";
import { filterEnvironment, isSensitiveEnvironmentKey } from "../src/core/spawn.ts";
import { makeRegistry, tempCwd } from "./helpers.ts";

test("the default command shell is bash, not the ambient non-POSIX login shell", async () => {
  const policy = resolveShell({ SHELL: "/usr/bin/nu" });
  assert.equal(policy.shell, "/bin/bash");
  assert.equal(policy.source, "fallback");
  assert.equal(policy.posix, true);
  assert.match(describeShellPolicy(policy), /ignores ambient \$SHELL/);
  assert.equal(resolveShell({ PI_ASYNC_SHELL: "/usr/bin/fish" }).posix, false);
  assert.equal(resolveShell({ PI_ASYNC_SHELL: "/bin/sh" }).shell, "/bin/sh");

  const registry = makeRegistry(tempCwd(), {
    env: { ...process.env, SHELL: "/usr/bin/nu", PI_ASYNC_SHELL: undefined },
  });
  try {
    assert.equal(registry.shell.shell, "/bin/bash");
    const handle = await registry.start({ command: "[[ value == value ]] && echo bash-ok" });
    const result = await registry.awaitHandles({ ids: handle.id, waitMs: 5000 });
    assert.equal(result.outcomes[0]?.status, "completed");
    assert.equal((await registry.read({ id: handle.id })).text, "bash-ok");
  } finally {
    await registry.shutdown("quit");
  }
});

test("sensitive ambient variables are filtered and explicit env values win", async () => {
  assert.equal(isSensitiveEnvironmentKey("OPENAI_API_KEY"), true);
  assert.equal(isSensitiveEnvironmentKey("openai_api_key"), true);
  assert.equal(isSensitiveEnvironmentKey("PATH"), false);
  const filtered = filterEnvironment(
    { PATH: "/bin", OPENAI_API_KEY: "ambient", GITHUB_TOKEN: "ambient", NODE_ENV: "test" },
    { OPENAI_API_KEY: "explicit" },
  );
  assert.equal(filtered.PATH, "/bin");
  assert.equal(filtered.NODE_ENV, "test");
  assert.equal(filtered.OPENAI_API_KEY, "explicit");
  assert.equal(filtered.GITHUB_TOKEN, undefined);

  const registry = makeRegistry(tempCwd(), {
    env: { ...process.env, PI_ASYNC_SHELL: "/bin/sh", OPENAI_API_KEY: "ambient-test", GITHUB_TOKEN: "ambient-test" },
  });
  try {
    const handle = await registry.start({
      command: 'if [ -z "$OPENAI_API_KEY" ] && [ -z "$GITHUB_TOKEN" ]; then echo filtered; else echo exposed; fi',
    });
    await registry.awaitHandles({ ids: handle.id, waitMs: 5000 });
    assert.equal((await registry.read({ id: handle.id })).text, "filtered");

    const explicit = await registry.start({
      command: 'if [ "$OPENAI_API_KEY" = explicit-test ]; then echo explicit; else echo missing; fi',
      env: { OPENAI_API_KEY: "explicit-test" },
    });
    await registry.awaitHandles({ ids: explicit.id, waitMs: 5000 });
    assert.equal((await registry.read({ id: explicit.id })).text, "explicit");
  } finally {
    await registry.shutdown("quit");
  }
});

test("non-Linux platforms fail clearly instead of returning an empty process tree", () => {
  assert.doesNotThrow(() => assertLinux("linux"));
  assert.throws(() => assertLinux("darwin"), /supports Linux only.*darwin/);
  assert.throws(() => assertLinux("win32"), /supports Linux only.*win32/);
});

test("runtime directories are owner-only", () => {
  const paths = registryPaths(tempCwd(), "private", 7);
  ensureRegistryDirs(paths);
  for (const dir of [paths.root, paths.sessionDir, paths.workspaceDir, paths.requestsDir]) {
    assert.equal(
      statSync(dir).mode & 0o777,
      0o700,
      `${dir} must not be enterable by another local user`,
    );
  }
});

test("registry initialization creates a non-destructive gitignore", () => {
  const paths = registryPaths(tempCwd(), "gitignore", 123);
  ensureRegistryDirs(paths);
  const path = join(paths.root, ".gitignore");
  assert.equal(readFileSync(path, "utf8"), "*\n");
  writeFileSync(path, "custom\n");
  ensureRegistryDirs(paths);
  assert.equal(readFileSync(path, "utf8"), "custom\n", "an existing user rule is never replaced");
});

function writeExecution(
  _paths: RegistryPaths,
  parent: string,
  id: string,
  status: "running" | "completed",
  timestamp: number,
  scope: "session" | "workspace" = "session",
): string {
  const dir = join(parent, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "combined.log"), `${id}\n`);
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({
      version: 1,
      id,
      name: id,
      command: "true",
      cwd: "/tmp",
      scope,
      binding: "pipe",
      status,
      startedAt: timestamp - 1000,
      endedAt: status === "completed" ? timestamp : undefined,
      log: {
        dir,
        stdout: join(dir, "stdout.log"),
        stderr: join(dir, "stderr.log"),
        combined: join(dir, "combined.log"),
      },
      bytes: { stdout: 0, stderr: 0, combined: 0, capReached: false },
      durable: scope === "workspace",
      adoptAttempts: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
  );
  return dir;
}

function writeRequest(paths: RegistryPaths, id: string, createdAt: number): string {
  const path = join(paths.requestsDir, `${id}.json`);
  writeFileSync(path, JSON.stringify({ id, request: id, kind: "start", createdAt }));
  return path;
}

test("GC removes expired terminal history but never running or current-session records", () => {
  const now = Date.now();
  const old = now - 10 * 24 * 60 * 60 * 1000;
  const paths = registryPaths(tempCwd(), "current", 123);
  ensureRegistryDirs(paths);
  const otherSession = join(paths.root, "sessions", "old-999");
  const expiredSession = writeExecution(paths, otherSession, "sh_expired", "completed", old);
  const expiredWorkspace = writeExecution(paths, paths.workspaceDir, "sh_workold", "completed", old, "workspace");
  const runningWorkspace = writeExecution(paths, paths.workspaceDir, "sh_running", "running", old, "workspace");
  const current = writeExecution(paths, paths.sessionDir, "sh_current", "completed", old);
  const requests = [
    writeRequest(paths, "sh_expired", old),
    writeRequest(paths, "sh_workold", old),
    writeRequest(paths, "sh_running", old),
    writeRequest(paths, "sh_current", old),
    writeRequest(paths, "sh_orphan", old),
  ];

  const result = collectRegistryGarbage(paths, { now, retentionMs: 24 * 60 * 60 * 1000 });
  assert.deepEqual(new Set(result.removedExecutions), new Set(["sh_expired", "sh_workold"]));
  assert.equal(existsSync(expiredSession), false);
  assert.equal(existsSync(expiredWorkspace), false);
  assert.equal(existsSync(runningWorkspace), true, "old metadata does not make a running process garbage");
  assert.equal(existsSync(current), true, "the active session keeps its loaded history");
  assert.equal(existsSync(requests[0]), false);
  assert.equal(existsSync(requests[1]), false);
  assert.equal(existsSync(requests[2]), true);
  assert.equal(existsSync(requests[3]), true);
  assert.equal(existsSync(requests[4]), false, "an old orphan request expires");
});

test("GC reclaims a session directory that never ran a command", () => {
  const now = Date.now();
  const paths = registryPaths(tempCwd(), "current", 123);
  ensureRegistryDirs(paths);
  const stale = join(paths.root, "sessions", "old-999");
  const old = new Date(now - 10 * 24 * 60 * 60 * 1000);
  mkdirSync(stale, { recursive: true });
  utimesSync(stale, old, old);

  const result = collectRegistryGarbage(paths, { now, retentionMs: 24 * 60 * 60 * 1000 });
  assert.equal(existsSync(stale), false, "an empty session directory is not history worth keeping");
  assert.equal(result.removedSessionDirs, 1);
  assert.equal(existsSync(paths.sessionDir), true, "the running session keeps its own directory");
});

test("GC count eviction keeps the newest terminal records and observes a grace period", () => {
  const now = Date.now();
  const paths = registryPaths(tempCwd(), "current", 123);
  ensureRegistryDirs(paths);
  const history = join(paths.root, "sessions", "old-999");
  const older = writeExecution(paths, history, "sh_older", "completed", now - 20 * 60 * 1000);
  const newer = writeExecution(paths, history, "sh_newer", "completed", now - 10 * 60 * 1000);
  const fresh = writeExecution(paths, history, "sh_fresh", "completed", now - 1000);

  const result = collectRegistryGarbage(paths, {
    now,
    retentionMs: 24 * 60 * 60 * 1000,
    maxTerminalRecords: 2,
  });
  assert.deepEqual(result.removedExecutions, ["sh_older"]);
  assert.equal(existsSync(older), false);
  assert.equal(existsSync(newer), true);
  assert.equal(existsSync(fresh), true, "count pressure never deletes a fresh record");
});
