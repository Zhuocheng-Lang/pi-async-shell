import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAsyncShellImpl,
  createBackgroundTasksImpl,
  createBashImpl,
  createBetterBackgroundTasksImpl,
  createExecCommandImpl,
  createPattyImpl,
  createPiAsyncImpl,
  createPiBackgroundImpl,
  createPiShellImpl,
  createShellJobsImpl,
  type Impl,
} from "./adapters.ts";
import { PI_GLOBAL_NODE_MODULES, type BenchSession } from "./harness.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, "..");
export const VENDORS = join(here, "vendors", "node_modules");

/** The globally installed pi-background-tasks, which is the incumbent. */
const GLOBAL_BACKGROUND_TASKS = join(
  PI_GLOBAL_NODE_MODULES,
  "pi-background-tasks",
  "dist",
  "extensions",
  "background-tasks.js",
);

export interface ImplSpec {
  key: string;
  /** Full package name and version, or the host tool for the baseline. */
  packageName: string;
  /** npm downloads in the last 30 days; 0 for the baseline and for unpublished code. */
  downloads: number;
  /** Absolute path to the extension entry, or undefined to load no extension. */
  extension?: string;
  create(session: BenchSession): Impl;
}

function vendorVersion(dir: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(VENDORS, dir, "package.json"), "utf8")) as { version: string };
    return pkg.version;
  } catch {
    return "unknown";
  }
}

function vendorEntry(dir: string): string {
  const pkg = JSON.parse(readFileSync(join(VENDORS, dir, "package.json"), "utf8")) as {
    pi?: { extensions?: string[] };
  };
  const rel = pkg.pi?.extensions?.[0];
  if (!rel) throw new Error(`${dir} declares no pi.extensions entry`);
  return join(VENDORS, dir, rel.replace(/^\.\//, ""));
}

/**
 * The field, ordered by adoption. The baseline comes first because it is the
 * thing every extension has to beat; the rest are ordered by npm downloads for
 * the last 30 days, measured when this benchmark was written.
 */
export const IMPLS: ImplSpec[] = [
  {
    key: "bash",
    packageName: "Pi built-in bash",
    downloads: 0,
    extension: undefined,
    create: createBashImpl,
  },
  {
    key: "async-shell",
    packageName: "pi-async-shell",
    downloads: 0,
    extension: join(ROOT, "src", "extension.ts"),
    create: createAsyncShellImpl,
  },
  {
    key: "bg-tasks",
    packageName: `pi-background-tasks@${globalVersion("pi-background-tasks")}`,
    downloads: 26780,
    extension: GLOBAL_BACKGROUND_TASKS,
    create: createBackgroundTasksImpl,
  },
  {
    key: "better-bg",
    packageName: `pi-better-background-tasks@${vendorVersion("pi-better-background-tasks")}`,
    downloads: 6581,
    extension: vendorEntry("pi-better-background-tasks"),
    create: createBetterBackgroundTasksImpl,
  },
  {
    key: "pi-background",
    packageName: `pi-background@${vendorVersion("pi-background")}`,
    downloads: 4293,
    extension: vendorEntry("pi-background"),
    create: createPiBackgroundImpl,
  },
  {
    key: "patty",
    packageName: `pi-patty-bg-tasks@${vendorVersion("pi-patty-bg-tasks")}`,
    downloads: 2476,
    extension: vendorEntry("pi-patty-bg-tasks"),
    create: createPattyImpl,
  },
  {
    key: "pi-async",
    packageName: `pi-async@${vendorVersion("pi-async")}`,
    downloads: 1214,
    extension: vendorEntry("pi-async"),
    create: createPiAsyncImpl,
  },
  {
    key: "pi-shell",
    packageName: `@tduyng/pi-shell@${vendorVersion("@tduyng/pi-shell")}`,
    downloads: 1100,
    extension: vendorEntry("@tduyng/pi-shell"),
    create: createPiShellImpl,
  },
  {
    key: "shell-jobs",
    packageName: `pi-shell-jobs@${vendorVersion("pi-shell-jobs")}`,
    downloads: 766,
    extension: vendorEntry("pi-shell-jobs"),
    create: createShellJobsImpl,
  },
  {
    key: "exec-cmd",
    packageName: `pi-exec-command@${vendorVersion("pi-exec-command")}`,
    downloads: 186,
    extension: vendorEntry("pi-exec-command"),
    create: createExecCommandImpl,
  },
];

function globalVersion(name: string): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(PI_GLOBAL_NODE_MODULES, name, "package.json"), "utf8"),
    ) as { version: string };
    return pkg.version;
  } catch {
    return "unknown";
  }
}

export function specFor(key: string): ImplSpec {
  const spec = IMPLS.find((entry) => entry.key === key);
  if (!spec) throw new Error(`unknown implementation: ${key}`);
  return spec;
}
