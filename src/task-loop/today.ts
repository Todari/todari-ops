// 오늘의 3개(docs/task-loop.md): 아침 다이제스트의 메뉴에서 오늘 할 일을 최대 3개 고르면
// 저녁 체크인이 그것을 다시 보여 주고, 한 번 눌러 볼트의 체크박스를 완료한다.
// 열린 할 일이 아무리 많아도 하루에 마주하는 것은 3개가 되게 하려는 것이다.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type Embed,
  type StringSelectMenuInteraction,
  type TopLevelComponent,
} from "discord.js";
import { createHash } from "node:crypto";
import path from "node:path";
import { clip } from "../daily-log/evidence.js";
import { env } from "../env.js";
import { readJsonObject, writeJsonObject } from "../storage/json-file.js";
import { completeVaultTask, type VaultTaskRef } from "../vault/mutations.js";
import { completeCapturedVaultTask, daysUntil, type VaultState } from "../vault/state.js";
import { editInOrder, withoutSnoozed } from "./tidy.js";

export interface TodayTask extends VaultTaskRef {
  /** 노트 이름과 할 일 문장으로 만든 짧은 id. 후보를 다시 뽑아도 같은 할 일은 같은 id 다. */
  id: string;
  due?: string;
  done?: boolean;
}

/** 고르기 메뉴의 후보 순서를 정하는 근거. 없으면 그 단계는 건너뛴다. */
export interface PickOrder {
  /** 어젯밤 체크인의 후보 버튼으로 정한 "내일 첫 작업". 아직 열려 있으면 맨 앞에 미리 골라 둔다. */
  first?: Pick<VaultTaskRef, "note" | "text"> | null;
  /** 최근 커밋한 프로젝트(카탈로그 slug 또는 레포 이름), 커밋이 많은 순. */
  active?: string[];
}

interface Day {
  /** 그날 메뉴에 실은 후보. 재시작 뒤에도 고른 값(id)을 할 일로 되돌린다. */
  candidates: TodayTask[];
  /** 고른 할 일(고른 순서, 최대 3개). */
  picks: TodayTask[];
}

const FILE = path.resolve(env.WORK_DIR, "..", "today-picks.json");
const FIELD = "🎯 오늘의 3개";
const MAX_OPTIONS = 25; // Discord 선택 메뉴의 한도
const MAX_PICKS = 3;
const KEEP_DAYS = 7;

/** 읽고·고치고·쓰기를 한 틱에 끝낸다. */
function update<T>(change: (days: Record<string, Day>) => T): T {
  const days = readJsonObject<Day>(FILE);
  const result = change(days);
  // 자동 데일리 기록이 다음 날 새벽에 어제 것을 읽는다. 며칠 지난 날만 지운다.
  const oldest = new Date(Date.now() + (9 - 24 * KEEP_DAYS) * 3600_000).toISOString().slice(0, 10);
  writeJsonObject(FILE, Object.fromEntries(Object.entries(days).filter(([date]) => date >= oldest)));
  return result;
}

/** 그 날짜(KST)에 고른 할 일들. 체크인과 자동 데일리 기록이 읽는다. */
export function getTodayPicks(date: string): TodayTask[] {
  return readJsonObject<Day>(FILE)[date]?.picks ?? [];
}

const taskId = (note: string, text: string) =>
  createHash("sha1").update(`${note}\n${text}`).digest("hex").slice(0, 8);

/** active 에 든 프로젝트의 노트를 그 순서대로 앞에 세운다. 나머지 노트는 볼트 순서 그대로 뒤에 온다. */
export function activeFirst<N extends { note: string; slug?: string }>(notes: N[], active: string[]): N[] {
  const slugs = active.map((slug) => slug.toLowerCase());
  const rank = (n: N) => {
    const index = slugs.indexOf((n.slug ?? n.note).toLowerCase());
    return index < 0 ? slugs.length : index;
  };
  return [...notes].sort((a, b) => rank(a) - rank(b));
}

/**
 * 고르기 메뉴의 후보를 이 순서로 limit 개까지: 어젯밤 정한 "내일 첫 작업" → 마감이 지났거나 7일 안인 할 일(마감 순)
 * → 최근 커밋한 프로젝트의 첫 할 일(커밋이 많은 순) → 나머지 노트의 첫 할 일 → 둘째 할 일 …
 * 마감일이 하나도 없어도 노트 이름순이 아니라 손대고 있는 일이 위에 오게 한다. 같은 할 일은 한 번만 나온다.
 */
