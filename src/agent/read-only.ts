import type { Options } from "@anthropic-ai/claude-agent-sdk";

// 읽기 전용 에이전트 세션의 공용 정책. 진단(diagnose)과 코드베이스 Q&A(ask-codebase)가
// 공유한다 — 읽기 전용 허용 목록이 두 곳에서 갈리면 한쪽이 실수로 쓰기를 허용할 수 있어
// 위험하므로 한 곳에 둔다.

const SAFE_BASH =
  /^(?:git\s+(?:log|show|diff|status|grep|blame|shortlog|rev-parse)|ls|cat|head|tail|wc|pwd|tree)\b/;

// Bash는 문자열 하나를 셸이 해석하므로 허용 명령의 접두사만 검사하면 안 된다.
// 예: `git status && rm ...`, `find ... -delete`, `git branch -D ...`.
// 읽기 전용 세션에는 SDK의 Read/Grep/Glob이 따로 있으므로 Bash는 진단에 필요한
// 소수 명령만 허용하고, 셸 조합·리다이렉션·명령/변수 치환은 전부 거부한다.
export function isSafeReadOnlyBash(command: string): boolean {
  const normalized = command.trim();
  if (!normalized || /[\n\r;&|><`\\$]/.test(normalized)) return false;
  if (!SAFE_BASH.test(normalized)) return false;

  // 일부 읽기 명령도 옵션을 통해 파일을 쓰거나 외부 프로그램을 실행할 수 있다.
  return !/(?:^|\s)(?:-o|--output(?:=|\s)|--ext-diff\b|--textconv\b|--open-files-in-pager(?:=|\s)|--exec(?:=|\s))/.test(
    normalized,
  );
}

export function readOnlyCanUseTool(): NonNullable<Options["canUseTool"]> {
  return async (toolName, toolInput) => {
    const readOnly =
      toolName === "Read" || toolName === "Grep" || toolName === "Glob";
    const safeBash =
      toolName === "Bash" &&
      isSafeReadOnlyBash(String((toolInput as { command?: string })?.command ?? ""));
    return readOnly || safeBash
      ? { behavior: "allow", updatedInput: toolInput }
      : { behavior: "deny", message: "read-only session" };
  };
}

export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : ((c as { text?: string }).text ?? "")))
      .join("");
  }
  return "";
}
