// SPDX-FileCopyrightText: 2026 Zhuocheng-Lang
// SPDX-License-Identifier: MPL-2.0

/**
 * Same-process `/reload` handoff.
 *
 * The extension is reloaded, but the child processes are not. A process-global
 * slot carries the live registry across the reload, keyed by
 * `(pid, sessionId, realpath(cwd))` with a claim deadline. A fresh activation
 * that never claims the slot lets it expire, and the handles then follow the
 * normal cancellation ladder rather than staying unowned.
 */
const HUB_SYMBOL = Symbol.for("pi-async-shell.reload-hub.v1");

export interface HandoffSlot {
  key: string;
  payload: unknown;
  deadline: number;
  timer?: NodeJS.Timeout;
}

interface Hub {
  slots: Map<string, HandoffSlot>;
}

function hub(): Hub {
  const globalObject = globalThis as unknown as Record<symbol, Hub | undefined>;
  let existing = globalObject[HUB_SYMBOL];
  if (!existing) {
    existing = { slots: new Map() };
    globalObject[HUB_SYMBOL] = existing;
  }
  return existing;
}

export function handoffKey(pid: number, sessionId: string, cwd: string): string {
  return `${pid}|${sessionId}|${cwd}`;
}

export function publishHandoff(
  key: string,
  payload: unknown,
  ttlMs: number,
  onExpire: () => void,
): void {
  const slots = hub().slots;
  const previous = slots.get(key);
  if (previous?.timer) clearTimeout(previous.timer);
  const slot: HandoffSlot = { key, payload, deadline: Date.now() + ttlMs };
  slot.timer = setTimeout(() => {
    const current = slots.get(key);
    if (current === slot) {
      slots.delete(key);
      onExpire();
    }
  }, ttlMs);
  slot.timer.unref?.();
  slots.set(key, slot);
}

export function claimHandoff<T>(key: string): T | undefined {
  const slots = hub().slots;
  const slot = slots.get(key);
  if (!slot) return undefined;
  if (slot.deadline < Date.now()) {
    if (slot.timer) clearTimeout(slot.timer);
    slots.delete(key);
    return undefined;
  }
  if (slot.timer) clearTimeout(slot.timer);
  slots.delete(key);
  return slot.payload as T;
}

export function discardHandoff(key: string): void {
  const slots = hub().slots;
  const slot = slots.get(key);
  if (!slot) return;
  if (slot.timer) clearTimeout(slot.timer);
  slots.delete(key);
}

export function handoffCount(): number {
  return hub().slots.size;
}
