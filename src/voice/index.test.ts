import {
  ButtonStyle,
  Collection,
  MessageFlags,
  MessageFlagsBitField,
  type ActionRowBuilder,
  type ButtonBuilder,
  type ButtonInteraction,
  type EmbedBuilder,
  type Message,
} from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projects } from "../projects.js";

const mocks = vi.hoisted(() => ({
  env: {
    WORK_DIR: "", OWNER_DISCORD_ID: "owner", INBOX_CHANNEL_ID: "", GEMINI_API_KEY: "", VOICE_MODEL: "",
    DIGEST_TIME: "08:30", CHECKIN_TIME: "21:30", DAILY_LOG_TIME: "00:40", DAILY_LOG_OWNERS: [] as string[], VAULT_REPO_URL: "",
  },
  fetch: vi.fn(), capture: vi.fn(), sentry: vi.fn(),
}));
vi.mock("../env.js", () => ({ env: mocks.env }));
// 볼트 쓰기만 가짜다. 프로젝트 → 노트 이름 규칙(noteNameForProject)은 실제 구현을 쓴다.
vi.mock("../vault/mutations.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../vault/mutations.js")>()),
  applyVaultCapture: mocks.capture,
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));
vi.mock("../observability/sentry.js", () => ({ captureException: mocks.sentry }));
// handleButton 이 함께 끌어오는 다른 버튼 처리기들. 여기서는 음성 캡처 경로만 본다.
vi.mock("../content/index.js", () => ({ contentButton: vi.fn() }));
vi.mock("../agent/permissions.js", () => ({ resolvePending: vi.fn() }));
vi.mock("../agent/bootstrap.js", () => ({ spawnSessionThread: vi.fn() }));
vi.mock("../webhook/instagram-handler.js", () => ({
  ACK_BUTTON_ID: "igack", OPS_BUTTON_ID: "igops", acknowledgeProblem: vi.fn(), requestProblemAction: vi.fn(),
}));
vi.mock("../jp/cards.js", () => ({ dueCards: vi.fn(), gradeCard: vi.fn() }));
// 볼트 스냅샷(vault-state.json)과 대기 중인 캡처(voice-captures.json)는 실제 구현이 임시 /data 를 읽고 쓴다.

type File = { contentType: string | null; size: number; duration: number | null; url: string };
type Reply = {
  content?: string;
  embeds?: EmbedBuilder[];
  components?: Array<ActionRowBuilder<ButtonBuilder>>;
  allowedMentions?: unknown;
};
type Answer = { transcript?: unknown; kind?: unknown; project?: unknown; text?: unknown };
type Hub = { note: string; slug?: string; tasks: Array<{ text: string }> };

const EPHEMERAL = 64; // MessageFlags.Ephemeral
const MB = 1024 * 1024;
const AUDIO_URL = "https://cdn.discordapp.test/attachments/11/22/voice-message.ogg";
const AUDIO = new Uint8Array([79, 103, 103, 83, 0, 2, 7, 9]);
const GEMINI = "https://generativelanguage.googleapis.com/v1beta/models/gemini-test-model:generateContent";
const SAID = "음 그러니까 엘브이티아이 결과 화면에 공유 버튼을 달아야 돼";
const ANSWER = { transcript: SAID, kind: "task", project: "lvti", text: "LVTI 결과 화면에 공유 버튼 달기" };
const WRITTEN = { changed: true, path: "프로젝트/lvti.md", summary: "할 일을 프로젝트/lvti.md에 추가했습니다.", commit: "abc1234" };
let root: string;

