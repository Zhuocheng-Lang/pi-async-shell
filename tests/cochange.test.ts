import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildReport,
  capFor,
  clip,
  countPairs,
  describeStructure,
  generated,
  inScope,
  pairKey,
  parseArgs,
  percent,
  readHistory,
  readStructure,
  readTip,
  readTracked,
  renderJson,
  renderText,
  tipOf,
} from "../scripts/cochange.mjs";
import type { Commit, Options, Pair, Structure } from "../scripts/cochange.mjs";

/**
 * The change coupling matrix, pinned where it can regress quietly.
 *
 * The report is an argument about this tree, so the numbers in it go stale on
 * purpose and this file does not assert them as constants. What it does assert
 * is the machinery under them: one count in, three coefficients out; the three
 * filters that decide which commits and which paths are allowed to make a pair;
 * the four names the import graph can give a pair; the arg contract the shell
 * sees; and the two filters a rename has to survive. Those are the parts a
 * refactor breaks without changing any number that a reader would notice.
 *
 * The end-to-end tests run the real script against the real history, and they
 * allow it to grow. They pin the rank order, the derivation of every rate from
 * the payload's own counts, and the specific pair the ADR leans on.
 */

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(ROOT, "scripts", "cochange.mjs");

function options(overrides: Partial<Options> = {}): Options {
  return { scopes: ["src/"], format: "json", threshold: 2, maxShare: 0.3, rev: "HEAD", ...overrides };
}

/** An import graph with nothing in it, so every pair comes out outside it. */
function graph(overrides: Partial<Structure> = {}): Structure {
  return { available: true, nodes: new Set(), distance: new Map(), edge: new Map(), ...overrides };
}

function commit(subject: string, files: string[]): Commit {
  return { hash: subject.padEnd(40, "0").slice(0, 40), date: "2026-01-01", subject, files, renames: [] };
}

function findPair(pairs: Pair[], a: string, b: string): Pair {
  const found = pairs.filter((entry) => pairKey(entry.a, entry.b) === pairKey(a, b));
  assert.equal(found.length, 1, a + " and " + b + " should be one pair");
  return found[0] as Pair;
}

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number | null; stdout?: string; stderr?: string };
    return { status: failure.status ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

function reportJson(args: string[]): Payload {
  const run = runCli(["--format", "json", ...args]);
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout) as Payload;
}

/** The JSON payload, as the documented contract names it. */
type Payload = {
  rev: string;
  tip: string;
  scopes: string[];
  threshold: number;
  maxShare: number;
  structureAvailable: boolean;
  counts: {
    commits: number;
    files: number;
    multiFileCommits: number;
    droppedBySize: number;
    singleFileCommits: number;
  };
  dropped: Array<{ hash: string; subject: string; files: number }>;
  files: Array<{ file: string; commits: number; partners: number; strongest: string | null; strongestN: number }>;
  pairs: Pair[];
  dormant: Array<{ a: string; b: string; commitsA: number; commitsB: number }>;
};

// ---------------------------------------------------------------------------
// The arithmetic: one co-change count, three coefficients.
// ---------------------------------------------------------------------------

test("a pair is counted once per commit and the file counts follow the same commits", () => {
  const { perFile, perPair } = countPairs([
    ["src/a.ts", "src/b.ts"],
    ["src/a.ts", "src/b.ts"],
    ["src/a.ts", "src/c.ts"],
  ]);
  assert.equal(perFile.get("src/a.ts"), 3);
  assert.equal(perFile.get("src/b.ts"), 2);
  assert.equal(perFile.get("src/c.ts"), 1);
  assert.equal(perPair.get(pairKey("src/a.ts", "src/b.ts")), 2);
  assert.equal(perPair.get(pairKey("src/a.ts", "src/c.ts")), 1);
  assert.equal(perPair.get(pairKey("src/b.ts", "src/c.ts")), undefined);
  assert.equal(pairKey("src/b.ts", "src/a.ts"), pairKey("src/a.ts", "src/b.ts"));
});

