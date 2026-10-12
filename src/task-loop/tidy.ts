// 금요일 할 일 정리(docs/task-loop.md): 주간 요약 바로 뒤에, 볼트에서 가장 오래 손대지 않은
// 열린 할 일 5개를 버튼과 함께 올린다. 할 일은 쌓이기만 하고 주인은 봇에 글을 쓰지 않으므로,
// 한 번 눌러 다음 주로 미루거나(next) 4주 동안 가리거나(snooze) 버리게(drop) 한다.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type ButtonInteraction,
  type TextChannel,
} from "discord.js";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { clip } from "../daily-log/evidence.js";
import { env } from "../env.js";
import { readJsonObject, writeJsonObject } from "../storage/json-file.js";
import { findOpenTask, normalizeTaskText } from "../vault/editor.js";
import {
  blameVaultNotes,
  tidyVaultTask,
  type BlameLine,
  type VaultTaskRef,
} from "../vault/mutations.js";
import {
  completeCapturedVaultTask,
  getVaultState,
  setCapturedVaultTaskDue,
  todayKst,
  type VaultState,
} from "../vault/state.js";

export interface StaleTask extends VaultTaskRef {
  /** 그 줄이 마지막으로 바뀐 뒤 지난 날수. */
  days: number;
}

interface TidyTask extends StaleTask {
  id: string;
  /** 버튼으로 정한 결과. 메시지의 그 줄에 적힌다. */
  outcome?: string;
}

interface TidyPost {
  at: number;
  tasks: TidyTask[];
}

interface TidyState {
  /** 올린 정리 메시지들. 버튼이 주말의 재시작을 넘기도록 /data 에 둔다. */
  posts: TidyPost[];
  /** 보류한 할 일(`노트\n할 일`) → 다시 보이기 시작하는 KST 날짜. */
  snoozed: Record<string, string>;
  /** 예약된 주간 요약이 나간 KST 날짜 → 그때의 열린 할 일 수. */
  openCounts: Record<string, number>;
}

const FILE = path.resolve(env.WORK_DIR, "..", "task-tidy.json");
const DAY_MS = 86_400_000;
const KEEP_POSTS_MS = 14 * DAY_MS;
const SNOOZE_DAYS = 28;
const KEEP_COUNT_DAYS = 56;

function load(): TidyState {
  const raw = readJsonObject<unknown>(FILE) as Partial<TidyState>;
  return { posts: raw.posts ?? [], snoozed: raw.snoozed ?? {}, openCounts: raw.openCounts ?? {} };
}

/** 읽고·고치고·쓰기를 한 틱에 끝낸다. 버튼 처리가 겹쳐도 서로의 기록을 덮지 않는다. */
function update(change: (state: TidyState) => void): TidyState {
  const state = load();
  change(state);
  writeJsonObject(FILE, state);
  return state;
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** date 뒤에 처음 오는 금요일. 금요일에 누르면 7일 뒤다. */
function comingFriday(date: string): string {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, (5 - weekday + 7) % 7 || 7);
}

const snoozeKey = (note: string, text: string) => `${note}\n${normalizeTaskText(text)}`;
const findTask = (state: TidyState, id: string | undefined) =>
  state.posts.flatMap((post) => post.tasks).find((task) => task.id === id);

/** 보류 중인 할 일을 뺀 볼트 상태. 정리 목록·다이제스트의 고르기 메뉴·체크인 후보가 같은 것을 가린다. */
export function withoutSnoozed(vault: VaultState): VaultState {
  const { snoozed } = load();
  const today = todayKst();
  const hidden = (note: string, text: string) => (snoozed[snoozeKey(note, text)] ?? "") > today;
  return {
    ...vault,
    notes: vault.notes.map((n) => ({ ...n, tasks: n.tasks.filter((t) => !hidden(n.note, t.text)) })),
  };
}

