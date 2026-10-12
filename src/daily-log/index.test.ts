import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  env: {
    WORK_DIR: "", DAILY_LOG_TIME: "00:40", DAILY_LOG_AUTHOR: "", DAILY_LOG_OWNERS: [] as string[],
    VAULT_REPO_URL: "https://github.com/Todari/obsidian-vault.git",
  },
  ghJson: vi.fn(), added: vi.fn(), write: vi.fn(), brief: vi.fn(), card: vi.fn(), firstTask: vi.fn(),
  captureException: vi.fn(),
}));
vi.mock("../env.js", () => ({ env: mocks.env }));
vi.mock("../github/api.js", () => ({ ghJson: mocks.ghJson }));
vi.mock("../vault/mutations.js", () => ({ listVaultNotesAdded: mocks.added, writeVaultDailyLog: mocks.write }));
vi.mock("../monitor/status-board.js", () => ({ readInstagramBrief: mocks.brief }));
vi.mock("../jp/cards.js", () => ({ dailyCardBetween: mocks.card }));
vi.mock("../checkin/index.js", () => ({ getFirstTaskChosenOn: mocks.firstTask }));
vi.mock("../observability/sentry.js", () => ({ captureException: mocks.captureException }));
// 운영 이벤트(stats/events)와 예약 기록(scheduled-posts)은 실제 구현이 임시 /data 를 읽고 쓴다.
import { groupCommits, groupNotes, kstDayWindow, renderDailyLog, summarize, type DayEvidence } from "./evidence.js";

const kst = (hhmm: string, date = "2026-10-12") => Date.parse(`${date}T${hhmm}:00+09:00`);
const DAY = kstDayWindow("2026-10-11");
/** 검색 결과의 커밋 하나. author 는 작성자에 연결된 GitHub 계정이다(연결된 계정이 없으면 null). */
const commit = (repo: string, message: string, at: string, login: string | null = "octo-owner") => ({
  repository: { full_name: repo },
  author: login ? { login } : null,
  commit: { message, committer: { date: `2026-10-${at}:00.000+09:00` } },
});
/** 검색은 됐고 커밋이 없었다. 검색이 실패하면 ghJson 은 이것이 아니라 null 을 준다. */
const NO_COMMITS = { total_count: 0, items: [] };
const evidence = (over: Partial<DayEvidence> = {}): DayEvidence => ({
  commits: [], commitsBeyondPage: 0, events: [], notes: [], ...over,
});
/** GitHub 의 답: 커밋 검색 결과(null 이면 검색 실패)와 토큰의 주인(GET /user, null 이면 알아내지 못한다). */
function github(search: unknown = NO_COMMITS, login: string | null = "octo-owner") {
  mocks.ghJson.mockImplementation(async (path: string) => (path === "/user" ? login && { login } : search));
}
/** 봇이 GitHub 에 물은 것들, 순서대로. */
const asked = () => mocks.ghJson.mock.calls.map(([path]) => decodeURIComponent(String(path)));

describe("kstDayWindow", () => {
  it("is the KST calendar day, nine hours ahead of the UTC one", () => {
    expect(new Date(DAY.start).toISOString()).toBe("2026-10-10T15:00:00.000Z");
    expect(new Date(DAY.end).toISOString()).toBe("2026-10-11T15:00:00.000Z");
  });
});