/** 봇을 (다시) 띄운다: 메모리 상태는 사라지고 /data 의 파일만 남는다. */
async function boot() {
  vi.resetModules();
  const [voice, button] = await Promise.all([import("./index.js"), import("../handlers/button.js")]);
  return { handleVoiceMessage: voice.handleVoiceMessage, handleButton: button.handleButton };
}
const ogg = (file: Partial<File> = {}): File => ({ contentType: "audio/ogg", size: 48_000, duration: 7.4, url: AUDIO_URL, ...file });
/** 인박스 채널에 주인이 꾹 눌러 녹음해 보낸 음성 메시지. over 로 한 가지씩 바꾼다. */
function voiceMessage(
  over: { id?: string; channelId?: string; authorId?: string; bot?: boolean; voice?: boolean; files?: File[] } = {},
) {
  const message = {
    id: over.id ?? "9001",
    channelId: over.channelId ?? "inbox",
    author: { id: over.authorId ?? "owner", bot: over.bot ?? false },
    flags: new MessageFlagsBitField(over.voice === false ? 0 : MessageFlags.IsVoiceMessage),
    attachments: new Collection((over.files ?? [ogg()]).map((file, i): [string, File] => [String(i), file])),
    channel: { sendTyping: vi.fn(async () => undefined) },
    reply: vi.fn(async (payload: Reply) => payload),
    // 음성 메시지 자체를 건드리는 길. 어느 경우에도 불리지 않아야 한다.
    delete: vi.fn(), edit: vi.fn(), react: vi.fn(),
  };
  return {
    message,
    send: (handle: (m: Message) => Promise<boolean>) => handle(message as unknown as Message),
    replies: () => message.reply.mock.calls.map(([payload]) => payload),
    untouched: () => [message.delete, message.edit, message.react].every((fn) => fn.mock.calls.length === 0),
  };
}
/** Gemini 의 응답: 답(객체면 JSON 으로)을 후보의 글로 싣는다. */
const gemini = (answer: Answer | string, init?: ResponseInit) =>
  new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text: typeof answer === "string" ? answer : JSON.stringify(answer) }] } }] }),
    init,
  );
/** 음성 주소에는 파일을, 그 밖의 주소(Gemini)에는 respond 의 응답을 준다. */
function serve(respond: () => Response | Promise<Response> = () => gemini(ANSWER)) {
  mocks.fetch.mockImplementation(async (url: string) => (url === AUDIO_URL ? new Response(AUDIO) : respond()));
}
const geminiCalls = () => mocks.fetch.mock.calls.filter(([url]) => url !== AUDIO_URL) as Array<[string, RequestInit]>;
const sentBody = () =>
  JSON.parse(String(geminiCalls()[0]![1].body)) as {
    contents: Array<{ parts: [{ text: string }, { inline_data: { mime_type: string; data: string } }] }>;
    generationConfig: { responseMimeType: string; responseSchema: { properties: Record<string, { enum?: string[]; nullable?: boolean }>; required: string[] } };
  };
function seedVault(notes: Hub[]) {
  writeFileSync(
    join(root, "vault-state.json"),
    JSON.stringify({ generatedAt: "2026-10-12T00:00:00Z", notes: notes.map((n) => ({ deadlines: [], ...n })) }),
  );
}
const saved = <T>(name: string) => JSON.parse(readFileSync(join(root, name), "utf8")) as T;
const pending = () => (existsSync(join(root, "voice-captures.json")) ? Object.keys(saved<object>("voice-captures.json")) : []);
const embed = (reply: Reply) => reply.embeds![0]!.toJSON();
const field = (reply: Reply, name: string) => embed(reply).fields?.find((f) => f.name === name)?.value;
const buttons = (reply: Reply) =>
  (reply.components ?? []).flatMap((row) =>
    (row.toJSON().components as Array<{ custom_id: string; label: string; style: number }>).map(
      ({ custom_id, label, style }) => ({ id: custom_id, label, style }),
    ),
  );
/** 제안 답장의 버튼을 누른다. 응답(editReply)은 그 답장에 반영된다: 싣지 않은 것(버튼 등)은 그대로 남는다. */
function click(customId: string, shown: Reply, userId = "owner") {
  const interaction = {
    user: { id: userId }, customId,
    reply: vi.fn(), deferUpdate: vi.fn(),
    editReply: vi.fn(async (payload: Reply) => void Object.assign(shown, payload)),
  };
  return { interaction, press: (handle: (i: ButtonInteraction) => Promise<void>) => handle(interaction as unknown as ButtonInteraction) };
}
/** 음성 메시지 하나를 보내 제안 답장까지 받은 상태. */
async function proposed(answer: Answer = ANSWER, id = "9001") {
  serve(() => gemini(answer));
  const bot = await boot();
  const voice = voiceMessage({ id });
  await voice.send(bot.handleVoiceMessage);
  return { ...bot, shown: voice.replies()[0]! };
}

