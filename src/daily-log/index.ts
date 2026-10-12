// 자동 데일리 기록: DAILY_LOG_TIME(KST)에 "어제" 하루의 근거를 모아 볼트
// `데일리/YYYY-MM-DD.md`의 `## 자동 기록` 구획에 쓴다(docs/daily-log.md).
// 사람이 봇에 적지 않아도 데일리 노트가 이어지게 하려는 것이라 밤에는 디스코드에
// 알리지 않고, 아침 다이제스트가 요약 한 줄만 싣는다. 실행이 실패했거나 봇이 며칠
// 내려가 있어 놓친 날은 다음 실행이 채운다.

import path from "node:path";
import { getFirstTaskChosenOn } from "../checkin/index.js";
import { env } from "../env.js";
import { dailyCardBetween } from "../jp/cards.js";
import { readInstagramBrief } from "../monitor/status-board.js";
import { captureException } from "../observability/sentry.js";
import { readJsonObject, writeJsonObject } from "../storage/json-file.js";
import { claimTodayKst, missedTodayKst } from "../storage/scheduled-posts.js";
import { getTodayPicks } from "../task-loop/today.js";
import { writeVaultDailyLog } from "../vault/mutations.js";
import { addDays } from "../vault/state.js";
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

interface LogState {
  /** 마지막으로 쓴 기록의 날짜와 요약 한 줄. 아침 다이제스트가 읽는다. */
  date?: string;
  summary?: string;
  /** 여기까지는 살펴봤다: 썼거나, 근거가 없어 넘어갔거나, 못 써서 pending 에 남겼다. */
  processed?: string;
  /** 살펴봤지만 아직 쓰지 못한 날들(쓰다가 실패했거나 실행이 도중에 끊겼다). 다음 실행이 다시 쓴다. */
  pending?: string[];
}

const FILE = path.resolve(env.WORK_DIR, "..", "daily-log.json");
// 한 번의 실행이 거슬러 올라가 채우는 날수. 오늘의 3개(today-picks.json)가 남아 있는 기간이기도 하다.
const MAX_BACKFILL_DAYS = 7;

const loadState = () => readJsonObject<unknown>(FILE) as LogState;

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
      // KST 하루 한 번, 그 시각 기준 어제까지 아직 쓰지 않은 날을 쓴다.
      if (claimTodayKst("daily-log")) await writePendingDays();
    } catch (err) {
      console.error("[daily-log] failed:", err);
      captureException(err, { kind: "daily-log" });
    }
    scheduleNext();
  }, delay);
}

/**
 * 마지막으로 살펴본 날 다음부터 어제까지를 오래된 날부터 쓴다(최대 MAX_BACKFILL_DAYS 일).
 * 근거가 없던 날도 살펴본 날로 쳐서 매번 다시 보지 않는다. 하루가 실패해도 뒤의 날은 이어서 쓰고,
 * 쓰지 못한 날은 다음 실행에서 다시 쓴다.
 */
async function writePendingDays(): Promise<void> {
  const yesterday = yesterdayKst();
  const oldest = addDays(yesterday, 1 - MAX_BACKFILL_DAYS);
  const state = loadState();
  // processed 가 생기기 전의 파일에는 마지막으로 쓴 날(date)만 있다. 둘 다 없으면(첫 실행) 어제만 쓴다.
  const last = state.processed ?? state.date;
  const next = last ? addDays(last, 1) : yesterday;
  const days = new Set((state.pending ?? []).filter((day) => day >= oldest && day <= yesterday));
  for (let day = next < oldest ? oldest : next; day <= yesterday; day = addDays(day, 1)) days.add(day);

  // 먼저 모두 "아직 못 쓴 날"로 올려 두고 끝낸 날만 지운다. 이미 쓴 날을 다음 실행이 다시 쓰면
  // 그날에만 있던 근거(인스타 실적·내일 첫 작업)가 빠진 내용으로 덮이므로, 날마다 바로 남긴다.
  const pending = [...days].sort();
  writeJsonObject(FILE, { ...state, processed: yesterday, pending });
  for (const day of pending) {
    try {
      await writeDailyLog(day);
      const now = loadState();
      writeJsonObject(FILE, { ...now, pending: (now.pending ?? []).filter((d) => d !== day) });
    } catch (err) {
      console.error(`[daily-log] ${day} failed:`, err);
      captureException(err, { kind: "daily-log", date: day });
    }
  }
}

/** date(KST) 하루의 기록을 볼트에 쓴다. 근거가 하나도 없으면 아무것도 쓰지 않고 false. */
export async function writeDailyLog(date: string): Promise<boolean> {
  const window = kstDayWindow(date);
  const evidence: DayEvidence = {
    ...(await collectActivity(date)),
    instagram: await optional("instagram brief", undefined, () => instagramBriefFor(window)),
    jp: await optional("jp", undefined, () => jpLine(window)),
    picks: await optional("today picks", undefined, () => getTodayPicks(date)),
    firstTask: await optional("first task", undefined, () => getFirstTaskChosenOn(date) ?? undefined),
  };
  const body = renderDailyLog(evidence);
  if (!body) {
    console.log(`[daily-log] ${date}: nothing to record`);
    return false;
  }
  const result = await writeVaultDailyLog(date, body);
  writeJsonObject(FILE, { ...loadState(), date, summary: summarize(evidence) });
  console.log(`[daily-log] ${date}: ${result.changed ? `written (${result.commit})` : "unchanged"}`);
  return true;
}

/** 아침 다이제스트의 "📓 어제 기록" 한 줄. 어제 기록을 쓰지 않았으면(근거 없음·실패) null. */
export function yesterdayLogSummary(): string | null {
  const { date, summary } = loadState();
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
