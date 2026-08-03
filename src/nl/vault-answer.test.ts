import { describe, it, expect } from "vitest";
import { formatVaultContext, buildVaultPrompt } from "./vault-answer.js";
import type { VaultState } from "../vault/state.js";

const STATE: VaultState = {
  generatedAt: "2026-07-27T00:00:00Z",
  notes: [
    {
      note: "이정표",
      slug: "jeongpyo",
      tasks: [{ text: "활동보고서 초안" }],
      deadlines: [{ text: "2R 진출평가 서류", date: "2026-08-14" }],
    },
    { note: "haengdong", slug: "haengdong", tasks: [], deadlines: [] },
  ],
};

describe("formatVaultContext", () => {
  it("renders deadlines and tasks per note with slug heading", () => {
    const ctx = formatVaultContext(STATE);
    expect(ctx).toContain("## jeongpyo");
    expect(ctx).toContain("📅 2026-08-14 2R 진출평가 서류");
    expect(ctx).toContain("- [ ] 활동보고서 초안");
  });

  it("shows a placeholder for notes with no items", () => {
    const ctx = formatVaultContext(STATE);
    expect(ctx).toContain("## haengdong");
    expect(ctx).toContain("(항목 없음)");
  });
});

describe("buildVaultPrompt", () => {
  it("embeds today, the question, the quick-reference hint, and the read-only guard", () => {
    const hint = "## jeongpyo\n  - 📅 2026-08-14 2R 진출평가 서류";
    const p = buildVaultPrompt("이정표 2R 언제까지?", "2026-07-27", hint);
    expect(p).toContain("2026-07-27");
    expect(p).toContain("이정표 2R 언제까지?");
    expect(p).toContain("2026-08-14 2R 진출평가 서류");
    expect(p).toContain("읽기 전용");
  });
});
