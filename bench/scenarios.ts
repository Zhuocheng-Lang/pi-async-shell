import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Impl } from "./adapters.ts";
import { createBenchSession, median, percentile } from "./harness.ts";
import { specFor } from "./impls.ts";

export interface ScenarioResult {
  scenario: string;
  title: string;
  /** outcome = what a user feels; mechanism = why the difference exists. */
  group: "outcome" | "mechanism";
  /** One sentence a user can check themselves. */
  rationale?: string;
  impl: string;
  /** True when the implementation cannot express the scenario at all. */
  notExpressible?: boolean;
  metrics: Record<string, number | string | boolean | null>;
  notes: string[];
}

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function logSize(path: string | undefined): number | null {
  if (!path) return null;
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeCancel(impl: Impl, id: string): Promise<void> {
  try {
    await impl.cancel(id);
  } catch {
    /* an already-settled handle needs no cancel */
  }
}

/**
 * Counts what the model would actually receive: one call, and the bytes of the
 * tool result. A scenario adds every result it takes, so the totals describe the
 * conversation the agent would have, not the benchmark's own bookkeeping.
 */
function meter() {
  let calls = 0;
  let bytes = 0;
  return {
    add(text: string | undefined) {
      calls += 1;
      bytes += text ? Buffer.byteLength(text, "utf8") : 0;
    },
    get calls() {
      return calls;
    },
    get bytes() {
      return bytes;
    },
  };
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function httpGet(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
    await response.text();
    return response.ok;
  } catch {
    return false;
  }
}

/** Live processes whose command line carries the marker. Never returns pid 0 or 1. */
function markedProcesses(marker: string): number[] {
  const pids: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid || pid <= 1) continue;
    try {
      if (readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(marker)) pids.push(pid);
    } catch {
      /* the process is already gone */
    }
  }
  return pids;
}

function notExpressible(
  impl: Impl,
  scenario: string,
  title: string,
  group: "outcome" | "mechanism",
  rationale: string,
  reason: string,
): ScenarioResult {
  return { scenario, title, group, rationale, impl: impl.key, notExpressible: true, metrics: {}, notes: [reason] };
}

// ------------------------------------------------------------------ outcomes

/**
 * U1 — a dev server started in one turn, still usable in the next.
 *
 * The user question is not "does a handle exist"; it is "when can I call it, and
 * is it still there after the turn ends". Readiness is discovered with whatever
 * the implementation offers: a declared condition for implementations that have
 * one, a log poll loop for those that do not.
 */
export async function devServer(impl: Impl): Promise<ScenarioResult> {
  const title = "A dev server started in one turn, used in the next";
  const rationale =
    "Start a slow service, wait only until it can be called, then come back to it after the turn ends.";
  if (impl.key === "bash") {
    return notExpressible(impl, "dev-server", title, "outcome", rationale, "bash blocks until the server exits, so a long-lived service cannot be started at all");
  }

  const port = await freePort();
  const script = join(fixturesDir, "dev-server.mjs");
  const command = `node ${script} ${port} 1200`;
  const notes: string[] = [];
  const spend = meter();

  const startedAt = performance.now();
  const started = await impl.start(command, {
    name: "dev server",
    scope: "session",
    notifyOnCompletion: false,
    ...(impl.caps.readiness ? { readiness: { kind: "pattern" as const, regex: "READY" } } : {}),
  });
  spend.add(started.text);

  let ready = false;
  let readyCalls = 0;
  if (impl.caps.readiness) {
    const awaited = await impl.awaitReady(started.id, 20_000);
    spend.add(awaited.text);
    readyCalls += 1;
    ready = awaited.ready;
  } else {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const read = await impl.readTail(started.id, 4096);
      spend.add(read.text);
      readyCalls += 1;
      if (read.text.includes("READY")) {
        ready = true;
        break;
      }
      await sleep(200);
    }
    notes.push("no output-pattern wait: knowing the server is up costs one log poll per 200 ms");
  }
  const readyMs = performance.now() - startedAt;
  const servedAtReady = await httpGet(port);

  let turnBoundary = true;
  try {
    await impl.session.runTurn("note the dev server and end the turn");
  } catch (error) {
    turnBoundary = false;
    notes.push(`turn boundary failed: ${String(error).slice(0, 160)}`);
  }

  // Either path counts: some implementations answer a status query without
  // echoing the handle, and some prune their listing once a task settles.
  const listing = await impl.statusAll();
  spend.add(listing.text);
  const direct = await impl.status(started.id);
  spend.add(direct.text);
  const listedAfterTurn = listing.text.includes(started.id) || direct.text.includes(started.id);
  const reachableAfterTurn = await httpGet(port);
  const log = await impl.readTail(started.id, 4096);
  spend.add(log.text);
  const logReadableAfterTurn = log.text.includes("served GET");
  await safeCancel(impl, started.id);

  return {
    scenario: "dev-server",
    title,
    group: "outcome",
    rationale,
    impl: impl.key,
    metrics: {
      readyMs: round(readyMs),
      readyCalls,
      ready,
      servedAtReady,
      turnBoundary,
      listedAfterTurn,
      reachableAfterTurn,
      logReadableAfterTurn,
      toolCalls: spend.calls,
      bytesIntoModel: spend.bytes,
    },
    notes,
  };
}

