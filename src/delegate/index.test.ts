import { ActionRow, Embed, type ButtonInteraction, type EmbedBuilder } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  env: {
    WORK_DIR: "", OWNER_DISCORD_ID: "owner", DIGEST_TIME: "08:30", CHECKIN_TIME: "21:30", DAILY_LOG_TIME: "00:40",
    DAILY_LOG_OWNERS: [] as string[], VAULT_REPO_URL: "",
  },
  // 지어낸 카탈로그: GitHub 레포 둘과 GitHub 밖의 레포 하나.
  catalog: [
    { slug: "widgets", name: "Widgets", repoUrl: "https://github.com/acme/widgets.git", defaultBranch: "main" },
    { slug: "gadgets", name: "Gadgets", repoUrl: "https://github.com/acme/gadgets.git", defaultBranch: "main" },
    { slug: "manual", name: "Manual", repoUrl: "https://git.example.com/acme/manual.git", defaultBranch: "main" },
  ],
  send: vi.fn(), ghJson: vi.fn(), ghPost: vi.fn(),
}));
vi.mock("../env.js", () => ({ env: mocks.env }));
vi.mock("../projects.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../projects.js")>();
  // 찾기·레포 이름 함수는 실제 구현 그대로 두고, 그것들이 읽는 목록만 바꾼다.
  actual.projects.splice(0, actual.projects.length, ...mocks.catalog);
  return { ...actual };
});
vi.mock("../discord/alerts.js", () => ({
  fetchDigestChannel: async () => ({ send: mocks.send, setTopic: vi.fn() }),
  ownerMention: () => ({ content: "<@owner>", allowedMentions: { users: ["owner"] } }),
}));
vi.mock("../github/api.js", () => ({ ghJson: mocks.ghJson, ghPost: mocks.ghPost }));
vi.mock("../vault/mutations.js", () => ({ listVaultNotesAdded: async () => [] }));
vi.mock("../observability/sentry.js", () => ({ captureException: vi.fn() }));
vi.mock("../monitor/uptime.js", () => ({ getUptimeSnapshot: () => [], formatUptimeSnapshot: () => "" }));
vi.mock("../monitor/status-board.js", () => ({ getInstagramBrief: () => null, readInstagramBrief: () => null }));
// handleButton 이 함께 끌어오는 다른 버튼 처리기들. 여기서는 위임 경로만 본다.
vi.mock("../content/index.js", () => ({ contentButton: vi.fn() }));
vi.mock("../agent/permissions.js", () => ({ resolvePending: vi.fn() }));
vi.mock("../agent/bootstrap.js", () => ({ spawnSessionThread: vi.fn() }));
vi.mock("../webhook/instagram-handler.js", () => ({
  ACK_BUTTON_ID: "igack", OPS_BUTTON_ID: "igops", acknowledgeProblem: vi.fn(), requestProblemAction: vi.fn(),
}));
vi.mock("../jp/cards.js", () => ({ dueCards: vi.fn(), gradeCard: vi.fn(), dailyCardBetween: () => null }));
// 볼트 스냅샷·위임 후보(delegations.json)·다이제스트는 실제 구현이 임시 /data 를 읽고 쓴다.

type Note = { note: string; slug?: string; tasks: Array<{ text: string; due?: string }> };
type Payload = { content?: string; embeds?: Array<{ toJSON(): unknown }>; components?: Array<{ toJSON(): unknown }> };
type Posted = {
  message: { id: string; content: string; embeds: Embed[]; components: Array<ActionRow<never>> };
  apply: (payload: Payload) => unknown;
};
const kst = (hhmm: string, date = "2026-10-12") => Date.parse(`${date}T${hhmm}:00+09:00`);
const EPHEMERAL = 64; // MessageFlags.Ephemeral
const FIELD = "🤖 위임";
const WORKFLOW = "/contents/.github/workflows/claude.yml";
const OPEN_ISSUES = "/issues?state=open&per_page=50";
const ISSUE = "https://github.com/acme/widgets/issues/7";
const VAULT: Note[] = [
  { note: "위젯 가게", slug: "widgets", tasks: [{ text: "결제 실패 재시도 추가", due: "2026-10-13" }, { text: "관리자 화면 정렬 버그" }] },
  { note: "Gadgets", slug: "gadgets", tasks: [{ text: "README 설치 절차 갱신", due: "2026-10-14" }] },
  { note: "독서 노트", tasks: [{ text: "카탈로그에 없는 노트의 할 일" }] },
];
const BODY = (text: string, note: string) =>
  [
    "@claude 아래 할 일을 맡아줘.",
    "",
    "## 할 일",
    "",
    `> ${text}`,
    "",
    `볼트 노트: ${note}`,
    "",
    "## 진행 방법",
    "",
    "- 새 브랜치에서 작업하고 pull request 를 연다.",
    "- 기본 브랜치에는 절대 직접 push 하지 않는다.",
    "- 레포의 테스트를 실행하고 그 결과를 PR 설명에 적는다.",
    "- 할 일이 불분명하면 작업을 멈추고 이 이슈에 질문을 남긴다.",
  ].join("\n");
