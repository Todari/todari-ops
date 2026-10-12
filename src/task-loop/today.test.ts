import {
  ActionRow,
  Embed,
  type ActionRowBuilder,
  type ButtonBuilder,
  type ButtonInteraction,
  type EmbedBuilder,
  type StringSelectMenuInteraction,
} from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  env: {
    WORK_DIR: "", OWNER_DISCORD_ID: "owner", DIGEST_TIME: "08:30", CHECKIN_TIME: "21:30", DAILY_LOG_TIME: "00:40",
    DAILY_LOG_OWNERS: [] as string[], VAULT_REPO_URL: "",
  },
  send: vi.fn(), ghJson: vi.fn(), added: vi.fn(), complete: vi.fn(), write: vi.fn(),
}));
vi.mock("../env.js", () => ({ env: mocks.env }));
vi.mock("../discord/alerts.js", () => ({
  fetchDigestChannel: async () => ({ send: mocks.send, setTopic: vi.fn() }),
  ownerMention: () => ({ content: "<@owner>", allowedMentions: { users: ["owner"] } }),
}));
vi.mock("../github/api.js", () => ({ ghJson: mocks.ghJson }));
vi.mock("../vault/mutations.js", () => ({
  listVaultNotesAdded: mocks.added, completeVaultTask: mocks.complete, writeVaultDailyLog: mocks.write,
}));
vi.mock("../observability/sentry.js", () => ({ captureException: vi.fn() }));
vi.mock("../monitor/uptime.js", () => ({ getUptimeSnapshot: () => [], formatUptimeSnapshot: () => "" }));
vi.mock("../monitor/status-board.js", () => ({ getInstagramBrief: () => null, readInstagramBrief: () => null }));
// handleButton 이 함께 끌어오는 다른 버튼 처리기들. 여기서는 오늘의 3개 경로만 본다.
vi.mock("../content/index.js", () => ({ contentButton: vi.fn() }));
vi.mock("../agent/permissions.js", () => ({ resolvePending: vi.fn() }));
vi.mock("../agent/bootstrap.js", () => ({ spawnSessionThread: vi.fn() }));
vi.mock("../webhook/instagram-handler.js", () => ({
  ACK_BUTTON_ID: "igack", OPS_BUTTON_ID: "igops", acknowledgeProblem: vi.fn(), requestProblemAction: vi.fn(),
}));
vi.mock("../jp/cards.js", () => ({ dueCards: vi.fn(), gradeCard: vi.fn(), dailyCardBetween: () => null }));
// 볼트 스냅샷·고른 할 일(today-picks.json)·보류(task-tidy.json)·체크인·다이제스트는 실제 구현이 임시 /data 를 읽고 쓴다.

type Note = { note: string; slug?: string; tasks: Array<{ text: string; due?: string }> };
type Option = { label: string; description?: string; value: string; default?: boolean };
type Sent = { embeds: EmbedBuilder[]; components: Array<ActionRowBuilder<ButtonBuilder>> };
const kst = (hhmm: string, date = "2026-10-12") => Date.parse(`${date}T${hhmm}:00+09:00`); // 2026-10-12 는 월요일
const EPHEMERAL = 64; // MessageFlags.Ephemeral
const FIELD = "🎯 오늘의 3개";
const LONG = `워커 메모리 한도 초과 원인 찾기: ${"수집 시작 직후 OOM 이 나는 구간을 좁힌다 ".repeat(6)}끝`;
const VAULT: Note[] = [
  { note: "HGT", slug: "HGT", tasks: [{ text: "배포 키 구성" }, { text: "스토어 심사 제출", due: "2026-10-30" }] },
  {
    note: "todari-ops", slug: "todari-ops",
    tasks: [{ text: "알림 버튼 실사용 확인" }, { text: "주간 요약 다듬기", due: "2026-10-14" }, { text: "셋째 할 일" }],
  },
  { note: "이정표", slug: "jeongpyo", tasks: [{ text: "관납료 납부", due: "2026-10-05" }, { text: "사업계획서 제출", due: "2026-10-19" }] },
  { note: "인스타 실험실", tasks: [{ text: LONG }] },
];
let root: string;

