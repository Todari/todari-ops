import type { ActionRowBuilder, ButtonBuilder, ButtonInteraction, EmbedBuilder } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  env: { WORK_DIR: "", OWNER_DISCORD_ID: "owner", CHECKIN_TIME: "21:30", DAILY_LOG_OWNERS: [] as string[], VAULT_REPO_URL: "" },
  send: vi.fn(), ghJson: vi.fn(), blame: vi.fn(), tidy: vi.fn(), captureException: vi.fn(),
}));
vi.mock("../env.js", () => ({ env: mocks.env }));
vi.mock("../discord/alerts.js", () => ({
  fetchDigestChannel: async () => ({ send: mocks.send }),
  ownerMention: () => ({ content: "<@owner>", allowedMentions: { users: ["owner"] } }),
}));
vi.mock("../github/api.js", () => ({ ghJson: mocks.ghJson }));
vi.mock("../vault/mutations.js", () => ({ blameVaultNotes: mocks.blame, tidyVaultTask: mocks.tidy }));
vi.mock("../observability/sentry.js", () => ({ captureException: mocks.captureException }));
// handleButton 이 함께 끌어오는 다른 버튼 처리기들. 여기서는 정리 버튼 경로만 본다.
vi.mock("../content/index.js", () => ({ contentButton: vi.fn() }));
vi.mock("../agent/permissions.js", () => ({ resolvePending: vi.fn() }));
vi.mock("../agent/bootstrap.js", () => ({ spawnSessionThread: vi.fn() }));
vi.mock("../webhook/instagram-handler.js", () => ({
  ACK_BUTTON_ID: "igack", OPS_BUTTON_ID: "igops", acknowledgeProblem: vi.fn(), requestProblemAction: vi.fn(),
}));
vi.mock("../jp/cards.js", () => ({ dueCards: vi.fn(), gradeCard: vi.fn() }));
// 볼트 스냅샷(vault/state)·정리 상태(task-tidy.json)·예약 기록·주간 요약은 실제 구현이 임시 /data 를 읽고 쓴다.

type Note = { note: string; slug?: string; tasks: Array<{ text: string; due?: string }> };
const kst = (hhmm: string, date = "2026-10-16") => Date.parse(`${date}T${hhmm}:00+09:00`); // 2026-10-16 은 금요일
const EPHEMERAL = 64; // MessageFlags.Ephemeral
let root: string;

/** 봇을 그 시각에 (다시) 띄운다: 메모리 상태는 사라지고 /data 의 파일만 남는다. */
async function boot(now: number) {
  vi.clearAllTimers();
  vi.resetModules();
  vi.setSystemTime(now);
  const [weekly, tidy, button] = await Promise.all([
    import("../digest/weekly.js"), import("./tidy.js"), import("../handlers/button.js"),
  ]);
  return { ...weekly, ...tidy, handleButton: button.handleButton };
}
function seedVault(notes: Note[]) {
  writeFileSync(
    join(root, "vault-state.json"),
    JSON.stringify({ generatedAt: "2026-10-16T00:00:00Z", notes: notes.map((n) => ({ deadlines: [], ...n })) }),
  );
}
const saved = <T>(name: string) => JSON.parse(readFileSync(join(root, name), "utf8")) as T;
const vaultTasks = (note: string) =>
  saved<{ notes: Note[] }>("vault-state.json").notes.find((n) => n.note === note)?.tasks;