describe("groupCommits", () => {
  it("groups by repo with the busiest first and each repo's commits in the order they happened", () => {
    const items = [ // 검색 결과는 최신순
      commit("Todari/todari-ops", "fix: second", "11T21:00"),
      commit("linkive/for-creator", "chore: bump", "11T15:00"),
      commit("Todari/todari-ops", "feat: first\n\nlong body", "11T09:00"),
    ];
    expect(groupCommits(items, DAY, "Todari/obsidian-vault")).toEqual([
      { fullName: "Todari/todari-ops", repo: "todari-ops", subjects: ["feat: first", "fix: second"] },
      { fullName: "linkive/for-creator", repo: "for-creator", subjects: ["chore: bump"] },
    ]);
  });

  it("drops the vault repo, vault commits and commits outside the day", () => {
    const items = [
      commit("Todari/todari", "feat: next day", "12T00:00"), // 자정 정각은 다음 날
      commit("Todari/todari", "feat: last minute", "11T23:59"),
      commit("todari/Obsidian-Vault", "docs: note by hand", "11T12:00"),
      commit("Todari/notes", "vault backup: 2026-10-11 12:00:01", "11T12:00"),
      commit("Todari/notes", "vault: daily log 2026-10-10 via todari-ops", "11T00:40"),
      commit("Todari/todari", "feat: first minute", "11T00:00"),
      commit("Todari/todari", "feat: previous day", "10T23:59"),
      { repository: { full_name: "Todari/todari" }, commit: { message: "no date" } },
    ];
    expect(groupCommits(items, DAY, "Todari/obsidian-vault")).toEqual([
      { fullName: "Todari/todari", repo: "todari", subjects: ["feat: first minute", "feat: last minute"] },
    ]);
  });
});

describe("groupNotes", () => {
  it("names the note type from its folder and skips daily notes, archive and templates", () => {
    expect(groupNotes([
      "공부/개념/이벤트 루프.md",
      "공부/TIL/git 날짜.md",
      "프로젝트/todari-ops 의사결정/2026-10-11 알림 정책.md",
      "이정표/의사결정/2026-10-11 가격 정책.md",
      "공부/트러블슈팅/볼트 push 충돌.md",
      "데일리/2026-10-10.md",
      "Archive/옛 노트.md",
      "템플릿/데일리.md",
      ".trash/지운 노트.md",
      "홈.md",
      "공부/TIL/한글 이름.md".normalize("NFD"), // macOS 가 자모로 풀어 저장한 이름도 같은 묶음, 링크는 NFC
    ])).toEqual([
      ["의사결정", ["2026-10-11 알림 정책", "2026-10-11 가격 정책"]],
      ["TIL", ["git 날짜", "한글 이름"]],
      ["트러블슈팅", ["볼트 push 충돌"]],
      ["공부", ["이벤트 루프"]],
      ["루트", ["홈"]],
    ]);
  });
});

