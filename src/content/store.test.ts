import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore } from "./store.js";
const dirs: string[] = [];
const make = () => { const dir = mkdtempSync(join(tmpdir(), "content-")); dirs.push(dir); return new JobStore(dir); };
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));
describe("content approval", () => {
  it("persists review and permits only one approval of the exact version", () => {
    const s = make(); const j = s.create("instatoon", "topic", "body", "channel");
    j.state = "review"; j.hash = "hash"; s.save(j);
    const reboot = new JobStore(s.root);
    expect(() => reboot.decide(j.id, "old", true)).toThrow();
    expect(reboot.decide(j.id, "hash", true).approvedHash).toBe("hash");
    expect(() => s.decide(j.id, "hash", true)).toThrow();
    expect(() => s.decide(j.id, "hash", false)).toThrow();
  });
  it("rejects without publish authorization", () => {
    const s = make(); const j = s.create("waenyamyeon", "topic", "body", "channel");
    expect(() => s.decide(j.id, "hash", true)).toThrow();
    j.state = "review"; j.hash = "hash"; s.save(j);
    expect(s.decide(j.id, "hash", false).approvedHash).toBeUndefined();
  });
  it("resumes interrupted generation but never retries publishing after restart", () => {
    const s = make();
    for (const state of ["publishing", "generating", "review", "approved"] as const) {
      const j = s.create("instatoon", state, "body", "channel"); j.state = state; s.save(j);
    }
    s.recover();
    expect(Object.fromEntries(s.list().map(j => [j.topic, j.state]))).toEqual({
      publishing: "uncertain", generating: "queued", review: "review", approved: "approved" });
    expect(s.list().find(j => j.topic === "generating")?.generationAttempts).toBe(1);
  });
  it("preserves the generation retry budget across restarts", () => {
    const s = make();
    const pending = s.create("waenyamyeon", "pending", "body", "channel");
    pending.state = "generating"; pending.generationAttempts = 2; s.save(pending);
    const exhausted = s.create("waenyamyeon", "exhausted", "body", "channel");
    exhausted.state = "generating"; exhausted.generationAttempts = 3; s.save(exhausted);
    new JobStore(s.root).recover();
    expect(s.get(pending.id)).toMatchObject({ state: "queued", generationAttempts: 2 });
    expect(s.get(exhausted.id)).toMatchObject({ state: "failed", generationAttempts: 3 });
    new JobStore(s.root).recover();
    expect(s.get(pending.id).generationAttempts).toBe(2);
  });
  it("keeps other jobs available when a job file is damaged", () => {
    const s = make(); const bad = s.create("instatoon", "bad", "body", "channel");
    const good = s.create("instatoon", "good", "body", "channel");
    writeFileSync(join(s.path(bad.id), "job.json"), "{");
    expect(s.list().map(j => j.id)).toEqual([good.id]);
  });
  it("rejects traversal and blank inputs", () => {
    const s = make(); expect(() => s.get("../../etc/passwd")).toThrow();
    expect(() => s.create("instatoon", " ", "body", "channel")).toThrow();
  });
});

describe("explicit failed instatoon retry", () => {
  it("accepts a retry inside the owning revision thread while keeping the new job in its parent channel", () => {
    const store = make(); const old = store.create("instatoon", "쿠키", "원문", "channel");
    old.state = "draft"; old.thread = "thread"; store.save(old);
    expect(() => store.retry(old.id, "other-thread")).toThrow();
    const next = store.retry(old.id, "thread");
    expect(next).toMatchObject({ state: "queued", channel: "channel", retryOf: old.id });
    expect(next.thread).toBeUndefined();
    expect(store.retry(old.id, "channel").id).toBe(next.id);
  });
  it("creates one fresh job across duplicate clicks and restarts, preserving the failed run", () => {
    const store = make(); const old = store.create("instatoon", "쿠키", "원문", "channel", "source");
    old.state = "failed"; old.generationAttempts = 3; old.error = "quality failed"; store.save(old);
    const next = store.retry(old.id, "channel");
    expect(next).toMatchObject({ state: "queued", retryOf: old.id, topic: old.topic, body: old.body });
    expect(next.id).not.toBe(old.id);
    expect(next.generationAttempts).toBeUndefined();
    expect(next.approvedHash).toBeUndefined();
    expect(next.sourceMessageId).toBeUndefined();
    expect(new JobStore(store.root).retry(old.id, "channel").id).toBe(next.id);
    expect(store.list()).toHaveLength(2);
    expect(store.get(old.id)).toEqual(old);
  });
  it("never retries uncertain publication, approved jobs, other kinds or another channel", () => {
    const store = make();
    for (const state of ["review", "approved", "publishing", "published", "uncertain"] as const) {
      const job = store.create("instatoon", state, "body", "channel"); job.state = state; store.save(job);
      expect(() => store.retry(job.id, "channel")).toThrow();
    }
    const science = store.create("waenyamyeon", "science", "body", "channel"); science.state = "failed"; store.save(science);
    expect(() => store.retry(science.id, "channel")).toThrow();
    const failed = store.create("instatoon", "failed", "body", "channel"); failed.state = "failed"; store.save(failed);
    expect(() => store.retry(failed.id, "elsewhere")).toThrow();
  });
  it("honors the queue limit before spending another generation attempt", () => {
    const store = make(); const failed = store.create("instatoon", "failed", "body", "channel"); failed.state = "failed"; store.save(failed);
    for (let n = 0; n < 5; n++) store.create("instatoon", `${n}`, "body", "channel");
    expect(() => store.retry(failed.id, "channel")).toThrow("5개");
    expect(store.list()).toHaveLength(6);
  });
});
