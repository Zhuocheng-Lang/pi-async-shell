// SPDX-FileCopyrightText: 2026 Zhuocheng-Lang
// SPDX-License-Identifier: MPL-2.0

// @ts-check
/**
 * Change coupling matrix for the source tree.
 *
 * A DSM (scripts/dsm.mjs) reads the import graph, which is what the code says
 * about itself. This reads the history, which is what the changes did. The two
 * disagree in both directions: a pair of files that always change together and
 * never import each other is coupled through a protocol, an argument or a
 * schema, and a pair that imports and never co-changes is structure nobody has
 * needed to exercise.
 *
 * A pair is counted once per commit that touches both files. Two rates and a
 * Jaccard coefficient follow from that count, because each answers a different
 * question. P(B|A) is "when A changed, how often B had to", and that is the
 * signature of an interface: a provider that edits an API pulls its consumers.
 * Jaccard is "of the commits that touched either file, how many touched both",
 * and it does not reward a file for being touched everywhere.
 *
 * Three filters, each of which the report names when it fires:
 *
 *   - A one-file commit makes no pair. It is counted and skipped.
 *   - A commit that touches a large share of the files in scope is a
 *     restructuring, not a coupling observation: it witnesses one event for
 *     every pair it contains, so a single coincidence becomes a count of three.
 *     This tree has two such commits, the import of 0.2.0-beta.1 and the split
 *     of 0.2.3, and --max-share 1 shows what keeping them costs.
 *   - A generated file records what a tool produced, not what a person decided.
 *
 * Usage:
 *   node scripts/cochange.mjs                   text report over src/
 *   node scripts/cochange.mjs --scope src,tests source files and their tests
 *   node scripts/cochange.mjs --scope all       the whole repository
 *   node scripts/cochange.mjs --threshold 1     every pair, seen once included
 *   node scripts/cochange.mjs --max-share 1     keep the whole-tree commits
 *   node scripts/cochange.mjs --rev HEAD~20..   a narrower range
 *   node scripts/cochange.mjs --format json     the matrix, for a tool
 *
 * The text report applies --threshold; the JSON payload carries every pair and
 * leaves the cut to the caller.
 *
 * Every stage is exported, and every stage that reads git takes the repository
 * directory as an argument defaulted to this one, so tests/cochange.test.ts can
 * feed it a history it controls. Importing this file prints nothing.
 *
 * Zero dependencies on purpose: see CONTRIBUTING.md, "What a change needs".
 */

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository this script lives in, which is the one it reports on. */
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Files whose content is a tool's output. A pair of them co-changes because one
 * command wrote both, and a version bump is the ordinary case.
 * @type {RegExp[]}
 */
const GENERATED = [
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)bench\/out\//,
  /(^|\/)bench\/vendors\//,
  /(^|\/)docs\/assets\//,
  /(^|\/)node_modules\//,
  /(^|\/)\.pi\//,
];

/**
 * The prefix git's --format writes, so a subject cannot be mistaken for a path.
 */
const RECORD = "@@";

/**
 * @typedef {object} Commit
 * @property {string} hash
 * @property {string} date
 * @property {string} subject
 * @property {string[]} files   every path the commit touched, deduplicated
 * @property {Array<[string, string]>} renames
 */

/**
 * @typedef {object} Options
 * @property {string[]} scopes   path prefixes, "" for the whole tree
 * @property {"text" | "json"} format
 * @property {number} threshold   the fewest co-changes a text row may have
 * @property {number} maxShare    the largest share of files in scope a commit may touch
 * @property {string} rev
 */

/**
 * @typedef {object} Structure
 * @property {boolean} available
 * @property {Set<string>} nodes
 * @property {Map<string, number>} distance   pair key to shortest hops, either way
 * @property {Map<string, [string, string]>} edge   pair key to the importer and its import
 */

/**
 * @typedef {object} Pair
 * @property {string} a
 * @property {string} b
 * @property {number} n
 * @property {number} commitsA
 * @property {number} commitsB
 * @property {number} pBA
 * @property {number} pAB
 * @property {number} jaccard
 * @property {"structural" | "indirect" | "hidden" | "outside"} structure
 * @property {{ from: string; to: string } | null} edge   the importer and its import
 * @property {number | null} hops
 */

