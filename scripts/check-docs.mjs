// @ts-check
/**
 * Doc contract checker for the docs/design/ series and docs/implementation-notes.md.
 *
 * The design series is written by hand in two languages, and it refers to itself
 * with relative section numbers such as "04-runtime-architecture.md section 6.2".
 * Neither survives a rename, a renumbering or an inserted paragraph without a
 * check. This script is that check. It has no dependencies, so "pnpm verify"
 * stays runnable from a plain "pnpm install".
 *
 * Six contracts:
 *
 *   1. Frontmatter       kind, applies_to and tracks exist; applies_to equals the
 *                        version in package.json. A version bump therefore names
 *                        every document that owes an edit.
 *   2. Version literals  a pre-release tag in this tree is the current one, or the
 *                        line ends with the historical marker.
 *   3. Bilingual mirror  every English file has a zh-CN file with the same heading
 *                        skeleton, the same fenced blocks, the same table shape
 *                        and the same code identifiers.
 *   4. Section refs      a ".md" citation followed by a section sign on the same
 *                        line resolves to a heading carrying that number.
 *   5. Evidence          every test title named in an "Evidence:" line exists.
 *   6. Tool surface      every tool identifier in the prose is a registered tool,
 *                        or one the design records as retired.
 *
 * Prose style is not checked here. The retired vocabulary in 00-terminology.md
 * section 10 is enforced by Vale, which runs as a separate optional job because
 * it needs a binary this repository does not ship.
 *
 * Usage: node scripts/check-docs.mjs
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DESIGN = join(ROOT, "docs", "design");
const DESIGN_ZH = join(DESIGN, "zh-CN");
const NOTES = join(ROOT, "docs", "implementation-notes.md");
const TESTS = join(ROOT, "tests");
const EXTENSION = join(ROOT, "src", "extension.ts");
const PACKAGE = join(ROOT, "package.json");

/** The marker a line carries when it records a version on purpose. */
const HISTORICAL = "<!-- historical -->";

/**
 * Markdown files this series cites that belong to another package rather than to
 * this repository. Each entry names its owner, so a stale entry is visible.
 */
const EXTERNAL_DOCS = new Set([
  "background-task-runtime.md", // pi-background-tasks
  "docs/concepts/completion-delivery.md", // pi-background-tasks
  "docs/codemode.md", // pi-coding-agent
  ".instructions.md", // the handoff extension, cited as a file suffix
  "packages/durable/README.md", // Pi Durable
]);

/**
 * Filenames this series retired in 0.2.0. They may appear only in the rename
 * tables and in the "this file used to be called" notes, which is what those
 * tables are for.
 */
const RENAMED_DOCS = new Set([
  "00-overview.md",
  "01-ecosystem-survey-and-value.md",
  "02-execution-model-and-primitives.md",
  "03-carrier-and-runtime-architecture.md",
  "04-durability-and-containment.md",
]);

/**
 * Tool identifiers the design discusses as removed. 00-terminology.md section 10
 * owns the list. An entry here is a name the prose may use, not a shipped tool.
 */
const RETIRED_TOOLS = new Set(["shell_attach"]);

const FENCE = /^ {0,3}([\x60~]{3,})(.*)$/;
const INLINE_CODE = /[\x60]([^\x60\n]+)[\x60]/g;
const DOC_CITATION = /[\x60]([^\x60\n]*\.md)[\x60]/g;
const HEADING = /^ {0,3}(#{1,6})\s+(.*)$/;
const HEADING_NUMBER = /^(\d+(?:\.\d+)*[a-z]?)\.?(?:\s|$)/;
const SECTION_REF = /§(\d+(?:\.\d+)*[a-z]?)/g;
const RULE_REF = /\b([RC])(\d{1,2})\b/g;
const PRERELEASE = /(?<![@\w.])0\.\d+\.\d+-(?:alpha|beta|rc)\.\d+/g;
const TEST_DECLARATION = /^test\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|\x60([^\x60]*)\x60)/gm;

