import { describe, it, expect } from "vitest";
import { parseIntent, buildPrompt } from "./router.js";

describe("parseIntent", () => {
  it("parses a note with project", () => {
    const r = parseIntent('{"intent":"note","project":"haengdong","text":"도메인 갱신 보류"}');
    expect(r.intent).toBe("note");
    expect(r.project).toBe("haengdong");
    expect(r.text).toBe("도메인 갱신 보류");
  });

  it("parses jp_ask from a fenced block", () => {
    const r = parseIntent('```json\n{"intent":"jp_ask","question":"편의점 봉투 필요하냐고?"}\n```');
    expect(r.intent).toBe("jp_ask");
    expect(r.question).toContain("봉투");
  });

  it("parses chat with a reply", () => {
    const r = parseIntent('{"intent":"chat","reply":"안녕하세요!"}');
    expect(r.intent).toBe("chat");
    expect(r.reply).toBe("안녕하세요!");
  });

  it("parses a codebase question with project", () => {
    const r = parseIntent('{"intent":"codebase","project":"forcletter","question":"광고단가 예측 어디 있어?"}');
    expect(r.intent).toBe("codebase");
    expect(r.project).toBe("forcletter");
    expect(r.question).toContain("광고단가");
  });

  it("parses a vault question", () => {
    const r = parseIntent('{"intent":"vault","question":"이정표 2R 언제까지?"}');
    expect(r.intent).toBe("vault");
    expect(r.question).toContain("2R");
  });

  it("parses a code action with a self-contained prompt", () => {
    const r = parseIntent(
      '{"intent":"code","project":"todari-ops","prompt":"오늘의 표현에 N2 단어를 추가해줘"}',
    );
    expect(r.intent).toBe("code");
    expect(r.project).toBe("todari-ops");
    expect(r.prompt).toContain("N2 단어");
  });

  it("parses a reminder action", () => {
    const r = parseIntent(
      '{"intent":"remind","when":"30m","text":"배포 상태 확인"}',
    );
    expect(r.intent).toBe("remind");
    expect(r.when).toBe("30m");
    expect(r.text).toBe("배포 상태 확인");
  });

  it("falls back to chat when intent is unknown (never a destructive default)", () => {
    const r = parseIntent('{"intent":"delete_everything"}');
    expect(r.intent).toBe("chat");
  });

  it("falls back to chat (raw as reply) when JSON is unparseable", () => {
    const r = parseIntent("그냥 평범한 문장, JSON 아님");
    expect(r.intent).toBe("chat");
    expect(r.reply).toContain("평범한");
  });
});

describe("buildPrompt", () => {
  it("embeds the user text and demands JSON only", () => {
    const p = buildPrompt("행동대장 우선순위 낮춰");
    expect(p).toContain("행동대장 우선순위 낮춰");
    expect(p).toContain("JSON");
  });

  it("includes recent conversation so follow-up requests can be resolved", () => {
    const p = buildPrompt("너 추천대로 해줘", [
      {
        role: "user",
        text: "오늘의 표현에 N2~N3 단어도 5~10개 넣고 싶어",
      },
      {
        role: "assistant",
        text: "예문까지 같이 넣는 방향을 추천해요.",
      },
    ]);
    expect(p).toContain("N2~N3 단어");
    expect(p).toContain("예문까지");
    expect(p).toContain("너 추천대로 해줘");
    expect(p).toContain('"intent":"code"');
  });

  it("documents every executable conversational action", () => {
    const p = buildPrompt("뭘 할 수 있어?");
    for (const intent of [
      "code",
      "status",
      "remind",
      "digest",
      "week",
      "checkin",
      "sessions",
      "jp_review",
    ]) {
      expect(p).toContain(`"${intent}"`);
    }
  });
});
