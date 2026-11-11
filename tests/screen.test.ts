import assert from "node:assert/strict";
import { test } from "node:test";
import { renderScreen } from "../src/core/screen.ts";

test("carriage returns collapse a redrawn line to its final frame", () => {
  const snapshot = renderScreen("downloading 10%\rdownloading 55%\rdownloading 100%\r\n", { cols: 40, rows: 5 });
  assert.deepEqual(snapshot.lines, ["downloading 100%"]);
});

test("cursor addressing redraws in place instead of appending", () => {
  const stream = "menu\r\n> one\r\n  two\r\n\u001b[2;1H\u001b[2K> ONE\r\n";
  const snapshot = renderScreen(stream, { cols: 40, rows: 6 });
  assert.deepEqual(snapshot.lines, ["menu", "> ONE", "  two"]);
  assert.equal(snapshot.addressed, true);
});

test("erase-display clears the previous frame", () => {
  const snapshot = renderScreen("old frame\r\nmore\r\n\u001b[2J\u001b[Hnew frame\r\n", { cols: 40, rows: 6 });
  assert.deepEqual(snapshot.lines, ["new frame"]);
});

test("a line longer than the recorded width wraps", () => {
  const snapshot = renderScreen("abcdefghijklmnopqrstuvwxyz\n", { cols: 20, rows: 5 });
  assert.deepEqual(snapshot.lines, ["abcdefghijklmnopqrst", "uvwxyz"]);
});

test("unknown escapes are consumed rather than printed", () => {
  const snapshot = renderScreen("\u001b[?25l\u001b]0;title\u0007visible\r\n", { cols: 40, rows: 4 });
  assert.deepEqual(snapshot.lines, ["visible"]);
});

test("the viewport follows the cursor once output scrolls past the height", () => {
  const stream = Array.from({ length: 6 }, (_, index) => `line ${index + 1}\r\n`).join("");
  const snapshot = renderScreen(stream, { cols: 40, rows: 3 });
  assert.deepEqual(snapshot.lines, ["line 4", "line 5", "line 6"]);
});

test("a bare line feed keeps the column, as a terminal does", () => {
  // ONLCR turns \\n into \\r\\n on a PTY, so a lone line feed is a deliberate
  // downward move; treating it as a new line would hide a real staircase bug.
  const snapshot = renderScreen("a\nb\n", { cols: 10, rows: 4 });
  assert.deepEqual(snapshot.lines, ["a", " b"]);
});

test("a hostile insert-lines sequence cannot grow the grid without bound", () => {
  const stream = "\u001b[9999L".repeat(2000) + "after\r\n";
  const snapshot = renderScreen(stream, { cols: 40, rows: 5 });
  assert.ok(snapshot.lines.length <= 5, "the viewport stays the size of the screen");
  assert.match(snapshot.lines.join("\n"), /after/);
});

test("an absurd cursor address is clamped instead of allocating", () => {
  const snapshot = renderScreen("\u001b[99999999;1Hboom\r\n", { cols: 40, rows: 5 });
  assert.ok(snapshot.lines.length <= 5, "the viewport stays the size of the screen");
  assert.equal(snapshot.lines.at(-1), "boom");
});

test("backspace and erase-to-end-of-line behave like a prompt redraw", () => {
  const snapshot = renderScreen("prompt> ask\b\b\banswer\u001b[K\r\n", { cols: 40, rows: 4 });
  assert.deepEqual(snapshot.lines, ["prompt> answer"]);
});
