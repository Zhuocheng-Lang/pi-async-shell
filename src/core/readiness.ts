// SPDX-FileCopyrightText: 2026 Zhuocheng-Lang
// SPDX-License-Identifier: MPL-2.0

import { existsSync } from "node:fs";
import { join } from "node:path";

/** The marker a command creates when it is ready for dependent work. */
export function readinessMarkerPath(execDir: string): string {
  return join(execDir, "ready");
}

export function readinessMarkerExists(execDir: string): boolean {
  return existsSync(readinessMarkerPath(execDir));
}
