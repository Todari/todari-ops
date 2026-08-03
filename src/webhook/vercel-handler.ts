import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type Message } from "discord.js";
import { findProjectByLooseName, type ProjectConfig } from "../projects.js";
import { probe } from "../monitor/uptime.js";
import { fetchAlertsChannel } from "../discord/alerts.js";
import { shouldDrop } from "./dedup.js";
import { putPendingAction } from "./pending.js";
import { recordEvent } from "../stats/events.js";

// Vercel account/team-level webhook. Alerts on deployment.error /
// deployment.canceled; posts a green "recovered" note on the first successful
// deployment after a failure of the same project.

interface VercelPayload {
  type?: string;
  payload?: {
    name?: string; // vercel project name
    target?: string | null; // "production" | "staging" | null (preview)
    url?: string; // deployment url (no scheme)
    deployment?: {
      id?: string;
      url?: string;
      meta?: { githubCommitMessage?: string; githubCommitRef?: string };
    };
    links?: { deployment?: string; project?: string };
    project?: { id?: string };
  };
}

// Last deploy outcome per vercel project name — drives the recovery message.
const lastFailed = new Set<string>();

export async function handleVercelEvent(payload: unknown): Promise<void> {
  const p = (payload ?? {}) as VercelPayload;
  const type = p.type ?? "";
  const name = p.payload?.name ?? "?";
  const target = p.payload?.target ?? "preview";
  const deployId = p.payload?.deployment?.id ?? p.payload?.url ?? "dep";
  const inspectUrl = p.payload?.links?.deployment;
  const commitMsg = p.payload?.deployment?.meta?.githubCommitMessage?.split("\n")[0];
  const branch = p.payload?.deployment?.meta?.githubCommitRef;

  const failed = type === "deployment.error" || type === "deployment.canceled";
  const succeeded = type === "deployment.succeeded";
  if (!failed && !succeeded) return;
  // Preview 배포는 실패만 알림, 성공은 프로덕션 복구 알림에만 사용.
  if (shouldDrop(`vercel:${type}:${deployId}`)) return;

  const project = findProjectByLooseName(name);

  if (succeeded) {
    if (target === "production") recordEvent("vercel_deploy", project?.slug ?? name);
    const wasFailed = lastFailed.has(name);
    lastFailed.delete(name);
    // 복구는 항상 알리고, 평상시 프로덕션 성공은 컴팩트 초록 한 줄.
    if (!wasFailed && target !== "production") return;
    const channel = await fetchAlertsChannel();
    if (!channel) return;
    const embed = new EmbedBuilder()
      .setColor(0x22c55e)
      .setTitle(
        wasFailed
          ? `🟢 [${project?.name ?? name}] Vercel 배포 복구됨 (${target})`
          : `🟢 [${project?.name ?? name}] 프로덕션 배포 완료`,
      )
      .setDescription(commitMsg ? `\`${branch ?? "?"}\` ${commitMsg}` : null);
    if (inspectUrl) embed.setURL(inspectUrl);
    const sent = await channel.send({ embeds: [embed] });
    // 배포 후 스모크 체크: Vercel 말만 믿지 않고 실제 프로덕션 URL 확인.
    if (target === "production" && project?.healthUrl) {
      void smokeCheck(sent, project.healthUrl);
    }
    return;
  }

  lastFailed.add(name);
  recordEvent("vercel_fail", project?.slug ?? name);
  const channel = await fetchAlertsChannel();
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setColor(0xef4444)
    .setTitle(`🚨 [${project?.name ?? name}] Vercel 배포 실패 (${target})`)
    .addFields(
      { name: "event", value: type, inline: true },
      { name: "branch", value: branch ?? "?", inline: true },
      { name: "commit", value: truncate(commitMsg ?? "?", 100), inline: true },
    )
    .setFooter({ text: project?.slug ?? name });
  if (inspectUrl) embed.setURL(inspectUrl);

  const row = new ActionRowBuilder<ButtonBuilder>();
  if (project) {
    const id = putPendingAction({
      projectSlug: project.slug,
      threadName: `deploy-fail/${project.slug}/${String(deployId).slice(-8)}`,
      prompt: buildDeployFailPrompt(project, type, branch, commitMsg, inspectUrl),
    });
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`triage:start:${id}`)
        .setLabel("🔧 Triage in /code")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`triage:ack:${id}`).setLabel("✅ Ack").setStyle(ButtonStyle.Secondary),
    );
  }
  if (inspectUrl) {
    row.addComponents(
      new ButtonBuilder().setLabel("Open in Vercel").setStyle(ButtonStyle.Link).setURL(inspectUrl),
    );
  }
  await channel.send({
    embeds: [embed],
    components: row.components.length > 0 ? [row] : [],
  });
}

function buildDeployFailPrompt(
  project: ProjectConfig,
  type: string,
  branch: string | undefined,
  commitMsg: string | undefined,
  inspectUrl: string | undefined,
): string {
  return [
    "[Vercel 배포 실패 트리아지]",
    `프로젝트: ${project.name} (${project.slug})`,
    `이벤트: ${type} / 브랜치: ${branch ?? "?"}`,
    commitMsg ? `커밋: ${commitMsg}` : "",
    inspectUrl ? `Vercel: ${inspectUrl}` : "",
    "",
    "최근 커밋을 확인하고 빌드가 깨진 원인을 찾아줘. 로컬에서 빌드를 재현해보고",
    "(pnpm/npm build), 고칠 수 있으면 fix 를 제안해줘.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

async function smokeCheck(message: Message, healthUrl: string): Promise<void> {
  await new Promise((r) => setTimeout(r, 15_000)); // alias 전파 여유
  const result = await probe(healthUrl);
  try {
    const base = message.embeds[0];
    const embed = EmbedBuilder.from(base).addFields({
      name: "스모크 체크",
      value: result.ok ? `✅ ${healthUrl} (${result.detail})` : `🔴 ${healthUrl} (${result.detail}) — 배포됐지만 응답 이상`,
    });
    if (!result.ok) embed.setColor(0xef4444);
    await message.edit({ embeds: [embed] });
  } catch (err) {
    console.warn("[vercel] smoke check edit failed:", err);
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