/** 볼트 노트 파일의 blame: `## 다음 할 일` 아래 줄마다 [줄, 마지막으로 바뀐 날]. */
function blameOf(notes: Record<string, Array<[line: string, changed: string]>>) {
  return new Map(
    Object.entries(notes).map(([note, lines]) => [
      note,
      [
        { time: kst("12:00", "2026-01-01"), text: "## 다음 할 일" },
        ...lines.map(([text, changed]) => ({ time: kst("12:00", changed), text })),
      ],
    ]),
  );
}
/** n 번째로 게시된 메시지를 비교하기 쉬운 모양으로. */
function message(payload: unknown) {
  const { embeds, components, ...rest } = payload as {
    embeds: EmbedBuilder[]; components?: Array<ActionRowBuilder<ButtonBuilder>>;
  };
  return {
    ...rest,
    embed: embeds[0]!.toJSON(),
    lines: (embeds[0]!.toJSON().description ?? "").split("\n"),
    rows: (components ?? []).map((row) =>
      (row.toJSON().components as Array<{ custom_id: string; label: string }>).map(({ custom_id, label }) => ({
        id: custom_id, label,
      })),
    ),
  };
}
const sent = (n: number) => message(mocks.send.mock.calls[n]?.[0]);
function click(customId: string, userId = "owner") {
  const interaction = {
    user: { id: userId }, customId,
    reply: vi.fn(), deferUpdate: vi.fn(), followUp: vi.fn(), editReply: vi.fn(),
  };
  return { interaction, press: (handle: (i: ButtonInteraction) => Promise<void>) => handle(interaction as unknown as ButtonInteraction) };
}
const edited = (interaction: { editReply: ReturnType<typeof vi.fn> }) => message(interaction.editReply.mock.calls.at(-1)?.[0]);

// 다섯 개가 넘는 열린 할 일. 줄의 나이는 FIVE_BLAME 이 정한다.
const FIVE: Note[] = [
  { note: "todari-ops", slug: "todari-ops", tasks: [{ text: "알림 버튼 실사용 확인" }, { text: "어제 적은 일" }] },
  { note: "이정표", slug: "jeongpyo", tasks: [{ text: "관납료 납부", due: "2026-10-01" }, { text: "가격 정책 정리" }] },
  { note: "인스타 실험실", tasks: [{ text: "릴스 훅 실험" }, { text: "해시태그 정리" }] },
];
const FIVE_BLAME = () =>
  blameOf({
    "todari-ops": [["- [ ] **알림 버튼** 실사용 확인", "2026-06-01"], ["- [ ] 어제 적은 일", "2026-10-15"]],
    이정표: [["- [ ] 관납료 납부 📅 2026-10-01", "2026-09-04"], ["- [ ] [[가격 정책]] 정리", "2026-08-01"]],
    "인스타 실험실": [["- [ ] 릴스 훅 실험", "2026-07-01"], ["- [ ] 해시태그 정리", "2026-09-01"]],
  });
