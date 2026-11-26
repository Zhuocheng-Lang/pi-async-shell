// SPDX-FileCopyrightText: 2026 Zhuocheng-Lang
// SPDX-License-Identifier: MPL-2.0

/**
 * Every string a person or a model reads back: one handle, one outcome, one
 * completion message.
 *
 * This module imports types and nothing else. That is the point of it: wording
 * is the most frequently edited thing in the package, and keeping it below the
 * registry in the import graph means a change here cannot reach the state
 * machine, the spawn recipes or the host wiring.
 */

import type {
  CompletionRecord,
  ShellHandle,
  ShellReadParams,
  ShellReadResult,
  ShellSendResult,
} from "./core/types.ts";

/**
 * The one method an outcome excerpt needs from the registry. Naming it here is
 * what lets the formatter stay a leaf instead of importing `registry.ts`.
 */
export interface LogReader {
  read(params: ShellReadParams, signal?: AbortSignal): Promise<ShellReadResult>;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

export function describeHandle(handle: ShellHandle): string {
  const parts = [handle.id, `"${handle.name}"`, handle.status];
  if (handle.exitCode !== undefined && handle.exitCode !== null) parts.push(`exit ${handle.exitCode}`);
  if (handle.signal) parts.push(`signal ${handle.signal}`);
  if (handle.endedAt) parts.push(formatDuration(handle.endedAt - handle.startedAt));
  else parts.push(`${formatDuration(Date.now() - handle.startedAt)} so far`);
  parts.push(`scope ${handle.scope}`, `binding ${handle.binding}`);
  if (handle.readyAt) parts.push("ready");
  parts.push(`${formatBytes(handle.bytes.combined)} logged`);
  if (handle.bytes.capReached) parts.push("log cap reached");
  if (handle.error) parts.push(`error: ${handle.error}`);
  if (handle.exitSource === "pipefail") parts.push("pipeline status: pipefail");
  else if (handle.exitSource === "last-command") parts.push("pipeline status: last stage only");
  return parts.join(" · ");
}

/** A bounded, human-readable excerpt of the log for an outcome message. */
export function outcomeExcerpt(text: string | undefined, failed: boolean): string[] {
  const lines = (text ?? "")
    .split("\n")
    .map((line) => line.replace(/\s+$/, "").slice(0, 500))
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];
  const tail = lines.slice(-10);
  const tailBlock = ["  --- tail ---", ...tail.map((line) => `  ${line}`)];
  if (!failed) return tailBlock;
  const errorIndex = lines.findIndex((line) => /error|fail|fatal|exception|panic|Traceback/i.test(line));
  if (errorIndex < 0) return tailBlock;
  const from = Math.max(0, errorIndex - 2);
  const to = Math.min(lines.length, errorIndex + 8);
  const block = ["  --- first error ---", ...lines.slice(from, to).map((line) => `  ${line}`)];
  const tailFrom = Math.max(to, lines.length - 6);
  if (tailFrom < lines.length) {
    block.push("  --- tail ---", ...lines.slice(tailFrom).map((line) => `  ${line}`));
  }
  return block;
}

/** Completion and await messages carry the outcome, not just a log path. */
export async function readOutcomeExcerpt(
  registry: LogReader | undefined,
  id: string,
  status: ShellHandle["status"],
  lines = 20,
): Promise<string[]> {
  if (!registry) return [];
  try {
    const read = await registry.read({ id, mode: "tail", lines, stream: "combined" });
    return outcomeExcerpt(read.text, status === "failed" || status === "timed-out");
  } catch {
    return [];
  }
}

/**
 * `wrote: false` means the bytes did not reach the child: either the stdin FIFO
 * has no reader yet, or this request id already sent once.
 */
export function sendHeadline(result: ShellSendResult): string {
  if (result.wrote) return `Sent to ${result.id}`;
  return `Nothing written to ${result.id} (no reader on its stdin, or this request was already sent)`;
}

/** A start result is a handle; a settled one also carries its output. */
export function startText(
  handle: ShellHandle,
  inlineSettleMs: number | undefined,
  preview: string | undefined,
  note?: string,
): string {
  const lines = [`Started ${describeHandle(handle)}`];
  if (note) lines.push(`  note: ${note}`);
  if (inlineSettleMs !== undefined) {
    lines.push(
      `Settled inside the ${formatDuration(inlineSettleMs)} inline window, so the result is here and no shell_await is needed.`,
    );
    lines.push(...outcomeExcerpt(preview, handle.status === "failed" || handle.status === "timed-out"));
  }
  lines.push(`log: ${handle.log.combined}`);
  return lines.join("\n");
}

export async function completionMessage(
  records: CompletionRecord[],
  registry: LogReader | undefined,
): Promise<string> {
  const lines = ["<async-shell-completion>"];
  for (const record of records) {
    const outcome =
      record.status === "completed"
        ? "completed"
        : record.status === "cancelled"
          ? "cancelled"
          : record.status === "timed-out"
            ? "timed out"
            : record.status === "lost"
              ? "lost (liveness could not be proven)"
              : `failed${record.exitCode !== null && record.exitCode !== undefined ? ` (exit ${record.exitCode})` : ""}`;
    lines.push(
      `${record.id} "${record.name}" ${outcome} after ${formatDuration(record.durationMs)} · scope ${record.scope} · binding ${record.binding}`,
    );
    if (record.error) lines.push(`  error: ${record.error}`);
    if (record.exitSource === "pipefail") lines.push("  pipeline status: pipefail (any stage failure fails the command)");
    else if (record.exitSource === "last-command") lines.push("  pipeline status: last stage only (shell has no pipefail)");
    lines.push(`  exit: ${record.exitCode ?? "unknown"}`);
    if (record.signal) lines.push(`  signal: ${record.signal}`);
    lines.push(...(await readOutcomeExcerpt(registry, record.id, record.status)));
    lines.push(`  log: ${record.log.combined} (${formatBytes(record.bytes.combined)})`);
  }
  lines.push("Read output with shell_read; do not re-run a command that already completed.");
  lines.push("</async-shell-completion>");
  return lines.join("\n");
}
