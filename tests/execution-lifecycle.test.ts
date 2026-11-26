import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createExecutionLifecycle,
  executionLifecycleStatus,
  executionStatusForExit,
  isExecutionSettled,
  transitionExecutionLifecycle,
} from "../src/core/execution-lifecycle.ts";

test("launch and adoption admit an execution without settling it", () => {
  for (const type of ["launched", "adopted"] as const) {
    const starting = createExecutionLifecycle();
    assert.equal(executionLifecycleStatus(starting), "starting");
    const running = transitionExecutionLifecycle(starting, { type });
    assert.deepEqual(running, { phase: "running" });
    assert.equal(executionLifecycleStatus(running), "running");
    assert.equal(isExecutionSettled(running), false);
  }
});

test("a natural exit is classified and settled exactly once", () => {
  const running = transitionExecutionLifecycle(createExecutionLifecycle(), { type: "launched" });
  const status = executionStatusForExit(running, 0, null);
  assert.equal(status, "completed");
  const settled = transitionExecutionLifecycle(running, { type: "settled", status });
  assert.deepEqual(settled, { phase: "settled", status: "completed" });
  assert.equal(isExecutionSettled(settled), true);
});

test("cancellation is an active stop intent until finalization", () => {
  const running = transitionExecutionLifecycle(createExecutionLifecycle(), { type: "launched" });
  const cancelling = transitionExecutionLifecycle(running, { type: "cancel-requested" });
  assert.deepEqual(cancelling, { phase: "running", stop: "cancel" });
  assert.equal(executionLifecycleStatus(cancelling), "running");
  assert.equal(isExecutionSettled(cancelling), false);
  assert.equal(executionStatusForExit(cancelling, 0, null), "cancelled");
  const cancelled = transitionExecutionLifecycle(cancelling, { type: "settled", status: "cancelled" });
  assert.equal(executionLifecycleStatus(cancelled), "cancelled");
  assert.equal(isExecutionSettled(cancelled), true);
});

test("timeout is publicly visible before cleanup has settled", () => {
  const running = transitionExecutionLifecycle(createExecutionLifecycle(), { type: "launched" });
  const timingOut = transitionExecutionLifecycle(running, { type: "timeout-requested" });
  assert.deepEqual(timingOut, { phase: "running", stop: "timeout" });
  assert.equal(executionLifecycleStatus(timingOut), "timed-out");
  assert.equal(isExecutionSettled(timingOut), false);
  assert.equal(executionStatusForExit(timingOut, 0, null), "timed-out");
  const timedOut = transitionExecutionLifecycle(timingOut, { type: "settled", status: "timed-out" });
  assert.equal(isExecutionSettled(timedOut), true);
});

test("timeout wins over cancellation and cannot be overwritten by a later cancel", () => {
  const running = transitionExecutionLifecycle(createExecutionLifecycle(), { type: "launched" });
  const cancelling = transitionExecutionLifecycle(running, { type: "cancel-requested" });
  const timingOut = transitionExecutionLifecycle(cancelling, { type: "timeout-requested" });
  const stillTimingOut = transitionExecutionLifecycle(timingOut, { type: "cancel-requested" });
  assert.deepEqual(stillTimingOut, { phase: "running", stop: "timeout" });
  assert.equal(executionStatusForExit(stillTimingOut, null, "SIGTERM"), "timed-out");
});

test("late events preserve the first terminal outcome and never revive a handle", () => {
  const failed = transitionExecutionLifecycle(createExecutionLifecycle(), {
    type: "settled",
    status: "failed",
  });
  assert.strictEqual(transitionExecutionLifecycle(failed, { type: "launched" }), failed);
  assert.strictEqual(transitionExecutionLifecycle(failed, { type: "adopted" }), failed);
  assert.strictEqual(
    transitionExecutionLifecycle(failed, { type: "settled", status: "completed" }),
    failed,
  );
  assert.equal(executionLifecycleStatus(failed), "failed");
});