test("P(B|A), P(A|B) and Jaccard all follow from the one count", () => {
  const tracked = ["src/a.ts", "src/b.ts", "src/c.ts"];
  const report = buildReport(
    options(),
    [commit("one", ["src/a.ts", "src/b.ts"]), commit("two", ["src/a.ts", "src/b.ts"]), commit("three", ["src/a.ts", "src/c.ts"])],
    tracked,
    graph(),
    "tip",
  );
  assert.deepEqual(report.universe, [3, 3, 0, 0]);
  const ab = findPair(report.pairs, "src/a.ts", "src/b.ts");
  assert.equal(ab.n, 2);
  assert.equal(ab.commitsA, 3);
  assert.equal(ab.commitsB, 2);
  assert.equal(ab.pBA, 2 / 3);
  assert.equal(ab.pAB, 1);
  assert.equal(ab.jaccard, 2 / 3);
  const ac = findPair(report.pairs, "src/a.ts", "src/c.ts");
  assert.equal(ac.n, 1);
  assert.equal(ac.pBA, 1 / 3);
  assert.equal(ac.pAB, 1);
  assert.equal(ac.jaccard, 1 / 3);
});

test("a file is ordered first in its pair, so the two rates never swap silently", () => {
  const report = buildReport(
    options(),
    [commit("one", ["src/b.ts", "src/a.ts"])],
    ["src/a.ts", "src/b.ts"],
    graph(),
    "tip",
  );
  const pair = report.pairs[0] as Pair;
  assert.ok(pair.a < pair.b);
  assert.equal(pair.a, "src/a.ts");
});

test("a one-file commit is counted and makes no pair", () => {
  const report = buildReport(
    options(),
    [commit("pair", ["src/a.ts", "src/b.ts"]), commit("solo", ["src/a.ts"])],
    ["src/a.ts", "src/b.ts"],
    graph(),
    "tip",
  );
  assert.deepEqual(report.universe, [2, 1, 0, 1]);
  assert.equal(report.pairs.length, 1);
  assert.equal(report.dropped.length, 0);
});

// ---------------------------------------------------------------------------
// The three filters: size, generated output, and a path that left the tree.
// ---------------------------------------------------------------------------

test("a commit above the size cap is dropped instead of becoming a pair factory", () => {
  const tracked = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "src/f.ts"];
  const report = buildReport(
    options(),
    [commit("wide", tracked.slice(0, 5)), commit("fits", tracked.slice(0, 4))],
    tracked,
    graph(),
    "tip",
  );
  assert.deepEqual(report.universe, [6, 1, 1, 0]);
  assert.deepEqual(report.dropped, [{ hash: "wide" + "0".repeat(36), subject: "wide", files: 5 }]);
  assert.equal(findPair(report.pairs, "src/a.ts", "src/d.ts").n, 1);
  assert.equal(report.pairs.some((pair) => pair.a === "src/e.ts" || pair.b === "src/e.ts"), false);
});

test("the size cap has a floor of four files and no ceiling", () => {
  assert.equal(capFor(options({ maxShare: 0.01 }), 100), 4);
  assert.equal(capFor(options({ maxShare: 0.3 }), 22), 6);
  assert.equal(capFor(options({ maxShare: 0.3 }), 10), 4);
  assert.equal(capFor(options({ maxShare: 1 }), 5), Number.POSITIVE_INFINITY);
});

test("--max-share 1 keeps the whole-tree commit", () => {
  const tracked = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "src/f.ts"];
  const report = buildReport(options({ maxShare: 1 }), [commit("all", tracked)], tracked, graph(), "tip");
  assert.deepEqual(report.universe, [6, 1, 0, 0]);
  assert.equal(report.dropped.length, 0);
  assert.equal(report.pairs.length, 15);
  assert.equal(report.pairs[0]?.n, 1);
});

