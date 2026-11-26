import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { clearIndexCache, lineIndex, readLog, readScreenLog } from "../src/core/log-manager.ts";
import { tempCwd } from "./helpers.ts";

function fixture(lines: number): string {
  const dir = tempCwd("pas-log-");
  const path = join(dir, "combined.log");
  const body = Array.from({ length: lines }, (_, index) => `line-${index + 1}`).join("\n") + "\n";
  writeFileSync(path, body);
  clearIndexCache();
  return path;
}

test("line index counts lines and checkpoints every 256", async () => {
  const path = fixture(1000);
  const index = await lineIndex(path);
  assert.equal(index.totalLines, 1000);
  assert.equal(index.checkpoints.length, Math.floor(1000 / 256) + 1);
});

test("head returns the first lines", async () => {
  const path = fixture(300);
  const result = await readLog(path, { id: "x", mode: "head", lines: 5 });
  assert.equal(result.text, "line-1\nline-2\nline-3\nline-4\nline-5");
  assert.equal(result.totalLines, 300);
  assert.equal(result.range.startLine, 1);
});

test("tail returns the last lines", async () => {
  const path = fixture(300);
  const result = await readLog(path, { id: "x", mode: "tail", lines: 3 });
  assert.equal(result.text, "line-298\nline-299\nline-300");
  assert.equal(result.range.endLine, 300);
  assert.equal(result.range.nextLine, 301);
});

test("offset by line number seeks instead of scanning", async () => {
  const path = fixture(300);
  const result = await readLog(path, { id: "x", mode: "offset", lineOffset: 100, lines: 3 });
  assert.equal(result.text, "line-100\nline-101\nline-102");
  assert.equal(result.range.startLine, 100);
  assert.equal(result.range.nextLine, 103);
});

test("offset by byte number continues from that byte", async () => {
  const path = fixture(300);
  const first = await readLog(path, { id: "x", mode: "offset", byteOffset: 0, lines: 2 });
  const next = await readLog(path, { id: "x", mode: "offset", byteOffset: first.range.nextByte, lines: 2 });
  assert.equal(first.text, "line-1\nline-2");
  assert.equal(next.text, "line-3\nline-4");
});

test("grep returns matches with context and line numbers", async () => {
  const path = fixture(300);
  const result = await readLog(path, { id: "x", mode: "grep", pattern: "^line-299$", context: 1 });
  assert.match(result.text, /298: line-298/);
  assert.match(result.text, /299: line-299/);
  assert.match(result.text, /300: line-300/);
  assert.equal(result.note?.includes("1 matching line"), true);
});

test("grep matches a character that straddles a chunk boundary", async () => {
  const dir = tempCwd("pas-log-");
  const path = join(dir, "combined.log");
  // The scan reads 1 MiB at a time. "中" is three bytes, so a line that starts
  // one byte before the boundary is split by the read and, decoded chunk by
  // chunk, becomes U+FFFD on both sides of it.
  const filler = `${"a".repeat(1024 * 1024 - 6)}\n`;
  writeFileSync(path, `${filler}中文-answer\ntail\n`);
  clearIndexCache();
  // No context lines: the filler line is a megabyte long and would fill the
  // byte budget before the match is reached.
  const result = await readLog(path, { id: "x", mode: "grep", pattern: "中文", context: 0 });
  assert.match(result.text, /中文-answer/, "a split character must not hide the line that holds it");
});

test("a pattern that could backtrack catastrophically is refused before it runs", async () => {
  const path = fixture(10);
  await assert.rejects(
    () => readLog(path, { id: "x", mode: "grep", pattern: "(x+)+y" }),
    /nested quantifiers/,
  );
  await assert.rejects(
    () => readLog(path, { id: "x", mode: "grep", pattern: "a".repeat(600) }),
    /the limit is 512/,
  );
});

test("grep reports no match without throwing", async () => {
  const path = fixture(10);
  const result = await readLog(path, { id: "x", mode: "grep", pattern: "nope" });
  assert.equal(result.text, "");
  assert.equal(result.note, "no lines matched");
});

test("maxBytes truncates from the correct end", async () => {
  const path = fixture(300);
  const tail = await readLog(path, { id: "x", mode: "tail", lines: 300, maxBytes: 64 });
  assert.equal(tail.truncated, true);
  assert.ok(Buffer.byteLength(tail.text, "utf8") <= 64);
  assert.match(tail.text, /line-300$/);
  const head = await readLog(path, { id: "x", mode: "head", lines: 300, maxBytes: 64 });
  assert.equal(head.truncated, true);
  assert.match(head.text, /^line-1\n/);
});

