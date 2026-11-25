// SPDX-FileCopyrightText: 2026 Zhuocheng-Lang
// SPDX-License-Identifier: MPL-2.0

/**
 * Compile a caller-supplied pattern with a bound on what it can cost.
 *
 * A `RegExp` runs on the same thread as everything else, and Node offers no way
 * to interrupt one: `(x+)+` against a single short line spends seconds of the
 * event loop, and an `AbortSignal` cannot reach it. The guard is therefore
 * static. It bounds the source length and rejects a quantifier applied to a
 * group that already repeats, which is the shape every classic blowup needs.
 *
 * This is a floor, not a proof. A pattern under the length limit that avoids the
 * nested form can still be quadratic on a very large log, so the length would
 * have to be tiny to make the guarantee absolute. The limit is documented in
 * `docs/implementation-notes.md` §4 rather than claimed away.
 */
export const MAX_PATTERN_LENGTH = 512;

function hasNestedQuantifier(source: string): boolean {
  /** One frame per open group; true when that group already repeats something. */
  const groups: boolean[] = [];
  let escaped = false;
  let inClass = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      continue;
    }
    if (ch === "(") {
      groups.push(false);
      continue;
    }
    if (ch === ")") {
      const inner = groups.pop();
      if (inner === undefined) continue;
      const next = source[i + 1];
      const repeats = next === "*" || next === "+" || next === "{" || next === "?";
      if (inner && repeats) return true;
      const outer = groups.length - 1;
      if (outer >= 0 && (inner || repeats)) groups[outer] = true;
      continue;
    }
    if (ch === "*" || ch === "+" || ch === "{") {
      if (groups.length > 0) groups[groups.length - 1] = true;
    }
  }
  return false;
}

/** `what` names the tool argument, so the error says which pattern was refused. */
export function compilePattern(source: string, what: string): RegExp {
  if (source.length > MAX_PATTERN_LENGTH) {
    throw new Error(
      `${what} is ${source.length} characters; the limit is ${MAX_PATTERN_LENGTH}. Narrow the pattern instead of widening the budget.`,
    );
  }
  if (hasNestedQuantifier(source)) {
    throw new Error(
      `${what} repeats a group that already repeats, which can take quadratic or exponential time on this thread. Rewrite it without nested quantifiers.`,
    );
  }
  try {
    return new RegExp(source);
  } catch (error) {
    throw new Error(`invalid ${what}: ${(error as Error).message}`);
  }
}
