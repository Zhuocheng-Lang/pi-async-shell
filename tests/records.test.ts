import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  readDeltaSync,
  readJson,
  requestFileName,
  sanitizeRequest,
  sizeOf,
  writeFifo,
  writeJsonAtomic,
  writeJsonAtomicSync,
} from "../src/core/records.ts";
import { tempCwd, waitFor } from "./helpers.ts";

/**
 * The two rules in `records.ts` that fail silently, and the fs primitives
 * around them.
 *
 * A request name that collides answers a second `shell_start` with the first
 * one's handle: the command never runs and the result says it did. A delta read
 * that ends inside a character decodes that character as U+FFFD and advances
 * past it: the bytes are gone for good. Both are one-line rules in a module no
 * other test imports, which is why they are pinned here rather than only through
 * the registry that calls them.
 */

const WINDOW = 256 * 1024;

function writeFixture(text: string): string {
  const dir = tempCwd("pas-records-");
  const path = join(dir, "combined.log");
  writeFileSync(path, text);
  return path;
}

/** The digest a request name carries between its sanitized key and its kind. */
function digestOf(name: string): string {
  const parts = name.split(".");
  assert.equal(parts.length, 4, "expected <key>.<digest>.<kind>.json, got " + name);
  return parts[1] as string;
}

test("a request key the sanitizer changed carries a digest of the key it was given", () => {
  assert.equal(sanitizeRequest("build one"), "build_one");
  assert.equal(sanitizeRequest("build/one"), "build_one");
  const spaced = requestFileName("build one", "start");
  const slashed = requestFileName("build/one", "start");
  assert.notEqual(spaced, slashed, "two requests with one sanitized spelling must not share a file");
  assert.match(spaced, /^build_one\.[0-9a-f]{12}\.start\.json$/);
  assert.match(slashed, /^build_one\.[0-9a-f]{12}\.start\.json$/);
  assert.equal(digestOf(spaced).length, 12, "the digest is twelve hex characters");
  assert.match(digestOf(spaced), /^[0-9a-f]{12}$/);
});

test("a request key that needed no sanitizing carries no digest", () => {
  assert.equal(requestFileName("build_one", "start"), "build_one.start.json");
  assert.equal(requestFileName("sh_1.cwd", "send"), "sh_1.cwd.send.json");
});

test("a start request and a send request with one key are two file names", () => {
  assert.equal(requestFileName("shared-key", "start"), "shared-key.start.json");
  assert.equal(requestFileName("shared-key", "send"), "shared-key.send.json");
  // The digest covers the key alone, so one key names one request per kind.
  assert.equal(
    requestFileName("build one", "send"),
    "build_one." + digestOf(requestFileName("build one", "start")) + ".send.json",
  );
});

test("two request keys sharing their first ninety-six characters get different files", () => {
  const shared = "x".repeat(96);
  assert.equal(sanitizeRequest(shared + "left").length, 96, "the sanitizer keeps ninety-six characters and no more");
  const left = requestFileName(shared + "left", "start");
  const right = requestFileName(shared + "right", "start");
  assert.notEqual(left, right, "truncation is part of the sanitizer, so the digest has to cover the whole key");
  assert.match(left, /^x{96}\.[0-9a-f]{12}\.start\.json$/);
});

test("the sanitizer keeps the characters a file name may hold and replaces the rest", () => {
  assert.equal(sanitizeRequest("build_one.start-9"), "build_one.start-9");
  assert.equal(sanitizeRequest("a b"), "a_b");
  assert.equal(sanitizeRequest("a/b:c"), "a_b_c");
  assert.equal(sanitizeRequest("a\u0000b"), "a_b");
});

test("a delta read of a missing file reports nothing and keeps the offset", () => {
  const dir = tempCwd("pas-records-");
  assert.deepEqual(readDeltaSync(join(dir, "absent.log"), 7), { text: "", nextOffset: 7 });
});

test("a delta read at or past the end reports nothing and keeps the offset", () => {
  const text = "héllo 中";
  const path = writeFixture(text);
  const size = Buffer.byteLength(text);
  assert.deepEqual(readDeltaSync(path, size), { text: "", nextOffset: size });
  assert.deepEqual(readDeltaSync(path, size + 10), { text: "", nextOffset: size + 10 });
});

