import { afterEach, describe, expect, it, vi } from "vitest";
import { collectWorkflowFailureEvidence, resolveReleaseCommit, sanitizeDiagnosticText } from "./api.js";

vi.mock("../env.js", () => ({ env: { GITHUB_TOKEN: "private-fixture-token" } }));
const sha = "a".repeat(40);
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const job = (id = 11) => ({ id, head_sha: sha, name: "build", conclusion: "failure", steps: [
  { number: 3, name: "Typecheck", conclusion: "failure" },
] });
const args = { fullName: "Todari/example", runId: 123, headSha: sha, runAttempt: 2 };

afterEach(() => vi.unstubAllGlobals());

describe("bounded GitHub diagnosis evidence", () => {
  it("pins the attempt and SHA, includes actual steps/logs and does not forward auth to storage", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ total_count: 1, jobs: [job()] }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: {
        location: "https://results.blob.core.windows.net/log.txt?sig=download-secret",
      } }))
      .mockResolvedValueOnce(new Response("Error TS2322\nTOKEN=private-ci-value\nprivate-fixture-token\ncontact alice@example.com"));
    vi.stubGlobal("fetch", fetcher);
    const evidence = await collectWorkflowFailureEvidence(args);
    expect(String(fetcher.mock.calls[0][0])).toContain("/runs/123/attempts/2/jobs");
    expect(fetcher.mock.calls[2][1].headers).toEqual({ Range: "bytes=-262144" });
    expect(evidence).toContain("Typecheck");
    expect(evidence).toContain("Error TS2322");
    expect(evidence).not.toMatch(/private-ci-value|private-fixture-token|alice@example.com|download-secret/);
  });

  it("does not download logs for jobs from another SHA", async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ jobs: [{ ...job(), head_sha: "b".repeat(40) }] }));
    vi.stubGlobal("fetch", fetcher);
    const evidence = await collectWorkflowFailureEvidence(args);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(evidence).toContain("SHA가 확인되지 않는 실패 job은 제외");
  });

  it("limits job count and masks before retaining the bounded log excerpt", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ jobs: [job(1), job(2), job(3), job(4)] }))
      .mockImplementation(async () => new Response("x".repeat(500_000)));
    vi.stubGlobal("fetch", fetcher);
    const evidence = await collectWorkflowFailureEvidence(args);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(evidence).toContain("최대 3개");
    expect(evidence).toContain("다운로드 크기 제한");
    expect(evidence.length).toBeLessThan(14_000);
  });

  it("reports missing metadata, denied logs and an untrusted redirect without leaking errors", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ jobs: [job(1), job(2)] }))
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret" } }));
    vi.stubGlobal("fetch", fetcher);
    const evidence = await collectWorkflowFailureEvidence(args);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(evidence.match(/job 로그를 받지 못했습니다/g)).toHaveLength(2);
    expect(evidence).not.toContain("127.0.0.1");
    fetcher.mockRejectedValue(new Error("private-fixture-token request timed out"));
    const missing = await collectWorkflowFailureEvidence(args);
    expect(missing).toContain("부족한 정보");
    expect(missing).not.toContain("private-fixture-token");
  });

  it("rejects malformed identifiers before making a request and propagates cancellation", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("aborted"));
    vi.stubGlobal("fetch", fetcher);
    expect(await collectWorkflowFailureEvidence({ ...args, runId: -1 })).toContain("유효한 workflow");
    expect(fetcher).not.toHaveBeenCalled();
    const abort = new AbortController();
    abort.abort();
    expect(await collectWorkflowFailureEvidence({ ...args, signal: abort.signal })).toContain("부족한 정보");
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("resolves a missing attempt only for the same event SHA", async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ head_sha: "b".repeat(40), run_attempt: 3 }));
    vi.stubGlobal("fetch", fetcher);
    expect(await collectWorkflowFailureEvidence({ ...args, runAttempt: undefined })).toContain("이벤트 SHA와 달라");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("release identity and sensitive data", () => {
  it("requires GitHub to confirm a hexadecimal release in the repository", async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ sha }));
    vi.stubGlobal("fetch", fetcher);
    expect(await resolveReleaseCommit("Todari/example", "v1.2.3")).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    expect(await resolveReleaseCommit("Todari/example", "aaaaaaa")).toBe(sha);
    fetcher.mockResolvedValue(json({ sha: "b".repeat(40) }));
    expect(await resolveReleaseCommit("Todari/example", "aaaaaaa")).toBeNull();
  });

  it("redacts common token, header, database, multiline key and email forms", () => {
    const safe = sanitizeDiagnosticText([
      "Authorization: Basic abc123==", "DATABASE_URL=postgres://u:password@host/db",
      'API_KEY="with spaces"', "Bearer abc.def.ghi", "ghp_privatefixture",
      "-----BEGIN PRIVATE KEY-----\nbase64secret\n-----END PRIVATE KEY-----",
      "-----BEGIN RSA PRIVATE KEY-----\ntruncatedsecret",
    ].join("\n"));
    expect(safe).not.toMatch(/abc123|password@|with spaces|abc.def.ghi|ghp_privatefixture|base64secret|truncatedsecret/);
    expect(safe).toContain("[REDACTED");
  });
});
