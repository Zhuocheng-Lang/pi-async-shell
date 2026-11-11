import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { makeRegistry, sleep, tempCwd } from "./helpers.ts";

test("pty gives the child a terminal and accepts stdin", async () => {
  const registry = makeRegistry(tempCwd("pas-pty-"));
  try {
    const handle = await registry.start({
      command: "test -t 0 && echo tty-yes; read -r line; echo got:$line",
      binding: "pty",
      scope: "session",
    });
    const ready = await registry.awaitHandles({
      ids: handle.id,
      until: { kind: "pattern", regex: "tty-yes" },
      waitMs: 5000,
    });
    assert.equal(ready.timedOutWaiting, false);
    assert.equal(ready.stillRunning.length, 1, "a pattern match is not settlement");

    const sent = await registry.send({ id: handle.id, text: "hello-pty\n", settleMs: 400 });
    assert.equal(sent.wrote, true);

    const result = await registry.awaitHandles({ ids: handle.id, waitMs: 5000 });
    assert.equal(result.settled, true);
    assert.equal(result.outcomes[0]?.status, "completed");

    const view = await registry.read({ id: handle.id, stream: "ptyView" });
    assert.match(view.text, /tty-yes/);
    assert.match(view.text, /got:hello-pty/);
    assert.equal(view.stream, "ptyView");
  } finally {
    await registry.shutdown("quit");
  }
});

test("ptyView is the rendered screen, not the raw stream", async () => {
  const registry = makeRegistry(tempCwd("pas-pty-"));
  try {
    const handle = await registry.start({
      command:
        "printf 'progress 10%%\\rprogress 99%%\\n'; printf '\\033[1;1Hfinal frame\\033[K\\n'; sleep 0.2",
      binding: "pty",
      scope: "session",
    });
    await registry.awaitHandles({ ids: handle.id, waitMs: 20000 });

    const view = await registry.read({ id: handle.id, stream: "ptyView" });
    assert.match(view.text, /final frame/);
    assert.doesNotMatch(view.text, /progress 10%/, "an overwritten frame is not on the screen");
    assert.match(view.note ?? "", /rendered \d+x\d+ terminal screen/);

    const raw = await registry.read({ id: handle.id, stream: "combined" });
    assert.match(raw.text, /progress 10%/, "the byte stream still holds every frame");
  } finally {
    await registry.shutdown("quit");
  }
});

test("pty accepts key chords through shell_send", async () => {
  const registry = makeRegistry(tempCwd("pas-pty-"));
  try {
    const handle = await registry.start({
      command: "read -r line; echo got:$line",
      binding: "pty",
      scope: "session",
    });
    await sleep(250);
    await registry.send({ id: handle.id, text: "abc", keys: ["Enter"], settleMs: 400 });
    const result = await registry.awaitHandles({ ids: handle.id, waitMs: 5000 });
    assert.equal(result.settled, true);
    const view = await registry.read({ id: handle.id, stream: "ptyView" });
    assert.match(view.text, /got:abc/);
  } finally {
    await registry.shutdown("quit");
  }
});

test("a marker file declares readiness out of band", async () => {
  const registry = makeRegistry(tempCwd("pas-pty-"));
  try {
    const handle = await registry.start({
      command: 'sleep 0.2; touch "$PI_ASYNC_SHELL_EXEC_DIR/ready"; sleep 60',
      binding: "pty",
      scope: "session",
    });
    const ready = await registry.awaitHandles({ ids: handle.id, until: { kind: "ready" }, waitMs: 5000 });
    assert.equal(ready.timedOutWaiting, false);
    assert.ok(ready.stillRunning[0]?.readyAt, "readyAt is recorded as a milestone");
  } finally {
    await registry.shutdown("quit");
  }
});

test("a request id makes shell_send replay-safe", async () => {
  const registry = makeRegistry(tempCwd("pas-pty-"));
  try {
    const handle = await registry.start({
      command: "read -r line; echo got:$line; sleep 5",
      binding: "pty",
      scope: "session",
    });
    await sleep(250);
    const first = await registry.send({ id: handle.id, text: "abc\n", request: "send-1", settleMs: 200 });
    assert.equal(first.wrote, true);
    const second = await registry.send({ id: handle.id, text: "zzz\n", request: "send-1", settleMs: 100 });
    assert.equal(second.wrote, false, "a replay must not send a second keystroke");
    const view = await registry.read({ id: handle.id, stream: "ptyView" });
    assert.match(view.text, /got:abc/);
    assert.doesNotMatch(view.text, /got:zzz/);
  } finally {
    await registry.shutdown("quit");
  }
});

test("workspace + pty is a reachable cell, not a coercion", async () => {
  const diagnostics: string[] = [];
  const registry = makeRegistry(tempCwd("pas-pty-"), {
    onDiagnostic: (message) => diagnostics.push(message),
  });
  try {
    const handle = await registry.start({ command: "echo durable-pty", binding: "pty", scope: "workspace" });
    assert.equal(handle.binding, "pty");
    assert.equal(handle.scope, "workspace");
    assert.deepEqual(diagnostics, [], "no binding is coerced any more");
    const result = await registry.awaitHandles({ ids: handle.id, waitMs: 20000 });
    assert.equal(result.outcomes[0]?.status, "completed");
    const combined = await registry.read({ id: handle.id, stream: "combined" });
    assert.match(combined.text, /durable-pty/);
  } finally {
    await registry.shutdown("quit");
  }
});

test("a live pty can be promoted to workspace", async () => {
  const registry = makeRegistry(tempCwd("pas-pty-"));
  try {
    const handle = await registry.start({ command: "sleep 60", binding: "pty", scope: "session" });
    const promoted = await registry.promote({ id: handle.id, to: "workspace" });
    assert.equal(promoted.scope, "workspace");
    assert.equal(existsSync(join(registry.paths.workspaceDir, handle.id)), true);
    await registry.cancel({ ids: handle.id, ladder: "force" });
  } finally {
    await registry.shutdown("quit");
  }
});

test("the pty is sized at spawn time instead of degrading to 0 0", async () => {
  const registry = makeRegistry(tempCwd("pas-pty-"));
  try {
    const handle = await registry.start({ command: "stty size", binding: "pty", scope: "session" });
    const result = await registry.awaitHandles({ ids: handle.id, waitMs: 20000 });
    assert.equal(result.outcomes[0]?.status, "completed");
    const view = await registry.read({ id: handle.id, stream: "ptyView" });
    assert.match(view.text, /^\d+ \d+$/m, "the child sees a real terminal size");
    assert.doesNotMatch(view.text, /^0 0$/m, "a FIFO stdin gives the slave no size of its own");
  } finally {
    await registry.shutdown("quit");
  }
});
