import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { EmbedBuilder, type Message } from "discord.js";
import { env } from "../env.js";
import type { ProjectConfig } from "../projects.js";
import { ensureCheckout } from "../workspaces/checkout.js";
import { countTodayKst, recordEvent } from "../stats/events.js";
import { captureException } from "../observability/sentry.js";
import { readOnlyCanUseTool, extractText } from "./read-only.js";

// 알림(센트리 이슈·CI 실패)이 오면 사람이 버튼을 누르기 전에 읽기 전용
// 진단 세션을 자동으로 돌려 원인 가설을 답글로 달아둔다.
// 가드레일: 하루 DIAG_DAILY_CAP회(KST) · maxTurns 15 · 5분 타임아웃 ·
// 읽기 도구만 허용(Bash 는 안전 프리픽스만).

const DIAG_TIMEOUT_MS = 5 * 60_000;

export function runAutoDiagnosis(args: {
  project: ProjectConfig;
  title: string;
  prompt: string;
  alertMessage: Message;
}): void {
  void diagnose(args).catch((err) => {
    console.error("[diag] failed:", err);
    captureException(err, { kind: "diag", project: args.project.slug });
  });
}

async function diagnose(args: {
  project: ProjectConfig;
  title: string;
  prompt: string;
  alertMessage: Message;
}): Promise<void> {
  const cap = env.DIAG_DAILY_CAP;
  if (cap <= 0) return;
  if (countTodayKst("diag") >= cap) {
    console.log(`[diag] daily cap ${cap} reached — skip`);
    return;
  }
  recordEvent("diag", args.project.slug);
  console.log(`[diag] start: [${args.project.slug}] ${args.title}`);

  // 프로젝트별 진단 전용 clone 을 재사용한다 (스레드 세션과 분리).
  const cwd = await ensureCheckout(`diag-${args.project.slug}`, args.project);

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), DIAG_TIMEOUT_MS);

  const options: Options = {
    cwd,
    abortController: abort,
    ...(env.CLAUDE_MODEL ? { model: env.CLAUDE_MODEL } : {}),
    permissionMode: "default",
    maxTurns: 15,
    canUseTool: readOnlyCanUseTool(),
  } as Options;

  let finalText = "";
  let assistantText = "";
  try {
    for await (const message of query({ prompt: args.prompt, options })) {
      const m = message as { type?: string; result?: string; message?: { content?: unknown } };
      if (m.type === "result" && typeof m.result === "string") finalText = m.result;
      if (m.type === "assistant" && m.message?.content) {
        assistantText = extractText(m.message.content) || assistantText;
      }
    }
  } finally {
    clearTimeout(timer);
  }

  const text = (finalText || assistantText || "").trim();
  if (!text) {
    console.warn("[diag] empty result");
    return;
  }
  const embed = new EmbedBuilder()
    .setColor(0x818cf8)
    .setTitle(`🧠 자동 사전 진단 — ${args.title}`.slice(0, 250))
    .setDescription(text.slice(0, 3900))
    .setFooter({ text: `${args.project.slug} · 읽기 전용 · 본 수정은 Triage 버튼으로` });
  await args.alertMessage.reply({ embeds: [embed] });
  console.log(`[diag] posted for ${args.project.slug}`);
}