/**
 * @typedef {object} Report
 * @property {Options} options
 * @property {string} rev
 * @property {string} tip
 * @property {boolean} structureAvailable
 * @property {number} commits
 * @property {number[]} universe   files in scope, kept commits, dropped commits, single-file commits
 * @property {Array<{ hash: string; subject: string; files: number }>} dropped
 * @property {Array<{ file: string; commits: number; partners: number; strongest: string | null; strongestN: number }>} files
 * @property {Pair[]} pairs
 * @property {Array<{ a: string; b: string; commitsA: number; commitsB: number }>} dormant
 */

/**
 * The options an argv produces. The CLI passes process.argv.slice(2); the tests
 * pass a literal array, which is why this reads no process state.
 * @param {string[]} argv
 * @returns {Options}
 */
export function parseArgs(argv) {
  /** @type {Options} */
  const options = { scopes: ["src/"], format: "text", threshold: 2, maxShare: 0.3, rev: "HEAD" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    const inline = equals === -1 ? undefined : arg.slice(equals + 1);
    /** @param {string} name @returns {string} */
    const value = (name) => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined) throw new Error(name + " needs a value");
      i += 1;
      return next;
    };
    if (flag === "--scope") {
      options.scopes = scopesOf(value("--scope"));
    } else if (flag === "--format") {
      options.format = formatOf(value("--format"));
    } else if (flag === "--threshold") {
      options.threshold = count("--threshold", value("--threshold"));
    } else if (flag === "--max-share") {
      options.maxShare = shareOf(value("--max-share"));
    } else if (flag === "--rev") {
      options.rev = value("--rev");
    } else {
      throw new Error('unknown argument "' + arg + '"');
    }
  }
  return options;
}

/**
 * A scope is a path prefix, and "all" and "." are the whole tree.
 * @param {string} raw
 * @returns {string[]}
 */
function scopesOf(raw) {
  return raw.split(",").map((entry) => {
    if (entry === "all" || entry === ".") return "";
    return entry.endsWith("/") ? entry : entry + "/";
  });
}

/**
 * @param {string} raw
 * @returns {"text" | "json"}
 */
function formatOf(raw) {
  if (raw !== "text" && raw !== "json") throw new Error("--format is text or json");
  return raw;
}

/**
 * @param {string} raw
 * @returns {number}
 */
function shareOf(raw) {
  const share = Number(raw);
  if (!Number.isFinite(share) || share <= 0) throw new Error("--max-share is a positive number");
  return share;
}

/**
 * @param {string} name
 * @param {string} raw
 * @returns {number}
 */
export function count(name, raw) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(name + " is a whole number of at least 1");
  return value;
}

/**
 * The commit a range ends at. --rev accepts a git range, and both ls-tree and
 * rev-parse want the single commit at its end rather than the range.
 * @param {string} rev
 * @returns {string}
 */
export function tipOf(rev) {
  const parts = rev.split(/\.{2,3}/);
  const last = (parts[parts.length - 1] ?? "").trim();
  return last === "" ? "HEAD" : last;
}

/**
 * @param {string[]} args
 * @param {string} [cwd]
 * @returns {string}
 */
function git(args, cwd = REPO_ROOT) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/**
 * The short hash the range ends at, which is what the report header names.
 * @param {string} rev
 * @param {string} [cwd]
 * @returns {string}
 */
export function readTip(rev, cwd = REPO_ROOT) {
  return git(["rev-parse", "--short", tipOf(rev)], cwd).trim();
}

/**
 * The history of a range, newest first, as commits with the paths they touched.
 * A rename is recorded under its new name, because the matrix is read against
 * today's tree: a question about which files belong together is not answered by
 * a name that no longer exists.
 * @param {string} rev
 * @param {string} [cwd]
 * @returns {Commit[]}
 */
