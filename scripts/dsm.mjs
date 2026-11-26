// SPDX-FileCopyrightText: 2026 Zhuocheng-Lang
// SPDX-License-Identifier: MPL-2.0

// @ts-check
/**
 * Design Structure Matrix for the source tree.
 *
 * A DSM is the adjacency matrix of the import graph, reordered so that a
 * dependency sits below the diagonal and a feedback edge sits above it. The
 * reordering is what turns the matrix into an argument: below-diagonal marks
 * are the structure, above-diagonal marks are the coupling that a change has to
 * travel through twice. The numbers beside it say how much of the tree a single
 * edit can reach.
 *
 * Usage:
 *   node scripts/dsm.mjs                     text matrix over src/
 *   node scripts/dsm.mjs --format markdown   the same matrix as a markdown table
 *   node scripts/dsm.mjs --format json       the graph, for a tool that wants it
 *   node scripts/dsm.mjs --root tests        any other directory
 *   node scripts/dsm.mjs --fail-on-cycle     exit 1 when a cycle exists
 *
 * Zero dependencies on purpose: see CONTRIBUTING.md, "What a change needs".
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE_EXTENSIONS = [".ts", ".mjs", ".js"];

/**
 * Import specifiers, in the four shapes this tree uses.
 * @type {RegExp[]}
 */
const SPECIFIER_PATTERNS = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  /^\s*import\s+["']([^"']+)["']/gm,
];

/**
 * @typedef {object} Options
 * @property {string} root
 * @property {"text" | "markdown" | "json"} format
 * @property {boolean} failOnCycle
 * @property {boolean} quiet
 */

/**
 * @returns {Options}
 */
function parseArgs() {
  /** @type {Options} */
  const options = { root: "src", format: "text", failOnCycle: false, quiet: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      const value = argv[i + 1];
      if (value === undefined) throw new Error("--root needs a directory");
      options.root = value;
      i += 1;
    } else if (arg.startsWith("--root=")) {
      options.root = arg.slice("--root=".length);
    } else if (arg === "--format") {
      const value = argv[i + 1];
      if (value !== "text" && value !== "markdown" && value !== "json") {
        throw new Error("--format is text, markdown or json");
      }
      options.format = value;
      i += 1;
    } else if (arg.startsWith("--format=")) {
      const value = arg.slice("--format=".length);
      if (value !== "text" && value !== "markdown" && value !== "json") {
        throw new Error("--format is text, markdown or json");
      }
      options.format = value;
    } else if (arg === "--fail-on-cycle") {
      options.failOnCycle = true;
    } else if (arg === "--quiet") {
      options.quiet = true;
    } else {
      throw new Error(`unknown argument "${arg}"`);
    }
  }
  return options;
}

/**
 * Every source file under a directory, as repo-relative POSIX paths.
 * @param {string} root
 * @returns {string[]}
 */
function collectFiles(root) {
  /** @type {string[]} */
  const found = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const path = posix.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext)) && !entry.name.endsWith(".d.ts")) {
        found.push(path);
      }
    }
  };
  walk(root.replace(/\/+$/, ""));
  return found.sort();
}

/**
 * @param {string} text
 * @returns {string[]}
 */
function parseSpecifiers(text) {
  /** @type {string[]} */
  const specifiers = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match !== null) {
      const specifier = match[1];
      if (specifier !== undefined) specifiers.push(specifier);
      match = pattern.exec(text);
    }
  }
  return specifiers;
}

/**
 * Resolve a relative specifier against the file set. Anything that does not
 * land on a known file is external, and external is not a matrix entry.
 * @param {string} fromFile
 * @param {string} specifier
 * @param {Set<string>} known
 * @returns {string | undefined}
 */
function resolveSpecifier(fromFile, specifier, known) {
  if (!specifier.startsWith(".")) return undefined;
  const base = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
  /** @type {string[]} */
  const candidates = [base];
  for (const extension of SOURCE_EXTENSIONS) candidates.push(`${base}${extension}`);
  for (const extension of SOURCE_EXTENSIONS) candidates.push(posix.join(base, `index${extension}`));
  return candidates.find((candidate) => known.has(candidate));
}

/**
 * @param {string} path
 * @returns {number}
 */