test("a delta read smaller than the window returns the file whole", () => {
  const text = "héllo 中 🙂\n";
  const path = writeFixture(text);
  assert.ok(Buffer.byteLength(text) < WINDOW);
  assert.deepEqual(readDeltaSync(path, 0), { text, nextOffset: Buffer.byteLength(text) });
});

test("a window that cuts a character loses no byte across two reads", () => {
  // Three-byte characters, so a 256 KiB window cannot end on a boundary: 262144
  // is not a multiple of three.
  const text = "中".repeat(90_000);
  const path = writeFixture(text);
  const size = Buffer.byteLength(text);
  assert.ok(size > WINDOW, "the fixture must exceed one read window");

  const first = readDeltaSync(path, 0);
  assert.equal(first.nextOffset, Buffer.byteLength(first.text), "the text is exactly the bytes the offset consumed");
  assert.ok(first.text.length > 0);
  assert.ok(first.text.length < text.length, "one read must not return the whole file");
  assert.equal(first.text.includes("\ufffd"), false, "a character split by the window decoded to U+FFFD");

  const second = readDeltaSync(path, first.nextOffset);
  assert.equal(second.text.includes("\ufffd"), false);
  assert.equal(first.text + second.text, text, "the second read resumes where the first stopped");
  assert.equal(second.nextOffset, size);
});

test("an atomic write leaves the record and no temporary file beside it", async () => {
  const dir = tempCwd("pas-records-");
  const record = join(dir, "sh_1.json");
  writeJsonAtomicSync(record, { id: "sh_1", status: "running" });
  assert.deepEqual(readdirSync(dir), ["sh_1.json"], "a completed write leaves no .tmp behind");
  assert.deepEqual(readJson(record), { id: "sh_1", status: "running" });

  await writeJsonAtomic(record, { id: "sh_1", status: "completed" });
  assert.deepEqual(readdirSync(dir), ["sh_1.json"]);
  assert.deepEqual(readJson(record), { id: "sh_1", status: "completed" });
  assert.equal(sizeOf(record), Buffer.byteLength(JSON.stringify({ id: "sh_1", status: "completed" }, null, 2)));
});

test("a record that is not valid JSON reads as absent", () => {
  const dir = tempCwd("pas-records-");
  writeFileSync(join(dir, "truncated.json"), '{"id": "sh_1", "status":');
  writeFileSync(join(dir, "plain.json"), "not json at all");
  writeFileSync(join(dir, "empty.json"), "");
  assert.equal(readJson(join(dir, "truncated.json")), undefined);
  assert.equal(readJson(join(dir, "plain.json")), undefined);
  assert.equal(readJson(join(dir, "empty.json")), undefined);
  assert.equal(readJson(join(dir, "absent.json")), undefined);
});

test("sizeOf reports zero for a path that does not exist", () => {
  const dir = tempCwd("pas-records-");
  assert.equal(sizeOf(join(dir, "absent.log")), 0);
});

/** A FIFO needs a program to make it; mkfifo(1) is the dependency the pty binding already has. */
function makeFifo(dir: string): string {
  const path = join(dir, "stdin.fifo");
  execFileSync("mkfifo", ["-m", "600", path]);
  return path;
}

test("writeFifo reports false when nothing is reading its stdin", { timeout: 15_000 }, async () => {
  const fifo = makeFifo(tempCwd("pas-records-"));
  // The open is non-blocking, so an absent reader is an answer rather than a
  // hang: a blocking open here would wedge the process that reports it.
  assert.equal(await writeFifo(fifo, "nobody is listening"), false);
});

test("writeFifo delivers the bytes to a reader", { timeout: 15_000 }, async () => {
  const fifo = makeFifo(tempCwd("pas-records-"));
  const reader = spawn("cat", [fifo], { stdio: ["ignore", "pipe", "ignore"] });
  const output = reader.stdout;
  assert.ok(output, "the reader must expose its stdout");
  let received = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    received += chunk;
  });
  try {
    // The reader's open and this one race: until `cat` has the FIFO open,
    // writeFifo reports the same false it reports for an absent reader.
    const wrote = await waitFor(() => writeFifo(fifo, "hello-fifo"), 5000);
    assert.equal(wrote, true, "writeFifo must succeed once a reader has the FIFO open");
    assert.equal(await waitFor(() => received === "hello-fifo", 5000), true, "the reader received " + JSON.stringify(received));
  } finally {
    reader.kill();
  }
});
