import { query } from "@anthropic-ai/claude-agent-sdk";

// 값싼 단발 호출용 기본 모델.
export const LLM_MODEL = "claude-sonnet-5";

// 응답 텍스트에서 첫 JSON 오브젝트를 뽑는다(코드펜스 안/밖 모두 처리).
export function extractJson(raw: string): any {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = fenced ? fenced[1] : raw;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("no JSON object in response");
  return JSON.parse(text.slice(start, end + 1));
}

// 격리된 단발 LLM 호출. 봇의 에이전트 세션(../agent/run.ts)과 달리:
// - `tools: []`  — 내장 도구(Bash/Read/Edit…) 전부 비활성. 안 그러면 SDK가 full
//   `claude_code` 프리셋을 붙여 단순 호출이 파일/셸을 건드릴 수 있다.
// - `settingSources: []` — SDK 격리 모드: `~/.claude/settings.json`/프로젝트
//   `.claude`/CLAUDE.md·훅을 로드하지 않는다(이 호스트의 워크스페이스 하네스 훅 상속 방지).
// - `maxTurns: 1` — 단발.
// 튜터·자연어 라우터가 공유한다(격리 로직이 갈라지면 위험하므로 한 곳에 둔다).
export async function askText(prompt: string, model: string = LLM_MODEL): Promise<string> {
  let out = "";
  for await (const msg of query({
    prompt,
    options: { model, tools: [], settingSources: [], maxTurns: 1 },
  })) {
    if (msg.type === "assistant") {
      for (const block of msg.message.content) {
        if (block.type === "text") out += block.text;
      }
    }
  }
  if (!out.trim()) throw new Error("empty LLM response");
  return out;
}
