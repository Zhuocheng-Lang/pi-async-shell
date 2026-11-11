// SPDX-FileCopyrightText: 2026 Zhuocheng-Lang
// SPDX-License-Identifier: MPL-2.0

import { createWriteStream, type WriteStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { stripAnsi } from "./ansi.ts";
import { renderScreen } from "./screen.ts";
import type { ByteCounts, ShellReadParams, ShellReadRange } from "./types.ts";

export const DEFAULT_MAX_LOG_BYTES = 100 * 1024 * 1024;
export const MAX_READ_LINES = 2000;
export const MAX_READ_BYTES = 50 * 1024;
export const DEFAULT_READ_LINES = 200;
export const DEFAULT_READ_BYTES = 16 * 1024;

export interface LogWriterOptions {
  stdoutPath: string;
  stderrPath: string;
  combinedPath: string;
  capBytes?: number;
  /** Called whenever bytes are appended or the cap is reached. */
  onChange?: (bytes: ByteCounts) => void;
}

/**
 * Durable output with a cap that is a *logging* policy, never a *process* policy.
 *
 * When the cap is reached the writer stops appending, but the caller keeps
 * draining the pipe and discards the surplus. A Linux pipe holds 64 KiB by
 * default; a cap implemented as "stop reading" turns a logging decision into a
 * blocked child, which is the failure this class exists to avoid.
 */
export class LogWriter {
  readonly bytes: ByteCounts = { stdout: 0, stderr: 0, combined: 0, capReached: false };
  private readonly capBytes: number;
  private readonly stdoutStream: WriteStream;
  private readonly stderrStream: WriteStream;
  private readonly combinedStream: WriteStream;
  private readonly onChange?: (bytes: ByteCounts) => void;
  private closed = false;

  constructor(options: LogWriterOptions) {
    this.capBytes = options.capBytes ?? DEFAULT_MAX_LOG_BYTES;
    this.onChange = options.onChange;
    this.stdoutStream = createWriteStream(options.stdoutPath, { flags: "a" });
    this.stderrStream = createWriteStream(options.stderrPath, { flags: "a" });
    this.combinedStream = createWriteStream(options.combinedPath, { flags: "a" });
    for (const stream of [this.stdoutStream, this.stderrStream, this.combinedStream]) {
      stream?.on("error", () => {
        /* A log write failure must never take the execution down. */
      });
    }
  }

  get capReached(): boolean {
    return this.bytes.capReached;
  }

  /** The remaining budget before the cap, in bytes. */
  get remaining(): number {
    return Math.max(0, this.capBytes - this.bytes.combined);
  }

  writeStdout(chunk: Buffer): void {
    this.append(chunk, "stdout");
  }

  writeStderr(chunk: Buffer): void {
    this.append(chunk, "stderr");
  }

  private append(chunk: Buffer, kind: "stdout" | "stderr"): void {
    if (this.closed) return;
    const size = chunk.length;
    if (kind === "stdout") this.bytes.stdout += size;
    else this.bytes.stderr += size;
    if (this.bytes.combined >= this.capBytes) {
      if (!this.bytes.capReached) {
        this.bytes.capReached = true;
        this.onChange?.({ ...this.bytes });
      }
      // Drain and discard. Never pause the source.
      return;
    }
    const room = this.capBytes - this.bytes.combined;
    const slice = size <= room ? chunk : chunk.subarray(0, room);
    if (kind === "stderr") this.stderrStream.write(slice);
    else this.stdoutStream.write(slice);
    this.combinedStream.write(slice);
    this.bytes.combined += slice.length;
    if (slice.length < size && !this.bytes.capReached) {
      this.bytes.capReached = true;
    }
    this.onChange?.({ ...this.bytes });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all(
      [this.stdoutStream, this.stderrStream, this.combinedStream].map(
        (stream) =>
          new Promise<void>((resolveClose) => {
            stream.end(() => resolveClose());
          }),
      ),
    );
  }
}

interface IndexEntry {
  size: number;
  scannedBytes: number;
  totalLines: number;
  /** Byte offset of every 256th line start. */
  checkpoints: number[];
}

const indexCache = new Map<string, IndexEntry>();
const CHECKPOINT_EVERY = 256;
const SCAN_CHUNK = 1024 * 1024;

/**
 * A sparse line index: one checkpoint every 256 lines, extended incrementally as
 * the file grows. `mode: "offset"` can then seek instead of scanning.
 */
export async function lineIndex(path: string): Promise<IndexEntry> {
  const info = await stat(path).catch(() => undefined);
  const size = info?.size ?? 0;
  let entry = indexCache.get(path);
  if (!entry) {
    entry = { size: 0, scannedBytes: 0, totalLines: 0, checkpoints: [0] };
    indexCache.set(path, entry);
  }
  if (size < entry.scannedBytes) {
    // The file was truncated or replaced; rebuild.
    entry = { size: 0, scannedBytes: 0, totalLines: 0, checkpoints: [0] };
    indexCache.set(path, entry);
  }
  if (size === entry.scannedBytes) {
    entry.size = size;
    return entry;
  }

  const handle = await open(path, "r");
  try {
    let position = entry.scannedBytes;
    while (position < size) {
      const length = Math.min(SCAN_CHUNK, size - position);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead <= 0) break;
      for (let i = 0; i < bytesRead; i += 1) {
        if (buffer[i] !== 0x0a) continue;
        entry.totalLines += 1;
        const lineStart = position + i + 1;
        if (entry.totalLines % CHECKPOINT_EVERY === 0 && lineStart < size) {
          entry.checkpoints.push(lineStart);
        }
      }
      position += bytesRead;
    }
    entry.scannedBytes = position;
    entry.size = size;
  } finally {
    await handle.close();
  }
  return entry;
}

