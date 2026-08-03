import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { env } from "../env.js";
import { ensureVaultCheckout } from "../vault/repo.js";
import { readOnlyCanUseTool, extractText } from "../agent/read-only.js";
import { getVaultState, type VaultState } from "../vault/state.js";

// 봇은 obsidian-vault 레포를 clone/pull해 볼트 '본문 전체'를 읽는다(코드베이스 Q&A와
// 같은 읽기 전용 하네스). 예전엔 iCloud라 못 읽는 줄 알고 동기화된 요약만 썼지만,
// obsidian-git이 GitHub로 push하므로 봇이 레포로 읽으면 된다. 동기화된 할일·마감
// 요약(getVaultState)은 '빠른 참조'로 프롬프트에 얹어 일정 질문의 D-day 계산을 돕는다.

const TIMEOUT_MS = 4 * 60_000;

const VAULT_GUIDE =
  "볼트 구조: 프로젝트/<서비스>.md(현황·다음 할 일), 이정표/(jeongpyo·basetie 허브), " +
  "포크레터/(forcletter 허브 — 제품·가격·사업 판단), 공부/(TIL·트러블슈팅·개념), " +
  "창/(아이디어), 회고/, 데일리/. 한글 파일명은 NFD로 저장돼 Glob이 어긋날 수 있으니 " +
  "`ls`/`find`로 실제 파일명을 확인한 뒤 Read 해라. 내용 검색은 grep/rg로 직접 뒤져라.";

export function formatVaultContext(state: VaultState): string {
  return state.notes
    .map((n) => {
      const name = n.slug || n.note;
      const dl = n.deadlines.map((d) => `  - 📅 ${d.date} ${d.text}`).join("\n");
      const tk = n.tasks
        .map((t) => `  - [ ] ${t.text}${t.due ? ` (📅 ${t.due})` : ""}`)
        .join("\n");
      const lines = [dl, tk].filter(Boolean).join("\n");
      return `## ${name}\n${lines || "  (항목 없음)"}`;
    })
    .join("\n\n");
}

export function buildVaultPrompt(question: string, today: string, hint: string): string {
  return (
    "너는 사용자의 옵시디언 볼트(지식베이스)를 읽고 질문에 한국어로 간결히 답하는 조수다.\n" +
    `오늘은 ${today}. 마감·D-day를 물으면 오늘 기준으로 계산해라.\n` +
    `${VAULT_GUIDE}\n\n` +
    "아래는 동기화된 '할 일·마감' 빠른 참조다(볼트 전체가 아님, 일정 질문에 우선 활용):\n" +
    `${hint}\n\n` +
    "근거가 된 노트는 파일명으로 밝히고, 볼트에서 못 찾으면 없다고 솔직히 말해라. " +
    "절대 수정하지 말 것(읽기 전용).\n\n" +
    `질문: ${question}`
  );
}

export async function answerVaultQuestion(question: string): Promise<string> {
  let cwd: string;
  try {
    cwd = await ensureVaultCheckout();
  } catch {
    return "볼트 레포를 가져오지 못했어요. (동기화 또는 토큰 접근을 확인해줘)";
  }

  const state = getVaultState();
  const hint = state && state.notes.length > 0 ? formatVaultContext(state) : "(동기화된 요약 없음)";
  const today = new Date().toISOString().slice(0, 10);
  const prompt = buildVaultPrompt(question, today, hint);

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
  return (finalText || assistantText || "볼트에서 답을 찾지 못했어요.").trim();
}