describe("renderDailyLog", () => {
  const full = evidence({
    commits: [
      { fullName: "Todari/todari-ops", repo: "todari-ops", subjects: ["feat: a", "fix: b", "docs: c"] },
      { fullName: "Todari/lovetype", repo: "lovetype", subjects: ["fix: d"] },
    ],
    events: [
      { t: 1, kind: "vercel_deploy", project: "todari" }, { t: 2, kind: "vercel_deploy", project: "todari" },
      { t: 3, kind: "vercel_deploy", project: "lvti" }, { t: 4, kind: "vercel_fail", project: "lvti" },
      { t: 5, kind: "ci_fail", project: "todari-ops" }, { t: 6, kind: "pr_opened", project: "haengdong" },
      { t: 7, kind: "pr_merged", project: "haengdong" }, { t: 8, kind: "uptime_down", project: "toksai" },
      { t: 9, kind: "uptime_recover", project: "toksai" }, { t: 10, kind: "sentry_alert", project: "jeongpyo" },
      { t: 11, kind: "diag" },
    ],
    notes: ["이정표/의사결정/2026-10-11 가격 정책.md", "공부/TIL/git 날짜.md", "데일리/2026-10-10.md"],
    instagram: "어제 게시: 1/3건\n· 공구함 gonggu-daily 1/1\n· 야있날 game-flow-reel 0/2 ← 미게시 있음\n최근 7일: 공구함 1/1 · 야있날 1/3",
    jp: "お疲れ様です (おつかれさまです) — 수고하셨습니다",
    firstTask: "todari-ops · 자동 데일리 기록\n배포 확인",
  });

  it("writes every section that has evidence, in the note's order", () => {
    expect(renderDailyLog(full)).toBe([
      "### 코드",
      "- **todari-ops** 3건: feat: a; fix: b; docs: c",
      "- **lovetype** 1건: fix: d",
      "### 운영",
      "- 배포 3건 (todari×2, lvti)",
      "- 배포 실패 1건 (lvti)",
      "- CI 실패 1건 (todari-ops)",
      "- PR 열림 1건 (haengdong)",
      "- PR 머지 1건 (haengdong)",
      "- 장애 1건 (toksai)",
      "- 복구 1건 (toksai)",
      "- Sentry 1건 (jeongpyo)",
      "- 자동진단 1건",
      "### 인스타 게시",
      "게시: 1/3건", // 그날의 노트에서는 "어제"가 아니다
      "· 공구함 gonggu-daily 1/1",
      "· 야있날 game-flow-reel 0/2 ← 미게시 있음",
      "최근 7일: 공구함 1/1 · 야있날 1/3",
      "### 볼트",
      "- 의사결정: [[2026-10-11 가격 정책]]",
      "- TIL: [[git 날짜]]",
      "### 일본어",
      "- お疲れ様です (おつかれさまです) — 수고하셨습니다",
      "### 내일 첫 작업",
      "- todari-ops · 자동 데일리 기록 배포 확인",
    ].join("\n"));
    expect(summarize(full)).toBe("커밋 4 · 배포 3 · 장애 1 · 새 노트 2");
  });

  it("leaves out empty sections and writes nothing at all without evidence", () => {
    expect(renderDailyLog(evidence({ jp: "ただいま (ただいま) — 다녀왔습니다" }))).toBe(
      "### 일본어\n- ただいま (ただいま) — 다녀왔습니다",
    );
    expect(summarize(evidence({ jp: "ただいま" }))).toBe("기록됨");
    expect(renderDailyLog(evidence({ notes: ["데일리/2026-10-10.md"] }))).toBe("");
  });

  it("shows five commit subjects cut to 70 characters and counts the rest", () => {
    const long = `feat: ${"가".repeat(80)}`;
    const subjects = [long, "b", "c", "d", "e", "f", "g"];
    const [line, beyond] = renderDailyLog(
      evidence({ commits: [{ fullName: "Todari/todari", repo: "todari", subjects }], commitsBeyondPage: 20 }),
    ).split("\n").slice(1);
    expect(line).toBe(`- **todari** 7건: feat: ${"가".repeat(63)}…; b; c; d; e 외 2건`);
    expect(beyond).toBe("- 외 20건 (GitHub 검색 한 번에 담기는 100건 밖)");
    const notes = Array.from({ length: 12 }, (_, i) => `공부/TIL/노트 ${i + 1}.md`);
    expect(renderDailyLog(evidence({ notes }))).toMatch(/\[\[노트 10\]\] 외 2건$/);
  });
});

