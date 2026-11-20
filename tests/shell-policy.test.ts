// SPDX-FileCopyrightText: 2026 Zhuocheng-Lang
// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { applyPipelineStatus, supportsPipefail } from "../src/core/shell-policy.ts";

test("pipefail is applied only to real pipelines on supporting shells", () => {
  assert.equal(supportsPipefail("/bin/bash"), true);
  assert.equal(supportsPipefail("/bin/sh"), false);
  const bash = { shell: "/bin/bash", source: "fallback", posix: true } as const;
  const sh = { shell: "/bin/sh", source: "fallback", posix: true } as const;

  assert.deepEqual(applyPipelineStatus(bash, "echo plain"), { command: "echo plain" });
  assert.deepEqual(applyPipelineStatus(bash, "echo 'a | b'"), { command: "echo 'a | b'" });
  assert.deepEqual(applyPipelineStatus(bash, 'echo "a | b"'), { command: 'echo "a | b"' });
  assert.deepEqual(applyPipelineStatus(bash, "echo a \\| b"), { command: "echo a \\| b" });
  assert.deepEqual(applyPipelineStatus(bash, "true || false"), { command: "true || false" });
  assert.deepEqual(applyPipelineStatus(bash, "# a | comment\necho done"), {
    command: "# a | comment\necho done",
  });
  assert.deepEqual(applyPipelineStatus(bash, "false | tail -2"), {
    command: "set -o pipefail; false | tail -2",
    exitSource: "pipefail",
  });
  assert.deepEqual(applyPipelineStatus(bash, "grep -r x . | wc -l"), {
    command: "set -o pipefail; grep -r x . | wc -l",
    exitSource: "pipefail",
  });
  assert.deepEqual(applyPipelineStatus(sh, "false | tail -2"), {
    command: "false | tail -2",
    exitSource: "last-command",
  });
});
