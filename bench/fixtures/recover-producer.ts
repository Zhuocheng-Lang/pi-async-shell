/**
 * Starts a long job, reports its handle, then SIGKILLs itself so the benchmark
 * can ask a fresh session whether the job and its output are still reachable.
 *
 * The kill is deliberate: no shutdown handler runs, the workspace lock is not
 * released, and the exit record has to come from the job itself.
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

const command = 'for i in $(seq 1 40); do echo "build-step $i"; sleep 0.05; done; echo build-done';
const started = await impl.start(command, { name: "recovery", scope: "workspace", notifyOnCompletion: false });
process.stdout.write(JSON.stringify({ id: started.id, logPath: impl.logPath(started.id), cwd }) + "\n");

// Give the spawn a moment to reach the child, then die without cleanup.
await new Promise((resolve) => setTimeout(resolve, 250));
process.kill(process.pid, "SIGKILL");
