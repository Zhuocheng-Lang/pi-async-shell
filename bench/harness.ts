/**
 * Benchmark harness.
 *
 * Both extensions are loaded into one real Pi SDK session, so every call goes
 * through the same extension loader, tool wrapper and context. The tools are
 * then invoked directly, which removes model latency from the measurement while
 * keeping the code path that a model would actually reach.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  wrapRegisteredTool,
} from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
// Extensions that render tool output through Pi's interactive theme throw
// "Theme not initialized" in a headless SDK session. A real Pi session always
// initializes it, so the benchmark does the same rather than scoring the
// extension for a missing TUI.
// Pi's interactive theme lives outside the package's exports map, so it is
// imported by absolute URL rather than by specifier.
const THEME_MODULE = new URL(
  "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js",
  import.meta.url,
).href;

let themeReady = false;
async function ensureTheme(): Promise<void> {
  if (themeReady) return;
  const module = (await import(THEME_MODULE)) as { initTheme: (name: string) => void };
  module.initTheme("dark");
  themeReady = true;
}

export const ASYNC_SHELL_EXTENSION = new URL("../src/extension.ts", import.meta.url).pathname;
export const BACKGROUND_TASKS_EXTENSION =
  "/home/ckbc/.pi/agent/npm/node_modules/pi-background-tasks/dist/extensions/background-tasks.js";

export interface ToolCallResult {
  text: string;
  ms: number;
  structured?: unknown;
  details?: unknown;
}

export interface BenchSession {
  cwd: string;
  callTool(name: string, params: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<ToolCallResult>;
  messages(): { customType?: string; content?: unknown }[];
  waitForCustomType(customType: string, timeoutMs: number): Promise<{ content: string; at: number } | undefined>;
  toolNames(): string[];
  /** Registered tool names with their JSON parameter schemas, for capability probes. */
  toolSchemas(): { name: string; parameters?: unknown }[];
  /**
   * Drive one real model turn: agent_start, a scripted assistant reply, then
   * agent_settled. Scenarios use this when the question is what happens at a
   * turn boundary, not what one tool call costs.
   */
  runTurn(text: string): Promise<void>;
  dispose(): void;
}

interface SessionOptions {
  cwd?: string;
  /** Load only the requested extension, so each implementation is measured alone. Omitted for the bare-host baseline. */
  extension?: string;
}

export async function createBenchSession(options: SessionOptions): Promise<BenchSession> {
  const cwd = options.cwd ?? mkdtempSync(join(tmpdir(), "pas-bench-"));
  await ensureTheme();
  const agentDir = mkdtempSync(join(tmpdir(), "pas-bench-agent-"));
  writeFileSync(join(agentDir, "auth.json"), "{}");

  const faux = createFauxCore({ models: [{ id: "faux-1", contextWindow: 128000, maxTokens: 4096 }] });
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json") });
  modelRuntime.registerProvider("faux", {
    apiKey: "bench-key",
    baseUrl: "http://localhost:0",
    api: faux.api,
    models: [
      {
        type: "chat",
        id: "faux-1",
        name: "Faux Model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
    streamSimple: faux.streamSimple,
  });
  await modelRuntime.setRuntimeApiKey("faux", "bench-key");

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    additionalExtensionPaths: options.extension ? [options.extension] : [],
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    resourceLoader,
    sessionManager: SessionManager.inMemory(),
    model: faux.getModel(),
    thinkingLevel: "off",
  });
  await session.bindExtensions({});

  const runner = (session as unknown as { _extensionRunner: any })._extensionRunner;
  const registered = runner.getAllRegisteredTools() as { definition: { name: string } }[];
  const wrapped = new Map<string, { execute: (...args: unknown[]) => Promise<any> }>();
  for (const tool of registered) {
    wrapped.set(tool.definition.name, wrapRegisteredTool(tool as never, runner) as never);
  }

  return {
    cwd,
    async callTool(name, params, options = {}) {
      const tool = wrapped.get(name);
      if (!tool) throw new Error(`tool not registered: ${name}`);
      const started = performance.now();
      const call = tool.execute(`bench-${name}-${Math.random().toString(36).slice(2)}`, params, undefined, undefined);
      // A tool that never returns is a result, not a reason to hang the run.
      const result =
        options.timeoutMs === undefined
          ? await call
          : await Promise.race([
              call,
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`tool call timed out after ${options.timeoutMs} ms`)), options.timeoutMs),
              ),
            ]);
      const ms = performance.now() - started;
      const text = (result?.content ?? [])
        .map((block: { type?: string; text?: string }) => (block.type === "text" ? block.text ?? "" : ""))
        .join("\n");
      return { text, ms, structured: result?.structuredContent, details: result?.details };
    },
    messages() {
      return session.messages as unknown as { customType?: string; content?: unknown }[];
    },
    async waitForCustomType(customType, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = (session.messages as unknown as { customType?: string; content?: unknown }[]).find(
          (message) => message.customType === customType,
        );
        if (found) {
          return { content: JSON.stringify(found.content ?? ""), at: Date.now() };
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return undefined;
    },
    toolNames() {
      return [...wrapped.keys()];
    },
    toolSchemas() {
      return registered.map((tool) => ({
        name: tool.definition.name,
        parameters: (tool.definition as { parameters?: unknown }).parameters,
      }));
    },
    async runTurn(text) {
      faux.setResponses([fauxAssistantMessage("acknowledged")]);
      await session.prompt(text);
    },
    dispose() {
      session.dispose();
    },
  };
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index]!;
}
