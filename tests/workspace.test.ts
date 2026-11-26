import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { bootId } from "../src/core/identity.ts";
import { acquireWorkspaceLock, readLock, releaseWorkspaceLock } from "../src/core/workspace-lock.ts";
import { makeRegistry, tempCwd, waitFor } from "./helpers.ts";

const producerPath = new URL("./fixtures/pty-producer.ts", import.meta.url).pathname;
const producerCommand = "sh -c 'sleep 0.8; echo workspace-done'";

function writeRunningWorkspaceRecord(
  registry: ReturnType<typeof makeRegistry>,
  id: string,
  adoptAttempts = 0,
): void {
  const dir = join(registry.paths.workspaceDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({
      version: 1,
      id,
      name: "ghost",
      command: "sleep 999",
      cwd: registry.cwd,
      scope: "workspace",
      binding: "pipe",
      status: "running",
      startedAt: Date.now() - 60_000,
      log: {
        dir,
        stdout: join(dir, "stdout.log"),
        stderr: join(dir, "stderr.log"),
        combined: join(dir, "combined.log"),
      },
      bytes: { stdout: 0, stderr: 0, combined: 0, capReached: false },
      identity: { bootId: bootId(), pid: 999_999, start: 1 },
      durable: true,
      adoptAttempts,
      createdAt: Date.now() - 60_000,
      updatedAt: Date.now() - 60_000,
    }),
  );
}

test("a workspace execution survives its parent and is re-adopted", async () => {
  const cwd = tempCwd("pas-ws-");
  const produced = spawnSync(process.execPath, [producerPath, cwd, producerCommand, "exit", "pipe"], { encoding: "utf8", timeout: 30000 });
  assert.equal(produced.status, 0, produced.stderr);
  const record = JSON.parse(produced.stdout.trim()) as { id: string };
  assert.match(record.id, /^sh_[0-9a-f]{8}$/);

  const registry = makeRegistry(cwd, { sessionId: "adopter" });
  registry.setWorkspaceOwner(true);
  try {
    const adopted = await registry.adoptWorkspace();
    assert.deepEqual(adopted.adopted, [record.id]);

    assert.equal(
      await waitFor(() => registry.status({ id: record.id }).handles[0]?.status === "completed", 10000),
      true,
    );
    const read = await registry.read({ id: record.id, stream: "combined" });
    assert.match(read.text, /workspace-done/);
  } finally {
    await registry.shutdown("quit");
  }
});

