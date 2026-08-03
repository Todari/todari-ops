import { EmbedBuilder } from "discord.js";
import { projects, repoFullName } from "../projects.js";
import { fetchDigestChannel } from "../discord/alerts.js";
import { ghJson } from "../github/api.js";
import { eventsSince, type EventKind } from "../stats/events.js";
import { collectDeadlines, ddayLabel, getVaultState } from "../vault/state.js";
import { captureException } from "../observability/sentry.js";

// 금요일 18:00 KST 주간 요약: 레포별 7일 커밋·머지 PR(GitHub API) +
// 봇이 관측한 운영 이벤트(장애·CI 실패·배포) + 다음 주 마감. /week 로 수동 게시.

const WEEK_MS = 7 * 86_400_000;

export function startWeeklySummary(): void {
  scheduleNext();
}

function scheduleNext(): void {
  const delay = msUntilFridayKst(18, 0);
  console.log(`[weekly] next run in ${Math.round(delay / 3600_000)}h (금 18:00 KST)`);
  setTimeout(async () => {
    try {
      await postWeekly();
    } catch (err) {
      console.error("[weekly] failed:", err);
      captureException(err, { kind: "weekly" });
    }
    scheduleNext();
  }, delay);
}

export async function postWeekly(): Promise<boolean> {
  const channel = await fetchDigestChannel();
  if (!channel) return false;

  const since = new Date(Date.now() - WEEK_MS).toISOString();
  const repos = projects
    .map((p) => ({ project: p, fullName: repoFullName(p) }))
    .filter((r): r is { project: (typeof projects)[number]; fullName: string } =>
      Boolean(r.fullName),
    );

  const rows = await Promise.all(
    repos.map(async ({ project, fullName }) => {
      const [commits, closedPrs] = await Promise.all([
        ghJson<unknown[]>(
          `/repos/${fullName}/commits?since=${encodeURIComponent(since)}&per_page=100`,
        ),
        ghJson<Array<{ merged_at?: string | null }>>(
          `/repos/${fullName}/pulls?state=closed&sort=updated&direction=desc&per_page=30`,
        ),
      ]);
      const merged = (closedPrs ?? []).filter(
        (pr) => pr.merged_at && Date.parse(pr.merged_at) >= Date.now() - WEEK_MS,
      ).length;
      return { project, commits: commits?.length ?? 0, merged };
    }),
  );

  const kst = (ms: number) => new Date(ms + 9 * 3600_000).toISOString().slice(5, 10);
  const embed = new EmbedBuilder()
    .setColor(0xa78bfa)
    .setTitle(`📅 주간 요약 (${kst(Date.now() - WEEK_MS)} ~ ${kst(Date.now())})`);

  const active = rows.filter((r) => r.commits > 0 || r.merged > 0);
  if (active.length > 0) {
    embed.addFields({
      name: "레포 활동 (7일)",
      value: active
        .map((r) => `**${r.project.slug}** · 커밋 ${r.commits}${r.merged ? ` · 머지 PR ${r.merged}` : ""}`)
        .join("\n")
        .slice(0, 1000),
    });
  } else {
    embed.addFields({ name: "레포 활동 (7일)", value: "커밋 없음" });
  }

  const ev = eventsSince(WEEK_MS);
  const count = (k: EventKind) => ev.filter((e) => e.kind === k).length;
  const opsLine = [
    `장애 ${count("uptime_down")} (복구 ${count("uptime_recover")})`,
    `Sentry ${count("sentry_alert")}`,
    `CI 실패 ${count("ci_fail")}`,
    `Vercel 배포 ${count("vercel_deploy")} (실패 ${count("vercel_fail")})`,
    `PR 열림 ${count("pr_opened")} · 머지 ${count("pr_merged")}`,
    `자동진단 ${count("diag")}`,
  ].join(" · ");
  embed.addFields({ name: "운영 이벤트 (봇 관측)", value: opsLine.slice(0, 1000) });

  const vault = getVaultState();
  if (vault) {
    const next = collectDeadlines(vault, 0, 7);
    if (next.length > 0) {
      embed.addFields({
        name: "⏳ 다음 7일 마감",
        value: next
          .slice(0, 6)
          .map((x) => `**${ddayLabel(x.d)}** ${x.date.slice(5)} · [${x.note}] ${x.text}`)
          .join("\n")
          .slice(0, 1000),
      });
    }
  }

  await channel.send({ embeds: [embed] });
  return true;
}

function msUntilFridayKst(hour: number, minute: number): number {
  const nowShifted = new Date(Date.now() + 9 * 3600_000);
  const target = new Date(nowShifted);
  target.setUTCHours(hour, minute, 0, 0);
  let addDays = (5 - nowShifted.getUTCDay() + 7) % 7; // 5 = Friday
  if (addDays === 0 && target.getTime() <= nowShifted.getTime()) addDays = 7;
  target.setUTCDate(target.getUTCDate() + addDays);
  return target.getTime() - nowShifted.getTime();
}
