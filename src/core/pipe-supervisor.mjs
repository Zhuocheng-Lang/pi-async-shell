import { spawn } from "node:child_process";
import {
  createReadStream,
  createWriteStream,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const [dir, shell, command, capArgument, watchArgument] = process.argv.slice(2);
if (!dir || !shell || command === undefined) {
  throw new Error("usage: pipe-supervisor.mjs <dir> <shell> <command> <capBytes> <watch>");
}
const capBytes = Math.max(0, Number.isFinite(Number(capArgument)) ? Math.trunc(Number(capArgument)) : 10 * 1024 * 1024);
const watch = watchArgument === "1";

/** @param {string} name @param {unknown} value */
function writeJsonAtomic(name, value) {
  const path = join(dir, name);
  const temporary = path + "." + process.pid + ".tmp";
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, path);
}

function identity() {
  const raw = readFileSync("/proc/self/stat", "utf8");
  const fields = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/);
  writeJsonAtomic("pid.json", {
    pid: process.pid,
    pgid: Number(fields[2]),
    starttime: Number(fields[19]),
  });
}
identity();

// Command output is plaintext and can hold anything the command printed, so the
// files are owner-only even when the surrounding umask is permissive.
const stdout = createWriteStream(join(dir, "stdout.log"), { flags: "a", mode: 0o600 });
const stderr = createWriteStream(join(dir, "stderr.log"), { flags: "a", mode: 0o600 });
const combined = createWriteStream(join(dir, "combined.log"), { flags: "a", mode: 0o600 });
for (const stream of [stdout, stderr, combined]) stream.on("error", () => undefined);

let logged = 0;
let capReached = false;
/** @param {Buffer} chunk @param {import("node:fs").WriteStream} stream */
function append(chunk, stream) {
  const room = Math.max(0, capBytes - logged);
  const slice = chunk.length <= room ? chunk : chunk.subarray(0, room);
  if (slice.length > 0) {
    stream.write(slice);
    combined.write(slice);
    logged += slice.length;
  }
  if (slice.length < chunk.length && !capReached) {
    capReached = true;
    try {
      writeJsonAtomic("log-cap.json", { capBytes, reachedAt: Date.now() });
    } catch {
      // Logging protection must not become a process-level failure.
    }
  }
}

const child = spawn(shell, ["-c", command], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (chunk) => append(chunk, stdout));
child.stderr.on("data", (chunk) => append(chunk, stderr));

let released = !watch;
let settled = false;
/** @type {NodeJS.Timeout | undefined} */
let killTimer;
/** @type {import("node:fs").ReadStream | undefined} */
let owner;
// A group signal also reaches this supervisor. Ignore TERM long enough to seal
// the exit record; registry cancellation still escalates to KILL when needed.
process.on("SIGTERM", () => undefined);

function terminateGroup() {
  if (settled || released) return;
  try {
    process.kill(-process.pid, "SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
  }
  clearTimeout(killTimer);
  killTimer = setTimeout(() => {
    try { process.kill(-process.pid, "SIGKILL"); } catch { /* already gone */ }
  }, 1000);
  killTimer.unref();
}

if (watch) {
  const ownerStream = createReadStream("", { fd: 3, autoClose: true });
  owner = ownerStream;
  let control = "";
  ownerStream.on("data", (chunk) => {
    control += chunk.toString("utf8");
    if (!control.includes("release")) return;
    released = true;
    clearTimeout(killTimer);
    ownerStream.destroy();
  });
  ownerStream.on("end", () => { if (!released) terminateGroup(); });
  ownerStream.on("error", () => { if (!released) terminateGroup(); });
}

/** @param {import("node:fs").WriteStream} stream */
function closeStream(stream) {
  return new Promise((resolve) => stream.end(resolve));
}

let outcome;
const outcomePromise = new Promise((resolve) => {
  child.once("error", (error) => resolve({ exitCode: null, signal: null, error: String(error) }));
  child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
});
child.once("error", () => undefined);
outcome = await outcomePromise;
settled = true;
clearTimeout(killTimer);
owner?.destroy();
await Promise.all([closeStream(stdout), closeStream(stderr), closeStream(combined)]);
writeJsonAtomic("exit.json", {
  exitCode: outcome.exitCode,
  signal: outcome.signal,
  endedAt: Date.now(),
  ...(outcome.error ? { error: outcome.error } : {}),
});
// A signal watcher used by the owner-loss protocol must never leave a live
// supervisor behind after its durable outcome is sealed.
process.kill(process.pid, "SIGKILL");
