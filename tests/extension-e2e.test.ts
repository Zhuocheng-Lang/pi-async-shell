/**
 * End-to-end verification through a real Pi session.
 *
 * A faux provider scripts the model's tool calls, so these tests exercise the
 * actual extension loader, tool schema validation, tool execution, the
 * completion-message path, and the /reload handoff without a network or a real
 * model.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  wrapRegisteredTool,
} from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TranscriptContext } from "@earendil-works/pi-ai";

const extensionPath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "extension.ts");

interface Harness {
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  faux: ReturnType<typeof createFauxCore>;
  callTool(name: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
  callToolResult(name: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<any>;
  toolSchema(name: string): Record<string, any>;
  refresh(): void;
  dispose(): void;
}

async function createHarness(): Promise<Harness> {
  const cwd = mkdtempSync(join(tmpdir(), "pas-e2e-"));
  const agentDir = mkdtempSync(join(tmpdir(), "pas-agent-"));
  writeFileSync(join(agentDir, "auth.json"), "{}");
  const faux = createFauxCore({ models: [{ id: "faux-1", contextWindow: 128000, maxTokens: 4096 }] });
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json") });
  modelRuntime.registerProvider("faux", {
    apiKey: "faux-test-key",
    baseUrl: "http://localhost:0",
    api: faux.api,
    models: [
      {
        type: "chat",
        id: "faux-1",
        name: "Faux Model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
    streamSimple: faux.streamSimple,
  });
  await modelRuntime.setRuntimeApiKey("faux", "faux-test-key");

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    additionalExtensionPaths: [extensionPath],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    resourceLoader,
    sessionManager: SessionManager.inMemory(),
    model: faux.getModel(),
    thinkingLevel: "off",
  });
  // A shutdown handler makes the runner "bound", which is what makes
  // session_start(reason: "reload") fire after session.reload().
  await session.bindExtensions({ shutdownHandler: () => {} });

  let tools = new Map<string, { execute: (...args: unknown[]) => Promise<any> }>();
  let definitions = new Map<string, Record<string, any>>();
  const refresh = () => {
    const runner = (session as unknown as { _extensionRunner: any })._extensionRunner;
    const registered = runner.getAllRegisteredTools() as { definition: Record<string, any> }[];
    definitions = new Map(registered.map((tool) => [tool.definition.name, tool.definition]));
    tools = new Map(
      registered.map((tool) => [
        tool.definition.name,
        wrapRegisteredTool(tool as never, runner) as never,
      ]),
    );
  };
  refresh();

  const callToolResult = async (name: string, params: Record<string, unknown>, signal?: AbortSignal) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`tool not registered: ${name}`);
    return tool.execute(`e2e-${name}`, params, signal, undefined);
  };

  return {
    session,
    faux,
    async callTool(name, params, signal) {
      const result = await callToolResult(name, params, signal);
      return (result?.content ?? [])
        .map((block: { type?: string; text?: string }) => (block.type === "text" ? block.text ?? "" : ""))
        .join("\n");
    },
    callToolResult,
    toolSchema(name) {
      const definition = definitions.get(name);
      if (!definition) throw new Error(`tool not registered: ${name}`);
      return definition.parameters as Record<string, any>;
    },
    refresh,
    dispose() {
      session.dispose();
    },
  };
}

function lastToolText(context: TranscriptContext): string {
  const messages = context.messages as unknown as { role?: string; content?: unknown }[];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "toolResult") continue;
    const content = message.content;
    if (Array.isArray(content)) {
      return content
        .map((block: { type?: string; text?: string }) => (block.type === "text" ? block.text ?? "" : ""))
        .join("\n");
    }
    return String(content ?? "");
  }
  return "";
}

function lastHandleId(context: TranscriptContext): string {
  const match = lastToolText(context).match(/sh_[0-9a-f]{8}/);
  if (!match) throw new Error("no handle id in the transcript");
  return match[0];
}

function customMessages(session: Harness["session"], type: string): { content?: unknown }[] {
  return (session.messages as unknown as { customType?: string; content?: unknown }[]).filter(
    (message) => message.customType === type,
  );
}

function completionForId(session: Harness["session"], id: string): string | undefined {
  return customMessages(session, "async-shell-completion")
    .map((message) => JSON.stringify(message.content))
    .find((text) => text.includes(id));
}

function completionInContext(context: TranscriptContext): boolean {
  return JSON.stringify(context.messages).includes("<async-shell-completion>");
}

/** The handle id whose start result mentions this command. */
function handleIdForCommand(context: TranscriptContext, command: string): string {
  const messages = context.messages as unknown as { role?: string; content?: unknown }[];
  for (const message of messages) {
    if (message.role !== "toolResult") continue;
    const text = Array.isArray(message.content)
      ? message.content
          .map((block: { type?: string; text?: string }) => (block.type === "text" ? block.text ?? "" : ""))
          .join("\n")
      : String(message.content ?? "");
    if (!text.includes(command)) continue;
    const match = text.match(/sh_[0-9a-f]{8}/);
    if (match) return match[0];
  }
  throw new Error(`no handle id for command: ${command}`);
}

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

