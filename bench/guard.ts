/**
 * Process-level guard for the benchmark.
 *
 * At least one extension under test (pi-background) delivers its completion
 * notification from a stream callback that runs after the session was disposed,
 * and Pi's loader throws on a stale extension context. In a real Pi session that
 * window is closed by the shutdown order; in a benchmark that creates and
 * disposes a session per implementation it is reachable. The crash is recorded
 * as an observation rather than allowed to end the run.
 */
export interface Incident {
  kind: "uncaughtException" | "unhandledRejection";
  message: string;
  at: number;
}

const incidents: Incident[] = [];
let installed = false;

export function installGuard(): void {
  if (installed) return;
  installed = true;
  process.on("uncaughtException", (error) => {
    incidents.push({ kind: "uncaughtException", message: String(error).slice(0, 400), at: Date.now() });
    console.error("[bench-guard] uncaughtException: " + String(error).slice(0, 200));
  });
  process.on("unhandledRejection", (reason) => {
    incidents.push({ kind: "unhandledRejection", message: String(reason).slice(0, 400), at: Date.now() });
    console.error("[bench-guard] unhandledRejection: " + String(reason).slice(0, 200));
  });
}

export function takeIncidents(): Incident[] {
  return incidents.splice(0, incidents.length);
}

export function incidentCount(): number {
  return incidents.length;
}