export function readHistory(rev, cwd = REPO_ROOT) {
  const format = "--format=" + RECORD + "%H|%ad|%s";
  const output = git(["log", rev, "--no-merges", "--name-status", "-M", "--date=short", format], cwd);
  /** @type {Commit[]} */
  const commits = [];
  /** @type {Commit | null} */
  let current = null;
  for (const line of output.split("\n")) {
    if (line.startsWith(RECORD)) {
      const [hash, date, ...rest] = line.slice(RECORD.length).split("|");
      current = { hash: hash ?? "", date: date ?? "", subject: rest.join("|"), files: [], renames: [] };
      commits.push(current);
      continue;
    }
    if (line.trim() === "" || current === null) continue;
    const [status, first, second] = line.split("\t");
    if (status === undefined || first === undefined) continue;
    if (status.startsWith("R") || status.startsWith("C")) {
      if (second === undefined) continue;
      current.files.push(second);
      if (status.startsWith("R")) current.renames.push([first, second]);
    } else if (status !== "D") {
      current.files.push(first);
    }
  }
  return resolveRenames(commits);
}

/**
 * Rewrite every path to the name it carries today, so a file that was renamed is
 * one file across the whole history rather than two unrelated ones.
 * @param {Commit[]} commits
 * @returns {Commit[]}
 */
function resolveRenames(commits) {
  for (const commit of commits) commit.files = [...new Set(commit.files)];

  /** @type {Map<string, string>} */
  const alias = new Map();
  for (const commit of commits) {
    for (const [from, to] of commit.renames) {
      const survivor = alias.get(to) ?? to;
      if (survivor !== from) alias.set(from, survivor);
    }
  }
  for (const commit of commits) commit.files = [...new Set(commit.files.map((file) => alias.get(file) ?? file))];
  return commits;
}

/**
 * @param {string} rev
 * @param {string} [cwd]
 * @returns {string[]}
 */
export function readTracked(rev, cwd = REPO_ROOT) {
  return git(["ls-tree", "-r", "--name-only", tipOf(rev)], cwd)
    .split("\n")
    .filter((line) => line !== "");
}

/**
 * @param {string} file
 * @param {string[]} scopes
 * @returns {boolean}
 */
export function inScope(file, scopes) {
  return scopes.some((prefix) => prefix === "" || file.startsWith(prefix));
}

/**
 * @param {string} file
 * @returns {boolean}
 */
export function generated(file) {
  return GENERATED.some((pattern) => pattern.test(file));
}

/**
 * The import graph as scripts/dsm.mjs reports it. A pair whose endpoints are not
 * both in it is "outside": a test file has no import edge by construction, and
 * calling that hidden coupling would be a category error.
 * @param {string} [root]
 * @returns {Structure}
 */
export function readStructure(root = REPO_ROOT) {
  /** @type {Structure} */
  const structure = { available: false, nodes: new Set(), distance: new Map(), edge: new Map() };
  /** @type {string} */
  let output;
  try {
    output = execFileSync(process.execPath, [join(root, "scripts", "dsm.mjs"), "--format", "json"], {
      cwd: root,
      encoding: "utf8",
    });
  } catch {
    return structure;
  }
  /** @type {{ nodes: string[]; rows: Array<{ module: string; dependsOn: string[] }> }} */
  let payload;
  try {
    payload = JSON.parse(output);
  } catch {
    return structure;
  }
  structure.available = true;
  for (const node of payload.nodes) structure.nodes.add(node);
  /** @type {Map<string, Set<string>>} */
  const out = new Map(payload.nodes.map((node) => [node, new Set()]));
  for (const row of payload.rows) {
    for (const dependency of row.dependsOn) {
      out.get(row.module)?.add(dependency);
      structure.edge.set(pairKey(row.module, dependency), [row.module, dependency]);
    }
  }
  for (const source of payload.nodes) {
    /** @type {Map<string, number>} */
    const hops = new Map([[source, 0]]);
    const queue = [source];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;
      for (const next of out.get(current) ?? []) {
        if (hops.has(next)) continue;
        hops.set(next, (hops.get(current) ?? 0) + 1);
        queue.push(next);
      }
    }
    for (const [target, distance] of hops) {
      if (target === source) continue;
      const key = pairKey(source, target);
      const known = structure.distance.get(key);
      if (known === undefined || distance < known) structure.distance.set(key, distance);
    }
  }
  return structure;
}

/**
 * The key of an unordered pair of paths.
 * @param {string} a
 * @param {string} b
 * @returns {string}
 */