/** 오늘(KST)보다 앞서 예약 주간 요약이 마지막으로 남긴 열린 할 일 수와 그 날짜. 주간 요약이 견주는 값이다. */
export function lastOpenTaskCount(): { date: string; count: number } | undefined {
  const { openCounts } = load();
  const today = todayKst();
  const date = Object.keys(openCounts).filter((d) => d < today).sort().at(-1);
  return date === undefined ? undefined : { date, count: openCounts[date] };
}

export function recordOpenTaskCount(count: number): void {
  const today = todayKst();
  update((state) => {
    state.openCounts[today] = count;
    for (const date of Object.keys(state.openCounts)) {
      if (date < addDays(today, -KEEP_COUNT_DAYS)) delete state.openCounts[date];
    }
  });
}

/**
 * 줄이 마지막으로 바뀐 지 가장 오래된 열린 할 일 limit 개. 마감이 오늘 이후인 할 일은 이미 날을 잡은 것이라 빼고,
 * 볼트에서 파일이나 줄을 찾지 못한 할 일(스냅샷은 하루 이틀 늦을 수 있다)도 조용히 뺀다.
 */
export function stalestTasks(
  vault: VaultState,
  blame: Map<string, BlameLine[]>,
  limit = 5,
): StaleTask[] {
  const today = todayKst();
  const found: Array<VaultTaskRef & { time: number }> = [];
  for (const n of vault.notes) {
    const lines = blame.get(n.note);
    if (!lines) continue;
    const texts = lines.map((line) => line.text);
    for (const task of n.tasks) {
      if (task.due && task.due >= today) continue;
      const line = lines[findOpenTask(texts, task.text)];
      if (line) found.push({ projectSlug: n.slug ?? n.note, note: n.note, text: task.text, time: line.time });
    }
  }
  return found
    .sort((a, b) => a.time - b.time)
    .slice(0, limit)
    .map(({ time, ...task }) => ({ ...task, days: Math.floor((Date.now() - time) / DAY_MS) }));
}

/** 주간 요약 바로 뒤에 같은 채널로 올린다. 볼트 상태가 없거나 고를 할 일이 없으면 아무것도 올리지 않는다. */
export async function postTidy(channel: Pick<TextChannel, "send">): Promise<boolean> {
  const vault = getVaultState();
  if (!vault) return false;
  const visible = withoutSnoozed(vault);
  const blame = await blameVaultNotes(
    visible.notes
      .filter((n) => n.tasks.length > 0)
      .map((n) => ({ projectSlug: n.slug ?? n.note, note: n.note })),
  );
  const stale = stalestTasks(visible, blame);
  if (stale.length === 0) return false;

  const post: TidyPost = {
    at: Date.now(),
    tasks: stale.map((task) => ({ id: randomUUID().slice(0, 8), ...task })),
  };
  const today = todayKst();
  update((state) => {
    state.posts = [...state.posts.filter((old) => post.at - old.at < KEEP_POSTS_MS), post];
    for (const [key, until] of Object.entries(state.snoozed)) {
      if (until <= today) delete state.snoozed[key];
    }
  });
  // 주간 요약에 딸린 메시지라 멘션(푸시)은 하지 않는다.
  await channel.send(render(post));
  return true;
}

function render(post: TidyPost): {
  embeds: EmbedBuilder[];
  components: Array<ActionRowBuilder<ButtonBuilder>>;
} {
  const button = (id: string, label: string, style: ButtonStyle) =>
    new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
  const lines = post.tasks.map((task, i) => {
    const line = `**${task.note}** · ${clip(task.text, 150)} — ${task.days}일째`;
    return `${i + 1}. ${task.outcome ? `~~${line}~~ → ${task.outcome}` : line}`;
  });
  return {
    embeds: [
      new EmbedBuilder()
        .setColor(0x94a3b8)
        .setTitle(`🧹 할 일 정리 — 오래 손대지 않은 ${post.tasks.length}개`)
        .setDescription(lines.join("\n")),
    ],
    // 처리한 할 일은 줄에 결과를 적고 버튼 줄만 뺀다. 번호는 그대로라 남은 버튼과 어긋나지 않는다.
    components: post.tasks.flatMap((task, i) =>
      task.outcome
        ? []
        : [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              button(`tidy:next:${task.id}`, `${i + 1} 다음 주`, ButtonStyle.Primary),
              button(`tidy:snooze:${task.id}`, `${i + 1} 보류 4주`, ButtonStyle.Secondary),
              button(`tidy:drop:${task.id}`, `${i + 1} 버림`, ButtonStyle.Danger),
            ),
          ],
    ),
  };
}