/**
 * U2 — a command that prints a burst, then waits for an answer.
 *
 * Two separate user outcomes are measured, because they fail separately: can the
 * model see the prompt, and can it answer it.
 */
export async function interactivePrompt(impl: Impl): Promise<ScenarioResult> {
  const title = "A command that prints 4000 lines, then asks a question";
  const rationale =
    "Some commands print a lot and then wait for a human answer. Can the agent see the prompt and complete the interaction?";
  if (impl.key === "bash") {
    return notExpressible(impl, "interactive", title, "outcome", rationale, "bash blocks on the read and has no stdin channel, so the call never returns");
  }

  const lines = 4000;
  // The answer marker is assembled at runtime so the echoed command line cannot
  // be mistaken for the answer in a PTY recording.
  const command =
    `for i in $(seq 1 ${lines}); do echo "noise line $i padding padding padding"; done; ` +
    `printf 'Proceed? [y/N] '; read answer; printf 'ANS%s[%s]\\n' WER "$answer"`;
  const notes: string[] = [];
  const spend = meter();
  // Everything the agent received, in order. A chunk-based reader never repeats
  // bytes, so the answer has to be found in what was already read.
  let seen = "";
  const take = (text: string | undefined) => {
    spend.add(text);
    if (text) seen += text;
  };
  const startedAt = performance.now();

  const started = await impl.start(command, {
    name: "interactive",
    scope: "session",
    binding: impl.caps.pty ? "pty" : "pipe",
    ...(impl.caps.readiness ? { readiness: { kind: "pattern" as const, regex: "Proceed\\?" } } : {}),
  });
  take(started.text);

  let answered = false;
  let hung = false;

  if (impl.caps.stdin) {
    if (impl.caps.readiness) {
      const awaited = await impl.awaitReady(started.id, 20_000);
      take(awaited.text);
    } else {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        take((await impl.readTail(started.id, 8192)).text);
        if (seen.includes("Proceed?")) break;
        await sleep(200);
      }
    }
    const sent = await impl.send(started.id, "y\n");
    if (sent) {
      take(sent.text);
      answered = sent.wrote;
    }
    take((await impl.awaitAll([started.id], 20_000)).text);
    if (impl.caps.screen) take((await impl.readScreen(started.id))?.text);
    else take((await impl.readTail(started.id, 8192)).text);
  } else {
    take((await impl.waitCompletionFor([started.id], 8000)).text);
    take((await impl.readTail(started.id, 8192)).text);
    const status = await impl.status(started.id);
    hung = status.status === "running";
    notes.push("no stdin channel: the prompt is visible in the log and cannot be answered");
  }

  const promptVisible = seen.includes("Proceed?");
  const answers = [...seen.matchAll(/ANSWER\[(.*?)\]/g)].map((match) => match[0]);
  const answerLine = answers.at(-1) ?? "";
  answered = answered && answerLine.includes("ANSWER[y]");
  await safeCancel(impl, started.id);

  return {
    scenario: "interactive",
    title,
    group: "outcome",
    rationale,
    impl: impl.key,
    metrics: {
      binding: impl.caps.pty ? "pty" : "pipe",
      promptVisible,
      answered,
      answerLine: answerLine || "(none)",
      hung,
      wallMs: round(performance.now() - startedAt),
      logBytes: logSize(impl.logPath(started.id)),
      toolCalls: spend.calls,
      bytesIntoModel: spend.bytes,
    },
    notes,
  };
}