test("a generated path is recognised by its shape, not by a list of names", () => {
  for (const path of [
    "pnpm-lock.yaml",
    "bench/out/results.json",
    "bench/vendors/library.js",
    "docs/assets/logo.png",
    "node_modules/pkg/index.js",
    ".pi/async-shell/state.json",
  ]) {
    assert.equal(generated(path), true, path + " is a tool's output");
  }
  for (const path of [
    "src/extension.ts",
    "src/core/pipe-supervisor.mjs",
    "tests/cochange.test.ts",
    "docs/adr/0009-read-change-coupling-from-the-history.md",
    "scripts/cochange.mjs",
    "bench/REPORT.md",
  ]) {
    assert.equal(generated(path), false, path + " is a decision");
  }
});

test("a generated file neither pairs nor joins the file count", () => {
  const tracked = ["src/a.ts", "src/b.ts", "pnpm-lock.yaml"];
  const report = buildReport(options(), [commit("bump", tracked)], tracked, graph(), "tip");
  assert.deepEqual(report.universe, [2, 1, 0, 0]);
  assert.equal(findPair(report.pairs, "src/a.ts", "src/b.ts").n, 1);
});

test("a path that is no longer in the tree cannot make a pair", () => {
  const report = buildReport(options(), [commit("gone", ["src/a.ts", "src/removed.ts"])], ["src/a.ts"], graph(), "tip");
  assert.deepEqual(report.universe, [1, 0, 0, 1]);
  assert.equal(report.pairs.length, 0);
});

test("a scope is a path prefix and the whole tree is the empty one", () => {
  assert.equal(inScope("src/extension.ts", ["src/"]), true);
  assert.equal(inScope("tests/cochange.test.ts", ["src/"]), false);
  assert.equal(inScope("tests/cochange.test.ts", ["src/", "tests/"]), true);
  assert.equal(inScope("README.md", [""]), true);
});

// ---------------------------------------------------------------------------
// The four names the import graph can give a pair.
// ---------------------------------------------------------------------------

function classified(): Pair[] {
  const structure = graph({
    nodes: new Set(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]),
    edge: new Map([[pairKey("src/a.ts", "src/b.ts"), ["src/b.ts", "src/a.ts"]]]),
    distance: new Map([
      [pairKey("src/a.ts", "src/b.ts"), 1],
      [pairKey("src/a.ts", "src/c.ts"), 2],
    ]),
  });
  const tracked = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/f.ts"];
  return buildReport(options({ maxShare: 1 }), [commit("all", tracked)], tracked, structure, "tip").pairs;
}

test("an import edge either way makes a pair structural, and names the importer", () => {
  const pair = findPair(classified(), "src/a.ts", "src/b.ts");
  assert.equal(pair.structure, "structural");
  assert.deepEqual(pair.edge, { from: "src/b.ts", to: "src/a.ts" });
  assert.equal(pair.hops, 1);
  assert.equal(describeStructure(pair), "structural, b.ts imports a.ts");
});

test("a path with no edge makes a pair indirect, and carries the hop count", () => {
  const pair = findPair(classified(), "src/a.ts", "src/c.ts");
  assert.equal(pair.structure, "indirect");
  assert.equal(pair.edge, null);
  assert.equal(pair.hops, 2);
  assert.equal(describeStructure(pair), "indirect, 2 hops apart");
});

test("two nodes the graph knows but does not connect are hidden coupling", () => {
  const pair = findPair(classified(), "src/a.ts", "src/d.ts");
  assert.equal(pair.structure, "hidden");
  assert.equal(pair.edge, null);
  assert.equal(pair.hops, null);
  assert.equal(describeStructure(pair), "hidden, no import edge");
});

test("a pair the graph never saw is outside it, not hidden", () => {
  const pair = findPair(classified(), "src/a.ts", "src/f.ts");
  assert.equal(pair.structure, "outside");
  assert.equal(pair.edge, null);
  assert.equal(pair.hops, null);
  assert.equal(describeStructure(pair), "outside the import graph");
});