test("a real Pi session drives the seven shell tools end to end", { timeout: 120_000 }, async () => {
  const previousShell = process.env.PI_ASYNC_SHELL;
  process.env.PI_ASYNC_SHELL = "/bin/sh";
  const harness = await createHarness();
  try {
    const shellTools = harness.session
      .getActiveToolNames()
      .filter((name) => name.startsWith("shell_"))
      .sort();
    assert.deepEqual(shellTools, [
      "shell_await",
      "shell_cancel",
      "shell_promote",
      "shell_read",
      "shell_send",
      "shell_start",
      "shell_status",
    ]);
    const startSchema = harness.toolSchema("shell_start");
    assert.deepEqual(startSchema.properties.scope.enum, ["session", "workspace"]);
    assert.deepEqual(startSchema.properties.delivery.enum, ["steer", "settle"]);
    assert.equal(startSchema.properties.readiness, undefined);
    const awaitSchema = harness.toolSchema("shell_await");
    assert.equal(awaitSchema.properties.waitMs.maximum, undefined);
    assert.equal(startSchema.properties.inlineSettleMs.maximum, undefined);
    assert.deepEqual(harness.toolSchema("shell_read").properties.mode.enum, ["tail", "head", "offset", "grep", "all"]);
    assert.equal(awaitSchema.properties.cancelOnFirstFailure, undefined);
    assert.match(harness.session.systemPrompt, /shell_start runs commands with `\/bin\/sh -c <command>`/);

    // Turn 1: start, await, read — the causal barrier pi-background-tasks lacks.
    harness.faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("shell_start", { command: "echo e2e-hello; sleep 0.3; echo e2e-done", scope: "session" })],
        { stopReason: "toolUse" },
      ),
      (context) =>
        fauxAssistantMessage(
          [fauxToolCall("shell_await", { ids: lastHandleId(context), waitMs: 10_000 })],
          { stopReason: "toolUse" },
        ),
      (context) =>
        fauxAssistantMessage(
          [fauxToolCall("shell_read", { id: lastHandleId(context), stream: "stdout", mode: "tail" })],
          { stopReason: "toolUse" },
        ),
      fauxAssistantMessage("turn one done"),
    ]);
    await harness.session.prompt("start and await the command");

    const texts = harness.session.messages
      .filter((message) => message.role === "toolResult")
      .map((message) =>
        (message.content as { type: string; text?: string }[])
          .map((block) => block.text ?? "")
          .join("\n"),
      );
    assert.match(texts[0] ?? "", /Started sh_[0-9a-f]{8}/);
    assert.match(texts[0] ?? "", /Settled inside the 1\.0s inline window/);
    assert.match(texts[1] ?? "", /completed/);
    assert.match(texts[2] ?? "", /e2e-hello/);

    // Turn 2: a completion event wakes the session after the turn ends.
    harness.faux.appendResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("shell_start", {
            command: "echo notify-me",
            scope: "session",
            notifyOnCompletion: true,
            inlineSettleMs: 0,
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("ending the turn"),
      fauxAssistantMessage("noted the completion"),
    ]);
    await harness.session.prompt("start a quick command and end the turn");
    assert.equal(
      await waitFor(() => customMessages(harness.session, "async-shell-completion").length > 0),
      true,
      "a completion message must reach the session",
    );
    assert.match(
      JSON.stringify(customMessages(harness.session, "async-shell-completion")[0]?.content),
      /notify-me|completed/,
    );

  } finally {
    harness.dispose();
    if (previousShell === undefined) delete process.env.PI_ASYNC_SHELL;
    else process.env.PI_ASYNC_SHELL = previousShell;
  }
});

