import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ButtonInteraction, Client, Message } from "discord.js";
import { JobStore } from "./store.js";

const mocks = vi.hoisted(() => ({ env: { WORK_DIR: "", OWNER_DISCORD_ID: "owner" }, execute: vi.fn() }));
vi.mock("../env.js", () => ({ env: mocks.env }));
vi.mock("node:child_process", () => ({ execFile: mocks.execute }));

let jobs: JobStore;
beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks(); vi.useFakeTimers();
  vi.stubEnv("CONTENT_ENABLED", "true"); vi.stubEnv("GEMINI_API_KEY", "test");
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.env.WORK_DIR = mkdtempSync(join(tmpdir(), "content-revision-"));
  jobs = new JobStore(join(mocks.env.WORK_DIR, "content"));
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(mocks.env.WORK_DIR, { recursive: true, force: true }); });

const plan = { panels: [{}, {}, {}, {}, {}, {}] };
function seed(state: "draft" | "review", failed: number[] = [1]) {
  const job = jobs.create("instatoon", "버스 정류장", "body", "studio");
  Object.assign(job, { state, thread: "thread-1", message: "posted", hash: state === "review" ? "h" : undefined });
  jobs.save(job);
  const dir = jobs.path(job.id);
  writeFileSync(join(dir, "production-plan.json"), JSON.stringify(plan));
  if (state === "draft") writeFileSync(join(dir, "draft.json"), JSON.stringify({ failed_panels: failed.map(index => ({ index, blockers: ["b"] })), previews: [], caption: "c" }));
  else writeFileSync(join(dir, "manifest.json"), JSON.stringify({ hash: "h", account: null, caption: "c", review: { summary: "ok" }, previews: [] }));
  return job;
}
const threadMessage = (content: string, overrides: Record<string, unknown> = {}) => ({
  id: "m1", channelId: "thread-1", content, author: { id: "owner", bot: false },
  channel: { isThread: () => true }, reply: vi.fn().mockResolvedValue({}), ...overrides,
}) as unknown as Message;
const button = (customId: string, messageId = "posted", channelId = "thread-1") => ({ customId, channelId,
  deferReply: vi.fn(), editReply: vi.fn(), message: { id: messageId, edit: vi.fn() } });