test("an unreadable import graph degrades every pair to outside and says so", () => {
  const tracked = ["src/a.ts", "src/b.ts"];
  const report = buildReport(options(), [commit("one", tracked)], tracked, graph({ available: false }), "tip");
  assert.equal(report.structureAvailable, false);
  assert.equal(report.pairs[0]?.structure, "outside");
  assert.equal(report.dormant.length, 0);
  const text = renderText(report);
  assert.match(text, /Dormant structure[^\n]*\n {2}\(the import graph could not be read\)/);
});

test("a pair is the strongest partner of every file it touches", () => {
  const report = buildReport(
    options(),
    [commit("one", ["src/a.ts", "src/b.ts"]), commit("two", ["src/a.ts", "src/b.ts"])],
    ["src/a.ts", "src/b.ts"],
    graph(),
    "tip",
  );
  assert.deepEqual(
    report.files.map((entry) => [entry.file, entry.commits, entry.partners, entry.strongest, entry.strongestN]),
    [
      ["src/a.ts", 2, 1, "src/b.ts", 2],
      ["src/b.ts", 2, 1, "src/a.ts", 2],
    ],
  );
});

// ---------------------------------------------------------------------------
// The argument contract the shell sees.
// ---------------------------------------------------------------------------

test("the defaults are a text report over src/ at the threshold of two", () => {
  assert.deepEqual(parseArgs([]), { scopes: ["src/"], format: "text", threshold: 2, maxShare: 0.3, rev: "HEAD" });
});

test("--scope turns all and . into the whole tree and a bare name into a prefix", () => {
  assert.deepEqual(parseArgs(["--scope", "all"]).scopes, [""]);
  assert.deepEqual(parseArgs(["--scope", "."]).scopes, [""]);
  assert.deepEqual(parseArgs(["--scope", "src"]).scopes, ["src/"]);
  assert.deepEqual(parseArgs(["--scope", "src/"]).scopes, ["src/"]);
  assert.deepEqual(parseArgs(["--scope", "src,tests"]).scopes, ["src/", "tests/"]);
});

test("an inline value is the same option as a separate one", () => {
  assert.deepEqual(
    parseArgs(["--scope=src,tests", "--threshold=3", "--max-share=0.5", "--format=json", "--rev=HEAD~2.."]),
    parseArgs(["--scope", "src,tests", "--threshold", "3", "--max-share", "0.5", "--format", "json", "--rev", "HEAD~2.."]),
  );
});

test("an argument that cannot be honoured stops the parse instead of being ignored", () => {
  assert.throws(() => parseArgs(["--nope"]), /unknown argument/);
  assert.throws(() => parseArgs(["-scope"]), /unknown argument/);
  assert.throws(() => parseArgs(["--threshold", "0"]), /at least 1/);
  assert.throws(() => parseArgs(["--threshold", "1.5"]), /at least 1/);
  assert.throws(() => parseArgs(["--max-share", "0"]), /positive number/);
  assert.throws(() => parseArgs(["--max-share", "-1"]), /positive number/);
  assert.throws(() => parseArgs(["--max-share", "wide"]), /positive number/);
  assert.throws(() => parseArgs(["--format", "yaml"]), /text or json/);
  assert.throws(() => parseArgs(["--scope"]), /needs a value/);
  assert.equal(parseArgs(["--threshold", "1"]).threshold, 1);
});

test("the command line exits non-zero on a rejected argument", () => {
  for (const args of [["--nope"], ["--threshold", "0"], ["--max-share", "0"], ["--format", "yaml"], ["--scope"]]) {
    const run = runCli(args);
    assert.notEqual(run.status, 0, args.join(" ") + " should exit non-zero");
    assert.equal(run.stdout, "", args.join(" ") + " should print no report");
  }
});

test("a range is read at its end and an open range ends at HEAD", () => {
  assert.equal(tipOf("HEAD"), "HEAD");
  assert.equal(tipOf("HEAD~8.."), "HEAD");
  assert.equal(tipOf("HEAD~8..HEAD"), "HEAD");
  assert.equal(tipOf("main...feature"), "feature");
  assert.equal(tipOf("HEAD~8.. "), "HEAD");
  assert.equal(tipOf(""), "HEAD");
});