test("a command that settles inside the start call returns its result there", { timeout: 120_000 }, async () => {
  const previousShell = process.env.PI_ASYNC_SHELL;
  process.env.PI_ASYNC_SHELL = "/bin/sh";
  const harness = await createHarness();
  try {
    const result = await harness.callToolResult("shell_start", {
      command: "echo inline-hello; exit 3",
      scope: "session",
    });
    const text = (result.content as { type: string; text?: string }[])
      .map((block) => block.text ?? "")
      .join("\n");
    assert.match(text, /Started sh_[0-9a-f]{8}/);
    assert.match(text, /failed/);
    assert.match(text, /inline-hello/);
    assert.equal(result.structuredContent.settledInline, true);
    assert.equal(result.structuredContent.status, "failed");
    assert.equal(result.structuredContent.exitCode, 3);
    // The settle was reported by this call, so it must not be reported twice.
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(customMessages(harness.session, "async-shell-completion").length, 0);
  } finally {
    harness.dispose();
    if (previousShell === undefined) delete process.env.PI_ASYNC_SHELL;
    else process.env.PI_ASYNC_SHELL = previousShell;
  }
});

test("an await that reports the settle does not announce it again", { timeout: 120_000 }, async () => {
  const previousShell = process.env.PI_ASYNC_SHELL;
  process.env.PI_ASYNC_SHELL = "/bin/sh";
  const harness = await createHarness();
  try {
    // The start call returns before the settle, so shell_await is what reports
    // the outcome.
    const started = await harness.callTool("shell_start", {
      command: "sleep 0.4; echo awaited-hello",
      scope: "session",
      inlineSettleMs: 0,
      notifyOnCompletion: true,
    });
    const id = started.match(/sh_[0-9a-f]{8}/)?.[0];
    assert.ok(id, "the start result must carry a handle id");
    assert.match(started, /running/);
    const awaited = await harness.callTool("shell_await", { ids: id, waitMs: 10_000 });
    assert.match(awaited, /completed/);
    // The settle was reported by this call, so it must not be reported twice.
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(customMessages(harness.session, "async-shell-completion").length, 0);
  } finally {
    harness.dispose();
    if (previousShell === undefined) delete process.env.PI_ASYNC_SHELL;
    else process.env.PI_ASYNC_SHELL = previousShell;
  }
});

test("an await in mode all holds a sibling's settle until both are reported", { timeout: 120_000 }, async () => {
  const previousShell = process.env.PI_ASYNC_SHELL;
  const previousWindow = process.env.PI_ASYNC_SHELL_COALESCE_MS;
  process.env.PI_ASYNC_SHELL = "/bin/sh";
  // A zero window sends every queued record the moment it is queued, so a
  // settle that leaks out of the wait shows up as its own message at once.
  process.env.PI_ASYNC_SHELL_COALESCE_MS = "0";
  const harness = await createHarness();
  try {
    const first = await harness.callTool("shell_start", {
      command: "sleep 0.2; echo first-settled",
      scope: "session",
      inlineSettleMs: 0,
      triggerOnCompletion: false,
    });
    const firstId = first.match(/sh_[0-9a-f]{8}/)?.[0];
    const second = await harness.callTool("shell_start", {
      command: "sleep 1.2; echo second-settled",
      scope: "session",
      inlineSettleMs: 0,
      triggerOnCompletion: false,
    });
    const secondId = second.match(/sh_[0-9a-f]{8}/)?.[0];
    assert.ok(firstId && secondId, "both starts must carry a handle id");
    const awaited = await harness.callToolResult("shell_await", {
      ids: [firstId, secondId],
      mode: "all",
      waitMs: 20_000,
    });
    assert.equal(awaited.structuredContent.settled, true);
    assert.equal(awaited.structuredContent.outcomes.length, 2);
    const text = (awaited.content as { text?: string }[]).map((block) => block.text ?? "").join("\n");
    assert.match(text, new RegExp(firstId));
    assert.match(text, new RegExp(secondId));
    // The first handle settled while the wait still waited for the second. Both
    // outcomes are in this result, so neither may arrive as a message as well.
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(customMessages(harness.session, "async-shell-completion").length, 0);
  } finally {
    harness.dispose();
    if (previousShell === undefined) delete process.env.PI_ASYNC_SHELL;
    else process.env.PI_ASYNC_SHELL = previousShell;
    if (previousWindow === undefined) delete process.env.PI_ASYNC_SHELL_COALESCE_MS;
    else process.env.PI_ASYNC_SHELL_COALESCE_MS = previousWindow;
  }
});

