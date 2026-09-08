import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectConfig } from "../projects.js";

const mocks = vi.hoisted(() => ({
  env: { WORK_DIR: "/tmp/uptime-test/work", UPTIME_ENABLED: true, UPTIME_INTERVAL_MS: 300_000, ALERTS_CHANNEL_ID: "alerts" },
  projects: [] as ProjectConfig[],
  existsSync: vi.fn(), readFileSync: vi.fn(), mkdir: vi.fn(), writeFile: vi.fn(), rename: vi.fn(),
  send: vi.fn(), recordEvent: vi.fn(), completeCheck: vi.fn(), expectCheck: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("../env.js", () => ({ env: mocks.env }));
vi.mock("../projects.js", async (original) => {
  const actual = await original<typeof import("../projects.js")>();
  return { ...actual, getHealthTargets: () => actual.getHealthTargets(mocks.projects) };
});
vi.mock("node:fs", async (original) => ({
  ...await original<typeof import("node:fs")>(),
  existsSync: mocks.existsSync, readFileSync: mocks.readFileSync,
}));
vi.mock("node:fs/promises", () => ({ mkdir: mocks.mkdir, writeFile: mocks.writeFile, rename: mocks.rename }));
vi.mock("../discord/alerts.js", () => ({ fetchAlertsChannel: async () => ({ send: mocks.send }) }));
vi.mock("../observability/sentry.js", () => ({ captureException: vi.fn() }));
vi.mock("../stats/events.js", () => ({ recordEvent: mocks.recordEvent }));
vi.mock("./health.js", () => ({ runtimeHealth: { expectCheck: mocks.expectCheck, completeCheck: mocks.completeCheck } }));

const NOW = Date.UTC(2026, 8, 8, 1);
const INTERVAL = 300_000;
let uptime: typeof import("./uptime.js");
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
  mocks.env.UPTIME_ENABLED = true;
  mocks.env.ALERTS_CHANNEL_ID = "alerts";
  mocks.projects = ["alpha", "beta"].map((slug) => ({
    slug, name: slug, repoUrl: `https://github.com/example/${slug}.git`, defaultBranch: "main",
    healthUrl: `https://${slug}.example/health`,
  }));
  mocks.existsSync.mockReturnValue(false);
  mocks.mkdir.mockResolvedValue(undefined);
  mocks.writeFile.mockResolvedValue(undefined);
  mocks.rename.mockResolvedValue(undefined);
  mocks.send.mockResolvedValue(undefined);
  mocks.fetch.mockImplementation(async () => new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", mocks.fetch);
  uptime = await import("./uptime.js");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("uptime status and alert lifecycle", () => {
  it("does not show green before monitoring or before the first response", async () => {
    expect(uptime.getUptimeSnapshot()[0]).toMatchObject({
      status: "unknown", lastCheckedAt: null, lastOutcome: null, detail: "감시 시작 전",
    });
    let finish!: (response: Response) => void;
    mocks.fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    uptime.startUptimeMonitor();
    await flush();
    expect(uptime.getUptimeSnapshot().find((entry) => entry.slug === "alpha")).toMatchObject({
      status: "unknown", lastCheckedAt: null, detail: "아직 검사 전",
    });
    finish(new Response(null, { status: 200 }));
    await flush();
    expect(uptime.getUptimeSnapshot()[0]).toMatchObject({ status: "healthy", lastCheckedAt: NOW, lastOutcome: "success" });
  });

  it.each(["disabled", "no-channel"])("does not claim health when monitoring is %s", (reason) => {
    if (reason === "disabled") mocks.env.UPTIME_ENABLED = false;
    else mocks.env.ALERTS_CHANNEL_ID = "";
    uptime.startUptimeMonitor();
    const snapshot = uptime.getUptimeSnapshot();
    expect(snapshot.every((entry) => entry.status === "unknown" && entry.lastCheckedAt === null)).toBe(true);
    expect(uptime.formatUptimeSnapshot(snapshot)).not.toContain("🟢");
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.expectCheck).not.toHaveBeenCalled();
  });

  it("shows the first failed check as unknown, alerts on the second, and recovers once", async () => {
    let failing = true;
    mocks.fetch.mockImplementation(async (url: string) => new Response(null, {
      status: url.includes("alpha") && failing ? 503 : 200,
    }));
    uptime.startUptimeMonitor();
    await flush();
    expect(uptime.getUptimeSnapshot()[0]).toMatchObject({ key: "alpha", status: "unknown", lastOutcome: "failure" });
    expect(uptime.getUptimeSnapshot()[0].detail).toContain("1회 실패");
    expect(mocks.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(uptime.getUptimeSnapshot()[0]).toMatchObject({ key: "alpha", status: "down" });
    expect(mocks.recordEvent).toHaveBeenCalledWith("uptime_down", "alpha");
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mocks.writeFile.mock.lastCall![1]).alpha.up).toBe(false);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    failing = false;
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(uptime.getUptimeSnapshot().every((entry) => entry.status === "healthy")).toBe(true);
    expect(mocks.recordEvent).toHaveBeenLastCalledWith("uptime_recover", "alpha");
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(mocks.writeFile.mock.lastCall![1]).alpha.up).toBe(true);
  });

  it("marks old success and failure results stale instead of asserting current health", async () => {
    mocks.fetch.mockImplementation(async (url: string) => new Response(null, { status: url.includes("alpha") ? 503 : 200 }));
    uptime.startUptimeMonitor();
    await flush();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    const checkedAt = Date.now();
    vi.setSystemTime(checkedAt + INTERVAL * 2 + 30_001);
    const snapshot = uptime.getUptimeSnapshot();
    expect(snapshot.every((entry) => entry.status === "stale" && entry.lastCheckedAt === checkedAt)).toBe(true);
    expect(snapshot.find((entry) => entry.key === "alpha")).toMatchObject({ lastOutcome: "failure" });
    expect(snapshot.find((entry) => entry.key === "beta")).toMatchObject({ lastOutcome: "success" });
    expect(uptime.formatUptimeSnapshot(snapshot)).not.toContain("🟢");
  });

  it("retains legacy outage deduplication but requires a new check after restart", async () => {
    mocks.existsSync.mockReturnValue(true);
    mocks.readFileSync.mockReturnValue(JSON.stringify({ alpha: { up: false, downSince: NOW - 60_000 } }));
    mocks.fetch.mockImplementation(async () => new Response(null, { status: 503 }));
    uptime.startUptimeMonitor();
    expect(uptime.getUptimeSnapshot().find((entry) => entry.key === "alpha")).toMatchObject({ status: "unknown", lastCheckedAt: null });
    await flush();
    expect(uptime.getUptimeSnapshot().find((entry) => entry.key === "alpha")).toMatchObject({ status: "down" });
    expect(mocks.recordEvent).not.toHaveBeenCalledWith("uptime_down", "alpha");
    mocks.fetch.mockImplementation(async () => new Response(null, { status: 200 }));
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(mocks.recordEvent).toHaveBeenCalledWith("uptime_recover", "alpha");
  });

  it("keeps component failures separate from a project's healthy website", async () => {
    mocks.projects[0].healthChecks = [{ id: "api", name: "API", url: "https://api.alpha.example/health", expectJson: { ok: true } }];
    mocks.fetch.mockImplementation(async (url: string) => url.includes("api.alpha")
      ? Response.json({ ok: false }) : new Response(null, { status: 200 }));
    uptime.startUptimeMonitor();
    await flush();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(uptime.getUptimeSnapshot()[0]).toMatchObject({ key: "alpha:api", slug: "alpha", checkName: "API", status: "down" });
    expect(uptime.getUptimeSnapshot().find((entry) => entry.key === "alpha")).toMatchObject({ status: "healthy" });
    expect(JSON.parse(mocks.writeFile.mock.lastCall![1])["alpha:api"].up).toBe(false);
    expect(uptime.formatUptimeSnapshot(uptime.getUptimeSnapshot()).split("\n")[0]).toContain("alpha/API");
  });

  it("serializes outage state writes from concurrent targets", async () => {
    mocks.fetch.mockImplementation(async () => new Response(null, { status: 503 }));
    let finishWrite!: () => void;
    mocks.writeFile.mockImplementationOnce(() => new Promise<void>((resolve) => { finishWrite = resolve; }));
    uptime.startUptimeMonitor();
    await flush();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    expect(mocks.rename).not.toHaveBeenCalled();
    expect(uptime.getUptimeSnapshot().every((entry) => entry.status === "down")).toBe(true);
    finishWrite();
    await flush();
    expect(mocks.writeFile).toHaveBeenCalledTimes(2);
    expect(mocks.rename).toHaveBeenCalledTimes(2);
    expect(JSON.parse(mocks.writeFile.mock.lastCall![1])).toMatchObject({ alpha: { up: false }, beta: { up: false } });
  });

  it("does not overlap a stalled sweep and keeps each target's actual check time", async () => {
    let finish!: (response: Response) => void;
    mocks.fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    uptime.startUptimeMonitor();
    await flush();
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.completeCheck).not.toHaveBeenCalled();
    finish(new Response(null, { status: 200 }));
    await flush();
    expect(uptime.getUptimeSnapshot().find((entry) => entry.key === "alpha")).toMatchObject({ status: "healthy", lastCheckedAt: Date.now() });
    expect(uptime.getUptimeSnapshot().find((entry) => entry.key === "beta")).toMatchObject({ status: "stale", lastCheckedAt: NOW });
  });

  it("formats check age, prioritizes problems, and respects the embed field limit", async () => {
    uptime.startUptimeMonitor();
    await flush();
    const snapshot = uptime.getUptimeSnapshot();
    const entries = Array.from({ length: 30 }, (_, index) => ({ ...snapshot[0], key: `target-${index}`, slug: `target-${index}`, status: index === 29 ? "down" as const : "healthy" as const }));
    const text = uptime.formatUptimeSnapshot(entries, NOW + 120_000, 300);
    expect(text.split("\n")[0]).toContain("🔴 장애 · target-29");
    expect(text).toContain("검사 2분 전");
    expect(text).toMatch(/… 외 \d+개$/);
    expect(text.length).toBeLessThanOrEqual(300);
    expect(entries[0].slug).toBe("target-0");
  });
});