/** Byte offset of a 1-based line number. */
export async function byteOffsetOfLine(path: string, line: number): Promise<number> {
  if (line <= 1) return 0;
  const entry = await lineIndex(path);
  const checkpointIndex = Math.min(
    entry.checkpoints.length - 1,
    Math.floor((line - 1) / CHECKPOINT_EVERY),
  );
  let offset = entry.checkpoints[checkpointIndex] ?? 0;
  let currentLine = checkpointIndex * CHECKPOINT_EVERY + 1;
  if (currentLine >= line) return offset;

  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    const buffer = Buffer.allocUnsafe(SCAN_CHUNK);
    let position = offset;
    while (position < info.size && currentLine < line) {
      const length = Math.min(SCAN_CHUNK, info.size - position);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead <= 0) break;
      for (let i = 0; i < bytesRead; i += 1) {
        if (buffer[i] !== 0x0a) continue;
        currentLine += 1;
        if (currentLine === line) {
          offset = position + i + 1;
          return offset;
        }
      }
      position += bytesRead;
    }
    return position;
  } finally {
    await handle.close();
  }
}

async function readRange(path: string, start: number, length: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export interface ReadOutcome {
  text: string;
  truncated: boolean;
  totalLines: number;
  totalBytes: number;
  range: ShellReadRange;
  note?: string;
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  // A trailing newline produces a final empty element that is not a line.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function clampLines(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) return DEFAULT_READ_LINES;
  return Math.max(1, Math.min(MAX_READ_LINES, Math.floor(value)));
}

function clampBytes(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) return DEFAULT_READ_BYTES;
  return Math.max(64, Math.min(MAX_READ_BYTES, Math.floor(value)));
}

function cutToBytes(text: string, maxBytes: number, from: "start" | "end"): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return { text, truncated: false };
  const slice = from === "start" ? buffer.subarray(0, maxBytes) : buffer.subarray(buffer.length - maxBytes);
  let out = slice.toString("utf8");
  if (from === "end") {
    const newline = out.indexOf("\n");
    if (newline >= 0 && newline < out.length - 1) out = out.slice(newline + 1);
  } else {
    const newline = out.lastIndexOf("\n");
    if (newline > 0) out = out.slice(0, newline + 1);
  }
  return { text: out, truncated: true };
}