test("an aborted await hands its held settle back to the completion channel", { timeout: 120_000 }, async () => {
  const previousShell = process.env.PI_ASYNC_SHELL;
  const previousWindow = process.env.PI_ASYNC_SHELL_COALESCE_MS;
  process.env.PI_ASYNC_SHELL = "/bin/sh";
  process.env.PI_ASYNC_SHELL_COALESCE_MS = "0";
  const harness = await createHarness();
  try {
    const quick = await harness.callTool("shell_start", {
      command: "sleep 0.6; echo aborted-await-quick",
      scope: "session",
      inlineSettleMs: 0,
      triggerOnCompletion: false,
    });
    const quickId = quick.match(/sh_[0-9a-f]{8}/)?.[0];
    const slow = await harness.callTool("shell_start", {
      command: "sleep 30",
      scope: "session",
      inlineSettleMs: 0,
    });
    const slowId = slow.match(/sh_[0-9a-f]{8}/)?.[0];
    assert.ok(quickId && slowId, "both starts must carry a handle id");
    const controller = new AbortController();
    const pending = harness.callToolResult(
      "shell_await",
      { ids: [quickId, slowId], mode: "all", waitMs: 60_000 },
      controller.signal,
    );
    // The quick handle settles while the call still waits for the slow one, so
    // its record is held under the claim and nothing is announced.
    let settledWhileWaiting = false;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if ((await harness.callTool("shell_status", { id: quickId })).includes("completed")) {
        settledWhileWaiting = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(settledWhileWaiting, true, "the quick handle must settle before the abort");
    assert.equal(
      customMessages(harness.session, "async-shell-completion").length,
      0,
      "a claimed settle is held, not announced",
    );
    controller.abort();
    const aborted = await pending;
    assert.equal(aborted.structuredContent.settled, false);
    // The aborted call never reached the model, so the released record is the
    // only report of the quick run.
    assert.equal(
      await waitFor(() => Boolean(completionForId(harness.session, quickId))),
      true,
      "the released record must still be announced",
    );
    const status = await harness.callToolResult("shell_status", { id: quickId });
    assert.equal(status.structuredContent.handles[0].consumedByAwait, false, "an aborted await claims nothing");
    await harness.callTool("shell_cancel", { ids: slowId, ladder: "force" });
  } finally {
    harness.dispose();
    if (previousShell === undefined) delete process.env.PI_ASYNC_SHELL;
    else process.env.PI_ASYNC_SHELL = previousShell;
    if (previousWindow === undefined) delete process.env.PI_ASYNC_SHELL_COALESCE_MS;
    else process.env.PI_ASYNC_SHELL_COALESCE_MS = previousWindow;
  }
});

test("a command that outlives the inline window keeps the handle and still notifies", { timeout: 120_000 }, async () => {
  const previousShell = process.env.PI_ASYNC_SHELL;
  process.env.PI_ASYNC_SHELL = "/bin/sh";
  const harness = await createHarness();
  try {
    const startedAt = Date.now();
    const started = await harness.callTool("shell_start", {
      command: "sleep 3; echo late",
      scope: "session",
      triggerOnCompletion: false,
    });
    const elapsed = Date.now() - startedAt;
    assert.match(started, /Started sh_[0-9a-f]{8}/);
    assert.match(started, /running/);
    assert.doesNotMatch(started, /Settled inside/);
    assert.ok(elapsed < 2000, `the start call must return when the window expires, not when the command settles (${elapsed}ms)`);
    // The claim ended with the wait, so the settle is still announced.
    assert.equal(
      await waitFor(() => customMessages(harness.session, "async-shell-completion").length > 0),
      true,
      "a settle after the window must still reach the session",
    );
  } finally {
    harness.dispose();
    if (previousShell === undefined) delete process.env.PI_ASYNC_SHELL;
    else process.env.PI_ASYNC_SHELL = previousShell;
  }
});

test("inlineSettleMs: 0 returns at once and leaves the completion channel alone", { timeout: 120_000 }, async () => {
  const previousShell = process.env.PI_ASYNC_SHELL;
  process.env.PI_ASYNC_SHELL = "/bin/sh";
  const harness = await createHarness();
  try {
    assert.equal(harness.toolSchema("shell_start").properties.inlineSettleMs.maximum, undefined);
    const startedAt = Date.now();
    const started = await harness.callTool("shell_start", {
      command: "echo no-inline",
      scope: "session",
      inlineSettleMs: 0,
      triggerOnCompletion: false,
    });
    assert.ok(Date.now() - startedAt < 800, "an explicit zero must not wait");
    assert.doesNotMatch(started, /Settled inside/);
    assert.equal(
      await waitFor(() => customMessages(harness.session, "async-shell-completion").length > 0),
      true,
      "an unclaimed settle must be announced",
    );
  } finally {
    harness.dispose();
    if (previousShell === undefined) delete process.env.PI_ASYNC_SHELL;
    else process.env.PI_ASYNC_SHELL = previousShell;
  }
});

test("a default session execution survives agent settling", { timeout: 120_000 }, async () => {
  const previousShell = process.env.PI_ASYNC_SHELL;
  process.env.PI_ASYNC_SHELL = "/bin/sh";
  const harness = await createHarness();
  try {
    const started = await harness.callTool("shell_start", { command: "sleep 30" });
    const id = started.match(/sh_[0-9a-f]{8}/)?.[0];
    assert.ok(id);
    harness.faux.setResponses([fauxAssistantMessage("end the turn without awaiting")]);
    await harness.session.prompt("leave the session command running");

    const status = await harness.callTool("shell_status", { id });
    assert.match(status, /running/);
    assert.match(status, /scope session/);
    assert.equal(customMessages(harness.session, "async-shell-error").length, 0);
    await harness.callTool("shell_cancel", { ids: id, ladder: "force" });
  } finally {
    harness.dispose();
    if (previousShell === undefined) delete process.env.PI_ASYNC_SHELL;
    else process.env.PI_ASYNC_SHELL = previousShell;
  }
});

test("three completions coalesce into one message", { timeout: 120_000 }, async () => {
  const previousShell = process.env.PI_ASYNC_SHELL;
  process.env.PI_ASYNC_SHELL = "/bin/sh";
  const harness = await createHarness();
  // The commands block on one file that the test opens after the turn ends, so
  // their settles land together. The raised window absorbs the moment a
  // contended runner needs to notice that file; the width of the window itself
  // is not what this test asserts.
  const gate = join(mkdtempSync(join(tmpdir(), "pas-gate-")), "open");
  const waitForGate = (label: string) => `while [ ! -f ${gate} ]; do sleep 0.01; done; echo ${label}`;
  const previousWindow = process.env.PI_ASYNC_SHELL_COALESCE_MS;
  process.env.PI_ASYNC_SHELL_COALESCE_MS = "2000";
  try {
    harness.faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("shell_start", { command: waitForGate("one"), scope: "session", inlineSettleMs: 0 }),
          fauxToolCall("shell_start", { command: waitForGate("two"), scope: "session", inlineSettleMs: 0 }),
          fauxToolCall("shell_start", { command: waitForGate("three"), scope: "session", inlineSettleMs: 0 }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("ending the turn"),
      fauxAssistantMessage("acknowledged"),
    ]);
    await harness.session.prompt("start three quick commands and end the turn");
    // The turn is over, so these settles take the idle path and share one window.
    writeFileSync(gate, "");
    const delivered = () =>
      new Set(
        customMessages(harness.session, "async-shell-completion").flatMap(
          (message) => JSON.stringify(message.content).match(/sh_[0-9a-f]{8}/g) ?? [],
        ),
      );
    assert.equal(await waitFor(() => delivered().size === 3), true, "every record is still delivered");
    const messages = customMessages(harness.session, "async-shell-completion");
    assert.equal(messages.length, 1, "coalescing must produce one delivery, not three");
  } finally {
    harness.dispose();
    if (previousShell === undefined) delete process.env.PI_ASYNC_SHELL;
    else process.env.PI_ASYNC_SHELL = previousShell;
    if (previousWindow === undefined) delete process.env.PI_ASYNC_SHELL_COALESCE_MS;
    else process.env.PI_ASYNC_SHELL_COALESCE_MS = previousWindow;
  }
});