export function pairKey(a, b) {
  const [first, second] = a < b ? [a, b] : [b, a];
  return first + "\u0000" + second;
}

/**
 * Per-file and per-pair commit counts over the commits that survived the filters.
 * @param {string[][]} kept
 * @returns {{ perFile: Map<string, number>; perPair: Map<string, number> }}
 */
export function countPairs(kept) {
  /** @type {Map<string, number>} */
  const perFile = new Map();
  /** @type {Map<string, number>} */
  const perPair = new Map();
  for (const files of kept) {
    for (const file of files) perFile.set(file, (perFile.get(file) ?? 0) + 1);
    for (let i = 0; i < files.length; i += 1) {
      for (let j = i + 1; j < files.length; j += 1) {
        const key = pairKey(files[i] ?? "", files[j] ?? "");
        perPair.set(key, (perPair.get(key) ?? 0) + 1);
      }
    }
  }
  return { perFile, perPair };
}

/**
 * The most files a commit may touch and still be read as a coupling observation.
 * A share below one always leaves room for the smallest useful commit, so the
 * tree cannot reach a cap that drops every multi-file commit.
 * @param {Options} options
 * @param {number} scopeFiles
 * @returns {number}
 */
export function capFor(options, scopeFiles) {
  if (options.maxShare >= 1) return Number.POSITIVE_INFINITY;
  return Math.max(4, Math.floor(scopeFiles * options.maxShare));
}

/**
 * The files of a commit the matrix may read: inside the scope, not a tool's
 * output, and still in the tree at the tip. A path that a later commit deleted
 * has no row to appear in.
 * @param {Commit} commit
 * @param {Options} options
 * @param {Set<string>} known
 * @returns {string[]}
 */
function countedFiles(commit, options, known) {
  return commit.files.filter((file) => inScope(file, options.scopes) && !generated(file) && known.has(file));
}

/**
 * Split the history into the commits the matrix reads, the commits too wide to
 * read, and the count of commits with nothing to pair.
 * @param {Commit[]} commits
 * @param {Options} options
 * @param {Set<string>} known
 * @param {number} cap
 * @returns {{ kept: string[][]; dropped: Report["dropped"]; singles: number }}
 */
function partition(commits, options, known, cap) {
  /** @type {Report["dropped"]} */
  const dropped = [];
  /** @type {string[][]} */
  const kept = [];
  let singles = 0;
  for (const commit of commits) {
    const files = countedFiles(commit, options, known);
    if (files.length < 2) {
      if (files.length === 1) singles += 1;
      continue;
    }
    if (files.length > cap) {
      dropped.push({ hash: commit.hash, subject: commit.subject, files: files.length });
      continue;
    }
    kept.push(files);
  }
  return { kept, dropped, singles };
}

/**
 * What the import graph says about a pair, in the order the report explains it.
 * An edge is structural, a path with no edge is indirect, two nodes the graph
 * knows but does not connect are hidden, and a pair the graph never saw is
 * outside it — a test file has no import edge by construction, and calling that
 * hidden coupling would be a category error.
 * @param {string} key
 * @param {string} a
 * @param {string} b
 * @param {Structure} structure
 * @returns {Pair["structure"]}
 */
function classify(key, a, b, structure) {
  if (structure.edge.has(key)) return "structural";
  if (structure.distance.has(key)) return "indirect";
  if (structure.nodes.has(a) && structure.nodes.has(b)) return "hidden";
  return "outside";
}

/**
 * Strongest first, then the coefficient that does not reward a busy file, then a
 * stable order so two runs of the same history print the same table.
 * @param {Pair} left
 * @param {Pair} right
 * @returns {number}
 */
function byCoupling(left, right) {
  return (
    right.n - left.n || right.jaccard - left.jaccard || left.a.localeCompare(right.a) || left.b.localeCompare(right.b)
  );
}

/**
 * @param {string} key
 * @returns {[string, string]}
 */
function splitKey(key) {
  return /** @type {[string, string]} */ (key.split("\u0000"));
}

/**
 * @param {Map<string, number>} perPair
 * @param {Map<string, number>} perFile
 * @param {Structure} structure
 * @returns {Pair[]}
 */
