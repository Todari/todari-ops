import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
} from "discord.js";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../env.js";
import { clip, collectActivity, renderSections, type DayEvidence } from "../daily-log/evidence.js";
import { fetchDigestChannel, ownerMention } from "../discord/alerts.js";
import { findProjectByRepoFullName } from "../projects.js";
import { getVaultState, todayKst, type VaultState } from "../vault/state.js";
import { captureException } from "../observability/sentry.js";
import { claimTodayKst, missedTodayKst } from "../storage/scheduled-posts.js";
import { getPendingAction, putPendingAction } from "../webhook/pending.js";

// 저녁 체크인: 21:30(KST) #daily 에 [회고 쓰기] 버튼 → 모달(오늘/막힘/내일)
// → 제출 내용은 📥 인박스로 가서 스위퍼가 데일리 노트에 기록하고,
// "내일 첫 작업"은 봇이 직접 저장해 다음날 아침 다이제스트 최상단에 띄운다.
// 글을 쓰지 않아도 닫을 수 있게 같은 메시지에 오늘 한 일(봇이 모은 근거)과
// "내일 첫 작업" 후보 버튼을 붙인다. 후보를 한 번 누르면 모달 없이 저장된다.

interface CheckinState {
  date: string; // 체크인한 저녁의 KST 날짜
  tomorrow: string;
}

const FILE = path.resolve(env.WORK_DIR, "..", "checkin.json");
// 후보 버튼은 다음 날 아침 다이제스트 전까지 눌러도 된다.
const PICK_TTL_MS = 12 * 3600_000;
// 근거 수집(GitHub 검색·볼트 pull)이 늦어도 프롬프트는 제때 나가야 한다.
const ACTIVITY_TIMEOUT_MS = 20_000;

export function startEveningCheckin(): void {
  if (!env.CHECKIN_TIME) {
    console.log("[checkin] disabled (CHECKIN_TIME empty)");
    return;
  }
  scheduleNext();
}

function scheduleNext(): void {
  const next = msUntilKst(env.CHECKIN_TIME);
  // 오늘 예약 시각이 지났는데 게시 기록이 없으면(배포·재시작으로 놓침) 바로 따라잡는다.
  const delay = missedTodayKst("checkin", next) ? 0 : next;
  console.log(`[checkin] next prompt in ${Math.round(delay / 60_000)}min (${env.CHECKIN_TIME} KST)`);
  setTimeout(async () => {
    try {
      // 예약 게시는 KST 하루 한 번. 수동 /checkin 은 세지 않는다.
      if (claimTodayKst("checkin")) await postCheckinPrompt();
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
  const date = todayKst();
  const extras = await oneTapExtras(date);
  // 회고를 쓰라는 요청이라 푸시가 가야 한다(서버 알림 기본값이 "@멘션만").
  const mention = ownerMention();
  await channel.send({
    ...mention,
    content: `${mention.content} 🌙 **저녁 체크인** — 오늘을 3줄로 닫읍시다. 내일 첫 작업은 아침 브리핑 맨 위에 올라갑니다.`,
    embeds: extras.embeds,
    components: [openRow(date), ...extras.rows],
  });
  return true;
}

function openRow(date: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`checkin:open:${date}`)
      .setLabel("📝 회고 쓰기 (30초)")
      .setStyle(ButtonStyle.Primary),
  );
}

/** 오늘 한 일 요약과 "내일 첫 작업" 후보 버튼. 못 만들어도 프롬프트는 그대로 나간다. */
async function oneTapExtras(
  date: string,
): Promise<{ embeds: EmbedBuilder[]; rows: Array<ActionRowBuilder<ButtonBuilder>> }> {
  try {
    const activity = await activitySoFar(date);
    const fields = (activity ? renderSections(activity) : []).map((section) => ({
      name: section.title,
      // 임베드에서는 위키링크가 걸리지 않는다. 노트 이름만 남긴다.
      value: clip(section.lines.join("\n").replace(/\[\[(.+?)\]\]/g, "$1"), 1000),
    }));
    const embeds =
      fields.length > 0
        ? [new EmbedBuilder().setColor(0x6366f1).setTitle("오늘 한 일 (지금까지)").addFields(fields)]
        : [];
    const vault = getVaultState();
    // 오늘 커밋한 레포의 노트를 앞에 세운다(커밋이 많은 순).
    const active = (activity?.commits ?? []).map(
      (repo) => findProjectByRepoFullName(repo.fullName)?.slug ?? repo.repo,
    );
    // 긴 한글 문장이 잘리지 않게 후보마다 한 줄을 쓴다.
    // ponytail: 후보 원문은 메모리(putPendingAction)에 둔다 — 봇이 재시작하면 버튼이 만료된다.
    // 배포가 저녁과 자주 겹치면 /data 에 보관하도록 바꾼다.
    const rows = (vault ? firstTaskCandidates(vault, active) : []).map((task) => {
      const id = putPendingAction(
        { projectSlug: "vault", threadName: "checkin-pick", prompt: task },
        PICK_TTL_MS,
      );
      return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`checkin:pick:${date}:${id}`)
          .setLabel(clip(`🎯 ${task}`, 78))
          .setStyle(ButtonStyle.Secondary),
      );
    });
    return { embeds, rows };
  } catch (err) {
    console.warn("[checkin] one-tap extras failed:", err);
    return { embeds: [], rows: [] };
  }
}

