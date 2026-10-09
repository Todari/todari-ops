import type { Client } from "discord.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  env: {
    WORK_DIR: "", DIGEST_TIME: "08:30", DIGEST_CHANNEL_ID: "daily", ALERTS_CHANNEL_ID: "",
    CHECKIN_TIME: "21:30", JP_PUSH_HOUR: 8, JP_PUSH_MINUTE: 10,
  },
  send: vi.fn(),
}));
vi.mock("../env.js", () => ({ env: mocks.env }));
vi.mock("../discord/alerts.js", () => ({
  fetchDigestChannel: async () => ({ send: mocks.send }),
  fetchJpChannel: async () => ({ send: mocks.send }),
}));
vi.mock("../observability/sentry.js", () => ({ captureException: vi.fn() }));
vi.mock("../github/api.js", () => ({ ghJson: async () => null }));
vi.mock("../monitor/uptime.js", () => ({ getUptimeSnapshot: () => [], formatUptimeSnapshot: () => "" }));
vi.mock("../webhook/pending.js", () => ({ putPendingAction: vi.fn() }));
vi.mock("../jp/tutor.js", () => ({
  generateDailyPhrase: async () => ({ front: "お疲れ様", reading: "おつかれさま", meaning: "수고했어요", example: "", exampleKo: "", note: "" }),
}));
vi.mock("../jp/cards.js", () => ({ insertCard: async () => 1, logDaily: async () => {}, recentDailyFronts: async () => [] }));

// 2026-10-09 는 금요일(KST). 예약: 일본어 08:10 · 다이제스트 08:30 · 주간 금 18:00 · 체크인 21:30.
const kst = (hhmm: string, date = "2026-10-09") => Date.parse(`${date}T${hhmm}:00+09:00`);
let root: string;
const file = () => join(root, "scheduled-posts.json");
const seed = (state: Record<string, string>) => writeFileSync(file(), JSON.stringify(state));
const saved = () => JSON.parse(readFileSync(file(), "utf8")) as Record<string, string>;
const TITLES = { digest: "데일리 다이제스트", weekly: "주간 요약", checkin: "저녁 체크인", "jp-push": "오늘의 표현" };
/** 지금까지 채널에 게시된 메시지를 예약 이름으로 바꿔 순서대로 돌려준다. */
const posted = () => mocks.send.mock.calls.map(([message]) =>
  Object.entries(TITLES).find(([, title]) => JSON.stringify(message).includes(title))?.[0]);

/** 봇 (재)시작: 메모리 상태와 걸려 있던 타이머를 버리고 bot.ts 처럼 네 예약을 모두 건다. */
async function boot(now: number) {
  vi.clearAllTimers();
  vi.resetModules();
  vi.setSystemTime(now);
  const [daily, weekly, checkin, jp] = await Promise.all([
    import("../digest/daily.js"), import("../digest/weekly.js"), import("../checkin/index.js"), import("../jp/daily-push.js"),
  ]);
  daily.startDailyDigest();
  weekly.startWeeklySummary();
  checkin.startEveningCheckin();
  jp.scheduleJpPush({} as Client);
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => {});
  root = mkdtempSync(join(tmpdir(), "scheduled-"));
  mocks.env.WORK_DIR = join(root, "work");
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

it("catches up once after a restart past the scheduled time, then only arms the next run", async () => {
  seed({ digest: "2026-10-08" });
  await boot(kst("10:00"));
  expect(posted()).toEqual(["digest"]);
  expect(saved().digest).toBe("2026-10-09");

  await boot(kst("10:05")); // 같은 날 또 재시작 — 이미 게시했다
  expect(posted()).toEqual(["digest"]);

  await vi.advanceTimersByTimeAsync(kst("08:30", "2026-10-10") - kst("10:05"));
  expect(posted()).toEqual(["digest", "weekly", "checkin", "jp-push", "digest"]);
});

it.each([-1, 0, 1])("posts exactly once when startup lands %ims from the scheduled instant", async (offset) => {
  seed({ digest: "2026-10-08" });
  await boot(kst("08:30") + offset);
  await vi.advanceTimersByTimeAsync(2 * 3600_000);
  expect(posted()).toEqual(["digest"]);
});

it("catches up every missed schedule once, each on its own record", async () => {
  seed({ digest: "2026-10-08", "jp-push": "2026-10-08", checkin: "2026-10-08", weekly: "2026-10-02" });
  await boot(kst("22:00"));
  expect(posted().sort()).toEqual(["checkin", "digest", "jp-push", "weekly"]);
  expect(saved()).toEqual({ digest: "2026-10-09", "jp-push": "2026-10-09", checkin: "2026-10-09", weekly: "2026-10-09" });

  await boot(kst("22:10"));
  expect(posted()).toHaveLength(4);
});

it("skips a schedule already posted today even when its timer fires later that day", async () => {
  seed({ digest: "2026-10-09" });
  await boot(kst("07:00")); // 예: DIGEST_TIME 을 늦춘 뒤 재배포
  await vi.advanceTimersByTimeAsync(2 * 3600_000);
  expect(posted()).toEqual(["jp-push"]);
});

it("does not count a manual post as the scheduled one", async () => {
  seed({ digest: "2026-10-08" });
  await boot(kst("08:20"));
  await (await import("../digest/daily.js")).postDigest();
  expect(saved().digest).toBe("2026-10-08");
  await vi.advanceTimersByTimeAsync(3600_000);
  expect(posted()).toEqual(["digest", "digest"]);
});

it("does not catch up without an earlier record or on a later day", async () => {
  await boot(kst("22:00")); // 첫 배포: 구버전이 오늘 이미 게시했을 수 있다
  expect(posted()).toEqual([]);

  seed({ weekly: "2026-10-02" });
  await boot(kst("10:00", "2026-10-10")); // 금요일 주간 요약을 놓치고 토요일에 시작
  expect(posted()).toEqual([]);
  expect((await import("./scheduled-posts.js")).missedTodayKst("weekly", Number.NaN)).toBe(false);
});
