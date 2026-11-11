import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createBenchSession } from "./harness.ts";

const root = resolve(new URL("..", import.meta.url).pathname);
const vendors = join(root, "bench", "vendors", "node_modules");

const candidates = [
  ["pi-better-background-tasks", "pi-better-background-tasks", "src/index.ts"],
  ["pi-async", "pi-async", "extensions/index.ts"],
  ["pi-background", "pi-background", "extensions/background.ts"],
  ["pi-shell", "@tduyng/pi-shell", "src/index.ts"],
  ["pi-shell-jobs", "pi-shell-jobs", "src/index.ts"],
  ["pi-patty-bg-tasks", "pi-patty-bg-tasks", "index.ts"],
  ["pi-process-monitor", "pi-process-monitor", "extensions"],
  ["alignfirst-pi-background", "@alignfirst/pi-background", "index.js"],
  ["pi-exec-command", "pi-exec-command", "src/extension.ts"],
];

const results = [];
for (const [label, dir, rel] of candidates) {
  const extension = join(vendors, dir, rel);
  const started = Date.now();
  // A path that is not installed loads as an extension with no tools, which
  // would read as a pass. Report it as missing instead.
  if (!existsSync(extension)) {
    results.push({ label, extension, ok: false, loadMs: 0, error: `not installed: ${extension}` });
    continue;
  }
  try {
    const session = await createBenchSession({ extension });
    const tools = session.toolSchemas();
    results.push({ label, extension, ok: true, loadMs: Date.now() - started, tools });
    session.dispose();
  } catch (error) {
    results.push({ label, extension, ok: false, loadMs: Date.now() - started, error: String(error).slice(0, 600) });
  }
}

mkdirSync(join(root, "bench", "out"), { recursive: true });
writeFileSync(join(root, "bench", "out", "tool-surface.json"), JSON.stringify(results, null, 2));

for (const r of results) {
  console.log("\n===== " + r.label + (r.ok ? " OK " + r.loadMs + "ms" : " FAILED: " + r.error));
  if (!r.ok) continue;
  for (const t of r.tools ?? []) {
    const schema = (t.parameters ?? {}) as { properties?: Record<string, unknown>; required?: string[] };
    const params = Object.keys(schema.properties ?? {});
    const required = schema.required ?? [];
    console.log("  " + t.name + "(" + params.map((k) => (required.includes(k) ? k + "*" : k)).join(", ") + ")");
  }
}
process.exit(0);