function activitySoFar(date: string): Promise<DayEvidence | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ACTIVITY_TIMEOUT_MS);
  });
  return Promise.race([collectActivity(date), timeout]).finally(() => clearTimeout(timer));
}

/**
 * "내일 첫 작업" 후보: 마감이 가까운 할 일 → 오늘 손댄 프로젝트(activeSlugs 순)의 첫 할 일
 * → 나머지 노트의 첫 할 일. 다이제스트의 태스크 버튼과 달리 카탈로그 밖 노트도 후보다.
 */
export function firstTaskCandidates(vault: VaultState, activeSlugs: string[], limit = 3): string[] {
  const active = activeSlugs.map((slug) => slug.toLowerCase());
  const rank = (note: { note: string; slug?: string }) => {
    const index = active.indexOf((note.slug ?? note.note).toLowerCase());
    return index < 0 ? active.length : index;
  };
  const dated = vault.notes
    .flatMap((n) => n.tasks.filter((t) => t.due).map((t) => ({ note: n.note, ...t })))
    .sort((a, b) => (a.due ?? "").localeCompare(b.due ?? ""));
  const firsts = [...vault.notes]
    .sort((a, b) => rank(a) - rank(b))
    .flatMap((n) => (n.tasks[0] ? [{ note: n.note, ...n.tasks[0] }] : []));
  const texts = [...dated, ...firsts].map(
    (c) => `${c.note} · ${c.text}${c.due ? ` (📅 ${c.due.slice(5)})` : ""}`,
  );
  return [...new Set(texts)].slice(0, limit);
}

/** 후보 버튼 한 번으로 "내일 첫 작업"을 정한다. 후보 버튼은 고른 내용 한 줄로 바뀌고 회고 버튼은 남는다. */
export async function pickTomorrowFirstTask(interaction: ButtonInteraction): Promise<void> {
  // customId: checkin:pick:<체크인 날짜>:<후보 id> — 자정 넘어 눌러도 그 저녁의 체크인으로 남는다.
  const [, , date, id] = interaction.customId.split(":");
  const task = id ? getPendingAction(id)?.prompt : undefined;
  if (!date || !task) {
    await interaction.reply({
      content: "이 후보는 만료됨 (12h TTL 또는 봇 재시작) — 📝 회고 쓰기에 적어주세요",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await saveTomorrowFirstTask(date, task);
  await interaction.update({
    content: `${interaction.message.content}\n🎯 내일 첫 작업: ${task}`,
    components: [openRow(date)],
  });
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

function readState(): CheckinState | null {
  try {
    if (!existsSync(FILE)) return null;
    const state = JSON.parse(readFileSync(FILE, "utf8")) as CheckinState;
    return state?.tomorrow ? state : null;
  } catch {
    return null;
  }
}

/** 어젯밤(또는 오늘) 체크인의 "내일 첫 작업" — 신선할 때만 반환. */
export function getTodayFirstTask(): string | null {
  const state = readState();
  if (!state) return null;
  const age = Date.parse(todayKst()) - Date.parse(state.date);
  // 어제 저녁(1일 차) 또는 오늘 새벽 체크인만 유효
  if (Number.isNaN(age) || age < 0 || age > 86_400_000) return null;
  return state.tomorrow;
}

/** 그 날짜(KST) 저녁 체크인에서 정한 "내일 첫 작업". 자동 데일리 기록에 들어간다. */
export function getFirstTaskChosenOn(date: string): string | null {
  const state = readState();
  return state?.date === date ? state.tomorrow : null;
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
