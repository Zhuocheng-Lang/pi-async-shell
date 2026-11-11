// SPDX-FileCopyrightText: 2026 Zhuocheng-Lang
// SPDX-License-Identifier: MPL-2.0

/**
 * A terminal screen, not a byte stream.
 *
 * `ptyView` answers a different question than `combined`: not "what bytes did
 * the program write" but "what is on the screen now". A program that redraws a
 * prompt, a progress bar, or a menu writes cursor motion and erasures; reading
 * that stream as lines shows every intermediate frame. This module replays the
 * stream into a grid and returns the viewport a human would see.
 *
 * It is deliberately small: the sequences a terminal UI actually emits, not the
 * whole ECMA-48 surface. Unhandled sequences are consumed and ignored, so an
 * unknown escape can never corrupt the text.
 */

export interface ScreenOptions {
  cols?: number;
  rows?: number;
  /** Lines kept above the viewport. */
  scrollback?: number;
}

export interface ScreenSnapshot {
  /** The visible viewport, right-trimmed, with trailing blank lines removed. */
  lines: string[];
  cols: number;
  rows: number;
  cursor: { row: number; col: number };
  /** True once the stream used cursor addressing: the program owns the screen. */
  addressed: boolean;
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_SCROLLBACK = 2000;

class Grid {
  readonly cols: number;
  readonly rows: number;
  readonly scrollback: number;
  private cells: string[][] = [[]];
  private top = 0;
  row = 0;
  col = 0;
  addressed = false;
  private savedCursor: { row: number; col: number } = { row: 0, col: 0 };

  /** Absolute index of the first visible row. */
  get topIndex(): number {
    return this.top;
  }

  constructor(options: ScreenOptions) {
    this.cols = clamp(options.cols, 20, 500, DEFAULT_COLS);
    this.rows = clamp(options.rows, 4, 200, DEFAULT_ROWS);
    this.scrollback = clamp(options.scrollback, 0, 20_000, DEFAULT_SCROLLBACK);
  }

  private ensureRow(row: number): string[] {
    while (this.cells.length <= row) this.cells.push([]);
    return this.cells[row] as string[];
  }

  private trimScrollback(): void {
    const excess = this.cells.length - (this.rows + this.scrollback);
    if (excess <= 0) return;
    this.cells.splice(0, excess);
    this.top = Math.max(0, this.top - excess);
    this.row = Math.max(0, this.row - excess);
    this.savedCursor = { row: Math.max(0, this.savedCursor.row - excess), col: this.savedCursor.col };
  }

  /** The furthest row a cursor may address: the screen plus its scrollback. */
  private get maxRow(): number {
    return this.top + this.rows + this.scrollback;
  }

  private scrollIntoView(): void {
    if (this.row < this.top + this.rows) return;
    this.top = this.row - this.rows + 1;
    this.trimScrollback();
  }

  newline(): void {
    this.row += 1;
    this.ensureRow(this.row);
    this.scrollIntoView();
  }

  carriageReturn(): void {
    this.col = 0;
  }

  backspace(): void {
    if (this.col > 0) this.col -= 1;
  }

  tab(): void {
    const next = (Math.floor(this.col / 8) + 1) * 8;
    this.col = Math.min(this.cols - 1, next);
  }

  write(char: string): void {
    if (this.col >= this.cols) {
      this.col = 0;
      this.newline();
    }
    const line = this.ensureRow(this.row);
    while (line.length < this.col) line.push(" ");
    line[this.col] = char;
    this.col += 1;
  }

  moveTo(row: number, col: number): void {
    this.row = Math.max(0, Math.min(row, this.maxRow));
    this.col = Math.max(0, Math.min(this.cols - 1, col));
    this.ensureRow(this.row);
    this.scrollIntoView();
  }

  up(n: number): void {
    this.row = Math.max(this.top, this.row - n);
  }

