// Persistent event tally for the weekly summary and the auto-diagnosis daily
// cap. Append-only JSON on the /data volume, pruned to 35 days.

import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../env.js";

export type EventKind =
  | "uptime_down"
  | "uptime_recover"
  | "sentry_alert"
  | "ci_fail"
  | "pr_opened"
  | "pr_merged"
  | "vercel_fail"
  | "vercel_deploy"
  | "diag";

export interface EventRecord {
  t: number;
  kind: EventKind;
  project?: string;
}

const FILE = path.resolve(env.WORK_DIR, "..", "events.json");
const PRUNE_MS = 35 * 86_400_000;

let events: EventRecord[] | null = null;

function load(): EventRecord[] {
  if (events) return events;
  try {
    events = existsSync(FILE) ? (JSON.parse(readFileSync(FILE, "utf8")) as EventRecord[]) : [];
    if (!Array.isArray(events)) events = [];
  } catch {
    events = [];
  }
  return events;
}

async function persist(): Promise<void> {
  try {
    await mkdir(path.dirname(FILE), { recursive: true });
    const tmp = FILE + ".tmp";
    await writeFile(tmp, JSON.stringify(events ?? []));
    await rename(tmp, FILE);
  } catch (err) {
    console.warn("[stats] persist failed:", err);
  }
}

export function recordEvent(kind: EventKind, project?: string): void {
  const list = load();
  const now = Date.now();
  list.push({ t: now, kind, ...(project ? { project } : {}) });
  const cutoff = now - PRUNE_MS;
  events = list.filter((e) => e.t >= cutoff);
  void persist();
}

export function eventsSince(ms: number): EventRecord[] {
  const cutoff = Date.now() - ms;
  return load().filter((e) => e.t >= cutoff);
}

/** KST-day count of a kind — used by the auto-diagnosis daily cap. */
export function countTodayKst(kind: EventKind): number {
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  return load().filter(
    (e) =>
      e.kind === kind &&
      new Date(e.t + 9 * 3600_000).toISOString().slice(0, 10) === today,
  ).length;
}
