import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fence, verifyGone } from "../src/core/containment.ts";
import { processIdentity, readProcStat, taggedPids } from "../src/core/identity.ts";
import { makeRegistry, sleep, tempCwd, waitFor } from "./helpers.ts";
import type { CompletionRecord } from "../src/core/types.ts";

test("pipe separates stdout and stderr and records the exit code", async () => {
  const registry = makeRegistry(tempCwd());
  try {
    const handle = await registry.start({
      command: "echo out-line; echo err-line >&2; exit 3",
      scope: "session",
    });
    const result = await registry.awaitHandles({ ids: handle.id, waitMs: 5000 });
    assert.equal(result.settled, true);
    assert.equal(result.outcomes[0]?.status, "failed");
    assert.equal(result.outcomes[0]?.exitCode, 3);

    const stdout = await registry.read({ id: handle.id, stream: "stdout" });
    const stderr = await registry.read({ id: handle.id, stream: "stderr" });
    const combined = await registry.read({ id: handle.id, stream: "combined" });
    assert.equal(stdout.text, "out-line");
    assert.equal(stderr.text, "err-line");
    assert.equal(combined.text, "out-line\nerr-line");
  } finally {
    await registry.shutdown("quit");
  }
});

for (const scope of ["session", "workspace"] as const) {
test(`the ${scope} pipe log cap drains instead of killing or blocking the child`, async () => {
  const cwd = tempCwd();
  const registry = makeRegistry(cwd, {
    env: { ...process.env, PI_ASYNC_SHELL: "/bin/sh", PI_ASYNC_SHELL_MAX_LOG_BYTES: "65536" },
  });
  try {
    // 300 KiB into a 64 KiB cap. A cap implemented as "stop reading" would block
    // the child on a full pipe and never reach the echo.
    const handle = await registry.start({
      command: "yes x | head -c 300000; echo finished",
      scope,
    });
    const result = await registry.awaitHandles({ ids: handle.id, waitMs: 15000 });
    assert.equal(result.settled, true, "the child must not hang on a full pipe");
    assert.equal(result.outcomes[0]?.status, "completed");
    assert.equal(result.outcomes[0]?.bytes.capReached, true);
    assert.ok((result.outcomes[0]?.bytes.combined ?? 0) <= 65536);

    const tail = await registry.read({ id: handle.id, mode: "tail", lines: 5 });
    assert.ok(tail.totalBytes <= 65536, "the durable log stops at the cap");
    assert.match(tail.text, /x/, "the retained bytes are the start of the stream");
  } finally {
    await registry.shutdown("quit");
  }
});
}

test("await mode=all waits for every handle", async () => {
  const registry = makeRegistry(tempCwd());
  try {
    const fast = await registry.start({ command: "sleep 0.1; echo fast", scope: "session" });
    const slow = await registry.start({ command: "sleep 0.6; echo slow", scope: "session" });
    const started = Date.now();
    const result = await registry.awaitHandles({ ids: [fast.id, slow.id], mode: "all", waitMs: 5000 });
    const elapsed = Date.now() - started;
    assert.equal(result.settled, true);
    assert.equal(result.outcomes.length, 2);
    assert.ok(elapsed >= 500, `expected to wait for the slow handle, waited ${elapsed}ms`);
  } finally {
    await registry.shutdown("quit");
  }
});

test("await mode=any returns on the first settlement", async () => {
  const registry = makeRegistry(tempCwd());
  try {
    const fast = await registry.start({ command: "sleep 0.1; echo fast", scope: "session" });
    const slow = await registry.start({ command: "sleep 5; echo slow", scope: "session" });
    const started = Date.now();
    const result = await registry.awaitHandles({ ids: [fast.id, slow.id], mode: "any", waitMs: 5000 });
    const elapsed = Date.now() - started;
    assert.equal(result.outcomes.length, 1);
    assert.equal(result.outcomes[0]?.id, fast.id);
    assert.equal(result.stillRunning.length, 1);
    assert.ok(elapsed < 2000, `expected an early return, waited ${elapsed}ms`);
  } finally {
    await registry.shutdown("quit");
  }
});