/**
 * U3 — one ordinary slow command, and the answer at the end of its noise.
 *
 * This is the most common shape of real work: nothing to parallelise, nothing to
 * survive, just a command that takes seconds and prints a thousand lines. The
 * user pays in wall-clock time and in context, so both are measured.
 */
export async function answerCost(impl: Impl): Promise<ScenarioResult> {
  const command = `sleep 2.5; for i in $(seq 1 1000); do echo "step $i ok"; done; echo "RESULT 42 artifacts"`;
  const spend = meter();
  // Everything the agent received, in order. A chunk-based reader never repeats
  // bytes, so the answer is searched in what was already read.
  let seen = "";
  const take = (text: string | undefined) => {
    spend.add(text);
    if (text) seen += text;
  };
  const startedAt = performance.now();
  const started = await impl.start(command, { name: "answer cost", scope: "session" });
  take(started.text);

  // The blocking baseline already carries the answer; a no-op await would be a
  // tool call the agent never had to make.
  if (impl.key !== "bash") {
    if (impl.caps.inTurnAwait) take((await impl.awaitAll([started.id], 30_000)).text);
    else take((await impl.waitCompletionFor([started.id], 30_000)).text);
  }
  if (!seen.includes("RESULT 42 artifacts")) {
    const grep = await impl.readGrep(started.id, "RESULT");
    if (grep) take(grep.text);
    else take((await impl.readTail(started.id, 16_384)).text);
  }
  const answerMs = performance.now() - startedAt;
  const answerFound = seen.includes("RESULT 42 artifacts");
  await safeCancel(impl, started.id);

  return {
    scenario: "answer-cost",
    title: "One 2.5 s command, 1000 lines of noise, one answer",
    group: "outcome",
    rationale:
      "The ordinary case. What does a single slow command cost in wall-clock time, tool calls, and context before the agent can act?",
    impl: impl.key,
    metrics: {
      answerMs: round(answerMs),
      answerFound,
      toolCalls: spend.calls,
      bytesIntoModel: spend.bytes,
      logBytes: logSize(impl.logPath(started.id)),
    },
    notes: [],
  };
}

/**
 * U4 — cancel a runaway and check what is left behind.
 *
 * Users forgive a slow cancel; they do not forgive a build that keeps running
 * after the agent said it stopped. The command spawns a child so the check covers
 * the tree, not just the top process.
 */
export async function cancelCleanup(impl: Impl): Promise<ScenarioResult> {
  const title = "Cancel a runaway command, then look for leftovers";
  const rationale =
    "When the agent stops a runaway build, the output should still be readable and no process should keep running.";
  if (impl.key === "bash") {
    return notExpressible(impl, "cancel-cleanup", title, "outcome", rationale, "bash blocks until the command ends, so there is nothing to cancel");
  }

  const marker = `pas_cancel_${Math.random().toString(36).slice(2, 10)}`;
  const command =
    `sh -c 'while :; do echo "${marker} child"; sleep 0.2; done' & ` +
    `while :; do echo "${marker} tick"; sleep 0.2; done`;
  const spend = meter();
  const started = await impl.start(command, { name: "runaway", scope: "session", notifyOnCompletion: false });
  spend.add(started.text);
  await sleep(800);
  const processesBefore = markedProcesses(marker).length;

  const cancelStarted = performance.now();
  const cancelled = await impl.cancel(started.id);
  spend.add(cancelled.text);
  const cancelMs = performance.now() - cancelStarted;

  let leaked = markedProcesses(marker);
  const deadline = Date.now() + 3000;
  while (leaked.length > 0 && Date.now() < deadline) {
    await sleep(100);
    leaked = markedProcesses(marker);
  }
  for (const pid of leaked) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }

  let outputPreserved = false;
  try {
    const read = await impl.readTail(started.id, 8192);
    spend.add(read.text);
    outputPreserved = read.text.includes(marker);
  } catch {
    /* a killed task whose log is unreachable is a result too */
  }

  return {
    scenario: "cancel-cleanup",
    title,
    group: "outcome",
    rationale,
    impl: impl.key,
    metrics: {
      processesBefore,
      leakedAfter: leaked.length,
      cancelMs: round(cancelMs),
      cancelSupported: cancelled.supported,
      outputPreserved,
      toolCalls: spend.calls,
      bytesIntoModel: spend.bytes,
    },
    notes: [
      ...(cancelled.supported ? [] : ["no cancel tool exists: the runaway cannot be stopped by the agent"]),
      ...(leaked.length > 0
        ? [`${leaked.length} process(es) still carried the marker after the cancel; the bench killed them`]
        : []),
    ],
  };
}

