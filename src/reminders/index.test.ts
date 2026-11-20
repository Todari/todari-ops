import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  env: { WORK_DIR: "", OWNER_DISCORD_ID: "owner" },
  fetch: vi.fn(),
  send: vi.fn(),
}));
vi.mock("../env.js", () => ({ env: mocks.env }));
vi.mock("../discord/client.js", () => ({ getDiscordClient: () => ({ channels: { fetch: mocks.fetch } }) }));

let root: string;
let file: string;
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  root = mkdtempSync(join(tmpdir(), "reminders-"));
  file = join(root, "reminders.json");
  mocks.env.WORK_DIR = join(root, "work");
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

it("rejects an unsaved reminder and preserves earlier requests", async () => {
  const { addReminder } = await import("./index.js");
  const first = await addReminder({ channelId: "one", content: "existing", fireAt: Date.now() + 30_000 });
  mkdirSync(file + ".tmp");
  await expect(addReminder({ channelId: "two", content: "failed write", fireAt: Date.now() + 30_000 })).rejects.toThrow();
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([first]);
  expect(vi.getTimerCount()).toBe(1);
});

it("keeps a legacy overdue reminder through missing channels, restart, and failed sends", async () => {
  const earlier = { id: "1234abcd", channelId: "one", content: "원문", fireAt: Date.now() - 10_000 };
  writeFileSync(file, JSON.stringify([earlier]));
  mocks.fetch.mockResolvedValueOnce(null).mockResolvedValue({ isSendable: () => true, send: mocks.send });
  mocks.send.mockRejectedValueOnce(new Error("send unavailable")).mockResolvedValue(undefined);

  (await import("./index.js")).startReminders();
  await vi.advanceTimersByTimeAsync(1);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([earlier]);

  vi.clearAllTimers();
  vi.resetModules();
  (await import("./index.js")).startReminders();
  await vi.advanceTimersByTimeAsync(1);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([earlier]);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(mocks.send).toHaveBeenCalledTimes(2);
  expect(mocks.send).toHaveBeenLastCalledWith(expect.objectContaining({
    content: expect.stringContaining("원문"), nonce: earlier.id, enforceNonce: true,
  }));
  expect(existsSync(file)).toBe(true);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([]);
});
