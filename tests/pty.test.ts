import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { keyToBytes } from "../src/core/registry.ts";
import { makeRegistry, sleep, tempCwd, waitFor } from "./helpers.ts";

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

test("a pty does not hand its command an ignored SIGINT", async () => {
  const registry = makeRegistry(tempCwd("pas-pty-"));
  try {
    // POSIX gives the child of an asynchronous list SIG_IGN for INT and QUIT, and
    // a non-interactive shell cannot reset what it inherited as ignored. A
    // backgrounded script(1) would therefore put an unkillable ^C in front of the
    // command, on every host whose /bin/sh honours that rule.
    const handle = await registry.start({
      command:
        'while read -r key value; do if [ "$key" = "SigIgn:" ]; then printf "%s\\n" "$value" > "$PI_ASYNC_SHELL_EXEC_DIR/sigign.txt"; fi; done < /proc/self/status',
      binding: "pty",
      scope: "session",
    });
    const path = join(handle.log.dir, "sigign.txt");
    assert.equal(await waitFor(() => existsSync(path), 8000), true, "the command must report its own mask");
    const mask = Number.parseInt(readFileSync(path, "utf8").trim(), 16);
    assert.equal(mask & 0x2, 0, "SIGINT must keep its default disposition, or ^C cannot reach the group");
  } finally {
    await registry.shutdown("quit");
  }
});

test("a pty cancel interrupts the terminal instead of waiting out the grace period", async () => {
  const registry = makeRegistry(tempCwd("pas-pty-"));
  try {
    const handle = await registry.start({ command: "cat", binding: "pty", scope: "session" });
    await sleep(400);
    const started = Date.now();
    const results = await registry.cancel({ ids: handle.id, ladder: "graceful", graceMs: 3000 });
    const elapsed = Date.now() - started;
    assert.equal(results[0]?.status, "cancelled");
    assert.ok(elapsed < 1500, `graceful cancel took ${elapsed} ms: the interrupt never reached the terminal`);
  } finally {
    await registry.shutdown("quit");
  }
});

test("a pty has one stream, and a stderr request says so instead of timing out", async () => {
  const registry = makeRegistry(tempCwd("pas-pty-"));
  try {
    const handle = await registry.start({
      command: "echo to-stderr >&2; sleep 5",
      binding: "pty",
      scope: "session",
    });
    const matched = await registry.awaitHandles({
      ids: handle.id,
      until: { kind: "pattern", regex: "to-stderr", stream: "stderr" },
      waitMs: 3000,
    });
    assert.equal(matched.timedOutWaiting, false, "a stderr wait on a pty observes the recording");
    assert.match(matched.note ?? "", /no separate stderr/);
    const read = await registry.read({ id: handle.id, stream: "stderr" });
    assert.equal(read.stream, "combined", "the read agrees with the wait instead of returning an empty file");
    assert.match(read.text, /to-stderr/);
    assert.match(read.note ?? "", /no separate stderr/);
  } finally {
    await registry.shutdown("quit");
  }
});

test("a start request key and a send request key are separate namespaces", async () => {
  const registry = makeRegistry(tempCwd("pas-pty-"));
  try {
    const handle = await registry.start({
      command: "read -r line; echo got:$line; sleep 5",
      binding: "pty",
      scope: "session",
      request: "shared-key",
    });
    await sleep(250);
    const sent = await registry.send({ id: handle.id, text: "abc\n", request: "shared-key", settleMs: 200 });
    assert.equal(sent.wrote, true, "a start record must not answer for a send");
  } finally {
    await registry.shutdown("quit");
  }
});

test("key names accept the spellings the documentation uses", () => {
  assert.equal(keyToBytes("Ctrl+C"), "\u0003");
  assert.equal(keyToBytes("ctrl c"), "\u0003");
  assert.equal(keyToBytes("CTRL+C"), "\u0003");
  assert.equal(keyToBytes("Ctrl+Z"), "\u001a");
  assert.equal(keyToBytes("Enter"), "\r");
  assert.equal(keyToBytes("PageUp"), "\u001b[5~");
  assert.equal(keyToBytes("F5"), "\u001b[15~");
  assert.equal(keyToBytes("Space"), " ");
  assert.equal(keyToBytes("y"), "y");
  // A name nobody knows used to be written as literal text and reported as a
  // delivered keystroke, which sends the caller looking in the wrong place.
  assert.throws(() => keyToBytes("Hyperkey"), /does not know the key/);
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

test("a pty starts in a workspace whose path contains a space", async () => {
  // The launcher path used to be pasted into `script -c` unquoted, so this
  // directory failed with "cannot open /tmp/pas" while a pipe binding worked.
  const registry = makeRegistry(tempCwd("pas pty space "));
  try {
    const handle = await registry.start({ command: "echo spaced-path", binding: "pty", scope: "session" });
    const result = await registry.awaitHandles({ ids: handle.id, waitMs: 20000 });
    assert.equal(result.outcomes[0]?.status, "completed");
    const combined = await registry.read({ id: handle.id, stream: "combined" });
    assert.match(combined.text, /spaced-path/);
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

test("a pty recording stops at the log cap without killing the command", async () => {
  // `script --output-limit` would end the session at the limit, which turns a
  // logging policy into a process policy. The bounded writer keeps the process
  // alive and stops appending, so the cap costs output and nothing else.
  const cap = 32768;
  const registry = makeRegistry(tempCwd("pas-pty-cap-"), {
    env: { ...process.env, PI_ASYNC_SHELL: "/bin/sh", PI_ASYNC_SHELL_MAX_LOG_BYTES: String(cap) },
  });
  try {
    const handle = await registry.start({
      command:
        "i=0; while [ $i -lt 4000 ]; do echo \"line $i 0123456789012345678901234567890123456789\"; i=$((i+1)); done; printf 'CAP-SURVIVED'",
      binding: "pty",
      scope: "session",
    });
    // The loop writes far more than the cap, so the cap has to be reached
    // before the command finishes.
    const capped = await waitFor(() => existsSync(join(handle.log.dir, "log-cap.json")), 15000);
    assert.equal(capped, true, "the cap record has to appear once the file is full");
    const size = statSync(join(handle.log.dir, "combined.log")).size;
    assert.ok(size <= cap, `the recording stays at or under the cap: ${size} > ${cap}`);

    const result = await registry.awaitHandles({ ids: handle.id, waitMs: 20000 });
    assert.equal(result.outcomes[0]?.status, "completed", "a full log never becomes a failed command");
    assert.equal(result.outcomes[0]?.bytes.capReached, true);
    const tail = await registry.read({ id: handle.id, mode: "grep", pattern: "CAP-SURVIVED" });
    assert.equal(tail.text.trim(), "", "the retained bytes are the head of the recording, not its tail");
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
