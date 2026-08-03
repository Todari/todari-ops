import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import { findProjectByRepoFullName, type ProjectConfig } from "../projects.js";
import { fetchAlertsChannel } from "../discord/alerts.js";
import { shouldDrop } from "./dedup.js";
import { putPendingAction } from "./pending.js";
import { recordEvent } from "../stats/events.js";
import { runAutoDiagnosis } from "../agent/diagnose.js";

// Handles `pull_request` (opened / ready_for_review / reopened) and
// `workflow_run` (completed + failure). Repos are registered with only these
// two events, so anything else is just acked.

interface GithubPullRequest {
  number?: number;
  title?: string;
  html_url?: string;
  draft?: boolean;
  merged?: boolean;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  user?: { login?: string };
  head?: { ref?: string };
  base?: { ref?: string };
}

interface GithubWorkflowRun {
  id?: number;
  name?: string;
  conclusion?: string;
  html_url?: string;
  head_branch?: string;
  head_commit?: { message?: string };
}

interface GithubPayload {
  action?: string;
  repository?: { full_name?: string; html_url?: string };
  sender?: { login?: string };
  pull_request?: GithubPullRequest;
  workflow_run?: GithubWorkflowRun;
}

export async function handleGithubEvent(eventName: string, payload: unknown): Promise<void> {
  const p = (payload ?? {}) as GithubPayload;
  const fullName = p.repository?.full_name;
  if (eventName === "ping") {
    console.log(`[webhook] github ping from ${fullName ?? "?"}`);
    return;
  }
  if (!fullName) return;
  const project = findProjectByRepoFullName(fullName);
  if (!project) {
    console.warn(`[webhook] github event for unknown repo: ${fullName}`);
    return;
  }

  if (eventName === "pull_request" && p.pull_request) {
    await handlePullRequest(project, fullName, p.action ?? "", p.pull_request);
    return;
  }
  if (eventName === "workflow_run" && p.workflow_run) {
    await handleWorkflowRun(project, fullName, p.action ?? "", p.workflow_run);
    return;
  }
}

async function handlePullRequest(
  project: ProjectConfig,
  fullName: string,
  action: string,
  pr: GithubPullRequest,
): Promise<void> {
  // 머지되면 초록 확인 알림 (closed + merged), 열리면 리뷰 알림.
  if (action === "closed") {
    if (!pr.merged) return;
    if (shouldDrop(`gh:pr-merged:${fullName}:${pr.number}`)) return;
    recordEvent("pr_merged", project.slug);
    const channel = await fetchAlertsChannel();
    if (!channel) return;
    const embed = new EmbedBuilder()
      .setColor(0x22c55e)
      .setTitle(`🟢 [${project.name}] PR #${pr.number} 머지됨 — ${truncate(pr.title ?? "", 180)}`)
      .setFooter({ text: project.slug });
    if (pr.html_url) embed.setURL(pr.html_url);
    await channel.send({ embeds: [embed] });
    return;
  }

  const interesting = action === "opened" || action === "ready_for_review" || action === "reopened";
  if (!interesting || pr.draft) return;
  if (shouldDrop(`gh:pr:${fullName}:${pr.number}:${action}`)) return;
  recordEvent("pr_opened", project.slug);

  const channel = await fetchAlertsChannel();
  if (!channel) return;

  const base = pr.base?.ref ?? "?";
  const head = pr.head?.ref ?? "?";
  const prompt = [
    "[GitHub PR 리뷰]",
    `프로젝트: ${project.name} (${project.slug})`,
    `PR #${pr.number}: ${pr.title ?? ""}`,
    `브랜치: ${head} → ${base}`,
    pr.html_url ? `URL: ${pr.html_url}` : "",
    "",
    "워크스페이스는 기본 브랜치가 체크아웃돼 있다. 아래로 변경분을 확인하고 리뷰해줘:",
    "```",
    `git fetch origin pull/${pr.number}/head:pr-${pr.number}`,
    `git diff ${base}...pr-${pr.number}`,
    "```",
    "버그·보안·설계 문제 우선으로 리뷰하고, 스타일 지적은 마지막에 짧게.",
  ]
    .filter((l) => l !== "")
    .join("\n");

  const id = putPendingAction({
    projectSlug: project.slug,
    threadName: `review/${project.slug}/pr-${pr.number}`,
    prompt,
  });

  const embed = new EmbedBuilder()
    .setColor(0x3b82f6)
    .setTitle(`🔀 [${project.name}] PR #${pr.number} ${truncate(pr.title ?? "", 200)}`)
    .addFields(
      { name: "author", value: pr.user?.login ?? "?", inline: true },
      { name: "branch", value: `${head} → ${base}`, inline: true },
      {
        name: "diff",
        value: `+${pr.additions ?? "?"} −${pr.deletions ?? "?"} (${pr.changed_files ?? "?"} files)`,
        inline: true,
      },
    )
    .setFooter({ text: project.slug });
  if (pr.html_url) embed.setURL(pr.html_url);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`triage:start:${id}`)
      .setLabel("🔍 리뷰 시작")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`triage:ack:${id}`).setLabel("✅ Ack").setStyle(ButtonStyle.Secondary),
  );
  if (pr.html_url) {
    row.addComponents(
      new ButtonBuilder().setLabel("Open PR").setStyle(ButtonStyle.Link).setURL(pr.html_url),
    );
  }
  await channel.send({ embeds: [embed], components: [row] });
}

