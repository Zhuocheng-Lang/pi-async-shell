#!/usr/bin/env node
// Make the Pi host packages resolvable from ./node_modules.
//
// `pnpm install` already provides them from devDependencies, so on a normal
// checkout this script has nothing to do. It still earns its place in two
// situations:
//
//   * a checkout that was never installed, where the packages have to come from
//     the NODE_PATH entries of a running Pi installation instead;
//   * the benchmark, which loads third-party Pi extensions that expect Pi's
//     flat store to be visible as ./node_modules.
//
// Both jobs are strictly additive. A package that pnpm manages is never
// replaced, because replacing it would silently downgrade or upgrade the tree
// the type checker and the tests are verified against.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nodeModules = join(root, "node_modules");

/** The packages src/ imports directly. Pi supplies them at runtime. */
const wanted = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "typebox"];

const searchRoots = [
  ...(process.env.NODE_PATH ?? "").split(":").filter(Boolean),
  nodeModules,
];

/** Every name the root manifest declares, and therefore pnpm owns. */
function declaredNames() {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  /** @type {Set<string>} */
  const names = new Set();
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    for (const name of Object.keys(manifest[field] ?? {})) names.add(name);
  }
  return names;
}

const owned = declaredNames();

/** @param {string} name */
function present(name) {
  return existsSync(join(nodeModules, name, "package.json"));
}

/**
 * True when linking `target` to `link` would produce a symlink that points at
 * itself or at its own ancestor, which Node then fails to resolve.
 *
 * @param {string} link
 * @param {string} target
 */
function wouldSelfLink(link, target) {
  if (link === target) return true;
  try {
    const realLink = realpathSync(link);
    const realTarget = realpathSync(target);
    if (realLink === realTarget) return true;
    if (realLink.startsWith(realTarget + "/")) return true;
    if (realTarget.startsWith(realLink + "/")) return true;
  } catch {
    // A link that does not exist yet cannot be a self-link.
  }
  return false;
}

/**
 * lstat, so a symlink whose target is gone still counts as present.
 *
 * @param {string} path
 */
function entryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} name
 * @param {string} target
 */
function link(name, target) {
  const linkPath = join(nodeModules, name);
  if (wouldSelfLink(linkPath, target)) return false;
  mkdirSync(dirname(linkPath), { recursive: true });
  if (entryExists(linkPath)) rmSync(linkPath, { recursive: true, force: true });
  symlinkSync(target, linkPath, "dir");
  return true;
}

/** @param {string} name */
function findPackage(name) {
  for (const base of searchRoots) {
    const candidate = join(base, name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
  }
  return undefined;
}

mkdirSync(nodeModules, { recursive: true });

let linked = 0;
const missing = [];
const kept = [];
for (const name of wanted) {
  if (present(name)) {
    kept.push(name);
    continue;
  }
  const target = findPackage(name);
  if (!target) {
    missing.push(name);
    continue;
  }
  if (link(name, target)) linked += 1;
}

// Pi resolves extension dependencies through its own NODE_PATH entries, which
// include a flat store directory. Mirror that set so the benchmark can load a
// third-party extension outside Pi without copying any package. Declared
// packages stay as pnpm left them; only genuinely absent names are added.
let mirrored = 0;
for (const base of searchRoots) {
  let entries;
  try {
    entries = readdirSync(base);
  } catch {
    continue;
  }
  for (const entry of entries) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    if (entry.startsWith("@")) {
      const scopeDir = join(base, entry);
      let scoped;
      try {
        scoped = readdirSync(scopeDir);
      } catch {
        continue;
      }
      for (const name of scoped) {
        const full = `${entry}/${name}`;
        if (owned.has(full) || present(full)) continue;
        const target = join(scopeDir, name);
        if (!existsSync(join(target, "package.json"))) continue;
        if (link(full, target)) mirrored += 1;
      }
      continue;
    }
    if (owned.has(entry) || present(entry)) continue;
    const target = join(base, entry);
    if (!existsSync(join(target, "package.json"))) continue;
    if (link(entry, target)) mirrored += 1;
  }
}

const parts = [];
if (kept.length > 0) parts.push(`${kept.length} host packages already installed by pnpm`);
if (linked > 0) parts.push(`${linked} host packages linked from NODE_PATH`);
if (mirrored > 0) parts.push(`${mirrored} packages mirrored from Pi's store`);
console.log(parts.length > 0 ? `${parts.join(", ")} in ${nodeModules}` : `nothing to do in ${nodeModules}`);

if (missing.length > 0) {
  console.error(
    `missing host packages: ${missing.join(", ")}\n` +
      `run \`pnpm install\` first, or run this from a shell that has Pi's NODE_PATH`,
  );
  process.exitCode = 1;
}
