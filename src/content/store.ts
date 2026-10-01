import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
export type Kind = "waenyamyeon" | "instatoon";
export type State = "queued" | "generating" | "review" | "draft" | "revising" | "recovering" | "approved" | "publishing" | "published" | "failed" | "rejected" | "uncertain";
export interface RevisionProposal {
  token: string; panels: number[]; instruction: string; messageId: string;
  operation: "revise" | "restore"; backupId?: string;
}
export const MAX_GENERATION_ATTEMPTS = 3;
export interface Job {
  id: string; kind: Kind; topic: string; body: string; channel: string;
  state: State; created: string; hash?: string; approvedHash?: string;
  sourceMessageId?: string; retryOf?: string; message?: string; error?: string; mediaId?: string; generationAttempts?: number;
  /** Discord thread where the operator types revision requests for this job. */
  thread?: string;
  /** State to restore when a revision run fails before producing a draft or manifest. */
  revisionFrom?: "draft" | "review";
  revisionId?: string;
  revisionProposal?: RevisionProposal;
  lastRevisionBackup?: string;
}
export class JobStore {
  constructor(readonly root: string) { mkdirSync(root, { recursive: true }); }
  path(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("잘못된 작업 ID");
    return join(this.root, id);
  }
  get(id: string): Job { return JSON.parse(readFileSync(join(this.path(id), "job.json"), "utf8")); }
  save(job: Job): void {
    const dir = this.path(job.id); mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `job.${randomUUID()}.tmp`);
    writeFileSync(tmp, JSON.stringify(job, null, 2)); renameSync(tmp, join(dir, "job.json"));
  }
  list(): Job[] {
    const jobs: Job[] = [];
    for (const id of readdirSync(this.root).filter(id => /^[a-f0-9-]{36}$/.test(id))) {
      try { jobs.push(this.get(id)); }
      catch { console.error(`[content] unreadable job ${id}; skipped, manual recovery required`); }
    }
    return jobs.sort((a, b) => a.created.localeCompare(b.created));
  }
  create(kind: Kind, topic: string, body: string, channel: string, sourceMessageId?: string): Job {
    if (sourceMessageId) {
      const existing = this.list().find(job => job.channel === channel && job.sourceMessageId === sourceMessageId);
      if (existing) return existing;
    }
    if (!["waenyamyeon", "instatoon"].includes(kind) || !topic.trim() || !body.trim()) throw new Error("주제와 내용이 필요합니다");
    const job: Job = { id: randomUUID(), kind, topic, body, channel, ...(sourceMessageId ? { sourceMessageId } : {}), state: "queued", created: new Date().toISOString() };
    this.save(job); return job;
  }
  retry(id: string, channel: string): Job {
    const original = this.get(id);
    if (original.kind !== "instatoon" || !["failed", "draft"].includes(original.state) || ![original.channel, original.thread].includes(channel)) {
      throw new Error("생성에 실패했거나 초안 상태인 인스타툰만 원래 채널에서 다시 제작할 수 있습니다");
    }
    const all = this.list();
    const existing = all.find(job => job.retryOf === id);
    if (existing) return existing;
    if (all.filter(job => ["queued", "generating", "revising", "recovering", "approved", "publishing"].includes(job.state)).length >= 5) {
      throw new Error("대기 작업이 5개입니다. 처리 후 다시 눌러 주세요");
    }
    // One atomic job write retains the retry relationship across process restarts.
    // A new directory keeps the failed run and its cached model responses intact.
    const job: Job = { id: randomUUID(), kind: original.kind, topic: original.topic,
      body: original.body, channel: original.channel, state: "queued", created: new Date().toISOString(), retryOf: id };
    this.save(job);
    return job;
  }
  decide(id: string, hash: string, approve: boolean): Job {
    const job = this.get(id);
    if (job.state !== "review" || !hash || job.hash !== hash) throw new Error("이미 처리됐거나 이전 버전의 승인입니다");
    job.state = approve ? "approved" : "rejected";
    job.revisionProposal = undefined;
    if (approve) job.approvedHash = hash;
    this.save(job); return job;
  }
  /** Persist an operator revision request; the worker runs it on the next tick. */
  proposeRevision(id: string, proposal: Omit<RevisionProposal, "token">): RevisionProposal {
    const job = this.get(id);
    if (job.kind !== "instatoon" || !["draft", "review"].includes(job.state)) throw new Error("현재 수정할 수 없는 작업입니다");
    job.revisionProposal = { ...proposal, token: randomUUID() };
    this.save(job); return job.revisionProposal;
  }
  confirmRevision(id: string, token: string, cancel = false): Job {
    const job = this.get(id), proposal = job.revisionProposal;
    if (!proposal || proposal.token !== token || !["draft", "review"].includes(job.state)) throw new Error("만료된 수정 요청입니다");
    if (cancel) { job.revisionProposal = undefined; this.save(job); return job; }
    return this.requestRevision(id, proposal.panels, proposal.instruction, proposal.messageId, proposal.operation, proposal.backupId);
  }
  requestRevision(id: string, panels: number[], instruction: string, messageId: string,
    operation: "revise" | "restore" = "revise", backupId?: string): Job {
    const job = this.get(id);
    if (job.kind !== "instatoon" || !["draft", "review"].includes(job.state)) throw new Error("초안 또는 검토 상태의 인스타툰만 수정할 수 있습니다");
    if (this.list().filter(j => ["queued", "generating", "revising", "recovering", "approved", "publishing"].includes(j.state)).length >= 5) throw new Error("대기 작업이 5개입니다");
    if (!panels.length || panels.some(i => !Number.isInteger(i) || i < 0) || new Set(panels).size !== panels.length || !instruction.trim() || instruction.length > 1000) throw new Error("잘못된 수정 대상입니다");
    if (operation === "restore" && (!backupId || backupId !== job.lastRevisionBackup)) throw new Error("원복 가능한 직전 버전이 없습니다");
    const dir = this.path(id);
    const tmp = join(dir, `revision.${randomUUID()}.tmp`);
    writeFileSync(tmp, JSON.stringify({ instruction, panels, messageId, operation, backupId, requestedAt: new Date().toISOString() }, null, 2));
    renameSync(tmp, join(dir, "revision.json"));
    job.revisionFrom = job.state as "draft" | "review";
    job.revisionId = randomUUID(); job.revisionProposal = undefined;
    job.state = "revising"; job.error = undefined; job.hash = undefined; job.approvedHash = undefined;
    this.save(job); return job;
  }
  recover(): void {
    for (const job of this.list()) {
      if (job.state === "revising") {
        // Never expose partially modified media with the previous approval hash.
        job.state = "recovering"; job.hash = undefined; job.approvedHash = undefined;
        job.error = "수정 중 재시작되어 이전 결과를 복구합니다. 복구 후 새 검토 요청을 확인해 주세요.";
        this.save(job); continue;
      }
      if (job.state === "generating" || job.state === "publishing") {
        job.error = "실행 중 서버가 재시작되었습니다. 산출물/게시 여부 확인이 필요합니다.";
        if (job.state === "publishing") {
          job.state = "uncertain";
        } else {
          job.generationAttempts ??= 1;
          job.state = job.generationAttempts < MAX_GENERATION_ATTEMPTS ? "queued" : "failed";
          if (job.state === "queued") job.error = "서버 재시작 후 저장된 생성 단계부터 자동 재시도합니다.";
        }
        this.save(job);
      }
    }
  }
}
