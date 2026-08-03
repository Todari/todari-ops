import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../env.js";
import { fetchDigestChannel } from "../discord/alerts.js";
import { todayKst } from "../vault/state.js";
import { captureException } from "../observability/sentry.js";

// 저녁 체크인: 21:30(KST) #daily 에 [회고 쓰기] 버튼 → 모달(오늘/막힘/내일)
// → 제출 내용은 📥 인박스로 가서 스위퍼가 데일리 노트에 기록하고,
// "내일 첫 작업"은 봇이 직접 저장해 다음날 아침 다이제스트 최상단에 띄운다.

interface CheckinState {
  date: string; // 체크인한 저녁의 KST 날짜
  tomorrow: string;
}

const FILE = path.resolve(env.WORK_DIR, "..", "checkin.json");

export function startEveningCheckin(): void {
  if (!env.CHECKIN_TIME) {
    console.log("[checkin] disabled (CHECKIN_TIME empty)");
    return;
  }
  scheduleNext();
}

function scheduleNext(): void {
  const delay = msUntilKst(env.CHECKIN_TIME);
  console.log(`[checkin] next prompt in ${Math.round(delay / 60_000)}min (${env.CHECKIN_TIME} KST)`);
  setTimeout(async () => {
    try {
      await postCheckinPrompt();
    } catch (err) {
      console.error("[checkin] failed:", err);
      captureException(err, { kind: "checkin" });
    }
    scheduleNext();
  }, delay);
}

export async function postCheckinPrompt(): Promise<boolean> {
  const channel = await fetchDigestChannel();
  if (!channel) return false;
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`checkin:open:${todayKst()}`)
      .setLabel("📝 회고 쓰기 (30초)")
      .setStyle(ButtonStyle.Primary),
  );
  await channel.send({
    content: "🌙 **저녁 체크인** — 오늘을 3줄로 닫읍시다. 내일 첫 작업은 아침 브리핑 맨 위에 올라갑니다.",
    components: [row],
  });
  return true;
}

export function buildCheckinModal(date: string): ModalBuilder {
  const input = (id: string, label: string, required: boolean, placeholder: string) =>
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId(id)
        .setLabel(label)
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(required)
        .setMaxLength(500)
        .setPlaceholder(placeholder),
    );
  return new ModalBuilder()
    .setCustomId(`checkin:submit:${date}`)
    .setTitle(`저녁 체크인 — ${date}`)
    .addComponents(
      input("done", "오늘 한 일", true, "핵심만 1~3줄"),
      input("stuck", "막힌 것 / 삽질 (선택)", false, "다음에 검색하고 싶을 내용이면 자세히"),
      input("tomorrow", "내일 첫 작업 (선택)", false, "아침에 바로 시작할 한 가지"),
    );
}

export async function saveTomorrowFirstTask(date: string, tomorrow: string): Promise<void> {
  const state: CheckinState = { date, tomorrow };
  await mkdir(path.dirname(FILE), { recursive: true });
  const tmp = FILE + ".tmp";
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, FILE);
}

/** 어젯밤(또는 오늘) 체크인의 "내일 첫 작업" — 신선할 때만 반환. */
export function getTodayFirstTask(): string | null {
  try {
    if (!existsSync(FILE)) return null;
    const state = JSON.parse(readFileSync(FILE, "utf8")) as CheckinState;
    if (!state?.tomorrow) return null;
    const age = Date.parse(todayKst()) - Date.parse(state.date);
    // 어제 저녁(1일 차) 또는 오늘 새벽 체크인만 유효
    if (Number.isNaN(age) || age < 0 || age > 86_400_000) return null;
    return state.tomorrow;
  } catch {
    return null;
  }
}

function msUntilKst(hhmm: string): number {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  const hours = m ? Number(m[1]) : 21;
  const minutes = m ? Number(m[2]) : 30;
  const nowShifted = new Date(Date.now() + 9 * 3600_000);
  const target = new Date(nowShifted);
  target.setUTCHours(hours, minutes, 0, 0);
  if (target.getTime() <= nowShifted.getTime()) target.setUTCDate(target.getUTCDate() + 1);
  return target.getTime() - nowShifted.getTime();
}