test("a completion steers into the next LLM call of a running turn", { timeout: 120_000 }, async () => {
  const previousShell = process.env.PI_ASYNC_SHELL;
  process.env.PI_ASYNC_SHELL = "/bin/sh";
  const harness = await createHarness();
  const seen: boolean[] = [];
  try {
    harness.faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("shell_start", { command: "sleep 0.2; echo steered", scope: "session", inlineSettleMs: 0 }),
          fauxToolCall("shell_start", { command: "sleep 2; echo long", scope: "session", inlineSettleMs: 0 }),
        ],
        { stopReason: "toolUse" },
      ),
      (context) =>
        fauxAssistantMessage(
          [fauxToolCall("shell_await", { ids: handleIdForCommand(context, "sleep 2"), waitMs: 10_000 })],
          { stopReason: "toolUse" },
        ),
      // The short command settled while the await held the turn open, so this
      // decision is the first one that could know about it.
      (context) => {
        seen.push(completionInContext(context));
        return fauxAssistantMessage("done");
      },
    ]);
    await harness.session.prompt("start two commands and wait for the long one");

    assert.equal(seen.length, 1, "steering must not force an extra request");
    assert.equal(seen[0], true, "a completion must reach the model before its next decision");
  } finally {
    harness.dispose();
    if (previousShell === undefined) delete process.env.PI_ASYNC_SHELL;
    else process.env.PI_ASYNC_SHELL = previousShell;
  }
});

