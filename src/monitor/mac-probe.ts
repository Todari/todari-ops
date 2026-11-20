import path from "node:path";
import { env } from "../env.js";
import { readJsonFile, writeJsonFile } from "../storage/json-file.js";

const FILE = path.resolve(env.WORK_DIR, "..", "mac-probe.json");
const STALE_AFTER = 30 * 60_000 + 30_000;
const GITHUB_STALE_AFTER = 90 * 60_000;

interface MacProbeReceipt {
  checkedAt: string;
  healthy: boolean;
  githubLastStartedAt?: string | null;
}

function isTimestamp(value: unknown, now: number): value is string {
  if (typeof value !== "string" || value.length !== 24) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && time <= now + 60_000 && new Date(time).toISOString() === value;
}

function missingProbe(status: "unknown" | "stale") {
  return { status, checkedAt: null, healthy: null, githubMonitor: { status: "unknown", lastStartedAt: null } };
}

export function macProbeHealth(now = Date.now()) {
  let receipt: unknown;
  try {
    receipt = readJsonFile(FILE, undefined);
  } catch {
    return missingProbe("stale");
  }
  if (receipt === undefined) return missingProbe("unknown");
  const { checkedAt, healthy, githubLastStartedAt } = (receipt ?? {}) as Partial<MacProbeReceipt>;
  if (!isTimestamp(checkedAt, now) || typeof healthy !== "boolean") return missingProbe("stale");
  const known = isTimestamp(githubLastStartedAt, Date.parse(checkedAt));
  return {
    status: now - Date.parse(checkedAt) > STALE_AFTER ? "stale" : "fresh",
    checkedAt, healthy,
    githubMonitor: {
      status: known ? now - Date.parse(githubLastStartedAt) > GITHUB_STALE_AFTER ? "stale" : "fresh" : "unknown",
      lastStartedAt: known ? githubLastStartedAt : null,
    },
  };
}

export function receiveMacProbe(raw: unknown, now = Date.now()): boolean {
  const { checkedAt, healthy, githubLastStartedAt } = (raw ?? {}) as Partial<MacProbeReceipt>;
  if (!isTimestamp(checkedAt, now) || typeof healthy !== "boolean" || now - Date.parse(checkedAt) > STALE_AFTER ||
      (githubLastStartedAt != null && !isTimestamp(githubLastStartedAt, Date.parse(checkedAt)))) return false;

  const current = macProbeHealth(now);
  if (typeof current.checkedAt !== "string" || checkedAt > current.checkedAt) {
    writeJsonFile(FILE, { checkedAt, healthy, githubLastStartedAt });
  }
  return true;
}
