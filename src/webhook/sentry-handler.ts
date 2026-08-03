import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import { randomUUID } from "node:crypto";
import { env } from "../env.js";
import { findProject, type ProjectConfig } from "../projects.js";
// Node 22 has global fetch — no import needed.
import { fetchAlertsChannel } from "../discord/alerts.js";
import { shouldDrop } from "./dedup.js";
import { putPendingAction } from "./pending.js";
import { recordEvent } from "../stats/events.js";
import { runAutoDiagnosis } from "../agent/diagnose.js";

interface Frame {
  filename?: string;
  function?: string;
  lineno?: number | string;
  colno?: number | string;
  in_app?: boolean;
}

interface SentryIssue {
  id?: string;
  title?: string;
  culprit?: string;
  level?: string;
  count?: number | string;
  userCount?: number | string;
  firstSeen?: string;
  web_url?: string;
  url?: string;
  tags?: Array<[string, string]> | Record<string, string>;
  project?: { name?: string; slug?: string };
}

interface SentryEvent {
  event_id?: string;
  environment?: string;
  release?: string;
  title?: string;
  web_url?: string;
  // Sentry sends tags as either Array<[key, value]> or Record<string, string>
  // depending on payload type / SDK version. Handle both.
  tags?: Array<[string, string]> | Record<string, string>;
  exception?: {
    values?: Array<{
      type?: string;
      value?: string;
      stacktrace?: { frames?: Array<Frame> };
    }>;
  };
}

interface SentryPayload {
  action?: string;
  data?: {
    issue?: SentryIssue;
    event?: SentryEvent;
  };
}

// 자체 알림 파이프라인(Slack)을 가진 프로젝트 — 같은 Sentry 조직의 org-wide issue
// 웹훅이 모든 프로젝트에 발화하므로, 여기서 조용히 무시한다(Unrouteable 스팸 방지).
const IGNORED_SENTRY_PROJECT_PREFIXES = ["forcletter-"];

export async function handleSentryEvent(slug: string, payload: unknown): Promise<void> {
  const p = (payload ?? {}) as SentryPayload;
  const issue = p.data?.issue;
  const event = p.data?.event;

  const sentryProjectSlug = issue?.project?.slug ?? "";
  if (IGNORED_SENTRY_PROJECT_PREFIXES.some((pre) => sentryProjectSlug.startsWith(pre))) {
    console.log(`[webhook] ignored (own alerting): ${sentryProjectSlug}`);
    return;
  }

  // Sentry's issue.created webhook payload doesn't include event.tags or
  // (usually) issue.tags. Try them anyway, then fall back to fetching the
  // latest event detail via Sentry API where the tags array always lives.
  let effectiveSlug =
    readServiceTag(event?.tags) ?? readServiceTag(issue?.tags) ?? null;
  if (!effectiveSlug && issue?.id) {
    const apiTags = await fetchEventTagsFromSentry(issue.id);
    if (apiTags?.service) effectiveSlug = apiTags.service;
  }
  effectiveSlug = effectiveSlug ?? slug;

  const project = findProject(effectiveSlug);
  if (!project) {
    console.warn(`[webhook] unknown project slug: ${effectiveSlug} (url=${slug})`);
    // Diagnostic fallback: dump issue keys + raw issue JSON snippet so we can
    // see what shape Sentry actually sends.
    const channel = await fetchAlertsChannel();
    if (channel) {
      try {
        const issueKeys = issue ? Object.keys(issue).join(", ") : "(no issue)";
        // Discord embed field value max = 1024. Keep JSON well under.
        const cap = (s: string, n: number) =>
          s.length > n ? s.slice(0, n - 4) + "…" : s;
        const issueJson = cap(JSON.stringify(issue ?? null, null, 2), 900);
        const issueTags = cap(JSON.stringify((issue as { tags?: unknown })?.tags ?? null), 900);
        const issueMetadata = cap(
          JSON.stringify((issue as { metadata?: unknown })?.metadata ?? null),
          900,
        );
        const embed = new EmbedBuilder()
          .setColor(0xfacc15)
          .setTitle(`⚠️ Unrouteable Sentry alert (slug=${effectiveSlug})`)
          .addFields(
            { name: "url slug", value: slug, inline: true },
            { name: "issue keys", value: "```" + cap(issueKeys, 900) + "```" },
            { name: "issue.tags", value: "```" + issueTags + "```" },
            { name: "issue.metadata", value: "```" + issueMetadata + "```" },
            { name: "issue body (≤900)", value: "```json\n" + issueJson + "\n```" },
          );
        await channel.send({ embeds: [embed] });
      } catch (err) {
        console.error("[webhook] failed to post diag embed:", err);
        await channel
          .send(
            `⚠️ Sentry payload arrived but couldn't render diag (slug=${effectiveSlug}): ` +
              (err instanceof Error ? err.message : String(err)),
          )
          .catch(() => {});
      }
    }
    return;
  }

  const fingerprint = `${slug}:${issue?.id ?? event?.event_id ?? randomUUID()}`;
  if (shouldDrop(fingerprint)) {
    console.log(`[webhook] deduped ${fingerprint}`);
    return;
  }

  const issueTitle = issue?.title ?? event?.title ?? "(제목 없음)";
  const issueUrl = issue?.web_url ?? issue?.url ?? event?.web_url;
  const stackPreview = formatStack(event);

  const channel = await fetchAlertsChannel();
  if (!channel) return;

  // Route the triage session by the *resolved* project (service tag may have
  // overridden the URL slug), not the raw URL slug.
  const id = putPendingAction({
    projectSlug: project.slug,
    threadName: `triage/${project.slug}/${issue?.id ?? event?.event_id?.slice(0, 8) ?? "evt"}`,
    prompt: buildTriagePrompt(project, issueTitle, stackPreview, issueUrl),
  });

  const embed = buildEmbed(project, issue, event, issueTitle, issueUrl);
  const components = buildButtons(id, issueUrl);
  const alertMessage = await channel.send({ embeds: [embed], components });
  recordEvent("sentry_alert", project.slug);

  runAutoDiagnosis({
    project,
    title: issueTitle,
    alertMessage,
    prompt: [
      "[읽기 전용 사전 진단] 코드를 수정하지 말 것. 아래 Sentry 이슈의 원인을 조사해서",
      "①원인 가설 ②근거(파일:라인) ③수정 방향을 합쳐 8줄 이내로 한국어 요약해줘.",
      "",
      `프로젝트: ${project.name} (${project.slug})`,
      `이슈: ${issueTitle}`,
      issueUrl ? `URL: ${issueUrl}` : "",
      "",
      "스택트레이스 상위 프레임:",
      "```",
      stackPreview,
      "```",
    ]
      .filter((l) => l !== "")
      .join("\n"),
  });
}