/** @typedef {{ kind: string, applies_to: string, tracks: string[] }} Frontmatter */
/**
 * @typedef {Object} Doc
 * @property {string} path
 * @property {string} rel
 * @property {string[]} lines
 * @property {string[]} fences
 * @property {Frontmatter | null} front
 * @property {boolean} narrative  A decision record or a proposal: checked for
 *   citations, section references and tool names only. It carries no
 *   frontmatter contract and no bilingual mirror.
 */

/** @param {string} path */
const read = (path) => readFileSync(path, "utf8");

/**
 * A host path is evidence about the machine the survey ran on, not a file this
 * repository ships. Absolute and home-relative citations are therefore skipped
 * rather than resolved, and the survey can date its sources without publishing
 * an account name.
 *
 * @param {string} name
 */
const isHostPath = (name) => name.startsWith("/") || name.startsWith("~/");

/**
 * Resolve a cited filename to an absolute path, or undefined when it names
 * something outside this repository. A citation is a bare filename as often as
 * it is a path from the repository root, so every documentation root is tried
 * nearest-first.
 *
 * @param {Doc} doc
 * @param {string} name
 * @returns {string | undefined}
 */
function resolveCitation(doc, name) {
  if (isHostPath(name) || EXTERNAL_DOCS.has(name) || RENAMED_DOCS.has(name)) return undefined;
  for (const root of [dirname(doc.path), ROOT, join(ROOT, "docs"), DESIGN]) {
    const candidate = join(root, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Split YAML frontmatter off the top of a document. The parser is deliberately
 * tiny: this repository wants three scalar keys and one list, and a YAML
 * dependency would be a larger surface than the check it serves.
 *
 * @param {string[]} raw
 * @returns {{ front: Frontmatter | null, endLine: number, error: string | null }}
 */
function parseFrontmatter(raw) {
  if (raw.length === 0 || raw[0].trim() !== "---") {
    return { front: null, endLine: -1, error: "no frontmatter: the file must open with a --- line" };
  }
  let end = -1;
  for (let index = 1; index < raw.length; index += 1) {
    if (raw[index].trim() === "---") {
      end = index;
      break;
    }
  }
  if (end === -1) return { front: null, endLine: -1, error: "unterminated frontmatter" };

  /** @type {Map<string, string | string[]>} */
  const fields = new Map();
  /** @type {string | null} */
  let listKey = null;
  for (let index = 1; index < end; index += 1) {
    const line = raw[index];
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey) {
      const existing = fields.get(listKey);
      if (Array.isArray(existing)) existing.push(item[1].trim());
      continue;
    }
    const pair = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!pair) continue;
    if (pair[2].trim() === "") {
      fields.set(pair[1], []);
      listKey = pair[1];
    } else {
      fields.set(pair[1], pair[2].trim().replace(/^["'](.*)["']$/, "$1"));
      listKey = null;
    }
  }

  const kind = fields.get("kind");
  const appliesTo = fields.get("applies_to");
  const tracks = fields.get("tracks");
  return {
    front: {
      kind: typeof kind === "string" ? kind : "",
      applies_to: typeof appliesTo === "string" ? appliesTo : "",
      tracks: Array.isArray(tracks) ? tracks : [],
    },
    endLine: end,
    error: null,
  };
}

/**
 * Blank out fenced code so the heading, table and reference walks never read a
 * shell comment as a heading. Line numbers survive because lines are replaced,
 * not removed.
 *
 * @param {string[]} lines
 * @returns {{ lines: string[], fences: string[] }}
 */
function stripFences(lines) {
  /** @type {string[]} */
  const kept = [];
  /** @type {string[]} */
  const fences = [];
  /** @type {{ char: string, length: number } | null} */
  let open = null;
  for (const line of lines) {
    const fence = FENCE.exec(line);
    if (open) {
      if (fence && fence[1][0] === open.char && fence[1].length >= open.length && fence[2].trim() === "") {
        open = null;
      }
      kept.push("");
      continue;
    }
    if (fence) {
      open = { char: fence[1][0], length: fence[1].length };
      fences.push(fence[2].trim());
      kept.push("");
      continue;
    }
    kept.push(line);
  }
  return { lines: kept, fences };
}

/** @param {string} path @param {string} rel @param {boolean} [narrative] @returns {Doc} */
function loadDoc(path, rel, narrative = false) {
  const raw = read(path).split("\n");
  const { front, endLine } = parseFrontmatter(raw);
  const body = raw.map((line, index) => (index <= endLine ? "" : line));
  const { lines, fences } = stripFences(body);
  return { path, rel, lines, fences, front, narrative };
}

/**
 * A backticked span counts as code when it is printable ASCII with no space and
 * is not a bare lowercase word. The filter keeps the spans that must not drift
 * between the two guides (shell_start, ptyView, combined.log,
 * PI_ASYNC_SHELL_EXEC_DIR) and drops the ones a translator may render (partial,
 * a translated tuple description).
 *
 * @param {string} span
 */
function isCodeIdent(span) {
  if (!/^[\x21-\x7E]+$/.test(span)) return false;
  if (/^[a-z]+$/.test(span)) return false;
  return true;
}

/** @param {Doc} doc */
function headingNumbers(doc) {
  /** @type {Map<string, number[]>} */
  const numbers = new Map();
  doc.lines.forEach((line, index) => {
    const heading = HEADING.exec(line);
    if (!heading) return;
    const numbered = HEADING_NUMBER.exec(heading[2]);
    if (!numbered) return;
    const seen = numbers.get(numbered[1]);
    if (seen) seen.push(index + 1);
    else numbers.set(numbered[1], [index + 1]);
  });
  return numbers;
}

/** @param {Doc} doc */
function headingSkeleton(doc) {
  /** @type {string[]} */
  const skeleton = [];
  for (const line of doc.lines) {
    const heading = HEADING.exec(line);
    if (!heading) continue;
    const numbered = HEADING_NUMBER.exec(heading[2]);
    skeleton.push(heading[1].length + ":" + (numbered ? numbered[1] : "-"));
  }
  return skeleton;
}

/** @param {Doc} doc */
function codeIdents(doc) {
  /** @type {Set<string>} */
  const spans = new Set();
  for (const line of doc.lines) {
    for (const match of line.matchAll(INLINE_CODE)) {
      if (isCodeIdent(match[1])) spans.add(match[1]);
    }
  }
  return [...spans].sort();
}

/** @param {Doc} doc */
function tableShape(doc) {
  /** @type {number[]} */
  const shape = [];
  for (const line of doc.lines) {
    if (!/^\s*\|/.test(line)) continue;
    shape.push(line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").length);
  }
  return shape;
}

/** @param {string} file */
function testTitles(file) {
  const path = join(TESTS, file);
  /** @type {Set<string>} */
  const titles = new Set();
  if (!existsSync(path)) return titles;
  for (const match of read(path).matchAll(TEST_DECLARATION)) {
    const title = match[1] ?? match[2] ?? match[3];
    if (title) titles.add(title.replace(/\\"/g, '"'));
  }
  return titles;
}

function registeredTools() {
  /** @type {Set<string>} */
  const names = new Set();
  for (const match of read(EXTENSION).matchAll(/\bname:\s*"(shell_[a-z_]+)"/g)) names.add(match[1]);
  return names;
}

/** @param {string} dir @returns {string[]} */
const listMarkdown = (dir) =>
  readdirSync(dir)
    .filter((entry) => entry.endsWith(".md"))
    .sort();

/** @type {{ where: string, message: string }[]} */
const failures = [];
/** @type {{ where: string, message: string }[]} */
const warnings = [];

/** @param {string} where @param {string} message */
function fail(where, message) {
  failures.push({ where, message });
}
/** @param {string} where @param {string} message */
function warn(where, message) {
  warnings.push({ where, message });
}

const version = JSON.parse(read(PACKAGE)).version;
const englishFiles = listMarkdown(DESIGN);
const chineseFiles = listMarkdown(DESIGN_ZH);

/** @type {Doc[]} */
const docs = [];
for (const file of englishFiles) docs.push(loadDoc(join(DESIGN, file), "docs/design/" + file));
for (const file of chineseFiles) docs.push(loadDoc(join(DESIGN_ZH, file), "docs/design/zh-CN/" + file));
if (existsSync(NOTES)) docs.push(loadDoc(NOTES, "docs/implementation-notes.md"));
// The decision record and the open proposals. Their citations and section
// references are checked like the design's, so a rename cannot orphan them.
for (const folder of ["adr", "rfcs"]) {
  const dir = join(ROOT, "docs", folder);
  if (!existsSync(dir)) continue;
  for (const file of listMarkdown(dir)) docs.push(loadDoc(join(dir, file), "docs/" + folder + "/" + file, true));
}

/** @type {Map<string, Doc>} */
const byRel = new Map();
/** @type {Map<string, Doc>} */
const byPath = new Map();
for (const doc of docs) {
  byRel.set(doc.rel, doc);
  byPath.set(doc.path, doc);
}

// 1. Frontmatter.
for (const doc of docs) {
  if (doc.narrative) continue;
  const { front, error } = parseFrontmatter(read(doc.path).split("\n"));
  if (error) {
    fail(doc.rel, error);
    continue;
  }
  if (!front) continue;
  if (!front.kind) fail(doc.rel, "frontmatter is missing kind");
  else if (!["normative", "empirical", "notes"].includes(front.kind)) {
    fail(doc.rel, "frontmatter kind " + front.kind + " is not normative, empirical or notes");
  }
  if (!front.applies_to) fail(doc.rel, "frontmatter is missing applies_to");
  else if (front.applies_to !== version) {
    fail(doc.rel, "frontmatter applies_to " + front.applies_to + " is not the package.json version " + version);
  }
  if (front.tracks.length === 0) fail(doc.rel, "frontmatter is missing tracks");
  for (const track of front.tracks) {
    if (!existsSync(join(ROOT, track))) fail(doc.rel, "frontmatter tracks a missing path: " + track);
  }
}

// 2. Version literals.
for (const doc of docs) {
  doc.lines.forEach((line, index) => {
    if (line.includes(HISTORICAL)) return;
    for (const match of line.matchAll(PRERELEASE)) {
      if (match[0] === version) continue;
      fail(doc.rel + ":" + (index + 1), "version " + match[0] + " is not the current " + version + "; end the line with " + HISTORICAL + " if it records the past");
    }
  });
}

// 3. Bilingual mirror.
for (const file of englishFiles) {
  const english = byRel.get("docs/design/" + file);
  const chinese = byRel.get("docs/design/zh-CN/" + file);
  if (!chinese) {
    fail("docs/design/" + file, "has no zh-CN counterpart");
    continue;
  }
  if (!english) continue;

  /** @type {[string, string[], string[]][]} */
  const pairs = [
    ["heading skeleton", headingSkeleton(english), headingSkeleton(chinese)],
    ["fenced blocks", english.fences, chinese.fences],
    ["code identifiers", codeIdents(english), codeIdents(chinese)],
    ["table shape", tableShape(english).map(String), tableShape(chinese).map(String)],
  ];
  for (const [label, left, right] of pairs) {
    if (left.length !== right.length) {
      fail("docs/design/" + file, label + ": " + left.length + " in English, " + right.length + " in zh-CN");
      continue;
    }
    const onlyEnglish = left.filter((entry) => !right.includes(entry));
    const onlyChinese = right.filter((entry) => !left.includes(entry));
    if (onlyEnglish.length > 0 || onlyChinese.length > 0) {
      fail(
        "docs/design/" + file,
        label + ": only English " + JSON.stringify(onlyEnglish) + ", only zh-CN " + JSON.stringify(onlyChinese),
      );
    }
  }
  if (english.front && chinese.front) {
    if (english.front.kind !== chinese.front.kind) fail("docs/design/" + file, "frontmatter kind differs from zh-CN");
    if (english.front.applies_to !== chinese.front.applies_to) {
      fail("docs/design/" + file, "frontmatter applies_to differs from zh-CN");
    }
    if (english.front.tracks.join(",") !== chinese.front.tracks.join(",")) {
      fail("docs/design/" + file, "frontmatter tracks differs from zh-CN");
    }
  }
}
for (const file of chineseFiles) {
  if (!englishFiles.includes(file)) fail("docs/design/zh-CN/" + file, "has no English counterpart");
}

// Rules and contracts defined by the overview, used by check 4.
const registered = registeredTools();
const ruleDefinitions = new Set();
const overview = byRel.get("docs/design/01-overview.md");
if (overview) {
  for (const line of overview.lines) {
    const heading = HEADING.exec(line);
    if (!heading) continue;
    for (const match of heading[2].matchAll(RULE_REF)) ruleDefinitions.add(match[1] + match[2]);
  }
}

// 4. Section references, and 6. the tool surface, share one walk of the prose.
for (const doc of docs) {
  doc.lines.forEach((line, index) => {
    const where = doc.rel + ":" + (index + 1);

    for (const match of line.matchAll(DOC_CITATION)) {
      const name = match[1];
      if (isHostPath(name) || EXTERNAL_DOCS.has(name) || RENAMED_DOCS.has(name)) continue;
      // A template writes its citation with a placeholder: <file>.md, NNNN.md.
      if (/[<>]/.test(name)) continue;
      if (!resolveCitation(doc, name)) {
        fail(where, "cites " + name + ", which does not exist; add it to EXTERNAL_DOCS when another package owns it");
      }
    }

    for (const match of line.matchAll(INLINE_CODE)) {
      const span = match[1];
      if (!/^shell_[a-z_]+$/.test(span)) continue;
      if (registered.has(span) || RETIRED_TOOLS.has(span)) continue;
      fail(where, span + " is not a registered tool; RETIRED_TOOLS lists the names the design records as removed");
    }

    // A section sign resolves against a file cited earlier on the same line, so
    // the answer never depends on how far back the nearest path happens to be.
    /** @type {Doc | undefined} */
    let anchor;
    let cursor = 0;
    for (const ref of line.matchAll(SECTION_REF)) {
      const start = ref.index ?? 0;
      const cited = [...line.slice(cursor, start).matchAll(DOC_CITATION)].pop();
      cursor = start + ref[0].length;
      if (cited) {
        const target = resolveCitation(doc, cited[1]);
        anchor = target ? byPath.get(target) : undefined;
      }
      const owner = anchor ?? doc;
      const numbers = byPath.has(owner.path) ? headingNumbers(owner) : null;
      if (!numbers) continue;
      if (!numbers.has(ref[1])) {
        fail(where, "section " + ref[1] + " does not exist in " + owner.rel);
      }
    }

    for (const match of line.matchAll(RULE_REF)) {
      const id = match[1] + match[2];
      if (!ruleDefinitions.has(id)) fail(where, id + " is not a rule or contract defined in 01-overview.md");
    }
  });
}

// 5. Evidence back-links in every loaded document.
for (const doc of docs) {
  doc.lines.forEach((line, index) => {
    if (!line.startsWith("Evidence:")) return;
    const where = doc.rel + ":" + (index + 1);
    /** @type {string | undefined} */
    let file;
    for (const match of line.matchAll(/[\x60]([\w.-]+\.test\.ts)[\x60]|"([^"]+)"/g)) {
      if (match[1]) {
        file = match[1];
        if (!existsSync(join(TESTS, file))) fail(where, "cites " + file + ", which does not exist");
        continue;
      }
      const title = match[2];
      if (!file) {
        warn(where, 'test title "' + title + '" has no file before it on the line');
        continue;
      }
      if (!testTitles(file).has(title)) fail(where, file + ' has no test titled "' + title + '"');
    }
  });
}

for (const entry of warnings) console.log("warning  " + entry.where + "  " + entry.message);
for (const entry of failures) console.error("error    " + entry.where + "  " + entry.message);

if (failures.length > 0) {
  console.error("");
  console.error("check-docs: " + failures.length + " failure(s) across " + docs.length + " documents");
  process.exit(1);
}
console.log("check-docs: " + docs.length + " documents against version " + version + ", " + warnings.length + " warning(s)");