test("an expired await does not kill the work", async () => {
  const registry = makeRegistry(tempCwd());
  try {
    const handle = await registry.start({ command: "sleep 60", scope: "session" });
    const result = await registry.awaitHandles({ ids: handle.id, waitMs: 300 });
    assert.equal(result.timedOutWaiting, true);
    assert.equal(result.settled, false);
    assert.equal(result.stillRunning.length, 1);
    assert.ok(taggedPids(handle.id).length > 0, "the process must still be running");
  } finally {
    await registry.shutdown("quit");
  }
});

test("aborting an await detaches the waiter only", async () => {
  const registry = makeRegistry(tempCwd());
  try {
    const handle = await registry.start({ command: "sleep 60", scope: "session" });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const result = await registry.awaitHandles({ ids: handle.id, waitMs: 5000 }, controller.signal);
    assert.equal(result.timedOutWaiting, true);
    assert.ok(taggedPids(handle.id).length > 0, "aborting a wait must not cancel the producer");
    const status = registry.status({ id: handle.id });
    assert.equal(status.handles[0]?.status, "running");
  } finally {
    await registry.shutdown("quit");
  }
});

test("an await pattern observes only the selected stream", async () => {
  const registry = makeRegistry(tempCwd());
  try {
    const onStderr = await registry.start({ command: "echo STREAM-READY >&2; sleep 60", scope: "session" });
    const matched = await registry.awaitHandles({
      ids: onStderr.id,
      until: { kind: "pattern", regex: "STREAM-READY", stream: "stderr" },
      waitMs: 5000,
    });
    assert.equal(matched.matched?.line, "STREAM-READY");

    const wrongStream = await registry.awaitHandles({
      ids: onStderr.id,
      until: { kind: "pattern", regex: "STREAM-READY", stream: "stdout" },
      waitMs: 300,
    });
    assert.equal(wrongStream.timedOutWaiting, true, "stderr does not satisfy a stdout pattern");

    const onStdout = await registry.start({ command: "echo STREAM-READY; sleep 60", scope: "session" });
    const stdout = await registry.awaitHandles({
      ids: onStdout.id,
      until: { kind: "pattern", regex: "STREAM-READY", stream: "stdout" },
      waitMs: 5000,
    });
    assert.equal(stdout.matched?.line, "STREAM-READY");
  } finally {
    await registry.shutdown("quit");
  }
});

test("a pattern wait with since=now cannot re-match an answered prompt", async () => {
  const registry = makeRegistry(tempCwd());
  try {
    const handle = await registry.start({
      command: "echo ready-one; sleep 0.3; echo ready-two; sleep 60",
      scope: "session",
    });
    const first = await registry.awaitHandles({
      ids: handle.id,
      until: { kind: "pattern", regex: "ready-two", since: 0 },
      waitMs: 5000,
    });
    assert.equal(first.matched?.line, "ready-two");

    const second = await registry.awaitHandles({
      ids: handle.id,
      until: { kind: "pattern", regex: "ready-two", since: "now" },
      waitMs: 400,
    });
    assert.equal(second.matched, undefined);
    assert.equal(second.timedOutWaiting, true);
  } finally {
    await registry.shutdown("quit");
  }
});

test("an await pattern matches a prompt before a newline arrives", async () => {
  const registry = makeRegistry(tempCwd());
  try {
    const handle = await registry.start({ command: 'printf "Proceed? "; sleep 60', binding: "pty" });
    const result = await registry.awaitHandles({
      ids: handle.id,
      until: { kind: "pattern", regex: "Proceed\\?" },
      waitMs: 2000,
    });
    assert.equal(result.timedOutWaiting, false);
    assert.equal(result.matched?.line, "Proceed? ");
    assert.equal(result.stillRunning.length, 1);
  } finally {
    await registry.shutdown("quit");
  }
});

test("cancel proves the tree is gone, including a setsid escapee", async () => {
  const registry = makeRegistry(tempCwd());
  try {
    const handle = await registry.start({
      command: "setsid sleep 60 & echo escapee-started; sleep 60",
      scope: "session",
    });
    assert.equal(await waitFor(() => taggedPids(handle.id).length >= 2, 5000), true);
    const results = await registry.cancel({ ids: handle.id, ladder: "force" });
    assert.equal(results[0]?.status, "cancelled");
    assert.equal(results[0]?.verifiedGone, true);
    assert.deepEqual(taggedPids(handle.id), []);
  } finally {
    await registry.shutdown("quit");
  }
});