export async function readLog(path: string, params: ShellReadParams): Promise<ReadOutcome> {
  const info = await stat(path).catch(() => undefined);
  const totalBytes = info?.size ?? 0;
  const index = await lineIndex(path);
  const totalLines = index.totalLines;
  const mode = params.mode ?? "tail";
  const maxLines = clampLines(params.lines);
  const maxBytes = clampBytes(params.maxBytes);
  const shouldStrip = params.stripAnsi !== false;

  const finish = (raw: string, range: ShellReadRange, truncated: boolean, note?: string): ReadOutcome => {
    // A terminal-backed binding records CRLF; a line-oriented read normalizes it
    // so a pattern anchored at the end of a line still matches.
    const text = shouldStrip ? stripAnsi(raw).replace(/\r\n/g, "\n").replace(/\r$/gm, "") : raw;
    return { text, truncated, totalLines, totalBytes, range, note };
  };

  if (totalBytes === 0) {
    return finish("", { startByte: 0, endByte: 0, nextByte: 0 }, false);
  }

  if (mode === "head") {
    const window = Math.min(totalBytes, Math.max(maxBytes * 4, 64 * 1024));
    const buffer = await readRange(path, 0, window);
    const lines = splitLines(buffer.toString("utf8")).slice(0, maxLines);
    const joined = lines.join("\n");
    const cut = cutToBytes(joined, maxBytes, "start");
    const endByte = cut.truncated
      ? Buffer.byteLength(cut.text, "utf8")
      : Math.min(Buffer.byteLength(joined, "utf8") + (lines.length > 0 ? 1 : 0), totalBytes);
    return finish(cut.text, { startLine: 1, endLine: lines.length, startByte: 0, endByte, nextLine: lines.length + 1, nextByte: endByte }, cut.truncated || buffer.length < totalBytes);
  }

  if (mode === "offset") {
    let startByte = 0;
    let startLine: number | undefined;
    if (typeof params.byteOffset === "number" && params.byteOffset > 0) {
      startByte = Math.min(params.byteOffset, totalBytes);
    } else if (typeof params.lineOffset === "number" && params.lineOffset > 1) {
      startLine = Math.floor(params.lineOffset);
      startByte = await byteOffsetOfLine(path, startLine);
    }
    const window = Math.min(totalBytes - startByte, Math.max(maxBytes * 4, 64 * 1024));
    const buffer = await readRange(path, startByte, window);
    const lines = splitLines(buffer.toString("utf8")).slice(0, maxLines);
    const joined = lines.join("\n");
    const cut = cutToBytes(joined, maxBytes, "start");
    const consumed = cut.truncated
      ? Buffer.byteLength(cut.text, "utf8")
      : Math.min(Buffer.byteLength(joined, "utf8") + (lines.length > 0 ? 1 : 0), totalBytes - startByte);
    const endByte = startByte + consumed;
    if (startLine === undefined) {
      startLine = (await lineIndex(path)).totalLines === 0 ? 1 : await lineOfByte(path, startByte);
    }
    return finish(
      cut.text,
      {
        startLine,
        endLine: startLine + lines.length - 1,
        startByte,
        endByte,
        nextLine: startLine + lines.length,
        nextByte: endByte,
      },
      cut.truncated || startByte + buffer.length < totalBytes,
    );
  }

  if (mode === "grep") {
    return grepLog(path, params, { totalLines, totalBytes, shouldStrip, maxLines, maxBytes, finish });
  }

  // tail
  const window = Math.min(totalBytes, Math.max(maxBytes * 4, 64 * 1024));
  const start = totalBytes - window;
  const buffer = await readRange(path, start, window);
  let lines = splitLines(buffer.toString("utf8"));
  if (start > 0 && lines.length > 0) lines = lines.slice(1); // drop the partial first line
  const tailLines = lines.slice(Math.max(0, lines.length - maxLines));
  const joined = tailLines.join("\n");
  const cut = cutToBytes(joined, maxBytes, "end");
  const endByte = totalBytes;
  const startByte = Math.max(0, endByte - Buffer.byteLength(cut.text, "utf8"));
  const startLine = Math.max(1, totalLines - tailLines.length + 1);
  return finish(
    cut.text,
    {
      startLine,
      endLine: totalLines,
      startByte,
      endByte,
      nextLine: totalLines + 1,
      nextByte: endByte,
    },
    cut.truncated || start > 0,
  );
}

export interface ScreenReadOptions {
  cols?: number;
  rows?: number;
}

/**
 * Read a terminal recording as the screen it produced.
 *
 * The recording is replayed through the screen model instead of being returned
 * as bytes, so a redrawn prompt shows its final frame rather than every frame.
 * Only the tail of the file is replayed: the viewport is what a caller can act
 * on, and replaying a 100 MiB recording to show 40 lines is not a read.
 */
