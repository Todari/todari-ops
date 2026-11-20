import { randomUUID } from "node:crypto";
import path from "node:path";
import { env } from "../env.js";
import { getDiscordClient } from "../discord/client.js";
import { readJsonFile, writeJsonFile } from "../storage/json-file.js";

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
const RETRY_MS = 60_000;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

export function startReminders(): void {
  let reminders: Reminder[];
  try {
    reminders = load();
  } catch (err) {
    console.warn("[remind] restore failed:", err);
    setTimeout(startReminders, RETRY_MS).unref();
    return;
  }
  const now = Date.now();
  const overdue = reminders.filter((r) => r.fireAt <= now);
  for (const reminder of reminders) schedule(reminder, reminder.fireAt <= now);
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
  const reminder: Reminder = { id: randomUUID(), ...args };
  writeJsonFile(FILE, [...load(), reminder]);
  schedule(reminder);
  return reminder;
}

function schedule(r: Reminder, late = false, delay = r.fireAt - Date.now(), sent = false): void {
  const prior = timers.get(r.id);
  if (prior) clearTimeout(prior);
  const timer = setTimeout(() => void fire(r, late, sent), Math.max(0, delay));
  timer.unref();
  timers.set(r.id, timer);
}

async function fire(r: Reminder, late: boolean, sent: boolean): Promise<void> {
  try {
    if (!sent) {
      const ch = await getDiscordClient().channels.fetch(r.channelId);
      if (!ch?.isSendable()) {
        throw new Error("Reminder channel unavailable");
      }
      const lateNote = late ? " (봇 재시작으로 지연됨)" : "";
      const prefix = `⏰ <@${env.OWNER_DISCORD_ID}>`;
      const content = `${prefix} ${r.content}${lateNote}`;
      await ch.send({
        content: content.length <= 2000 ? content : `${prefix} 리마인더가 도착했어요.${lateNote}`,
        ...(content.length > 2000 && { files: [{ attachment: Buffer.from(r.content), name: "reminder.txt" }] }),
        allowedMentions: { users: [env.OWNER_DISCORD_ID] },
        nonce: r.id.slice(0, 25),
        enforceNonce: true,
      });
      sent = true;
    }
    writeJsonFile(FILE, load().filter((item) => item.id !== r.id));
    timers.delete(r.id);
  } catch (err) {
    console.warn("[remind] delivery pending:", r.id, (err as Error).name);
    schedule(r, late, RETRY_MS, sent);
  }
}

function load(): Reminder[] {
  const reminders = readJsonFile(FILE, []);
  if (!Array.isArray(reminders) || !reminders.every(isReminder)) {
    throw new Error("Invalid reminder store");
  }
  return reminders;
}

function isReminder(value: unknown): value is Reminder {
  const reminder = value as Partial<Reminder> | null;
  return typeof reminder?.id === "string" && typeof reminder.channelId === "string"
    && typeof reminder.content === "string" && Number.isFinite(reminder.fireAt);
}
