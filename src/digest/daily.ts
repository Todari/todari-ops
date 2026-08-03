import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import { env } from "../env.js";
import { findProject, projects, repoFullName } from "../projects.js";
import { fetchDigestChannel } from "../discord/alerts.js";
import { getUptimeSnapshot } from "../monitor/uptime.js";
import { captureException } from "../observability/sentry.js";
import { putPendingAction } from "../webhook/pending.js";
import { ghJson } from "../github/api.js";
import { getTodayFirstTask } from "../checkin/index.js";
import {
  collectDeadlines,
  ddayLabel,
  getVaultState,
  vaultAgeHours,
  type VaultState,
} from "../vault/state.js";

// Daily digest at DIGEST_TIME (KST, no DST): last-24h commits + open PRs per
// repo (GitHub API) + uptime snapshot. Also triggered on demand via /digest.

export function startDailyDigest(): void {
  if (!env.DIGEST_TIME) {
    console.log("[digest] disabled (DIGEST_TIME empty)");
    return;
  }
  if (!env.DIGEST_CHANNEL_ID && !env.ALERTS_CHANNEL_ID) {
    console.log("[digest] disabled (no DIGEST_CHANNEL_ID / ALERTS_CHANNEL_ID)");
    return;
  }
  scheduleNext();
}

function scheduleNext(): void {
  const delay = msUntilNextKst(env.DIGEST_TIME);
  console.log(`[digest] next run in ${Math.round(delay / 60_000)}min (${env.DIGEST_TIME} KST)`);
  setTimeout(async () => {
    try {
      await postDigest();
    } catch (err) {
      console.error("[digest] failed:", err);
      captureException(err, { kind: "digest" });
    }
    scheduleNext();
  }, delay);
}

export async function postDigest(): Promise<boolean> {
  const channel = await fetchDigestChannel();
  if (!channel) return false;

  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const repos = projects
    .map((p) => ({ project: p, fullName: repoFullName(p) }))
    .filter((r): r is { project: (typeof projects)[number]; fullName: string } =>
      Boolean(r.fullName),
    );

  const results = await Promise.all(
    repos.map(async ({ project, fullName }) => {
      const [commits, pulls] = await Promise.all([
        ghJson<Array<{ commit?: { message?: string } }>>(
          `/repos/${fullName}/commits?since=${encodeURIComponent(since)}&per_page=20`,
        ),
        ghJson<Array<{ number?: number; title?: string; html_url?: string }>>(
          `/repos/${fullName}/pulls?state=open&per_page=10`,
        ),
      ]);
      return { project, fullName, commits: commits ?? [], pulls: pulls ?? [] };
    }),
  );

  const embed = new EmbedBuilder().setColor(0xfacc15).setTitle("☀️ 데일리 다이제스트");

  // 어젯밤 체크인에서 정한 "내일 첫 작업"이 있으면 맨 위에.
  const firstTask = getTodayFirstTask();
  if (firstTask) {
    embed.addFields({ name: "🎯 오늘 첫 작업 (어제 체크인)", value: truncate(firstTask, 1000) });
  }

  // --- vault sections (pushed by Mac cron; may be absent/stale) ---
  const vault = getVaultState();
  const isMondayKst = new Date(Date.now() + 9 * 3600_000).getUTCDay() === 1;
  if (vault && isMondayKst) {
    const week = collectDeadlines(vault, 0, 7);
    const dueTasks = vault.notes.flatMap((n) =>
      n.tasks.filter((t) => t.due).map((t) => ({ note: n.note, ...t })),
    );
    const lines = [
      ...week.map((x) => `**${ddayLabel(x.d)}** ${x.date.slice(5)} · [${x.note}] ${x.text}`),
      ...(week.length === 0 ? ["이번 주 마감 없음"] : []),
      `열린 할 일 ${vault.notes.reduce((s, n) => s + n.tasks.length, 0)}개 (날짜 지정 ${dueTasks.length}개)`,
    ];
    embed.addFields({ name: "🗓 월요일 킥오프 — 이번 주", value: truncate(lines.join("\n"), 1000) });
  }
  if (vault) {
    const deadlines = collectDeadlines(vault, 7, 30).slice(0, 8);
    if (deadlines.length > 0) {
      embed.addFields({
        name: "📌 다가오는 마감",
        value: truncate(
          deadlines
            .map((x) => `**${ddayLabel(x.d)}** ${x.date.slice(5)} · [${x.note}] ${x.text}`)
            .join("\n"),
          1000,
        ),
      });
    }
    const taskLines: string[] = [];
    for (const n of vault.notes) {
      for (const t of n.tasks.slice(0, 2)) {
        taskLines.push(`**${n.note}** · ${t.text}${t.due ? ` (📅 ${t.due.slice(5)})` : ""}`);
      }
    }
    if (taskLines.length > 0) {
      embed.addFields({ name: "📋 다음 할 일 (노트당 top 2)", value: truncate(taskLines.join("\n"), 1000) });
    }
    const age = vaultAgeHours(vault);
    if (age > 36) {
      embed.setFooter({ text: `⚠️ 볼트 데이터 ${Math.round(age)}시간 전 기준 — Mac 동기화 확인 필요` });
    }
  }

  const quiet: string[] = [];
  for (const r of results) {
    const hasActivity = r.commits.length > 0 || r.pulls.length > 0;
    if (!hasActivity) {
      quiet.push(r.project.slug);
      continue;
    }
    const lines: string[] = [];
    if (r.commits.length > 0) {
      lines.push(`커밋 ${r.commits.length}개 (24h)`);
      for (const c of r.commits.slice(0, 3)) {
        lines.push(`• ${truncate(c.commit?.message?.split("\n")[0] ?? "?", 60)}`);
      }
      if (r.commits.length > 3) lines.push(`• … 외 ${r.commits.length - 3}개`);
    }
    if (r.pulls.length > 0) {
      lines.push(`열린 PR ${r.pulls.length}개`);
      for (const pr of r.pulls.slice(0, 3)) {
        lines.push(`• [#${pr.number} ${truncate(pr.title ?? "", 50)}](${pr.html_url})`);
      }
    }
    embed.addFields({
      name: `${r.project.name} (${r.project.slug})`,
      value: truncate(lines.join("\n"), 1000),
    });
  }
  if (quiet.length > 0) {
    embed.addFields({ name: "변화 없음", value: quiet.join(", ") });
  }

  const uptime = getUptimeSnapshot();
  if (uptime.length > 0) {
    embed.addFields({
      name: "uptime",
      value: uptime.map((u) => `${u.up ? "🟢" : "🔴"} ${u.slug} (${u.detail})`).join("\n"),
    });
  }

  const components = vault ? buildTaskButtons(vault) : [];
  await channel.send({ embeds: [embed], components });
  void updateDailyTopic();
  return true;
}