export async function readScreenLog(
  path: string,
  params: ShellReadParams,
  screen: ScreenReadOptions = {},
): Promise<ReadOutcome> {
  const info = await stat(path).catch(() => undefined);
  const totalBytes = info?.size ?? 0;
  const maxLines = clampLines(params.lines);
  const maxBytes = clampBytes(params.maxBytes);
  const mode = params.mode ?? "tail";
  if (totalBytes === 0) {
    return { text: "", truncated: false, totalLines: 0, totalBytes, range: { startByte: 0, endByte: 0, nextByte: 0 } };
  }
  const window = Math.min(totalBytes, Math.max(maxBytes * 8, 256 * 1024));
  const start = totalBytes - window;
  const buffer = await readRange(path, start, window);
  let raw = buffer.toString("utf8");
  if (start > 0) {
    // Never start the replay inside an escape sequence.
    const newline = raw.indexOf("\n");
    raw = newline >= 0 ? raw.slice(newline + 1) : "";
  }
  const snapshot = renderScreen(raw, { cols: screen.cols, rows: screen.rows });
  const lines = snapshot.lines;
  const note = `rendered ${snapshot.cols}x${snapshot.rows} terminal screen from ${totalBytes} recorded bytes`;
  const range = (startLine: number, endLine: number): ShellReadRange => ({
    startLine,
    endLine,
    startByte: start,
    endByte: totalBytes,
    nextLine: endLine + 1,
    nextByte: totalBytes,
  });

  if (mode === "grep") {
    const pattern = params.pattern;
    if (!pattern) throw new Error("shell_read mode=grep requires a pattern");
    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch (error) {
      throw new Error(`invalid grep pattern: ${(error as Error).message}`);
    }
    const context = Math.max(0, Math.min(20, params.context ?? 2));
    const wanted = new Set<number>();
    let matches = 0;
    lines.forEach((line, index) => {
      if (!regex.test(line)) return;
      matches += 1;
      for (let n = index - context; n <= index + context; n += 1) {
        if (n >= 0 && n < lines.length) wanted.add(n);
      }
    });
    if (matches === 0) {
      return { text: "", truncated: false, totalLines: lines.length, totalBytes, range: range(1, 0), note: `${note}; no lines matched` };
    }
    const ordered = [...wanted].sort((a, b) => a - b);
    const selected = ordered.map((index) => `${index + 1}: ${lines[index]}`);
    const cut = cutToBytes(selected.join("\n"), maxBytes, "start");
    return {
      text: cut.text,
      truncated: cut.truncated,
      totalLines: lines.length,
      totalBytes,
      range: range((ordered[0] ?? 0) + 1, (ordered[ordered.length - 1] ?? 0) + 1),
      note: `${note}; ${matches} matching line(s)`,
    };
  }

  let selected: string[];
  let firstLine: number;
  if (mode === "head") {
    selected = lines.slice(0, maxLines);
    firstLine = 1;
  } else if (mode === "offset") {
    firstLine = Math.max(1, Math.floor(params.lineOffset ?? 1));
    selected = lines.slice(firstLine - 1, firstLine - 1 + maxLines);
  } else {
    selected = lines.slice(Math.max(0, lines.length - maxLines));
    firstLine = lines.length - selected.length + 1;
  }
  const cut = cutToBytes(selected.join("\n"), maxBytes, mode === "head" ? "start" : "end");
  return {
    text: cut.text,
    truncated: cut.truncated || selected.length < lines.length,
    totalLines: lines.length,
    totalBytes,
    range: range(firstLine, firstLine + selected.length - 1),
    note,
  };
}

async function lineOfByte(path: string, byte: number): Promise<number> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    const length = Math.min(byte, info.size);
    if (length === 0) return 1;
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    let lines = 1;
    for (let i = 0; i < bytesRead; i += 1) if (buffer[i] === 0x0a) lines += 1;
    return lines;
  } finally {
    await handle.close();
  }
}

interface GrepContext {
  totalLines: number;
  totalBytes: number;
  shouldStrip: boolean;
  maxLines: number;
  maxBytes: number;
  finish: (raw: string, range: ShellReadRange, truncated: boolean, note?: string) => ReadOutcome;
}

