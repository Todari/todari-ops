import type { ActionRowBuilder, ButtonBuilder, ButtonInteraction, EmbedBuilder } from "discord.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  env: { WORK_DIR: "", OWNER_DISCORD_ID: "owner", CHECKIN_TIME: "21:30", DAILY_LOG_OWNERS: [] as string[], VAULT_REPO_URL: "" },
  send: vi.fn(), ghJson: vi.fn(), added: vi.fn(),
}));
vi.mock("../env.js", () => ({ env: mocks.env }));
vi.mock("../discord/alerts.js", () => ({
  fetchDigestChannel: async () => ({ send: mocks.send }),
  ownerMention: () => ({ content: "<@owner>", allowedMentions: { users: ["owner"] } }),
}));
vi.mock("../github/api.js", () => ({ ghJson: mocks.ghJson }));
vi.mock("../vault/mutations.js", () => ({ listVaultNotesAdded: mocks.added }));
vi.mock("../observability/sentry.js", () => ({ captureException: vi.fn() }));
// handleButton 이 함께 끌어오는 다른 버튼 처리기들. 여기서는 체크인 경로만 본다.
vi.mock("../content/index.js", () => ({ contentButton: vi.fn() }));
vi.mock("../agent/permissions.js", () => ({ resolvePending: vi.fn() }));
vi.mock("../agent/bootstrap.js", () => ({ spawnSessionThread: vi.fn() }));
vi.mock("../webhook/instagram-handler.js", () => ({
  ACK_BUTTON_ID: "igack", OPS_BUTTON_ID: "igops", acknowledgeProblem: vi.fn(), requestProblemAction: vi.fn(),
}));
vi.mock("../jp/cards.js", () => ({ dueCards: vi.fn(), gradeCard: vi.fn() }));
// 볼트 할 일(vault/state)·후보 보관(checkin-candidates.json)·체크인 저장은 실제 구현이 임시 /data 를 읽고 쓴다.

const PROMPT = "<@owner> 🌙 **저녁 체크인** — 오늘을 3줄로 닫읍시다. 내일 첫 작업은 아침 브리핑 맨 위에 올라갑니다.";
const LONG_TASK = `워커 메모리 한도 초과 원인 찾기: ${"수집 시작 직후 OOM 이 나는 구간을 좁힌다 ".repeat(6)}끝`;
const kst = (hhmm: string, date = "2026-10-12") => Date.parse(`${date}T${hhmm}:00+09:00`);
const commit = (repo: string, message: string, hhmm: string) => ({
  repository: { full_name: repo },
  commit: { message, committer: { date: `2026-10-12T${hhmm}:00.000+09:00` } },
});
let root: string;

/** 봇을 그 시각에 띄운다(모듈 상태 초기화). 체크인과 버튼 처리기는 같은 모듈 인스턴스를 본다. */
async function boot(now: number) {
  vi.resetModules();
  vi.setSystemTime(now);
  const [checkin, button] = await Promise.all([import("./index.js"), import("../handlers/button.js")]);
  return { ...checkin, handleButton: button.handleButton };
}
function seedVault(notes: Array<{ note: string; slug?: string; tasks: Array<{ text: string; due?: string }> }>) {
  writeFileSync(
    join(root, "vault-state.json"),
    JSON.stringify({ generatedAt: "2026-10-12T09:00:00Z", notes: notes.map((n) => ({ deadlines: [], ...n })) }),
  );
}
/** 마지막으로 게시된 체크인 메시지를 비교하기 쉬운 모양으로. */
function posted() {
  const message = mocks.send.mock.calls.at(-1)?.[0] as {
    content: string; allowedMentions: unknown; embeds: EmbedBuilder[]; components: Array<ActionRowBuilder<ButtonBuilder>>;
  };
  return {
    content: message.content,
    allowedMentions: message.allowedMentions,
    embeds: message.embeds.map((embed) => embed.toJSON()),
    buttons: buttons(message.components),
  };
}
const buttons = (rows: Array<ActionRowBuilder<ButtonBuilder>>) =>
  rows.flatMap((row) => row.toJSON().components as Array<{ custom_id: string; label: string }>)
    .map(({ custom_id, label }) => ({ id: custom_id, label }));