// ---------------------------------------------------------------------------
// Renames, which this repository's short history does not contain, so the
// fixture builds the two commits that would expose the bug.
// ---------------------------------------------------------------------------

function fixtureGit(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Cochange Test", "-c", "user.email=cochange@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

test("a renamed file keeps one history under the name it carries today", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pas-cochange-"));
  try {
    fixtureGit(cwd, "init", "--quiet");
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "old.ts"), "export const moved = 1;\n");
    writeFileSync(join(cwd, "src", "keep.ts"), "export const kept = 1;\n");
    fixtureGit(cwd, "add", "--all");
    fixtureGit(cwd, "commit", "--quiet", "-m", "feat: add the two files");

    fixtureGit(cwd, "mv", "src/old.ts", "src/new.ts");
    writeFileSync(join(cwd, "src", "keep.ts"), "export const kept = 2;\n");
    fixtureGit(cwd, "add", "--all");
    fixtureGit(cwd, "commit", "--quiet", "-m", "refactor: rename the moved file and touch the kept one");

    const commits = readHistory("HEAD", cwd);
    assert.equal(commits.length, 2);
    assert.deepEqual(commits[0]?.renames, [["src/old.ts", "src/new.ts"]]);
    assert.deepEqual([...(commits[0]?.files ?? [])].sort(), ["src/keep.ts", "src/new.ts"]);
    // The older commit is rewritten too. Without that, this pair would be seen
    // once instead of twice, and two renames would hide a file's whole history.
    assert.deepEqual([...(commits[1]?.files ?? [])].sort(), ["src/keep.ts", "src/new.ts"]);

    const tracked = readTracked("HEAD", cwd);
    assert.deepEqual([...tracked].sort(), ["src/keep.ts", "src/new.ts"]);
    const report = buildReport(options(), commits, tracked, readStructure(cwd), readTip("HEAD", cwd));
    assert.equal(report.structureAvailable, false);
    assert.equal(findPair(report.pairs, "src/keep.ts", "src/new.ts").n, 2);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The text report: what it names, what it defers, and what it never invents.
// ---------------------------------------------------------------------------

test("an empty history prints a table with no rows and no claim", () => {
  const report = buildReport(options(), [], [], graph(), "tip");
  const text = renderText(report);
  assert.match(text, /^Change coupling over 0 commits of HEAD \(tip\), scope src\/\./);
  assert.equal(text.match(/^ {2}\(none\)$/gm)?.length, 3);
  assert.doesNotMatch(text, /single commit|coincidence/);
});

test("the text report counts what it holds back and names what it excluded", () => {
  const tracked = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "src/f.ts"];
  const report = buildReport(
    options(),
    [commit("wide", tracked), commit("one", ["src/a.ts", "src/b.ts"]), commit("solo", ["src/a.ts"])],
    tracked,
    graph(),
    "tip",
  );
  const text = renderText(report);
  assert.match(text, /excluded by size\./);
  assert.match(text, /Excluded by size, more than 4 of 6 files touched/);
  assert.match(text, /^ {2}wide0+ +6 files {2}wide$/m);
  assert.match(text, /\(1 below the threshold are counted, not printed\):/);
});

test("a list longer than the section limit defers to --format json", () => {
  const tracked: string[] = [];
  const commits: Commit[] = [];
  const nodes = new Set<string>();
  const edge = new Map<string, [string, string]>();
  for (let index = 0; index < 25; index += 1) {
    const left = "src/p" + String(index) + ".ts";
    const right = "src/q" + String(index) + ".ts";
    tracked.push(left, right);
    nodes.add(left);
    nodes.add(right);
    commits.push(commit("pair " + String(index), [left, right]));
    // An edge into the next pair's file: both ends change, never together.
    edge.set(pairKey(left, "src/q" + String((index + 1) % 25) + ".ts"), [left, "src/q" + String((index + 1) % 25) + ".ts"]);
  }
  const report = buildReport(options(), commits, tracked, graph({ nodes, edge }), "tip");
  assert.equal(report.pairs.length, 25);
  assert.equal(report.dormant.length, 25);
  const text = renderText(report);
  assert.equal(text.match(/and 5 more, all in --format json/g)?.length, 2);
  assert.match(text, /Every one of these is a single commit\. 25 commits cannot separate a rule from a coincidence/);
});

