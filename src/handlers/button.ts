import { ChannelType, MessageFlags, type ButtonInteraction } from "discord.js";
import { env } from "../env.js";
import { resolvePending, type PermissionDecision } from "../agent/permissions.js";
import { spawnSessionThread } from "../agent/bootstrap.js";
import { findProject } from "../projects.js";
import { deletePendingAction, getPendingAction } from "../webhook/pending.js";
import { buildCheckinModal } from "../checkin/index.js";
import { fetchInboxChannel } from "../discord/alerts.js";
import { dueCards, gradeCard } from "../jp/cards.js";
import type { Grade } from "../jp/srs.js";

export async function handleButton(interaction: ButtonInteraction): Promise<void> {
  if (interaction.user.id !== env.OWNER_DISCORD_ID) {
    await interaction.reply({ content: "권한 없음", flags: MessageFlags.Ephemeral });
    return;
  }
  const [kind, action, id] = interaction.customId.split(":");

  if (kind === "perm") {
    const decision = action as PermissionDecision;
    const handled = await resolvePending(id, decision);
    if (!handled) {
      await interaction.reply({ content: "이미 처리됐거나 만료됨", flags: MessageFlags.Ephemeral });
      return;
    }
    const label =
      decision === "approve"
        ? "✅ 승인"
        : decision === "approve-once"
          ? "✅ 1회 승인"
          : "❌ 거부";
    await interaction.update({
      content: `${label} (by ${interaction.user.username})`,
      components: [],
    });
    return;
  }

  if (kind === "triage") {
    await handleTriage(interaction, action, id);
    return;
  }

  if (kind === "checkin" && action === "open") {
    await interaction.showModal(buildCheckinModal(id ?? ""));
    return;
  }

  if (kind === "til" && action === "save") {
    await handleTilSave(interaction, id);
    return;
  }

  if (kind === "jp") {
    await gradeCard(Number(id), action as Grade, new Date());
    const remaining = (await dueCards(new Date(), 1)).length;
    await interaction.update({
      content: remaining ? "✅ 채점됨 — `/jp review`로 계속." : "✅ 채점됨 — 오늘 복습 끝 🎉",
      components: [],
    });
    return;
  }
}

async function handleTilSave(
  interaction: ButtonInteraction,
  id: string | undefined,
): Promise<void> {
  const pending = id ? getPendingAction(id) : undefined;
  if (!pending) {
    await interaction.reply({
      content: "이 요약은 만료됨 (24h TTL 또는 봇 재시작)",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const channel = await fetchInboxChannel();
  if (!channel) {
    await interaction.reply({ content: "⚠️ 인박스 채널 없음", flags: MessageFlags.Ephemeral });
    return;
  }
  await channel.send(`📥 [til] (${pending.projectSlug}) ${pending.prompt}`.slice(0, 1900));
  if (id) deletePendingAction(id);
  await interaction.update({ components: [] });
  await interaction.followUp({
    content: "📚 인박스 큐에 넣음 — 스위퍼가 볼트로 정리합니다",
    flags: MessageFlags.Ephemeral,
  });
}

async function handleTriage(
  interaction: ButtonInteraction,
  action: string | undefined,
  id: string | undefined,
): Promise<void> {
  if (!id) {
    await interaction.reply({ content: "잘못된 버튼", flags: MessageFlags.Ephemeral });
    return;
  }
  if (action === "ack") {
    deletePendingAction(id);
    await interaction.update({
      content: `✅ ack — ${interaction.user.username}`,
      components: [],
    });
    return;
  }
  if (action === "start") {
    const pending = getPendingAction(id);
    if (!pending) {
      await interaction.reply({
        content: "이 알림은 만료됨 (30분 TTL 또는 봇 재시작)",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const channel = interaction.channel;
    if (!channel || channel.type !== ChannelType.GuildText) {
      await interaction.reply({
        content: "트리아지는 텍스트 채널 알림에서만 가능",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.deferReply();
    const thread = await spawnSessionThread({
      parent: channel,
      threadName: pending.threadName,
      projectSlug: pending.projectSlug,
      permissionMode: "acceptEdits",
      prompt: pending.prompt,
      ...(pending.sourceTask ? { sourceTask: pending.sourceTask } : {}),
    });
    deletePendingAction(id);
    const projectName = findProject(pending.projectSlug)?.name ?? pending.projectSlug;
    await interaction.editReply({
      content: `🔧 ${projectName} 세션 시작 → ${thread}`,
    });
  }
}
