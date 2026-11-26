// SPDX-FileCopyrightText: 2026 Zhuocheng-Lang
// SPDX-License-Identifier: MPL-2.0

import type { ShellStatus, TerminalShellStatus } from "./types.ts";

/** Why an active execution is being stopped. A timeout takes precedence over cancellation. */
export type ExecutionStop = "cancel" | "timeout";

/**
 * The complete in-memory lifecycle of an execution.
 *
 * `ShellHandle.status` is a projection of this state, not the state itself. In
 * particular, a timeout is public while the cancellation ladder is still running:
 * `phase: "running", stop: "timeout"` projects to `timed-out`, but only
 * `phase: "settled"` means that awaiters may consume the outcome.
 */
export type ExecutionLifecycleState =
  | { readonly phase: "starting" }
  | { readonly phase: "running"; readonly stop?: ExecutionStop }
  | { readonly phase: "settled"; readonly status: TerminalShellStatus };

export type ExecutionLifecycleEvent =
  | { readonly type: "launched" }
  | { readonly type: "adopted" }
  | { readonly type: "cancel-requested" }
  | { readonly type: "timeout-requested" }
  | { readonly type: "settled"; readonly status: TerminalShellStatus };

/** Every execution begins in admission, including one restored for finalization. */
export function createExecutionLifecycle(): ExecutionLifecycleState {
  return { phase: "starting" };
}

/**
 * Apply one lifecycle event.
 *
 * ```text
 * starting  -- launched / adopted --> running
 * running   -- cancel-requested  --> running (stop: cancel)
 * running   -- timeout-requested --> running (stop: timeout)
 * starting  -- settled ----------> settled
 * running   -- settled ----------> settled
 * ```
 *
 * Process callbacks can race with admission, adoption and the cancellation
 * ladder. Events that no longer apply are idempotent no-ops; in particular, the
 * first settled outcome wins and a late launch cannot revive a failed start.
 */
export function transitionExecutionLifecycle(
  current: ExecutionLifecycleState,
  event: ExecutionLifecycleEvent,
): ExecutionLifecycleState {
  switch (event.type) {
    case "launched":
      return current.phase === "starting" ? { phase: "running" } : current;
    case "adopted":
      return current.phase === "starting" ? { phase: "running" } : current;
    case "cancel-requested":
      if (current.phase !== "running" || current.stop === "timeout") return current;
      return { phase: "running", stop: "cancel" };
    case "timeout-requested":
      return current.phase === "running" ? { phase: "running", stop: "timeout" } : current;
    case "settled":
      return current.phase === "settled" ? current : { phase: "settled", status: event.status };
    default:
      return assertNever(event);
  }
}

function assertNever(value: never): never {
  throw new Error(`unknown execution lifecycle event: ${JSON.stringify(value)}`);
}

/** Project the internal state onto the stable, durable handle vocabulary. */
export function executionLifecycleStatus(state: ExecutionLifecycleState): ShellStatus {
  if (state.phase === "starting") return "starting";
  if (state.phase === "settled") return state.status;
  return state.stop === "timeout" ? "timed-out" : "running";
}

export function isExecutionSettled(
  state: ExecutionLifecycleState,
): state is Extract<ExecutionLifecycleState, { phase: "settled" }> {
  return state.phase === "settled";
}

/** Classify an exit record using the stop intent that public status alone cannot represent. */
export function executionStatusForExit(
  state: ExecutionLifecycleState,
  code: number | null,
  signal: string | null,
): TerminalShellStatus {
  if (state.phase === "settled") return state.status;
  if (state.phase === "running" && state.stop === "timeout") return "timed-out";
  if (state.phase === "running" && state.stop === "cancel") return "cancelled";
  if (code === 0 && !signal) return "completed";
  return "failed";
}
