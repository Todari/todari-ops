import type { ThreadChannel } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), end: vi.fn(), complete: vi.fn(), snapshot: vi.fn(),
  begin: vi.fn(), release: vi.fn(), summary: vi.fn(), capture: vi.fn(),
}));
vi.mock("../storage/sessions.js", () => ({ getSession: mocks.session, endSession: mocks.end }));
vi.mock("../vault/mutations.js", () => ({ completeVaultTask: mocks.complete }));
vi.mock("../vault/state.js", () => ({ completeCapturedVaultTask: mocks.snapshot }));
vi.mock("../observability/sentry.js", () => ({ captureException: mocks.capture }));
vi.mock("./run.js", () => ({ beginSessionEnd: mocks.begin, releaseSessionEnd: mocks.release }));
vi.mock("./summary.js", () => ({ postSessionSummary: mocks.summary }));
import { closeCodeSession } from "./end-session.js";

const thread = { id: "thread-1" } as ThreadChannel;
const task = { projectSlug: "todari", note: "todari", text: "할 일" };
const session = { threadId: thread.id, projectSlug: "todari", sessionId: "sdk-1", sourceTask: task };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.begin.mockReturnValue("locked");
  mocks.session.mockResolvedValue(session);
  mocks.complete.mockResolvedValue({ changed: true });
  mocks.summary.mockResolvedValue(undefined);
});

describe("explicit session completion", () => {
  it.each([null, "paused", "abandoned"])("keeps tasks open for %s", async (outcome) => {
    const result = await closeCodeSession(thread, outcome);
    expect(result.closed).toBe(true);
    expect(result.message).toContain("원본 할 일은 열린 상태");
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(mocks.end).toHaveBeenCalledWith(thread.id);
    expect(mocks.summary).toHaveBeenCalledWith(thread, session, outcome === "abandoned" ? "중단" : "보류");
    expect(mocks.release).toHaveBeenCalledWith(thread.id);
  });

  it("completes the source before closing a session only when explicitly requested", async () => {
    expect((await closeCodeSession(thread, "completed")).closed).toBe(true);
    expect(mocks.complete).toHaveBeenCalledWith(task);
    expect(mocks.snapshot).toHaveBeenCalledWith(task.note, task.projectSlug, task.text);
    expect(mocks.complete.mock.invocationCallOrder[0]).toBeLessThan(mocks.end.mock.invocationCallOrder[0]);
    expect(mocks.summary).toHaveBeenCalledWith(thread, session, "완료");
  });

  it("preserves the session for retry when the source write fails", async () => {
    mocks.complete.mockRejectedValue(new Error("push failed"));
    const result = await closeCodeSession(thread, "completed");
    expect(result.closed).toBe(false);
    expect(result.message).toContain("세션을 유지");
    expect(mocks.end).not.toHaveBeenCalled();
    expect(mocks.summary).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledWith(thread.id);
  });

  it("does not claim completion if the source checkbox cannot be found", async () => {
    mocks.complete.mockResolvedValue({ changed: false });
    expect((await closeCodeSession(thread, "completed")).closed).toBe(false);
    expect(mocks.end).not.toHaveBeenCalled();
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });

  it("keeps a successful source completion when only the derived snapshot fails", async () => {
    mocks.snapshot.mockRejectedValue(new Error("disk unavailable"));
    const result = await closeCodeSession(thread, "completed");
    expect(result.closed).toBe(true);
    expect(result.message).toContain("원본 볼트 할 일도 완료");
    expect(result.message).toContain("다음 볼트 동기화");
    expect(mocks.end).toHaveBeenCalledOnce();
  });

  it.each(["active", "ending"])("does not close or mutate tasks while %s", async (state) => {
    mocks.begin.mockReturnValue(state);
    expect((await closeCodeSession(thread, "completed")).closed).toBe(false);
    expect(mocks.session).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it("rejects an invalid outcome and handles an already closed session", async () => {
    expect((await closeCodeSession(thread, "invalid")).closed).toBe(false);
    expect(mocks.begin).not.toHaveBeenCalled();
    mocks.session.mockResolvedValue(null);
    expect((await closeCodeSession(thread, null)).closed).toBe(false);
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledWith(thread.id);
  });
});
