// #상태판: 봇이 고쳐 쓰는 메시지 하나. 알림을 거슬러 읽지 않고 "지금 어떤가"를 보는 곳이다.
// 인스타 현황은 워치독이 생존 신호(15분)에 실어 보내고, 서비스 상태는 봇의 uptime 감시에서 온다.
// 고쳐 쓰기는 푸시를 만들지 않는다.

import { EmbedBuilder, MessageFlags } from "discord.js";
import path from "node:path";
import { fetchTextChannel } from "../discord/alerts.js";
import { env } from "../env.js";
import { readJsonObject, writeJsonObject } from "../storage/json-file.js";
import { getVaultState } from "../vault/state.js";
import { getUptimeSnapshot } from "./uptime.js";

const FILE = path.resolve(env.WORK_DIR, "..", "status-board.json");
const ICON = { healthy: "🟢", down: "🔴", stale: "🟡", unknown: "⚪" } as const;
const UNKNOWN_MESSAGE = 10008; // Discord API: 메시지가 지워졌다
const BRIEF_STALE_MS = 2 * 3600_000;
const VAULT_STALE_MS = 26 * 3600_000;

export function buildStatusBoard(instagram: string | null, now = Date.now()): EmbedBuilder {
  const services = getUptimeSnapshot(now).map((entry) => {
    const target = entry.checkName ? `${entry.slug}/${entry.checkName}` : entry.slug;
    const detail = entry.status === "down" || entry.status === "stale" ? ` (${entry.detail.slice(0, 80)})` : "";
    return `${ICON[entry.status]} ${target}${detail}`;
  });
  const vaultSyncedAt = Date.parse(getVaultState()?.generatedAt ?? "");
  const watch = [`워치독 확인 <t:${Math.floor(now / 1000)}:R>`];
  if (!Number.isNaN(vaultSyncedAt)) {
    // 맥 크론이 하루 세 번 보낸다. 하루 넘게 끊기면 다이제스트의 마감·할 일이 낡은 것이다.
    const stale = now - vaultSyncedAt > VAULT_STALE_MS ? "🟡 " : "";
    watch.push(`${stale}볼트 동기화 <t:${Math.floor(vaultSyncedAt / 1000)}:R>`);
  }
  const fields = [
    { name: "인스타 게시 (게시/예정)", value: instagram ?? "워치독 현황을 아직 받지 못했습니다." },
    { name: "서비스", value: services.join(" · ").slice(0, 1000) || "감시 대상 없음" },
    { name: "감시", value: watch.join(" · ") },
  ];
  const body = fields.map((field) => field.value).join("\n");
  return new EmbedBuilder()
    .setColor(body.includes("🔴") ? 0xed4245 : body.includes("🟡") ? 0xfee75c : 0x57f287)
    .setTitle("📊 상태판")
    .addFields(fields)
    .setFooter({ text: "15분마다 갱신 · 조치할 일은 #조치-필요" })
    .setTimestamp(now);
}

/** 상태판 메시지를 고쳐 쓴다. 처음이거나 메시지가 지워졌으면 새로 올린다. */
export async function updateStatusBoard(instagram: string | null): Promise<void> {
  if (!env.STATUS_CHANNEL_ID) return;
  const channel = await fetchTextChannel(env.STATUS_CHANNEL_ID, "status");
  if (!channel) return;
  const embeds = [buildStatusBoard(instagram)];
  const { messageId } = readJsonObject<string>(FILE);
  if (messageId) {
    try {
      await channel.messages.edit(messageId, { embeds });
      return;
    } catch (err) {
      // 일시 오류에 새 메시지를 올리면 상태판이 둘이 된다. 다음 생존 신호에서 다시 고친다.
      if ((err as { code?: unknown }).code !== UNKNOWN_MESSAGE) throw err;
    }
  }
  const sent = await channel.send({ embeds, flags: MessageFlags.SuppressNotifications });
  writeJsonObject(FILE, { ...readJsonObject<string>(FILE), messageId: sent.id });
}

/** 워치독이 생존 신호에 실어 보낸 어제 게시 실적을 아침 다이제스트 때까지 보관한다. */
export function saveInstagramBrief(brief: string, now = Date.now()): void {
  writeJsonObject(FILE, { ...readJsonObject<string>(FILE), brief, briefAt: new Date(now).toISOString() });
}

/** 아침 다이제스트에 넣을 인스타 게시 실적. 워치독이 오래 조용했으면 그 사실을 앞에 적는다. */
export function getInstagramBrief(now = Date.now()): string | null {
  const { brief, briefAt } = readJsonObject<string>(FILE);
  if (!brief) return null;
  const at = Date.parse(briefAt ?? "");
  return now - at > BRIEF_STALE_MS
    ? `⚠️ 워치독 현황이 <t:${Math.floor(at / 1000)}:R> 이후 오지 않았습니다.\n${brief}`
    : brief;
}