function lineCount(path) {
  const text = readFileSync(join(REPO_ROOT, path), "utf8");
  return text.split("\n").length;
}

/**
 * @typedef {object} Graph
 * @property {string[]} nodes
 * @property {Map<string, number>} index
 * @property {number[][]} edges  edges[i] lists the nodes i depends on
 * @property {Map<string, number>} loc
 * @property {Array<{ from: string; specifier: string }>} unresolved
 */

/**
 * @param {string} root
 * @returns {Graph}
 */
function buildGraph(root) {
  const nodes = collectFiles(root);
  const index = new Map(nodes.map((node, i) => [node, i]));
  const known = new Set(nodes);
  /** @type {number[][]} */
  const edges = nodes.map(() => []);
  /** @type {Map<string, number>} */
  const loc = new Map();
  /** @type {Array<{ from: string; specifier: string }>} */
  const unresolved = [];

  nodes.forEach((from, i) => {
    loc.set(from, lineCount(from));
    const text = readFileSync(join(REPO_ROOT, from), "utf8");
    for (const specifier of parseSpecifiers(text)) {
      const target = resolveSpecifier(from, specifier, known);
      if (target === undefined) {
        if (specifier.startsWith(".")) unresolved.push({ from, specifier });
        continue;
      }
      const j = index.get(target);
      if (j === undefined || j === i) continue;
      const list = edges[i];
      if (list !== undefined && !list.includes(j)) list.push(j);
    }
  });

  for (const list of edges) list.sort((a, b) => a - b);
  return { nodes, index, edges, loc, unresolved };
}

/**
 * Tarjan's strongly connected components. The output order is sinks first, so
 * a component is always listed before the components that depend on it: that
 * ordering is the DSM partition.
 * @param {Graph} graph
 * @returns {number[][]}
 */
function stronglyConnected(graph) {
  const n = graph.nodes.length;
  /** @type {number[]} */
  const order = new Array(n).fill(-1);
  /** @type {number[]} */
  const low = new Array(n).fill(0);
  /** @type {boolean[]} */
  const onStack = new Array(n).fill(false);
  /** @type {number[]} */
  const stack = [];
  /** @type {number[][]} */
  const components = [];
  let counter = 0;

  /** @param {number} v */
  const visit = (v) => {
    order[v] = counter;
    low[v] = counter;
    counter += 1;
    stack.push(v);
    onStack[v] = true;
    for (const w of graph.edges[v] ?? []) {
      const orderW = order[w] ?? -1;
      if (orderW === -1) {
        visit(w);
        low[v] = Math.min(low[v] ?? 0, low[w] ?? 0);
      } else if (onStack[w] === true) {
        low[v] = Math.min(low[v] ?? 0, orderW);
      }
    }
    if (low[v] === order[v]) {
      /** @type {number[]} */
      const component = [];
      let w = -1;
      while (w !== v) {
        const top = stack.pop();
        if (top === undefined) throw new Error("stack underflow in Tarjan");
        w = top;
        onStack[w] = false;
        component.push(w);
      }
      components.push(component.sort((a, b) => a - b));
    }
  };

  for (let v = 0; v < n; v += 1) {
    if ((order[v] ?? -1) === -1) visit(v);
  }
  return components;
}

/**
 * @param {Graph} graph
 * @param {number[][]} components
 * @returns {number[]} node indices in partitioned order
 */
function partition(graph, components) {
  const order = components.flat();
  if (order.length !== graph.nodes.length) throw new Error("partition lost a module");
  return order;
}

/**
 * @typedef {object} Metrics
 * @property {number} n
 * @property {number} edges
 * @property {number} density
 * @property {number} propagationCost
 * @property {number} feedbackEdges
 * @property {number} cycles
 * @property {number} largestComponent
 * @property {number} depth
 * @property {number[]} reach   reach[i] is how many nodes i can reach
 * @property {boolean[][]} closure
 */

/**
 * @param {Graph} graph
 * @param {number[]} order
 * @param {number[][]} components
 * @returns {Metrics}
 */