test("the fence reaches a child that cleared its env and lost its parent", async () => {
  // The adversarial shape: the grandchild has no tag (`env -i`), and once the
  // shell between it and Pi exits it is reparented to init, so the ppid walk
  // cannot see it. It never calls setsid, so its process group still names it.
  const pidFile = join(tempCwd("pas-fence-"), "escapee.pid");
  const child = spawn("/bin/sh", ["-c", `env -i /bin/sh -c 'echo $$ > ${pidFile}; sleep 60' &`], {
    detached: true,
    stdio: "ignore",
  });
  let escapee = 0;
  try {
    const identity = processIdentity(child.pid as number);
    assert.ok(identity);
    assert.equal(await waitFor(() => existsSync(pidFile), 5000), true, "the escapee reported its pid");
    escapee = Number(readFileSync(pidFile, "utf8").trim());
    assert.ok(escapee > 1);
    // Orphans are reparented to the nearest subreaper, which is not Pi, so the
    // ppid walk no longer connects the escapee to the execution.
    assert.equal(
      await waitFor(() => {
        const stat = readProcStat(escapee);
        return Boolean(stat) && stat?.ppid !== identity.pid;
      }, 5000),
      true,
      "the ppid edge is gone",
    );
    assert.deepEqual(taggedPids("pas-no-such-tag"), []);

    const groups = [{ pgid: identity.pgid as number, since: identity.start }];
    const before = await verifyGone("pas-no-such-tag", [identity], groups);
    assert.equal(before.gone, false, "an env-cleared, reparented child is still visible");
    assert.ok(before.remaining.includes(escapee));

    const result = await fence({ tag: "pas-no-such-tag", identities: [identity], groups, deadlineMs: 3000 });
    assert.equal(result.ok, true);
    const after = readProcStat(escapee);
    assert.ok(after === undefined || after.state === "Z" || after.state === "X", "the escapee was killed");
  } finally {
    // pid 0 would signal this whole process group; never pass it to kill(2).
    if (escapee > 1) {
      try {
        process.kill(escapee, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
});

test("graceful cancel uses SIGTERM before the fence", async () => {
  const registry = makeRegistry(tempCwd());
  try {
    const handle = await registry.start({
      command: "trap 'echo got-term; exit 0' TERM; sleep 60",
      scope: "session",
    });
    await sleep(200);
    const results = await registry.cancel({ ids: handle.id, ladder: "graceful", graceMs: 3000 });
    assert.equal(results[0]?.status, "cancelled");
    assert.equal(results[0]?.verifiedGone, true);
    const log = await registry.read({ id: handle.id, stream: "combined" });
    assert.match(log.text, /got-term/);
  } finally {
    await registry.shutdown("quit");
  }
});

test("the ready marker works without any shell_start readiness declaration", async () => {
  const registry = makeRegistry(tempCwd());
  try {
    const handle = await registry.start({ command: 'touch "$PI_ASYNC_SHELL_EXEC_DIR/ready"; sleep 60' });
    const result = await registry.awaitHandles({ ids: handle.id, until: { kind: "ready" }, waitMs: 5000 });
    assert.equal(result.timedOutWaiting, false);
    assert.ok(result.stillRunning[0]?.readyAt);
  } finally {
    await registry.shutdown("quit");
  }
});

test("turn scope is rejected instead of acquiring settle-time semantics", async () => {
  const registry = makeRegistry(tempCwd());
  try {
    await assert.rejects(
      () => registry.start({ command: "sleep 60", scope: "turn" as never }),
      /scope must be session or workspace/,
    );
    assert.equal(registry.status().running, 0);
  } finally {
    await registry.shutdown("quit");
  }
});

test("a request id makes shell_start replay-safe", async () => {
  const registry = makeRegistry(tempCwd());
  try {
    const first = await registry.start({ command: "echo once", request: "req-1", scope: "session" });
    const second = await registry.start({ command: "echo twice", request: "req-1", scope: "session" });
    assert.equal(second.id, first.id);
    assert.equal(registry.status().handles.filter((handle) => handle.command.includes("echo")).length, 1);
  } finally {
    await registry.shutdown("quit");
  }
});

test("timeoutSeconds settles as timed-out through the ladder", async () => {
  const registry = makeRegistry(tempCwd());
  try {
    const handle = await registry.start({ command: "sleep 60", timeoutSeconds: 1, scope: "session" });
    const result = await registry.awaitHandles({ ids: handle.id, waitMs: 15000 });
    assert.equal(result.settled, true);
    assert.equal(result.outcomes[0]?.status, "timed-out");
    const tagged = taggedPids(handle.id);
    assert.deepEqual(
      tagged,
      [],
      JSON.stringify({
        tagged: tagged.map((pid) => ({ pid, stat: readProcStat(pid) })),
        meta: JSON.parse(readFileSync(join(handle.log.dir, "meta.json"), "utf8")),
        exit: JSON.parse(readFileSync(join(handle.log.dir, "exit.json"), "utf8")),
      }),
    );
  } finally {
    await registry.shutdown("quit");
  }
});

test("promotion widens default pipe and pty sessions to workspace", async () => {
  const registry = makeRegistry(tempCwd());
  try {
    const handle = await registry.start({ command: "sleep 60", scope: "session" });
    const promoted = await registry.promote({ id: handle.id, to: "workspace" });
    assert.equal(promoted.binding, "pipe");
    assert.equal(promoted.scope, "workspace");

    const pty = await registry.start({ command: "sleep 60", binding: "pty", scope: "session" });
    const widened = await registry.promote({ id: pty.id, to: "workspace" });
    assert.equal(widened.scope, "workspace");
    await registry.cancel({ ids: [handle.id, pty.id], ladder: "force" });
  } finally {
    await registry.shutdown("quit");
  }
});

test("shell_send refuses on a pipe binding", async () => {
  const registry = makeRegistry(tempCwd());
  try {
    const handle = await registry.start({ command: "sleep 60", scope: "session" });
    await assert.rejects(() => registry.send({ id: handle.id, text: "x" }), /refuses on pipe/);
  } finally {
    await registry.shutdown("quit");
  }
});

test("shell_read rejects a pre-aborted signal before opening the log", async () => {
  const registry = makeRegistry(tempCwd());
  try {
    const handle = await registry.start({ command: "echo hi", scope: "session" });
    await registry.awaitHandles({ ids: handle.id, waitMs: 5000 });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => registry.read({ id: handle.id }, controller.signal), /aborted/);
  } finally {
    await registry.shutdown("quit");
  }
});

test("a completion record carries the delivery choice", async () => {
  const records: CompletionRecord[] = [];
  const registry = makeRegistry(tempCwd(), { onSettle: (_handle, record) => records.push(record) });
  try {
    const steered = await registry.start({ command: "echo steered", scope: "session" });
    const held = await registry.start({ command: "echo held", scope: "session", delivery: "settle" });
    await registry.awaitHandles({ ids: [steered.id, held.id], waitMs: 5000 });
    assert.equal(await waitFor(() => records.length === 2), true, "both records must settle");
    assert.equal(records.find((record) => record.id === steered.id)?.delivery, "steer");
    assert.equal(records.find((record) => record.id === held.id)?.delivery, "settle");
  } finally {
    await registry.shutdown("quit");
  }
});

test("unknown handles are refused with a clear message", async () => {
  const registry = makeRegistry(tempCwd());
  try {
    await assert.rejects(() => registry.read({ id: "sh_deadbeef" }), /unknown handle/);
    await assert.rejects(() => registry.start({ command: "   " }), /requires a command/);
  } finally {
    await registry.shutdown("quit");
  }
});

test("an await pattern is refused when it can backtrack catastrophically", async () => {
  const registry = makeRegistry(tempCwd());
  try {
    const handle = await registry.start({ command: "echo ready; sleep 5", scope: "session" });
    await assert.rejects(
      () => registry.awaitHandles({ ids: handle.id, until: { kind: "pattern", regex: "(x+)+y" }, waitMs: 100 }),
      /nested quantifiers/,
    );
  } finally {
    await registry.shutdown("quit");
  }
});
