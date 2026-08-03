import { randomUUID } from "node:crypto";

// Generic "click a button on an alert → start a /code session" store.
// Sentry/Vercel/GitHub handlers put an action here at alert time; the
// `triage:start:<id>` button in handlers/button.ts consumes it. In-memory
// with TTL — same v0 tradeoff as sessions (alert can be re-triggered).
export interface PendingAction {
  projectSlug: string;
  threadName: string;
  prompt: string;
  createdAt: number;
  ttlMs: number;
}

const store = new Map<string, PendingAction>();
const DEFAULT_TTL_MS = 30 * 60 * 1000;

export function putPendingAction(
  action: Omit<PendingAction, "createdAt" | "ttlMs">,
  ttlMs = DEFAULT_TTL_MS,
): string {
  prune();
  const id = randomUUID().slice(0, 8);
  store.set(id, { ...action, createdAt: Date.now(), ttlMs });
  return id;
}

export function getPendingAction(id: string): PendingAction | undefined {
  prune();
  return store.get(id);
}

export function deletePendingAction(id: string): void {
  store.delete(id);
}

function prune(now = Date.now()): void {
  for (const [k, v] of store) {
    if (now - v.createdAt > v.ttlMs) store.delete(k);
  }
}