function buildPairs(perPair, perFile, structure) {
  /** @type {Pair[]} */
  const pairs = [];
  for (const [key, n] of perPair) {
    const [a, b] = splitKey(key);
    const commitsA = perFile.get(a) ?? 0;
    const commitsB = perFile.get(b) ?? 0;
    const imports = structure.edge.get(key) ?? null;
    pairs.push({
      a,
      b,
      n,
      commitsA,
      commitsB,
      pBA: n / commitsA,
      pAB: n / commitsB,
      jaccard: n / (commitsA + commitsB - n),
      structure: classify(key, a, b, structure),
      edge: imports === null ? null : { from: imports[0], to: imports[1] },
      hops: structure.distance.get(key) ?? null,
    });
  }
  pairs.sort(byCoupling);
  return pairs;
}

/**
 * An import edge whose two ends the kept commits both changed, never together.
 * @param {Map<string, number>} perPair
 * @param {Map<string, number>} perFile
 * @param {Structure} structure
 * @returns {Report["dormant"]}
 */
function buildDormant(perPair, perFile, structure) {
  /** @type {Report["dormant"]} */
  const dormant = [];
  for (const key of structure.edge.keys()) {
    if (perPair.has(key)) continue;
    const [a, b] = splitKey(key);
    const commitsA = perFile.get(a);
    const commitsB = perFile.get(b);
    if (commitsA === undefined || commitsB === undefined) continue;
    dormant.push({ a, b, commitsA, commitsB });
  }
  dormant.sort((left, right) => left.a.localeCompare(right.a) || left.b.localeCompare(right.b));
  return dormant;
}

/**
 * One row per file that the kept commits touched.
 * @param {Map<string, number>} perFile
 * @param {Pair[]} pairs
 * @returns {Report["files"]}
 */
function buildFiles(perFile, pairs) {
  /** @type {Report["files"]} */
  const files = [];
  for (const [file, touched] of perFile) {
    const partners = pairs.filter((pair) => pair.a === file || pair.b === file);
    /** @type {Pair | null} */
    let best = null;
    for (const pair of partners) if (best === null || pair.n > best.n) best = pair;
    files.push({
      file,
      commits: touched,
      partners: partners.length,
      strongest: best === null ? null : best.a === file ? best.b : best.a,
      strongestN: best === null ? 0 : best.n,
    });
  }
  files.sort((left, right) => right.commits - left.commits || left.file.localeCompare(right.file));
  return files;
}

/**
 * The whole matrix from a history and a graph, with no process and no git call
 * left in it: the tip is passed in because it is the one fact a range does not
 * carry.
 * @param {Options} options
 * @param {Commit[]} commits
 * @param {string[]} tracked   every path in the tree at the tip
 * @param {Structure} structure
 * @param {string} tip
 * @returns {Report}
 */
export function buildReport(options, commits, tracked, structure, tip) {
  const known = new Set(tracked);
  const universe = tracked.filter((file) => inScope(file, options.scopes) && !generated(file));
  const { kept, dropped, singles } = partition(commits, options, known, capFor(options, universe.length));
  const { perFile, perPair } = countPairs(kept);
  const pairs = buildPairs(perPair, perFile, structure);
  return {
    options,
    rev: options.rev,
    tip,
    structureAvailable: structure.available,
    commits: commits.length,
    universe: [universe.length, kept.length, dropped.length, singles],
    dropped,
    files: buildFiles(perFile, pairs),
    pairs,
    dormant: buildDormant(perPair, perFile, structure),
  };
}

/** How many rows a long list may print before it defers to --format json. */
const SECTION_LIMIT = 20;

/** @param {number} value @returns {string} */
export function percent(value) {
  return (value * 100).toFixed(1) + "%";
}

/**
 * The last segment of a path, which is what a table column has room for.
 * @param {string} file
 * @returns {string}
 */
function base(file) {
  return file.slice(file.lastIndexOf("/") + 1);
}

/**
 * @param {string} text
 * @param {number} width
 * @returns {string}
 */