const FIVE_LINES = [
  "1. **todari-ops** · 알림 버튼 실사용 확인 — 137일째",
  "2. **인스타 실험실** · 릴스 훅 실험 — 107일째",
  "3. **이정표** · 가격 정책 정리 — 76일째",
  "4. **인스타 실험실** · 해시태그 정리 — 45일째",
  "5. **이정표** · 관납료 납부 — 42일째",
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  for (const method of ["log", "warn"] as const) vi.spyOn(console, method).mockImplementation(() => {});
  root = mkdtempSync(join(tmpdir(), "task-tidy-"));
  mocks.env.WORK_DIR = join(root, "work");
  mocks.ghJson.mockResolvedValue(null);
  mocks.blame.mockImplementation(async () => FIVE_BLAME());
  mocks.tidy.mockResolvedValue({ changed: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("stalestTasks", () => {
  it("orders open tasks by how long ago their line last changed and keeps the oldest five", async () => {
    const { stalestTasks } = await boot(kst("18:00"));
    const vault = {
      generatedAt: "",
      notes: [
        {
          note: "todari-ops", slug: "todari-ops", deadlines: [],
          tasks: [
            { text: "가" }, { text: "나" },
            { text: "오늘 마감", due: "2026-10-16" }, { text: "내일 마감", due: "2026-10-17" },
            { text: "지난 마감", due: "2026-10-15" },
            { text: "볼트에서 끝낸 일" }, { text: "구획 밖의 일" }, { text: "볼트에 없는 일" },
          ],
        },
        { note: "이정표", slug: "jeongpyo", deadlines: [], tasks: [{ text: "다" }, { text: "라" }, { text: "마" }, { text: "바" }] },
        { note: "파일이 없는 노트", deadlines: [], tasks: [{ text: "사" }] },
      ],
    };
    const blame = blameOf({
      "todari-ops": [
        ["- [ ] **가**", "2026-07-01"], ["- [ ] 나", "2026-10-10"],
        ["- [ ] 오늘 마감 📅 2026-10-16", "2026-01-01"], ["- [ ] 내일 마감 📅 10/17", "2026-01-01"],
        ["- [ ] 지난 마감 📅 2026-10-15", "2026-06-01"],
        ["- [x] 볼트에서 끝낸 일", "2026-01-01"], // 스냅샷이 늦어 아직 열린 것으로 알고 있다
        ["## 보류", "2026-01-01"], ["- [ ] 구획 밖의 일", "2026-01-01"],
      ],
      이정표: [["- [ ] 다", "2026-09-01"], ["- [ ] 라", "2026-08-01"], ["* [ ] [[마]]", "2026-08-15"], ["- [ ] 바", "2026-09-10"]],
    });

    expect(stalestTasks(vault, blame)).toEqual([
      { projectSlug: "todari-ops", note: "todari-ops", text: "지난 마감", days: 137 }, // 마감이 지난 것은 후보다
      { projectSlug: "todari-ops", note: "todari-ops", text: "가", days: 107 },
      { projectSlug: "jeongpyo", note: "이정표", text: "라", days: 76 },
      { projectSlug: "jeongpyo", note: "이정표", text: "마", days: 62 },
      { projectSlug: "jeongpyo", note: "이정표", text: "다", days: 45 },
    ]);
    expect(stalestTasks(vault, blame, 7).map((task) => task.text).slice(5)).toEqual(["바", "나"]);
    expect(stalestTasks(vault, new Map())).toEqual([]);
  });
});

describe("friday tidy", () => {
  it("follows the weekly summary with the five stalest tasks and three buttons each, without a mention", async () => {
    seedVault(FIVE);
    const { postWeekly } = await boot(kst("18:00"));
    expect(await postWeekly()).toBe(true);

    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(sent(0).embed.title).toMatch(/^📅 주간 요약/);
    expect(mocks.send.mock.calls[1]?.[0]).not.toHaveProperty("content"); // 멘션(푸시) 없이
    expect(mocks.blame).toHaveBeenCalledWith([
      { projectSlug: "todari-ops", note: "todari-ops" },
      { projectSlug: "jeongpyo", note: "이정표" },
      { projectSlug: "인스타 실험실", note: "인스타 실험실" },
    ]);
    const tidy = sent(1);
    expect(tidy.embed.title).toBe("🧹 할 일 정리 — 오래 손대지 않은 5개");
    expect(tidy.lines).toEqual(FIVE_LINES); // "어제 적은 일"은 여섯째라 빠졌다
    expect(tidy.rows).toHaveLength(5);
    tidy.rows.forEach((row, i) => {
      expect(row.map((button) => button.label)).toEqual([`${i + 1} 다음 주`, `${i + 1} 보류 4주`, `${i + 1} 버림`]);
      const id = row[0]!.id.split(":")[2];
      expect(row.map((button) => button.id)).toEqual([`tidy:next:${id}`, `tidy:snooze:${id}`, `tidy:drop:${id}`]);
    });
    expect(new Set(tidy.rows.map((row) => row[0]!.id)).size).toBe(5);
  });

  it("posts only the summary when there is no vault snapshot, no eligible task or no readable vault", async () => {
    const first = await boot(kst("18:00"));
    expect(await first.postWeekly()).toBe(true); // 스냅샷 없음
    expect(mocks.blame).not.toHaveBeenCalled();

    seedVault([{ note: "todari-ops", tasks: [{ text: "다음 주 금요일까지", due: "2026-10-23" }] }]);
    mocks.blame.mockResolvedValue(blameOf({ "todari-ops": [["- [ ] 다음 주 금요일까지 📅 2026-10-23", "2026-06-01"]] }));
    const second = await boot(kst("18:00"));
    await second.postWeekly(); // 마감이 잡힌 할 일뿐

    seedVault(FIVE);
    mocks.blame.mockRejectedValue(new Error("git pull exited 1"));
    const third = await boot(kst("18:00"));
    expect(await third.postWeekly()).toBe(true); // 볼트를 읽지 못해도 요약은 나간다

    expect(mocks.send).toHaveBeenCalledTimes(3);
    for (const [payload] of mocks.send.mock.calls) expect(message(payload).embed.title).toMatch(/^📅 주간 요약/);
    expect(mocks.captureException).toHaveBeenCalledWith(expect.any(Error), { kind: "task-tidy" });
  });

  it("applies each button to the vault, notes the outcome on that line and removes only that row", async () => {
    seedVault(FIVE);
    const { postWeekly, handleButton } = await boot(kst("18:00"));
    await postWeekly();
    const rows = sent(1).rows;

    // 1 다음 주: 금요일에 누르면 7일 뒤 금요일이 마감일이 된다.
    const next = click(rows[0]![0]!.id);
    await next.press(handleButton);
    expect(next.interaction.deferUpdate).toHaveBeenCalled(); // 볼트 push 는 3초를 넘긴다
    expect(mocks.tidy).toHaveBeenLastCalledWith(
      expect.objectContaining({ projectSlug: "todari-ops", note: "todari-ops", text: "알림 버튼 실사용 확인" }),
      "next",
      "2026-10-23",
    );
    expect(vaultTasks("todari-ops")).toEqual([{ text: "알림 버튼 실사용 확인", due: "2026-10-23" }, { text: "어제 적은 일" }]);
    expect(edited(next.interaction).lines).toEqual([`1. ~~${FIVE_LINES[0]!.slice(3)}~~ → 📅 10-23`, ...FIVE_LINES.slice(1)]);
    expect(edited(next.interaction).rows).toEqual(rows.slice(1));

    // 3 버림: 오늘 날짜로 버림 표시, 스냅샷에서도 빠진다.
    const drop = click(rows[2]![2]!.id);
    await drop.press(handleButton);
    expect(mocks.tidy).toHaveBeenLastCalledWith(
      expect.objectContaining({ projectSlug: "jeongpyo", note: "이정표", text: "가격 정책 정리" }),
      "drop",
      "2026-10-16",
    );
    expect(vaultTasks("이정표")).toEqual([{ text: "관납료 납부", due: "2026-10-01" }]);

    // 2 보류 4주: 볼트는 건드리지 않는다.
    const snooze = click(rows[1]![1]!.id);
    await snooze.press(handleButton);
    expect(mocks.tidy).toHaveBeenCalledTimes(2);
    expect(saved<{ snoozed: Record<string, string> }>("task-tidy.json").snoozed).toEqual({
      "인스타 실험실\n릴스 훅 실험": "2026-11-13",
    });
    expect(vaultTasks("인스타 실험실")).toEqual(FIVE[2]!.tasks);

    // 앞서 누른 줄의 결과는 남고, 남은 두 줄의 버튼만 그대로다.
    expect(edited(snooze.interaction).embed.title).toBe("🧹 할 일 정리 — 오래 손대지 않은 5개");
    expect(edited(snooze.interaction).lines).toEqual([
      `1. ~~${FIVE_LINES[0]!.slice(3)}~~ → 📅 10-23`,
      `2. ~~${FIVE_LINES[1]!.slice(3)}~~ → 보류 (11-13까지)`,
      `3. ~~${FIVE_LINES[2]!.slice(3)}~~ → 버림`,
      FIVE_LINES[3],
      FIVE_LINES[4],
    ]);
    expect(edited(snooze.interaction).rows).toEqual(rows.slice(3));
    for (const { interaction } of [next, drop, snooze]) expect(interaction.reply).not.toHaveBeenCalled();

    // 이미 처리한 줄을 다시 누르면(화면이 늦게 바뀐 사이) 볼트를 또 고치지 않는다.
    const again = click(rows[2]![0]!.id);
    await again.press(handleButton);
    expect(again.interaction.reply).toHaveBeenCalledWith({ content: expect.stringContaining("이미 처리"), flags: EPHEMERAL });
    expect(mocks.tidy).toHaveBeenCalledTimes(2);
  });

  it("keeps every outcome when a slow vault write finishes after a later tap", async () => {
    seedVault(FIVE);
    const { postWeekly, handleButton } = await boot(kst("18:00"));
    await postWeekly();
    const rows = sent(1).rows;
    let finish!: (result: { changed: boolean }) => void;
    mocks.tidy.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));

    const drop = click(rows[0]![2]!.id);
    const dropping = drop.press(handleButton); // 볼트 push 를 기다리는 중
    const snooze = click(rows[1]![1]!.id);
    await snooze.press(handleButton); // 그사이 다음 줄을 눌렀다
    expect(edited(snooze.interaction).rows).toEqual([rows[0], ...rows.slice(2)]);
    expect(drop.interaction.editReply).not.toHaveBeenCalled();

    finish({ changed: true });
    await dropping;
    // 늦게 끝난 쪽이 누른 순간의 화면으로 덮어쓰지 않는다: 둘째 줄의 결과가 남는다.
    expect(edited(drop.interaction).lines.slice(0, 2)).toEqual([
      `1. ~~${FIVE_LINES[0]!.slice(3)}~~ → 버림`,
      `2. ~~${FIVE_LINES[1]!.slice(3)}~~ → 보류 (11-13까지)`,
    ]);
    expect(edited(drop.interaction).rows).toEqual(rows.slice(2));
  });

  it("stays quiet when the same button is tapped twice before the first tap lands", async () => {
    seedVault(FIVE);
    const { postWeekly, handleButton } = await boot(kst("18:00"));
    await postWeekly();
    const id = sent(1).rows[0]![2]!.id;
    const writes: Array<(result: { changed: boolean }) => void> = [];
    mocks.tidy.mockImplementation(() => new Promise((resolve) => writes.push(resolve)));

    const first = click(id);
    const second = click(id);
    const both = [first.press(handleButton), second.press(handleButton)];
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    writes[0]!({ changed: true });
    await both[0];
    writes[1]!({ changed: false }); // 둘째 쓰기는 이미 버린 줄을 만난다
    await both[1];

    expect(edited(first.interaction).lines[0]).toBe(`1. ~~${FIVE_LINES[0]!.slice(3)}~~ → 버림`);
    for (const { interaction } of [first, second]) {
      expect(interaction.followUp).not.toHaveBeenCalled();
      expect(interaction.reply).not.toHaveBeenCalled();
    }
    expect(second.interaction.editReply).not.toHaveBeenCalled();
  });

  it("sends the message edits one at a time, each drawn from the state at that moment", async () => {
    seedVault(FIVE);
    const { postWeekly, handleButton } = await boot(kst("18:00"));
    await postWeekly();
    const rows = sent(1).rows;

    const first = click(rows[0]![1]!.id);
    let arrive!: () => void;
    first.interaction.editReply.mockReturnValueOnce(new Promise<void>((resolve) => { arrive = resolve; })); // 느린 응답
    const one = first.press(handleButton);
    const second = click(rows[1]![1]!.id);
    const two = second.press(handleButton);
    await vi.advanceTimersByTimeAsync(0);
    expect(first.interaction.editReply).toHaveBeenCalledTimes(1);
    expect(second.interaction.editReply).not.toHaveBeenCalled(); // 앞의 수정이 도착할 때까지 기다린다

    arrive();
    await Promise.all([one, two]);
    expect(edited(second.interaction).rows).toEqual(rows.slice(2)); // 마지막에 도착하는 화면이 두 결과를 다 담는다
  });

  it("keeps the buttons working across a weekend restart, aiming at the coming Friday", async () => {
    seedVault(FIVE);
    const friday = await boot(kst("18:00"));
    await friday.postWeekly();
    const rows = sent(1).rows;

    const monday = await boot(kst("09:00", "2026-10-19")); // 재시작: 메모리에는 아무것도 없다
    const next = click(rows[3]![0]!.id);
    await next.press(monday.handleButton);
    expect(mocks.tidy).toHaveBeenLastCalledWith(
      expect.objectContaining({ note: "인스타 실험실", text: "해시태그 정리" }), "next", "2026-10-23",
    );
    expect(edited(next.interaction).lines[3]).toBe(`4. ~~${FIVE_LINES[3]!.slice(3)}~~ → 📅 10-23`);
    expect(edited(next.interaction).rows).toEqual([rows[0], rows[1], rows[2], rows[4]]);

    const saturday = await boot(kst("09:00", "2026-10-24"));
    await click(rows[4]![0]!.id).press(saturday.handleButton);
    expect(mocks.tidy).toHaveBeenLastCalledWith(expect.anything(), "next", "2026-10-30");
  });

  it("answers privately and leaves the message alone when the line is gone or the vault write fails", async () => {
    seedVault(FIVE);
    const { postWeekly, handleButton } = await boot(kst("18:00"));
    await postWeekly();
    const rows = sent(1).rows;

    mocks.tidy.mockResolvedValue({ changed: false }); // 그사이 볼트에서 완료했거나 문장을 고쳤다
    const gone = click(rows[0]![2]!.id);
    await gone.press(handleButton);
    expect(gone.interaction.followUp).toHaveBeenCalledWith({
      content: expect.stringContaining("**todari-ops** 노트에서 고칠 줄을 찾지 못했습니다"), flags: EPHEMERAL,
    });

    mocks.tidy.mockRejectedValue(new Error("vault push conflict"));
    const failed = click(rows[0]![0]!.id);
    await failed.press(handleButton);
    expect(failed.interaction.followUp).toHaveBeenCalledWith({
      content: expect.stringContaining("볼트에 반영하지 못했습니다"), flags: EPHEMERAL,
    });

    for (const { interaction } of [gone, failed]) expect(interaction.editReply).not.toHaveBeenCalled();
    expect(vaultTasks("todari-ops")).toEqual(FIVE[0]!.tasks);
    // 줄은 그대로 열려 있다: 다시 누르면 다시 시도한다.
    mocks.tidy.mockResolvedValue({ changed: true });
    const retry = click(rows[0]![2]!.id);
    await retry.press(handleButton);
    expect(edited(retry.interaction).lines[0]).toBe(`1. ~~${FIVE_LINES[0]!.slice(3)}~~ → 버림`);
  });

  it("refuses strangers and buttons from a list older than 14 days", async () => {
    seedVault(FIVE);
    const first = await boot(kst("18:00"));
    await first.postWeekly();
    const old = sent(1).rows[0]![2]!.id;

    const stranger = click(old, "someone-else");
    await stranger.press(first.handleButton);
    expect(stranger.interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: "권한 없음" }));

    const later = await boot(kst("18:00", "2026-10-30")); // 2주 뒤의 목록이 오래된 목록을 지운다
    await later.postWeekly();
    const expired = click(old);
    await expired.press(later.handleButton);
    const unknown = click("tidy:drop:nope1234");
    await unknown.press(later.handleButton);
    for (const { interaction } of [expired, unknown]) {
      expect(interaction.reply).toHaveBeenCalledWith({ content: expect.stringContaining("만료"), flags: EPHEMERAL });
      expect(interaction.deferUpdate).not.toHaveBeenCalled();
    }
    expect(mocks.tidy).not.toHaveBeenCalled();
    const fresh = click(sent(3).rows[0]![2]!.id); // 새 목록의 버튼은 된다
    await fresh.press(later.handleButton);
    expect(mocks.tidy).toHaveBeenCalledTimes(1);
  });

  it("hides a snoozed task from the list until its date, then offers it again", async () => {
    seedVault(FIVE);
    const first = await boot(kst("18:00"));
    await first.postWeekly();
    await click(sent(1).rows[0]![1]!.id).press(first.handleButton); // 가장 오래된 "알림 버튼 실사용 확인"을 보류

    const nextWeek = await boot(kst("18:00", "2026-10-23"));
    expect(nextWeek.withoutSnoozed(saved("vault-state.json")).notes[0]?.tasks).toEqual([{ text: "어제 적은 일" }]);
    await nextWeek.postWeekly();
    expect(sent(3).lines.map((line) => line.replace(/ — \d+일째$/, ""))).toEqual([
      "1. **인스타 실험실** · 릴스 훅 실험",
      "2. **이정표** · 가격 정책 정리",
      "3. **인스타 실험실** · 해시태그 정리",
      "4. **이정표** · 관납료 납부",
      "5. **todari-ops** · 어제 적은 일",
    ]);

    const fourWeeks = await boot(kst("18:00", "2026-11-13")); // 보류가 끝나는 날
    await fourWeeks.postWeekly();
    expect(sent(5).lines[0]).toBe("1. **todari-ops** · 알림 버튼 실사용 확인 — 165일째");
    expect(saved<{ snoozed: object }>("task-tidy.json").snoozed).toEqual({}); // 끝난 보류는 지운다
  });
});

