import { describe, it, expect } from "vitest";
import { parseDaily, parseCorrection } from "./tutor.js";

describe("parseDaily", () => {
  it("extracts JSON from a fenced code block", () => {
    const raw = "설명\n```json\n{\"front\":\"おはよう\",\"reading\":\"おはよう\",\"meaning\":\"안녕(아침)\",\"example\":\"おはよう、元気？\",\"exampleKo\":\"안녕, 잘 지내?\",\"note\":\"반말\",\"kind\":\"phrase\"}\n```";
    const d = parseDaily(raw);
    expect(d.front).toBe("おはよう");
    expect(d.kind).toBe("phrase");
  });
  it("throws on missing front", () => {
    expect(() => parseDaily("{}")).toThrow();
  });
});

describe("parseCorrection", () => {
  it("parses corrected + mistakes array", () => {
    const raw = "{\"corrected\":\"私は学生です\",\"natural\":\"학생이에요\",\"explanation\":\"は 조사\",\"mistakes\":[\"조사 누락\"]}";
    const c = parseCorrection(raw);
    expect(c.corrected).toBe("私は学生です");
    expect(c.mistakes).toHaveLength(1);
  });
});
