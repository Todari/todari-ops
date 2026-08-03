import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../env.js";
import { nextSchedule, type Grade } from "./srs.js";

export interface JpCard {
  id: number; front: string; reading: string; meaning: string;
  example: string; exampleKo: string; note: string; kind: string; source: string;
  intervalDays: number; ease: number; dueAt: string; reps: number; lapses: number; createdAt: string;
}
export interface JpMistake { original: string; corrected: string; reason: string; createdAt: string; }
interface JpData { nextId: number; cards: JpCard[]; dailyLog: Record<string, number>; mistakes: JpMistake[]; }

const FILE = path.join(env.WORK_DIR, "jp.json");
let data: JpData = load();

function load(): JpData {
  const empty: JpData = { nextId: 1, cards: [], dailyLog: {}, mistakes: [] };
  try {
    if (!existsSync(FILE)) return empty;
    const raw = JSON.parse(readFileSync(FILE, "utf8"));
    return {
      nextId: typeof raw.nextId === "number" ? raw.nextId : 1,
      cards: Array.isArray(raw.cards) ? raw.cards : [],
      dailyLog: raw.dailyLog && typeof raw.dailyLog === "object" ? raw.dailyLog : {},
      mistakes: Array.isArray(raw.mistakes) ? raw.mistakes : [],
    };
  } catch (err) { console.warn("[jp] load failed:", err); return empty; }
}

async function persist(): Promise<void> {
  try {
    await mkdir(path.dirname(FILE), { recursive: true });
    const tmp = FILE + ".tmp";
    await writeFile(tmp, JSON.stringify(data, null, 2));
    await rename(tmp, FILE);
  } catch (err) { console.warn("[jp] persist failed:", err); }
}

export async function insertCard(c: {
  front: string; reading: string; meaning: string; example: string;
  exampleKo: string; note: string; kind: string; source: string; dueAt: Date;
}): Promise<number> {
  const id = data.nextId++;
  data.cards.push({
    id, front: c.front, reading: c.reading, meaning: c.meaning, example: c.example,
    exampleKo: c.exampleKo, note: c.note, kind: c.kind, source: c.source,
    intervalDays: 0, ease: 2.3, dueAt: c.dueAt.toISOString(), reps: 0, lapses: 0,
    createdAt: new Date().toISOString(),
  });
  await persist();
  return id;
}

export async function dueCards(now: Date, limit: number): Promise<JpCard[]> {
  return data.cards
    .filter((c) => new Date(c.dueAt) <= now)
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
    .slice(0, limit);
}

export async function gradeCard(id: number, grade: Grade, now: Date): Promise<void> {
  const c = data.cards.find((x) => x.id === id);
  if (!c) return;
  const n = nextSchedule(
    { intervalDays: c.intervalDays, ease: c.ease, reps: c.reps, lapses: c.lapses }, grade, now);
  c.intervalDays = n.intervalDays; c.ease = n.ease; c.reps = n.reps;
  c.lapses = n.lapses; c.dueAt = n.dueAt.toISOString();
  await persist();
}

export async function recentDailyFronts(days: number): Promise<string[]> {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  return Object.entries(data.dailyLog)
    .filter(([d]) => d >= cutoff)
    .map(([, id]) => data.cards.find((c) => c.id === id)?.front)
    .filter((f): f is string => Boolean(f));
}

export async function logDaily(date: string, cardId: number): Promise<void> {
  data.dailyLog[date] = cardId;
  await persist();
}

export async function insertMistake(m: { original: string; corrected: string; reason: string }): Promise<void> {
  data.mistakes.push({ ...m, createdAt: new Date().toISOString() });
  await persist();
}

export function allCards(): JpCard[] { return data.cards; }
export function allMistakes(): JpMistake[] { return data.mistakes; }
export function stats(now: Date): { total: number; due: number; learned7d: number } {
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  return {
    total: data.cards.length,
    due: data.cards.filter((c) => new Date(c.dueAt) <= now).length,
    learned7d: data.cards.filter((c) => new Date(c.createdAt) >= weekAgo).length,
  };
}