test("delivery settle holds a completion until the run has no more work", { timeout: 120_000 }, async () => {
  const previousShell = process.env.PI_ASYNC_SHELL;
  process.env.PI_ASYNC_SHELL = "/bin/sh";
  const harness = await createHarness();
  const seen: boolean[] = [];
  try {
    harness.faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("shell_start", {
            command: "sleep 0.2; echo held",
            scope: "session",
            delivery: "settle",
            inlineSettleMs: 0,
          }),
          fauxToolCall("shell_start", { command: "sleep 2; echo long", scope: "session", inlineSettleMs: 0 }),
        ],
        { stopReason: "toolUse" },
      ),
      (context) =>
        fauxAssistantMessage(
          [fauxToolCall("shell_await", { ids: handleIdForCommand(context, "sleep 2"), waitMs: 10_000 })],
          { stopReason: "toolUse" },
        ),
      (context) => {
        seen.push(completionInContext(context));
        return fauxAssistantMessage("done");
      },
      (context) => {
        seen.push(completionInContext(context));
        return fauxAssistantMessage("noted");
      },
    ]);
    await harness.session.prompt("start a held command and wait for the long one");

    assert.equal(seen.length, 2, "settle must keep the run alive for the record");
    assert.equal(seen[0], false, "settle must not steer mid-run");
    assert.equal(seen[1], true, "the record must still reach the model");
  } finally {
    harness.dispose();
    if (previousShell === undefined) delete process.env.PI_ASYNC_SHELL;
    else process.env.PI_ASYNC_SHELL = previousShell;
  }
});

