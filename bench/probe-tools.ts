import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBenchSession } from "./harness.ts";
import { IMPLS, ROOT, vendorEntry } from "./impls.ts";

/**
 * Tool-surface probe. Loads one extension at a time and prints the tool names
 * and parameter names it registers, so the capability matrix in
 * `bench/REPORT.md` can be read off a real schema instead of a package's README.
 *
 * Manual: nothing imports it, `bench/run-bench.ts` does not call it, and it is
 * not a gate.
 *
 *   node bench/probe-tools.ts                 # every extension in the pinned field
 *   node bench/probe-tools.ts pi-shell-jobs   # named vendor directories instead
 *
 * The default field comes from `impls.ts`, so the probe cannot drift from the
 * packages the report measured. Named directories are how a candidate is
 * judged before it joins the field: `pi-process-monitor` and
 * `@alignfirst/pi-background` were dropped after this printed their tools.
 *
 * Writes `bench/out/tool-surface.json` and exits 0 whatever the extensions do:
 * one that fails to load is a row in the output, not a failed run.
 */
interface ProbeTarget {
  key: string;
  packageName: string;
  extension: string;
}

interface ProbeResult extends ProbeTarget {
  ok: boolean;
  loadMs: number;
  tools?: { name: string; parameters?: unknown }[];
  error?: string;
}

const named = process.argv.slice(2);
const targets: ProbeTarget[] =
  named.length > 0
    ? named.map((dir) => ({ key: dir, packageName: dir, extension: vendorEntry(dir) }))
    : IMPLS.filter((spec) => spec.extension !== undefined).map((spec) => ({
        key: spec.key,
        packageName: spec.packageName,
        extension: spec.extension as string,
      }));

const results: ProbeResult[] = [];

for (const target of targets) {
  const started = Date.now();
  try {
    const session = await createBenchSession({ extension: target.extension });
    results.push({ ...target, ok: true, loadMs: Date.now() - started, tools: session.toolSchemas() });
    session.dispose();
  } catch (error) {
    results.push({ ...target, ok: false, loadMs: Date.now() - started, error: String(error).slice(0, 600) });
  }
}

mkdirSync(join(ROOT, "bench", "out"), { recursive: true });
writeFileSync(join(ROOT, "bench", "out", "tool-surface.json"), JSON.stringify(results, null, 2));

for (const result of results) {
  const header = result.key + " (" + result.packageName + ")";
  console.log("\n===== " + header + (result.ok ? " OK " + result.loadMs + "ms" : " FAILED: " + result.error));
  if (!result.ok) continue;
  for (const tool of result.tools ?? []) {
    const schema = (tool.parameters ?? {}) as { properties?: Record<string, unknown>; required?: string[] };
    const params = Object.keys(schema.properties ?? {});
    const required = schema.required ?? [];
    console.log("  " + tool.name + "(" + params.map((key) => (required.includes(key) ? key + "*" : key)).join(", ") + ")");
  }
}
process.exit(0);
