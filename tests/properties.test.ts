import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import fc from "fast-check";

import { stripAnsi } from "../src/core/ansi.ts";
import { clearIndexCache, readLog } from "../src/core/log-manager.ts";
import { renderScreen } from "../src/core/screen.ts";
import { completeUtf8Length } from "../src/core/utf8.ts";
import { tempCwd } from "./helpers.ts";

/**
 * Properties for the four modules that answer "what did this execution print".
 *
 * The example-based tests next door pin the cases the design names. These state
 * the invariants that must hold for input nobody wrote down: an escape stripper
 * that is not idempotent, a screen model whose cursor leaves the viewport, or a
 * byte-offset page that repeats a line are all bugs a fixed example list does
 * not find. `completeUtf8Length` is here for the same reason: a window that ends
 * inside a character loses those bytes from the next poll, and no example list
 * names every offset a window can end on.
 */

const CASE_COUNTS = { numRuns: 120 };
const FILE_CASE_COUNTS = { numRuns: 50 };

const terminalFragments = fc.constantFrom(
  "\u001b[2J",
  "\u001b[H",
  "\u001b[2;1H",
  "\u001b[31m",
  "\u001b[0m",
  "\u001b]0;title\u0007",
  "\u001b]8;;https://example.com\u001b\\",
  "\r",
  "\n",
  "\b",
  "\t",
  "中文",
  "🙂",
);
const terminalText = fc.oneof(
  fc.string({ maxLength: 200 }),
  fc
    .array(fc.oneof(fc.string({ maxLength: 8 }), terminalFragments), { maxLength: 50 })
    .map((parts) => parts.join("")),
);

/**
 * Text a window may cut, at any code point except two.
 *
 * A lone surrogate has no UTF-8 encoding of its own, and U+FFFD is the
 * replacement character itself: it would satisfy "the decode introduced no
 * replacement" for a reason that has nothing to do with the boundary under test.
 */
const unicodeText = fc
  .array(
    fc.integer({ min: 0, max: 0x10ffff }).map((code) =>
      code >= 0xd800 && code <= 0xdfff ? 0x41 : code === 0xfffd ? 0x42 : code,
    ),
    { maxLength: 120 },
  )
  .map((codes) => String.fromCodePoint(...codes));

function writeFixture(text: string): string {
  const dir = tempCwd("pas-property-");
  const path = join(dir, "combined.log");
  writeFileSync(path, text);
  clearIndexCache();
  return path;
}

test("stripAnsi consumes OSC sequences terminated by BEL or ST", () => {
  assert.equal(stripAnsi("before\u001b]0;title\u0007after"), "beforeafter");
  assert.equal(stripAnsi("before\u001b]8;;https://example.com\u001b\\after"), "beforeafter");
});

test("stripAnsi is idempotent and leaves no escape introducer", () => {
  fc.assert(
    fc.property(terminalText, (input) => {
      const once = stripAnsi(input);
      assert.equal(stripAnsi(once), once, "a second pass changed the text");
      assert.equal(once.includes("\u001B"), false, "an ESC survived the strip");
    }),
    CASE_COUNTS,
  );
});

test("renderScreen keeps the cursor inside the declared viewport", () => {
  fc.assert(
    fc.property(
      terminalText,
      fc.integer({ min: 20, max: 120 }),
      fc.integer({ min: 4, max: 40 }),
      (input, cols, rows) => {
        const snapshot = renderScreen(input, { cols, rows });
        assert.equal(snapshot.cols, cols);
        assert.equal(snapshot.rows, rows);
        assert.ok(
          snapshot.cursor.row >= 0 && snapshot.cursor.row < rows,
          "row " + snapshot.cursor.row + " of " + rows,
        );
        assert.ok(
          snapshot.cursor.col >= 0 && snapshot.cursor.col < cols,
          "col " + snapshot.cursor.col + " of " + cols,
        );
        assert.ok(snapshot.lines.length <= rows, "the viewport grew to " + snapshot.lines.length + " lines");
      },
    ),
    CASE_COUNTS,
  );
});

