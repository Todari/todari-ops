import { ChannelType } from "discord.js";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { env } from "../env.js";
import { getDiscordClient } from "../discord/client.js";

// /remind 30m|2h|1d|HH:MM <내용> — 일회성 리마인더. /data 볼륨의 JSON 에
// 영속화해 재시작에도 살아남고, 발화 시 커맨드를 친 채널에 멘션으로 알린다.

interface Reminder {
  id: string;
  channelId: string;
  content: string;
  fireAt: number;
}

const FILE = path.resolve(env.WORK_DIR, "..", "reminders.json");
const MAX_DELAY_MS = 20 * 86_400_000;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

let reminders: Reminder[] = [];

export function startReminders(): void {
  try {
    reminders = existsSync(FILE)
      ? (JSON.parse(readFileSync(FILE, "utf8")) as Reminder[])
      : [];
    if (!Array.isArray(reminders)) reminders = [];
  } catch {
    reminders = [];
  }
  const now = Date.now();
  const overdue = reminders.filter((r) => r.fireAt <= now);
  for (const r of overdue) void fire(r, true);
  for (const r of reminders.filter((x) => x.fireAt > now)) schedule(r);
  if (reminders.length > 0) {
    console.log(`[remind] restored ${reminders.length} reminders (${overdue.length} overdue)`);
  }
}

/** "30m" | "2h" | "1d" | "HH:MM"(KST, 지난 시각이면 내일) → 발화 시각(ms) 또는 null. */
export function parseFireAt(spec: string, now = Date.now()): number | null {
  const rel = spec.match(/^(\d+)([smhd])$/i);
  if (rel) {
    const mult = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
      rel[2].toLowerCase() as "s" | "m" | "h" | "d"
    ];
    const delay = Number(rel[1]) * mult;
    if (delay < 30_000 || delay > MAX_DELAY_MS) return null;
    return now + delay;
  }
  const abs = spec.match(/^(\d{1,2}):(\d{2})$/);
  if (abs) {
    const h = Number(abs[1]);
    const m = Number(abs[2]);
    if (h > 23 || m > 59) return null;
    const shifted = new Date(now + 9 * 3600_000);
    const target = new Date(shifted);
    target.setUTCHours(h, m, 0, 0);
    if (target.getTime() <= shifted.getTime()) target.setUTCDate(target.getUTCDate() + 1);
    return now + (target.getTime() - shifted.getTime());
  }
  return null;
}

export async function addReminder(args: {
  channelId: string;
  content: string;
  fireAt: number;
}): Promise<Reminder> {
  const reminder: Reminder = { id: randomUUID().slice(0, 8), ...args };
  reminders.push(reminder);
  await persist();
  schedule(reminder);
  return reminder;
}

function schedule(r: Reminder): void {
  const delay = Math.max(0, r.fireAt - Date.now());
  timers.set(
    r.id,
    setTimeout(() => void fire(r, false), delay),
  );
}

async function fire(r: Reminder, late: boolean): Promise<void> {
  try {
    const client = getDiscordClient();
    const ch = await client.channels.fetch(r.channelId).catch(() => null);
    if (ch && (ch.type === ChannelType.GuildText || ch.isThread())) {
      const lateNote = late ? " (봇 재시작으로 지연됨)" : "";
      await ch.send(`⏰ <@${env.OWNER_DISCORD_ID}> ${r.content}${lateNote}`);
    }
  } catch (err) {
    console.warn("[remind] fire failed:", err);
  } finally {
    timers.delete(r.id);
    reminders = reminders.filter((x) => x.id !== r.id);
    await persist();
  }
}

async function persist(): Promise<void> {
  try {
    await mkdir(path.dirname(FILE), { recursive: true });
    const tmp = FILE + ".tmp";
    await writeFile(tmp, JSON.stringify(reminders, null, 2));
    await rename(tmp, FILE);
  } catch (err) {
    console.warn("[remind] persist failed:", err);
  }
}
