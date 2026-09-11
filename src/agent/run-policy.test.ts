import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  query: vi.fn(), session: vi.fn(), save: vi.fn(), audit: vi.fn(),
  env: { CLAUDE_MODEL: "" },
  thread: { isThread: () => true, send: vi.fn() },
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: mocks.query }));
vi.mock("../env.js", () => ({ env: mocks.env }));
vi.mock("../storage/sessions.js", () => ({ getSession: mocks.session, updateSessionId: vi.fn(), updateExecutionProfile: mocks.save }));
vi.mock("../projects.js", () => ({ findProject: () => ({ slug: "demo" }) }));
vi.mock("../workspaces/checkout.js", () => ({ ensureCheckout: async () => "/repo" }));
vi.mock("./permissions.js", () => ({ askPermission: vi.fn() }));
vi.mock("./render.js", () => ({ renderEvent: vi.fn() }));
vi.mock("../storage/audit.js", () => ({ logAudit: mocks.audit }));
vi.mock("../discord/client.js", () => ({ getDiscordClient: () => ({ channels: { fetch: async () => mocks.thread } }) }));
vi.mock("../observability/sentry.js", () => ({ captureException: vi.fn() }));
import { startTurn } from "./run.js";
afterEach(() => vi.unstubAllEnvs());

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "test-only");
  mocks.env.CLAUDE_MODEL = "";
  mocks.session.mockResolvedValue({ projectSlug: "demo", permissionMode: "default", sessionId: "old-session" });
  mocks.query.mockImplementation(async function* () {
    yield { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 10 }, total_cost_usd: 0 };
  });
});

it("passes automatic model/effort to the SDK while retaining conversation and permissions", async () => {
  await startTurn({ threadId: "test", prompt: "필터 기능 추가", isFirstTurn: false });
  expect(mocks.query.mock.calls[0]![0].options).toMatchObject({ model: "sonnet", effort: "medium", resume: "old-session", permissionMode: "default" });
  expect(mocks.save).toHaveBeenCalledWith("test", expect.objectContaining({ effort: "medium" }));
  expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ tool: "turn:complete", input: expect.objectContaining({ result: expect.objectContaining({ usage: { input_tokens: 10 } }) }) }));
});

it("honors a fixed Haiku without sending an unsupported effort", async () => {
  mocks.env.CLAUDE_MODEL = "haiku";
  await startTurn({ threadId: "test", prompt: "인증 점검", isFirstTurn: false });
  const options = mocks.query.mock.calls[0]![0].options;
  expect(options.model).toBe("haiku");
  expect(options).not.toHaveProperty("effort");
});

it("passes Fable 5.1 and high effort for complex work", async () => {
  await startTurn({ threadId: "test", prompt: "인증 로직 수정", isFirstTurn: false });
  expect(mocks.query.mock.calls[0]![0].options).toMatchObject({ model: "claude-fable-5-1", effort: "high", resume: "old-session" });
});

it("records SDK failure as failure, without automatic paid retries", async () => {
  mocks.query.mockImplementation(async function* () {
    yield { type: "result", subtype: "error_during_execution", is_error: true, usage: {}, total_cost_usd: 0 };
  });
  await startTurn({ threadId: "test", prompt: "필터 추가", isFirstTurn: false });
  expect(mocks.query).toHaveBeenCalledOnce();
  expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ tool: "turn:complete", decision: "failed" }));
});
