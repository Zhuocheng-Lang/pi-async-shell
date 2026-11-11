/**
 * Runs the comparison benchmark and writes bench/out/results.json and
 * bench/REPORT.md.
 *
 * Usage:
 *   node bench/run-bench.ts                # full run
 *   node bench/run-bench.ts --quick        # fewer admission samples
 *   node bench/run-bench.ts --only=async-shell,bg-tasks
 *   node bench/run-bench.ts --render-only  # re-render from bench/out/results.json
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Impl } from "./adapters.ts";
import { installGuard, takeIncidents, type Incident } from "./guard.ts";
import { createBenchSession } from "./harness.ts";
import { IMPLS, specFor, type ImplSpec } from "./impls.ts";
import { SCENARIOS, admissionLatency, restartRecovery, type ScenarioResult } from "./scenarios.ts";
import { survival } from "./survival.ts";

installGuard();
// Every implementation reads the ambient shell. Pin one POSIX shell so they all
// run byte-identical commands; pi-exec-command defaults to $SHELL, which here is
// Nushell, and would otherwise be measured on a different language.
process.env.SHELL = "/bin/sh";
process.env.PI_ASYNC_SHELL = "/bin/sh";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "bench", "out");
const quick = process.argv.includes("--quick");
const onlyArg = process.argv.find((arg) => arg.startsWith("--only="));
const only = onlyArg ? onlyArg.slice("--only=".length).split(",") : undefined;

function environment(): Record<string, string> {
  const run = (command: string): string => {
    try {
      return execSync(command, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "unavailable";
    }
  };
  return {
    date: new Date().toISOString(),
    node: process.version,
    pi: run("pi --version"),
    shell: process.env.SHELL ?? "unknown",
    kernel: run("uname -sr"),
    cpus: run("nproc"),
  };
}

// --------------------------------------------------------------------- runner

async function runInProcess(spec: ImplSpec): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  let session;
  try {
    session = await createBenchSession({ extension: spec.extension });
  } catch (error) {
    return [
      {
        scenario: "load",
        title: "Extension load",
        group: "mechanism",
        impl: spec.key,
        notExpressible: true,
        metrics: {},
        notes: [`the extension did not load: ${String(error).slice(0, 300)}`],
      },
    ];
  }
  const impl: Impl = spec.create(session);
  try {
    for (const scenario of SCENARIOS) {
      const started = Date.now();
      try {
        const result =
          scenario.key === "admission"
            ? await admissionLatency(impl, quick ? 3 : 10)
            : await scenario.run(impl);
        results.push(result);
      } catch (error) {
        results.push({
          scenario: scenario.key,
          title: scenario.key,
          group: "mechanism",
          impl: spec.key,
          notExpressible: true,
          metrics: {},
          notes: [`scenario threw: ${String(error).slice(0, 300)}`],
        });
      }
      process.stderr.write(`  ${spec.key}/${scenario.key} ${Date.now() - started}ms\n`);
    }
  } finally {
    try {
      session.dispose();
    } catch {
      /* a disposal race is recorded as an incident, not thrown */
    }
  }
  return results;
}

// --------------------------------------------------------------------- report

const CELL_NA = "—";

function value(results: ScenarioResult[], scenario: string, impl: string, key: string): number | string | boolean | null {
  const found = results.find((result) => result.scenario === scenario && result.impl === impl);
  if (!found || found.notExpressible) return null;
  return found.metrics[key] ?? null;
}

function yesNo(flag: unknown, detail?: unknown): string {
  if (flag === null || flag === undefined) return CELL_NA;
  const base = flag === true ? "yes" : "no";
  return detail === undefined || detail === null ? base : `${base} — ${detail}`;
}

function fmt(raw: number | string | boolean | null): string {
  if (raw === null || raw === undefined) return CELL_NA;
  if (typeof raw === "number") return Number.isInteger(raw) ? String(raw) : raw.toFixed(1);
  if (typeof raw === "boolean") return raw ? "yes" : "no";
  return String(raw);
}

