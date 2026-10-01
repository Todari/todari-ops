import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "discord.js";
import { JobStore } from "./store.js";
const mocks = vi.hoisted(() => ({ env: { WORK_DIR: "", OWNER_DISCORD_ID: "owner" } }));
vi.mock("../env.js", () => ({ env: mocks.env }));
let jobs: JobStore;
beforeEach(() => {
  vi.resetModules();
  mocks.env.WORK_DIR = mkdtempSync(join(tmpdir(), "content-channel-"));
  jobs = new JobStore(join(mocks.env.WORK_DIR, "content"));
  vi.stubEnv("INSTATOON_CHANNEL_ID", "studio");
  vi.stubEnv("CONTENT_ENABLED", "true");
  vi.stubEnv("GEMINI_API_KEY", "test");
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(mocks.env.WORK_DIR, { recursive: true, force: true }); });
function message(overrides: Record<string, unknown> = {}) {
  return { id: "message-1", guildId: "guild", channelId: "studio", author: { id: "owner", bot: false },
    content: '카페에서 친구 만난 날\n나: "많이 기다렸어?"\n친구: "방금 왔어."', reference: null,
    system: false, channel: { isThread: () => false }, reply: vi.fn().mockResolvedValue({}), ...overrides };
}
it("queues the whole message once and remains idempotent after restarting intake", async () => {
  let { contentChannelMessage } = await import("./index.js");
  const input = message();
  expect(await contentChannelMessage(input as unknown as Message)).toBe(true);
  expect(jobs.list()).toMatchObject([{ kind: "instatoon", topic: "카페에서 친구 만난 날", body: input.content,
    channel: "studio", sourceMessageId: "message-1", state: "queued" }]);
  vi.resetModules();
  ({ contentChannelMessage } = await import("./index.js"));
  await contentChannelMessage(input as unknown as Message);
  expect(jobs.list()).toHaveLength(1);
  expect(input.reply).toHaveBeenCalledTimes(1);
});
it("does not generate for other channels, users, bots, DMs, replies or system messages", async () => {
  const { contentChannelMessage } = await import("./index.js");
  for (const override of [{ channelId: "other" }, { author: { id: "other", bot: false } },
    { author: { id: "owner", bot: true } }, { guildId: null }, { reference: { messageId: "previous" } },
    { system: true }, { channel: { isThread: () => true } }]) {
    const input = message(override);
    await contentChannelMessage(input as unknown as Message);
    expect(input.reply).not.toHaveBeenCalled();
  }
  expect(jobs.list()).toHaveLength(0);
});
it("rejects empty/oversized messages and disabled generation without enqueueing", async () => {
  const { contentChannelMessage } = await import("./index.js");
  for (const content of [" ", "가".repeat(4001)]) {
    const input = message({ content });
    await contentChannelMessage(input as unknown as Message);
    expect(input.reply).toHaveBeenCalledOnce();
  }
  vi.stubEnv("CONTENT_ENABLED", "false");
  await contentChannelMessage(message() as unknown as Message);
  expect(jobs.list()).toHaveLength(0);
});
it("honors the existing queue limit", async () => {
  const { contentChannelMessage } = await import("./index.js");
  for (let i=0; i<5; i++) jobs.create("instatoon", "title", "body", "studio");
  const input = message();
  await contentChannelMessage(input as unknown as Message);
  expect(jobs.list()).toHaveLength(5);
  expect(input.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("5개") }));
});
it("store-level replay cannot duplicate an already received Discord message", () => {
  const first = jobs.create("instatoon", "title", "body", "studio", "source");
  const second = new JobStore(jobs.root).create("instatoon", "changed", "changed", "studio", "source");
  expect(first.id).toBe(second.id);
  expect(second.body).toBe("body");
});