/** 봇을 그 시각에 (다시) 띄운다: 메모리 상태는 사라지고 /data 의 파일만 남는다. */
async function boot(now: number) {
  vi.resetModules();
  vi.setSystemTime(now);
  const [digest, checkin, log, today, button, select] = await Promise.all([
    import("../digest/daily.js"), import("../checkin/index.js"), import("../daily-log/index.js"),
    import("./today.js"), import("../handlers/button.js"), import("../handlers/select.js"),
  ]);
  return { ...digest, ...checkin, ...log, ...today, handleButton: button.handleButton, handleSelect: select.handleSelect };
}
function seedVault(notes: Note[]) {
  writeFileSync(
    join(root, "vault-state.json"),
    JSON.stringify({ generatedAt: "2026-10-12T00:00:00Z", notes: notes.map((n) => ({ deadlines: [], ...n })) }),
  );
}
const saved = <T>(name: string) => JSON.parse(readFileSync(join(root, name), "utf8")) as T;
const picksOn = (date: string) =>
  saved<Record<string, { picks: Array<{ note: string; text: string; done?: boolean }> }>>("today-picks.json")[date]
    ?.picks.map(({ note, text, done }) => ({ note, text, done: Boolean(done) }));
const lastSent = () => mocks.send.mock.calls.at(-1)?.[0] as Sent;
const fields = (embed: EmbedBuilder | Embed) => embed.toJSON().fields ?? [];
const picked = (embed: EmbedBuilder | Embed) => fields(embed).filter((field) => field.name === FIELD).map((field) => field.value);
const buttons = (rows: ReadonlyArray<{ toJSON(): unknown }>) =>
  rows.map((row) =>
    ((row.toJSON() as { components: Array<{ custom_id: string; label: string }> }).components).map(
      ({ custom_id, label }) => ({ id: custom_id, label }),
    ),
  );
const menu = (payload: Sent) =>
  (payload.components[0]!.toJSON().components[0] as unknown) as {
    custom_id: string; placeholder: string; min_values: number; max_values: number; options: Option[];
  };

