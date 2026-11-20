// Vault-derived task/deadline snapshot. Mac-side cron(vault_sync.py)이
// POST /webhook/vault-sync로 전체 상태를 갱신하고, 봇이 직접 추가·완료한 태스크는
// 다음 snapshot 전까지 이 파일에도 즉시 낙관적으로 반영한다.

import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../env.js";
import { normalizeTaskText } from "./editor.js";
import { normalizeHostOperations, type HostOperations } from "./operations.js";
import { getVaultRemoteRevision } from "./repo.js";

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
  /** Last verified Mac snapshot. Legacy files cannot distinguish its time from a bot edit. */
  generatedAt: string | null;
  sourceRevision?: string;
  localMutationAt?: string;
  operations?: HostOperations[];
  notes: VaultNote[];
}

interface VaultSnapshot {
  generatedAt: string;
  sourceRevision: string;
  operations?: HostOperations;
  notes: VaultNote[];
}

const FILE = path.resolve(env.WORK_DIR, "..", "vault-state.json");

let cached: VaultState | null = null;
let loadedFromDisk = false;
let pendingWrites: Promise<unknown> = Promise.resolve();

export function getVaultState(): VaultState | null {
  if (!cached && !loadedFromDisk) {
    loadedFromDisk = true;
    try {
      if (existsSync(FILE)) {
        const state = JSON.parse(readFileSync(FILE, "utf8")) as VaultState | null;
        if (state && Array.isArray(state.notes)) {
          cached = {
            ...state,
            generatedAt: validRevision(state.sourceRevision) ? normalizeTimestamp(state.generatedAt) : null,
          };
        }
      }
    } catch (err) {
      console.warn("[vault-sync] failed to load state file:", err);
    }
  }
  return cached;
}

function enqueueWrite<T>(write: () => Promise<T>): Promise<T> {
  const result = pendingWrites.then(write);
  pendingWrites = result.catch(() => undefined);
  return result;
}

async function persist(state: VaultState): Promise<void> {
  await mkdir(path.dirname(FILE), { recursive: true });
  const tmp = FILE + ".tmp";
  await writeFile(tmp, JSON.stringify(state, null, 2), { flush: true });
  await rename(tmp, FILE);
  cached = state;
  loadedFromDisk = true;
}

export function saveVaultSnapshot(snapshot: VaultSnapshot): Promise<"stored" | "stale" | "outdated-revision"> {
  return enqueueWrite(async () => {
    const current = getVaultState();
    if (current?.generatedAt && snapshot.generatedAt <= current.generatedAt) return "stale";
    if (snapshot.sourceRevision !== await getVaultRemoteRevision()) return "outdated-revision";

    const { operations, ...state } = snapshot;
    const hosts = current?.operations ?? [];
    await persist({
      ...state,
      localMutationAt: current?.localMutationAt,
      operations: operations ? [operations, ...hosts.filter((host) => host.hostname !== operations.hostname)].slice(0, 4) : hosts,
    });
    return "stored";
  });
}

/** Reflect an EC2-side vault commit immediately, before the next Mac snapshot. */
export async function addCapturedVaultTask(
  note: string,
  slug: string,
  rawText: string,
): Promise<void> {
  const text = normalizeTaskText(rawText).slice(0, 300);
  if (!text) return;
  await enqueueWrite(async () => {
    const current = getVaultState() ?? { generatedAt: null, notes: [] };
    const notes = [...current.notes];
    const index = notes.findIndex((entry) => entry.slug === slug || entry.note === note);
    const target = notes[index] ?? { note, slug, tasks: [], deadlines: [] };
    if (target.tasks.some((task) => task.text === text)) return;
    const dueMatch = rawText.match(/📅\s*(\d{4}-\d{2}-\d{2})/);
    const task = {
      text,
      ...(dueMatch?.[1] ? { due: dueMatch[1] } : {}),
    };
    notes[index < 0 ? notes.length : index] = { ...target, tasks: [task, ...target.tasks] };
    await persist({ ...current, localMutationAt: new Date().toISOString(), notes });
  });
}

export async function completeCapturedVaultTask(
  note: string,
  slug: string,
  rawText: string,
): Promise<void> {
  const text = normalizeTaskText(rawText);
  await rewriteCapturedTasks(note, slug, (tasks) => tasks.filter((task) => task.text !== text));
}

