import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { env } from "../env.js";
import type { ProjectConfig } from "../projects.js";
import { ensureCheckout } from "../workspaces/checkout.js";
import { readOnlyCanUseTool, extractText } from "./read-only.js";

// #토다리에서 자연어로 코드 질문을 받으면 그 레포를 읽기 전용 에이전트로 뒤져 답한다.
// diagnose와 같은 읽기 전용 하네스를 쓰되, 결과를 fire-and-forget이 아니라 반환한다.

const TIMEOUT_MS = 4 * 60_000;

export async function askCodebase(project: ProjectConfig, question: string): Promise<string> {
  const cwd = await ensureCheckout(`ask-${project.slug}`, project);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  const options = {
    cwd,
    abortController: abort,
    ...(env.CLAUDE_MODEL ? { model: env.CLAUDE_MODEL } : {}),
    permissionMode: "default",
    maxTurns: 15,
    canUseTool: readOnlyCanUseTool(),
  } as Options;

  const prompt =
    `이 저장소(${project.slug})에 대한 질문에 한국어로 간결히 답해라. ` +
    `코드를 직접 읽어 근거를 대고, 관련 위치는 \`파일경로:라인\`으로 밝혀라. ` +
    `추측이 필요하면 추측임을 명시해라. 절대 수정하지 말 것(읽기 전용).\n\n질문: ${question}`;

  let finalText = "";
  let assistantText = "";
  try {
    for await (const message of query({ prompt, options })) {
      const m = message as {
        type?: string;
        result?: string;
        message?: { content?: unknown };
      };
      if (m.type === "result" && typeof m.result === "string") finalText = m.result;
      if (m.type === "assistant" && m.message?.content) {
        assistantText = extractText(m.message.content) || assistantText;
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return (finalText || assistantText || "답을 찾지 못했어요.").trim();
}