beforeEach(() => {
  vi.clearAllMocks();
  // 만료만 시계를 본다. 타이머는 실제 것을 쓴다.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2026-10-12T09:00:00+09:00"));
  for (const method of ["log", "warn"] as const) vi.spyOn(console, method).mockImplementation(() => {});
  vi.stubGlobal("fetch", mocks.fetch);
  root = mkdtempSync(join(tmpdir(), "voice-capture-"));
  Object.assign(mocks.env, {
    WORK_DIR: join(root, "work"), INBOX_CHANNEL_ID: "inbox", GEMINI_API_KEY: "test-key", VOICE_MODEL: "gemini-test-model",
  });
  serve();
  mocks.capture.mockResolvedValue(WRITTEN);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("which messages start a voice capture", () => {
  it("proposes a capture for a voice message in the inbox channel and writes nothing to the vault", async () => {
    const { handleVoiceMessage } = await boot();
    const voice = voiceMessage();
    expect(await voice.send(handleVoiceMessage)).toBe(true);

    const [reply, ...more] = voice.replies();
    expect(more).toEqual([]);
    expect(embed(reply!).description).toBe(`> ${SAID}`);
    expect(field(reply!, "제안")).toBe("LVTI 결과 화면에 공유 버튼 달기");
    expect(field(reply!, "프로젝트")).toBe("lvti");
    expect(field(reply!, "결과")).toBeUndefined();
    // 한 줄에 세 버튼, 모델이 제안한 종류(할 일)만 강조한다.
    expect(reply!.components).toHaveLength(1);
    expect(buttons(reply!)).toEqual([
      { id: "voice:task:9001", label: "✅ 할 일", style: ButtonStyle.Primary },
      { id: "voice:idea:9001", label: "💡 아이디어", style: ButtonStyle.Secondary },
      { id: "voice:drop:9001", label: "✖ 버림", style: ButtonStyle.Secondary },
    ]);
    // 답장은 보낸 사람에게만 알린다.
    expect(reply!.allowedMentions).toEqual({ parse: [], repliedUser: true });
    // 누르기 전에는 볼트에 쓰지 않고, 음성 메시지는 그대로다.
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(existsSync(join(root, "vault-state.json"))).toBe(false);
    expect(voice.untouched()).toBe(true);
    expect(pending()).toEqual(["9001"]);
  });

  it("also takes an uploaded audio file that is not a voice message, and highlights an idea", async () => {
    serve(() => gemini({ ...ANSWER, kind: "idea", project: null }));
    const { handleVoiceMessage } = await boot();
    const voice = voiceMessage({
      voice: false,
      files: [{ contentType: "image/png", size: 900, duration: null, url: "https://cdn.discordapp.test/a.png" }, ogg({ contentType: "audio/mpeg", duration: null })],
    });
    expect(await voice.send(handleVoiceMessage)).toBe(true);

    // 길이를 모르는 파일은 크기만 본다. 오디오 첨부만 내려받아 그 종류 그대로 보낸다.
    expect(mocks.fetch.mock.calls.map(([url]) => url)).toEqual([AUDIO_URL, GEMINI]);
    expect(sentBody().contents[0]!.parts[1].inline_data.mime_type).toBe("audio/mpeg");
    const reply = voice.replies()[0]!;
    expect(buttons(reply).map(({ label, style }) => `${label}:${style}`)).toEqual([
      `✅ 할 일:${ButtonStyle.Secondary}`, `💡 아이디어:${ButtonStyle.Primary}`, `✖ 버림:${ButtonStyle.Secondary}`,
    ]);
    expect(field(reply, "프로젝트")).toBe("미지정 (할 일은 todari-ops 노트로)");
  });

  it("reads the answer past a thought summary and across split parts", async () => {
    const answer = JSON.stringify(ANSWER);
    serve(() => new Response(JSON.stringify({
      candidates: [{ content: { parts: [
        { text: "먼저 음성을 받아쓴다…", thought: true }, { text: answer.slice(0, 20) }, { text: answer.slice(20) },
      ] } }],
    })));
    const { handleVoiceMessage } = await boot();
    const voice = voiceMessage();
    await voice.send(handleVoiceMessage);
    expect(field(voice.replies()[0]!, "제안")).toBe("LVTI 결과 화면에 공유 버튼 달기");
  });

  it("takes a voice message whose attachment has no content type as Ogg", async () => {
    const { handleVoiceMessage } = await boot();
    const voice = voiceMessage({ files: [ogg({ contentType: null })] });
    expect(await voice.send(handleVoiceMessage)).toBe(true);
    expect(sentBody().contents[0]!.parts[1].inline_data.mime_type).toBe("audio/ogg");
  });

  it.each([
    ["another channel", { channelId: "general" }],
    ["a thread of the inbox channel", { channelId: "inbox-thread" }],
    ["another author", { authorId: "someone-else" }],
    ["a bot", { bot: true }],
    ["a picture", { voice: false, files: [{ contentType: "image/png", size: 900, duration: null, url: "https://cdn.discordapp.test/a.png" }] }],
    ["a video", { voice: false, files: [{ contentType: "video/mp4", size: 900, duration: 3, url: "https://cdn.discordapp.test/a.mp4" }] }],
    ["plain text", { voice: false, files: [] }],
  ])("ignores %s", async (_what, over) => {
    const { handleVoiceMessage } = await boot();
    const voice = voiceMessage(over);
    expect(await voice.send(handleVoiceMessage)).toBe(false);
    expect(voice.replies()).toEqual([]);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(pending()).toEqual([]);
  });

  it("ignores voice messages when no inbox channel is configured", async () => {
    mocks.env.INBOX_CHANNEL_ID = "";
    const { handleVoiceMessage } = await boot();
    const voice = voiceMessage({ channelId: "" });
    expect(await voice.send(handleVoiceMessage)).toBe(false);
    expect(voice.replies()).toEqual([]);
  });
});

describe("when voice capture cannot run", () => {
  it("says once that it is off until GEMINI_API_KEY is set, and does nothing else", async () => {
    mocks.env.GEMINI_API_KEY = "";
    const { handleVoiceMessage } = await boot();
    const voice = voiceMessage();
    expect(await voice.send(handleVoiceMessage)).toBe(true);

    expect(voice.replies()).toHaveLength(1);
    expect(voice.replies()[0]!.content).toBe("🎙️ 음성 캡처는 꺼져 있습니다 — `GEMINI_API_KEY` 를 설정하면 켜집니다.");
    expect(voice.replies()[0]!.components).toBeUndefined();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(pending()).toEqual([]);
    expect(voice.untouched()).toBe(true);
  });

  it.each([
    ["larger than 10 MB", ogg({ size: 10 * MB + 1 }), "10.0MB"],
    ["much larger than 10 MB", ogg({ size: 23.4 * MB, duration: null }), "23.4MB"],
    ["longer than 5 minutes", ogg({ duration: 301.2 }), "5분 1초"],
  ])("answers with one short line when the audio is %s", async (_what, file, shown) => {
    const { handleVoiceMessage } = await boot();
    const voice = voiceMessage({ files: [file] });
    expect(await voice.send(handleVoiceMessage)).toBe(true);

    expect(voice.replies()).toHaveLength(1);
    expect(voice.replies()[0]!.content).toBe(`🎙️ 음성이 한도를 넘었습니다 (${shown}) — 5분·10MB 까지 받습니다. 나눠서 보내 주세요.`);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(pending()).toEqual([]);
  });

  it("accepts audio exactly at the limits", async () => {
    const { handleVoiceMessage } = await boot();
    const voice = voiceMessage({ files: [ogg({ size: 10 * MB, duration: 300 })] });
    await voice.send(handleVoiceMessage);
    expect(voice.replies()[0]!.embeds).toHaveLength(1);
  });

  it.each([
    ["an HTTP error", () => new Response(JSON.stringify({ error: { message: "models/gemini-test-model is not found." } }), { status: 404 }), "Gemini HTTP 404: models/gemini-test-model is not found"],
    ["an HTTP error without a body", () => new Response("upstream down", { status: 503 }), "Gemini HTTP 503"],
    ["text that is not JSON", () => gemini("죄송하지만 들리지 않습니다"), "Gemini 응답 형식 오류"],
    ["JSON of another shape", () => gemini('["task"]'), "Gemini 응답 형식 오류"],
    ["an unknown kind", () => gemini({ ...ANSWER, kind: "note" }), "Gemini 응답 형식 오류"],
    ["no candidate", () => new Response(JSON.stringify({ promptFeedback: { blockReason: "OTHER" } })), "Gemini 응답 형식 오류"],
    ["a timeout", () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")), "45초 안에 끝나지 않음"],
    ["a network failure", () => Promise.reject(new TypeError("fetch failed")), "fetch failed"],
  ])("answers with one short line when Gemini returns %s", async (_what, respond, reason) => {
    serve(respond);
    const { handleVoiceMessage } = await boot();
    const voice = voiceMessage();
    expect(await voice.send(handleVoiceMessage)).toBe(true);

    expect(voice.replies()).toHaveLength(1);
    const reply = voice.replies()[0]!;
    expect(reply.content).toBe(`⚠️ 받아쓰지 못했습니다 — ${reason}. 음성 메시지는 그대로 있으니 다시 보내 주세요.`);
    expect(reply.content).not.toContain("\n"); // 스택이 아니라 한 줄
    expect(reply.embeds).toBeUndefined();
    expect(reply.components).toBeUndefined();
    expect(mocks.sentry).toHaveBeenCalledTimes(1);
    expect(pending()).toEqual([]);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(voice.untouched()).toBe(true);
  });

  it.each([
    ["an empty transcript", { ...ANSWER, transcript: " ", text: "" }],
    ["no sentence to record", { transcript: SAID, kind: "task", project: null }],
  ])("says that nothing was heard when Gemini returns %s, without raising an alarm", async (_what, answer) => {
    serve(() => gemini(answer));
    const { handleVoiceMessage } = await boot();
    const voice = voiceMessage();
    expect(await voice.send(handleVoiceMessage)).toBe(true);

    expect(voice.replies().map((r) => r.content)).toEqual(["🎙️ 알아들은 말이 없습니다 — 다시 말해 주세요."]);
    expect(mocks.sentry).not.toHaveBeenCalled();
    expect(pending()).toEqual([]);
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("reports a response that stops arriving as a timeout, not as a malformed answer", async () => {
    const timedOut = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    // 45초가 다 된 신호: 머리말은 왔지만 본문을 읽다가 끊긴다.
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort(timedOut));
    serve(() => Object.assign(gemini(ANSWER), { json: () => Promise.reject(timedOut) }));
    const { handleVoiceMessage } = await boot();
    const voice = voiceMessage();
    await voice.send(handleVoiceMessage);
    expect(timeout.mock.calls).toEqual([[45_000]]);
    expect(voice.replies().map((r) => r.content)).toEqual([
      "⚠️ 받아쓰지 못했습니다 — 45초 안에 끝나지 않음. 음성 메시지는 그대로 있으니 다시 보내 주세요.",
    ]);
  });

  it("answers with one short line when the audio cannot be downloaded, without calling Gemini", async () => {
    mocks.fetch.mockImplementation(async () => new Response("gone", { status: 404 }));
    const { handleVoiceMessage } = await boot();
    const voice = voiceMessage();
    await voice.send(handleVoiceMessage);
    expect(voice.replies().map((r) => r.content)).toEqual([
      "⚠️ 받아쓰지 못했습니다 — 음성 내려받기 HTTP 404. 음성 메시지는 그대로 있으니 다시 보내 주세요.",
    ]);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("what is sent to Gemini", () => {
  it("posts the audio inline with the key in a header and asks for the capture as JSON", async () => {
    seedVault([
      { note: "독서 노트", slug: "독서 노트", tasks: [{ text: "밖으로 나가면 안 되는 할 일 문장" }] },
      { note: "이정표", slug: "jeongpyo", tasks: [{ text: "다른 할 일" }] },
      { note: "연애 테스트", slug: "lvti", tasks: [{ text: "또 다른 할 일" }] },
    ]);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const { handleVoiceMessage } = await boot();
    await voiceMessage({ files: [ogg({ contentType: "audio/ogg; codecs=opus" })] }).send(handleVoiceMessage);

    expect(geminiCalls()).toHaveLength(1);
    const [url, init] = geminiCalls()[0]!;
    expect(url).toBe(GEMINI); // 모델은 주소에, 키는 주소가 아니라 헤더에
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json", "x-goog-api-key": "test-key" });
    // 음성 내려받기와 Gemini 호출이 45초짜리 신호 하나를 함께 쓴다.
    expect(timeout.mock.calls).toEqual([[45_000]]);
    expect(mocks.fetch.mock.calls.map(([, options]) => options.signal === timeout.mock.results[0]!.value)).toEqual([true, true]);
    expect(String(init.body)).not.toContain("test-key");

    const body = sentBody();
    expect(body.contents).toHaveLength(1);
    const [prompt, audio] = body.contents[0]!.parts;
    expect(audio).toEqual({ inline_data: { mime_type: "audio/ogg", data: Buffer.from(AUDIO).toString("base64") } });
    // 고를 이름: 카탈로그 slug(부르는 이름·허브 노트 이름과 함께)와 카탈로그에 없는 허브 노트.
    // 같은 노트를 두 이름으로 싣지 않는다.
    const listed = prompt.text.split("\n").at(-1)!.replace(/^[^:]+: /, "").split(", ");
    expect(listed.map((entry) => entry.split("(")[0])).toEqual([...projects.map((p) => p.slug), "독서 노트"]);
    expect(listed).toContain("lvti(LVTI/lovetype/연애유형/연애 테스트)");
    expect(listed).toContain("jeongpyo(이정표/basetie)");
    // 볼트의 내용은 보내지 않는다.
    expect(String(init.body)).not.toContain("밖으로 나가면 안 되는 할 일 문장");

    expect(body.generationConfig.responseMimeType).toBe("application/json");
    const schema = body.generationConfig.responseSchema;
    expect(Object.keys(schema.properties)).toEqual(["transcript", "kind", "project", "text"]);
    expect(schema.properties.kind!.enum).toEqual(["task", "idea"]);
    expect(schema.properties.project!.nullable).toBe(true);
    expect(schema.required).toEqual(["transcript", "kind", "text"]);
  });
});

describe("the three buttons", () => {
  it("✅ 할 일 records the proposed sentence as a task and shows where it went", async () => {
    const { handleButton, shown } = await proposed();
    const { interaction, press } = click("voice:task:9001", shown);
    await press(handleButton);

    expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.capture.mock.calls).toEqual([["task", "lvti", "LVTI 결과 화면에 공유 버튼 달기"]]);
    expect(field(shown, "제안")).toBe("LVTI 결과 화면에 공유 버튼 달기");
    expect(field(shown, "결과")).toBe("✅ 할 일을 프로젝트/lvti.md에 추가했습니다.");
    expect(shown.components).toEqual([]);
    expect(interaction.reply).not.toHaveBeenCalled();
    // /task 처럼 봇의 스냅샷에도 바로 실린다.
    const state = saved<{ notes: Array<{ note: string; slug: string; tasks: Array<{ text: string }> }> }>("vault-state.json");
    expect(state.notes).toEqual([{ note: "lvti", slug: "lvti", tasks: [{ text: "LVTI 결과 화면에 공유 버튼 달기" }], deadlines: [] }]);
  });

  it("💡 아이디어 records it as an idea even when a task was proposed", async () => {
    mocks.capture.mockResolvedValue({ changed: true, path: "창/아이디어 인박스.md", summary: "아이디어를 창/아이디어 인박스.md에 추가했습니다." });
    const { handleButton, shown } = await proposed();
    await click("voice:idea:9001", shown).press(handleButton);

    expect(mocks.capture.mock.calls).toEqual([["idea", "lvti", "LVTI 결과 화면에 공유 버튼 달기"]]);
    expect(field(shown, "결과")).toBe("✅ 아이디어를 창/아이디어 인박스.md에 추가했습니다.");
    expect(shown.components).toEqual([]);
    expect(existsSync(join(root, "vault-state.json"))).toBe(false); // 아이디어는 할 일 스냅샷에 싣지 않는다
  });

  it("✖ 버림 discards it without touching the vault", async () => {
    const { handleButton, shown } = await proposed();
    const { interaction, press } = click("voice:drop:9001", shown);
    await press(handleButton);

    expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(field(shown, "결과")).toBe("✖ 버렸습니다 — 볼트에 쓰지 않았습니다.");
    expect(shown.components).toEqual([]);
  });

  it("says so when the vault already has the same line", async () => {
    mocks.capture.mockResolvedValue({ changed: false, path: "프로젝트/lvti.md", summary: "이미 같은 할 일이 있습니다." });
    const { handleButton, shown } = await proposed();
    await click("voice:task:9001", shown).press(handleButton);
    expect(field(shown, "결과")).toBe("ℹ️ 이미 같은 할 일이 있습니다.");
    expect(shown.components).toEqual([]);
  });

  it("shows the reason and keeps the buttons when the vault write fails, so the next tap can succeed", async () => {
    mocks.capture.mockRejectedValueOnce(
      new Error("vault push conflict: git push exited 1: fatal: unable to access 'https://x-access-token:made-up-credential@github.test/vault.git/'"),
    );
    const { handleButton, shown } = await proposed();
    const failed = click("voice:task:9001", shown);
    await failed.press(handleButton);

    expect(failed.interaction.editReply.mock.calls[0]![0]).not.toHaveProperty("components");
    expect(buttons(shown).map(({ id }) => id)).toEqual(["voice:task:9001", "voice:idea:9001", "voice:drop:9001"]);
    expect(field(shown, "결과")).toMatch(/^⚠️ 기록하지 못했습니다 — vault push conflict: git push exited 1: .*\. 다시 눌러 주세요\.$/);
    expect(field(shown, "결과")).not.toContain("made-up-credential");

    await click("voice:task:9001", shown).press(handleButton);
    expect(mocks.capture).toHaveBeenCalledTimes(2);
    expect(field(shown, "결과")).toBe("✅ 할 일을 프로젝트/lvti.md에 추가했습니다.");
    expect(shown.components).toEqual([]);
  });

  it.each([
    // 모델이 고른 이름 → applyVaultCapture 에 넘기는 값, 제안에 보이는 노트 이름
    ["jeongpyo", "jeongpyo", "이정표"], // 프로젝트/ 밖의 허브는 slug 로만 닿는다
    ["독서 노트", "독서 노트", "독서 노트"], // 카탈로그에 없는 허브는 노트 이름 그대로
    ["haengdong", "행동대장", "행동대장"], // 허브의 노트 이름이 slug 와 다르면 노트 이름으로
    ["toksai", "톡사이", "톡사이"], // 스냅샷의 slug 가 낯설어도 노트 이름으로 카탈로그 프로젝트를 찾는다
    ["dakbal", "dakbal", "dakbal"], // 스냅샷에 허브가 없는 카탈로그 프로젝트는 /task 처럼 slug
    ["이정표", "jeongpyo", "이정표"], // slug 대신 부르는 이름으로 답해도 같은 곳으로
    ["없는 프로젝트", undefined, "미지정 (할 일은 todari-ops 노트로)"], // 싣지 않은 이름은 받지 않는다
    [null, undefined, "미지정 (할 일은 todari-ops 노트로)"],
  ])("passes the project %s to the vault as %s", async (answered, passed, shownProject) => {
    seedVault([
      { note: "독서 노트", slug: "독서 노트", tasks: [{ text: "가" }] },
      { note: "이정표", slug: "jeongpyo", tasks: [{ text: "나" }] },
      { note: "행동대장", slug: "2024-haeng-dong", tasks: [{ text: "다" }] },
      { note: "톡사이", slug: "chat-insight", tasks: [{ text: "라" }] },
    ]);
    const { handleButton, shown } = await proposed({ ...ANSWER, project: answered });
    expect(field(shown, "프로젝트")).toBe(shownProject);
    await click("voice:task:9001", shown).press(handleButton);
    expect(mocks.capture.mock.calls).toEqual([["task", passed, "LVTI 결과 화면에 공유 버튼 달기"]]);
  });

  it("refuses anyone but the owner", async () => {
    const { handleButton, shown } = await proposed();
    const { interaction, press } = click("voice:task:9001", shown, "someone-else");
    await press(handleButton);
    expect(interaction.reply).toHaveBeenCalledWith({ content: "권한 없음", flags: EPHEMERAL });
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(buttons(shown)).toHaveLength(3);
  });
});

describe("pending captures", () => {
  it("still answers the buttons after the bot restarts", async () => {
    const { shown } = await proposed();
    const restarted = await boot();
    await click("voice:task:9001", shown).press(restarted.handleButton);
    expect(mocks.capture.mock.calls).toEqual([["task", "lvti", "LVTI 결과 화면에 공유 버튼 달기"]]);
    expect(field(shown, "결과")).toBe("✅ 할 일을 프로젝트/lvti.md에 추가했습니다.");
    expect(shown.components).toEqual([]);
  });

  it("answers a second tap privately: while the first is being written, afterwards, and after a restart", async () => {
    let finish!: (result: typeof WRITTEN) => void;
    mocks.capture.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const { handleButton, shown } = await proposed();
    const first = click("voice:task:9001", shown);
    const writing = first.press(handleButton);

    // 볼트에 쓰는 사이 다른 버튼을 눌러도 두 번 기록하지 않는다.
    const during = click("voice:idea:9001", shown);
    await during.press(handleButton);
    expect(during.interaction.reply).toHaveBeenCalledWith({ content: "이 음성 캡처를 처리하는 중입니다", flags: EPHEMERAL });
    expect(during.interaction.deferUpdate).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(mocks.capture).toHaveBeenCalledTimes(1));
    finish(WRITTEN);
    await writing;
    expect(shown.components).toEqual([]);

    const already = { content: "이미 처리한 음성 캡처입니다 — ✅ 할 일을 프로젝트/lvti.md에 추가했습니다.", flags: EPHEMERAL };
    const after = click("voice:drop:9001", shown);
    await after.press(handleButton);
    expect(after.interaction.reply).toHaveBeenCalledWith(already);

    const restarted = await boot();
    const later = click("voice:task:9001", shown);
    await later.press(restarted.handleButton);
    expect(later.interaction.reply).toHaveBeenCalledWith(already);
    expect(later.interaction.editReply).not.toHaveBeenCalled();
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    expect(field(shown, "결과")).toBe("✅ 할 일을 프로젝트/lvti.md에 추가했습니다.");
  });

  it("forgets a capture after 7 days, and its buttons say it expired", async () => {
    const { shown } = await proposed();
    vi.setSystemTime(Date.now() + 6 * 86_400_000);
    await proposed({ ...ANSWER, text: "엿새 뒤의 다른 메모" }, "9002");
    expect(pending()).toEqual(["9001", "9002"]);

    vi.setSystemTime(Date.now() + 86_400_000 + 60_000);
    const { handleButton } = await proposed({ ...ANSWER, text: "이레 뒤의 또 다른 메모" }, "9003");
    expect(pending()).toEqual(["9002", "9003"]);

    const { interaction, press } = click("voice:task:9001", shown);
    await press(handleButton);
    expect(interaction.reply).toHaveBeenCalledWith({ content: "이 음성 캡처는 만료됨 (7일) — 다시 말해 주세요", flags: EPHEMERAL });
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });
});
