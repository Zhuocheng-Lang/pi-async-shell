/**
 * Cross-process durability for the pty binding.
 *
 * The recipe is only worth its complexity if the PTY really outlives the process
 * that started it. That cannot be tested in-process: the test would have to kill
 * itself. A producer process stands in for Pi, is killed with SIGKILL, and the
 * test then checks the three claims that matter — output keeps landing in the
 * log, the handle is re-adoptable, and stdin still reaches the child.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ShellRegistry } from "../src/core/registry.ts";
import { taggedPids } from "../src/core/identity.ts";
import { acquireWorkspaceLock } from "../src/core/workspace-lock.ts";
import { sleep, tempCwd, waitFor } from "./helpers.ts";

const producer = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "pty-producer.ts");

// The background loop keeps writing; the foreground read proves stdin still
// works after the owner is gone.
const command = "( while :; do echo tick; sleep 0.15; done ) & while read -r line; do echo got:$line; done";
const pipeCommand = "while :; do echo tick; sleep 0.15; done";

interface Record {
  id: string;
  dir: string;
  scope: string;
}

async function startProducer(
  cwd: string,
  mode?: "promote" | "session",
  binding: "pipe" | "pty" = "pty",
): Promise<{ child: ReturnType<typeof spawn>; record: Record; logPath: string }> {
  const child = spawn(process.execPath, [producer, cwd, binding === "pipe" ? pipeCommand : command, ...(mode ? [mode] : []), binding], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (data: Buffer) => {
    output += data.toString("utf8");
  });
  assert.equal(await waitFor(() => output.includes("\n"), 30_000), true, `the producer must report a handle: ${output}`);
  const record = JSON.parse(output.trim().split("\n")[0] as string) as Record;
  return { child, record, logPath: join(record.dir, "combined.log") };
}

function countTicks(path: string): number {
  try {
    return readFileSync(path, "utf8").split("\n").filter((line) => line.includes("tick")).length;
  } catch {
    return 0;
  }
}

async function adoptAndDrive(cwd: string, record: Record, logPath: string, binding: "pipe" | "pty" = "pty"): Promise<void> {
  const adopter = new ShellRegistry({
    cwd,
    sessionId: "adopter",
    env: { ...process.env, PI_ASYNC_SHELL: "/bin/sh" },
  });
  try {
    const lock = acquireWorkspaceLock(adopter.paths, "adopter");
    assert.equal(lock.owned, true, "a dead owner's lock is stale, not held");
    adopter.setWorkspaceOwner(lock.owned, lock.holder?.pid);

    const adopted = await adopter.adoptWorkspace();
    assert.deepEqual(adopted.adopted, [record.id], "the execution must be re-adoptable");
    assert.deepEqual(adopted.lost, []);

    if (binding === "pty") {
      const sent = await adopter.send({ id: record.id, text: "after-restart\n", settleMs: 400 });
      assert.equal(sent.wrote, true, "stdin must still reach the child through the FIFO");
      assert.equal(
        await waitFor(() => readFileSync(logPath, "utf8").includes("got:after-restart"), 10_000),
        true,
        "the adopted handle must be able to drive the terminal",
      );
    } else {
      const before = countTicks(logPath);
      assert.equal(await waitFor(() => countTicks(logPath) > before, 10_000), true);
    }

    const cancelled = await adopter.cancel({ ids: record.id, ladder: "force" });
    assert.equal(cancelled[0]?.verifiedGone, true, "the adopted tree must be reapable");
  } finally {
    await adopter.shutdown("quit");
  }
}

test("a workspace pty survives a hard Pi exit and is re-adopted", { timeout: 90_000 }, async () => {
  const cwd = tempCwd("pas-pty-durable-");
  const { child, record, logPath } = await startProducer(cwd);
  assert.equal(record.scope, "workspace");
  assert.equal(await waitFor(() => countTicks(logPath) >= 3, 15_000), true, "the pty must produce output");

  // The owner dies. Nothing in the data path belonged to it, so the PTY keeps
  // writing: this is the leak the old spawn recipe left behind, now intentional.
  child.kill("SIGKILL");
  const before = countTicks(logPath);
  assert.equal(await waitFor(() => countTicks(logPath) > before, 10_000), true, "output must keep landing in the log");

  await adoptAndDrive(cwd, record, logPath);
});

test("a promoted pty survives the Pi that promoted it", { timeout: 90_000 }, async () => {
  const cwd = tempCwd("pas-pty-promote-");
  const { child, record, logPath } = await startProducer(cwd, "promote");
  assert.equal(record.scope, "workspace", "promotion widened the scope");
  assert.equal(await waitFor(() => countTicks(logPath) >= 3, 15_000), true, "the pty must produce output");

  // The wrapper was started with an owner watch. Promotion released it, so the
  // SIGKILL below must not tear the PTY down — that release is the whole point
  // of the retracted R2.
  child.kill("SIGKILL");
  const before = countTicks(logPath);
  assert.equal(await waitFor(() => countTicks(logPath) > before, 10_000), true, "a promoted pty must outlive its promoter");

  await adoptAndDrive(cwd, record, logPath);
});

test("a promoted default pipe survives the Pi that promoted it", { timeout: 90_000 }, async () => {
  const cwd = tempCwd("pas-pipe-promote-");
  const { child, record, logPath } = await startProducer(cwd, "promote", "pipe");
  assert.equal(record.scope, "workspace");
  assert.equal(await waitFor(() => countTicks(logPath) >= 3, 15_000), true);

  child.kill("SIGKILL");
  const before = countTicks(logPath);
  assert.equal(await waitFor(() => countTicks(logPath) > before, 10_000), true, "the released pipe supervisor must keep writing");

  await adoptAndDrive(cwd, record, logPath, "pipe");
});

test("an unpromoted session pty stops when its owner is killed", { timeout: 30_000 }, async () => {
  const cwd = tempCwd("pas-pty-owner-loss-");
  const { child, record, logPath } = await startProducer(cwd, "session", "pty");
  assert.equal(record.scope, "session");
  assert.equal(await waitFor(() => countTicks(logPath) >= 3, 20_000), true);

  child.kill("SIGKILL");
  // Prove the tagged tree is gone instead of inferring it from a quiet log.
  assert.equal(await waitFor(() => taggedPids(record.id).length === 0, 15_000), true, "fd 3 EOF must tear down the terminal tree");
  const before = countTicks(logPath);
  await sleep(150);
  assert.equal(countTicks(logPath), before, "a dead terminal must not keep recording ticks");
});

test("an unpromoted session pipe stops when its owner is killed", { timeout: 30_000 }, async () => {
  const cwd = tempCwd("pas-pipe-owner-loss-");
  const { child, record, logPath } = await startProducer(cwd, "session", "pipe");
  assert.equal(record.scope, "session");
  assert.equal(await waitFor(() => countTicks(logPath) >= 3, 15_000), true);

  child.kill("SIGKILL");
  assert.equal(await waitFor(() => taggedPids(record.id).length === 0, 15_000), true, "fd 3 EOF must tear down the pipe tree");
  const before = countTicks(logPath);
  await sleep(150);
  assert.equal(countTicks(logPath), before, "a dead pipe execution must not keep recording ticks");
});
