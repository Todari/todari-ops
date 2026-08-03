import { describe, expect, it } from "vitest";
import { findProject } from "./projects.js";

describe("findProject", () => {
  it("resolves natural-language aliases", () => {
    expect(findProject("토다리봇")?.slug).toBe("todari-ops");
    expect(findProject("basetie")?.slug).toBe("jeongpyo");
    expect(findProject("포크레터")?.slug).toBe("forcletter");
    expect(findProject("카카오톡 분석")?.slug).toBe("toksai");
  });

  it("exposes forcletter with its real default branch", () => {
    const project = findProject("forcletter");
    expect(project?.repoUrl).toContain("linkive/for-creator");
    expect(project?.defaultBranch).toBe("dev");
  });

  it("monitors the Toksai API health endpoint", () => {
    const project = findProject("toksai");

    expect(project?.healthUrl).toBe("https://api.toksai.todari.dev/health");
  });
});
