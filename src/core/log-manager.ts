// SPDX-FileCopyrightText: 2026 Zhuocheng-Lang
// SPDX-License-Identifier: MPL-2.0

import { open, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { stripAnsi } from "./ansi.ts";
import { compilePattern } from "./pattern.ts";
import { renderScreen } from "./screen.ts";
import { clampPtySize, type PtySize, type ShellReadParams, type ShellReadRange } from "./types.ts";
import { completeUtf8Length } from "./utf8.ts";

export const DEFAULT_MAX_LOG_BYTES = 100 * 1024 * 1024;
export const MAX_READ_LINES = 2000;
export const MAX_READ_BYTES = 50 * 1024;
export const DEFAULT_READ_LINES = 200;
export const DEFAULT_READ_BYTES = 16 * 1024;

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

/**
 * Decode one read window.
 *
 * `complete` says whether the window reaches EOF. When it does not, its last
 * line is a fragment of a line that continues in the next window, and its last
 * bytes may be a fragment of a character; neither belongs in the answer.
 */
function decodeWindow(buffer: Buffer, complete: boolean): string[] {
  const usable = buffer.subarray(0, completeUtf8Length(buffer));
  const lines = splitLines(usable.toString("utf8"));
  if (!complete && lines.length > 0) lines.pop();
  return lines;
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
    const lines = decodeWindow(buffer, buffer.length >= totalBytes).slice(0, maxLines);
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
    const lines = decodeWindow(buffer, startByte + buffer.length >= totalBytes).slice(0, maxLines);
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
  /**
   * The geometry the child ran at, as the spawn recorded it. Absent means the
   * record was unreadable, and the note says the default was assumed rather than
   * presenting it as the size the program saw.
   */
  size?: PtySize;
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
    return { text: "", truncated: false, totalLines: 0, totalBytes, range: { startByte: 0, endByte: 0 } };
  }
  const geometry = clampPtySize(screen.size ?? {});
  const window = Math.min(totalBytes, Math.max(maxBytes * 8, 256 * 1024));
  const start = totalBytes - window;
  const buffer = await readRange(path, start, window);
  let raw = buffer.subarray(0, completeUtf8Length(buffer)).toString("utf8");
  let aligned = true;
  if (start > 0) {
    // A replay may not begin inside an escape sequence or in the middle of a
    // frame. A carriage return is a boundary too: a progress bar that only ever
    // draws with \r has no newline to align on, and reading "no newline" as
    // "nothing to replay" turned a 300 KiB recording into an empty screen.
    const boundary = raw.search(/[\n\r]/);
    aligned = boundary >= 0;
    raw = aligned ? raw.slice(boundary + 1) : "";
  }
  const snapshot = renderScreen(raw, geometry);
  const lines = snapshot.lines;
  // Everything a caller needs to judge the viewport, said once.
  const notes = [`rendered ${snapshot.cols}x${snapshot.rows} terminal screen from ${totalBytes} recorded bytes`];
  if (!screen.size) {
    notes.push(`the recorded terminal size was unreadable, so the default ${snapshot.cols}x${snapshot.rows} was assumed`);
  }
  if (start > 0) {
    notes.push(
      aligned
        ? `the replay covered the last ${window} of ${totalBytes} bytes, so frames drawn before that window are not in this viewport`
        : "the replay window began inside a line with no line break or carriage return, so the viewport could not be reconstructed; read stream \"combined\" for the bytes",
    );
  }
  if (snapshot.addressed) {
    notes.push("the program addressed the cursor, so this is a replayed screen rather than a tail of its output");
  }
  const note = notes.join("; ");
  // A window that could not be aligned lost frames, which is exactly what a
  // caller must not read as "the screen was empty".
  const windowed = start > 0 || !aligned;
  const range = (startLine: number, endLine: number): ShellReadRange => ({
    // A screen read is not pageable. These are viewport rows, not file lines,
    // and there is no byte a caller could continue from: naming an offset that
    // is already EOF is what made "page with nextByte" a no-op.
    startLine,
    endLine,
    startByte: start,
    endByte: totalBytes,
  });

  if (mode === "grep") {
    const pattern = params.pattern;
    if (!pattern) throw new Error("shell_read mode=grep requires a pattern");
    const regex = compilePattern(pattern, "shell_read pattern");
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
      return {
        text: "",
        truncated: windowed,
        totalLines: lines.length,
        totalBytes,
        range: range(1, 0),
        note: `${note}; no lines matched`,
      };
    }
    const ordered = [...wanted].sort((a, b) => a - b);
    const selected = ordered.map((index) => `${index + 1}: ${lines[index]}`);
    const cut = cutToBytes(selected.join("\n"), maxBytes, "start");
    return {
      text: cut.text,
      truncated: cut.truncated || windowed,
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
    truncated: cut.truncated || selected.length < lines.length || windowed,
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
  const regex = compilePattern(pattern, "shell_read pattern");
  const before = Math.max(0, Math.min(20, params.context ?? 2));
  const after = before;

  const handle = await open(path, "r");
  const matches: { line: number; text: string }[] = [];
  const wanted = new Set<number>();
  let lineNumber = 0;
  let matchedLines = 0;
  let truncated = false;
  // A chunk boundary is a byte offset, not a character boundary. Decoding each
  // chunk on its own turns a split character into U+FFFD, and a pattern written
  // in any non-ASCII script then silently stops matching across that boundary.
  const decoder = new StringDecoder("utf8");
  try {
    const info = await handle.stat();
    const buffer = Buffer.allocUnsafe(SCAN_CHUNK);
    let position = 0;
    let carry = "";
    while (position < info.size) {
      const length = Math.min(SCAN_CHUNK, info.size - position);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead <= 0) break;
      const text = carry + decoder.write(buffer.subarray(0, bytesRead));
      const lines = text.split("\n");
      carry = lines.pop() ?? "";
      for (const rawLine of lines) {
        lineNumber += 1;
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
    if (!truncated) carry += decoder.end();
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
    const selectedDecoder = new StringDecoder("utf8");
    let position = 0;
    let lineNumber = 0;
    let carry = "";
    let wantedIndex = 0;
    outer: while (position < info.size) {
      const length = Math.min(SCAN_CHUNK, info.size - position);
      const { bytesRead } = await handle2.read(buffer, 0, length, position);
      if (bytesRead <= 0) break;
      const text = carry + selectedDecoder.write(buffer.subarray(0, bytesRead));
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
