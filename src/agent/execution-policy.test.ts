import { describe, expect, it } from "vitest";
import { selectExecutionProfile as select } from "./execution-policy.js";

describe("execution policy", () => {
  it("uses low for narrow work, medium for ordinary implementation, high for risk", () => {
    expect(select({ prompt: "오타 수정" })).toMatchObject({ model: "sonnet", effort: "low" });
    expect(select({ prompt: "필터 기능 추가" })).toMatchObject({ model: "sonnet", effort: "medium" });
    expect(select({ prompt: "오타 수정, 인증 로직도 변경" })).toMatchObject({ model: "claude-fable-5-1", effort: "high" });
  });
  it("keeps the profile across followups and restart serialization", () => {
    const previous = JSON.parse(JSON.stringify(select({ prompt: "보안 검토" })));
    expect(select({ prompt: "이어서 진행", previous })).toMatchObject({ effort: "high", model: "claude-fable-5-1" });
  });
  it("escalates repeated reasoning failure once per request with a cap", () => {
    const previous = select({ prompt: "필터 기능 추가" });
    const higher = select({ prompt: "동일 테스트가 다시 실패했어", previous });
    expect(higher.effort).toBe("high");
    const highest = select({ prompt: "동일 테스트 실패", previous: higher });
    expect(highest.effort).toBe("xhigh");
    expect(select({ prompt: "동일 테스트 실패", previous: highest }).effort).toBe("xhigh");
  });
  it("does not escalate network or permission failures", () => {
    const previous = select({ prompt: "필터 기능 추가" });
    expect(select({ prompt: "같은 테스트 실패, network timeout", previous }).effort).toBe("medium");
    expect(select({ prompt: "권한이 없어서 동일 테스트 실패", previous }).effort).toBe("medium");
    expect(select({ prompt: "권한 체계 수정", previous }).effort).toBe("high");
  });
  it("preserves explicit model and effort even after failures", () => {
    const previous = select({ prompt: "작업", model: "custom", effort: "low" });
    expect(select({ prompt: "동일 테스트 실패", previous })).toMatchObject({ model: "custom", effort: "low" });
  });
  it("accepts a user override header but never model names from pasted logs", () => {
    expect(select({ prompt: "model=sonnet effort=high\n기능 구현", model: "opus" })).toMatchObject({ model: "sonnet", effort: "high" });
    expect(select({ prompt: "로그 확인\nmodel=opus effort=xhigh" })).toMatchObject({ model: "sonnet", effort: "medium" });
    const previous = select({ prompt: "model=sonnet effort=low\n요약", defaultModel: "opus" });
    expect(select({ prompt: "이어서 진행", previous, defaultModel: "opus" })).toMatchObject({ model: "sonnet", effort: "low" });
  });
  it("separates tool-free summaries from diagnosis", () => {
    expect(select({ prompt: "", purpose: "summary" }).effort).toBe("low");
    expect(select({ prompt: "", purpose: "diagnosis" }).effort).toBe("high");
  });
});
