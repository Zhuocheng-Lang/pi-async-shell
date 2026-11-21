import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import fc from "fast-check";

import { stripAnsi } from "../src/core/ansi.ts";
import { clearIndexCache, readLog } from "../src/core/log-manager.ts";
import { renderScreen } from "../src/core/screen.ts";

/**
 * Properties for the three modules that answer "what did this execution print".
 *
 * The example-based tests next door pin the cases the design names. These state
 * the invariants that must hold for input nobody wrote down: an escape stripper
 * that is not idempotent, a screen model whose cursor leaves the viewport, or a
 * byte-offset page that repeats a line are all bugs a fixed example list does
 * not find.
 */

const CASE_COUNTS = { numRuns: 120 };
const FILE_CASE_COUNTS = { numRuns: 50 };

function writeFixture(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pas-property-"));
  const path = join(dir, "combined.log");
  writeFileSync(path, text);
  clearIndexCache();
  return path;
}

test("stripAnsi is idempotent and leaves no escape introducer", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 400 }), (input) => {
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
      fc.string({ maxLength: 600 }),
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
        assert.ok(snapshot.lines.length <= rows + 1, "the viewport grew to " + snapshot.lines.length + " lines");
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
