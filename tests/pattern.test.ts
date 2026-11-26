import assert from "node:assert/strict";
import { test } from "node:test";
import { compilePattern, MAX_PATTERN_LENGTH } from "../src/core/pattern.ts";

test("the pattern guard rejects nested repetition and oversized sources", () => {
  for (const source of ["(x+)+y", "(a*b)+", "((a+))?", "(a+){2}"]) {
    assert.throws(() => compilePattern(source, "test pattern"), /nested quantifiers/, source);
  }
  assert.throws(
    () => compilePattern("a".repeat(MAX_PATTERN_LENGTH + 1), "test pattern"),
    new RegExp(`the limit is ${MAX_PATTERN_LENGTH}`),
  );
});

test("escaped syntax and character classes do not create false nested groups", () => {
  for (const source of [String.raw`\[a+b+\]+`, String.raw`[(a+)+]`, String.raw`\(x+\)+`, "(ab|cd)+e", "a{2,4}"]) {
    assert.doesNotThrow(() => compilePattern(source, "test pattern"), source);
  }
  assert.equal(compilePattern("ready", "test pattern").test("ready"), true);
});

test("invalid regular expressions identify the argument that rejected them", () => {
  assert.throws(() => compilePattern("[unclosed", "shell_read pattern"), /invalid shell_read pattern/);
});