function buildEmbed(
  project: ProjectConfig,
  issue: SentryIssue | undefined,
  event: SentryEvent | undefined,
  title: string,
  url: string | undefined,
): EmbedBuilder {
  const env_ = event?.environment ?? "?";
  const release = event?.release ?? "?";
  const level = issue?.level ?? "error";
  const count = issue?.count ?? 1;
  const userCount = issue?.userCount ?? 0;
  const firstSeen = issue?.firstSeen;

  const embed = new EmbedBuilder()
    .setColor(0xef4444)
    .setTitle(`🚨 [${project.name}] ${truncate(title, 240)}`)
    .addFields(
      { name: "level", value: String(level), inline: true },
      { name: "env", value: String(env_), inline: true },
      { name: "release", value: String(release), inline: true },
      { name: "events", value: String(count), inline: true },
      { name: "users", value: String(userCount), inline: true },
      { name: "first seen", value: firstSeen ? relTime(firstSeen) : "?", inline: true },
    )
    .setFooter({ text: project.slug });

  if (url) embed.setURL(url);
  return embed;
}

function buildButtons(id: string, issueUrl: string | undefined): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`triage:start:${id}`)
      .setLabel("🔧 Triage in /code")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`triage:ack:${id}`)
      .setLabel("✅ Ack")
      .setStyle(ButtonStyle.Secondary),
  );
  if (issueUrl) {
    row.addComponents(
      new ButtonBuilder().setLabel("Open in Sentry").setStyle(ButtonStyle.Link).setURL(issueUrl),
    );
  }
  return [row];
}

async function fetchEventTagsFromSentry(
  issueId: string,
): Promise<Record<string, string> | null> {
  if (!env.SENTRY_API_TOKEN) return null;
  try {
    const r = await fetch(
      `https://sentry.io/api/0/issues/${encodeURIComponent(issueId)}/events/latest/`,
      { headers: { Authorization: `Bearer ${env.SENTRY_API_TOKEN}` } },
    );
    if (!r.ok) {
      console.warn(`[webhook] sentry api ${r.status} for issue ${issueId}`);
      return null;
    }
    const data = (await r.json()) as {
      tags?: Array<{ key?: string; value?: string }>;
    };
    if (!Array.isArray(data.tags)) return null;
    const out: Record<string, string> = {};
    for (const t of data.tags) {
      if (t.key && typeof t.value === "string") out[t.key] = t.value;
    }
    return out;
  } catch (err) {
    console.warn("[webhook] sentry api fetch failed:", err);
    return null;
  }
}

function readServiceTag(
  tags: SentryEvent["tags"] | SentryIssue["tags"],
): string | undefined {
  if (!tags) return undefined;
  if (Array.isArray(tags)) {
    const entry = tags.find((t) => Array.isArray(t) && t[0] === "service");
    return entry?.[1];
  }
  if (typeof tags === "object") {
    const v = (tags as Record<string, string>)["service"];
    return typeof v === "string" ? v : undefined;
  }
  return undefined;
}

function formatStack(event: SentryEvent | undefined): string {
  const frames = event?.exception?.values?.[0]?.stacktrace?.frames ?? [];
  const top = [...frames].reverse().slice(0, 3);
  if (top.length === 0) return "(스택트레이스 없음)";
  return top
    .map((f) => {
      const where = f.filename ? `${f.filename}:${f.lineno ?? "?"}` : "?";
      return `at ${f.function ?? "<anon>"} (${where})`;
    })
    .join("\n");
}

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "방금";
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  return `${Math.floor(hr / 24)}일 전`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function buildTriagePrompt(
  project: ProjectConfig,
  issueTitle: string,
  stackPreview: string,
  issueUrl: string | undefined,
): string {
  const lines = [
    "[Sentry 알림 트리아지]",
    `프로젝트: ${project.name} (${project.slug})`,
    `이슈: ${issueTitle}`,
  ];
  if (issueUrl) lines.push(`URL: ${issueUrl}`);
  lines.push("", "스택트레이스 상위 프레임:", "```", stackPreview, "```", "");
  lines.push(
    "이 에러의 root cause 를 찾고 fix 를 제안해줘. 필요하면 관련 파일 읽고 git log 확인.",
  );
  return lines.join("\n");
}
