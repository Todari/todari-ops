// Vault-derived task/deadline state, pushed by the Mac-side cron
// (workspace-harness vault_sync.py) via POST /webhook/vault-sync. The full
// vault never leaves the Mac — only open tasks and dated items land here.

import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../env.js";

export interface VaultTask {
  text: string;
  /** YYYY-MM-DD (KST) when the task line carries a 📅 marker. */
  due?: string;
}

export interface VaultNote {
  /** Vault note basename, e.g. "lvti", "이정표". */
  note: string;
  /** Catalog slug when the note maps to a /code project. */
  slug?: string;
  tasks: VaultTask[];
  deadlines: Array<{ text: string; date: string }>;
}

export interface VaultState {
  generatedAt: string;
  notes: VaultNote[];
}

const FILE = path.resolve(env.WORK_DIR, "..", "vault-state.json");

let cached: VaultState | null = null;
let loadedFromDisk = false;

export function getVaultState(): VaultState | null {
  if (!cached && !loadedFromDisk) {
    loadedFromDisk = true;
    try {
      if (existsSync(FILE)) {
        cached = JSON.parse(readFileSync(FILE, "utf8")) as VaultState;
      }
    } catch (err) {
      console.warn("[vault-sync] failed to load state file:", err);
    }
  }
  return cached;
}

export async function saveVaultState(state: VaultState): Promise<void> {
  cached = state;
  loadedFromDisk = true;
  await mkdir(path.dirname(FILE), { recursive: true });
  const tmp = FILE + ".tmp";
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, FILE);
}

/** Bound + strip an incoming payload so a bad sync can't blow up embeds. */
export function normalizeVaultState(raw: unknown): VaultState | null {
  const r = raw as Partial<VaultState> | null;
  if (!r || typeof r.generatedAt !== "string" || !Array.isArray(r.notes)) return null;
  const clip = (s: unknown, n: number) => String(s ?? "").slice(0, n).trim();
  const notes: VaultNote[] = [];
  for (const n of r.notes.slice(0, 50)) {
    const note = clip((n as VaultNote).note, 80);
    if (!note) continue;
    const slugRaw = clip((n as VaultNote).slug, 80);
    const tasks = (Array.isArray((n as VaultNote).tasks) ? (n as VaultNote).tasks : [])
      .slice(0, 50)
      .map((t) => ({
        text: clip(t?.text, 300),
        ...(isIsoDate(String(t?.due ?? "")) ? { due: String(t!.due) } : {}),
      }))
      .filter((t) => t.text);
    const deadlines = (Array.isArray((n as VaultNote).deadlines) ? (n as VaultNote).deadlines : [])
      .slice(0, 30)
      .map((d) => ({ text: clip(d?.text, 300), date: String(d?.date ?? "") }))
      .filter((d) => d.text && isIsoDate(d.date));
    notes.push({ note, ...(slugRaw ? { slug: slugRaw } : {}), tasks, deadlines });
  }
  return { generatedAt: r.generatedAt, notes };
}

function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/** Today in KST (fixed UTC+9, no DST) as YYYY-MM-DD. */
export function todayKst(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

/** Days from today (KST) to date: negative = past, 0 = today. */
export function daysUntil(date: string): number {
  const a = Date.parse(todayKst() + "T00:00:00Z");
  const b = Date.parse(date + "T00:00:00Z");
  return Math.round((b - a) / 86_400_000);
}

export function ddayLabel(d: number): string {
  if (d === 0) return "D-DAY";
  return d > 0 ? `D-${d}` : `D+${-d}`;
}

export interface UpcomingDeadline {
  note: string;
  text: string;
  date: string;
  d: number;
}

/** Deadlines (dated tasks included) within [-pastDays, +futureDays], soonest first. */
export function collectDeadlines(
  state: VaultState,
  pastDays: number,
  futureDays: number,
): UpcomingDeadline[] {
  const out: UpcomingDeadline[] = [];
  for (const n of state.notes) {
    for (const dl of n.deadlines) {
      out.push({ note: n.note, text: dl.text, date: dl.date, d: daysUntil(dl.date) });
    }
    for (const t of n.tasks) {
      if (t.due) out.push({ note: n.note, text: t.text, date: t.due, d: daysUntil(t.due) });
    }
  }
  return out
    .filter((x) => x.d >= -pastDays && x.d <= futureDays)
    .sort((a, b) => a.d - b.d);
}

export function vaultAgeHours(state: VaultState): number {
  const t = Date.parse(state.generatedAt);
  if (Number.isNaN(t)) return Infinity;
  return (Date.now() - t) / 3600_000;
}
