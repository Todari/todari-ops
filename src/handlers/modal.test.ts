import type { ModalSubmitInteraction } from "discord.js";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: { WORK_DIR: "", OWNER_DISCORD_ID: "owner" },
  inbox: vi.fn(),
  firstTask: vi.fn(),
  send: vi.fn(),
}));
vi.mock("../env.js", () => ({ env: mocks.env }));
vi.mock("../discord/alerts.js", () => ({ fetchInboxChannel: mocks.inbox }));
vi.mock("../checkin/index.js", () => ({ saveTomorrowFirstTask: mocks.firstTask }));

let root: string;
let queue: string;
const note = "📥 [checkin] (2026-11-19) 오늘: 작업\n막힘: 원인\n내일: 첫 작업";
const interaction = (owner = "owner") => ({
  id: "123456789",
  user: { id: owner },
  customId: "checkin:submit:2026-11-19",
  fields: { getTextInputValue: (id: string) => ({ done: "작업", stuck: "원인", tomorrow: "첫 작업" })[id] },
  reply: vi.fn(),
  deferReply: vi.fn(),
  editReply: vi.fn(),
});

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  root = mkdtempSync(join(tmpdir(), "checkin-inbox-"));
  mocks.env.WORK_DIR = join(root, "work");
  queue = join(root, "checkin-inbox.json");
  mocks.firstTask.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

it("keeps the full check-in when the inbox is missing and posts it once after restart", async () => {
  const submitted = interaction();
  mocks.inbox.mockImplementationOnce(() => {
    expect(JSON.parse(readFileSync(queue, "utf8")).pending).toEqual({ [submitted.id]: note });
    return null;
  });
  await (await import("./modal.js")).handleModalSubmit(submitted as unknown as ModalSubmitInteraction);
  expect(submitted.editReply).toHaveBeenCalledWith(expect.stringContaining("원문을 보관했어요"));
  expect(mocks.firstTask).toHaveBeenCalledWith("2026-11-19", "첫 작업");

  vi.resetModules();
  mocks.inbox.mockResolvedValue({ send: mocks.send });
  const restarted = await import("./modal.js");
  restarted.startCheckinInbox();
  await vi.advanceTimersByTimeAsync(0);
  await restarted.handleModalSubmit(submitted as unknown as ModalSubmitInteraction);
  expect(mocks.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    content: note, nonce: submitted.id, enforceNonce: true,
  }));
  expect(submitted.editReply).toHaveBeenLastCalledWith(expect.stringContaining("인박스에 기록했어요"));
  expect(JSON.parse(readFileSync(queue, "utf8")).pending).toEqual({});
});

it("denies other users before storing anything", async () => {
  const submitted = interaction("other");
  await (await import("./modal.js")).handleModalSubmit(submitted as unknown as ModalSubmitInteraction);
  expect(submitted.reply).toHaveBeenCalledWith(expect.objectContaining({ content: "권한 없음" }));
  expect(existsSync(queue)).toBe(false);
});
