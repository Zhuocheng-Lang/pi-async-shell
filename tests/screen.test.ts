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
  const snapshot = renderScreen(
    "\u001b[?25l\u001b]0;title\u0007\u001b]8;;https://example.com\u001b\\visible\r\n",
    { cols: 40, rows: 4 },
  );
  assert.deepEqual(snapshot.lines, ["visible"]);
});

test("an SS3 sequence is consumed rather than leaving its final byte as text", () => {
  // ESC O and one final byte carries no text. Consuming only ESC and O left the
  // final byte in the grid, so an echoed F1 (ESC O P) showed up as a stray "P".
  assert.deepEqual(renderScreen("A\u001bOPB").lines, ["AB"]);
  assert.deepEqual(renderScreen("key\u001bOA!").lines, ["key!"]);
  assert.deepEqual(renderScreen("\u001b=B").lines, ["B"]);
  assert.deepEqual(renderScreen("\u001bOP").lines, []);
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

test("tabs and both cursor-save spellings preserve the editing position", () => {
  for (const [save, restore] of [["\u001b7", "\u001b8"], ["\u001b[s", "\u001b[u"]]) {
    const snapshot = renderScreen(`a\tb${save}\r\nxy${restore}Z`, { cols: 20, rows: 4 });
    assert.deepEqual(snapshot.lines, ["a       bZ", "xy"]);
  }
});

test("character and line editing sequences change only their target cells", () => {
  assert.deepEqual(renderScreen("abcdef\r\u001b[2G\u001b[2P", { cols: 20, rows: 4 }).lines, ["adef"]);
  assert.deepEqual(renderScreen("abcdef\r\u001b[2G\u001b[2@", { cols: 20, rows: 4 }).lines, ["a  bcdef"]);
  assert.deepEqual(renderScreen("abcdef\r\u001b[2G\u001b[2X", { cols: 20, rows: 4 }).lines, ["a  def"]);
  assert.deepEqual(
    renderScreen("one\r\ntwo\r\nthree\u001b[2;1H\u001b[1M", { cols: 20, rows: 4 }).lines,
    ["one", "three"],
  );
});

test("a full-width final character leaves the reported cursor inside the viewport", () => {
  for (const input of ["x".repeat(20), `${" ".repeat(19)}🙂`]) {
    const snapshot = renderScreen(input, { cols: 20, rows: 4 });
    assert.equal(snapshot.cursor.col, 19);
    assert.equal(snapshot.cursor.row, 0);
    if (input.includes("🙂")) assert.equal(snapshot.lines[0], `${" ".repeat(19)}🙂`.trimEnd());
  }
});