export function pickCandidates(vault: VaultState, order: PickOrder = {}, limit = MAX_OPTIONS): TodayTask[] {
  const notes = activeFirst(vault.notes, order.active ?? []).map((n) =>
    n.tasks.map(
      (task): TodayTask => ({
        id: taskId(n.note, task.text),
        projectSlug: n.slug ?? n.note,
        note: n.note,
        text: task.text,
        ...(task.due ? { due: task.due } : {}),
      }),
    ),
  );
  const all = notes.flat();
  // 그 할 일이 밤사이 완료·수정·보류됐으면 여기서 찾지 못해 맨 앞 자리는 없다.
  const firstId = order.first && taskId(order.first.note, order.first.text);
  const urgent = all
    .filter((task) => task.due && daysUntil(task.due) <= 7)
    .sort((a, b) => (a.due ?? "").localeCompare(b.due ?? ""));
  const depth = Math.max(0, ...notes.map((tasks) => tasks.length));
  const rounds = Array.from({ length: depth }, (_, i) => notes.flatMap((tasks) => tasks[i] ?? []));
  const unique = new Map(
    [...all.filter((task) => task.id === firstId), ...urgent, ...rounds.flat()].map((task) => [task.id, task]),
  );
  return [...unique.values()].slice(0, limit);
}

/**
 * 다이제스트의 "오늘 할 일 고르기" 메뉴. 그날의 후보를 새로 뽑아 저장하고(이미 고른 것은 그대로 둔다)
 * 후보가 없으면 null. 보류한 할 일은 후보에서 빠진다. 어젯밤 정한 첫 작업이 후보에 있으면 미리 골라 둔다.
 */
export function todayPickMenu(
  vault: VaultState,
  date: string,
  order: PickOrder = {},
): ActionRowBuilder<StringSelectMenuBuilder> | null {
  const candidates = pickCandidates(withoutSnoozed(vault), order);
  if (candidates.length === 0) return null;
  const preselected = order.first && taskId(order.first.note, order.first.text);
  update((days) => {
    days[date] = { candidates, picks: days[date]?.picks ?? [] };
  });
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`today:pick:${date}`)
      .setPlaceholder("🎯 오늘 할 일 고르기 (최대 3개)")
      .setMinValues(1)
      .setMaxValues(Math.min(MAX_PICKS, candidates.length))
      .addOptions(
        candidates.map((task) => ({
          label: clip(task.text, 100),
          description: clip(`${task.note}${task.due ? ` · 📅 ${task.due.slice(5)}` : ""}`, 100),
          value: task.id,
          ...(task.id === preselected ? { default: true } : {}),
        })),
      ),
  );
}

/** 임베드의 "🎯 오늘의 3개" 칸: 고른 순서대로 번호를 붙이고 끝낸 것은 ✅. 고른 것이 없으면 null. */
export function todayPicksField(date: string): { name: string; value: string } | null {
  const picks = getTodayPicks(date);
  if (picks.length === 0) return null;
  const lines = picks.map((pick, i) => {
    const due = pick.due ? ` (📅 ${pick.due.slice(5)})` : "";
    return `${i + 1}. ${pick.done ? "✅ " : ""}**${pick.note}** · ${clip(pick.text, 200)}${due}`;
  });
  return { name: FIELD, value: clip(lines.join("\n"), 1000) };
}

/** 체크인 메시지의 완료 버튼 줄: 아직 끝내지 않은 것만 `✅ n`. 번호는 "🎯 오늘의 3개" 칸의 번호다. */
export function todayDoneRows(date: string): Array<ActionRowBuilder<ButtonBuilder>> {
  const buttons = getTodayPicks(date).flatMap((pick, i) =>
    pick.done
      ? []
      : [
          new ButtonBuilder()
            // 번호가 아니라 id 로 가리킨다: 체크인 뒤에 다시 골라도 다른 할 일이 완료되지 않는다.
            .setCustomId(`today:done:${date}:${pick.id}`)
            .setLabel(`✅ ${i + 1}`)
            .setStyle(ButtonStyle.Success),
        ],
  );
  return buttons.length > 0 ? [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)] : [];
}