test("oversized wait and inline-settle values are clamped with a visible note", { timeout: 120_000 }, async () => {
  const previousShell = process.env.PI_ASYNC_SHELL;
  process.env.PI_ASYNC_SHELL = "/bin/sh";
  const harness = await createHarness();
  try {
    const started = await harness.callToolResult("shell_start", {
      command: "echo clamped",
      scope: "session",
      inlineSettleMs: 99_999,
      triggerOnCompletion: false,
    });
    const startedText = (started.content as { text?: string }[]).map((block) => block.text ?? "").join("\n");
    assert.match(startedText, /inlineSettleMs 99999 clamped to 10000/);
    assert.match(startedText, /Settled inside the 10\.0s inline window/);
    assert.match(startedText, /--- tail ---[\s\S]*clamped/);
    // A caller that reads only structured content must see the clamp too.
    assert.equal(
      started.structuredContent.note,
      "inlineSettleMs 99999 clamped to 10000; the command keeps its handle if it outlives that window.",
    );
    const id = startedText.match(/sh_[0-9a-f]{8}/)?.[0];
    assert.ok(id);
    const awaited = await harness.callToolResult("shell_await", {
      ids: id,
      waitMs: 99_999,
      includeOutputPreview: false,
    });
    const awaitedText = (awaited.content as { text?: string }[]).map((block) => block.text ?? "").join("\n");
    assert.match(awaitedText, /waitMs 99999 clamped to 50000/);
    assert.match(awaitedText, /exit 0/);
    assert.match(awaited.structuredContent.note, /waitMs 99999 clamped to 50000/);
  } finally {
    harness.dispose();
    if (previousShell === undefined) delete process.env.PI_ASYNC_SHELL;
    else process.env.PI_ASYNC_SHELL = previousShell;
  }
});

test("an expired wait carries its guidance in structured content", { timeout: 120_000 }, async () => {
  const previousShell = process.env.PI_ASYNC_SHELL;
  process.env.PI_ASYNC_SHELL = "/bin/sh";
  const harness = await createHarness();
  try {
    const started = await harness.callTool("shell_start", {
      command: "sleep 5",
      scope: "session",
      inlineSettleMs: 0,
      triggerOnCompletion: false,
    });
    const id = started.match(/sh_[0-9a-f]{8}/)?.[0];
    assert.ok(id);
    const expired = await harness.callToolResult("shell_await", { ids: id, waitMs: 100 });
    assert.equal(expired.structuredContent.timedOutWaiting, true);
    assert.equal(expired.structuredContent.settled, false);
    assert.match(expired.structuredContent.note, /The wait expired\. Nothing was killed\./);
    await harness.callTool("shell_cancel", { ids: id, ladder: "force" });
  } finally {
    harness.dispose();
    if (previousShell === undefined) delete process.env.PI_ASYNC_SHELL;
    else process.env.PI_ASYNC_SHELL = previousShell;
  }
});

test("shell_read accepts mode all as a bounded read", { timeout: 120_000 }, async () => {
  const previousShell = process.env.PI_ASYNC_SHELL;
  process.env.PI_ASYNC_SHELL = "/bin/sh";
  const harness = await createHarness();
  try {
    const started = await harness.callTool("shell_start", {
      command: "echo all-mode",
      scope: "session",
      triggerOnCompletion: false,
    });
    const id = started.match(/sh_[0-9a-f]{8}/)?.[0];
    assert.ok(id);
    const read = await harness.callTool("shell_read", { id, mode: "all" });
    assert.match(read, /all-mode/);
    assert.match(read, /mode all is a bounded head read/);
    assert.match(read, /use mode offset with nextByte\/nextLine to page/);
  } finally {
    harness.dispose();
    if (previousShell === undefined) delete process.env.PI_ASYNC_SHELL;
    else process.env.PI_ASYNC_SHELL = previousShell;
  }
});

test("bash pipelines report a failed stage and failure summaries carry the error", {
  skip: !existsSync("/bin/bash"),
  timeout: 120_000,
}, async () => {
  const previousShell = process.env.PI_ASYNC_SHELL;
  process.env.PI_ASYNC_SHELL = "/bin/bash";
  const harness = await createHarness();
  try {
    const inline = await harness.callToolResult("shell_start", {
      command: "false | tail -2",
      scope: "session",
      triggerOnCompletion: false,
    });
    assert.equal(inline.structuredContent.status, "failed");
    assert.equal(inline.structuredContent.exitCode, 1);
    assert.equal(inline.structuredContent.exitSource, "pipefail");
    assert.match(
      (inline.content as { text?: string }[]).map((block) => block.text ?? "").join("\n"),
      /pipeline status: pipefail/,
    );

    const deferred = await harness.callTool("shell_start", {
      command: "echo 'ERROR: boom' >&2; false | tail -2",
      scope: "session",
      inlineSettleMs: 0,
      // No scripted response is queued here, so the record must arrive without
      // starting a turn of its own.
      triggerOnCompletion: false,
    });
    const id = deferred.match(/sh_[0-9a-f]{8}/)?.[0];
    assert.ok(id);
    assert.equal(await waitFor(() => Boolean(completionForId(harness.session, id))), true);
    const summary = completionForId(harness.session, id) ?? "";
    assert.match(summary, /exit: 1/);
    assert.match(summary, /first error[\s\S]*ERROR: boom/);
    assert.match(summary, /pipeline status: pipefail/);
  } finally {
    harness.dispose();
    if (previousShell === undefined) delete process.env.PI_ASYNC_SHELL;
    else process.env.PI_ASYNC_SHELL = previousShell;
  }
});