describe("revision confirmation", () => {
  it("rejects old proposals, supports cancellation, and confirms once only", async () => {
    const { contentButton, contentThreadMessage } = await import("./index.js");
    const job = seed("review");
    await contentThreadMessage(threadMessage("수정 대상: 6컷\n5컷처럼 남겨 주세요"));
    const old = jobs.get(job.id).revisionProposal!.token;
    await contentThreadMessage(threadMessage("수정 대상: 6컷\n봉지 유지"));
    const fresh = jobs.get(job.id).revisionProposal!.token;
    await contentButton(button(`content:revise:${job.id}:${old}`) as unknown as ButtonInteraction);
    expect(jobs.get(job.id).state).toBe("review");
    await contentButton(button(`content:cancel:${job.id}:${fresh}`) as unknown as ButtonInteraction);
    expect(jobs.get(job.id).revisionProposal).toBeUndefined();
    expect(existsSync(join(jobs.path(job.id), "revision.json"))).toBe(false);
    await contentThreadMessage(threadMessage("수정 대상: 6컷\n5컷처럼 남겨 주세요"));
    const confirm = button(`content:revise:${job.id}:${jobs.get(job.id).revisionProposal!.token}`);
    await contentButton(confirm as unknown as ButtonInteraction);
    const accepted = jobs.get(job.id);
    expect(accepted).toMatchObject({ state: "revising", revisionFrom: "review" });
    expect(accepted.revisionId).toBeTruthy();
    expect(accepted.hash).toBeUndefined();
    expect(JSON.parse(readFileSync(join(jobs.path(job.id), "revision.json"), "utf8")).panels).toEqual([5]);
    await contentButton(confirm as unknown as ButtonInteraction);
    expect(jobs.get(job.id)).toEqual(accepted);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("rejects old approval messages even when restored media has the same hash", async () => {
    const { contentButton } = await import("./index.js");
    const job = seed("review");
    for (const [key, value] of Object.entries({ CONTENT_PUBLISH_ENABLED: "true", INSTATOON_IG_USER_ID: "account", INSTATOON_IG_ACCESS_TOKEN: "test", CONTENT_GRAPH_VERSION: "test", CONTENT_S3_BUCKET: "test" })) vi.stubEnv(key, value);
    writeFileSync(join(jobs.path(job.id), "manifest.json"), JSON.stringify({ account: "account", hash: "h" }));
    const stale = button(`content:approve:${job.id}:h`, "old-message");
    await contentButton(stale as unknown as ButtonInteraction);
    expect(jobs.get(job.id).state).toBe("review");
    expect(stale.message.edit).not.toHaveBeenCalled();
    await contentButton(button(`content:approve:${job.id}:h`) as unknown as ButtonInteraction);
    expect(jobs.get(job.id).state).toBe("approved");
  });
  it("offers restore only with a preserved prior revision and keeps it unpaid until confirmed", async () => {
    const { contentThreadMessage } = await import("./index.js");
    const job = seed("review");
    await contentThreadMessage(threadMessage("원복 대상: 5컷"));
    expect(jobs.get(job.id).revisionProposal).toBeUndefined();
    job.lastRevisionBackup = "backup"; jobs.save(job);
    await contentThreadMessage(threadMessage("원복 대상: 5컷"));
    expect(jobs.get(job.id)).toMatchObject({ state: "review", revisionProposal: { panels: [4], operation: "restore", backupId: "backup" } });
  });
});

describe("parseRevision", () => {
  it("selects only the separate target line, never reference numbers in the instruction", async () => {
    const { parseRevision } = await import("./index.js");
    expect(parseRevision("수정 대상: 6컷\n5컷처럼 노란 과자 봉지를 남겨 주세요.", 6)).toEqual({ panels: [5], instruction: "5컷처럼 노란 과자 봉지를 남겨 주세요.", operation: "revise" });
    expect(parseRevision("수정 대상: 4, 2컷, 4번\n표지와 5장 참고", 6)).toEqual({ panels: [1, 3], instruction: "표지와 5장 참고", operation: "revise" });
    expect(parseRevision("원복 대상: 6컷", 6)).toMatchObject({ panels: [5], operation: "restore" });
    expect(typeof parseRevision("손 모양 자연스럽게", 6, [0, 5])).toBe("string");
    for (const bad of ["수정 대상: 0컷\n수정", "수정 대상: 7컷\n수정", "수정 대상: 2-4컷\n수정", "수정 대상: 6컷", `수정 대상: 6컷\n${"가".repeat(1001)}`]) expect(typeof parseRevision(bad, 6)).toBe("string");
    expect(typeof parseRevision("손 모양 자연스럽게", 6, [])).toBe("string");
    expect(typeof parseRevision("9컷 고쳐", 6, [])).toBe("string");
    expect(typeof parseRevision("표지 제목 바꿔", 6, [])).toBe("string");
    expect(typeof parseRevision("   ", 6, [1])).toBe("string");
  });
});

describe("contentThreadMessage", () => {
  it("proposes without changing media or spending a generation, and ignores other threads/users", async () => {
    const { contentThreadMessage } = await import("./index.js");
    const job = seed("draft", [1]);
    expect(await contentThreadMessage(threadMessage("x", { channelId: "other-thread" }))).toBe(false);
    expect(await contentThreadMessage(threadMessage("x", { author: { id: "stranger", bot: false } }))).toBe(false);
    const message = threadMessage("수정 대상: 2컷\n표정 덜 놀라게");
    expect(await contentThreadMessage(message)).toBe(true);
    const saved = jobs.get(job.id);
    expect(saved).toMatchObject({ state: "draft", revisionProposal: { panels: [1], instruction: "표정 덜 놀라게", messageId: "m1" } });
    expect(existsSync(join(jobs.path(job.id), "revision.json"))).toBe(false);
    expect(mocks.execute).not.toHaveBeenCalled();
    expect((message.reply as ReturnType<typeof vi.fn>).mock.calls[0][0].content).toContain("2컷");
    jobs.confirmRevision(job.id, saved.revisionProposal!.token);
    // A second request while revising is refused without touching the stored request.
    const again = threadMessage("3컷 다시");
    expect(await contentThreadMessage(again)).toBe(true);
    expect(jobs.get(job.id).state).toBe("revising");
    expect(JSON.parse(readFileSync(join(jobs.path(job.id), "revision.json"), "utf8")).panels).toEqual([1]);
  });
  it("keeps the existing approval hash until explicit confirmation", async () => {
    const { contentThreadMessage } = await import("./index.js");
    const job = seed("review");
    const vague = threadMessage("배경 정리");
    await contentThreadMessage(vague);
    expect(jobs.get(job.id).state).toBe("review");
    await contentThreadMessage(threadMessage("수정 대상: 1컷\n배경 정리"));
    expect(jobs.get(job.id)).toMatchObject({ state: "review", hash: "h" });
    jobs.confirmRevision(job.id, jobs.get(job.id).revisionProposal!.token);
    const saved = jobs.get(job.id);
    expect(saved).toMatchObject({ state: "revising", revisionFrom: "review" });
    expect(saved.hash).toBeUndefined();
  });
});

describe("worker", () => {
  const start = async (fetch: ReturnType<typeof vi.fn>) => {
    const { startContentWorker } = await import("./index.js");
    startContentWorker({ channels: { fetch } } as unknown as Client);
    await vi.advanceTimersByTimeAsync(0);
  };
  it("fails closed when interrupted revision recovery fails", async () => {
    const job = seed("review");
    jobs.requestRevision(job.id, [0], "다시", "m1");
    mocks.execute.mockImplementation((_f: string, _a: string[], _o: unknown, cb: Function) => cb(new Error("bad snapshot"), "", ""));
    const send = vi.fn().mockResolvedValue({ id: "failed-notice" });
    await start(vi.fn().mockResolvedValue({ isSendable: () => true, send }));
    expect(jobs.get(job.id)).toMatchObject({ state: "failed", message: "notice:failed" });
    expect(jobs.get(job.id).hash).toBeUndefined();
    expect(() => jobs.decide(job.id, "h", true)).toThrow();
    expect(send.mock.calls[0][0].content).toContain("복구에 실패");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(mocks.execute).toHaveBeenCalledOnce();
  });
  it("sends comparison and review before the ten-image approval message", async () => {
    const job = seed("review"); job.message = undefined; jobs.save(job);
    const dir = jobs.path(job.id);
    writeFileSync(join(dir, "comparison.html"), "comparison");
    writeFileSync(join(dir, "review.html"), "review");
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ hash: "h", account: null, caption: "c", review: { summary: "ok" }, previews: Array.from({ length: 10 }, (_, n) => `${n}.jpg`) }));
    const send = vi.fn().mockResolvedValue({ id: "fresh-review" });
    await start(vi.fn().mockResolvedValue({ isSendable: () => true, send }));
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0].files.map((file: { name: string }) => file.name)).toEqual(["comparison.html", "review.html"]);
    expect(send.mock.calls[0][0].components).toBeUndefined();
    expect(send.mock.calls[1][0].files).toHaveLength(10);
    expect(send.mock.calls[1][0].components).toHaveLength(1);
    expect(jobs.get(job.id).message).toBe("fresh-review");
  });
  it("recovers interrupted revision at startup and issues a new review message", async () => {
    const job = seed("draft", [2]);
    jobs.requestRevision(job.id, [2], "3컷 다시", "m1");
    mocks.execute.mockImplementation((_f: string, _a: string[], _o: unknown, cb: Function) => cb(null, "", ""));
    await start(vi.fn().mockResolvedValue({ isSendable: () => true, send: vi.fn().mockResolvedValue({ id: "new-review" }) }));
    expect(mocks.execute.mock.calls[0][1][1]).toBe("recover-revision");
    expect(jobs.get(job.id)).toMatchObject({ state: "draft", message: "new-review" });
    expect(jobs.get(job.id).revisionId).toBeUndefined();
  });
  it("posts a flagged draft with a revision thread when generation ends without a manifest", async () => {
    const job = jobs.create("instatoon", "쿠키", "body", "studio");
    mocks.execute.mockImplementation((_f: string, args: string[], _o: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
      writeFileSync(join(args[2], "draft.json"), JSON.stringify({ failed_panels: [{ index: 2, blockers: ["꼬리 방향 오류"] }], previews: [], caption: "cap" }));
      cb(null, "", "");
    });
    const startThread = vi.fn().mockResolvedValue({ id: "thread-9" });
    const send = vi.fn().mockResolvedValue({ id: "draft-message", startThread });
    const fetch = vi.fn().mockResolvedValue({ isSendable: () => true, send });
    await start(fetch);
    expect(mocks.execute.mock.calls[0][1][1]).toBe("generate");
    expect(jobs.get(job.id)).toMatchObject({ state: "draft", message: "draft-message", thread: "thread-9" });
    const content = send.mock.calls[0][0].content as string;
    expect(content).toContain("초안(게시 불가)"); expect(content).toContain("3컷: 꼬리 방향 오류"); expect(content).toContain("스레드");
    expect(startThread).toHaveBeenCalledOnce();
    expect(existsSync(join(jobs.path(job.id), "manifest.json"))).toBe(false);
  });
  it("runs the revise action for revising jobs and reports the new outcome inside the thread", async () => {
    const job = seed("draft", [2]);
    mocks.execute.mockImplementation((_f: string, args: string[], _o: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
      rmSync(join(args[2], "draft.json"));
      writeFileSync(join(args[2], "manifest.json"), JSON.stringify({ hash: "new-hash", account: null, caption: "cap", review: { summary: "통과" }, previews: [] }));
      writeFileSync(join(args[2], "review.html"), "<html>");
      writeFileSync(join(args[2], "revision-result.json"), JSON.stringify({ backupId: jobs.get(job.id).revisionId, panels: [2], operation: "revise" }));
      cb(null, "", "");
    });
    const threadSend = vi.fn().mockResolvedValue({ id: "review-in-thread" });
    const channelSend = vi.fn();
    const fetch = vi.fn().mockImplementation(async (id: string) => id === "thread-1"
      ? { isSendable: () => true, send: threadSend } : { isSendable: () => true, send: channelSend });
    await start(fetch);
    // The request arrives while the worker is already running; a request found at startup is treated as interrupted.
    jobs.requestRevision(job.id, [2], "3컷 다시", "m1");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.execute.mock.calls[0][1][1]).toBe("revise");
    expect(jobs.get(job.id)).toMatchObject({ state: "review", hash: "new-hash", message: "review-in-thread", thread: "thread-1" });
    expect(channelSend).not.toHaveBeenCalled();
    expect(threadSend.mock.calls.at(-1)![0].content).toContain("검토 요청");
    expect(jobs.get(job.id).lastRevisionBackup).toBeTruthy();
  });
  it("blocks approval after revision failure until recovery finishes on the next tick", async () => {
    const job = seed("review");
    mocks.execute.mockImplementationOnce((_f: string, _a: string[], _o: unknown, cb: Function) => cb(Object.assign(new Error("boom"), { code: 1 }), "", ""))
      .mockImplementationOnce((_f: string, _a: string[], _o: unknown, cb: Function) => cb(null, "", ""));
    const threadSend = vi.fn().mockResolvedValue({ id: "n" });
    const fetch = vi.fn().mockImplementation(async (id: string) => ({ isSendable: () => true, send: id === "thread-1" ? threadSend : vi.fn() }));
    await start(fetch);
    jobs.requestRevision(job.id, [0], "1컷 다시", "m1");
    await vi.advanceTimersByTimeAsync(10_000);
    const saved = jobs.get(job.id);
    expect(saved).toMatchObject({ state: "recovering" });
    expect(saved.hash).toBeUndefined();
    expect(() => jobs.decide(job.id, "h", true)).toThrow();
    expect(saved.generationAttempts).toBeUndefined();
    expect(threadSend).not.toHaveBeenCalled();
    expect(mocks.execute).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.execute.mock.calls[1][1][1]).toBe("recover-revision");
    expect(jobs.get(job.id)).toMatchObject({ state: "review", hash: "h", message: "n" });
  });
});
