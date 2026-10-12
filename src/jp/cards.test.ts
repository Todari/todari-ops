import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ env: { WORK_DIR: "" } }));
vi.mock("../env.js", () => ({ env: mocks.env }));

const day = (date: string) => Date.parse(`${date}T00:00:00+09:00`);

beforeEach(() => {
  mocks.env.WORK_DIR = mkdtempSync(join(tmpdir(), "jp-cards-"));
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(mocks.env.WORK_DIR, { recursive: true, force: true });
});

it("finds the phrase pushed on a KST day although the daily log is keyed by the UTC date", async () => {
  vi.setSystemTime(Date.parse("2026-10-11T08:10:00+09:00")); // 아침 푸시 시각 = UTC 로는 전날 23:10
  const cards = await import("./cards.js");
  const phrase = { front: "お疲れ様です", reading: "おつかれさまです", meaning: "수고하셨습니다", example: "", exampleKo: "", note: "", kind: "phrase" };
  await cards.insertCard({ ...phrase, front: "대화에서 저장한 카드", source: "chat", dueAt: new Date() });
  const pushed = await cards.insertCard({ ...phrase, source: "daily", dueAt: new Date() });
  await cards.logDaily(new Date().toISOString().slice(0, 10), pushed); // daily-push.ts 가 쓰는 키: "2026-10-10"

  expect(cards.dailyCardBetween(day("2026-10-11"), day("2026-10-12"))?.front).toBe("お疲れ様です");
  expect(cards.dailyCardBetween(day("2026-10-10"), day("2026-10-11"))).toBeUndefined();
});
