import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ButtonInteraction } from "discord.js";
import { JobStore } from "./store.js";
const mocks = vi.hoisted(() => ({ env: { WORK_DIR: "" } }));
vi.mock("../env.js", () => ({ env: mocks.env }));
describe("failed generation retry button", () => {
  beforeEach(() => {
    vi.resetModules(); vi.stubEnv("CONTENT_ENABLED", "true"); vi.stubEnv("GEMINI_API_KEY", "test");
    mocks.env.WORK_DIR = mkdtempSync(join(tmpdir(), "retry-content-"));
  });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(mocks.env.WORK_DIR, { recursive: true, force: true }); });
  it("queues one new draft and removes the button without approving publication", async () => {
    const jobs = new JobStore(join(mocks.env.WORK_DIR, "content"));
    const old = jobs.create("instatoon", "쿠키", "원문", "channel"); old.state = "failed"; jobs.save(old);
    const interaction = { customId: `content:retry:${old.id}`, channelId: "channel", deferReply: vi.fn(), editReply: vi.fn(),
      message: { edit: vi.fn() } };
    const { contentButton } = await import("./index.js");
    await contentButton(interaction as unknown as ButtonInteraction);
    await contentButton(interaction as unknown as ButtonInteraction);
    expect(jobs.list()).toHaveLength(2);
    expect(jobs.list().find(j => j.retryOf === old.id)).toMatchObject({ state: "queued", body: "원문" });
    expect(jobs.list().some(j => j.state === "approved" || j.state === "publishing")).toBe(false);
    expect(interaction.message.edit).toHaveBeenCalledWith({ components: [] });
  });
  it("does not queue generation if its API is disconnected", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const jobs = new JobStore(join(mocks.env.WORK_DIR, "content"));
    const old = jobs.create("instatoon", "쿠키", "원문", "channel"); old.state = "failed"; jobs.save(old);
    const interaction = { customId: `content:retry:${old.id}`, channelId: "channel", deferReply: vi.fn(), editReply: vi.fn(), message: { edit: vi.fn() } };
    const { contentButton } = await import("./index.js");
    await contentButton(interaction as unknown as ButtonInteraction);
    expect(jobs.list()).toHaveLength(1);
    expect(interaction.message.edit).not.toHaveBeenCalled();
  });
  it("does not report rejection or duplicate paid work when accepted notification fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const jobs = new JobStore(join(mocks.env.WORK_DIR, "content"));
      const old = jobs.create("instatoon", "쿠키", "원문", "channel"); old.state = "failed"; jobs.save(old);
      const interaction = { customId: `content:retry:${old.id}`, channelId: "channel", deferReply: vi.fn(),
        editReply: vi.fn().mockRejectedValue(new Error("Discord unavailable")),
        message: { edit: vi.fn().mockRejectedValue(new Error("message unavailable")) } };
      const { contentButton } = await import("./index.js");
      await expect(contentButton(interaction as unknown as ButtonInteraction)).resolves.toBeUndefined();
      await contentButton(interaction as unknown as ButtonInteraction);
      expect(jobs.list()).toHaveLength(2);
      expect(interaction.editReply).toHaveBeenCalledTimes(2);
      expect(interaction.editReply.mock.calls.every(([text]) => String(text).includes("새 초안을 제작"))).toBe(true);
      expect(jobs.list().find(j => j.retryOf === old.id)?.state).toBe("queued");
    } finally { log.mockRestore(); }
  });
});
