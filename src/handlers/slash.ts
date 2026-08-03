import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  type ChatInputCommandInteraction,
} from "discord.js";
import { env } from "../env.js";
import { findProject } from "../projects.js";
import {
  getSession,
  updatePermissionMode,
  endSession,
  type PermissionMode,
} from "../storage/sessions.js";
import { EmbedBuilder } from "discord.js";
import { cancelActiveTurn, isTurnActive } from "../agent/run.js";
import { spawnSessionThread } from "../agent/bootstrap.js";
import { postDigest } from "../digest/daily.js";
import { postWeekly } from "../digest/weekly.js";
import { fetchInboxChannel } from "../discord/alerts.js";
import { getUptimeSnapshot } from "../monitor/uptime.js";
import { listSessions } from "../storage/sessions.js";
import { addReminder, parseFireAt } from "../reminders/index.js";
import { postSessionSummary } from "../agent/summary.js";
import { postCheckinPrompt } from "../checkin/index.js";
import {
  collectDeadlines,
  ddayLabel,
  getVaultState,
  vaultAgeHours,
} from "../vault/state.js";
import { answerQuestion, correctSentence } from "../jp/tutor.js";
import { dueCards, insertMistake } from "../jp/cards.js";

export async function handleSlash(interaction: ChatInputCommandInteraction): Promise<void> {
  if (interaction.user.id !== env.OWNER_DISCORD_ID) {
    await interaction.reply({ content: "권한 없음", flags: MessageFlags.Ephemeral });
    return;
  }

  switch (interaction.commandName) {
    case "ping":
      await interaction.reply({ content: "pong 🏓", flags: MessageFlags.Ephemeral });
      return;
    case "code":
      await handleCode(interaction);
      return;
    case "perm":
      await handlePerm(interaction);
      return;
    case "cancel":
      await handleCancel(interaction);
      return;
    case "end":
      await handleEnd(interaction);
      return;
    case "digest":
      await handleDigest(interaction);
      return;
    case "task":
      await handleCapture(interaction, "task");
      return;
    case "idea":
      await handleCapture(interaction, "idea");
      return;
    case "note":
      await handleCapture(interaction, "note");
      return;
    case "status":
      await handleStatus(interaction);
      return;
    case "week":
      await handleWeek(interaction);
      return;
    case "remind":
      await handleRemind(interaction);
      return;
    case "sessions":
      await handleSessions(interaction);
      return;
    case "checkin":
      await handleCheckin(interaction);
      return;
    case "jp":
      await handleJp(interaction);
      return;
    default:
      await interaction.reply({ content: `unknown: ${interaction.commandName}`, flags: MessageFlags.Ephemeral });
  }
}

