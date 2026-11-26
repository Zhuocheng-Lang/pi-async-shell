// SPDX-FileCopyrightText: 2026 Zhuocheng-Lang
// SPDX-License-Identifier: MPL-2.0

/**
 * A terminal viewport is not a log. When a caller asks for the byte stream we
 * strip escape sequences; when it asks for `ptyView` we keep them, because that
 * is what the terminal displayed.
 */
const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
// OSC hyperlinks and titles may end with ST (ESC \\), not only BEL. The
// general expression above consumes the BEL form but leaves the ST delimiter.
const OSC_PATTERN = new RegExp("\\u001B\\][\\s\\S]*?(?:\\u0007|\\u001B\\\\)", "g");

export function stripAnsi(input: string): string {
  return input.replace(OSC_PATTERN, "").replace(ANSI_PATTERN, "");
}