// ---------------------------------------------------------------- mechanisms

/**
 * M1 — how much a start costs before any work happens.
 *
 * The first call in a process pays module loading and JIT warmup, which is a
 * one-time cost rather than an admission cost. It is measured and reported
 * separately so the percentiles describe steady state.
 */
export async function admissionLatency(impl: Impl, samples = 10): Promise<ScenarioResult> {
  const warmup = await impl.start("true", { name: "admission warmup" });
  await safeCancel(impl, warmup.id);
  const durations: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const started = await impl.start("true", { name: `admission ${index}` });
    durations.push(started.ms);
    await safeCancel(impl, started.id);
  }
  return {
    scenario: "admission",
    title: "Start admission latency (10 trivial commands)",
    group: "mechanism",
    impl: impl.key,
    metrics: {
      medianMs: round(median(durations)),
      p95Ms: round(percentile(durations, 95)),
      minMs: round(Math.min(...durations)),
      maxMs: round(Math.max(...durations)),
      firstCallMs: round(warmup.ms),
    },
    notes: [`first call in the process: ${round(warmup.ms)} ms (module load and JIT warmup, excluded from the percentiles)`],
  };
}

/** M2 — the causal barrier: can the model see the result without ending the turn? */
export async function inTurnBarrier(impl: Impl): Promise<ScenarioResult> {
  const command = "echo begin; sleep 0.4; echo end";
  const startedAt = performance.now();
  const started = await impl.start(command, { name: "barrier" });
  let toolCalls = 1;
  let statuses: string[] = [];
  let text = "";

  if (impl.caps.inTurnAwait) {
    const awaited = await impl.awaitAll([started.id], 20_000);
    toolCalls += 1;
    statuses = awaited.statuses;
    const read = await impl.readTail(started.id, 16_384);
    toolCalls += 1;
    text = read.text + awaited.text;
  } else if (impl.key === "bash") {
    text = started.text;
    statuses = ["completed"];
  } else {
    await impl.waitCompletionFor([started.id], 20_000);
    toolCalls += 1;
    const status = await impl.status(started.id);
    statuses = [status.status];
    const read = await impl.readTail(started.id, 16_384);
    toolCalls += 1;
    text = read.text;
  }

  return {
    scenario: "barrier",
    title: "In-turn causal barrier (400 ms command)",
    group: "mechanism",
    impl: impl.key,
    metrics: {
      timeToResultMs: round(performance.now() - startedAt),
      toolCalls,
      turnBoundaries: impl.caps.inTurnAwait || impl.key === "bash" ? 0 : 1,
      inTurnAwait: impl.caps.inTurnAwait || impl.key === "bash",
      status: statuses.join(",") || "unknown",
      sawResult: text.includes("end"),
    },
    notes: impl.caps.inTurnAwait
      ? []
      : impl.key === "bash"
        ? ["bash blocks, so the result is in hand when the call returns"]
        : ["no await: the result is only reachable after the completion notification wakes a new turn"],
  };
}

/** M3 — does hitting the log cap kill the process? */
export async function logCap(impl: Impl): Promise<ScenarioResult> {
  const command = "yes x | head -c 31457280; echo finished";
  const startedAt = performance.now();
  const started = await impl.start(command, { name: "cap" });
  if (impl.caps.inTurnAwait || impl.key === "bash") await impl.awaitAll([started.id], 180_000);
  else await impl.waitCompletionFor([started.id], 180_000);
  const status = await impl.status(started.id);
  const tail = await impl.readTail(started.id, 16_384);
  const bytes = logSize(impl.logPath(started.id));
  await safeCancel(impl, started.id);
  const killedByCap = status.status === "failed";
  return {
    scenario: "log-cap",
    title: "30 MiB of output against the log cap",
    group: "mechanism",
    impl: impl.key,
    metrics: {
      status: status.status,
      exitCode: status.exitCode ?? null,
      // A log size is only reported when the implementation exposes a log.
      // The blocking baseline's one result is the only log it has.
      loggedBytes: bytes ?? (impl.key === "bash" ? Buffer.byteLength(started.text, "utf8") : null),
      wallMs: round(performance.now() - startedAt),
      killedByCap,
      tailSawFinished: tail.text.includes("finished"),
    },
    notes: killedByCap ? [`status text: ${status.text.split("\n")[0]}`] : [],
  };
}