// #daily 채널 토픽에 D-day 요약을 유지한다 (Manage Channels 필요).
// 호출처: 다이제스트 게시 후 + vault-sync 수신 후. 토픽 PATCH는 채널당
// 10분에 2회 rate limit — 값이 같으면 건너뛴다.
export async function updateDailyTopic(): Promise<void> {
  try {
    const vault = getVaultState();
    if (!vault) return;
    const channel = await fetchDigestChannel();
    if (!channel) return;
    const deadlines = collectDeadlines(vault, 0, 60).slice(0, 2);
    const tasks = vault.notes.reduce((s, n) => s + n.tasks.length, 0);
    const parts = deadlines.map(
      (x) => `${ddayLabel(x.d)} ${truncate(x.text, 24)}(${x.date.slice(5)})`,
    );
    parts.push(`열린 할 일 ${tasks}`);
    const topic = `📌 ${parts.join(" · ")} — 08:30 자동 브리핑, /digest 즉시`;
    if (channel.topic === topic) return;
    await channel.setTopic(topic.slice(0, 1024));
    console.log("[topic] #daily updated");
  } catch (err) {
    console.warn("[topic] update failed:", err);
  }
}

// One-tap "start this task as a /code session" buttons for the top tasks that
// map to catalog projects. 12h TTL so a late-morning tap still works.
const TASK_BUTTON_TTL_MS = 12 * 3600_000;

function buildTaskButtons(vault: VaultState): Array<ActionRowBuilder<ButtonBuilder>> {
  const candidates: Array<{ slug: string; note: string; text: string; due?: string }> = [];
  for (const n of vault.notes) {
    const slug = n.slug ?? n.note;
    if (!findProject(slug)) continue;
    for (const t of n.tasks.slice(0, 2)) {
      candidates.push({ slug, note: n.note, text: t.text, due: t.due });
    }
  }
  candidates.sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"));
  const top = candidates.slice(0, 3);
  if (top.length === 0) return [];

  const row = new ActionRowBuilder<ButtonBuilder>();
  for (const c of top) {
    const project = findProject(c.slug)!;
    const id = putPendingAction(
      {
        projectSlug: c.slug,
        threadName: `task/${c.slug}/${truncate(c.text, 40)}`,
        prompt: [
          "[볼트 태스크]",
          `프로젝트: ${project.name} (${c.slug})`,
          `할 일: ${c.text}`,
          "",
          `볼트 노트 프로젝트/${c.note}.md 의 '다음 할 일' 항목이다. 이 작업을 진행해줘.`,
          "범위를 파악하고 필요하면 계획을 세운 뒤 구현·검증까지. 완료하면 마지막에",
          "무엇을 했는지 3줄로 요약해줘 (볼트 체크는 사람이 한다).",
        ].join("\n"),
      },
      TASK_BUTTON_TTL_MS,
    );
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`triage:start:${id}`)
        .setLabel(truncate(`▶ ${c.slug}: ${c.text}`, 78))
        .setStyle(ButtonStyle.Primary),
    );
  }
  return [row];
}

// KST is fixed UTC+9 (no DST) — compute next HH:MM occurrence.
function msUntilNextKst(hhmm: string): number {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  const hours = m ? Number(m[1]) : 8;
  const minutes = m ? Number(m[2]) : 30;
  const nowShifted = new Date(Date.now() + 9 * 3600_000);
  const target = new Date(nowShifted);
  target.setUTCHours(hours, minutes, 0, 0);
  if (target.getTime() <= nowShifted.getTime()) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  return target.getTime() - nowShifted.getTime();
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