function measure(graph, order, components) {
  const n = graph.nodes.length;
  const position = new Map(order.map((node, i) => [node, i]));
  const edgeCount = graph.edges.reduce((sum, list) => sum + list.length, 0);

  /** @type {boolean[][]} */
  const closure = Array.from({ length: n }, () => new Array(n).fill(false));
  for (let source = 0; source < n; source += 1) {
    /** @type {number[]} */
    const queue = [source];
    const seen = new Set([source]);
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;
      for (const next of graph.edges[current] ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        closure[source][next] = true;
        queue.push(next);
      }
    }
  }
  const reach = closure.map((row) => row.filter(Boolean).length);
  const propagated = closure.reduce((sum, row) => sum + row.filter(Boolean).length, 0);

  let feedbackEdges = 0;
  for (let from = 0; from < n; from += 1) {
    for (const to of graph.edges[from] ?? []) {
      if ((position.get(to) ?? 0) > (position.get(from) ?? 0)) feedbackEdges += 1;
    }
  }

  /** Longest dependency path, in modules. */
  const depthOf = new Map();
  /** @param {number} node @returns {number} */
  const depth = (node) => {
    const memo = depthOf.get(node);
    if (memo !== undefined) return memo;
    depthOf.set(node, 0);
    let best = 0;
    for (const next of graph.edges[node] ?? []) best = Math.max(best, 1 + depth(next));
    depthOf.set(node, best);
    return best;
  };

  return {
    n,
    edges: edgeCount,
    density: n > 1 ? edgeCount / (n * (n - 1)) : 0,
    propagationCost: n > 0 ? propagated / (n * n) : 0,
    feedbackEdges,
    cycles: components.filter((component) => component.length > 1).length,
    largestComponent: components.reduce((largest, component) => Math.max(largest, component.length), 0),
    depth: graph.nodes.reduce((largest, _node, i) => Math.max(largest, depth(i)), 0),
    reach,
    closure,
  };
}

/** @param {number} value @returns {string} */
function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * @param {string} name
 * @param {number} width
 * @returns {string}
 */
function pad(name, width) {
  return name.length >= width ? name : name + " ".repeat(width - name.length);
}

/**
 * @param {Graph} graph
 * @param {number[]} order
 * @param {Metrics} metrics
 * @returns {string}
 */
function renderText(graph, order, metrics) {
  const position = new Map(order.map((node, i) => [node, i]));
  const labels = order.map((node) => graph.nodes[node] ?? "?");
  const width = Math.max(...labels.map((label) => label.length));
  const lines = [];

  lines.push(`DSM ${labels.length} modules, ${metrics.edges} edges, density ${percent(metrics.density)}`);
  lines.push("x = row depends on column, below the diagonal. F = feedback edge, above it. . = none.");
  lines.push("");

  /** @param {number} value @returns {string} */
  const digits = (value) => String(value + 1).padStart(2, "0");
  lines.push(`${pad("", width)}  ${labels.map((_label, i) => digits(i)).join("")}`);
  labels.forEach((label, row) => {
    const cells = labels.map((_other, column) => {
      if (row === column) return "::";
      const source = order[row] ?? 0;
      const target = order[column] ?? 0;
      const depends = (graph.edges[source] ?? []).includes(target);
      if (!depends) return " .";
      return (position.get(target) ?? 0) > row ? " F" : " x";
    });
    lines.push(`${pad(label, width)}  ${cells.join("")}`);
  });
  lines.push("");
  lines.push(`${pad("", width)}  ${labels.map((_label, i) => digits(i)).join("")}`);
  lines.push("");

  lines.push(
    `propagation cost ${percent(metrics.propagationCost)}: the share of module pairs a change can reach. ` +
      `longest chain ${metrics.depth}. feedback edges ${metrics.feedbackEdges}. cycles ${metrics.cycles}.`,
  );
  lines.push("");
  const header = `${pad("#", 3)}  ${pad("module", width)}  ${pad("loc", 5)}  ${pad("fanout", 6)}  ${pad("fanin", 5)}  ${pad("reach", 5)}`;
  lines.push(header);
  lines.push("-".repeat(header.length));
  labels.forEach((label, i) => {
    const node = order[i] ?? 0;
    const fanout = (graph.edges[node] ?? []).length;
    let fanin = 0;
    graph.edges.forEach((list, other) => {
      if (other !== node && list.includes(node)) fanin += 1;
    });
    const loc = graph.loc.get(graph.nodes[node] ?? "") ?? 0;
    lines.push(
      `${String(i + 1).padStart(2, "0")}   ${pad(label, width)}  ${String(loc).padStart(5)}  ` +
        `${String(fanout).padStart(6)}  ${String(fanin).padStart(5)}  ${String(metrics.reach[node] ?? 0).padStart(5)}`,
    );
  });

  if (metrics.cycles > 0) {
    lines.push("");
    lines.push("cycles:");
    for (const component of measureComponents(graph)) {
      if (component.length > 1) {
        lines.push(`  ${component.map((node) => graph.nodes[node] ?? "?").join(" <-> ")}`);
      }
    }
  }

  if (graph.unresolved.length > 0) {
    lines.push("");
    lines.push(`unresolved local specifiers (${graph.unresolved.length}):`);
    for (const { from, specifier } of graph.unresolved) lines.push(`  ${from} -> ${specifier}`);
  }
  return lines.join("\n");
}