describe("JSON health probes", () => {
  it("requires the configured JSON fields and exact value types", async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({ status: "ok", db: "ok", extra: 1 }));
    expect(await uptime.probe("https://api.example/health", { status: "ok", db: "ok" })).toMatchObject({ ok: true });
    mocks.fetch.mockResolvedValueOnce(Response.json({ ok: "true" }));
    expect(await uptime.probe("https://api.example/health", { ok: true })).toMatchObject({ ok: false, detail: expect.stringContaining("ok") });
    mocks.fetch.mockResolvedValueOnce(Response.json({ status: "ok" }));
    expect(await uptime.probe("https://api.example/health", { db: "ok" })).toMatchObject({ ok: false });
  });

  it.each(["<html>login</html>", "null", "[]", "{broken", " ".repeat(16_385)])("rejects HTTP 200 with invalid or oversized health data %#", async (body) => {
    mocks.fetch.mockResolvedValueOnce(new Response(body, { status: 200 }));
    expect(await uptime.probe("https://api.example/health", { ok: true })).toMatchObject({ ok: false });
  });

  it("keeps the existing HTTP-only smoke check and rejects HTTP errors even with healthy JSON", async () => {
    mocks.fetch.mockResolvedValueOnce(new Response("<html>website</html>", { status: 200 }));
    expect(await uptime.probe("https://web.example")).toEqual({ ok: true, detail: "HTTP 200" });
    mocks.fetch.mockResolvedValueOnce(Response.json({ ok: true }, { status: 503 }));
    expect(await uptime.probe("https://api.example/health", { ok: true })).toEqual({ ok: false, detail: "HTTP 503" });
  });
});