/** Discord 가 돌려주는 메시지: 보낸 빌더가 아니라 받은 구조체(Embed·ActionRow)다. 수정하면 그 메시지가 바뀐다. */
function received(payload: { content?: string; embeds: Array<{ toJSON(): unknown }>; components: Array<{ toJSON(): unknown }> }) {
  const structures = (p: { embeds?: Array<{ toJSON(): unknown }>; components?: Array<{ toJSON(): unknown }> }) => ({
    ...(p.embeds ? { embeds: p.embeds.map((embed) => Reflect.construct(Embed, [embed.toJSON()]) as Embed) } : {}),
    ...(p.components
      ? { components: p.components.map((row) => Reflect.construct(ActionRow, [row.toJSON()]) as ActionRow<never>) }
      : {}),
  });
  const message = { content: payload.content ?? "", embeds: [] as Embed[], components: [] as Array<ActionRow<never>> };
  const apply = (p: Parameters<typeof structures>[0] & { content?: string }) =>
    Object.assign(message, structures(p), p.content === undefined ? {} : { content: p.content });
  apply(payload);
  return { message, apply };
}
function choose(customId: string, values: string[], message: unknown, userId = "owner") {
  const interaction = { user: { id: userId }, customId, values, message, update: vi.fn(), reply: vi.fn() };
  return {
    interaction,
    pick: (handle: (i: StringSelectMenuInteraction) => Promise<void>) => handle(interaction as unknown as StringSelectMenuInteraction),
  };
}
/** 메시지의 버튼을 누른다. interaction.message 는 누른 순간의 모습이고, 응답(update·editReply)은 실제 메시지에 반영된다. */
function click(customId: string, target: ReturnType<typeof received>, userId = "owner") {
  const interaction = {
    user: { id: userId }, customId, message: { ...target.message },
    reply: vi.fn(), followUp: vi.fn(), deferUpdate: vi.fn(),
    fetchReply: vi.fn(async () => target.message),
    update: vi.fn(async (payload: Parameters<typeof target.apply>[0]) => void target.apply(payload)),
    editReply: vi.fn(async (payload: Parameters<typeof target.apply>[0]) => void target.apply(payload)),
  };
  return { interaction, press: (handle: (i: ButtonInteraction) => Promise<void>) => handle(interaction as unknown as ButtonInteraction) };
}
/** 아침 다이제스트를 올리고 메뉴에서 세 개를 고른 하루. */
async function aDayWithPicks() {
  seedVault(VAULT);
  const morning = await boot(kst("08:30"));
  await morning.postDigest();
  const digest = lastSent();
  const options = menu(digest).options;
  const values = ["관납료 납부", "알림 버튼 실사용 확인", "배포 키 구성"].map(
    (label) => options.find((option) => option.label === label)!.value,
  );
  await choose(menu(digest).custom_id, values, received(digest).message).pick(morning.handleSelect);
  return { digest, options, values };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  for (const method of ["log", "warn"] as const) vi.spyOn(console, method).mockImplementation(() => {});
  root = mkdtempSync(join(tmpdir(), "today-picks-"));
  mocks.env.WORK_DIR = join(root, "work");
  mocks.ghJson.mockResolvedValue(null);
  mocks.added.mockResolvedValue([]);
  mocks.complete.mockResolvedValue({ changed: true });
  mocks.write.mockResolvedValue({ changed: true, commit: "abc1234" });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("pickCandidates", () => {
  it("lists overdue and due-this-week tasks by date, then each note's first task, then second tasks", async () => {
    const { pickCandidates } = await boot(kst("08:30"));
    const candidates = pickCandidates({ generatedAt: "", notes: VAULT.map((n) => ({ deadlines: [], ...n })) });
    expect(candidates.map(({ note, text, due }) => `${note} · ${text}${due ? ` @${due}` : ""}`)).toEqual([
      "이정표 · 관납료 납부 @2026-10-05", // 마감이 지난 것부터
      "todari-ops · 주간 요약 다듬기 @2026-10-14",
      "이정표 · 사업계획서 제출 @2026-10-19", // 딱 7일 뒤까지
      "HGT · 배포 키 구성",
      "todari-ops · 알림 버튼 실사용 확인",
      `인스타 실험실 · ${LONG}`, // 이정표의 첫 할 일은 이미 위에 있다
      "HGT · 스토어 심사 제출 @2026-10-30", // 마감이 멀면 제 차례에 나온다
      "todari-ops · 셋째 할 일",
    ]);
    expect(candidates.find((c) => c.note === "이정표")?.projectSlug).toBe("jeongpyo");
    expect(candidates.find((c) => c.note === "인스타 실험실")?.projectSlug).toBe("인스타 실험실");
    expect(new Set(candidates.map((c) => c.id)).size).toBe(8);
    expect(candidates.every((c) => /^[0-9a-f]{8}$/.test(c.id))).toBe(true);
  });

  it("leads with last night's first task, then deadlines, then the projects worked on lately", async () => {
    const { pickCandidates } = await boot(kst("08:30"));
    const vault = { generatedAt: "", notes: VAULT.map((n) => ({ deadlines: [], ...n })) };
    const order = { first: { note: "todari-ops", text: "셋째 할 일" }, active: ["인스타 실험실", "hgt", "볼트에-없는-프로젝트"] };
    expect(pickCandidates(vault, order).map(({ note, text, due }) => `${note} · ${text}${due ? ` @${due}` : ""}`)).toEqual([
      "todari-ops · 셋째 할 일", // 어젯밤 정한 "내일 첫 작업"
      "이정표 · 관납료 납부 @2026-10-05",
      "todari-ops · 주간 요약 다듬기 @2026-10-14",
      "이정표 · 사업계획서 제출 @2026-10-19",
      `인스타 실험실 · ${LONG}`, // 최근 커밋한 프로젝트의 첫 할 일, 커밋이 많은 순
      "HGT · 배포 키 구성",
      "todari-ops · 알림 버튼 실사용 확인", // 나머지 노트의 첫 할 일
      "HGT · 스토어 심사 제출 @2026-10-30", // 둘째 할 일부터도 같은 노트 순서다
    ]);
    // 그 할 일이 밤사이 끝났거나 문장이 바뀌었으면 맨 앞 자리는 없다.
    expect(pickCandidates(vault, { first: { note: "todari-ops", text: "어제 끝낸 일" } })[0]?.text).toBe("관납료 납부");
  });

  it("stops at 25, the select menu limit", async () => {
    const { pickCandidates } = await boot(kst("08:30"));
    const notes = Array.from({ length: 12 }, (_, i) => ({
      note: `노트${i + 1}`, deadlines: [], tasks: [{ text: "첫째" }, { text: "둘째" }, { text: "셋째" }],
    }));
    const candidates = pickCandidates({ generatedAt: "", notes });
    expect(candidates).toHaveLength(25);
    expect(candidates.slice(11, 13).map((c) => `${c.note} ${c.text}`)).toEqual(["노트12 첫째", "노트1 둘째"]);
    expect(`${candidates[24]!.note} ${candidates[24]!.text}`).toBe("노트1 셋째");
    expect(pickCandidates({ generatedAt: "", notes: [] })).toEqual([]);
  });
});

describe("morning digest", () => {
  it("offers a pick menu instead of the task list and keeps the start buttons", async () => {
    seedVault(VAULT);
    writeFileSync(join(root, "task-tidy.json"), JSON.stringify({ snoozed: { "todari-ops\n셋째 할 일": "2026-11-09" } }));
    const { postDigest } = await boot(kst("08:30"));
    expect(await postDigest()).toBe(true);

    const digest = lastSent();
    expect(fields(digest.embeds[0]!).map((field) => field.name).filter((name) => /다음 할 일|오늘의 3개/.test(name))).toEqual([]);
    expect(digest.components).toHaveLength(2);
    expect(menu(digest)).toMatchObject({
      custom_id: "today:pick:2026-10-12", placeholder: "🎯 오늘 할 일 고르기 (최대 3개)", min_values: 1, max_values: 3,
    });
    expect(menu(digest).options.map(({ label, description }) => `${label} | ${description}`)).toEqual([
      "관납료 납부 | 이정표 · 📅 10-05",
      "주간 요약 다듬기 | todari-ops · 📅 10-14",
      "사업계획서 제출 | 이정표 · 📅 10-19",
      "배포 키 구성 | HGT",
      "알림 버튼 실사용 확인 | todari-ops",
      `${LONG.slice(0, 99)}… | 인스타 실험실`, // 라벨은 100자에서 잘린다
      "스토어 심사 제출 | HGT · 📅 10-30",
      // 보류한 "셋째 할 일"은 후보가 아니다
    ]);
    expect(menu(digest).options.every((option) => option.label.length <= 100)).toBe(true);
    // 기존 "▶ /code 세션으로 시작" 버튼 줄은 그대로다(카탈로그 프로젝트의 할 일, 마감 순 3개).
    expect(buttons(digest.components.slice(1))[0]?.map((button) => button.label)).toEqual([
      "▶ jeongpyo: 관납료 납부", "▶ todari-ops: 주간 요약 다듬기", "▶ jeongpyo: 사업계획서 제출",
    ]);
    expect(buttons(digest.components.slice(1))[0]?.every((button) => button.id.startsWith("triage:start:"))).toBe(true);
  });

  it("puts last night's first task on top of the menu, already selected, while it is still open", async () => {
    seedVault(VAULT);
    const evening = await boot(kst("21:30", "2026-10-11"));
    await evening.postCheckinPrompt();
    const prompt = received(lastSent());
    const candidate = buttons(prompt.message.components)[2]![0]!;
    expect(candidate.label).toBe("🎯 todari-ops · 주간 요약 다듬기 (📅 10-14)");
    await click(candidate.id, prompt).press(evening.handleButton);

    const morning = await boot(kst("08:30"));
    await morning.postDigest();
    // 다이제스트 맨 위의 칸은 저녁에 본 문장 그대로다.
    expect(fields(lastSent().embeds[0]!)[0]).toMatchObject({
      name: "🎯 오늘 첫 작업 (어제 체크인)", value: "todari-ops · 주간 요약 다듬기 (📅 10-14)",
    });
    const selected = (options: Option[]) => options.map((option) => `${option.default ? "☑ " : ""}${option.label}`);
    expect(selected(menu(lastSent()).options).slice(0, 4)).toEqual([
      "☑ 주간 요약 다듬기", "관납료 납부", "사업계획서 제출", "배포 키 구성",
    ]);
    expect(menu(lastSent()).options).toHaveLength(8); // 맨 앞에 온 할 일이 제자리에 또 나오지 않는다

    // 밤사이 그 할 일을 끝냈으면(스냅샷에서 빠짐) 미리 고르지 않는다. 모달에 직접 쓴 첫 작업도 견줄 할 일이 없다.
    seedVault(VAULT.map((n) => ({ ...n, tasks: n.tasks.filter((task) => task.text !== "주간 요약 다듬기") })));
    await (await boot(kst("08:40"))).postDigest();
    expect(selected(menu(lastSent()).options)[0]).toBe("관납료 납부");
    seedVault(VAULT);
    const typed = await boot(kst("08:50"));
    await typed.saveTomorrowFirstTask("2026-10-11", "주간 요약 다듬기");
    await typed.postDigest();
    expect(selected(menu(lastSent()).options).slice(0, 2)).toEqual(["관납료 납부", "주간 요약 다듬기"]);
  });

  it("moves the projects with commits in the last three days ahead of the other notes", async () => {
    seedVault(VAULT);
    const pushed = (repo: string, at: string) => ({
      repository: { full_name: repo }, commit: { message: "feat: work", committer: { date: `2026-10-${at}:00+09:00` } },
    });
    mocks.ghJson.mockImplementation(async (path: string) => {
      if (path === "/user") return { login: "octo-owner" };
      if (!path.startsWith("/search/commits")) return null; // 레포별 커밋·PR 조회
      return {
        total_count: 4,
        items: [
          pushed("Todari/todari-ops", "12T08:00"), pushed("Todari/jeongpyo", "11T20:00"),
          pushed("Todari/todari-ops", "10T10:00"), pushed("Todari/todari-ops", "09T08:00"), // 사흘보다 앞선 커밋은 세지 않는다
        ],
      };
    });
    const { postDigest } = await boot(kst("08:30"));
    await postDigest();

    const search = mocks.ghJson.mock.calls.map(([path]) => decodeURIComponent(String(path))).find((path) => path.startsWith("/search"));
    expect(search).toContain("q=author:octo-owner committer-date:2026-10-08T23:30:00Z..2026-10-11T23:30:00Z&");
    expect(menu(lastSent()).options.map((option) => option.label).slice(3, 6)).toEqual([
      "알림 버튼 실사용 확인", // todari-ops: 사흘 동안 커밋이 가장 많다 (이정표의 첫 할 일은 이미 마감 순에 있다)
      "배포 키 구성",
      LONG.slice(0, 99) + "…",
    ]);
  });

  it("posts on time without that order when the commit lookup hangs or fails", async () => {
    seedVault(VAULT);
    // 커밋 검색만 끝내 답하지 않는다.
    mocks.ghJson.mockImplementation((path: string) => (path.startsWith("/search") ? new Promise(() => {}) : Promise.resolve(null)));
    const slow = await boot(kst("08:30"));
    const posting = slow.postDigest();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(mocks.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await posting).toBe(true);
    const plain = menu(lastSent()).options.map((option) => option.label);
    expect(plain.slice(3, 5)).toEqual(["배포 키 구성", "알림 버튼 실사용 확인"]);

    // 조회가 던져도(레포별 조회는 그대로 답한다) 메뉴만 그 순서 없이 나간다.
    mocks.ghJson.mockImplementation((path: string) =>
      path.startsWith("/repos") ? Promise.resolve(null) : Promise.reject(new Error("github down")),
    );
    await (await boot(kst("08:40"))).postDigest();
    expect(menu(lastSent()).options.map((option) => option.label)).toEqual(plain);
  });

  it("has no menu without a vault snapshot and caps the picks at the number of candidates", async () => {
    const empty = await boot(kst("08:30"));
    await empty.postDigest();
    expect(lastSent().components).toEqual([]);

    seedVault([{ note: "인스타 실험실", tasks: [{ text: "하나" }, { text: "둘" }] }]);
    const two = await boot(kst("08:30"));
    await two.postDigest();
    expect(menu(lastSent())).toMatchObject({ min_values: 1, max_values: 2 });
  });

  it("saves what the owner picks and writes it on the digest, keeping the menu", async () => {
    const { digest, values } = await aDayWithPicks();
    expect(picksOn("2026-10-12")).toEqual([
      { note: "이정표", text: "관납료 납부", done: false },
      { note: "todari-ops", text: "알림 버튼 실사용 확인", done: false },
      { note: "HGT", text: "배포 키 구성", done: false },
    ]);

    // 봇이 재시작해도, 자정을 넘겨도 그 다이제스트의 메뉴는 그날의 것이다.
    const later = await boot(kst("00:10", "2026-10-13"));
    const target = received(digest);
    const first = choose(menu(digest).custom_id, [values[2]!, values[0]!], target.message);
    await first.pick(later.handleSelect);
    const update = first.interaction.update.mock.calls[0]?.[0] as { embeds: EmbedBuilder[] };
    expect(Object.keys(update)).toEqual(["embeds"]); // 메뉴·버튼은 건드리지 않아 다시 고를 수 있다
    expect(fields(update.embeds[0]!).slice(0, -1)).toEqual(fields(digest.embeds[0]!));
    expect(picked(update.embeds[0]!)).toEqual(["1. **HGT** · 배포 키 구성\n2. **이정표** · 관납료 납부 (📅 10-05)"]);
    expect(picksOn("2026-10-12")).toHaveLength(2);
    expect(picksOn("2026-10-13")).toBeUndefined();

    // 다시 고르면 칸이 하나 더 붙지 않고 바뀐다.
    target.apply(update);
    const again = choose(menu(digest).custom_id, [values[1]!], target.message);
    await again.pick(later.handleSelect);
    const second = again.interaction.update.mock.calls[0]?.[0] as { embeds: EmbedBuilder[] };
    expect(picked(second.embeds[0]!)).toEqual(["1. **todari-ops** · 알림 버튼 실사용 확인"]);
    expect(fields(second.embeds[0]!)).toHaveLength(fields(digest.embeds[0]!).length + 1);
  });

  it("regenerates the candidates on a manual /digest but keeps and shows the picks", async () => {
    await aDayWithPicks();
    // 낮에 볼트가 다시 동기화됐다: 새 할 일이 생기고 고른 것 하나는 후보에서 사라졌다.
    seedVault([{ note: "todari-ops", slug: "todari-ops", tasks: [{ text: "새로 생긴 일" }, { text: "알림 버튼 실사용 확인" }] }]);
    const noon = await boot(kst("12:00"));
    await noon.postDigest();

    const digest = lastSent();
    expect(menu(digest).options.map((option) => option.label)).toEqual(["새로 생긴 일", "알림 버튼 실사용 확인"]);
    expect(picked(digest.embeds[0]!)).toEqual([
      "1. **이정표** · 관납료 납부 (📅 10-05)\n2. **todari-ops** · 알림 버튼 실사용 확인\n3. **HGT** · 배포 키 구성",
    ]);
    expect(picksOn("2026-10-12")).toHaveLength(3);
  });

  it("answers privately when the list is gone or the picker is not the owner", async () => {
    const { digest, values } = await aDayWithPicks();
    const { handleSelect } = await boot(kst("09:00"));
    const message = received(digest).message;

    const stranger = choose(menu(digest).custom_id, values, message, "someone-else");
    await stranger.pick(handleSelect);
    expect(stranger.interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: "권한 없음" }));

    const unknown = choose(menu(digest).custom_id, ["nope1234"], message);
    await unknown.pick(handleSelect);
    const expired = choose("today:pick:2026-09-01", values, message);
    await expired.pick(handleSelect);
    for (const { interaction } of [stranger, unknown, expired]) expect(interaction.update).not.toHaveBeenCalled();
    for (const { interaction } of [unknown, expired]) {
      expect(interaction.reply).toHaveBeenCalledWith({ content: expect.stringContaining("만료"), flags: EPHEMERAL });
    }
    expect(picksOn("2026-10-12")).toHaveLength(3); // 고른 것은 그대로다
  });
});