  down(n: number): void {
    this.row = Math.min(this.row + n, this.maxRow);
    this.ensureRow(this.row);
    this.scrollIntoView();
  }

  left(n: number): void {
    this.col = Math.max(0, this.col - n);
  }

  right(n: number): void {
    this.col = Math.min(this.cols - 1, this.col + n);
  }

  eraseLine(mode: number): void {
    const line = this.ensureRow(this.row);
    if (mode === 2) {
      line.length = 0;
      return;
    }
    if (mode === 1) {
      for (let index = 0; index <= this.col && index < line.length; index += 1) line[index] = " ";
      return;
    }
    line.length = Math.min(line.length, this.col);
  }

  eraseDisplay(mode: number): void {
    if (mode === 2 || mode === 3) {
      this.cells = [[]];
      this.top = 0;
      this.row = 0;
      this.col = 0;
      this.ensureRow(0);
      return;
    }
    if (mode === 1) {
      for (let row = this.top; row < this.row; row += 1) this.ensureRow(row).length = 0;
      const line = this.ensureRow(this.row);
      for (let index = 0; index <= this.col && index < line.length; index += 1) line[index] = " ";
      return;
    }
    this.eraseLine(0);
    for (let row = this.row + 1; row < this.cells.length; row += 1) (this.cells[row] as string[]).length = 0;
  }

  deleteChars(n: number): void {
    const line = this.ensureRow(this.row);
    if (this.col < line.length) line.splice(this.col, n);
  }

  insertChars(n: number): void {
    const line = this.ensureRow(this.row);
    while (line.length < this.col) line.push(" ");
    line.splice(this.col, 0, ...new Array<string>(n).fill(" "));
  }

  eraseChars(n: number): void {
    const line = this.ensureRow(this.row);
    for (let index = this.col; index < Math.min(this.col + n, line.length); index += 1) line[index] = " ";
  }

  insertLines(n: number): void {
    const blanks = Array.from({ length: n }, () => [] as string[]);
    this.cells.splice(this.row, 0, ...blanks);
    this.trimScrollback();
  }

  deleteLines(n: number): void {
    this.cells.splice(this.row, n);
    if (this.cells.length === 0) this.cells = [[]];
  }

  saveCursor(): void {
    this.savedCursor = { row: this.row, col: this.col };
  }

  restoreCursor(): void {
    this.moveTo(this.savedCursor.row, this.savedCursor.col);
  }