/** 봇이 볼트의 할 일 줄에 적은 마감일을 다음 snapshot 전까지 반영한다. */
export async function setCapturedVaultTaskDue(
  note: string,
  slug: string,
  rawText: string,
  due: string,
): Promise<void> {
  const text = normalizeTaskText(rawText);
  await rewriteCapturedTasks(note, slug, (tasks) =>
    tasks.map((task) => (task.text === text && task.due !== due ? { ...task, due } : task)),
  );
}

async function rewriteCapturedTasks(
  note: string,
  slug: string,
  rewrite: (tasks: VaultTask[]) => VaultTask[],
): Promise<void> {
  await enqueueWrite(async () => {
    const state = getVaultState();
    if (!state) return;
    const notes = state.notes.map((entry) => {
      if (entry.slug !== slug && entry.note !== note) return entry;
      const tasks = rewrite(entry.tasks);
      if (tasks.length === entry.tasks.length && tasks.every((task, index) => task === entry.tasks[index])) return entry;
      return { ...entry, tasks };
    });
    if (notes.every((note, index) => note === state.notes[index])) return;
    await persist({ ...state, localMutationAt: new Date().toISOString(), notes });
  });
}

/** Bound + strip an incoming payload so a bad sync can't blow up embeds. */
export function normalizeVaultState(raw: unknown): VaultSnapshot | null {
  const r = raw as Partial<VaultSnapshot> | null;
  if (!r || !validRevision(r.sourceRevision) || !Array.isArray(r.notes)) return null;
  const generatedAt = normalizeTimestamp(r.generatedAt);
  if (!generatedAt || Date.parse(generatedAt) > Date.now() + 5 * 60_000) return null;
  const clip = (s: unknown, n: number) => typeof s === "string" ? s.slice(0, n).trim() : "";
  const notes: VaultNote[] = [];
  for (const n of r.notes.slice(0, 50)) {
    if (!n || typeof n !== "object") continue;
    const note = clip((n as VaultNote).note, 80);
    if (!note) continue;
    const slugRaw = clip((n as VaultNote).slug, 80);
    const tasks = (Array.isArray((n as VaultNote).tasks) ? (n as VaultNote).tasks : [])
      .slice(0, 50)
      .map((t) => ({
        text: clip(t?.text, 300),
        ...(isIsoDate(t?.due) ? { due: t.due } : {}),
      }))
      .filter((t) => t.text);
    const deadlines = (Array.isArray((n as VaultNote).deadlines) ? (n as VaultNote).deadlines : [])
      .slice(0, 30)
      .flatMap((d) => {
        const text = clip(d?.text, 300);
        return text && isIsoDate(d?.date) ? [{ text, date: d.date }] : [];
      });
    notes.push({ note, ...(slugRaw ? { slug: slugRaw } : {}), tasks, deadlines });
  }
  return {
    generatedAt, sourceRevision: r.sourceRevision, notes,
    operations: normalizeHostOperations(r.operations, generatedAt),
  };
}

function validRevision(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value);
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  const canonical = new Date(time).toISOString();
  return canonical === value || canonical.replace(".000Z", "Z") === value ? canonical : null;
}

function isIsoDate(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/** Today in KST (fixed UTC+9, no DST) as YYYY-MM-DD. */
export function todayKst(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

/** date(YYYY-MM-DD)에서 days 일 뒤의 날짜. 음수면 그만큼 앞의 날짜. */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
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

export function vaultAgeHours(state: VaultState | null): number | null {
  const t = Date.parse(state?.generatedAt ?? "");
  return Number.isFinite(t) ? Math.max(0, (Date.now() - t) / 3600_000) : null;
}

export function vaultSyncSummary(state: VaultState | null): string {
  const age = vaultAgeHours(state);
  const revision = state?.sourceRevision ? ` · ${state.sourceRevision.slice(0, 8)}` : "";
  const snapshot = age === null
    ? "⚪ 볼트 동기화 미수신"
    : `${age > 36 ? "⚠️ " : ""}볼트 동기화 ${Math.round(age)}시간 전${revision}`;
  const edit = Date.parse(state?.localMutationAt ?? "");
  return Number.isFinite(edit) ? `${snapshot} · 봇 할 일 반영 ${Math.round(Math.max(0, Date.now() - edit) / 3600_000)}시간 전` : snapshot;
}
