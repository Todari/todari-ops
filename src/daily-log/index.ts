// 자동 데일리 기록: DAILY_LOG_TIME(KST)에 "어제" 하루의 근거를 모아 볼트
// `데일리/YYYY-MM-DD.md`의 `## 자동 기록` 구획에 쓴다(docs/daily-log.md).
// 사람이 봇에 적지 않아도 데일리 노트가 이어지게 하려는 것이라 밤에는 디스코드에
// 알리지 않고, 아침 다이제스트가 요약 한 줄만 싣는다.

import path from "node:path";
import { getFirstTaskChosenOn } from "../checkin/index.js";
import { env } from "../env.js";
import { dailyCardBetween } from "../jp/cards.js";
import { readInstagramBrief } from "../monitor/status-board.js";
import { captureException } from "../observability/sentry.js";
import { readJsonObject, writeJsonObject } from "../storage/json-file.js";
import { claimTodayKst, missedTodayKst } from "../storage/scheduled-posts.js";
import { writeVaultDailyLog } from "../vault/mutations.js";
import {
  collectActivity,
  kstDayWindow,
  optional,
  renderDailyLog,
  summarize,
  yesterdayKst,
  type DayEvidence,
  type DayWindow,
} from "./evidence.js";

// 마지막으로 쓴 기록의 날짜와 요약 한 줄.
const FILE = path.resolve(env.WORK_DIR, "..", "daily-log.json");

export function startDailyLog(): void {
  if (!env.DAILY_LOG_TIME) {
    console.log("[daily-log] disabled (DAILY_LOG_TIME empty)");
    return;
  }
  scheduleNext();
}

function scheduleNext(): void {
  const next = msUntilNextKst(env.DAILY_LOG_TIME);
  // 오늘 예약 시각이 지났는데 기록한 적이 없으면(배포·재시작으로 놓침) 바로 따라잡는다.
  const delay = missedTodayKst("daily-log", next) ? 0 : next;
  console.log(`[daily-log] next run in ${Math.round(delay / 60_000)}min (${env.DAILY_LOG_TIME} KST)`);
  setTimeout(async () => {
    try {
      // KST 하루 한 번, 그 시각 기준 어제를 쓴다.
      if (claimTodayKst("daily-log")) await writeDailyLog(yesterdayKst());
    } catch (err) {
      console.error("[daily-log] failed:", err);
      captureException(err, { kind: "daily-log" });
    }
    scheduleNext();
  }, delay);
}

/** date(KST) 하루의 기록을 볼트에 쓴다. 근거가 하나도 없으면 아무것도 쓰지 않고 false. */
export async function writeDailyLog(date: string): Promise<boolean> {
  const window = kstDayWindow(date);
  const evidence: DayEvidence = {
    ...(await collectActivity(date)),
    instagram: await optional("instagram brief", undefined, () => instagramBriefFor(window)),
    jp: await optional("jp", undefined, () => jpLine(window)),
    firstTask: await optional("first task", undefined, () => getFirstTaskChosenOn(date) ?? undefined),
  };
  const body = renderDailyLog(evidence);
  if (!body) {
    console.log(`[daily-log] ${date}: nothing to record`);
    return false;
  }
  const result = await writeVaultDailyLog(date, body);
  writeJsonObject(FILE, { date, summary: summarize(evidence) });
  console.log(`[daily-log] ${date}: ${result.changed ? `written (${result.commit})` : "unchanged"}`);
  return true;
}

/** 아침 다이제스트의 "📓 어제 기록" 한 줄. 어제 기록을 쓰지 않았으면(근거 없음·실패) null. */
export function yesterdayLogSummary(): string | null {
  const { date, summary } = readJsonObject<string>(FILE);
  return date === yesterdayKst() && summary ? `${summary} → 볼트 데일리/${date}.md` : null;
}

// 워치독의 실적 문구는 받은 날 기준 "어제"를 말한다. 기록할 날의 다음 날(KST)에 받은 것만 그날의 실적이다.
function instagramBriefFor(window: DayWindow): string | undefined {
  const saved = readInstagramBrief();
  const fresh = saved && saved.at >= window.end && saved.at < window.end + 86_400_000;
  return fresh ? saved.brief : undefined;
}

function jpLine(window: DayWindow): string | undefined {
  const card = dailyCardBetween(window.start, window.end);
  return card ? `${card.front} (${card.reading}) — ${card.meaning}` : undefined;
}

// KST is fixed UTC+9 (no DST) — compute next HH:MM occurrence. Mirrors
// digest/daily.ts's msUntilNextKst / checkin/index.ts's msUntilKst.
function msUntilNextKst(hhmm: string): number {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  const hours = m ? Number(m[1]) : 0;
  const minutes = m ? Number(m[2]) : 40;
  const nowShifted = new Date(Date.now() + 9 * 3600_000);
  const target = new Date(nowShifted);
  target.setUTCHours(hours, minutes, 0, 0);
  if (target.getTime() <= nowShifted.getTime()) target.setUTCDate(target.getUTCDate() + 1);
  return target.getTime() - nowShifted.getTime();
}
