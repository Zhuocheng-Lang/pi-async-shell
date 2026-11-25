// SPDX-FileCopyrightText: 2026 Zhuocheng-Lang
// SPDX-License-Identifier: MPL-2.0

/**
 * The bounded writer between `script(1)` and a `pty` recording.
 *
 * `script` writes its recording to stdout, which used to be `combined.log`
 * itself, so the file grew for as long as the terminal ran. util-linux offers
 * `--output-limit`, but it ends the session when the limit is reached: the
 * command dies with the recording. A logging cap must never become a process
 * policy here, which is the same rule the pipe supervisor follows (C5).
 *
 * This writer sits in that path instead. It reads without ever stopping, appends
 * at most `capBytes`, and drops the rest, so the terminal can never block on a
 * full log and the command is never signalled. The retained bytes are the
 * beginning of the recording, because a prefix keeps every offset the line index
 * in `log-manager.ts` has already cached; a rotating file would not.
 *
 * Arguments: `<execDir> <capBytes>`. The target is `<execDir>/combined.log`,
 * and `<execDir>/log-cap.json` appears once the cap is reached — the same
 * record the pipe supervisor writes.
 */
import { closeSync, openSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

const [dir, capArgument] = process.argv.slice(2);
if (!dir) throw new Error("usage: recording-writer.mjs <execDir> <capBytes>");

const capBytes = Math.max(
  0,
  Number.isFinite(Number(capArgument)) ? Math.trunc(Number(capArgument)) : 100 * 1024 * 1024,
);
const target = join(dir, "combined.log");

/** @param {string} name @param {unknown} value */
function writeJsonAtomic(name, value) {
  const path = join(dir, name);
  const temporary = path + "." + process.pid + ".tmp";
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, path);
}

/** @type {number | undefined} */
let fd;
try {
  // The wrapper already created the file owner-only, so the mode here only
  // covers a start that raced the wrapper.
  fd = openSync(target, "w", 0o600);
} catch {
  // An unwritable recording is a diagnostic, not a reason to stop reading.
  fd = undefined;
}

let written = 0;
let capped = false;
let healthy = fd !== undefined;

function finish() {
  if (fd !== undefined) {
    try {
      closeSync(fd);
    } catch {
      /* the recording is already gone */
    }
    fd = undefined;
  }
  process.exit(0);
}

process.stdin.on("data", (chunk) => {
  const room = Math.max(0, capBytes - written);
  const slice = chunk.length <= room ? chunk : chunk.subarray(0, room);
  if (slice.length > 0 && healthy && fd !== undefined) {
    try {
      // Synchronous on purpose: a queued write would be lost when the shell is
      // killed by its group, and the recording is the only witness of a cancel.
      writeSync(fd, slice);
    } catch {
      healthy = false;
    }
  }
  written += slice.length;
  if (slice.length < chunk.length && !capped) {
    capped = true;
    try {
      writeJsonAtomic("log-cap.json", { capBytes, reachedAt: Date.now() });
    } catch {
      /* Logging protection must not become a process-level failure. */
    }
  }
});

process.stdin.on("end", finish);
process.stdin.on("close", finish);
process.stdin.on("error", finish);
