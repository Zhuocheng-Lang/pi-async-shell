// Pi supplies host packages to extensions through its own module mapping.
// Outside Pi, a benchmark has to reproduce it. This hook resolves a bare
// specifier against the local host installation, honoring each package's
// exports map, and falls back to Node's normal resolution.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repoModules = new URL("../node_modules/", import.meta.url).pathname;
const searchDirs = [
  repoModules,
  ...(process.env.NODE_PATH ?? "").split(":").filter(Boolean),
];

function pickCondition(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const picked = pickCondition(entry);
      if (picked) return picked;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  for (const key of ["import", "default", "node", "require"]) {
    if (key in value) {
      const picked = pickCondition(value[key]);
      if (picked) return picked;
    }
  }
  return undefined;
}

function entryFor(pkg, subpath) {
  const exportsField = pkg.exports;
  const key = subpath === "." ? "." : "./" + subpath;
  let target;
  if (typeof exportsField === "string") {
    target = exportsField;
  } else if (exportsField && typeof exportsField === "object") {
    if (exportsField[key]) {
      target = pickCondition(exportsField[key]);
    } else {
      for (const [pattern, value] of Object.entries(exportsField)) {
        if (!pattern.includes("*")) continue;
        const [prefix, suffix] = pattern.split("*");
        if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue;
        const star = key.slice(prefix.length, key.length - suffix.length);
        const picked = pickCondition(value);
        if (picked) target = picked.replaceAll("*", star);
        break;
      }
    }
  }
  if (typeof target !== "string") target = undefined;
  if (!target) target = pkg.module ?? pkg.main ?? "index.js";
  return target;
}

function splitSpecifier(specifier) {
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  const rest = specifier.slice(name.length).replace(/^\//, "");
  return { name, subpath: rest || "." };
}

function resolveBare(specifier) {
  const { name, subpath } = splitSpecifier(specifier);
  for (const dir of searchDirs) {
    const packageDir = join(dir, name);
    const packageJsonPath = join(packageDir, "package.json");
    if (!existsSync(packageJsonPath)) continue;
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    } catch {
      continue;
    }
    const entry = entryFor(pkg, subpath);
    const entryPath = join(packageDir, entry);
    if (existsSync(entryPath)) return pathToFileURL(entryPath).href;
  }
  return undefined;
}

export async function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.startsWith("node:")) {
    const resolved = resolveBare(specifier);
    if (resolved) return { url: resolved, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
