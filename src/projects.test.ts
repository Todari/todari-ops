import { describe, expect, it } from "vitest";
import { findProject, getHealthTargets, projects } from "./projects.js";

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

describe("project health targets", () => {
  it("preserves legacy keys and adds independent component targets", () => {
    const target = {
      slug: "sample", name: "Sample", repoUrl: "https://github.com/example/sample.git", defaultBranch: "main",
      healthUrl: "https://sample.example",
      healthChecks: [{ id: "api", name: "API", url: "https://api.sample.example/health", expectJson: { ok: true } }],
    };
    expect(getHealthTargets([target])).toMatchObject([
      { key: "sample", slug: "sample", url: target.healthUrl },
      { key: "sample:api", slug: "sample", checkName: "API", expectJson: { ok: true } },
    ]);
    expect(getHealthTargets([{ ...target, healthUrl: undefined }])).toHaveLength(1);
    expect(getHealthTargets([{ ...target, healthUrl: undefined, healthChecks: undefined }])).toEqual([]);
  });

  it("monitors the two verified API endpoints without replacing the metronome website", () => {
    const targets = getHealthTargets();
    expect(targets.find((target) => target.key === "metronomdeul")).toMatchObject({ url: "https://metronome.todari.dev" });
    expect(targets.find((target) => target.key === "metronomdeul:api")).toMatchObject({
      url: "https://api.metronome.todari.dev/health", expectJson: { status: "ok", db: "ok" },
    });
    expect(targets.find((target) => target.key === "dakbal:api")).toMatchObject({
      url: "https://dakbal.pro/api/health", expectJson: { ok: true },
    });
    expect(new Set(targets.map((target) => target.key)).size).toBe(targets.length);
    expect(projects.find((project) => project.slug === "jeongpyo")?.healthUrl).toBeUndefined();
  });
});