  snapshot(): ScreenSnapshot {
    const viewport = this.cells.slice(this.top, this.top + this.rows);
    const lines = viewport.map((line) => (line ?? []).join("").replace(/\s+$/, ""));
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return {
      lines,
      cols: this.cols,
      rows: this.rows,
      cursor: { row: this.row - this.top, col: this.col },
      addressed: this.addressed,
    };
  }
}

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  if (!value || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

interface Csi {
  params: number[];
  final: string;
  length: number;
}

function readCsi(input: string, start: number): Csi | undefined {
  // input[start] is the byte after ESC [.
  let index = start;
  let params = "";
  while (index < input.length) {
    const char = input[index] as string;
    if (char >= "0" && char <= "9") params += char;
    else if (char === ";" || char === ":") params += ";";
    else if (char === "?" || char === ">" || char === "!" || char === "<" || char === "=") {
      // Private modes carry no text meaning for us.
      params += " ";
    } else break;
    index += 1;
  }
  if (index >= input.length) return undefined;
  const final = input[index] as string;
  if (final < "@" || final > "~") return undefined;
  const numbers = params
    .split(";")
    .map((part) => Number.parseInt(part, 10))
    .map((value) => (Number.isFinite(value) ? value : 0));
  return { params: numbers, final, length: index - start + 1 };
}

function applyCsi(grid: Grid, csi: Csi): void {
  const first = csi.params[0] ?? 0;
  const count = first === 0 ? 1 : first;
  const row = csi.params[0] ?? 1;
  const col = csi.params[1] ?? 1;
  switch (csi.final) {
    case "H":
    case "f":
      grid.addressed = true;
      grid.moveTo(grid.topIndex + row - 1, col - 1);
      return;
    case "A":
      grid.up(count);
      return;
    case "B":
      grid.down(count);
      return;
    case "C":
      grid.right(count);
      return;
    case "D":
      grid.left(count);
      return;
    case "E":
      grid.down(count);
      grid.carriageReturn();
      return;
    case "F":
      grid.up(count);
      grid.carriageReturn();
      return;
    case "G":
      grid.moveTo(grid.row, row - 1);
      return;
    case "d":
      grid.moveTo(grid.topIndex + row - 1, grid.col);
      return;
    case "J":
      grid.eraseDisplay(first);
      return;
    case "K":
      grid.eraseLine(first);
      return;
    // Character and line counts are clamped to the screen, as a terminal does.
    // Without the clamp a recording could ask for 9999 blank lines per sequence
    // and grow the grid without bound.
    case "P":
      grid.deleteChars(Math.min(count, grid.cols));
      return;
    case "@":
      grid.insertChars(Math.min(count, grid.cols));
      return;
    case "X":
      grid.eraseChars(Math.min(count, grid.cols));
      return;
    case "L":
      grid.insertLines(Math.min(count, grid.rows));
      return;
    case "M":
      grid.deleteLines(Math.min(count, grid.rows));
      return;
    case "S":
      grid.deleteLines(Math.min(count, grid.rows));
      return;
    case "T":
      grid.insertLines(Math.min(count, grid.rows));
      return;
    case "s":
      grid.saveCursor();
      return;
    case "u":
      grid.restoreCursor();
      return;
    default:
      // SGR (m), modes (h/l), device reports and the rest carry no text.
      return;
  }
}

/**
 * Replay a terminal byte stream into the viewport it produced.
 *
 * `input` should start at a line boundary; a tail window that begins inside an
 * escape sequence would otherwise render its parameters as text.
 */
export function renderScreen(input: string, options: ScreenOptions = {}): ScreenSnapshot {
  const grid = new Grid(options);
  let index = 0;
  while (index < input.length) {
    const char = input[index] as string;
    if (char === "\u001b") {
      const next = input[index + 1];
      if (next === "[") {
        const csi = readCsi(input, index + 2);
        if (csi) {
          applyCsi(grid, csi);
          index += 2 + csi.length;
          continue;
        }
        index += 2;
        continue;
      }
      if (next === "]") {
        // OSC runs to BEL or ST; titles and hyperlinks live here.
        let end = index + 2;
        while (end < input.length) {
          if (input[end] === "\u0007") break;
          if (input[end] === "\u001b" && input[end + 1] === "\\") {
            end += 1;
            break;
          }
          end += 1;
        }
        index = end + 1;
        continue;
      }
      if (next === "(" || next === ")" || next === "#") {
        index += 3;
        continue;
      }
      if (next === "7") {
        grid.saveCursor();
        index += 2;
        continue;
      }
      if (next === "8") {
        grid.restoreCursor();
        index += 2;
        continue;
      }
      index += 2;
      continue;
    }
    if (char === "\r") {
      grid.carriageReturn();
      index += 1;
      continue;
    }
    if (char === "\n") {
      grid.newline();
      index += 1;
      continue;
    }
    if (char === "\b") {
      grid.backspace();
      index += 1;
      continue;
    }
    if (char === "\t") {
      grid.tab();
      index += 1;
      continue;
    }
    if (char < " ") {
      index += 1;
      continue;
    }
    const code = char.codePointAt(0) as number;
    if (code > 0xffff) {
      grid.write(String.fromCodePoint(code));
      index += 2;
      continue;
    }
    grid.write(char);
    index += 1;
  }
  return grid.snapshot();
}