test("a tail read returns the last lines and agrees with the index", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.stringMatching(/^[a-z0-9]{1,10}$/), { minLength: 1, maxLength: 40 }),
      fc.nat({ max: 40 }),
      async (words, requested) => {
        const all = words.map((word, index) => index + "-" + word);
        const text = all.join("\n") + "\n";
        const path = writeFixture(text);
        const wanted = Math.max(1, Math.min(requested, all.length));
        const result = await readLog(path, { id: "p", mode: "tail", lines: wanted });
        assert.equal(result.text, all.slice(all.length - wanted).join("\n"));
        assert.equal(result.totalLines, all.length);
        assert.equal(result.range.endLine, all.length);
        assert.equal(result.totalBytes, Buffer.byteLength(text));
      },
    ),
    FILE_CASE_COUNTS,
  );
});

test("byte offset paging neither repeats nor drops a line", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.stringMatching(/^[a-z]{1,8}$/), { minLength: 4, maxLength: 30 }),
      async (words) => {
        const all = words.map((word, index) => index + ":" + word);
        const path = writeFixture(all.join("\n") + "\n");
        const first = await readLog(path, { id: "p", mode: "head", lines: 2 });
        const next = await readLog(path, { id: "p", mode: "offset", byteOffset: first.range.nextByte });
        assert.deepEqual([...first.text.split("\n"), ...next.text.split("\n")], all);
      },
    ),
    FILE_CASE_COUNTS,
  );
});

test("completeUtf8Length stops on a character boundary and loses no byte", () => {
  fc.assert(
    fc.property(unicodeText, (input) => {
      const buffer = Buffer.from(input, "utf8");
      const usable = completeUtf8Length(buffer);
      assert.ok(usable >= 0 && usable <= buffer.length, "a boundary of " + usable + " outside a buffer of " + buffer.length);
      const prefix = buffer.subarray(0, usable).toString("utf8");
      const remainder = buffer.subarray(usable).toString("utf8");
      assert.equal(prefix.includes("\ufffd"), false, "the chosen end decoded a partial character");
      assert.equal(prefix + remainder, input, "the two halves must reconstruct the input");
    }),
    CASE_COUNTS,
  );
});

test("a window cut at any byte resumes at the character it cut", () => {
  fc.assert(
    fc.property(unicodeText, fc.nat({ max: 400 }), (input, cut) => {
      const buffer = Buffer.from(input, "utf8");
      const window = buffer.subarray(0, Math.min(cut, buffer.length));
      const usable = completeUtf8Length(window);
      const prefix = window.subarray(0, usable).toString("utf8");
      assert.equal(prefix.includes("\ufffd"), false, "a window that ends inside a character decoded a replacement");
      // The next poll starts at `usable` in the file, not at the window end, which
      // is what makes the cut character whole again instead of lost.
      assert.equal(
        prefix + buffer.subarray(usable).toString("utf8"),
        input,
        "a window of " + window.length + " of " + buffer.length + " bytes",
      );
    }),
    CASE_COUNTS,
  );
});

test("completeUtf8Length keeps a partial character for the next window", () => {
  assert.equal(completeUtf8Length(Buffer.alloc(0)), 0);
  // A window of continuation bytes names no character start to fall back to, so
  // it is returned whole rather than guessed at.
  assert.equal(completeUtf8Length(Buffer.from([0x80])), 1);
  assert.equal(completeUtf8Length(Buffer.from([0x80, 0x80])), 2);
  // A four-byte character cut at each of its byte positions yields nothing until
  // the last byte arrives, and the whole character when it does.
  const smile = Buffer.from("🙂", "utf8");
  assert.equal(smile.length, 4);
  for (let cut = 0; cut < 4; cut += 1) {
    assert.equal(completeUtf8Length(smile.subarray(0, cut)), 0, "a " + cut + "-byte prefix of a four-byte character is not decodable");
  }
  assert.equal(completeUtf8Length(smile), 4);
  assert.equal(completeUtf8Length(Buffer.from("中🙂")), 7, "two whole characters in one window both stay");
});
