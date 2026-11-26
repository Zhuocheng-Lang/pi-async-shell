// SPDX-FileCopyrightText: 2026 Zhuocheng-Lang
// SPDX-License-Identifier: MPL-2.0

/**
 * The files a registry keeps on disk: atomic JSON, size and delta reads, the
 * stdin FIFO, and the names that answer a replay key.
 *
 * Nothing here reads registry state. Each function takes a path and returns a
 * value, which is what lets the registry, the adoption path and a test share one
 * definition of "atomic" instead of three. Keeping the definition here is also
 * what keeps `registry.ts` about the state machine rather than about fs.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";
import { open, rename } from "node:fs/promises";
import { sleep } from "./identity.ts";
import { completeUtf8Length } from "./utf8.ts";

/**
 * Write JSON so that a reader sees the old file or the new one, never a partial
 * one. A crash between the write and the rename leaves the previous contents in
 * place and a stray `.tmp` beside the record, and the suffix names the failure.
 */
export function writeJsonAtomicSync(path: string, value: unknown): void {
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, JSON.stringify(value, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/**
 * A record that cannot be read is absent, not fatal. Every caller has an answer
 * for a missing record, and none of them has one for a throw on the read path.
 */
export function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * The bytes appended since an offset, cut on a character boundary.
 *
 * The next call resumes where this one stopped, so a character split by the
 * window would be lost for good. Stop on a boundary instead, and let the
 * following poll pick up the rest.
 */
export function readDeltaSync(path: string, offset: number): { text: string; nextOffset: number } {
  try {
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      if (size <= offset) return { text: "", nextOffset: offset };
      const length = Math.min(size - offset, 256 * 1024);
      const buffer = Buffer.allocUnsafe(length);
      const read = readSync(fd, buffer, 0, length, offset);
      const usable = completeUtf8Length(buffer.subarray(0, read));
      return { text: buffer.subarray(0, usable).toString("utf8"), nextOffset: offset + usable };
    } finally {
      closeSync(fd);
    }
  } catch {
    return { text: "", nextOffset: offset };
  }
}

/**
 * Write to a pty execution's stdin FIFO.
 *
 * The open is non-blocking on purpose: a FIFO with no reader would otherwise
 * block this process forever, and "nobody is listening" is a fact the caller
 * needs, not a hang. A full pipe buffer is retried briefly, because the reader
 * on the other side drains continuously.
 */
export async function writeFifo(path: string, text: string): Promise<boolean> {
  let fd: number;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_NONBLOCK);
  } catch {
    return false;
  }
  try {
    const buffer = Buffer.from(text, "utf8");
    let offset = 0;
    let stalls = 0;
    while (offset < buffer.length) {
      try {
        offset += writeSync(fd, buffer, offset, buffer.length - offset);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EAGAIN" || stalls++ > 200) return false;
        await sleep(5);
      }
    }
    return true;
  } finally {
    closeSync(fd);
  }
}

export function sanitizeRequest(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96);
}

/**
 * Name the file that answers a replay key.
 *
 * Two problems share one file name, so it answers both. The sanitized form is
 * lossy: `"build one"` and `"build/one"` both become `build_one`, so the second
 * start would find the first one's record, return its handle, and never run its
 * command while reporting success. A key the sanitizer changed therefore carries
 * a digest of the exact string the caller passed. The kind is in the name too,
 * because one request key used by both `shell_start` and `shell_send` would
 * otherwise let a start replay answer with the id minted for a keystroke.
 */
export function requestFileName(request: string, kind: "start" | "send"): string {
  const safe = sanitizeRequest(request);
  const digest =
    safe === request ? "" : `.${createHash("sha256").update(request).digest("hex").slice(0, 12)}`;
  return `${safe}${digest}.${kind}.json`;
}

export async function writeJsonAtomic(path: string, value: unknown, sync = true): Promise<void> {
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(JSON.stringify(value, null, 2));
    if (sync) await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
}