// 버튼을 연달아 누르면 응답이 겹친다. 메시지 수정은 한 줄로 세우고 보내는 순간의 상태로 그려,
// 먼저 그린 화면이 늦게 도착해 다른 줄의 결과를 지우는 일이 없게 한다.
let edits: Promise<unknown> = Promise.resolve();

export function editInOrder<T>(send: () => Promise<T>): Promise<T> {
  const run = edits.then(send, send);
  edits = run.catch(() => undefined);
  return run;
}

/** 정리 버튼(`tidy:<next|snooze|drop>:<id>`): 볼트를 고친 뒤 그 줄에 결과를 적고 그 줄의 버튼만 뺀다. */
export async function handleTidyButton(interaction: ButtonInteraction): Promise<void> {
  const [, action, id] = interaction.customId.split(":");
  const task = findTask(load(), id);
  if (!task || (action !== "next" && action !== "snooze" && action !== "drop")) {
    await interaction.reply({
      content: "이 정리 목록은 만료됨 (14일) — 다음 금요일 목록에서 골라주세요",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (task.outcome) {
    await interaction.reply({ content: `이미 처리한 할 일입니다 (${task.outcome})`, flags: MessageFlags.Ephemeral });
    return;
  }
  // 볼트 커밋·push 는 3초를 넘긴다.
  await interaction.deferUpdate();
  const today = todayKst();
  let outcome: string;
  if (action === "snooze") {
    // 볼트는 건드리지 않는다. 그날까지 봇의 목록들에서만 가린다.
    const until = addDays(today, SNOOZE_DAYS);
    update((state) => {
      state.snoozed[snoozeKey(task.note, task.text)] = until;
    });
    outcome = `보류 (${until.slice(5)}까지)`;
  } else {
    const date = action === "next" ? comingFriday(today) : today;
    let changed: boolean;
    try {
      changed = (await tidyVaultTask(task, action, date)).changed;
    } catch {
      // 원인은 mutation layer 가 이미 Sentry 에 남겼다.
      await interaction.followUp({
        content: "⚠️ 볼트에 반영하지 못했습니다. 잠시 후 다시 눌러주세요.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!changed) {
      // 같은 버튼을 연달아 두 번 누른 것이면 먼저 누른 쪽이 이미 반영했다. 알릴 것이 없다.
      if (findTask(load(), id)?.outcome) return;
      await interaction.followUp({
        content: `**${task.note}** 노트에서 고칠 줄을 찾지 못했습니다 — 이미 완료·수정했거나 같은 날짜가 적혀 있습니다. 볼트는 그대로입니다.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // 원본 커밋은 성공했다. 파생 스냅샷 갱신이 실패해도 다음 맥 동기화가 바로잡는다.
    await (action === "next"
      ? setCapturedVaultTaskDue(task.note, task.projectSlug, task.text, date)
      : completeCapturedVaultTask(task.note, task.projectSlug, task.text)
    ).catch((err) => console.warn("[tidy] vault snapshot update failed:", err));
    outcome = action === "next" ? `📅 ${date.slice(5)}` : "버림";
  }
  update((state) => {
    const done = findTask(state, id);
    if (done) done.outcome = outcome;
  });
  await editInOrder(async () => {
    const post = load().posts.find((p) => p.tasks.some((t) => t.id === id));
    if (post) await interaction.editReply(render(post));
  });
}