test("inline settle handles undefined and aborted signals without losing notifications", { timeout: 120_000 }, async () => {
  const previousShell = process.env.PI_ASYNC_SHELL;
  process.env.PI_ASYNC_SHELL = "/bin/sh";
  const harness = await createHarness();
  try {
    const normal = await harness.callToolResult(
      "shell_start",
      { command: "echo explicit-undefined", scope: "session", triggerOnCompletion: false },
      undefined,
    );
    assert.equal(normal.structuredContent.settledInline, true);
    assert.match(
      (normal.content as { text?: string }[]).map((block) => block.text ?? "").join("\n"),
      /Settled inside/,
    );

    const preAborted = new AbortController();
    preAborted.abort();
    const aborted = await harness.callToolResult(
      "shell_start",
      { command: "echo pre-aborted", scope: "session", inlineSettleMs: 1000, triggerOnCompletion: false },
      preAborted.signal,
    );
    const abortedText = (aborted.content as { text?: string }[]).map((block) => block.text ?? "").join("\n");
    assert.equal(aborted.structuredContent.settledInline, undefined);
    assert.doesNotMatch(abortedText, /Settled inside/);
    const abortedId = abortedText.match(/sh_[0-9a-f]{8}/)?.[0];
    assert.ok(abortedId);
    assert.equal(await waitFor(() => Boolean(completionForId(harness.session, abortedId))), true);
    const summary = completionForId(harness.session, abortedId) ?? "";
    assert.match(summary, /exit: 0/);
    assert.match(summary, /--- tail ---[\s\S]*pre-aborted/);

    const midAbort = new AbortController();
    const pending = harness.callToolResult(
      "shell_start",
      { command: "sleep 0.2; echo mid-aborted", scope: "session", inlineSettleMs: 1000, triggerOnCompletion: false },
      midAbort.signal,
    );
    setTimeout(() => midAbort.abort(), 50);
    const late = await pending;
    assert.equal(late.structuredContent.settledInline, undefined);
    const lateText = (late.content as { text?: string }[]).map((block) => block.text ?? "").join("\n");
    const lateId = lateText.match(/sh_[0-9a-f]{8}/)?.[0];
    assert.ok(lateId);
    assert.equal(await waitFor(() => Boolean(completionForId(harness.session, lateId))), true);
  } finally {
    harness.dispose();
    if (previousShell === undefined) delete process.env.PI_ASYNC_SHELL;
    else process.env.PI_ASYNC_SHELL = previousShell;
  }
});

test("/reload hands live handles to the new activation", { timeout: 120_000 }, async () => {
  const previousShell = process.env.PI_ASYNC_SHELL;
  process.env.PI_ASYNC_SHELL = "/bin/sh";
  const harness = await createHarness();
  try {
    const started = await harness.callTool("shell_start", { command: "sleep 30", scope: "session" });
    const id = started.match(/sh_[0-9a-f]{8}/)?.[0];
    assert.ok(id, "handle id");

    await harness.session.reload();
    harness.refresh();

    const status = await harness.callTool("shell_status", { id });
    assert.match(status, /running/, "the handle must survive the reload");
    const read = await harness.callTool("shell_read", { id, stream: "combined" });
    assert.match(read, /sh_[0-9a-f]{8}/, "logs stay readable after the reload");
    const cancelled = await harness.callTool("shell_cancel", { ids: id, ladder: "force" });
    assert.match(cancelled, /cancelled/);
  } finally {
    harness.dispose();
    if (previousShell === undefined) delete process.env.PI_ASYNC_SHELL;
    else process.env.PI_ASYNC_SHELL = previousShell;
  }
});
