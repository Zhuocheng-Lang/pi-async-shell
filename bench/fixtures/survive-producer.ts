/**
 * Starts a long-running task and exits immediately, simulating a hard Pi exit.
 * The parent benchmark then measures whether the task kept writing.
 */
import { createBenchSession } from "../harness.ts";
import { installGuard } from "../guard.ts";
import { specFor } from "../impls.ts";

installGuard();
process.env.SHELL = "/bin/sh";
process.env.PI_ASYNC_SHELL = "/bin/sh";

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, "").split("=");
    return [key as string, value as string | undefined];
  }),
);
const key = args.get("impl") ?? "async-shell";
const cwd = args.get("cwd");
if (!cwd) throw new Error("--cwd is required");

const spec = specFor(key);
const session = await createBenchSession({ cwd, extension: spec.extension });
const impl = spec.create(session);

const command = "for i in $(seq 1 25); do echo tick-$i; sleep 0.1; done";
const started = await impl.start(command, { name: "survival", scope: "workspace" });
process.stdout.write(JSON.stringify({ id: started.id, logPath: impl.logPath(started.id), cwd }) + "\n");
// Give the spawn a moment to reach the child, then die without cleanup.
await new Promise((resolve) => setTimeout(resolve, 300));
process.exit(0);