function click(customId: string, userId = "owner") {
  const interaction = { user: { id: userId }, customId, message: { content: PROMPT }, update: vi.fn(), reply: vi.fn() };
  return { interaction, press: (handle: (i: ButtonInteraction) => Promise<void>) => handle(interaction as unknown as ButtonInteraction) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  root = mkdtempSync(join(tmpdir(), "checkin-"));
  mocks.env.WORK_DIR = join(root, "work");
  mocks.ghJson.mockResolvedValue(null);
  mocks.added.mockResolvedValue([]);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

it("adds today's evidence and up to three first-task buttons to the unchanged prompt", async () => {
  mocks.ghJson.mockResolvedValue({
    total_count: 3,
    items: [
      commit("linkive/linkive-geo", "fix: worker memory", "20:10"),
      commit("Todari/todari-ops", "feat: daily log", "15:00"),
      commit("linkive/linkive-geo", "feat: collector", "11:00"),
    ],
  });
  mocks.added.mockResolvedValue(["이정표/의사결정/2026-10-12 가격 정책.md"]);
  writeFileSync(join(root, "events.json"), JSON.stringify([{ t: kst("16:00"), kind: "vercel_deploy", project: "todari" }]));
  seedVault([
    { note: "HGT", slug: "HGT", tasks: [{ text: "배포 키 구성" }] },
    { note: "linkive-geo", slug: "linkive-geo", tasks: [{ text: LONG_TASK }, { text: "두 번째" }] },
    { note: "todari-ops", slug: "todari-ops", tasks: [{ text: "알림 버튼 실사용 확인" }] },
    { note: "이정표", slug: "jeongpyo", tasks: [{ text: "관납료 납부" }, { text: "사업계획서 제출", due: "2026-10-15" }] },
  ]);
  const { postCheckinPrompt } = await boot(kst("21:30"));
  expect(await postCheckinPrompt()).toBe(true);

  const message = posted();
  expect(message.content).toBe(PROMPT);
  expect(message.allowedMentions).toEqual({ users: ["owner"] });
  expect(message.embeds).toEqual([expect.objectContaining({
    title: "오늘 한 일 (지금까지)",
    fields: [
      { name: "코드", value: "- **linkive-geo** 2건: feat: collector; fix: worker memory\n- **todari-ops** 1건: feat: daily log" },
      { name: "운영", value: "- 배포 1건 (todari)" },
      { name: "볼트", value: "- 의사결정: 2026-10-12 가격 정책" },
    ],
  })]);
  expect(mocks.added).toHaveBeenCalledWith(kst("00:00"), kst("00:00", "2026-10-13"));

  // 회고 버튼은 그대로 맨 앞. 후보는 마감 임박 → 오늘 커밋한 프로젝트(많은 순) 순이고 78자에서 잘린다.
  const geo = `linkive-geo · ${LONG_TASK}`;
  expect(message.buttons).toEqual([
    { id: "checkin:open:2026-10-12", label: "📝 회고 쓰기 (30초)" },
    { id: expect.stringMatching(/^checkin:pick:2026-10-12:\w+$/), label: "🎯 이정표 · 사업계획서 제출 (📅 10-15)" },
    { id: expect.stringMatching(/^checkin:pick:2026-10-12:\w+$/), label: `🎯 ${geo}`.slice(0, 77) + "…" },
    { id: expect.stringMatching(/^checkin:pick:2026-10-12:\w+$/), label: "🎯 todari-ops · 알림 버튼 실사용 확인" },
  ]);
  expect(message.buttons.every((button) => button.label.length <= 78)).toBe(true);
});

it("saves the tapped candidate in full and swaps the candidate buttons for one line", async () => {
  seedVault([{ note: "linkive-geo", tasks: [{ text: LONG_TASK }] }, { note: "todari-ops", tasks: [{ text: "배포 확인" }] }]);
  await (await boot(kst("21:30"))).postCheckinPrompt();
  const picked = posted().buttons[1]!;
  const full = `linkive-geo · ${LONG_TASK}`;
  expect(picked.label).not.toBe(`🎯 ${full}`); // 라벨은 잘렸다

  // 저녁 배포로 봇이 재시작한 뒤에, 자정을 넘겨 눌러도 그 저녁의 체크인이다.
  const { handleButton, getFirstTaskChosenOn, getTodayFirstTask, getTodayFirstTaskRef } = await boot(kst("00:30", "2026-10-13"));
  const { interaction, press } = click(picked.id);
  await press(handleButton);

  expect(interaction.reply).not.toHaveBeenCalled();
  const update = interaction.update.mock.calls[0]?.[0] as { content: string; components: Array<ActionRowBuilder<ButtonBuilder>> };
  expect(update.content).toBe(`${PROMPT}\n🎯 내일 첫 작업: ${full}`);
  expect(buttons(update.components)).toEqual([{ id: "checkin:open:2026-10-12", label: "📝 회고 쓰기 (30초)" }]);
  expect(getFirstTaskChosenOn("2026-10-12")).toBe(full); // 그날 밤 자동 데일리 기록에 들어간다
  expect(getFirstTaskChosenOn("2026-10-13")).toBeNull();
  vi.setSystemTime(kst("08:30", "2026-10-13"));
  expect(getTodayFirstTask()).toBe(full); // 아침 다이제스트 맨 위
  // 어느 할 일인지도 남는다: 아침의 고르기 메뉴가 그 할 일을 맨 앞에 미리 골라 둔다.
  expect(getTodayFirstTaskRef()).toEqual({ note: "linkive-geo", text: LONG_TASK });
  vi.setSystemTime(kst("08:30", "2026-10-14")); // 하루가 더 지나면 지난 선택이다
  expect(getTodayFirstTaskRef()).toBeNull();
});

it("answers an expired, unknown or foreign pick privately without saving anything", async () => {
  seedVault([{ note: "todari-ops", tasks: [{ text: "배포 확인" }] }]);
  const { postCheckinPrompt, handleButton, getFirstTaskChosenOn } = await boot(kst("21:30"));
  await postCheckinPrompt();
  const picked = posted().buttons[1]!;

  const stranger = click(picked.id, "someone-else");
  await stranger.press(handleButton);
  expect(stranger.interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: "권한 없음" }));

  const unknown = click("checkin:pick:2026-10-12:nope1234");
  await unknown.press(handleButton);
  vi.setSystemTime(kst("09:31", "2026-10-13")); // 12시간이 지났다
  const expired = click(picked.id);
  await expired.press(handleButton);

  for (const { interaction } of [unknown, expired]) {
    expect(interaction.update).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("만료"), flags: 64, // MessageFlags.Ephemeral
    });
  }
  expect(getFirstTaskChosenOn("2026-10-12")).toBeNull();
});