function table(header: string[], rows: string[][]): string {
  return [
    `| ${header.join(" | ")} |`,
    `|${header.map(() => "---").join("|")}|`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function fieldTable(results: ScenarioResult[], keys: string[]): string {
  return table(
    ["implementation", "package", "downloads/mo"],
    keys.map((key) => {
      const spec = specFor(key);
      return [`\`${key}\``, spec.packageName, spec.downloads ? spec.downloads.toLocaleString("en-US") : CELL_NA];
    }),
  );
}

function capabilityMatrix(keys: string[]): string {
  const caps: { label: string; flag: keyof Impl["caps"] }[] = [
    { label: "In-turn await", flag: "inTurnAwait" },
    { label: "Output-pattern wait", flag: "readiness" },
    { label: "Log search", flag: "grep" },
    { label: "stdin to a running command", flag: "stdin" },
    { label: "PTY", flag: "pty" },
    { label: "Rendered screen", flag: "screen" },
    { label: "Cancel", flag: "cancel" },
    { label: "Completion notification", flag: "notify" },
  ];
  // The capability flags are static per implementation, so they are read from a
  // throwaway adapter rather than from a scenario result.
  const session = { cwd: "", callTool: async () => ({ text: "", ms: 0 }) } as never;
  const impls = new Map(keys.map((key) => [key, specFor(key).create(session)]));
  return table(
    ["capability", ...keys],
    caps.map((cap) => [cap.label, ...keys.map((key) => (impls.get(key)!.caps[cap.flag] ? "yes" : "no"))]),
  );
}

function outcomeTable(results: ScenarioResult[], keys: string[]): string {
  const rows: [string, (key: string) => string][] = [
    [
      "A dev server started in one turn answers in the next",
      (key) => {
        const ready = value(results, "dev-server", key, "ready");
        const calls = value(results, "dev-server", key, "readyCalls");
        return ready === null ? CELL_NA : yesNo(ready, `${calls} call(s) to know it is ready`);
      },
    ],
    [
      "A prompt after a 4000-line burst can be answered",
      (key) => {
        const answered = value(results, "interactive", key, "answered");
        const visible = value(results, "interactive", key, "promptVisible");
        if (answered === null) return CELL_NA;
        if (answered === true) return "yes — prompt answered";
        return visible === true ? "no — prompt visible, no stdin" : "no";
      },
    ],
    [
      "One 2.5 s command: time, context, calls to the answer",
      (key) => {
        const bytes = value(results, "answer-cost", key, "bytesIntoModel");
        if (bytes === null) return CELL_NA;
        return `${fmt(value(results, "answer-cost", key, "answerMs"))} ms, ${bytes} B, ${fmt(value(results, "answer-cost", key, "toolCalls"))} calls`;
      },
    ],
    [
      "Cancel a runaway: output kept, nothing left running",
      (key) => {
        const leaked = value(results, "cancel-cleanup", key, "leakedAfter");
        if (leaked === null) return CELL_NA;
        const supported = value(results, "cancel-cleanup", key, "cancelSupported");
        if (supported === false) return "no — no cancel tool";
        if (leaked !== 0) return `no — ${leaked} process(es) left`;
        const preserved = value(results, "cancel-cleanup", key, "outputPreserved");
        return preserved === true ? "yes — log still readable" : "no — output lost after the cancel";
      },
    ],
    [
      "Output recovered after the agent is killed and restarted",
      (key) => {
        const recovered = value(results, "restart-recovery", key, "recovered");
        if (recovered === null) return CELL_NA;
        return yesNo(recovered, `${fmt(value(results, "restart-recovery", key, "lines"))}/40 lines`);
      },
    ],
    [
      "A task survives a hard parent exit",
      (key) => {
        const lines = value(results, "survival", key, "lines");
        if (lines === null) return CELL_NA;
        return yesNo(value(results, "survival", key, "survived"), `${lines}/25 lines`);
      },
    ],
  ];
  return table(["outcome", ...keys], rows.map(([label, format]) => [label, ...keys.map(format)]));
}

function mechanismTable(results: ScenarioResult[], keys: string[]): string {
  const claims: { claim: string; scenario: string; key: string; invert?: boolean }[] = [
    { claim: "An in-turn causal barrier exists", scenario: "barrier", key: "inTurnAwait" },
    { claim: "A 30 MiB log does not kill the process", scenario: "log-cap", key: "killedByCap", invert: true },
    { claim: "One line in a 200k-line log is reachable", scenario: "retrieval", key: "found" },
    { claim: "Three parallel commands overlap", scenario: "fan-out", key: "parallel" },
    { claim: "A completion notification exists", scenario: "notification", key: "delivered" },
  ];
  return table(
    ["claim", ...keys],
    claims.map((entry) => [
      entry.claim,
      ...keys.map((key) => {
        const raw = value(results, entry.scenario, key, entry.key);
        if (raw === null) return CELL_NA;
        const flag = entry.invert ? raw === false : raw === true;
        return flag ? "yes" : "no";
      }),
    ]),
  );
}

function metricRows(results: ScenarioResult[], scenario: string, keys: string[]): string {
  const present = keys.filter((key) => {
    const found = results.find((result) => result.scenario === scenario && result.impl === key);
    return found && !found.notExpressible;
  });
  if (present.length === 0) return "_(no implementation could express this scenario)_";
  const metricNames = [
    ...new Set(
      results
        .filter((result) => result.scenario === scenario && !result.notExpressible)
        .flatMap((result) => Object.keys(result.metrics)),
    ),
  ];
  return table(
    ["metric", ...present],
    metricNames.map((name) => [name, ...present.map((key) => fmt(value(results, scenario, key, name)))]),
  );
}

function renderSections(results: ScenarioResult[], group: "outcome" | "mechanism", keys: string[]): string {
  const order = [...new Set(results.filter((result) => result.group === group).map((result) => result.scenario))];
  return order
    .map((scenario) => {
      const first = results.find((result) => result.scenario === scenario)!;
      const notes = results
        .filter((result) => result.scenario === scenario && result.notes.length > 0)
        .flatMap((result) => result.notes.map((note) => `- \`${result.impl}\`: ${note}`));
      return [
        `#### ${first.title}`,
        "",
        ...(first.rationale ? [`*${first.rationale}*`, ""] : []),
        metricRows(results, scenario, keys),
        "",
        ...(notes.length > 0 ? [...notes, ""] : []),
      ].join("\n");
    })
    .join("\n");
}

function renderReport(
  results: ScenarioResult[],
  env: Record<string, string>,
  keys: string[],
  incidents: Incident[],
): string {
  const legend = keys.map((key) => `\`${key}\` = ${specFor(key).packageName}`).join(", ");
  return [
    "# Pi background-shell extensions: a measured comparison",
    "",
    "Generated by `node bench/run-bench.ts`. Every call goes through a real Pi SDK",
    "session with exactly one implementation loaded; model latency is excluded by",
    "invoking the registered tools directly. The dev-server scenario crosses a real",
    "turn boundary, driven by a scripted model, because the question there is what",
    "happens at the boundary rather than inside one tool call.",
    "",
    `Columns: ${legend}.`,
    "",
    "## Environment",
    "",
    ...Object.entries(env).map(([key, value]) => `- ${key}: \`${value}\``),
    "",
    "## The field",
    "",
    fieldTable(results, keys),
    "",
    "Adoption is npm downloads in the last 30 days, measured when this benchmark was",
    "written. It orders the columns and nothing else: a widely installed extension is",
    "not thereby a good one.",
    "",
    "## Capability matrix",
    "",
    capabilityMatrix(keys),
    "",
    "Each flag is backed by a registered tool, not by a README. A `no` means the",
    "implementation has no tool that can do the thing at all.",
    "",
    "## What a user gets",
    "",
    outcomeTable(results, keys),
    "",
    "## Mechanisms behind those outcomes",
    "",
    mechanismTable(results, keys),
    "",
    "## Measurements",
    "",
    "### What a user gets",
    "",
    renderSections(results, "outcome", keys),
    "",
    "### Mechanisms",
    "",
    renderSections(results, "mechanism", keys),
    "",
    "## Reading the numbers",
    "",
    "- `—` means the implementation cannot express the scenario: there is no tool",
    "  that could do it. It is not a zero and not a failure to be scored.",
    "- `bytesIntoModel` is the byte count of every tool result the scenario takes.",
    "  It is what the agent pays in context to act; it excludes the system prompt,",
    "  the model's own tokens, and the benchmark's bookkeeping.",
    "- `readyMs` in `dev-server` includes the fixture's 1.2 s startup and, for",
    "  implementations without a readiness signal, up to one 200 ms poll interval.",
    "  The shared 1.2 s is a floor; `readyCalls` is the part that differs.",
    "- `interactive.promptVisible` and `interactive.answered` are separate on",
    "  purpose: an implementation can show the prompt in its log and still be unable",
    "  to answer it. A single yes/no would hide which half failed.",
    "- `cancel-cleanup.leakedAfter` counts live processes whose command line still",
    "  carries the scenario's marker after the cancel returns. Anything left over is",
    "  killed by the benchmark after it is counted, so the run leaves no strays.",
    "- `restart-recovery` starts the job from a child process that SIGKILLs itself,",
    "  waits for the job to finish, then opens a fresh session in the same directory.",
    "- `survival` starts the task from a child process that exits after 300 ms, then",
    "  counts the lines written over the next 2.8 s.",
    "- `barrier.timeToResultMs` includes the turn boundary for implementations with",
    "  no await: the notification has to wake a new turn before the result is",
    "  reachable. The model's own latency is not modelled, so this understates the",
    "  cost of a turn boundary rather than overstating it.",
    "- `log-cap.killedByCap` is the mechanism behind the largest blast radius. An",
    "  implementation that kills the task at its cap reports `failed`; one that stops",
    "  appending and keeps draining reports `completed`.",
    "- `retrieval.bytesReturned` is the context cost of the best available call.",
    "  Without a search, the reader reads both ends and still misses the middle.",
    "- `admission` measures a start plus a forced cancel, ten times, after one",
    "  unmeasured warmup call. The warmup is reported as `firstCallMs` because module",
    "  loading and JIT belong to the process, not to the admission path.",
    ...(incidents.length > 0
      ? [
          "",
          "## Process-level incidents",
          "",
          "Extensions that deliver a completion callback after the session was disposed",
          "throw inside Pi's loader. Each one is caught by the benchmark guard and",
          "recorded here; none of them aborted the run.",
          "",
          ...incidents.map((incident) => `- ${incident.kind}: ${incident.message.split("\n")[0]}`),
        ]
      : []),
    "",
  ].join("\n");
}

// ----------------------------------------------------------------------- main

if (process.argv.includes("--render-only")) {
  const saved = JSON.parse(readFileSync(join(outDir, "results.json"), "utf8")) as {
    env: Record<string, string>;
    keys: string[];
    results: ScenarioResult[];
    incidents: Incident[];
  };
  writeFileSync(join(root, "bench", "REPORT.md"), renderReport(saved.results, saved.env, saved.keys, saved.incidents ?? []));
  console.log("re-rendered bench/REPORT.md from bench/out/results.json");
  process.exit(0);
}

const specs = only ? IMPLS.filter((spec) => only.includes(spec.key)) : IMPLS;
const keys = specs.map((spec) => spec.key);
const env = environment();
const results: ScenarioResult[] = [];

for (const spec of specs) {
  process.stderr.write(`\n== ${spec.key} (${spec.packageName})\n`);
  results.push(...(await runInProcess(spec)));
}

process.stderr.write("\n== cross-process scenarios\n");
for (const spec of specs) {
  process.stderr.write(`  ${spec.key}/survival\n`);
  results.push(await survival(spec.key));
  process.stderr.write(`  ${spec.key}/restart-recovery\n`);
  results.push(await restartRecovery(spec.key));
}

const incidents = takeIncidents();
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "results.json"), JSON.stringify({ env, keys, results, incidents }, null, 2));
const reportPath = join(root, "bench", "REPORT.md");
writeFileSync(reportPath, renderReport(results, env, keys, incidents));
console.log(`\nwrote ${join(outDir, "results.json")} and ${reportPath}`);
process.exit(0);
