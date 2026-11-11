/**
 * Starts a workspace execution and exits immediately, simulating a hard Pi exit.
 * The child keeps the log file descriptor and the exit record.
 */
import { ShellRegistry } from "../../src/core/registry.ts";

const cwd = process.argv[2] as string;
const command = process.argv[3] ?? "sh -c 'sleep 0.8; echo workspace-done'";
const registry = new ShellRegistry({
  cwd,
  sessionId: "producer",
  env: { ...process.env, PI_ASYNC_SHELL: "/bin/sh" },
});
const handle = await registry.start({ command, scope: "workspace" });
process.stdout.write(JSON.stringify({ id: handle.id, pid: handle.pid, log: handle.log }) + "\n");
process.exit(0);