async function handleWorkflowRun(
  project: ProjectConfig,
  fullName: string,
  action: string,
  run: GithubWorkflowRun,
): Promise<void> {
  if (action !== "completed" || run.conclusion !== "failure") return;
  if (shouldDrop(`gh:run:${fullName}:${run.id}`)) return;
  recordEvent("ci_fail", project.slug);

  const channel = await fetchAlertsChannel();
  if (!channel) return;

  const prompt = [
    "[CI 실패 트리아지]",
    `프로젝트: ${project.name} (${project.slug})`,
    `워크플로: ${run.name ?? "?"} / 브랜치: ${run.head_branch ?? "?"}`,
    run.html_url ? `URL: ${run.html_url}` : "",
    "",
    "최근 커밋(git log)을 보고 실패 원인을 추정해줘. GitHub API 가 필요하면",
    "`curl -H \"Authorization: Bearer $GITHUB_TOKEN\" https://api.github.com/...` 를 쓸 수 있다.",
  ]
    .filter((l) => l !== "")
    .join("\n");

  const id = putPendingAction({
    projectSlug: project.slug,
    threadName: `ci-fail/${project.slug}/${run.id ?? "run"}`,
    prompt,
  });

  const embed = new EmbedBuilder()
    .setColor(0xf97316)
    .setTitle(`❌ [${project.name}] CI 실패: ${truncate(run.name ?? "workflow", 200)}`)
    .addFields(
      { name: "branch", value: run.head_branch ?? "?", inline: true },
      { name: "commit", value: truncate(run.head_commit?.message?.split("\n")[0] ?? "?", 100), inline: true },
    )
    .setFooter({ text: project.slug });
  if (run.html_url) embed.setURL(run.html_url);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`triage:start:${id}`)
      .setLabel("🔧 Triage in /code")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`triage:ack:${id}`).setLabel("✅ Ack").setStyle(ButtonStyle.Secondary),
  );
  if (run.html_url) {
    row.addComponents(
      new ButtonBuilder().setLabel("Open run").setStyle(ButtonStyle.Link).setURL(run.html_url),
    );
  }
  const alertMessage = await channel.send({ embeds: [embed], components: [row] });

  runAutoDiagnosis({
    project,
    title: `CI 실패: ${run.name ?? "workflow"}`,
    alertMessage,
    prompt: [
      "[읽기 전용 사전 진단] 코드를 수정하지 말 것. 네트워크 접근 없이 git log/코드만으로",
      "아래 CI 실패의 원인을 조사해서 ①원인 가설 ②근거 ③수정 방향을 8줄 이내 한국어로.",
      "",
      `프로젝트: ${project.name} (${project.slug})`,
      `워크플로: ${run.name ?? "?"} / 브랜치: ${run.head_branch ?? "?"}`,
      `커밋: ${run.head_commit?.message?.split("\n")[0] ?? "?"}`,
      run.html_url ? `URL: ${run.html_url}` : "",
    ]
      .filter((l) => l !== "")
      .join("\n"),
  });
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
