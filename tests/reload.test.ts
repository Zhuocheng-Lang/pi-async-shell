import assert from "node:assert/strict";
import { test } from "node:test";
import { claimHandoff, discardHandoff, handoffCount, handoffKey, publishHandoff } from "../src/core/reload-hub.ts";
import { makeRegistry, sleep, tempCwd } from "./helpers.ts";

test("a handoff is claimed once and only before its deadline", async () => {
  const key = handoffKey(process.pid, "s1", "/tmp/x");
  publishHandoff(key, { marker: 1 }, 5000, () => undefined);
  assert.equal(handoffCount(), 1);
  assert.deepEqual(claimHandoff(key), { marker: 1 });
  assert.equal(claimHandoff(key), undefined);
  discardHandoff(key);
});

test("an unclaimed handoff expires and runs its cleanup", async () => {
  const key = handoffKey(process.pid, "s2", "/tmp/y");
  let expired = false;
  publishHandoff(key, { marker: 2 }, 120, () => {
    expired = true;
  });
  await sleep(300);
  assert.equal(expired, true);
  assert.equal(claimHandoff(key), undefined);
});

test("an abandoned registry cancels session handles but leaves workspace handles adoptable", async () => {
  const registry = makeRegistry(tempCwd(), { sessionId: "abandoned" });
  registry.setWorkspaceOwner(true);
  const session = await registry.start({ command: "sleep 60", scope: "session" });
  const workspace = await registry.start({ command: "sleep 60", scope: "workspace" });
  try {
    await registry.abandonHandoff();
    assert.equal(registry.status({ id: session.id }).handles[0]?.status, "cancelled");
    assert.equal(registry.status({ id: workspace.id }).handles[0]?.status, "running");
    await registry.cancel({ ids: workspace.id, ladder: "force" });
  } finally {
    await registry.shutdown("quit");
  }
});

test("a claimed registry keeps its live handles across the reload", async () => {
  const cwd = tempCwd();
  const registry = makeRegistry(cwd, { sessionId: "reload" });
  const key = handoffKey(process.pid, "reload", cwd);
  try {
    const handle = await registry.start({ command: "sleep 60", scope: "session" });
    publishHandoff(key, registry, 5000, () => undefined);
    const claimed = claimHandoff<typeof registry>(key);
    assert.equal(claimed, registry);
    claimed?.rebind({ onChange: () => undefined });
    const status = claimed?.status({ id: handle.id });
    assert.equal(status?.handles[0]?.status, "running");
    await claimed?.cancel({ ids: handle.id, ladder: "force" });
  } finally {
    await registry.shutdown("quit");
  }
});
