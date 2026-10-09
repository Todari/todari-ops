// 예약 게시(다이제스트·주간 요약·체크인·일본어 푸시)를 마지막으로 게시한 KST 날짜.
// /data 볼륨의 JSON 에 남겨, 예약 시각에 봇이 내려가 있었으면(배포·재시작) 다음
// 시작 때 따라잡고 같은 날 두 번 게시하지 않는다. 수동 명령(/digest 등)은 기록하지 않는다.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { env } from "../env.js";

const FILE = path.resolve(env.WORK_DIR, "..", "scheduled-posts.json");
const KST_MS = 9 * 3600_000;
const DAY_MS = 86_400_000;

let lastPosted: Record<string, string> | null = null; // 예약 이름 → YYYY-MM-DD (KST)

function load(): Record<string, string> {
  if (lastPosted) return lastPosted;
  try {
    const raw: unknown = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {};
    const valid = raw && typeof raw === "object" && !Array.isArray(raw);
    lastPosted = valid ? (raw as Record<string, string>) : {};
  } catch {
    lastPosted = {};
  }
  return lastPosted;
}

function kstDate(ms: number): string {
  return new Date(ms + KST_MS).toISOString().slice(0, 10);
}

/**
 * 따라잡기 판단: 직전 예약 시각(다음 예약 − 주기)이 오늘(KST)인데 오늘 게시한 기록이
 * 없으면 true. 기록이 아예 없는 예약(첫 배포·새 예약)은 오늘 이미 게시했는지 알 수
 * 없으므로 따라잡지 않는다.
 */
export function missedTodayKst(name: string, msUntilNext: number, periodMs = DAY_MS): boolean {
  const now = Date.now();
  const last = load()[name];
  // 직전 예약 시각은 날짜 번호로 비교한다 — msUntilNext 가 NaN(잘못된 env)이어도 던지지 않는다.
  const kstDay = (ms: number) => Math.floor((ms + KST_MS) / DAY_MS);
  if (kstDay(now + msUntilNext - periodMs) !== kstDay(now) || last === kstDate(now)) return false;
  if (last === undefined) {
    console.log(`[${name}] no scheduled-post record yet — not catching up`);
    return false;
  }
  console.log(`[${name}] missed today's scheduled post (last ${last}) — catching up`);
  return true;
}

/**
 * 예약 게시 직전에 호출한다. 오늘(KST) 이미 게시한 예약이면 false, 아니면 오늘 날짜를
 * 기록하고 true. 게시 전에 기록하므로 따라잡기와 정시 예약이 겹쳐도, 게시 도중
 * 재시작돼도 하루 두 번 게시되지 않는다(실패한 게시는 기존처럼 그날 다시 시도하지 않는다).
 */
export function claimTodayKst(name: string): boolean {
  const state = load();
  const today = kstDate(Date.now());
  if (state[name] === today) return false;
  state[name] = today;
  try {
    // 동기 쓰기: 시작 시 여러 예약이 한꺼번에 기록해도 tmp 파일이 겹치지 않는다.
    mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, FILE);
  } catch (err) {
    console.warn("[scheduled] persist failed:", err);
  }
  return true;
}