let root: string;
/** 채널에 올라가 있는 메시지들. 봇은 다이제스트를 여기서 다시 읽어 고친다. */
let channel: Map<string, Posted>;

/** 봇을 그 시각에 (다시) 띄운다: 메모리 상태는 사라지고 /data 의 파일만 남는다. */
async function boot(now: number) {
  vi.resetModules();
  vi.setSystemTime(now);
  const [digest, delegate, button] = await Promise.all([
    import("../digest/daily.js"), import("./index.js"), import("../handlers/button.js"),
  ]);
  return { postDigest: digest.postDigest, ...delegate, handleButton: button.handleButton };
}
function seedVault(notes: Note[]) {
  writeFileSync(
    join(root, "vault-state.json"),
    JSON.stringify({ generatedAt: "2026-10-12T00:00:00Z", notes: notes.map((n) => ({ deadlines: [], ...n })) }),
  );
}
/**
 * GitHub 의 답: 워크플로가 있는 레포, 공개 레포, 열린 이슈 목록(null 이면 그 조회가 실패한다)을 정한다.
 * 레포별 커밋·PR 조회에는 답이 없다.
 */
function github({ ready = [] as string[], open = [] as string[], issues = [] as object[] | null } = {}) {
  mocks.ghJson.mockImplementation(async (path: string) => {
    if (path.startsWith("/search")) return { total_count: 0, items: [] };
    if (path.endsWith(WORKFLOW)) {
      return ready.includes(path.slice("/repos/".length, -WORKFLOW.length)) ? { type: "file", name: "claude.yml" } : null;
    }
    if (path.endsWith(OPEN_ISSUES)) return issues;
    if (/^\/repos\/[^/]+\/[^/?]+$/.test(path)) return { private: !open.includes(path.slice("/repos/".length)) };
    return null;
  });
}
const asked = (end = "") => mocks.ghJson.mock.calls.map(([path]) => String(path)).filter((path) => path.endsWith(end));
const saved = () => JSON.parse(readFileSync(join(root, "delegations.json"), "utf8")) as Record<string, { text: string; issueUrl?: string }>;
const lastSent = () => mocks.send.mock.calls.at(-1)?.[0] as Required<Payload>;
const fields = (embed: EmbedBuilder | Embed) => embed.toJSON().fields ?? [];
const delegated = (embed: EmbedBuilder | Embed) => fields(embed).filter((field) => field.name === FIELD).map((field) => field.value);
const buttons = (rows: ReadonlyArray<{ toJSON(): unknown }>) =>
  rows.map((row) =>
    ((row.toJSON() as { components: Array<{ custom_id: string; label: string }> }).components).map(
      ({ custom_id, label }) => ({ id: custom_id, label }),
    ),
  );
const snapshot = ({ message }: Posted) => ({
  content: message.content,
  embeds: message.embeds.map((embed) => embed.toJSON()),
  components: message.components.map((row) => row.toJSON()),
});

/** Discord 가 돌려주는 메시지: 보낸 빌더가 아니라 받은 구조체(Embed·ActionRow)다. 수정하면 그 메시지가 바뀐다. */
function received(id: string, payload: Payload): Posted {
  const message: Posted["message"] = { id, content: "", embeds: [], components: [] };
  const apply = (p: Payload) =>
    Object.assign(
      message,
      p.content === undefined ? {} : { content: p.content },
      p.embeds ? { embeds: p.embeds.map((embed) => Reflect.construct(Embed, [embed.toJSON()]) as Embed) } : {},
      p.components
        ? { components: p.components.map((row) => Reflect.construct(ActionRow, [row.toJSON()]) as ActionRow<never>) }
        : {},
    );
  apply(payload);
  const posted = { message, apply };
  channel.set(id, posted);
  return posted;
}
/**
 * 메시지의 버튼을 누른다. 응답(fetchReply·editReply)은 버튼이 달린 그 메시지를 읽고 고친다.
 * 확인 버튼은 임시 메시지에 달려 있어, 그때 봇은 다이제스트를 채널에서 찾아(messages.fetch) 고친다.
 */
