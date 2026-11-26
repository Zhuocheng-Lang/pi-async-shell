import assert from "node:assert/strict";
import { test } from "node:test";
import {
  completionMessage,
  describeHandle,
  formatBytes,
  formatDuration,
  outcomeExcerpt,
  readOutcomeExcerpt,
  sendHeadline,
  startText,
  type LogReader,
} from "../src/presentation.ts";
import type { CompletionRecord, LogPaths, ShellHandle, ShellReadParams, ShellReadResult } from "../src/core/types.ts";

/**
 * The wording every person and every model reads back.
 *
 * Nothing here touches the filesystem or a child process: the module is a leaf
 * by design, so its tests are the cheapest in the suite and the ones a wording
 * change is expected to touch. The boundaries are the point — a unit switch that
 * rounds across itself, an excerpt that grows past its cap, and the envelope
 * around a completion block are all things a reader notices and a caller parses.
 */

const log: LogPaths = {
  dir: "/tmp/pas",
  stdout: "/tmp/pas/stdout.log",
  stderr: "/tmp/pas/stderr.log",
  combined: "/tmp/pas/combined.log",
};

const bytes = { stdout: 2000, stderr: 48, combined: 2048, capReached: false };

function handle(overrides: Partial<ShellHandle> = {}): ShellHandle {
  return {
    id: "sh_1",
    name: "build",
    command: "make",
    cwd: "/tmp/pas",
    scope: "session",
    binding: "pipe",
    status: "completed",
    startedAt: 1000,
    endedAt: 3500,
    exitCode: 0,
    signal: null,
    log,
    bytes,
    ...overrides,
  };
}

function record(overrides: Partial<CompletionRecord> = {}): CompletionRecord {
  return {
    id: "sh_1",
    name: "build",
    status: "completed",
    exitCode: 0,
    signal: null,
    scope: "session",
    binding: "pipe",
    startedAt: 1000,
    endedAt: 3500,
    durationMs: 2500,
    log,
    bytes,
    ...overrides,
  };
}

function readResult(text: string): ShellReadResult {
  return {
    id: "sh_1",
    status: "completed",
    stream: "combined",
    text,
    truncated: false,
    totalLines: text.split("\n").length,
    totalBytes: Buffer.byteLength(text),
    range: {},
    fullLogPath: log.combined,
  };
}

test("formatBytes switches unit at the binary boundary, not at the rounded value", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1023), "1023 B");
  assert.equal(formatBytes(1024), "1.0 KiB");
  assert.equal(formatBytes(1536), "1.5 KiB");
  // Just under a MiB it is still KiB, and the number it prints is past 1024:
  // the branch tests the byte count, not the rounded text.
  assert.equal(formatBytes(1048575), "1024.0 KiB");
  assert.equal(formatBytes(1048576), "1.0 MiB");
});

test("formatDuration keeps its unit below the boundary it rounds past", () => {
  assert.equal(formatDuration(0), "0ms");
  assert.equal(formatDuration(999), "999ms");
  assert.equal(formatDuration(1000), "1.0s");
  // 59999 ms rounds up to "60.0s" while 60000 ms prints "1m0s": the unit is
  // chosen before the rounding, so the two neighbours disagree about the unit.
  assert.equal(formatDuration(59999), "60.0s");
  assert.equal(formatDuration(60000), "1m0s");
  assert.equal(formatDuration(90000), "1m30s");
});

test("outcomeExcerpt returns nothing for empty or blank output", () => {
  assert.deepEqual(outcomeExcerpt(undefined, false), []);
  assert.deepEqual(outcomeExcerpt("", false), []);
  assert.deepEqual(outcomeExcerpt("\n\t\n   \n", true), []);
});

test("outcomeExcerpt trims trailing whitespace and caps each line at 500 characters", () => {
  assert.deepEqual(outcomeExcerpt("a   \nb\t\t\n", false), ["  --- tail ---", "  a", "  b"]);
  const excerpt = outcomeExcerpt("x".repeat(600), false);
  assert.equal(excerpt.length, 2);
  assert.equal(excerpt[1], "  " + "x".repeat(500), "the cap is on the line, before the two-space indent");
});

test("outcomeExcerpt keeps the last ten lines", () => {
  const text = Array.from({ length: 12 }, (_, index) => "line-" + (index + 1)).join("\n");
  const excerpt = outcomeExcerpt(text, false);
  assert.equal(excerpt.length, 11, "one header and ten lines");
  assert.equal(excerpt[1], "  line-3");
  assert.equal(excerpt[10], "  line-12");
});

test("outcomeExcerpt leads with the first error line on a failed status", () => {
  const lines = Array.from({ length: 20 }, (_, index) => "line-" + (index + 1));
  lines[2] = "Error: no rule to make target";
  const excerpt = outcomeExcerpt(lines.join("\n"), true);
  assert.equal(excerpt[0], "  --- first error ---");
  const error = excerpt.indexOf("  Error: no rule to make target");
  assert.ok(error > 0, "the error line is in the block");
  assert.equal(excerpt[1], "  line-1", "the block opens two lines before the error");
  const tail = excerpt.indexOf("  --- tail ---");
  assert.ok(tail > error, "the tail follows the error block");
  assert.equal(excerpt.at(-1), "  line-20", "the tail reaches the last line");
});