describe("open task count in the weekly summary", () => {
  const openField = (n: number) => sent(n).embed.fields?.find((field) => field.name === "📋 열린 할 일")?.value;

  it("shows the current count beside the one the previous scheduled summary stored", async () => {
    seedVault(FIVE);
    const first = await boot(kst("17:59"));
    first.startWeeklySummary();
    await vi.advanceTimersByTimeAsync(60_000); // 금요일 18:00 예약 게시
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(2));
    expect(openField(0)).toBe("6개"); // 첫 주에는 비교할 값이 없다
    expect(saved<{ openCounts: object }>("task-tidy.json").openCounts).toEqual({ "2026-10-16": 6 });

    const manual = await boot(kst("19:00"));
    await manual.postWeekly(); // 같은 날의 수동 /week: 오늘 남긴 값은 "지난주"가 아니다
    expect(openField(2)).toBe("6개");

    seedVault([FIVE[0]!, { ...FIVE[1]!, tasks: [] }]);
    const midweek = await boot(kst("10:00", "2026-10-21"));
    await midweek.postWeekly();
    expect(openField(4)).toBe("2개 (지난주 6개)");
    expect(saved<{ openCounts: object }>("task-tidy.json").openCounts).toEqual({ "2026-10-16": 6 }); // 수동 게시는 남기지 않는다

    const nextFriday = await boot(kst("17:59", "2026-10-23"));
    nextFriday.startWeeklySummary();
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(openField(6)).toBe("2개 (지난주 6개)"));
    expect(saved<{ openCounts: object }>("task-tidy.json").openCounts).toEqual({ "2026-10-16": 6, "2026-10-23": 2 });
  });

  it("leaves the field out without a vault snapshot", async () => {
    const { postWeekly } = await boot(kst("18:00"));
    await postWeekly();
    expect(openField(0)).toBeUndefined();
  });
});