/**
 * @param {Graph} graph
 * @returns {number[][]}
 */
function measureComponents(graph) {
  return stronglyConnected(graph);
}

/**
 * @param {Graph} graph
 * @param {number[]} order
 * @param {Metrics} metrics
 * @returns {string}
 */
function renderMarkdown(graph, order, metrics) {
  const position = new Map(order.map((node, i) => [node, i]));
  const labels = order.map((node) => graph.nodes[node] ?? "?");
  const lines = [];
  lines.push(`> ${labels.length} modules, ${metrics.edges} edges, density ${percent(metrics.density)}, ` +
    `propagation cost ${percent(metrics.propagationCost)}, ` +
    `${metrics.feedbackEdges} feedback edges, ${metrics.cycles} cycles.`);
  lines.push("");
  lines.push(`| | ${labels.map((_label, i) => i + 1).join(" | ")} |`);
  lines.push(`|---|${labels.map(() => "---").join("|")}|`);
  labels.forEach((label, row) => {
    const cells = labels.map((_other, column) => {
      if (row === column) return "\\";
      const source = order[row] ?? 0;
      const target = order[column] ?? 0;
      if (!(graph.edges[source] ?? []).includes(target)) return "";
      return (position.get(target) ?? 0) > row ? "**F**" : "x";
    });
    lines.push(`| ${row + 1}. ${label} | ${cells.join(" | ")} |`);
  });
  return lines.join("\n");
}

/**
 * @param {Graph} graph
 * @param {number[]} order
 * @param {Metrics} metrics
 * @returns {string}
 */
function renderJson(graph, order, metrics) {
  const labels = order.map((node) => graph.nodes[node] ?? "?");
  const position = new Map(order.map((node, i) => [node, i]));
  return JSON.stringify(
    {
      nodes: labels,
      rows: labels.map((label, row) => ({
        module: label,
        loc: graph.loc.get(label) ?? 0,
        dependsOn: (graph.edges[order[row] ?? 0] ?? []).map((node) => graph.nodes[node] ?? "?"),
        reach: metrics.reach[order[row] ?? 0] ?? 0,
      })),
      metrics: {
        modules: metrics.n,
        edges: metrics.edges,
        density: metrics.density,
        propagationCost: metrics.propagationCost,
        feedbackEdges: metrics.feedbackEdges,
        cycles: metrics.cycles,
        largestComponent: metrics.largestComponent,
        depth: metrics.depth,
      },
      feedback: graph.edges.flatMap((list, from) =>
        list
          .filter((to) => (position.get(to) ?? 0) > (position.get(from) ?? 0))
          .map((to) => `${graph.nodes[from]} -> ${graph.nodes[to]}`),
      ),
    },
    null,
    2,
  );
}

const options = parseArgs();
const graph = buildGraph(options.root);
const components = stronglyConnected(graph);
const order = partition(graph, components);
const metrics = measure(graph, order, components);

if (options.format === "json") {
  console.log(renderJson(graph, order, metrics));
} else if (options.format === "markdown") {
  console.log(renderMarkdown(graph, order, metrics));
} else {
  console.log(renderText(graph, order, metrics));
}

if (options.failOnCycle && metrics.cycles > 0) {
  if (!options.quiet) console.error(`${metrics.cycles} cycle(s) in ${options.root}`);
  process.exitCode = 1;
}