async function handleCode(interaction: ChatInputCommandInteraction): Promise<void> {
  const slug = interaction.options.getString("project", true);
  const prompt = interaction.options.getString("prompt", true);
  const mode = (interaction.options.getString("mode") ?? "default") as PermissionMode;
  const project = findProject(slug);
  if (!project) {
    await interaction.reply({ content: `unknown project: ${slug}`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (!interaction.channel || interaction.channel.type !== ChannelType.GuildText) {
    await interaction.reply({ content: "텍스트 채널에서만 사용 가능", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply();
  const thread = await spawnSessionThread({
    parent: interaction.channel,
    threadName: `${slug}/${truncate(prompt, 80)}`,
    projectSlug: slug,
    permissionMode: mode,
    prompt,
  });
  const modeLabel = mode === "default" ? "" : ` (mode: \`${mode}\`)`;
  await interaction.editReply({ content: `🚀 ${project.name} 세션 시작${modeLabel} → ${thread}` });
}

async function handlePerm(interaction: ChatInputCommandInteraction): Promise<void> {
  const mode = interaction.options.getString("mode", true) as PermissionMode;
  if (!interaction.channel?.isThread()) {
    await interaction.reply({ content: "스레드 안에서만 사용 가능", flags: MessageFlags.Ephemeral });
    return;
  }
  const session = await getSession(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: "이 스레드엔 세션이 없음", flags: MessageFlags.Ephemeral });
    return;
  }
  await updatePermissionMode(interaction.channelId, mode);
  await interaction.reply({ content: `🔐 권한 모드 → \`${mode}\`` });
}

async function handleCancel(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.channel?.isThread()) {
    await interaction.reply({ content: "스레드에서만 사용 가능", flags: MessageFlags.Ephemeral });
    return;
  }
  const cancelled = await cancelActiveTurn(interaction.channelId);
  await interaction.reply({
    content: cancelled ? "🛑 진행 중 턴 취소됨" : "취소할 작업 없음",
    flags: MessageFlags.Ephemeral,
  });
}

async function handleEnd(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.channel?.isThread()) {
    await interaction.reply({ content: "스레드에서만 사용 가능", flags: MessageFlags.Ephemeral });
    return;
  }
  const thread = interaction.channel;
  const session = await getSession(interaction.channelId);
  await interaction.reply({ content: "🏁 세션 종료" });
  // 세션 요약(재사용 가치 추출)은 종료 후 백그라운드로 — 메타 삭제 전에
  // session 객체를 잡아뒀으므로 resume 에 필요한 sessionId 는 살아있다.
  if (session?.sessionId && thread.isThread()) {
    void postSessionSummary(thread, session);
  }
  await endSession(interaction.channelId);
}

async function handleDigest(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const posted = await postDigest();
  await interaction.editReply({
    content: posted ? "☀️ 다이제스트 게시됨" : "⚠️ 다이제스트 채널을 찾을 수 없음",
  });
}

// /task, /idea → structured 📥 line in the inbox channel. The Mac-side daily
// sweeper (inbox-sweep skill) files them into the vault and ✅-acks them.
async function handleCapture(
  interaction: ChatInputCommandInteraction,
  kind: "task" | "idea" | "note",
): Promise<void> {
  const content = interaction.options.getString("content", true).trim();
  const project =
    kind === "task" || kind === "note" ? interaction.options.getString("project") : null;
  const channel = await fetchInboxChannel();
  if (!channel) {
    await interaction.reply({
      content: "⚠️ 인박스 채널 없음 (INBOX_CHANNEL_ID / ALERTS_CHANNEL_ID 설정 필요)",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await channel.send(`📥 [${kind}]${project ? ` (${project})` : ""} ${content}`);
  await interaction.reply({
    content: `✅ 인박스에 저장됨 — 매일 아침 스위퍼가 볼트로 정리합니다`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  const embed = new EmbedBuilder().setColor(0x60a5fa).setTitle("📊 상태 한눈에");

  const uptime = getUptimeSnapshot();
  if (uptime.length > 0) {
    embed.addFields({
      name: "uptime",
      value: uptime.map((u) => `${u.up ? "🟢" : "🔴"} ${u.slug} (${u.detail})`).join("\n"),
    });
  }

  const vault = getVaultState();
  if (vault) {
    const deadlines = collectDeadlines(vault, 7, 30).slice(0, 5);
    if (deadlines.length > 0) {
      embed.addFields({
        name: "📌 마감",
        value: deadlines
          .map((x) => `**${ddayLabel(x.d)}** ${x.date.slice(5)} · [${x.note}] ${x.text}`)
          .join("\n")
          .slice(0, 1000),
      });
    }
    const counts = vault.notes
      .filter((n) => n.tasks.length > 0)
      .map((n) => `${n.note} ${n.tasks.length}`)
      .join(" · ");
    if (counts) embed.addFields({ name: "📋 열린 할 일", value: counts.slice(0, 1000) });
    embed.setFooter({ text: `볼트 동기화 ${Math.round(vaultAgeHours(vault))}시간 전` });
  } else {
    embed.addFields({ name: "볼트", value: "동기화 데이터 없음 (Mac vault_sync 크론 대기 중)" });
  }

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleCheckin(interaction: ChatInputCommandInteraction): Promise<void> {
  const posted = await postCheckinPrompt();
  await interaction.reply({
    content: posted ? "🌙 체크인 프롬프트 게시됨" : "⚠️ 다이제스트 채널을 찾을 수 없음",
    flags: MessageFlags.Ephemeral,
  });
}

async function handleWeek(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const posted = await postWeekly();
  await interaction.editReply({
    content: posted ? "📅 주간 요약 게시됨" : "⚠️ 다이제스트 채널을 찾을 수 없음",
  });
}

async function handleRemind(interaction: ChatInputCommandInteraction): Promise<void> {
  const when = interaction.options.getString("when", true).trim();
  const content = interaction.options.getString("content", true).trim();
  const fireAt = parseFireAt(when);
  if (!fireAt) {
    await interaction.reply({
      content: "⚠️ 형식: `30m` `2h` `1d` 또는 `HH:MM` (30초~20일)",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await addReminder({ channelId: interaction.channelId, content, fireAt });
  const kst = new Date(fireAt + 9 * 3600_000).toISOString().slice(5, 16).replace("T", " ");
  await interaction.reply({
    content: `⏰ ${kst} KST 에 이 채널에서 알려드릴게요 — "${truncate(content, 80)}"`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleSessions(interaction: ChatInputCommandInteraction): Promise<void> {
  const sessions = listSessions();
  if (sessions.length === 0) {
    await interaction.reply({ content: "활성 세션 없음", flags: MessageFlags.Ephemeral });
    return;
  }
  const lines = sessions.slice(0, 20).map((s) => {
    const age = Math.round((Date.now() - s.createdAt) / 3600_000);
    const running = isTurnActive(s.threadId) ? " 🔄 실행 중" : "";
    return `<#${s.threadId}> · ${s.projectSlug} · ${age}h · \`${s.permissionMode}\`${running}`;
  });
  await interaction.reply({
    content: `**활성 세션 ${sessions.length}개** (종료는 각 스레드에서 \`/end\`)\n` + lines.join("\n"),
    flags: MessageFlags.Ephemeral,
  });
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

async function handleJp(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();
  if (sub === "ask") {
    await interaction.deferReply();
    try {
      const a = await answerQuestion(interaction.options.getString("q", true));
      await interaction.editReply(a.slice(0, 1900));
    } catch {
      await interaction.editReply("⚠️ 지금 답변을 못 만들었어요. 잠시 후 다시.");
    }
    return;
  }
  if (sub === "fix") {
    await interaction.deferReply();
    const jp = interaction.options.getString("sentence", true);
    try {
      const c = await correctSentence(jp);
      await insertMistake({ original: jp, corrected: c.corrected, reason: c.mistakes.join("; ") });
      const body =
        `**교정:** ${c.corrected}` +
        (c.natural ? `\n**자연스럽게:** ${c.natural}` : "") +
        `\n**설명:** ${c.explanation}`;
      await interaction.editReply(body.slice(0, 1900));
    } catch {
      await interaction.editReply("⚠️ 교정에 실패했어요. 잠시 후 다시.");
    }
    return;
  }
  if (sub === "review") {
    await handleJpReview(interaction); // Task 6
    return;
  }
}

async function handleJpReview(interaction: ChatInputCommandInteraction): Promise<void> {
  const cards = await dueCards(new Date(), 1);
  if (!cards.length) {
    await interaction.reply({ content: "복습할 카드 없음 🎉", flags: MessageFlags.Ephemeral });
    return;
  }
  const c = cards[0];
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`jp:again:${c.id}`).setLabel("모름").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`jp:hard:${c.id}`).setLabel("애매").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`jp:good:${c.id}`).setLabel("알았음").setStyle(ButtonStyle.Success),
  );
  await interaction.reply({
    content: `**${c.meaning}**\n||${c.front} (${c.reading}) — ${c.example}||`,
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}