/** M4 — can the model find one line in a 200k-line log without reading all of it? */
export async function retrieval(impl: Impl): Promise<ScenarioResult> {
  // The marker is assembled at run time so it never appears in the command
  // text. Otherwise an implementation that echoes the command into its log
  // "finds" the marker at line one and scores a search it never performed.
  const command = `seq 1 200000 | awk '{ if ($1==150000) { a="ERROR_"; b="MARKER boom"; print a b } else print "line " $1 }'`;
  const started = await impl.start(command, { name: "retrieval" });
  if (impl.key !== "bash") {
    if (impl.caps.inTurnAwait) await impl.awaitAll([started.id], 60_000);
    else await impl.waitCompletionFor([started.id], 60_000);
  }

  let found = false;
  let bytesReturned = 0;
  let calls = 0;
  const notes: string[] = [];

  if (impl.caps.grep) {
    const grep = await impl.readGrep(started.id, "ERROR_MARKER");
    calls += 1;
    bytesReturned += grep?.text.length ?? 0;
    found = grep?.found ?? false;
  } else {
    const tail = await impl.readTail(started.id, 51_200);
    calls += 1;
    bytesReturned += tail.text.length;
    found = tail.text.includes("ERROR_MARKER");
    // The blocking baseline has no separate head read: its one result is all
    // there is, and it was already delivered by the start.
    if (impl.key !== "bash") {
      const head = await impl.readHead(started.id, 51_200);
      calls += 1;
      bytesReturned += head.text.length;
      found = found || head.text.includes("ERROR_MARKER");
    }
    notes.push("no search: the reader offers only head and tail, and the marker sits at line 150000 of 200000");
  }

  await safeCancel(impl, started.id);
  return {
    scenario: "retrieval",
    title: "Locate one line in a 200k-line log",
    group: "mechanism",
    impl: impl.key,
    metrics: { found, bytesReturned, calls, logBytes: logSize(impl.logPath(started.id)) },
    notes,
  };
}

/** M5 — three 400 ms commands at once. */
export async function fanOut(impl: Impl): Promise<ScenarioResult> {
  const title = "Three parallel 400 ms commands";
  if (impl.key === "bash") {
    return notExpressible(impl, "fan-out", title, "mechanism", "Three independent commands should overlap.", "bash is one blocking call: three commands are three sequential calls");
  }
  const commands = [1, 2, 3].map((index) => `sleep 0.4; echo done-${index}`);
  const startedAt = performance.now();
  const started = await Promise.all(commands.map((command, index) => impl.start(command, { name: `fanout ${index}` })));
  // The span of the three starts answers "do they overlap"; the total wall time
  // also contains however long this implementation takes to observe completion.
  const startSpanMs = performance.now() - startedAt;
  const ids = started.map((entry) => entry.id);
  let notifications = 0;
  if (impl.caps.inTurnAwait) {
    await impl.awaitAll(ids, 30_000);
  } else {
    const waited = await impl.waitCompletionFor(ids, 30_000);
    notifications = waited.matched;
  }
  const wallMs = performance.now() - startedAt;
  for (const id of ids) await safeCancel(impl, id);
  return {
    scenario: "fan-out",
    title,
    group: "mechanism",
    impl: impl.key,
    metrics: {
      startSpanMs: round(startSpanMs),
      wallMs: round(wallMs),
      toolCalls: ids.length + 1,
      notifications,
      parallel: startSpanMs < 900,
    },
    notes: [],
  };
}