export function pad(text, width) {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/**
 * @param {string} text
 * @param {number} width
 * @returns {string}
 */
export function clip(text, width) {
  return text.length <= width ? text : text.slice(0, width - 1) + "…";
}

/**
 * @param {Pair} pair
 * @returns {string}
 */
export function describeStructure(pair) {
  if (pair.structure === "structural") {
    return pair.edge === null ? "structural" : "structural, " + base(pair.edge.from) + " imports " + base(pair.edge.to);
  }
  if (pair.structure === "indirect") return "indirect, " + String(pair.hops) + " hops apart";
  if (pair.structure === "hidden") return "hidden, no import edge";
  return "outside the import graph";
}

/**
 * The scope as the header names it, where the empty prefix is the whole tree.
 * @param {string[]} scopes
 * @returns {string}
 */
function scopeLabel(scopes) {
  return scopes.map((scope) => (scope === "" ? "the whole tree" : scope)).join(", ");
}

/**
 * @param {Report} report
 * @returns {string[]}
 */
function renderHead(report) {
  const [scopeFiles, kept, dropped, singles] = report.universe;
  return [
    "Change coupling over " + String(report.commits) + " commits of " + report.rev + " (" + report.tip + "), scope " +
      scopeLabel(report.options.scopes) + ".",
    String(scopeFiles) + " files in scope: " + String(kept) + " commits with two or more of them, " +
      String(singles) + " with one, " + String(dropped) + " excluded by size.",
  ];
}

/**
 * @param {Report} report
 * @param {number} scopeFiles
 * @returns {string[]}
 */
function renderDropped(report, scopeFiles) {
  if (report.dropped.length === 0) return [];
  const lines = [
    "",
    "Excluded by size, more than " + String(capFor(report.options, scopeFiles)) + " of " + String(scopeFiles) +
      " files touched (--max-share 1 keeps them):",
  ];
  for (const commit of report.dropped) {
    lines.push("  " + commit.hash.slice(0, 12) + "  " + String(commit.files).padStart(3) + " files  " + commit.subject);
  }
  return lines;
}

/**
 * The narrowest column that fits the longest pair name, bounded at both ends.
 * @param {Pair[]} pairs
 * @returns {number}
 */
function pairWidth(pairs) {
  return Math.min(48, Math.max(12, ...pairs.map((pair) => Math.max(pair.a.length, pair.b.length))));
}

/**
 * @param {Pair} pair
 * @param {number} width
 * @returns {string}
 */
function pairRow(pair, width) {
  return (
    "  " + pad(String(pair.n), 2) + "  " + pad(clip(pair.a, width), width) + "  " +
    pad(clip(pair.b, width), width) + "  " + pad(percent(pair.pBA), 6) + "  " +
    pad(percent(pair.pAB), 6) + "  " + pad(pair.jaccard.toFixed(2), 5) + "  " + describeStructure(pair)
  );
}

/**
 * @param {Report} report
 * @returns {string[]}
 */
function renderPairs(report) {
  const width = pairWidth(report.pairs);
  const suppressed = report.pairs.filter((pair) => pair.n < report.options.threshold).length;
  const header =
    "  " + pad("n", 2) + "  " + pad("A", width) + "  " + pad("B", width) + "  " +
    pad("P(B|A)", 6) + "  " + pad("P(A|B)", 6) + "  " + pad("J", 5) + "  structure";
  const printed = report.pairs.filter((pair) => pair.n >= report.options.threshold);
  const lines = [
    "",
    "Pairs with at least " + String(report.options.threshold) + " co-changes" +
      (suppressed > 0 ? " (" + String(suppressed) + " below the threshold are counted, not printed)" : "") + ":",
    "",
    header,
    "  " + "-".repeat(header.length - 2),
  ];
  if (printed.length === 0) lines.push("  (none)");
  for (const pair of printed) lines.push(pairRow(pair, width));
  return lines;
}

/**
 * @param {Pair} pair
 * @returns {string}
 */
function hiddenRow(pair) {
  const distance =
    pair.structure === "indirect"
      ? String(pair.hops) + " hops apart in the import graph"
      : "disconnected in the import graph";
  return "  " + String(pair.n) + "  " + pair.a + " x " + pair.b + "  " + distance + ", J " + pair.jaccard.toFixed(2);
}

/**
 * @param {Report} report
 * @returns {string[]}
 */
function renderHidden(report) {
  const hidden = report.pairs.filter((pair) => pair.structure === "hidden" || pair.structure === "indirect");
  const lines = ["", "Hidden coupling, co-changed with no import edge in either direction:"];
  if (hidden.length === 0) lines.push("  (none)");
  for (const pair of hidden.slice(0, SECTION_LIMIT)) lines.push(hiddenRow(pair));
  if (hidden.length > SECTION_LIMIT) {
    lines.push("  and " + String(hidden.length - SECTION_LIMIT) + " more, all in --format json");
  }
  if (hidden.length > 0 && hidden.every((pair) => pair.n < 3)) {
    lines.push(
      "  Every one of these is a single commit. " + String(report.universe[1]) +
        " commits cannot separate a rule from a coincidence, so read them as a hypothesis.",
    );
  }
  return lines;
}

/**
 * @param {Report} report
 * @returns {string[]}
 */
function renderDormant(report) {
  const lines = ["", "Dormant structure, an import edge whose two ends the kept commits changed, never together:"];
  if (!report.structureAvailable) lines.push("  (the import graph could not be read)");
  else if (report.dormant.length === 0) lines.push("  (none)");
  for (const entry of report.dormant.slice(0, SECTION_LIMIT)) {
    lines.push(
      "  " + entry.a + " (" + String(entry.commitsA) + " commits) -> " + entry.b + " (" + String(entry.commitsB) + ")",
    );
  }
  if (report.dormant.length > SECTION_LIMIT) {
    lines.push("  and " + String(report.dormant.length - SECTION_LIMIT) + " more, all in --format json");
  }
  if (report.dormant.length > 0 && report.dormant.every((entry) => Math.min(entry.commitsA, entry.commitsB) < 2)) {
    lines.push("  One end of each of these has a single commit, and one observation cannot show independence.");
  }
  return lines;
}

/**
 * @param {Report} report
 * @returns {string[]}
 */
function renderFiles(report) {
  const width = Math.min(44, Math.max(12, ...report.files.map((entry) => entry.file.length)));
  const lines = [
    "",
    "Per file:",
    "",
    "  " + pad("file", width) + "  " + pad("commits", 7) + "  " + pad("partners", 8) + "  strongest",
    "  " + "-".repeat(width) + "  -------  --------  ---------",
  ];
  for (const entry of report.files) {
    const strongest = entry.strongest === null ? "-" : entry.strongest + " (" + String(entry.strongestN) + ")";
    lines.push(
      "  " + pad(clip(entry.file, width), width) + "  " + pad(String(entry.commits), 7) + "  " +
        pad(String(entry.partners), 8) + "  " + strongest,
    );
  }
  return lines;
}

/**
 * @param {Report} report
 * @returns {string}
 */
export function renderText(report) {
  return [
    ...renderHead(report),
    ...renderDropped(report, report.universe[0]),
    ...renderPairs(report),
    ...renderHidden(report),
    ...renderDormant(report),
    ...renderFiles(report),
  ].join("\n");
}

/**
 * @param {Report} report
 * @returns {string}
 */
export function renderJson(report) {
  const [scopeFiles, kept, dropped, singles] = report.universe;
  return JSON.stringify(
    {
      rev: report.rev,
      tip: report.tip,
      scopes: report.options.scopes,
      threshold: report.options.threshold,
      maxShare: report.options.maxShare,
      structureAvailable: report.structureAvailable,
      counts: {
        commits: report.commits,
        files: scopeFiles,
        multiFileCommits: kept,
        droppedBySize: dropped,
        singleFileCommits: singles,
      },
      dropped: report.dropped,
      files: report.files,
      pairs: report.pairs,
      dormant: report.dormant,
    },
    null,
    2,
  );
}

/**
 * The real path of a path that may be a symlink, or its resolved path when it
 * does not exist.
 * @param {string} path
 * @returns {string}
 */
function real(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Whether this file is the process entry point. Tests import it for the pure
 * stages, and an import must not print a report.
 * @returns {boolean}
 */
function isEntryPoint() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return real(entry) === real(fileURLToPath(import.meta.url));
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const commits = readHistory(options.rev);
  const report = buildReport(options, commits, readTracked(options.rev), readStructure(), readTip(options.rev));
  console.log(options.format === "json" ? renderJson(report) : renderText(report));
}

if (isEntryPoint()) main();