/** 첫 임베드에 같은 이름의 칸이 있으면 바꾸고 없으면 붙인다. 나머지 임베드는 그대로 둔다. */
function withField(
  embeds: readonly Embed[],
  field: { name: string; value: string },
): Array<EmbedBuilder | Embed> {
  const first = EmbedBuilder.from(embeds[0] ?? {});
  first.setFields([...(first.data.fields ?? []).filter((f) => f.name !== field.name), field]);
  return [first, ...embeds.slice(1)];
}

/** 다이제스트 메뉴(`today:pick:<날짜>`)에서 고른 것을 그날의 3개로 저장하고 메시지에 적는다. 메뉴는 남아 다시 고를 수 있다. */
export async function pickToday(interaction: StringSelectMenuInteraction): Promise<void> {
  // 자정을 넘겨 골라도 그 다이제스트의 날짜로 남는다.
  const date = interaction.customId.split(":")[2] ?? "";
  const saved = update((days) => {
    const day = days[date];
    // 이미 고른 것은 완료 표시를 잃지 않게 그대로 가져온다.
    const picks = interaction.values.flatMap(
      (id) => day?.picks.find((p) => p.id === id) ?? day?.candidates.find((c) => c.id === id) ?? [],
    );
    if (day && picks.length > 0) day.picks = picks.slice(0, MAX_PICKS);
    return picks.length > 0;
  });
  const field = todayPicksField(date);
  if (!saved || !field) {
    await interaction.reply({
      content: "이 목록은 만료됨 — `/digest` 로 새 목록을 받아주세요",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.update({ embeds: withField(interaction.message.embeds, field) });
}

const isDoneRow = (row: TopLevelComponent) =>
  row.type === ComponentType.ActionRow &&
  row.components.some((component) => component.customId?.startsWith("today:done:"));

/**
 * 체크인의 `✅ n` 버튼(`today:done:<날짜>:<id>`): 볼트의 체크박스를 완료하고 그날의 3개에 표시한 뒤
 * 메시지의 칸과 버튼을 고친다. 회고 버튼과 "내일 첫 작업" 후보는 그대로 남는다.
 */
export async function completeTodayPick(interaction: ButtonInteraction): Promise<void> {
  const [, , date = "", id] = interaction.customId.split(":");
  const pick = getTodayPicks(date).find((p) => p.id === id);
  if (!pick) {
    await interaction.reply({
      content: "이 할 일은 그날의 3개에 없습니다 (다시 골랐거나 7일이 지남)",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  // 볼트 커밋·push 는 3초를 넘긴다.
  await interaction.deferUpdate();
  if (!pick.done) {
    let changed: boolean;
    try {
      changed = (await completeVaultTask(pick)).changed;
    } catch {
      // 원인은 mutation layer 가 이미 Sentry 에 남겼다.
      await interaction.followUp({
        content: "⚠️ 볼트에 반영하지 못했습니다. 잠시 후 다시 눌러주세요.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (changed) {
      // 원본 커밋은 성공했다. 파생 스냅샷 갱신이 실패해도 다음 맥 동기화가 바로잡는다.
      await completeCapturedVaultTask(pick.note, pick.projectSlug, pick.text).catch((err) =>
        console.warn("[today] vault snapshot update failed:", err),
      );
    } else if (!getTodayPicks(date).find((p) => p.id === id)?.done) {
      // 옵시디언에서 이미 체크했거나 문장을 고친 경우다. 다시 눌러도 같으니 완료로 표시하고 알린다.
      // (같은 버튼을 연달아 두 번 누른 것이면 먼저 누른 쪽이 이미 완료했으니 알리지 않는다.)
      await interaction.followUp({
        content: `**${pick.note}** 노트에 이 할 일의 열린 체크박스가 없어 볼트는 그대로 두었습니다 (이미 완료했거나 문장이 바뀜). 오늘의 3개에는 완료로 표시합니다.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    update((days) => {
      const done = days[date]?.picks.find((p) => p.id === id);
      if (done) done.done = true;
    });
  }
  await editInOrder(async () => {
    // 완료를 기다리는 사이 다른 버튼이 메시지를 바꿨을 수 있다. 지금의 메시지를 다시 읽어 그 위에 고친다.
    const message = await interaction.fetchReply();
    const field = todayPicksField(date);
    await interaction.editReply({
      ...(field ? { embeds: withField(message.embeds, field) } : {}),
      components: [...message.components.filter((row) => !isDoneRow(row)), ...todayDoneRows(date)],
    });
  });
}
