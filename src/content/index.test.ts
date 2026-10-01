import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "discord.js";
import { JobStore, type Job } from "./store.js";

const mocks = vi.hoisted(() => ({ env: { WORK_DIR: "" }, execute: vi.fn() }));
vi.mock("../env.js", () => ({ env: mocks.env }));
vi.mock("node:child_process", () => ({ execFile: mocks.execute }));

describe("content worker queue isolation", () => {
  let jobs: JobStore;
  let order: number;
  const create = (state: Job["state"], channel: string, message?: string) => {
    const job = jobs.create("waenyamyeon", channel, "body", channel);
    Object.assign(job, { state, message, created: new Date(order++).toISOString() });
    jobs.save(job);
    return job;
  };
  const start = async (fetch: ReturnType<typeof vi.fn>) => {
    const { startContentWorker } = await import("./index.js");
    startContentWorker({ channels: { fetch } } as unknown as Client);
    await vi.advanceTimersByTimeAsync(0);
  };
  const failWith = (code: number) => (_file: string, _args: string[], _options: unknown,
    callback: (error: Error, stdout: string, stderr: string) => void) => {
    callback(Object.assign(new Error("worker failed"), { code }), "", "");
  };

  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.stubEnv("CONTENT_ENABLED", "true");
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.env.WORK_DIR = mkdtempSync(join(tmpdir(), "content-worker-"));
    jobs = new JobStore(join(mocks.env.WORK_DIR, "content"));
    order = 0;
    mocks.execute.mockImplementation((_file: string, args: string[], _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      writeFileSync(join(args[2], "manifest.json"), JSON.stringify({
        hash: "test-hash", account: "test-account", caption: "caption", review: { summary: "ok" }, previews: [],
      }));
      callback(null, "", "");
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(mocks.env.WORK_DIR, { recursive: true, force: true });
  });

  it("does not fetch channels for rejected, notified, or already presented jobs", async () => {
    create("rejected", "deleted");
    create("review", "deleted", "review-message");
    for (const state of ["published", "failed", "uncertain"] as const) create(state, "deleted", `notice:${state}`);
    const fetch = vi.fn();
    await start(fetch);
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("continues generating later jobs when an earlier channel fetch fails", async () => {
    const deleted = create("queued", "deleted");
    const next = create("queued", "available");
    const send = vi.fn().mockResolvedValue({ id: "review-message" });
    const fetch = vi.fn().mockRejectedValueOnce(new Error("Unknown Channel"))
      .mockResolvedValue({ isSendable: () => true, send });
    await start(fetch);
    expect(fetch.mock.calls.map(call => call[0])).toEqual(["deleted", "available"]);
    expect(jobs.get(deleted.id).state).toBe("queued");
    expect(jobs.get(next.id)).toMatchObject({ state: "review", hash: "test-hash", message: "review-message" });
    expect(mocks.execute).toHaveBeenCalledOnce();
  });

  it("isolates failed notifications and retries only the unsent notice next tick", async () => {
    const first = create("failed", "unavailable");
    const next = create("published", "available");
    const failedSend = vi.fn().mockRejectedValueOnce(new Error("Missing Permissions"))
      .mockResolvedValue({ id: "notice" });
    const goodSend = vi.fn().mockResolvedValue({ id: "notice" });
    const fetch = vi.fn().mockImplementation(async (channel: string) => ({
      isSendable: () => true, send: channel === "unavailable" ? failedSend : goodSend,
    }));
    await start(fetch);
    expect(jobs.get(first.id).message).toBeUndefined();
    expect(jobs.get(next.id).message).toBe("notice:published");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(jobs.get(first.id).message).toBe("notice:failed");
    expect(goodSend).toHaveBeenCalledOnce();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("does not let a missing review manifest prevent later job processing", async () => {
    create("review", "broken-review");
    const next = create("queued", "available");
    const send = vi.fn().mockResolvedValue({ id: "review-message" });
    await start(vi.fn().mockResolvedValue({ isSendable: () => true, send }));
    expect(jobs.get(next.id).state).toBe("review");
    expect(mocks.execute).toHaveBeenCalledOnce();
  });

  it("resumes transient generation errors on the next tick without a premature failure notice", async () => {
    const job = create("queued", "available");
    mocks.execute.mockImplementationOnce(failWith(75));
    const send = vi.fn().mockResolvedValue({ id: "review-message" });
    await start(vi.fn().mockResolvedValue({ isSendable: () => true, send }));
    expect(jobs.get(job.id)).toMatchObject({ state: "queued", generationAttempts: 1 });
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(jobs.get(job.id)).toMatchObject({ state: "review", generationAttempts: 2, message: "review-message" });
    expect(jobs.get(job.id).error).toBeUndefined();
    expect(mocks.execute.mock.calls.map(call => call[1][2])).toEqual([jobs.path(job.id), jobs.path(job.id)]);
    expect(send).toHaveBeenCalledOnce();
  });

  it("reports a transient failure only after three generation attempts", async () => {
    const job = create("queued", "available");
    mocks.execute.mockImplementation(failWith(75));
    const send = vi.fn().mockResolvedValue({ id: "notice" });
    await start(vi.fn().mockResolvedValue({ isSendable: () => true, send }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(jobs.get(job.id)).toMatchObject({ state: "queued", generationAttempts: 2 });
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(jobs.get(job.id)).toMatchObject({ state: "failed", generationAttempts: 3, message: "notice:failed" });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(mocks.execute).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenCalledOnce();
  });

  it("does not retry quality or other permanent failures", async () => {
    const job = create("queued", "available");
    mocks.execute.mockImplementation(failWith(1));
    const send = vi.fn().mockResolvedValue({ id: "notice" });
    await start(vi.fn().mockResolvedValue({ isSendable: () => true, send }));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(jobs.get(job.id)).toMatchObject({ state: "failed", generationAttempts: 1 });
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
  });

  it("continues an interrupted generation with its persisted attempt budget", async () => {
    const job = create("generating", "available");
    job.generationAttempts = 2; jobs.save(job);
    mocks.execute.mockImplementation(failWith(75));
    const send = vi.fn().mockResolvedValue({ id: "notice" });
    await start(vi.fn().mockResolvedValue({ isSendable: () => true, send }));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(jobs.get(job.id)).toMatchObject({ state: "failed", generationAttempts: 3 });
    expect(mocks.execute).toHaveBeenCalledOnce();
  });

  it("never retries a publishing failure even when the exit code is transient", async () => {
    vi.stubEnv("CONTENT_PUBLISH_ENABLED", "true");
    vi.stubEnv("WAENYAMYEON_IG_USER_ID", "test-account");
    vi.stubEnv("WAENYAMYEON_IG_ACCESS_TOKEN", "test-token");
    vi.stubEnv("CONTENT_GRAPH_VERSION", "test-version");
    vi.stubEnv("CONTENT_S3_BUCKET", "test-bucket");
    const job = create("approved", "available");
    writeFileSync(join(jobs.path(job.id), "manifest.json"), JSON.stringify({ account: "test-account" }));
    mocks.execute.mockImplementation(failWith(75));
    const send = vi.fn().mockResolvedValue({ id: "notice" });
    await start(vi.fn().mockResolvedValue({ isSendable: () => true, send }));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(jobs.get(job.id)).toMatchObject({ state: "uncertain", message: "notice:uncertain" });
    expect(jobs.get(job.id).generationAttempts).toBeUndefined();
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(mocks.execute.mock.calls[0][1][1]).toBe("publish");
    expect(send).toHaveBeenCalledOnce();
  });
});
