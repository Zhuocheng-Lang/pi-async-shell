import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

function frontmatter(path: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(read(path));
  assert.ok(match, `${path} has no YAML frontmatter`);
  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const field = /^([a-z][a-z0-9-]*):[ \t]*(.*)$/.exec(line);
    assert.ok(field, `${path} has an unsupported frontmatter line: ${line}`);
    fields[field[1]] = field[2];
  }
  return fields;
}

test("daily and maintainer skills have disjoint routing and ownership", () => {
  const manifest = JSON.parse(read("package.json")) as { pi?: { skills?: string[] } };
  assert.ok(manifest.pi?.skills?.includes("./skills"), "the package root discovers every shipped skill");

  const dailyPath = "skills/async-shell/SKILL.md";
  const maintainerPath = "skills/async-shell-maintainer/SKILL.md";
  const daily = read(dailyPath);
  const maintainer = read(maintainerPath);
  for (const [path, fields] of [
    [dailyPath, frontmatter(dailyPath)],
    [maintainerPath, frontmatter(maintainerPath)],
  ] as const) {
    assert.equal(fields.name, path.split("/").at(-2), `${path} name differs from its directory`);
    assert.ok(fields.description.length > 0, `${path} has an empty description`);
    assert.ok(fields.description.length <= 1024, `${path} description exceeds 1024 characters`);
  }
  assert.doesNotMatch(frontmatter(dailyPath).description, /pi-async-shell extension itself/);
  assert.match(frontmatter(maintainerPath).description, /pi-async-shell extension itself/);
  assert.match(daily, /## Start a server and run dependent tests/);
  assert.ok(daily.includes('command: "pnpm test"'), "consumer test workflows stay in the daily skill");
  assert.match(maintainer, /ordinary project builds and tests with the async-shell skill/);

  const maintainerOnly = [
    "agent_before_settle",
    "session_shutdown",
    "consumedByAwait",
    "pipe-supervisor.mjs",
    "recording-writer.mjs",
    "script(1)",
    "registry GC",
    "pnpm verify",
    "pnpm pack --dry-run",
    "CONTRIBUTING.md",
    "docs/implementation-notes.md",
    "src/extension.ts",
  ];
  for (const text of maintainerOnly) {
    assert.equal(daily.includes(text), false, "daily skill contains maintainer-only text: " + text);
  }

  for (const text of [
    "agent_before_settle",
    "session_shutdown",
    "consumedByAwait",
    "pipe-supervisor.mjs",
    "recording-writer.mjs",
    "pnpm verify",
    "CONTRIBUTING.md",
    "docs/design/06-skill-boundaries.md",
  ]) {
    assert.ok(maintainer.includes(text), "maintainer skill lost its ownership marker: " + text);
  }

  const contracts = maintainer.split("## Read canonical contracts\n")[1]?.split("\n## ")[0] ?? "";
  const references = [...contracts.matchAll(/^\|[^|\n]+\|\s*([^|\n]+?)\s*\|$/gm)]
    .map((match) => match[1].trim())
    .filter((path) => path !== "Canonical source" && path !== "---");
  assert.ok(references.length >= 8, "the maintainer skill lost its canonical routing table");
  for (const path of references) {
    assert.ok(existsSync(join(ROOT, path)), `maintainer skill cites a missing path: ${path}`);
  }

  for (const path of [
    "docs/design/06-skill-boundaries.md",
    "docs/design/zh-CN/06-skill-boundaries.md",
  ]) {
    const design = read(path);
    assert.ok(design.includes("skills/async-shell/SKILL.md"));
    assert.ok(design.includes("skills/async-shell-maintainer/SKILL.md"));
    assert.ok(design.includes("pnpm test"));
  }
});