describe("nightly scheduler", () => {
  let root: string;
  const saved = (name: string) => JSON.parse(readFileSync(join(root, name), "utf8")) as Record<string, unknown>;
  const written = () => mocks.write.mock.calls.map(([date]) => date as string);
  const seed = (name: string, value: unknown) => writeFileSync(join(root, name), JSON.stringify(value));

  /** 봇 (재)시작: 메모리 상태와 걸려 있던 타이머를 버리고 bot.ts 처럼 예약을 건다. */
  async function boot(now: number) {
    vi.clearAllTimers();
    vi.resetModules();
    vi.setSystemTime(now);
    const log = await import("./index.js");
    log.startDailyLog();
    await vi.advanceTimersByTimeAsync(0);
    return log;
  }
  /** 2026-10-11 하루에 근거가 있었다. */
  function aBusyDay() {
    github({
      total_count: 2,
      items: [commit("Todari/todari-ops", "fix: b", "11T21:00"), commit("Todari/todari-ops", "feat: a", "11T09:00")],
    });
    mocks.added.mockResolvedValue(["이정표/의사결정/2026-10-11 가격 정책.md"]);
    seed("events.json", [
      { t: kst("23:59", "2026-10-10"), kind: "vercel_deploy", project: "어제" },
      { t: kst("14:00", "2026-10-11"), kind: "vercel_deploy", project: "todari" },
      { t: kst("00:10"), kind: "vercel_deploy", project: "오늘" },
    ]);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    for (const method of ["log", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
    root = mkdtempSync(join(tmpdir(), "daily-log-"));
    Object.assign(mocks.env, {
      WORK_DIR: join(root, "work"), DAILY_LOG_TIME: "00:40", DAILY_LOG_AUTHOR: "", DAILY_LOG_OWNERS: [],
    });
    github();
    mocks.added.mockResolvedValue([]);
    mocks.write.mockResolvedValue({ changed: true, commit: "abc1234", summary: "" });
    mocks.brief.mockReturnValue(null);
    mocks.card.mockReturnValue(undefined);
    mocks.firstTask.mockReturnValue(null);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it("writes the previous KST day's note at DAILY_LOG_TIME and leaves a summary for the digest", async () => {
    aBusyDay();
    mocks.brief.mockReturnValue({ brief: "어제 게시: 1/1건", at: kst("00:15") });
    mocks.card.mockReturnValue({ front: "お疲れ様です", reading: "おつかれさまです", meaning: "수고하셨습니다" });
    mocks.firstTask.mockReturnValue("todari-ops · 배포 확인");
    const log = await boot(kst("23:00", "2026-10-11"));
    expect(mocks.write).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(kst("00:40") - kst("23:00", "2026-10-11"));
    expect(mocks.write.mock.calls).toEqual([["2026-10-11", [
      "### 코드",
      "- **todari-ops** 2건: feat: a; fix: b",
      "### 운영",
      "- 배포 1건 (todari)",
      "### 인스타 게시",
      "게시: 1/1건",
      "### 볼트",
      "- 의사결정: [[2026-10-11 가격 정책]]",
      "### 일본어",
      "- お疲れ様です (おつかれさまです) — 수고하셨습니다",
      "### 내일 첫 작업",
      "- todari-ops · 배포 확인",
    ].join("\n")]]);
    // 근거는 모두 그 KST 하루로 묻는다. 커밋은 토큰의 주인이 쓴 것만, 소유자로 묶지 않고 한 번에 찾는다.
    expect(asked()).toEqual([
      "/user",
      "/search/commits?q=author:octo-owner -repo:Todari/obsidian-vault " +
        "committer-date:2026-10-10T15:00:00Z..2026-10-11T15:00:00Z&sort=committer-date&order=desc&per_page=100",
    ]);
    expect(mocks.added).toHaveBeenCalledWith(DAY.start, DAY.end);
    expect(mocks.card).toHaveBeenCalledWith(DAY.start, DAY.end);
    expect(mocks.firstTask).toHaveBeenCalledWith("2026-10-11");

    expect(saved("scheduled-posts.json")["daily-log"]).toBe("2026-10-12");
    expect(saved("daily-log.json")).toEqual({
      date: "2026-10-11", summary: "커밋 2 · 배포 1 · 새 노트 1", processed: "2026-10-11", pending: [],
    });
    vi.setSystemTime(kst("08:30"));
    expect(log.yesterdayLogSummary()).toBe("커밋 2 · 배포 1 · 새 노트 1 → 볼트 데일리/2026-10-11.md");
    vi.setSystemTime(kst("08:30", "2026-10-13")); // 다음 날 기록이 없으면 지난 요약을 다시 보여주지 않는다
    expect(log.yesterdayLogSummary()).toBeNull();
  });

  it("writes nothing for a day without evidence, and picks up again the next night", async () => {
    await boot(kst("00:39"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.added).toHaveBeenCalledWith(DAY.start, DAY.end); // 찾아봤지만 없었다
    expect(mocks.write).not.toHaveBeenCalled();
    expect(saved("daily-log.json")).toEqual({ processed: "2026-10-11", pending: [] }); // 근거가 없던 날도 살펴본 날이다
    expect(saved("scheduled-posts.json")["daily-log"]).toBe("2026-10-12");

    mocks.firstTask.mockReturnValue("이정표 · 사업계획서 제출");
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(mocks.write.mock.calls).toEqual([["2026-10-12", "### 내일 첫 작업\n- 이정표 · 사업계획서 제출"]]); // 10-11 은 다시 보지 않는다
  });

  it("fills in the days it missed, oldest first and seven at most", async () => {
    // 날마다 근거가 하나씩 있었다. 2026-10-10 만 빈 날이다.
    mocks.firstTask.mockImplementation((date: string) => (date === "2026-10-10" ? null : `${date} 에 정한 일`));
    seed("daily-log.json", { date: "2026-10-08", summary: "커밋 1" }); // processed 가 생기기 전의 파일: 마지막으로 쓴 날만 있다
    seed("scheduled-posts.json", { "daily-log": "2026-10-09" }); // 그 뒤로 봇이 사흘 내려가 있었다
    const log = await boot(kst("10:00"));
    expect(written()).toEqual(["2026-10-09", "2026-10-11"]);
    expect(saved("daily-log.json")).toEqual({ date: "2026-10-11", summary: "기록됨", processed: "2026-10-11", pending: [] });
    expect(log.yesterdayLogSummary()).toBe("기록됨 → 볼트 데일리/2026-10-11.md");

    // 더 오래 내려가 있었으면 최근 7일만 채우고, 그보다 오래된 날은 못 쓴 날이어도 포기한다.
    seed("daily-log.json", { processed: "2026-10-11", pending: ["2026-10-10", "2026-10-25"] });
    mocks.write.mockClear();
    await boot(kst("10:00", "2026-10-30"));
    expect(written()).toEqual([
      "2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29",
    ]);
    expect(saved("daily-log.json")).toMatchObject({ date: "2026-10-29", processed: "2026-10-29", pending: [] });
  });

  it("keeps going past a day that fails and writes only that day again on the next run", async () => {
    mocks.firstTask.mockImplementation((date: string) => `${date} 에 정한 일`);
    const failure = new Error("vault push conflict");
    mocks.write.mockImplementation(async (date: string) => {
      if (date === "2026-10-10") throw failure;
      return { changed: true, commit: "abc1234", summary: "" };
    });
    seed("daily-log.json", { processed: "2026-10-08" });
    seed("scheduled-posts.json", { "daily-log": "2026-10-09" });
    const log = await boot(kst("10:00"));
    expect(written()).toEqual(["2026-10-09", "2026-10-10", "2026-10-11"]);
    expect(mocks.captureException.mock.calls).toEqual([[failure, { kind: "daily-log", date: "2026-10-10" }]]);
    expect(saved("daily-log.json")).toMatchObject({ date: "2026-10-11", processed: "2026-10-11", pending: ["2026-10-10"] });
    expect(log.yesterdayLogSummary()).toBe("기록됨 → 볼트 데일리/2026-10-11.md"); // 다이제스트는 어제 것을 그대로 싣는다

    mocks.write.mockReset();
    mocks.write.mockResolvedValue({ changed: true, commit: "def5678", summary: "" });
    await vi.advanceTimersByTimeAsync(kst("00:40", "2026-10-13") - kst("10:00"));
    expect(written()).toEqual(["2026-10-10", "2026-10-12"]); // 이미 쓴 09·11 은 다시 쓰지 않는다
    expect(saved("daily-log.json")).toMatchObject({ date: "2026-10-12", processed: "2026-10-12", pending: [] });
  });

  it("catches up once after a restart past the scheduled time", async () => {
    aBusyDay();
    seed("scheduled-posts.json", { "daily-log": "2026-10-11" });
    await boot(kst("10:00"));
    expect(mocks.write).toHaveBeenCalledTimes(1);
    expect(mocks.write.mock.calls[0]?.[0]).toBe("2026-10-11");

    await boot(kst("10:05")); // 같은 날 또 재시작 — 이미 썼다
    expect(mocks.write).toHaveBeenCalledTimes(1);
  });

  it("keeps the remaining evidence when a source fails", async () => {
    aBusyDay();
    mocks.added.mockRejectedValue(new Error("git pull exited 1"));
    mocks.card.mockImplementation(() => { throw new Error("jp store broken"); });
    await boot(kst("00:39"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.write.mock.calls[0]?.[1]).toBe(
      "### 코드\n- **todari-ops** 2건: feat: a; fix: b\n### 운영\n- 배포 1건 (todari)",
    );
    expect(vi.mocked(console.warn).mock.calls.map(([line]) => line)).toEqual([
      "[daily-log] vault notes unavailable:", "[daily-log] jp unavailable:",
    ]);
  });

  it.each([
    ["received the evening before (still about the day before)", kst("23:50", "2026-10-11"), false],
    ["received after midnight", kst("00:00"), true],
    ["received a day late", kst("00:00", "2026-10-13"), false],
  ])("uses the Instagram brief only when it describes that day: %s", async (_label, at, used) => {
    mocks.brief.mockReturnValue({ brief: "어제 게시: 2/2건", at });
    await (await boot(kst("09:00"))).writeDailyLog("2026-10-11");
    expect(mocks.write.mock.calls).toEqual(used ? [["2026-10-11", "### 인스타 게시\n게시: 2/2건"]] : []);
  });

  it("asks who the token belongs to once per process, and narrows to DAILY_LOG_OWNERS when it is set", async () => {
    const log = await boot(kst("09:00"));
    await log.writeDailyLog("2026-10-11");
    mocks.env.DAILY_LOG_OWNERS = ["Todari", "my-org"];
    await log.writeDailyLog("2026-10-11");
    expect(asked()).toEqual([
      "/user",
      expect.stringContaining("q=author:octo-owner -repo:Todari/obsidian-vault committer-date:"),
      expect.stringContaining("q=author:octo-owner user:Todari user:my-org -repo:Todari/obsidian-vault committer-date:"),
    ]);
  });

  it("takes the author from DAILY_LOG_AUTHOR without asking GitHub", async () => {
    mocks.env.DAILY_LOG_AUTHOR = "someone-else";
    await (await boot(kst("09:00"))).writeDailyLog("2026-10-11");
    expect(asked()).toEqual([expect.stringContaining("q=author:someone-else -repo:Todari/obsidian-vault committer-date:")]);
  });

  it("falls back to the owners' repositories while the login is unknown, and asks again the next time", async () => {
    github(NO_COMMITS, null); // GET /user 가 실패한다
    const log = await boot(kst("09:00"));
    await log.writeDailyLog("2026-10-11");
    mocks.env.DAILY_LOG_OWNERS = ["my-org"];
    await log.writeDailyLog("2026-10-11");
    github(); // GitHub 이 다시 답한다
    await log.writeDailyLog("2026-10-11");
    expect(asked()).toEqual([
      "/user", // 카탈로그 레포의 소유자들
      expect.stringContaining("q=user:Todari user:yeouido-penthouse-cattower user:linkive -repo:Todari/obsidian-vault committer-date:"),
      "/user",
      expect.stringContaining("q=user:my-org -repo:Todari/obsidian-vault committer-date:"),
      "/user",
      expect.stringContaining("q=author:octo-owner user:my-org -repo:Todari/obsidian-vault committer-date:"),
    ]);
  });

  it("keeps only the author's own commits when GitHub ignores the author qualifier", async () => {
    // 없는 로그인의 author: 조건을 GitHub 은 말없이 버리고 남의 커밋을 돌려준다(200).
    mocks.env.DAILY_LOG_AUTHOR = "octo-ownr";
    github({
      total_count: 48_211_907,
      items: [commit("someone/else", "feat: not mine", "11T21:00", "someone"), commit("another/repo", "fix: nor this", "11T09:00", null)],
    });
    const log = await boot(kst("09:00"));
    expect(await log.writeDailyLog("2026-10-11")).toBe(false); // 남의 커밋도, 그 수("외 48,211,905건")도 적지 않는다
    expect(mocks.write).not.toHaveBeenCalled();

    // 제대로 적은 로그인은 대소문자가 달라도 자기 커밋이고, 한 쪽에 다 담기지 않은 수도 그대로 센다.
    mocks.env.DAILY_LOG_AUTHOR = "Octo-Owner";
    github({
      total_count: 5,
      items: [commit("Todari/todari-ops", "fix: b", "11T21:00"), commit("Todari/todari-ops", "feat: a", "11T09:00")],
    });
    await log.writeDailyLog("2026-10-11");
    expect(mocks.write.mock.calls).toEqual([[
      "2026-10-11", "### 코드\n- **todari-ops** 2건: feat: a; fix: b\n- 외 3건 (GitHub 검색 한 번에 담기는 100건 밖)",
    ]]);
  });

  it("leaves a day unwritten and pending when its commit search fails, and writes it on the next run", async () => {
    mocks.firstTask.mockImplementation((date: string) => `${date} 에 정한 일`); // 다른 근거는 날마다 있다
    // 2026-10-10 하루의 검색만 실패한다(한도 초과·5xx·시간 초과: ghJson 은 null 을 준다).
    mocks.ghJson.mockImplementation(async (path: string) => {
      if (path === "/user") return { login: "octo-owner" };
      return decodeURIComponent(path).includes("committer-date:2026-10-09T15:00:00Z") ? null : NO_COMMITS;
    });
    seed("daily-log.json", { processed: "2026-10-08" });
    seed("scheduled-posts.json", { "daily-log": "2026-10-09" });
    const log = await boot(kst("10:00"));
    // 커밋을 모르는 날을 "커밋 없음"으로 써 버리지 않는다. 뒤의 날은 그대로 쓴다.
    expect(written()).toEqual(["2026-10-09", "2026-10-11"]);
    expect(mocks.captureException.mock.calls).toEqual([
      [expect.objectContaining({ message: "commit search failed for 2026-10-10" }), { kind: "daily-log", date: "2026-10-10" }],
    ]);
    expect(saved("daily-log.json")).toMatchObject({ date: "2026-10-11", processed: "2026-10-11", pending: ["2026-10-10"] });
    expect(log.yesterdayLogSummary()).toBe("기록됨 → 볼트 데일리/2026-10-11.md");

    mocks.write.mockClear();
    github({ total_count: 1, items: [commit("Todari/todari-ops", "feat: a", "10T09:00")] }); // 다음 날 밤에는 검색이 된다
    await vi.advanceTimersByTimeAsync(kst("00:40", "2026-10-13") - kst("10:00"));
    expect(mocks.write.mock.calls).toEqual([
      ["2026-10-10", "### 코드\n- **todari-ops** 1건: feat: a\n### 내일 첫 작업\n- 2026-10-10 에 정한 일"],
      ["2026-10-12", "### 내일 첫 작업\n- 2026-10-12 에 정한 일"],
    ]);
    expect(saved("daily-log.json")).toMatchObject({ date: "2026-10-12", processed: "2026-10-12", pending: [] });
  });

  it("reports a failed vault write, records no summary and still arms the next night", async () => {
    aBusyDay();
    const failure = new Error("vault push conflict");
    mocks.write.mockRejectedValue(failure);
    const log = await boot(kst("00:39"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.captureException).toHaveBeenCalledWith(failure, { kind: "daily-log", date: "2026-10-11" });
    expect(log.yesterdayLogSummary()).toBeNull();
    expect(saved("daily-log.json")).toEqual({ processed: "2026-10-11", pending: ["2026-10-11"] });
    expect(vi.getTimerCount()).toBe(1);
  });

  it("does nothing when DAILY_LOG_TIME is empty", async () => {
    mocks.env.DAILY_LOG_TIME = "";
    seed("scheduled-posts.json", { "daily-log": "2026-10-11" });
    await boot(kst("10:00"));
    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.write).not.toHaveBeenCalled();
  });
});