test("a workspace execution that exited while Pi was away is finalized on adoption", async () => {
  const cwd = tempCwd("pas-ws-");
  const produced = spawnSync(process.execPath, [producerPath, cwd, "echo finalized-workspace", "exit", "pipe"], {
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(produced.status, 0, produced.stderr);
  const record = JSON.parse(produced.stdout.trim()) as { id: string; dir: string };
  assert.equal(await waitFor(() => existsSync(join(record.dir, "exit.json")), 10_000), true);

  const registry = makeRegistry(cwd, { sessionId: "adopter" });
  registry.setWorkspaceOwner(true);
  try {
    const adopted = await registry.adoptWorkspace();
    assert.deepEqual(adopted.finalized, [record.id]);
    assert.deepEqual(adopted.adopted, []);
    assert.equal(registry.status({ id: record.id }).handles[0]?.status, "completed");
    assert.match((await registry.read({ id: record.id })).text, /finalized-workspace/);
  } finally {
    await registry.shutdown("quit");
  }
});

test("an unprovable workspace record becomes lost, never completed", async () => {
  const cwd = tempCwd("pas-ws-");
  const registry = makeRegistry(cwd, { sessionId: "adopter" });
  registry.setWorkspaceOwner(true);
  try {
    writeRunningWorkspaceRecord(registry, "sh_deadbeef");
    const adopted = await registry.adoptWorkspace();
    assert.deepEqual(adopted.lost, ["sh_deadbeef"]);
    assert.equal(registry.status({ id: "sh_deadbeef" }).handles[0]?.status, "lost");
  } finally {
    await registry.shutdown("quit");
  }
});

test("adoption stops at the restart limit and records the reason", async () => {
  const registry = makeRegistry(tempCwd("pas-ws-"), { sessionId: "adopter" });
  registry.setWorkspaceOwner(true);
  try {
    writeRunningWorkspaceRecord(registry, "sh_restart", 5);
    const adopted = await registry.adoptWorkspace();
    assert.deepEqual(adopted.lost, ["sh_restart"]);
    const handle = registry.status({ id: "sh_restart" }).handles[0];
    assert.equal(handle?.status, "lost");
    assert.match(handle?.error ?? "", /restart limit exceeded/);
  } finally {
    await registry.shutdown("quit");
  }
});

test("one writer owns the workspace; a second process is read-only", async () => {
  const cwd = tempCwd("pas-ws-");
  const owner = makeRegistry(cwd, { sessionId: "owner" });
  const observer = makeRegistry(cwd, { sessionId: "observer" });
  try {
    const first = acquireWorkspaceLock(owner.paths, "owner");
    assert.equal(first.owned, true);
    assert.equal(readLock(owner.paths)?.pid, process.pid);

    const second = acquireWorkspaceLock(observer.paths, "observer");
    assert.equal(second.owned, false);
    assert.equal(second.holder?.sessionId, "owner");
    observer.setWorkspaceOwner(second.owned, second.holder?.pid);
    assert.equal(observer.status().workspaceOwner, false);
  } finally {
    releaseWorkspaceLock(owner.paths);
    await owner.shutdown("quit");
    await observer.shutdown("quit");
  }
});

test("workspace locks recover stale or corrupt holders and never release another pid", async () => {
  const registry = makeRegistry(tempCwd("pas-ws-"), { sessionId: "lock-test" });
  try {
    writeFileSync(
      registry.paths.lockFile,
      JSON.stringify({ bootId: bootId(), pid: 999_999, start: 1, sessionId: "dead", acquiredAt: 1 }),
    );
    const stale = acquireWorkspaceLock(registry.paths, "lock-test");
    assert.equal(stale.owned, true, "a dead holder cannot keep the lock");
    releaseWorkspaceLock(registry.paths);

    writeFileSync(registry.paths.lockFile, "{");
    const corrupt = acquireWorkspaceLock(registry.paths, "lock-test");
    assert.equal(corrupt.owned, true, "a torn lock is stale by definition");

    const foreignPid = process.pid + 1;
    writeFileSync(
      registry.paths.lockFile,
      JSON.stringify({ bootId: bootId(), pid: foreignPid, start: 1, sessionId: "other", acquiredAt: 1 }),
    );
    releaseWorkspaceLock(registry.paths);
    assert.equal(readLock(registry.paths)?.pid, foreignPid, "a non-holder must not unlink the lock");
  } finally {
    await registry.shutdown("quit");
  }
});

test("a read-only observer never adopts workspace handles", async () => {
  const cwd = tempCwd("pas-ws-");
  const producer = spawnSync(process.execPath, [producerPath, cwd, producerCommand, "exit", "pipe"], { encoding: "utf8", timeout: 30000 });
  assert.equal(producer.status, 0, producer.stderr);
  const registry = makeRegistry(cwd, { sessionId: "observer" });
  registry.setWorkspaceOwner(false, 999);
  try {
    const adopted = await registry.adoptWorkspace();
    assert.deepEqual(adopted, { adopted: [], lost: [], finalized: [] });
    // Reading the record is still allowed.
    const records = registry.status().handles;
    assert.equal(records.length, 1);
  } finally {
    await registry.shutdown("quit");
  }
});

test("a read-only observer can inspect but cannot mutate workspace executions", async () => {
  const cwd = tempCwd("pas-ws-");
  const owner = makeRegistry(cwd, { sessionId: "owner" });
  owner.setWorkspaceOwner(true);
  const observer = makeRegistry(cwd, { sessionId: "observer" });
  observer.setWorkspaceOwner(false, process.pid);
  try {
    const handle = await owner.start({ command: "sleep 60", binding: "pty", scope: "workspace" });
    await assert.rejects(
      () => observer.start({ command: "echo must-not-run", scope: "workspace" }),
      /writer lock|read-only/,
    );

    const ownSession = await observer.start({ command: "sleep 60", scope: "session" });
    await assert.rejects(() => observer.promote({ id: ownSession.id }), /writer lock|read-only/);
    await assert.rejects(() => observer.send({ id: handle.id, text: "x" }), /writer lock|read-only/);
    await assert.rejects(() => observer.cancel({ ids: handle.id, ladder: "force" }), /writer lock|read-only/);
    await assert.doesNotReject(() => observer.read({ id: handle.id }));

    observer.setWorkspaceOwner(true);
    await observer.cancel({ ids: ownSession.id, ladder: "force" });
    await owner.cancel({ ids: handle.id, ladder: "force" });
  } finally {
    await observer.shutdown("quit");
    await owner.shutdown("quit");
  }
});

test("a workspace completion an await reported is not surfaced again", async () => {
  const cwd = tempCwd("pas-ws-");
  const registry = makeRegistry(cwd, { sessionId: "awaiter" });
  registry.setWorkspaceOwner(true);
  try {
    const awaited = await registry.start({
      command: "echo awaited-workspace",
      scope: "workspace",
      notifyOnCompletion: true,
    });
    const outcome = await registry.awaitHandles({ ids: awaited.id, waitMs: 20_000 });
    assert.equal(outcome.settled, true);
    // The tool result was the delivery, so the record must not be offered again.
    // The flag has to reach the sealed record, because the scan reads meta.json
    // rather than this process's memory.
    const metaPath = join(registry.paths.workspaceDir, awaited.id, "meta.json");
    assert.equal(
      await waitFor(() => {
        try {
          return JSON.parse(readFileSync(metaPath, "utf8")).consumedByAwait === true;
        } catch {
          return false;
        }
      }, 10_000),
      true,
      "the consumed flag must be persisted",
    );
    assert.deepEqual(registry.workspaceCompletions(), [], "an awaited record is not offered again");
    const marker = JSON.parse(
      readFileSync(join(registry.paths.workspaceDir, awaited.id, ".surfaced"), "utf8"),
    ) as { reason?: string };
    assert.equal(marker.reason, "consumedByAwait");

    // A record nobody awaited is still surfaced, exactly once.
    const unwatched = await registry.start({
      command: "echo unwatched-workspace",
      scope: "workspace",
      notifyOnCompletion: true,
    });
    let surfaced: string[] = [];
    assert.equal(
      await waitFor(() => {
        surfaced = registry.workspaceCompletions().map((record) => record.id);
        return surfaced.length > 0;
      }, 20_000),
      true,
      "an unawaited record must still be surfaced",
    );
    assert.deepEqual(surfaced, [unwatched.id]);
    assert.deepEqual(registry.workspaceCompletions(), [], "a surfaced record is not offered twice");
  } finally {
    await registry.shutdown("quit");
  }
});