function click(customId: string, on: Posted, userId = "owner") {
  const interaction = {
    user: { id: userId }, customId, message: { id: on.message.id },
    channel: {
      messages: {
        fetch: vi.fn(async ({ message: id }: { message: string; force: boolean }) => {
          const found = channel.get(id);
          if (!found) throw new Error("Unknown Message");
          return { ...found.message, edit: async (payload: Payload) => void found.apply(payload) };
        }),
      },
    },
    reply: vi.fn(), followUp: vi.fn(), deferUpdate: vi.fn(),
    fetchReply: vi.fn(async () => on.message),
    editReply: vi.fn(async (payload: Payload) => void on.apply(payload)),
  };
  return { interaction, press: (handle: (i: ButtonInteraction) => Promise<void>) => handle(interaction as unknown as ButtonInteraction) };
}
/** 다이제스트를 올린다. 줄은 고르기 메뉴, ▶ 줄, (있으면) 위임 줄 순서다. */
async function aDigest(now = kst("08:30"), id = "digest-1") {
  const bot = await boot(now);
  await bot.postDigest();
  const digest = received(id, lastSent());
  return { ...bot, digest, rows: buttons(digest.message.components) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  for (const method of ["log", "warn"] as const) vi.spyOn(console, method).mockImplementation(() => {});
  root = mkdtempSync(join(tmpdir(), "delegations-"));
  mocks.env.WORK_DIR = join(root, "work");
  channel = new Map();
  seedVault(VAULT);
  github();
  mocks.ghPost.mockResolvedValue({ html_url: ISSUE });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("delegationReady", () => {
  it("is ready only when the repo has the workflow file the installer creates", async () => {
    const { delegationReady } = await boot(kst("08:30"));
    mocks.ghJson.mockResolvedValueOnce({ type: "file", name: "claude.yml" });
    expect(await delegationReady("acme/widgets")).toBe(true);
    expect(asked()).toEqual(["/repos/acme/widgets/contents/.github/workflows/claude.yml"]);

    mocks.ghJson.mockResolvedValueOnce(null); // 워크플로가 없다(404). ghJson 은 조회가 실패해도 null 을 준다
    expect(await delegationReady("acme/gadgets")).toBe(false);
    mocks.ghJson.mockResolvedValueOnce([{ type: "file", name: "deploy.yml" }]); // 그 이름이 폴더다
    expect(await delegationReady("acme/gadgets")).toBe(false);
    mocks.ghJson.mockRejectedValueOnce(new Error("github down"));
    expect(await delegationReady("acme/gadgets")).toBe(false);
  });

  it("gives up after three seconds, and still learns from an answer that arrives late", async () => {
    const { delegationReady } = await boot(kst("08:30"));
    let answer!: (file: unknown) => void;
    mocks.ghJson.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
    const settled = vi.fn();
    const waiting = delegationReady("acme/widgets").then(settled);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(settled).toHaveBeenCalledWith(false);

    answer({ type: "file", name: "claude.yml" });
    await vi.advanceTimersByTimeAsync(0);
    expect(await delegationReady("acme/widgets")).toBe(true);
    expect(asked(WORKFLOW)).toHaveLength(1); // 다시 묻지 않았다
  });

  it("remembers a ready repo for an hour, and asks again about one that was not ready", async () => {
    github({ ready: ["acme/widgets"] });
    const { delegationReady } = await boot(kst("08:30"));
    expect(await delegationReady("acme/widgets")).toBe(true);
    github(); // 그 사이 워크플로를 지웠다
    vi.setSystemTime(kst("09:29"));
    expect(await delegationReady("acme/widgets")).toBe(true);
    expect(asked(WORKFLOW)).toHaveLength(1);
    vi.setSystemTime(kst("09:30"));
    expect(await delegationReady("acme/widgets")).toBe(false);
    expect(asked(WORKFLOW)).toHaveLength(2);

    // 아니라는 답은 기억하지 않는다. 워크플로를 설치한 직후의 /digest 에 바로 버튼이 나온다.
    expect(await delegationReady("acme/gadgets")).toBe(false);
    github({ ready: ["acme/gadgets"] });
    expect(await delegationReady("acme/gadgets")).toBe(true);
  });
});

describe("morning digest", () => {
  it("adds a delegate button for each start-button candidate whose repo is ready", async () => {
    github({ ready: ["acme/widgets"] });
    const { rows } = await aDigest();

    expect(rows).toHaveLength(3);
    expect(rows[0]![0]!.id).toBe("today:pick:2026-10-12");
    expect(rows[1]!.map((button) => button.label)).toEqual([
      "▶ widgets: 결제 실패 재시도 추가", "▶ gadgets: README 설치 절차 갱신", "▶ widgets: 관리자 화면 정렬 버그",
    ]);
    expect(rows[1]!.every((button) => button.id.startsWith("triage:start:"))).toBe(true);
    expect(rows[2]!.map((button) => button.label)).toEqual([
      "🤖 위임 widgets: 결제 실패 재시도 추가", "🤖 위임 widgets: 관리자 화면 정렬 버그",
    ]);
    expect(rows[2]!.every((button) => /^delegate:file:[0-9a-f]{8}$/.test(button.id))).toBe(true);
    // 후보는 셋이어도 레포마다 한 번만 묻는다.
    expect(asked(WORKFLOW)).toEqual([`/repos/acme/widgets${WORKFLOW}`, `/repos/acme/gadgets${WORKFLOW}`]);
    expect(Object.values(saved())).toEqual([
      { at: kst("08:30"), fullName: "acme/widgets", note: "위젯 가게", text: "결제 실패 재시도 추가" },
      { at: kst("08:30"), fullName: "acme/widgets", note: "위젯 가게", text: "관리자 화면 정렬 버그" },
    ]);
  });

  it("clips a long label like the start buttons, offers a task written twice once, and skips a repo outside GitHub", async () => {
    // 라벨의 77번째 글자에 이모지(서로게이트 쌍)가 걸친다. 반으로 자르면 Discord 가 게시를 거부한다.
    const long = `${"가".repeat(61)}🎯${"나".repeat(40)}`;
    seedVault([
      { note: "Gadgets", slug: "gadgets", tasks: [{ text: long }, { text: long }] },
      { note: "Manual", slug: "manual", tasks: [{ text: "GitHub 밖 레포의 할 일" }] },
    ]);
    github({ ready: ["acme/gadgets"] });
    const { rows } = await aDigest();

    expect(rows[1]!.map((button) => button.label.slice(0, 10))).toEqual(["▶ gadgets:", "▶ gadgets:", "▶ manual: "]);
    expect(rows[2]!.map((button) => button.label)).toEqual([`🤖 위임 gadgets: ${"가".repeat(61)}…`]);
    expect(rows[2]![0]!.label.length).toBeLessThanOrEqual(78);
    expect(asked(WORKFLOW)).toEqual([`/repos/acme/gadgets${WORKFLOW}`]);
  });

  it("has no delegate row when no repo is ready, and still posts when every GitHub call fails", async () => {
    const quiet = await aDigest();
    expect(quiet.rows.map((row) => row.length)).toEqual([1, 3]); // 고르기 메뉴와 ▶ 줄은 그대로다

    mocks.ghJson.mockResolvedValue(null); // 한도 초과·5xx·시간 초과: ghJson 은 null 을 준다
    const down = await boot(kst("08:40"));
    expect(await down.postDigest()).toBe(true);
    expect(buttons(lastSent().components).map((row) => row.length)).toEqual([1, 3]);

    // 준비됐는지 묻는 조회가 던져도 위임 줄만 빠진다.
    mocks.ghJson.mockImplementation(async (path: string) => {
      if (path.endsWith(WORKFLOW)) throw new Error("github down");
      return null;
    });
    expect(await (await boot(kst("08:50"))).postDigest()).toBe(true);
    expect(buttons(lastSent().components).map((row) => row.length)).toEqual([1, 3]);
    // 위임 줄을 만드는 쪽에서 무엇이 터져도 마찬가지다.
    mocks.ghJson.mockImplementation((path: string) => {
      if (path.endsWith(WORKFLOW)) throw new Error("unexpected");
      return Promise.resolve(null);
    });
    expect(await (await boot(kst("09:00"))).postDigest()).toBe(true);
    expect(buttons(lastSent().components).map((row) => row.length)).toEqual([1, 3]);
    expect(mocks.send).toHaveBeenCalledTimes(4);
  });

  it("never offers more than three buttons", async () => {
    github({ ready: ["acme/widgets"] });
    const { delegateRows } = await boot(kst("08:30"));
    const rows = await delegateRows(Array.from({ length: 6 }, (_, i) => ({ slug: "widgets", note: "위젯 가게", text: `할 일 ${i + 1}` })));
    expect(buttons(rows).map((row) => row.map((button) => button.label))).toEqual([
      ["🤖 위임 widgets: 할 일 1", "🤖 위임 widgets: 할 일 2", "🤖 위임 widgets: 할 일 3"],
    ]);
    expect(await delegateRows([])).toEqual([]);
  });

  it("posts without the row after three seconds when the readiness lookup hangs", async () => {
    // 워크플로 조회만 끝내 답하지 않는다.
    mocks.ghJson.mockImplementation((path: string) =>
      path.endsWith(WORKFLOW) ? new Promise(() => {}) : Promise.resolve(path.startsWith("/search") ? { total_count: 0, items: [] } : null),
    );
    const { postDigest } = await boot(kst("08:30"));
    const posting = postDigest();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(mocks.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await posting).toBe(true);
    expect(buttons(lastSent().components).map((row) => row.length)).toEqual([1, 3]);
  });
});

describe("delegate button", () => {
  it("files a private repo's task on the first tap and writes the issue link where the button was", async () => {
    github({ ready: ["acme/widgets", "acme/gadgets"] });
    const { digest, rows, handleButton } = await aDigest();
    const before = snapshot(digest);
    const [first, second, third] = rows[2]!;

    const tap = click(first!.id, digest);
    await tap.press(handleButton);

    expect(mocks.ghPost).toHaveBeenCalledTimes(1);
    expect(mocks.ghPost).toHaveBeenCalledWith("/repos/acme/widgets/issues", {
      title: "결제 실패 재시도 추가",
      body: BODY("결제 실패 재시도 추가", "위젯 가게"),
    });
    // GitHub 을 부르기 전에 응답을 미뤄 둔다(3초 안에 답해야 한다).
    const visibility = mocks.ghJson.mock.calls.findIndex(([path]) => path === "/repos/acme/widgets");
    expect(tap.interaction.deferUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.ghJson.mock.invocationCallOrder[visibility]!,
    );
    // 그 버튼만 빠지고 임베드에 한 줄이 붙는다. 다른 줄과 칸은 그대로다.
    expect(snapshot(digest)).toEqual({
      content: before.content,
      embeds: [{ ...before.embeds[0], fields: [...before.embeds[0]!.fields!, { name: FIELD, value: `🤖 위임함: ${ISSUE}` }] }],
      components: [before.components[0], before.components[1], expect.anything()],
    });
    expect(buttons(digest.message.components)[2]).toEqual([second, third]);
    expect(tap.interaction.reply).not.toHaveBeenCalled();
    expect(tap.interaction.followUp).not.toHaveBeenCalled();

    // 나머지도 올리면 줄이 이어지고, 버튼이 다 빠진 위임 줄은 사라진다.
    mocks.ghPost.mockResolvedValueOnce({ html_url: "https://github.com/acme/gadgets/issues/3" });
    await click(second!.id, digest).press(handleButton);
    mocks.ghPost.mockResolvedValueOnce({ html_url: "https://github.com/acme/widgets/issues/8" });
    await click(third!.id, digest).press(handleButton);
    expect(mocks.ghPost.mock.calls.map(([path]) => path)).toEqual([
      "/repos/acme/widgets/issues", "/repos/acme/gadgets/issues", "/repos/acme/widgets/issues",
    ]);
    expect(snapshot(digest).components).toEqual(before.components.slice(0, 2));
    expect(delegated(digest.message.embeds[0]!)).toEqual([
      `🤖 위임함: ${ISSUE}\n🤖 위임함: https://github.com/acme/gadgets/issues/3\n🤖 위임함: https://github.com/acme/widgets/issues/8`,
    ]);
    expect(fields(digest.message.embeds[0]!).slice(0, -1)).toEqual(before.embeds[0]!.fields);
  });

  it("clips the issue title at 120 characters and keeps the whole task in the body", async () => {
    const long = "긴 할 일 ".repeat(40).trim();
    seedVault([{ note: "위젯 가게", slug: "widgets", tasks: [{ text: long }] }]);
    github({ ready: ["acme/widgets"] });
    const { digest, rows, handleButton } = await aDigest();
    await click(rows[2]![0]!.id, digest).press(handleButton);

    const [, issue] = mocks.ghPost.mock.calls[0] as [string, { title: string; body: string }];
    expect(issue.title).toBe(`${long.slice(0, 119)}…`);
    expect(issue.body).toBe(BODY(long, "위젯 가게"));
  });

  it("asks before publishing to a public repo and files only on the confirm tap", async () => {
    github({ ready: ["acme/widgets"], open: ["acme/widgets"] });
    const { digest, rows, handleButton } = await aDigest();
    const before = snapshot(digest);
    const first = rows[2]![0]!;

    const tap = click(first.id, digest);
    await tap.press(handleButton);
    expect(mocks.ghPost).not.toHaveBeenCalled();
    expect(snapshot(digest)).toEqual(before);
    expect(saved()[first.id.split(":")[2]!]?.issueUrl).toBeUndefined();
    const [warning] = tap.interaction.followUp.mock.calls[0] as [Required<Pick<Payload, "content" | "components">> & { flags: number }];
    expect(warning.flags).toBe(EPHEMERAL);
    expect(warning.content).toContain("**acme/widgets** 는 공개 레포입니다");
    expect(warning.content).toContain("공개 이슈");
    expect(warning.content).toContain("결제 실패 재시도 추가"); // 무엇이 공개되는지 보여 준다
    expect(warning.content).toContain("위젯 가게");
    // 확인 버튼은 임시 메시지에 달린다. 고칠 다이제스트 메시지를 id 로 들고 있다.
    const prompt = received("ephemeral-1", warning);
    const confirm = buttons(prompt.message.components)[0]![0]!;
    expect(confirm).toEqual({ id: `delegate:confirm:${first.id.split(":")[2]}:digest-1`, label: "공개 이슈로 올리기" });

    const confirmed = click(confirm.id, prompt);
    await confirmed.press(handleButton);
    expect(confirmed.interaction.deferUpdate).toHaveBeenCalled();
    expect(mocks.ghPost).toHaveBeenCalledTimes(1);
    expect(mocks.ghPost).toHaveBeenCalledWith("/repos/acme/widgets/issues", {
      title: "결제 실패 재시도 추가",
      body: BODY("결제 실패 재시도 추가", "위젯 가게"),
    });
    expect(asked("/repos/acme/widgets")).toHaveLength(1); // 확인한 뒤에는 공개 여부를 다시 묻지 않는다
    expect(snapshot(prompt)).toEqual({ content: `🤖 위임함: ${ISSUE}`, embeds: [], components: [] });
    expect(snapshot(digest).components).toEqual([before.components[0], before.components[1], expect.anything()]);
    expect(buttons(digest.message.components)[2]).toEqual(rows[2]!.slice(1));
    expect(delegated(digest.message.embeds[0]!)).toEqual([`🤖 위임함: ${ISSUE}`]);

    // 확인 버튼을 또 눌러도 다시 올리지 않는다.
    const twice = click(confirm.id, prompt);
    await twice.press(handleButton);
    expect(twice.interaction.reply).toHaveBeenCalledWith({ content: `이미 위임한 할 일입니다: ${ISSUE}`, flags: EPHEMERAL });
    expect(mocks.ghPost).toHaveBeenCalledTimes(1);
  });

  it("leaves the message alone and says why when GitHub fails, then files on a later tap", async () => {
    github({ ready: ["acme/widgets"] });
    const { digest, rows, handleButton } = await aDigest();
    const before = snapshot(digest);
    const id = rows[2]![0]!.id;

    mocks.ghPost.mockResolvedValueOnce(null); // 권한 없음·5xx·시간 초과: ghPost 는 null 을 준다
    const refused = click(id, digest);
    await refused.press(handleButton);
    expect(refused.interaction.followUp).toHaveBeenCalledWith({
      content: expect.stringContaining("이슈를 올리지 못했습니다"), flags: EPHEMERAL,
    });
    expect(refused.interaction.fetchReply).not.toHaveBeenCalled();
    expect(refused.interaction.editReply).not.toHaveBeenCalled();
    expect(snapshot(digest)).toEqual(before);

    // 공개 레포인지 알아내지 못하면 올리지 않는다(비공개라는 답을 받았을 때만 묻지 않고 올린다).
    mocks.ghJson.mockResolvedValue(null);
    const blind = click(id, digest);
    await blind.press(handleButton);
    expect(blind.interaction.followUp).toHaveBeenCalledWith({
      content: expect.stringContaining("공개 여부를 확인하지 못해"), flags: EPHEMERAL,
    });
    expect(mocks.ghPost).toHaveBeenCalledTimes(1);
    expect(snapshot(digest)).toEqual(before);

    // 주인이 아니면 GitHub 을 부르지도 않는다.
    const stranger = click(id, digest, "someone-else");
    await stranger.press(handleButton);
    expect(stranger.interaction.reply).toHaveBeenCalledWith({ content: "권한 없음", flags: EPHEMERAL });
    expect(stranger.interaction.deferUpdate).not.toHaveBeenCalled();
    expect(mocks.ghPost).toHaveBeenCalledTimes(1);

    github({ ready: ["acme/widgets"] });
    await click(id, digest).press(handleButton);
    expect(mocks.ghPost).toHaveBeenCalledTimes(2);
    expect(delegated(digest.message.embeds[0]!)).toEqual([`🤖 위임함: ${ISSUE}`]);
  });

  it("files once when the button is tapped twice, also from a digest posted again", async () => {
    github({ ready: ["acme/widgets"] });
    let finish!: (issue: unknown) => void;
    mocks.ghPost.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const { digest, rows, handleButton, postDigest } = await aDigest();
    const id = rows[2]![0]!.id;

    // 첫 탭이 올리는 동안의 두 번째 탭.
    const filing = click(id, digest).press(handleButton);
    const impatient = click(id, digest);
    await impatient.press(handleButton);
    expect(impatient.interaction.reply).toHaveBeenCalledWith({ content: expect.stringContaining("처리 중"), flags: EPHEMERAL });
    finish({ html_url: ISSUE });
    await filing;
    expect(mocks.ghPost).toHaveBeenCalledTimes(1);
    expect(delegated(digest.message.embeds[0]!)).toEqual([`🤖 위임함: ${ISSUE}`]);

    // 다이제스트를 다시 올려도 같은 할 일은 같은 버튼이다. 눌러도 올린 이슈의 주소만 답한다.
    await postDigest();
    const again = received("digest-2", lastSent());
    expect(buttons(again.message.components)[2]![0]!.id).toBe(id);
    const late = click(id, again);
    await late.press(handleButton);
    expect(late.interaction.reply).toHaveBeenCalledWith({ content: `이미 위임한 할 일입니다: ${ISSUE}`, flags: EPHEMERAL });
    expect(late.interaction.deferUpdate).not.toHaveBeenCalled();
    expect(mocks.ghPost).toHaveBeenCalledTimes(1);
    expect(saved()[id.split(":")[2]!]).toMatchObject({ text: "결제 실패 재시도 추가", issueUrl: ISSUE });
  });

  it("reuses an open issue that already has the title, as after a POST that timed out but went through", async () => {
    const long = "긴 할 일 ".repeat(40).trim();
    seedVault([{ note: "위젯 가게", slug: "widgets", tasks: [{ text: long, due: "2026-10-13" }, { text: "관리자 화면 정렬 버그" }] }]);
    github({ ready: ["acme/widgets"] });
    const { digest, rows, handleButton } = await aDigest();
    const [first, second] = rows[2]!;

    // 이슈는 올라갔는데 응답을 받지 못했다(시간 초과). 봇은 실패로 알린다.
    mocks.ghPost.mockResolvedValueOnce(null);
    const lost = click(first!.id, digest);
    await lost.press(handleButton);
    expect(lost.interaction.followUp).toHaveBeenCalledWith({
      content: expect.stringContaining("이슈를 올리지 못했습니다"), flags: EPHEMERAL,
    });

    // 다시 누르면 또 올리지 않고 그 이슈를 올린 것으로 적는다. 제목(120자로 자른 것)이 같아야 하고, PR 은 이슈가 아니다.
    github({
      ready: ["acme/widgets"],
      issues: [
        { title: `${long.slice(0, 119)}…`, html_url: "https://github.com/acme/widgets/pull/9", pull_request: {} },
        { title: long, html_url: "https://github.com/acme/widgets/issues/5" },
        { title: `${long.slice(0, 119)}…`, html_url: ISSUE },
      ],
    });
    const again = click(first!.id, digest);
    await again.press(handleButton);
    expect(asked(OPEN_ISSUES)).toEqual([`/repos/acme/widgets${OPEN_ISSUES}`, `/repos/acme/widgets${OPEN_ISSUES}`]);
    expect(mocks.ghPost).toHaveBeenCalledTimes(1);
    expect(saved()[first!.id.split(":")[2]!]?.issueUrl).toBe(ISSUE);
    expect(delegated(digest.message.embeds[0]!)).toEqual([`🤖 위임함: ${ISSUE}`]);
    expect(buttons(digest.message.components)[2]).toEqual([second]);
    expect(again.interaction.followUp).not.toHaveBeenCalled();

    // 제목이 같은 것이 PR 뿐이면 평소대로 올린다.
    github({
      ready: ["acme/widgets"],
      issues: [
        { title: "관리자 화면 정렬 버그", html_url: "https://github.com/acme/widgets/pull/10", pull_request: {} },
        { title: "관리자 화면 정렬 버그 2차", html_url: "https://github.com/acme/widgets/issues/11" },
      ],
    });
    mocks.ghPost.mockResolvedValueOnce({ html_url: "https://github.com/acme/widgets/issues/12" });
    await click(second!.id, digest).press(handleButton);
    expect(mocks.ghPost).toHaveBeenCalledTimes(2);
    expect(mocks.ghPost).toHaveBeenLastCalledWith("/repos/acme/widgets/issues", {
      title: "관리자 화면 정렬 버그", body: BODY("관리자 화면 정렬 버그", "위젯 가게"),
    });
    expect(delegated(digest.message.embeds[0]!)).toEqual([
      `🤖 위임함: ${ISSUE}\n🤖 위임함: https://github.com/acme/widgets/issues/12`,
    ]);
  });

  it("files nothing when it cannot list the repo's open issues", async () => {
    github({ ready: ["acme/widgets"], issues: null }); // 한도 초과·5xx·시간 초과: ghJson 은 null 을 준다
    const { digest, rows, handleButton } = await aDigest();
    const before = snapshot(digest);
    const id = rows[2]![0]!.id;

    const tap = click(id, digest);
    await tap.press(handleButton);
    expect(asked(OPEN_ISSUES)).toEqual([`/repos/acme/widgets${OPEN_ISSUES}`]);
    expect(mocks.ghPost).not.toHaveBeenCalled(); // 이미 올라가 있는지 모르는 채로 올리지 않는다
    expect(tap.interaction.followUp).toHaveBeenCalledWith({
      content: expect.stringContaining("열린 이슈를 확인하지 못해 올리지 않았습니다"), flags: EPHEMERAL,
    });
    expect(snapshot(digest)).toEqual(before);
    expect(saved()[id.split(":")[2]!]?.issueUrl).toBeUndefined();

    // 목록이 다시 읽히고 같은 제목이 없으면 올린다.
    github({ ready: ["acme/widgets"] });
    await click(id, digest).press(handleButton);
    expect(mocks.ghPost).toHaveBeenCalledTimes(1);
    expect(delegated(digest.message.embeds[0]!)).toEqual([`🤖 위임함: ${ISSUE}`]);
  });

  it("tells the issue link privately when the digest message can no longer be edited", async () => {
    github({ ready: ["acme/widgets"], open: ["acme/widgets"] });
    const { digest, rows, handleButton } = await aDigest();
    const [first, second] = rows[2]!;
    const asking = click(first!.id, digest);
    await asking.press(handleButton);
    const prompt = received("ephemeral-1", asking.interaction.followUp.mock.calls[0]![0] as Payload);
    channel.delete("digest-1"); // 확인하기 전에 다이제스트가 지워졌다

    const confirmed = click(buttons(prompt.message.components)[0]![0]!.id, prompt);
    await confirmed.press(handleButton);
    expect(mocks.ghPost).toHaveBeenCalledTimes(1);
    expect(confirmed.interaction.followUp).toHaveBeenCalledWith({
      content: expect.stringContaining(`🤖 위임함: ${ISSUE}`), flags: EPHEMERAL,
    });
    expect(saved()[first!.id.split(":")[2]!]?.issueUrl).toBe(ISSUE); // 이슈는 올라갔다. 다시 눌러도 올리지 않는다

    // 비공개 레포의 첫 탭도 마찬가지다.
    github({ ready: ["acme/widgets"] });
    const tap = click(second!.id, digest);
    tap.interaction.fetchReply.mockRejectedValue(new Error("Unknown Message"));
    await tap.press(handleButton);
    expect(mocks.ghPost).toHaveBeenCalledTimes(2);
    expect(tap.interaction.followUp).toHaveBeenCalledWith({
      content: expect.stringContaining(`🤖 위임함: ${ISSUE}`), flags: EPHEMERAL,
    });
  });

  it("keeps the button working across a restart, and expires it after seven days", async () => {
    github({ ready: ["acme/widgets"] });
    const { digest, rows } = await aDigest(kst("08:30"));
    const [first, second] = rows[2]!;

    // 재시작: 메모리의 상태는 사라지고 /data/delegations.json 만 남는다. 읽을 수 없는 항목이 섞여도 버튼은 산다.
    writeFileSync(join(root, "delegations.json"), JSON.stringify({ ...saved(), broken: null }));
    const evening = await boot(kst("20:00"));
    await click(first!.id, digest).press(evening.handleButton);
    expect(mocks.ghPost).toHaveBeenCalledTimes(1);
    expect(delegated(digest.message.embeds[0]!)).toEqual([`🤖 위임함: ${ISSUE}`]);

    // 올렸다는 기록도 재시작을 넘긴다.
    const again = click(first!.id, digest);
    await again.press((await boot(kst("21:00"))).handleButton);
    expect(again.interaction.reply).toHaveBeenCalledWith({ content: `이미 위임한 할 일입니다: ${ISSUE}`, flags: EPHEMERAL });

    // 딱 7일까지는 살아 있고, 그 뒤에는 올리지 않는다.
    const week = await boot(kst("08:30", "2026-10-19"));
    await click(second!.id, digest).press(week.handleButton);
    expect(mocks.ghPost).toHaveBeenCalledTimes(2);
    vi.setSystemTime(kst("08:31", "2026-10-19"));
    const expired = click(first!.id, digest);
    await expired.press(week.handleButton);
    expect(expired.interaction.reply).toHaveBeenCalledWith({ content: expect.stringContaining("만료"), flags: EPHEMERAL });
    expect(mocks.ghPost).toHaveBeenCalledTimes(2);

    // 지난 후보는 다음에 쓸 때 파일에서도 빠진다.
    seedVault([{ note: "Gadgets", slug: "gadgets", tasks: [{ text: "새 할 일" }] }]);
    github({ ready: ["acme/gadgets"] });
    await (await boot(kst("08:31", "2026-10-19"))).postDigest();
    expect(Object.values(saved()).map((task) => task.text)).toEqual(["새 할 일"]);
  });
});
