import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type ThreadChannel } from "discord.js";
import { env } from "../env.js";
import type { Session } from "../storage/sessions.js";
import { findProject } from "../projects.js";
import { ensureCheckout } from "../workspaces/checkout.js";
import { putPendingAction } from "../webhook/pending.js";
import { captureException } from "../observability/sentry.js";

// /end 시 세션을 resume 해 "무엇을 했고 뭘 배웠는지" 6줄 요약을 뽑고,
// [📚 볼트 기록] 버튼으로 인박스 큐(→ TIL/트러블슈팅)로 보낼 수 있게 한다.
// 도구는 전부 차단 — 요약에 도구가 필요할 일은 없다.

const SUMMARY_TIMEOUT_MS = 3 * 60_000;
const TIL_TTL_MS = 24 * 3600_000;

export async function postSessionSummary(
  thread: ThreadChannel,
  session: Session,
): Promise<void> {
  try {
    const project = findProject(session.projectSlug);
    if (!project || !session.sessionId) return;
    const cwd = await ensureCheckout(session.threadId, project);

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), SUMMARY_TIMEOUT_MS);
    const options: Options = {
      cwd,
      abortController: abort,
      resume: session.sessionId,
      ...(env.CLAUDE_MODEL ? { model: env.CLAUDE_MODEL } : {}),
      permissionMode: "default",
      maxTurns: 2,
      canUseTool: async () => ({ behavior: "deny", message: "summary turn: no tools" }),
    } as Options;

    let text = "";
    try {
      for await (const message of query({
        prompt:
          "이 세션을 마무리한다. 도구 없이 답만: ①무엇을 했는지 ②재사용 가치가 있는 배움·삽질 포인트(있다면 문제→원인→해결 구조로) 를 합쳐 6줄 이내 한국어로 요약해줘.",
        options,
      })) {
        const m = message as { type?: string; result?: string };
        if (m.type === "result" && typeof m.result === "string") text = m.result;
      }
    } finally {
      clearTimeout(timer);
    }

    text = text.trim();
    if (!text) return;

    const id = putPendingAction(
      { projectSlug: session.projectSlug, threadName: "til", prompt: text },
      TIL_TTL_MS,
    );
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`til:save:${id}`)
        .setLabel("📚 볼트에 기록")
        .setStyle(ButtonStyle.Secondary),
    );
    const embed = new EmbedBuilder()
      .setColor(0x94a3b8)
      .setTitle("🧾 세션 요약")
      .setDescription(text.slice(0, 3900))
      .setFooter({ text: `${session.projectSlug} · 기록 버튼 → 인박스 → 스위퍼가 TIL/트러블슈팅으로` });
    await thread.send({ embeds: [embed], components: [row] });
  } catch (err) {
    console.warn("[summary] failed:", err);
    captureException(err, { kind: "session-summary", threadId: session.threadId });
  }
}
