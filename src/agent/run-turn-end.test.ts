import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  query: vi.fn(), session: vi.fn(),
  env: { CLAUDE_MODEL: "", OWNER_DISCORD_ID: "owner" },
  thread: { isThread: () => true, send: vi.fn() },
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: mocks.query }));
vi.mock("../env.js", () => ({ env: mocks.env }));
vi.mock("../storage/sessions.js", () => ({ getSession: mocks.session, updateSessionId: vi.fn(), updateExecutionProfile: vi.fn() }));
vi.mock("../projects.js", () => ({ findProject: () => ({ slug: "demo" }) }));
vi.mock("../workspaces/checkout.js", () => ({ ensureCheckout: async () => "/repo" }));
vi.mock("./permissions.js", () => ({ askPermission: vi.fn() }));
vi.mock("../storage/audit.js", () => ({ logAudit: vi.fn() }));
vi.mock("../discord/client.js", () => ({ getDiscordClient: () => ({ channels: { fetch: async () => mocks.thread } }) }));
vi.mock("../observability/sentry.js", () => ({ captureException: vi.fn() }));
// render.js 는 실제 구현을 쓴다 — 스레드에 실제로 나가는 메시지를 검증한다.
import { cancelActiveTurn, isTurnActive, startTurn } from "./run.js";

const NOW = Date.UTC(2026, 9, 9);
const mention = (line: string) => ({ content: `<@owner> ${line}`, allowedMentions: { users: ["owner"] } });
const result = (subtype = "success") => ({ type: "result", subtype, is_error: subtype !== "success", usage: {}, total_cost_usd: 0 });
/** elapsedMs 가 걸린 뒤 finish 의 결과(또는 예외)로 끝나는 턴을 돌린다. */
function runTurn(elapsedMs: number, finish: () => unknown = result) {
  mocks.query.mockImplementation(async function* () {
    vi.setSystemTime(NOW + elapsedMs);
    yield finish();
  });
  return startTurn({ threadId: "t1", prompt: "필터 추가", isFirstTurn: false });
}
const sent = () => mocks.thread.send.mock.calls.map((call) => call[0]);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "test-only");
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.session.mockResolvedValue({ projectSlug: "demo", permissionMode: "default", sessionId: "old-session" });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each([[60_000, "1분 0초"], [192_000, "3분 12초"]])("mentions the owner when a %ims turn completes", async (elapsedMs, took) => {
  await runTurn(elapsedMs);
  expect(sent()).toEqual([mention(`✅ 작업이 끝났습니다 · ${took}`)]);
});

it("stays silent when the turn took less than a minute", async () => {
  await runTurn(59_999);
  expect(sent()).toEqual([]);
  await runTurn(59_999, () => { throw new Error("boom"); });
  expect(sent()).toEqual(["⚠️ 에러: boom"]);
});

it("does not mention the owner for a turn they cancelled themselves", async () => {
  await runTurn(60_000, () => { void cancelActiveTurn("t1"); throw new Error("aborted"); });
  expect(sent()).toEqual(["🛑 취소됨"]);
});

it.each([
  ["an error", () => { throw new Error("boom\n  at stack"); }, ["⚠️ 에러: boom\n  at stack"], "boom"],
  ["an SDK error result", () => result("error_max_turns"), [], "error_max_turns"],
])("mentions the owner with a one-line reason when a long turn ends in %s", async (_label, finish, existing, reason) => {
  await runTurn(60_000, finish);
  expect(sent()).toEqual([...existing, mention(`⚠️ 작업이 중단됐습니다 · ${reason}`)]);
});

it("releases the turn even if the completion mention cannot be sent", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.thread.send.mockRejectedValueOnce(new Error("discord down"));
  await runTurn(60_000);
  expect(isTurnActive("t1")).toBe(false);
});
