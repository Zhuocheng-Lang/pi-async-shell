import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBenchSession } from "./harness.ts";
import { specFor } from "./impls.ts";
import type { ScenarioResult } from "./scenarios.ts";

const producer = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "survive-producer.ts");

function countLines(path: string): number {
  try {
    return readFileSync(path, "utf8").split("\n").filter((line) => line.includes("tick-")).length;
  } catch {
    return 0;
  }
}

/**
 * S7 — does the task keep writing after the process that started it is gone?
 *
 * This is the difference a file-backed spawn predicts: a child whose stdout is a
 * pipe held by the parent loses its writer, while a child bound to a file
 * descriptor does not notice that the parent died.
 */
export async function survival(key: string): Promise<ScenarioResult> {
  const spec = specFor(key);
  const title = "Survive a hard parent exit (2.5 s writer)";
  const rationale = "A job started in a turn should keep running after the process that started it is gone.";

  if (key === "bash") {
    return {
      scenario: "survival",
      title,
      group: "outcome",
      rationale,
      impl: key,
      notExpressible: true,
      metrics: {},
      notes: ["bash cannot start a job that outlives the call"],
    };
  }

  const cwd = mkdtempSync(join(tmpdir(), `pas-survive-${key}-`));
  const produced = spawnSync(process.execPath, [producer, `--impl=${key}`, `--cwd=${cwd}`], {
    encoding: "utf8",
    timeout: 90_000,
  });
  const line = produced.stdout.trim().split("\n").pop() ?? "";
  let record: { id: string; logPath?: string } | undefined;
  try {
    record = JSON.parse(line);
  } catch {
    record = undefined;
  }
  if (!record?.id) {
    return {
      scenario: "survival",
      title,
      group: "outcome",
      rationale,
      impl: key,
      metrics: { survived: false, lines: 0, expectedLines: 25 },
      notes: [`producer failed: ${(produced.stderr ?? "").slice(0, 400)}`],
    };
  }

  // The producer is gone. Let the task keep running.
  await new Promise((resolve) => setTimeout(resolve, 2800));

  let lines = 0;
  const notes: string[] = [];
  if (record.logPath) {
    lines = countLines(record.logPath);
  } else {
    // This implementation exposes no log path, so the surviving output is read
    // the way the agent would read it: from a fresh session in the same place.
    notes.push("no log path is exposed; the surviving output was read from a fresh session");
    const session = await createBenchSession({ cwd, extension: spec.extension });
    try {
      const impl = spec.create(session);
      const read = await impl.readTail(record.id, 16_384);
      lines = (read.text.match(/tick-/g) ?? []).length;
    } catch (error) {
      notes.push(`reading the surviving output failed: ${String(error).slice(0, 160)}`);
    } finally {
      session.dispose();
    }
  }
  return {
    scenario: "survival",
    title,
    group: "outcome",
    rationale,
    impl: key,
    metrics: { survived: lines >= 20, lines, expectedLines: 25 },
    notes: [
      `${spec.packageName} wrote ${lines} of 25 lines after the process that started it exited`,
      ...notes,
    ],
  };
}