it("keeps an earlier prompt's buttons alive after a second /checkin and forgets candidates after a week", async () => {
  seedVault([{ note: "todari-ops", tasks: [{ text: "배포 확인" }] }]);
  writeFileSync(join(root, "checkin-candidates.json"), JSON.stringify({
    "2026-10-04": { aaaa1111: { label: "여드레 전 후보", at: kst("21:30", "2026-10-04") } },
    "2026-10-05": { bbbb2222: { label: "이레 전 후보", at: kst("21:30", "2026-10-05") } },
  }));
  const { postCheckinPrompt, handleButton, getFirstTaskChosenOn } = await boot(kst("21:30"));
  await postCheckinPrompt();
  const first = posted().buttons[1]!;
  await postCheckinPrompt(); // 같은 저녁의 수동 /checkin
  const second = posted().buttons[1]!;
  expect(second.id).not.toBe(first.id);

  const stored = JSON.parse(readFileSync(join(root, "checkin-candidates.json"), "utf8")) as Record<string, object>;
  expect(Object.keys(stored)).toEqual(["2026-10-05", "2026-10-12"]);
  expect(stored["2026-10-12"]).toEqual({
    [first.id.split(":")[3]!]: { label: "todari-ops · 배포 확인", note: "todari-ops", text: "배포 확인", at: kst("21:30") },
    [second.id.split(":")[3]!]: { label: "todari-ops · 배포 확인", note: "todari-ops", text: "배포 확인", at: kst("21:30") },
  });

  await click(first.id).press(handleButton);
  expect(getFirstTaskChosenOn("2026-10-12")).toBe("todari-ops · 배포 확인");
  // 지난 저녁의 후보는 파일에 남아 있어도 12시간이 지나 받지 않는다.
  const stale = click("checkin:pick:2026-10-05:bbbb2222");
  await stale.press(handleButton);
  expect(stale.interaction.reply).toHaveBeenCalledWith({ content: expect.stringContaining("만료"), flags: 64 });
  expect(getFirstTaskChosenOn("2026-10-05")).toBeNull();
});

