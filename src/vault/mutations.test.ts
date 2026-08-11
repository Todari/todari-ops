import { describe, expect, it } from "vitest";
import { isAllowedVaultMarkdownPath } from "./mutations.js";

const ROOT = "/data/work/vault";

describe("isAllowedVaultMarkdownPath", () => {
  it("allows Markdown inside approved vault roots", () => {
    expect(isAllowedVaultMarkdownPath(ROOT, "프로젝트/todari-ops.md")).toBe(true);
    expect(isAllowedVaultMarkdownPath(ROOT, `${ROOT}/공부/TIL/메모.md`)).toBe(true);
  });

  it("rejects traversal, git metadata, settings, and non-Markdown files", () => {
    expect(isAllowedVaultMarkdownPath(ROOT, "../secret.md")).toBe(false);
    expect(isAllowedVaultMarkdownPath(ROOT, `${ROOT}/.git/config.md`)).toBe(false);
    expect(isAllowedVaultMarkdownPath(ROOT, ".obsidian/plugins/config.md")).toBe(false);
    expect(isAllowedVaultMarkdownPath(ROOT, "프로젝트/첨부.png")).toBe(false);
  });
});