describe("evening check-in", () => {
  it("shows today's three with one done button each and completes a task in the vault on a tap", async () => {
    await aDayWithPicks();
    const { postCheckinPrompt, handleButton } = await boot(kst("21:30"));
    await postCheckinPrompt();
    const prompt = received(lastSent());

    expect(picked(prompt.message.embeds[0]!)).toEqual([
      "1. **이정표** · 관납료 납부 (📅 10-05)\n2. **todari-ops** · 알림 버튼 실사용 확인\n3. **HGT** · 배포 키 구성",
    ]);
    const rows = buttons(prompt.message.components);
    expect(rows).toHaveLength(5); // 회고 1 + 내일 첫 작업 후보 3 + 완료 1 = Discord 한도
    expect(rows[0]).toEqual([{ id: "checkin:open:2026-10-12", label: "📝 회고 쓰기 (30초)" }]);
    expect(rows.slice(1, 4).every(([button]) => button!.id.startsWith("checkin:pick:2026-10-12:"))).toBe(true);
    expect(rows[4]?.map((button) => button.label)).toEqual(["✅ 1", "✅ 2", "✅ 3"]);

    const done = click(rows[4]![1]!.id, prompt);
    await done.press(handleButton);
    expect(done.interaction.deferUpdate).toHaveBeenCalled(); // 볼트 push 는 3초를 넘긴다
    expect(mocks.complete).toHaveBeenCalledWith(
      expect.objectContaining({ projectSlug: "todari-ops", note: "todari-ops", text: "알림 버튼 실사용 확인" }),
    );
    expect(picksOn("2026-10-12")?.map((pick) => pick.done)).toEqual([false, true, false]);
    // 스냅샷에서도 빠져 내일 아침 후보에 다시 나오지 않는다.
    expect(saved<{ notes: Note[] }>("vault-state.json").notes[1]?.tasks.map((task) => task.text)).toEqual([
      "주간 요약 다듬기", "셋째 할 일",
    ]);
    expect(picked(prompt.message.embeds[0]!)).toEqual([
      "1. **이정표** · 관납료 납부 (📅 10-05)\n2. ✅ **todari-ops** · 알림 버튼 실사용 확인\n3. **HGT** · 배포 키 구성",
    ]);
    // 다른 줄은 그대로, 완료 줄에서 그 버튼만 빠진다.
    expect(buttons(prompt.message.components)).toEqual([...rows.slice(0, 4), [rows[4]![0], rows[4]![2]]]);
    expect(done.interaction.reply).not.toHaveBeenCalled();
    expect(done.interaction.followUp).not.toHaveBeenCalled();
  });

  it("keeps the done buttons when tomorrow's first task is picked, and drops the row once all are done", async () => {
    await aDayWithPicks();
    const { postCheckinPrompt, handleButton, getFirstTaskChosenOn } = await boot(kst("21:30"));
    await postCheckinPrompt();
    const prompt = received(lastSent());
    const rows = buttons(prompt.message.components);

    await click(rows[4]![0]!.id, prompt).press(handleButton); // ✅ 1
    await click(rows[1]![0]!.id, prompt).press(handleButton); // 🎯 내일 첫 작업 후보
    expect(getFirstTaskChosenOn("2026-10-12")).toBeTruthy();
    expect(buttons(prompt.message.components)).toEqual([rows[0], [rows[4]![1], rows[4]![2]]]);

    // 봇이 재시작한 뒤, 자정을 넘겨 눌러도 그날의 3개다.
    const midnight = await boot(kst("00:20", "2026-10-13"));
    await click(rows[4]![2]!.id, prompt).press(midnight.handleButton); // ✅ 3
    await click(rows[4]![1]!.id, prompt).press(midnight.handleButton); // ✅ 2
    expect(mocks.complete).toHaveBeenCalledTimes(3);
    expect(picksOn("2026-10-12")?.every((pick) => pick.done)).toBe(true);
    expect(picked(prompt.message.embeds[0]!)).toEqual([
      "1. ✅ **이정표** · 관납료 납부 (📅 10-05)\n2. ✅ **todari-ops** · 알림 버튼 실사용 확인\n3. ✅ **HGT** · 배포 키 구성",
    ]);
    expect(buttons(prompt.message.components)).toEqual([rows[0]]); // 회고 버튼만 남는다
    expect(prompt.message.content).toContain("🎯 내일 첫 작업: ");
  });

  it("does not bring the candidate buttons back when a completion finishes after tomorrow's task was picked", async () => {
    await aDayWithPicks();
    const { postCheckinPrompt, handleButton } = await boot(kst("21:30"));
    await postCheckinPrompt();
    const prompt = received(lastSent());
    const rows = buttons(prompt.message.components);
    let finish!: (result: { changed: boolean }) => void;
    mocks.complete.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));

    const done = click(rows[4]![0]!.id, prompt); // ✅ 1
    const completing = done.press(handleButton); // 볼트 push 를 기다리는 중
    await click(rows[2]![0]!.id, prompt).press(handleButton); // 그사이 🎯 내일 첫 작업 후보를 눌렀다
    expect(buttons(prompt.message.components)).toEqual([rows[0], rows[4]]);

    finish({ changed: true });
    await completing;
    expect(buttons(prompt.message.components)).toEqual([rows[0], [rows[4]![1], rows[4]![2]]]);
    expect(prompt.message.content).toContain("🎯 내일 첫 작업: ");
    expect(picked(prompt.message.embeds[0]!)[0]).toMatch(/^1\. ✅ \*\*이정표\*\*/);
  });

  it("stays quiet when the same done button is tapped twice before the first tap lands", async () => {
    await aDayWithPicks();
    const { postCheckinPrompt, handleButton } = await boot(kst("21:30"));
    await postCheckinPrompt();
    const prompt = received(lastSent());
    const rows = buttons(prompt.message.components);
    const writes: Array<(result: { changed: boolean }) => void> = [];
    mocks.complete.mockImplementation(() => new Promise((resolve) => writes.push(resolve)));

    const first = click(rows[4]![0]!.id, prompt);
    const second = click(rows[4]![0]!.id, prompt);
    const both = [first.press(handleButton), second.press(handleButton)];
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    writes[0]!({ changed: true });
    await both[0];
    writes[1]!({ changed: false }); // 둘째 쓰기는 이미 완료된 줄을 만난다
    await both[1];

    for (const { interaction } of [first, second]) expect(interaction.followUp).not.toHaveBeenCalled();
    expect(picksOn("2026-10-12")?.map((pick) => pick.done)).toEqual([true, false, false]);
    expect(buttons(prompt.message.components).at(-1)?.map((button) => button.label)).toEqual(["✅ 2", "✅ 3"]);
  });

  it("marks a pick done even when the vault no longer has its open checkbox, and says so", async () => {
    await aDayWithPicks();
    const { postCheckinPrompt, handleButton } = await boot(kst("21:30"));
    await postCheckinPrompt();
    const prompt = received(lastSent());
    const rows = buttons(prompt.message.components);

    mocks.complete.mockResolvedValue({ changed: false }); // 낮에 옵시디언에서 이미 체크했다
    const done = click(rows[4]![0]!.id, prompt);
    await done.press(handleButton);
    expect(done.interaction.followUp).toHaveBeenCalledWith({
      content: expect.stringContaining("**이정표** 노트에 이 할 일의 열린 체크박스가 없어"), flags: EPHEMERAL,
    });
    expect(picksOn("2026-10-12")?.map((pick) => pick.done)).toEqual([true, false, false]);
    expect(buttons(prompt.message.components).at(-1)?.map((button) => button.label)).toEqual(["✅ 2", "✅ 3"]);
    expect(saved<{ notes: Note[] }>("vault-state.json").notes[2]?.tasks).toEqual(VAULT[2]!.tasks); // 스냅샷은 그대로
  });

  it("leaves everything as it was when the vault write fails or the pick is unknown", async () => {
    await aDayWithPicks();
    const { postCheckinPrompt, handleButton } = await boot(kst("21:30"));
    await postCheckinPrompt();
    const prompt = received(lastSent());
    const rows = buttons(prompt.message.components);

    mocks.complete.mockRejectedValue(new Error("vault push conflict"));
    const failed = click(rows[4]![0]!.id, prompt);
    await failed.press(handleButton);
    expect(failed.interaction.followUp).toHaveBeenCalledWith({
      content: expect.stringContaining("볼트에 반영하지 못했습니다"), flags: EPHEMERAL,
    });
    const unknown = click("today:done:2026-10-12:nope1234", prompt);
    await unknown.press(handleButton);
    expect(unknown.interaction.reply).toHaveBeenCalledWith({ content: expect.stringContaining("그날의 3개에 없습니다"), flags: EPHEMERAL });
    const stranger = click(rows[4]![0]!.id, prompt, "someone-else");
    await stranger.press(handleButton);
    expect(stranger.interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: "권한 없음" }));

    for (const { interaction } of [failed, unknown, stranger]) expect(interaction.editReply).not.toHaveBeenCalled();
    expect(picksOn("2026-10-12")?.some((pick) => pick.done)).toBe(false);
    expect(buttons(prompt.message.components)).toEqual(rows);
  });

  it("adds nothing without picks and does not suggest a snoozed task for tomorrow", async () => {
    seedVault([{ note: "todari-ops", slug: "todari-ops", tasks: [{ text: "보류한 일" }, { text: "배포 확인" }] }]);
    writeFileSync(join(root, "task-tidy.json"), JSON.stringify({ snoozed: { "todari-ops\n보류한 일": "2026-10-13" } }));
    const today = await boot(kst("21:30"));
    await today.postCheckinPrompt();
    expect(lastSent().embeds).toEqual([]);
    expect(buttons(lastSent().components).flat().map((button) => button.label)).toEqual([
      "📝 회고 쓰기 (30초)", "🎯 todari-ops · 배포 확인",
    ]);

    const tomorrow = await boot(kst("21:30", "2026-10-13")); // 보류가 끝난 날에는 다시 권한다
    await tomorrow.postCheckinPrompt();
    expect(buttons(lastSent().components).flat().map((button) => button.label)).toEqual([
      "📝 회고 쓰기 (30초)", "🎯 todari-ops · 보류한 일",
    ]);
  });
});