async function grepLog(path: string, params: ShellReadParams, context: GrepContext): Promise<ReadOutcome> {
  const pattern = params.pattern;
  if (!pattern) throw new Error("shell_read mode=grep requires a pattern");
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (error) {
    throw new Error(`invalid grep pattern: ${(error as Error).message}`);
  }
  const before = Math.max(0, Math.min(20, params.context ?? 2));
  const after = before;

  const handle = await open(path, "r");
  const matches: { line: number; text: string }[] = [];
  const wanted = new Set<number>();
  let lineNumber = 0;
  let byteOffset = 0;
  let matchedLines = 0;
  let truncated = false;
  try {
    const info = await handle.stat();
    const buffer = Buffer.allocUnsafe(SCAN_CHUNK);
    let position = 0;
    let carry = "";
    while (position < info.size) {
      const length = Math.min(SCAN_CHUNK, info.size - position);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead <= 0) break;
      const text = carry + buffer.subarray(0, bytesRead).toString("utf8");
      const lines = text.split("\n");
      carry = lines.pop() ?? "";
      for (const rawLine of lines) {
        lineNumber += 1;
        byteOffset += Buffer.byteLength(rawLine, "utf8") + 1;
        const line = rawLine.replace(/\r$/, "");
        if (regex.test(line)) {
          matchedLines += 1;
          matches.push({ line: lineNumber, text: line });
          for (let n = lineNumber - before; n <= lineNumber + after; n += 1) {
            if (n >= 1) wanted.add(n);
          }
          if (matchedLines > context.maxLines * 4) {
            truncated = true;
            break;
          }
        }
      }
      position += bytesRead;
      if (truncated) break;
    }
    if (!truncated && carry.length > 0) {
      lineNumber += 1;
      const tail = carry.replace(/\r$/, "");
      if (regex.test(tail)) {
        matches.push({ line: lineNumber, text: tail });
        for (let n = lineNumber - before; n <= lineNumber + after; n += 1) {
          if (n >= 1) wanted.add(n);
        }
      }
    }
  } finally {
    await handle.close();
  }

  if (matches.length === 0) {
    return context.finish("", { startLine: 1, endLine: 0 }, false, "no lines matched");
  }

  // Second pass: collect the wanted lines with their numbers.
  const wantedSorted = [...wanted].sort((a, b) => a - b);
  const selected: string[] = [];
  let lastEmitted = 0;
  let emitted = 0;
  let outputTruncated = truncated;
  const handle2 = await open(path, "r");
  try {
    const info = await handle2.stat();
    const buffer = Buffer.allocUnsafe(SCAN_CHUNK);
    let position = 0;
    let lineNumber = 0;
    let carry = "";
    let wantedIndex = 0;
    outer: while (position < info.size) {
      const length = Math.min(SCAN_CHUNK, info.size - position);
      const { bytesRead } = await handle2.read(buffer, 0, length, position);
      if (bytesRead <= 0) break;
      const text = carry + buffer.subarray(0, bytesRead).toString("utf8");
      const lines = text.split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) {
        lineNumber += 1;
        if (wantedIndex >= wantedSorted.length) break outer;
        if (lineNumber !== wantedSorted[wantedIndex]) continue;
        wantedIndex += 1;
        if (emitted >= context.maxLines) {
          outputTruncated = true;
          break outer;
        }
        if (lastEmitted > 0 && lineNumber > lastEmitted + 1) selected.push("--");
        selected.push(`${lineNumber}: ${line.replace(/\r$/, "")}`);
        lastEmitted = lineNumber;
        emitted += 1;
      }
      position += bytesRead;
    }
  } finally {
    await handle2.close();
  }

  const joined = selected.join("\n");
  const cut = cutToBytes(joined, context.maxBytes, "start");
  const first = matches[0];
  return context.finish(
    cut.text,
    { startLine: wantedSorted[0], endLine: lastEmitted, nextLine: lastEmitted + 1 },
    cut.truncated || outputTruncated,
    `${matches.length} matching line(s); first match at line ${first?.line ?? 0}`,
  );
}

export function clearIndexCache(path?: string): void {
  if (path) indexCache.delete(path);
  else indexCache.clear();
}