test("the JSON payload carries every pair and leaves the cut to the caller", () => {
  const report = buildReport(
    options(),
    [commit("one", ["src/a.ts", "src/b.ts"])],
    ["src/a.ts", "src/b.ts"],
    graph(),
    "tip",
  );
  const payload = JSON.parse(renderJson(report)) as Payload;
  assert.deepEqual(Object.keys(payload), [
    "rev",
    "tip",
    "scopes",
    "threshold",
    "maxShare",
    "structureAvailable",
    "counts",
    "dropped",
    "files",
    "pairs",
    "dormant",
  ]);
  assert.deepEqual(Object.keys(payload.counts), [
    "commits",
    "files",
    "multiFileCommits",
    "droppedBySize",
    "singleFileCommits",
  ]);
  assert.equal(payload.pairs.length, 1);
  assert.equal(payload.pairs[0]?.n, 1);
  assert.doesNotMatch(renderText(report), /src\/a\.ts +src\/b\.ts/);
});

test("percent and clip keep a value inside its column", () => {
  assert.equal(percent(2 / 3), "66.7%");
  assert.equal(percent(1), "100.0%");
  assert.equal(percent(0), "0.0%");
  assert.equal(clip("abc", 4), "abc");
  assert.equal(clip("abcdef", 4), "abc…");
  assert.equal(clip("abcdef", 4).length, 4);
});

test("importing the report prints nothing", () => {
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", "import " + JSON.stringify(pathToFileURL(SCRIPT).href) + ";"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(output, "");
});

// ---------------------------------------------------------------------------
// The real history, allowed to grow, with the invariants that outlive it.
// ---------------------------------------------------------------------------

test("the report on this repository derives every rate from its own counts", () => {
  const payload = reportJson([]);
  assert.equal(payload.rev, "HEAD");
  assert.deepEqual(payload.scopes, ["src/"]);
  assert.equal(payload.structureAvailable, true);
  assert.ok(payload.counts.commits >= 41, "the history is at least the 41 commits of 0.2.3");
  assert.ok(payload.counts.files >= 20, "src/ holds at least the 20 files of 0.2.3");
  assert.ok(payload.counts.multiFileCommits >= 9);
  assert.ok(payload.counts.droppedBySize >= 2);
  assert.ok(payload.counts.singleFileCommits >= 7);
  assert.ok(
    payload.counts.multiFileCommits + payload.counts.droppedBySize + payload.counts.singleFileCommits <=
      payload.counts.commits,
    "a commit with nothing in scope is counted in neither column",
  );

  const cap = Math.max(4, Math.floor(payload.counts.files * payload.maxShare));
  for (const dropped of payload.dropped) assert.ok(dropped.files > cap, dropped.subject + " was wider than the cap");

  assert.ok(payload.pairs.length > 0);
  for (const pair of payload.pairs) {
    assert.ok(pair.a < pair.b, "a pair is keyed in one order: " + pair.a + " and " + pair.b);
    assert.equal(pair.pBA, pair.n / pair.commitsA);
    assert.equal(pair.pAB, pair.n / pair.commitsB);
    assert.equal(pair.jaccard, pair.n / (pair.commitsA + pair.commitsB - pair.n));
    assert.ok(pair.jaccard > 0 && pair.jaccard <= 1);
    if (pair.structure === "structural") {
      assert.notEqual(pair.edge, null);
      assert.equal(pair.hops, 1);
    } else {
      assert.equal(pair.edge, null, "only an edge makes a pair structural");
    }
    if (pair.structure === "indirect") assert.ok((pair.hops ?? 0) > 1);
    // The hop count comes from the same graph as the edge, so it is present for
    // exactly the two names that come from it.
    if (pair.structure === "hidden" || pair.structure === "outside") assert.equal(pair.hops, null);
  }

  for (let index = 1; index < payload.pairs.length; index += 1) {
    const previous = payload.pairs[index - 1] as Pair;
    const current = payload.pairs[index] as Pair;
    assert.ok(previous.n >= current.n, "pairs are ranked by co-changes");
    if (previous.n === current.n) assert.ok(previous.jaccard >= current.jaccard, "a tie is broken by Jaccard");
  }

  assert.ok(
    payload.pairs.some((pair) => pair.structure === "hidden" || pair.structure === "indirect"),
    "src/ still holds coupling that no import edge explains",
  );
});