describe("daily log", () => {
  it("records today's three as plain bullets, done or not, before tomorrow's first task", async () => {
    await aDayWithPicks();
    const evening = await boot(kst("21:30"));
    await evening.postCheckinPrompt();
    const prompt = received(lastSent());
    await click(buttons(prompt.message.components)[4]![1]!.id, prompt).press(evening.handleButton); // ✅ 2
    await evening.saveTomorrowFirstTask("2026-10-12", "이정표 · 사업계획서 제출");

    const night = await boot(kst("00:40", "2026-10-13"));
    expect(await night.writeDailyLog("2026-10-12")).toBe(true);
    expect(mocks.write).toHaveBeenCalledWith("2026-10-12", [
      "### 오늘의 3개",
      "- ⬜ 이정표 · 관납료 납부",
      "- ✅ todari-ops · 알림 버튼 실사용 확인",
      "- ⬜ HGT · 배포 키 구성",
      "### 내일 첫 작업",
      "- 이정표 · 사업계획서 제출",
    ].join("\n"));
    // 체크박스가 아니다: 볼트에서 새 열린 할 일이 되지 않는다.
    expect(mocks.write.mock.calls[0]?.[1]).not.toMatch(/- \[[ x]\]/);

    mocks.write.mockClear();
    expect(await night.writeDailyLog("2026-10-11")).toBe(false); // 고르지 않은 날에는 구획이 없다
    expect(mocks.write).not.toHaveBeenCalled();
  });
});