it("posts the plain prompt when there is no evidence and no vault snapshot", async () => {
  mocks.added.mockRejectedValue(new Error("git pull exited 1"));
  const { postCheckinPrompt } = await boot(kst("21:30"));
  expect(await postCheckinPrompt()).toBe(true);
  expect(posted()).toEqual({
    content: PROMPT,
    allowedMentions: { users: ["owner"] },
    embeds: [],
    buttons: [{ id: "checkin:open:2026-10-12", label: "📝 회고 쓰기 (30초)" }],
  });
});

it("does not hold the prompt back when evidence collection hangs", async () => {
  mocks.ghJson.mockReturnValue(new Promise(() => {})); // GitHub 이 끝내 답하지 않는다
  seedVault([{ note: "todari-ops", tasks: [{ text: "배포 확인" }] }]);
  const { postCheckinPrompt } = await boot(kst("21:30"));
  const posting = postCheckinPrompt();
  await vi.advanceTimersByTimeAsync(19_999);
  expect(mocks.send).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(await posting).toBe(true);
  expect(posted().embeds).toEqual([]);
  expect(posted().buttons.map((button) => button.label)).toEqual(["📝 회고 쓰기 (30초)", "🎯 todari-ops · 배포 확인"]);
});

it("orders candidates by due date, then today's projects, then the remaining notes", async () => {
  const { firstTaskCandidates } = await boot(kst("21:30"));
  const vault = {
    generatedAt: "",
    notes: [
      { note: "HGT", slug: "HGT", deadlines: [], tasks: [{ text: "가" }] },
      { note: "빈 노트", deadlines: [], tasks: [] },
      { note: "섹터4", slug: "sector4", deadlines: [], tasks: [{ text: "나" }, { text: "다", due: "2026-11-01" }] },
      { note: "포크레터", slug: "forcletter", deadlines: [], tasks: [{ text: "라", due: "2026-10-20" }, { text: "마" }] },
      { note: "인스타 실험실", deadlines: [], tasks: [{ text: "바" }] }, // 카탈로그 밖 노트도 후보다
    ],
  };
  const labels = (active: string[], limit?: number) => firstTaskCandidates(vault, active, limit).map((c) => c.label);
  expect(labels(["인스타 실험실", "hgt"], 10)).toEqual([
    "포크레터 · 라 (📅 10-20)",
    "섹터4 · 다 (📅 11-01)",
    "인스타 실험실 · 바",
    "HGT · 가",
    "섹터4 · 나",
    // "포크레터 · 라"는 이미 마감 순에 있다
  ]);
  expect(labels([])).toEqual(["포크레터 · 라 (📅 10-20)", "섹터4 · 다 (📅 11-01)", "HGT · 가"]);
  // 버튼에 보이는 문장과 별개로 어느 노트의 어느 할 일인지 함께 돌려준다.
  expect(firstTaskCandidates(vault, [])[0]).toEqual({ label: "포크레터 · 라 (📅 10-20)", note: "포크레터", text: "라" });
});