test("the pair the ADR leans on is still the strongest one", () => {
  const payload = reportJson([]);
  const strongest = payload.pairs[0] as Pair;
  assert.equal(strongest.a, "src/core/registry.ts");
  assert.equal(strongest.b, "src/extension.ts");
  assert.ok(strongest.n >= 4, "registry.ts and extension.ts changed together at least four times");
  assert.equal(strongest.structure, "structural");
  assert.deepEqual(strongest.edge, { from: "src/extension.ts", to: "src/core/registry.ts" });
  assert.equal(strongest.hops, 1);
  assert.ok(strongest.pBA > 0.5 && strongest.pAB > 0.5 && strongest.jaccard > 0.5);

  const runnersUp = payload.pairs.slice(1, 3).map((pair) => pair.a + " " + pair.b);
  assert.deepEqual(runnersUp, [
    "src/core/types.ts src/extension.ts",
    "src/core/registry.ts src/core/types.ts",
  ]);
  for (const pair of payload.pairs.slice(1, 3)) {
    assert.ok(pair.n >= 2);
    assert.equal(pair.structure, "structural");
  }
});

test("the dormant section lists only edges the kept commits never paired", () => {
  const payload = reportJson([]);
  assert.ok(payload.dormant.length >= 1, "src/ still holds an import edge its ends never exercised together");
  const pairs = new Set(payload.pairs.map((pair) => pairKey(pair.a, pair.b)));
  for (const entry of payload.dormant) {
    assert.equal(pairs.has(pairKey(entry.a, entry.b)), false);
    assert.ok(entry.commitsA >= 1 && entry.commitsB >= 1);
  }
});

test("--scope src,tests pairs the end-to-end test with the extension it drives", () => {
  const payload = reportJson(["--scope", "src,tests"]);
  assert.deepEqual(payload.scopes, ["src/", "tests/"]);
  const pair = findPair(payload.pairs, "tests/extension-e2e.test.ts", "src/extension.ts");
  assert.ok(pair.n >= 7, "the end-to-end test and the extension changed together at least seven times");
  assert.equal(pair.structure, "outside", "a test file is outside the import graph, not hidden in it");
  assert.ok(pair.pBA >= 0.75 && pair.pAB >= 0.75);
});

test("--max-share 1 lifts the whole-tree commits and inflates a pair that never stood alone", () => {
  const strict = reportJson([]);
  const loose = reportJson(["--max-share", "1"]);
  assert.equal(loose.counts.droppedBySize, 0);
  assert.ok(loose.counts.multiFileCommits >= strict.counts.multiFileCommits + 2);
  const lifted = findPair(loose.pairs, "src/core/shell-policy.ts", "src/core/types.ts");
  assert.ok(lifted.n >= 3, "two restructuring commits alone witness this pair three times");
  assert.ok(lifted.n > findPair(strict.pairs, "src/core/shell-policy.ts", "src/core/types.ts").n);
  assert.equal(lifted.structure, "hidden");
});

test("the text report over the whole tree names the scope and the tip", () => {
  const run = runCli(["--scope", "all", "--threshold", "3"]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^Change coupling over \d+ commits of HEAD \([0-9a-f]+\)\, scope the whole tree\./);
  assert.match(run.stdout, /^ {2}n +A +B +P\(B\|A\) +P\(A\|B\) +J +structure$/m);
  assert.match(run.stdout, /^Per file:$/m);
  assert.doesNotMatch(run.stdout, /and \d+ more, all in --format json/);
});
