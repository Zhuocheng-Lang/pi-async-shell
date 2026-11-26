// SPDX-FileCopyrightText: 2026 Zhuocheng-Lang
// SPDX-License-Identifier: MPL-2.0

/**
 * Key names to the bytes a terminal would have sent.
 *
 * This is the input half of what `screen.ts` does for output, and it has no
 * dependency on anything in the runtime, so it can be read and tested on its own.
 */

const KEY_BYTES: Record<string, string> = {
  enter: "\r",
  return: "\r",
  tab: "\t",
  escape: "\u001b",
  esc: "\u001b",
  backspace: "\u007f",
  space: " ",
  delete: "\u001b[3~",
  insert: "\u001b[2~",
  up: "\u001b[A",
  down: "\u001b[B",
  right: "\u001b[C",
  left: "\u001b[D",
  home: "\u001b[H",
  end: "\u001b[F",
  pageup: "\u001b[5~",
  pagedown: "\u001b[6~",
  f1: "\u001bOP",
  f2: "\u001bOQ",
  f3: "\u001bOR",
  f4: "\u001bOS",
  f5: "\u001b[15~",
  f6: "\u001b[17~",
  f7: "\u001b[18~",
  f8: "\u001b[19~",
  f9: "\u001b[20~",
  f10: "\u001b[21~",
  f11: "\u001b[23~",
  f12: "\u001b[24~",
};

/** `Ctrl+C`, `ctrl c`, `ctrl-c` and `CTRL+C` are one key, not four. */
function normalizeKeyName(key: string): string {
  return key.trim().toLowerCase().replace(/[\s+_-]+/g, "");
}

/**
 * Turn a key name into the bytes a terminal would have sent.
 *
 * A name nobody recognizes throws. Writing the name as literal text instead
 * reports `wrote: true`, so a typo in a key chord looks like a delivered
 * keystroke that the program simply ignored, and the caller debugs the program.
 */
export function keyToBytes(key: string): string {
  if (key.length === 1) return key; // a single character is itself
  const name = normalizeKeyName(key);
  const named = KEY_BYTES[name];
  if (named !== undefined) return named;
  const control = /^ctrl([a-z])$/.exec(name);
  if (control) return String.fromCharCode((control[1] as string).charCodeAt(0) - 96);
  throw new Error(
    `shell_send does not know the key "${key}". Send literal input as text, or use one of: ${[
      ...Object.keys(KEY_BYTES),
      "Ctrl+<letter>",
    ].join(", ")}.`,
  );
}