test("stripAnsi removes escapes by default and keeps them on request", async () => {
  const dir = tempCwd("pas-log-");
  const path = join(dir, "combined.log");
  writeFileSync(path, "\u001b[31mred\u001b[0m plain\n");
  clearIndexCache();
  const stripped = await readLog(path, { id: "x", mode: "tail" });
  assert.equal(stripped.text, "red plain");
  const raw = await readLog(path, { id: "x", mode: "tail", stripAnsi: false });
  assert.match(raw.text, /\u001b\[31m/);
});

test("an empty log returns an empty result", async () => {
  const dir = tempCwd("pas-log-");
  const path = join(dir, "combined.log");
  writeFileSync(path, "");
  clearIndexCache();
  const result = await readLog(path, { id: "x", mode: "tail" });
  assert.equal(result.text, "");
  assert.equal(result.totalBytes, 0);
});

test("a truncated or replaced log rebuilds its cached line index", async () => {
  const path = fixture(600);
  await lineIndex(path);
  writeFileSync(path, "new-1\nnew-2\n");
  const index = await lineIndex(path);
  assert.equal(index.totalLines, 2);
  assert.deepEqual(index.checkpoints, [0]);
  assert.equal((await readLog(path, { id: "x", mode: "tail" })).text, "new-1\nnew-2");
});

test("grep separates disjoint context blocks", async () => {
  const dir = tempCwd("pas-log-");
  const path = join(dir, "combined.log");
  writeFileSync(path, "before\nmatch-a\nmiddle\nmatch-b\nafter\n");
  clearIndexCache();
  const result = await readLog(path, { id: "x", mode: "grep", pattern: "match", context: 0 });
  assert.equal(result.text, "2: match-a\n--\n4: match-b");
  assert.match(result.note ?? "", /2 matching line/);
});

test("UTF-8 byte offsets page whole characters without repetition", async () => {
  const dir = tempCwd("pas-log-");
  const path = join(dir, "combined.log");
  writeFileSync(path, "零\n一\n二\n三\n");
  clearIndexCache();
  const first = await readLog(path, { id: "x", mode: "head", lines: 2 });
  const next = await readLog(path, { id: "x", mode: "offset", byteOffset: first.range.nextByte, lines: 2 });
  assert.equal(first.text, "零\n一");
  assert.equal(first.range.nextByte, 8);
  assert.equal(next.text, "二\n三");
  assert.doesNotMatch(`${first.text}${next.text}`, /�/);
});

test("screen reads support head, offset, and grep on the rendered viewport", async () => {
  const dir = tempCwd("pas-log-");
  const path = join(dir, "ptyView.log");
  writeFileSync(path, "alpha\r\nbeta\r\nalpha target\r\n");
  const head = await readScreenLog(path, { id: "x", mode: "head", lines: 2 });
  assert.equal(head.text, "alpha\nbeta");
  const offset = await readScreenLog(path, { id: "x", mode: "offset", lineOffset: 2, lines: 2 });
  assert.equal(offset.text, "beta\nalpha target");
  const grep = await readScreenLog(path, { id: "x", mode: "grep", pattern: "target", context: 1 });
  assert.equal(grep.text, "2: beta\n3: alpha target");
  assert.match(grep.note ?? "", /1 matching line/);
});

test("a replay window aligns on a carriage return, so a redrawn screen is not empty", async () => {
  const dir = tempCwd("pas-log-");
  const path = join(dir, "ptyView.log");
  // A progress bar draws with \r and never writes a newline. A window of the
  // last 256 KiB therefore holds no newline at all, and aligning only on \n
  // replayed nothing and reported an empty screen for 300 KiB of output.
  writeFileSync(path, `${"filler ".repeat(43_000)}\rprogress: 99%\r`);
  const outcome = await readScreenLog(path, { id: "x" }, { size: { cols: 40, rows: 6 } });
  assert.equal(outcome.text, "progress: 99%");
  assert.equal(outcome.truncated, true, "a windowed replay is not the whole recording");
  assert.match(outcome.note ?? "", /the replay covered the last \d+ of \d+ bytes/);
});

test("a window with no line or carriage-return boundary says so instead of returning nothing", async () => {
  const dir = tempCwd("pas-log-");
  const path = join(dir, "ptyView.log");
  writeFileSync(path, "y".repeat(300 * 1024));
  const outcome = await readScreenLog(path, { id: "x" }, {});
  assert.equal(outcome.text, "");
  assert.equal(outcome.truncated, true, "an unreconstructable viewport is not a successful empty read");
  assert.match(outcome.note ?? "", /could not be reconstructed/);
});

test("a screen read names no next page, and a missing size is reported as assumed", async () => {
  const dir = tempCwd("pas-log-");
  const path = join(dir, "ptyView.log");
  writeFileSync(path, "alpha\r\nbeta\r\n");
  const fallback = await readScreenLog(path, { id: "x", mode: "all" }, {});
  assert.equal(fallback.range.nextByte, undefined, "viewport rows are not a pageable byte range");
  assert.equal(fallback.range.nextLine, undefined);
  assert.match(fallback.note ?? "", /default 80x24 was assumed/);

  const sized = await readScreenLog(path, { id: "x" }, { size: { cols: 200, rows: 50 } });
  assert.match(sized.note ?? "", /rendered 200x50 terminal screen/);
  assert.doesNotMatch(sized.note ?? "", /was assumed/);
});