test("a completed status reports the tail without hunting for an error line", () => {
  const text = ["line-1", "Error: harmless", "line-3"].join("\n");
  assert.deepEqual(outcomeExcerpt(text, false), ["  --- tail ---", "  line-1", "  Error: harmless", "  line-3"]);
  assert.deepEqual(outcomeExcerpt(text, true), ["  --- first error ---", "  line-1", "  Error: harmless", "  line-3"]);
});

test("readOutcomeExcerpt asks the registry for a tail and formats what it returns", async () => {
  const asked: ShellReadParams[] = [];
  const registry: LogReader = {
    read: async (params: ShellReadParams) => {
      asked.push(params);
      return readResult("step 1 ok\nError: boom");
    },
  };
  const excerpt = await readOutcomeExcerpt(registry, "sh_1", "failed");
  assert.deepEqual(asked, [{ id: "sh_1", mode: "tail", lines: 20, stream: "combined" }]);
  assert.equal(excerpt[0], "  --- first error ---");
  assert.ok(excerpt.includes("  Error: boom"));
});

test("readOutcomeExcerpt returns nothing when there is no registry or the read throws", async () => {
  assert.deepEqual(await readOutcomeExcerpt(undefined, "sh_1", "failed"), []);
  const failing: LogReader = {
    read: async () => {
      throw new Error("the registry is gone");
    },
  };
  assert.deepEqual(await readOutcomeExcerpt(failing, "sh_1", "failed"), [], "a completion must still be delivered");
});

test("completionMessage opens and closes one block per record", async () => {
  const two = [record(), record({ id: "sh_2", name: "test", status: "failed", exitCode: 1 })];
  const lines = (await completionMessage(two, undefined)).split("\n");
  assert.equal(lines[0], "<async-shell-completion>");
  assert.equal(lines.at(-1), "</async-shell-completion>");
  assert.equal(lines.filter((line) => line === "<async-shell-completion>").length, 1);
  assert.equal(lines.filter((line) => line.startsWith("  log: ")).length, two.length, "one log line per record");
  assert.ok(lines.includes('sh_1 "build" completed after 2.5s · scope session · binding pipe'));
  assert.ok(lines.includes('sh_2 "test" failed (exit 1) after 2.5s · scope session · binding pipe'));
  assert.deepEqual((await completionMessage([], undefined)).split("\n"), [
    "<async-shell-completion>",
    "Read output with shell_read; do not re-run a command that already completed.",
    "</async-shell-completion>",
  ]);
});

test("completionMessage carries the outcome it has, including no exit code", async () => {
  const lost = record({ status: "lost", exitCode: null, signal: "SIGKILL", error: "liveness could not be proven" });
  const text = await completionMessage([lost], undefined);
  assert.match(text, /sh_1 "build" lost \(liveness could not be proven\) after 2\.5s/);
  assert.match(text, /  error: liveness could not be proven/);
  assert.match(text, /  signal: SIGKILL/);
  assert.match(text, /  exit: unknown/);
});

test("describeHandle states the exit, the duration and the log size in one line", () => {
  assert.equal(
    describeHandle(handle()),
    'sh_1 · "build" · completed · exit 0 · 2.5s · scope session · binding pipe · 2.0 KiB logged',
  );
  assert.equal(
    describeHandle(handle({ status: "failed", exitCode: 2, signal: "SIGTERM", error: "killed", bytes: { ...bytes, capReached: true } })),
    'sh_1 · "build" · failed · exit 2 · signal SIGTERM · 2.5s · scope session · binding pipe · 2.0 KiB logged · log cap reached · error: killed',
  );
  assert.match(describeHandle(handle({ endedAt: undefined })), / so far · scope session/, "a live handle says so far");
});

test("startText adds the inline window and its excerpt only when the start settled inline", () => {
  assert.equal(startText(handle(), undefined, undefined), 'Started ' + describeHandle(handle()) + "\nlog: /tmp/pas/combined.log");
  const settled = startText(handle({ status: "failed", exitCode: 2 }), 500, "make: no rule to make target", "waitMs was clamped");
  assert.match(settled, /^Started sh_1 /);
  assert.match(settled, /\n  note: waitMs was clamped\n/);
  assert.match(settled, /Settled inside the 500ms inline window/);
  assert.match(settled, / {2}make: no rule to make target/);
  assert.match(settled, /\nlog: \/tmp\/pas\/combined\.log$/);
});

test("sendHeadline separates a delivered write from an undelivered one", () => {
  assert.equal(sendHeadline({ id: "sh_1", wrote: true }), "Sent to sh_1");
  assert.match(sendHeadline({ id: "sh_1", wrote: false }), /^Nothing written to sh_1 \(no reader on its stdin/);
});
