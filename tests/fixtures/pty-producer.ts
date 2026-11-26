/**
 * A stand-in for a Pi process, used to prove that a pty execution outlives the
 * process that started it.
 *
 * It starts the execution, optionally promotes it to `workspace`, prints the
 * handle as one JSON line, and then waits to be killed. The test sends SIGKILL
 * and checks the log keeps growing and that a fresh registry can adopt the handle.
 * The `exit` mode exits immediately instead, simulating a clean hard exit.
 */
import { ShellRegistry } from "../../src/core/registry.ts";
import { acquireWorkspaceLock } from "../../src/core/workspace-lock.ts";

const cwd = process.argv[2];
const command = process.argv[3];
const mode = process.argv[4];
const promote = mode === "promote";
const binding = process.argv[5] === "pipe" ? "pipe" : "pty";
if (!cwd || !command) throw new Error("usage: pty-producer.ts <cwd> <command> [workspace|promote|session|exit] [pipe|pty]");

const registry = new ShellRegistry({
  cwd,
  sessionId: "producer",
  env: { ...process.env, PI_ASYNC_SHELL: "/bin/sh" },
});
const lock = acquireWorkspaceLock(registry.paths, "producer");
registry.setWorkspaceOwner(lock.owned, lock.holder?.pid);

const started = await registry.start({
  command,
  binding,
  scope: promote || mode === "session" ? "session" : "workspace",
});
// Promotion is the release of the owner watch: without it the wrapper would
// tear the PTY down when this process dies.
const handle = promote ? await registry.promote({ id: started.id, to: "workspace" }) : started;
process.stdout.write(`${JSON.stringify({ id: handle.id, dir: handle.log.dir, scope: handle.scope })}\n`);

if (mode === "exit") process.exit(0);
setInterval(() => {}, 1000);
