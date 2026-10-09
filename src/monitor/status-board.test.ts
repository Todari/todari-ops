import { MessageFlags } from "discord.js";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { getInstagramBrief, saveInstagramBrief, updateStatusBoard } from "./status-board.js";

const mocks = vi.hoisted(() => ({
  env: {
    STATUS_CHANNEL_ID: "status",
    WORK_DIR: `${process.env.TMPDIR ?? "/tmp"}/status-board-test-${process.pid}/work`,
  },
  send: vi.fn(async (_message: any) => ({ id: "board-1" })),
  edit: vi.fn(async (_id: string, _message: any) => ({})),
  uptime: [] as Array<Record<string, unknown>>,
  vaultAt: new Date().toISOString(),
}));
vi.mock("../env.js", () => ({ env: mocks.env }));
vi.mock("../discord/alerts.js", () => ({
  fetchTextChannel: async () => ({ send: mocks.send, messages: { edit: mocks.edit } }),
}));
vi.mock("../vault/state.js", () => ({
  getVaultState: () => ({ generatedAt: mocks.vaultAt, notes: [] }),
}));
vi.mock("./uptime.js", () => ({ getUptimeSnapshot: () => mocks.uptime }));
afterAll(() => rmSync(dirname(mocks.env.WORK_DIR), { recursive: true, force: true }));

it("posts the board once, then rewrites that message, and reposts only when it was deleted", async () => {
  mocks.uptime = [{ slug: "todari", status: "healthy", detail: "200" }];
  await updateStatusBoard("🟢 **섹터4** 오늘 1/1 · 어제 1/1");
  expect(mocks.send).toHaveBeenCalledTimes(1);
  const first = mocks.send.mock.calls[0]![0];
  expect(first.flags).toBe(MessageFlags.SuppressNotifications);
  expect(first.embeds[0].toJSON()).toMatchObject({
    color: 0x57f287,
    fields: [
      { value: "🟢 **섹터4** 오늘 1/1 · 어제 1/1" },
      { value: "🟢 todari" },
      { value: expect.stringContaining(`볼트 동기화 <t:${Math.floor(Date.parse(mocks.vaultAt) / 1000)}:R>`) },
    ],
  });

  // 볼트 동기화가 하루 넘게 끊기면 노랑으로 알린다.
  mocks.vaultAt = new Date(Date.now() - 27 * 3600_000).toISOString();
  await updateStatusBoard("🟢 **섹터4** 오늘 1/1 · 어제 1/1");
  expect(mocks.edit.mock.calls[0]![1].embeds[0].toJSON()).toMatchObject({
    color: 0xfee75c,
    fields: [{}, {}, { value: expect.stringContaining("🟡 볼트 동기화 <t:") }],
  });
  mocks.edit.mockClear();

  mocks.uptime = [{ slug: "lvti", checkName: "api", status: "down", detail: "HTTP 502" }];
  await updateStatusBoard(null);
  expect(mocks.send).toHaveBeenCalledTimes(1);
  expect(mocks.edit.mock.calls[0]![0]).toBe("board-1");
  expect(mocks.edit.mock.calls[0]![1].embeds[0].toJSON()).toMatchObject({
    color: 0xed4245,
    fields: [{ value: "워치독 현황을 아직 받지 못했습니다." }, { value: "🔴 lvti/api (HTTP 502)" }, {}],
  });

  // 일시 오류에는 새로 올리지 않는다(상태판이 둘이 되지 않게).
  mocks.edit.mockRejectedValueOnce(Object.assign(new Error("timeout"), { code: 500 }));
  await expect(updateStatusBoard(null)).rejects.toThrow("timeout");
  expect(mocks.send).toHaveBeenCalledTimes(1);
  // 메시지가 지워졌으면 새로 올린다.
  mocks.edit.mockRejectedValueOnce(Object.assign(new Error("Unknown Message"), { code: 10008 }));
  await updateStatusBoard(null);
  expect(mocks.send).toHaveBeenCalledTimes(2);
});

it("keeps the watchdog brief for the morning digest and flags it once the watchdog went quiet", () => {
  const at = Date.parse("2026-10-09T08:22:00+09:00");
  expect(getInstagramBrief(at)).toBeNull();
  saveInstagramBrief("어제 게시: 1/3건", at);
  expect(getInstagramBrief(at + 8 * 60_000)).toBe("어제 게시: 1/3건");
  expect(getInstagramBrief(at + 3 * 3600_000)).toBe(
    `⚠️ 워치독 현황이 <t:${at / 1000}:R> 이후 오지 않았습니다.\n어제 게시: 1/3건`,
  );
});
