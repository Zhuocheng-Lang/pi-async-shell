// SPDX-FileCopyrightText: 2026 Zhuocheng-Lang
// SPDX-License-Identifier: MPL-2.0

/**
 * Where a byte window may end.
 *
 * Two readers cut a window out of a growing file: the log reader below the
 * registry and the registry's own delta poll. Both need the same answer, and
 * neither needs the terminal replay model that the log reader also imports.
 */

/**
 * The largest prefix length that ends on a UTF-8 character boundary.
 *
 * A read window ends wherever the byte count says, which can be inside a
 * multi-byte character. Decoding that tail yields U+FFFD, so the partial bytes
 * are excluded and the caller picks them up in the next window.
 */
export function completeUtf8Length(buffer: Buffer): number {
  for (let back = 1; back <= Math.min(4, buffer.length); back += 1) {
    const byte = buffer[buffer.length - back] as number;
    if ((byte & 0xc0) === 0x80) continue; // a continuation byte: keep looking back
    const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return needed > back ? buffer.length - back : buffer.length;
  }
  return buffer.length;
}
