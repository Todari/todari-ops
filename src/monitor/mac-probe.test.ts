import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ WORK_DIR: "" }));
vi.mock("../env.js", () => ({ env }));

it("persists bounded monitor evidence, preserves the latest receipt, and detects staleness", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "mac-probe-test-"));
  env.WORK_DIR = path.join(root, "work");
  const { macProbeHealth, receiveMacProbe } = await import("./mac-probe.js");
  const now = Date.parse("2026-11-11T00:00:00.000Z");
  const at = (offset: number) => new Date(now + offset).toISOString();
  try {
    expect(macProbeHealth(now)).toMatchObject({ status: "unknown", checkedAt: null, healthy: null });
    expect(receiveMacProbe({ checkedAt: at(-60_000), healthy: false, githubLastStartedAt: at(-8 * 3600_000) }, now)).toBe(true);
    expect(receiveMacProbe({ checkedAt: at(-120_000), healthy: true }, now)).toBe(true);
    expect(receiveMacProbe({ checkedAt: at(120_000), healthy: true }, now)).toBe(false);
    expect(receiveMacProbe({ checkedAt: at(-3600_000), healthy: true }, now)).toBe(false);
    expect(receiveMacProbe({ checkedAt: at(0), healthy: "false" }, now)).toBe(false);
    vi.resetModules();
    const { macProbeHealth: reloadedHealth } = await import("./mac-probe.js");
    expect(reloadedHealth(now)).toEqual({
      status: "fresh", checkedAt: at(-60_000), healthy: false,
      githubMonitor: { status: "stale", lastStartedAt: at(-8 * 3600_000) },
    });
    expect(reloadedHealth(now + 30 * 60_000)).toMatchObject({ status: "stale" });
    expect(receiveMacProbe({ checkedAt: at(0), healthy: true }, now)).toBe(true);
    expect(reloadedHealth(now)).toEqual({
      status: "fresh", checkedAt: at(0), healthy: true,
      githubMonitor: { status: "unknown", lastStartedAt: null },
    });
    writeFileSync(path.join(root, "mac-probe.json"), "{");
    expect(reloadedHealth(now)).toMatchObject({ status: "stale", checkedAt: null, healthy: null });
    expect(receiveMacProbe({ checkedAt: at(0), healthy: false }, now)).toBe(true);
    expect(reloadedHealth(now)).toMatchObject({ status: "fresh", checkedAt: at(0), healthy: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