/** M6 — how much context one completion event costs. */
export async function notificationPayload(impl: Impl): Promise<ScenarioResult> {
  const title = "Completion notification payload";
  if (!impl.caps.notify) {
    return notExpressible(impl, "notification", title, "mechanism", "An idle turn should be woken by the command finishing.", "no completion notification exists");
  }
  const started = await impl.start("echo payload-line", { name: "payload" });
  const completion = await impl.waitCompletionFor([started.id], 15_000);
  await safeCancel(impl, started.id);
  return {
    scenario: "notification",
    title,
    group: "mechanism",
    impl: impl.key,
    metrics: {
      notificationBytes: Buffer.byteLength(completion.text, "utf8"),
      delivered: completion.matched > 0,
    },
    notes: completion.matched === 0 ? ["no completion message arrived within 15 s"] : [],
  };
}

// ---------------------------------------------------------------- durability

/**
 * U5 — kill the agent mid-job, restart, and try to get the output back.
 *
 * A separate process starts the job and then SIGKILLs itself, so no shutdown
 * handler runs. A fresh session in the same directory then asks the only
 * question a user asks: is my work still there and can I read what it printed?
 */
export async function restartRecovery(key: string): Promise<ScenarioResult> {
  const spec = specFor(key);
  const title = "Kill the agent mid-job, restart, recover the output";
  const rationale = "If Pi dies while a build runs, the next session should still find the build and the lines it printed.";
  if (key === "bash") {
    return {
      scenario: "restart-recovery",
      title,
      group: "outcome",
      rationale,
      impl: key,
      notExpressible: true,
      metrics: {},
      notes: ["bash has no handle and no log: when Pi dies there is nothing to recover"],
    };
  }

  const cwd = mkdtempSync(join(tmpdir(), `pas-recover-${key}-`));
  const producer = join(fixturesDir, "recover-producer.ts");
  const produced = spawnSync(process.execPath, [producer, `--impl=${key}`, `--cwd=${cwd}`], {
    encoding: "utf8",
    timeout: 90_000,
  });
  const line = produced.stdout.trim().split("\n").pop() ?? "";
  let record: { id: string } | undefined;
  try {
    record = JSON.parse(line);
  } catch {
    record = undefined;
  }
  if (!record?.id) {
    return {
      scenario: "restart-recovery",
      title,
      group: "outcome",
      rationale,
      impl: key,
      metrics: { recovered: false, handleVisible: false, outputReadable: false },
      notes: [`producer failed: ${(produced.stderr ?? "").slice(0, 400)}`],
    };
  }

  await sleep(3200);

  const session = await createBenchSession({ cwd, extension: spec.extension });
  const impl = spec.create(session);
  const spend = meter();
  const notes: string[] = [];
  try {
    const status = await impl.statusAll();
    spend.add(status.text);
    const handleVisible = status.text.includes(record.id);
    let outputReadable = false;
    let lines = 0;
    let readError = "";
    try {
      const read = await impl.readTail(record.id, 16_384);
      spend.add(read.text);
      lines = (read.text.match(/build-step/g) ?? []).length;
      outputReadable = lines > 0;
    } catch (error) {
      readError = String(error).slice(0, 160);
    }
    if (!handleVisible) notes.push("the new session lists no handle for the job");
    if (readError) notes.push(`reading the old handle failed: ${readError}`);

    return {
      scenario: "restart-recovery",
      title,
      group: "outcome",
      rationale,
      impl: key,
      metrics: {
        handleVisible,
        outputReadable,
        lines,
        expectedLines: 40,
        recovered: handleVisible && outputReadable,
        toolCalls: spend.calls,
        bytesIntoModel: spend.bytes,
      },
      notes,
    };
  } finally {
    session.dispose();
  }
}

/** Every in-process scenario, in report order. */
export const SCENARIOS: { key: string; run: (impl: Impl) => Promise<ScenarioResult> }[] = [
  { key: "dev-server", run: devServer },
  { key: "interactive", run: interactivePrompt },
  { key: "answer-cost", run: answerCost },
  { key: "cancel-cleanup", run: cancelCleanup },
  { key: "admission", run: admissionLatency },
  { key: "barrier", run: inTurnBarrier },
  { key: "log-cap", run: logCap },
  { key: "retrieval", run: retrieval },
  { key: "fan-out", run: fanOut },
  { key: "notification", run: notificationPayload },
];
