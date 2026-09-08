import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { Message } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { diagnose, prepareDiagnosisContext } from "./diagnose.js";
import { prepareDiagnosisCheckout } from "../workspaces/diagnosis-checkout.js";

const mocks = vi.hoisted(() => ({
  env: { WORK_DIR: "", GITHUB_TOKEN: "", DIAG_DAILY_CAP: 3, CLAUDE_MODEL: "" },
  git: vi.fn(), query: vi.fn(), resolve: vi.fn(), evidence: vi.fn(), count: vi.fn(), record: vi.fn(),
}));
vi.mock("../env.js", () => ({ env: mocks.env }));
vi.mock("node:child_process", () => {
  const fake = Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: mocks.git });
  return { execFile: fake, spawn: vi.fn() };
});
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: mocks.query }));
vi.mock("../github/api.js", () => ({
  resolveReleaseCommit: mocks.resolve, collectWorkflowFailureEvidence: mocks.evidence,
  sanitizeDiagnosticText: (value: string) => value,
}));
vi.mock("../stats/events.js", () => ({ countTodayKst: mocks.count, recordEvent: mocks.record }));
vi.mock("../observability/sentry.js", () => ({ captureException: vi.fn() }));

const sha = "a".repeat(40);
const project = { slug: "example", name: "Example", repoUrl: "https://github.com/Todari/example.git", defaultBranch: "main" };

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.env.WORK_DIR = await mkdtemp(path.join(tmpdir(), "todari-diag-test-"));
  mocks.env.DIAG_DAILY_CAP = 3;
  mocks.count.mockReturnValue(0);
  mocks.resolve.mockResolvedValue(null);
  mocks.evidence.mockResolvedValue("실패 step: Typecheck\nError TS2322");
  mocks.git.mockImplementation(async (_cmd, args: string[]) => ({ stdout: args.includes("rev-parse") ? sha : "", stderr: "" }));
  mocks.query.mockImplementation(async function* () { yield { type: "result", result: "검증된 진단" }; });
});

afterEach(async () => { await rm(mocks.env.WORK_DIR, { recursive: true, force: true }); });

describe("isolated diagnosis checkout", () => {
  it("pins simultaneous diagnostics independently without touching /code or old cache", async () => {
    for (const dir of ["thread-123", "diag-example"]) {
      await mkdir(path.join(mocks.env.WORK_DIR, dir));
      await writeFile(path.join(mocks.env.WORK_DIR, dir, "user-change"), "preserve me");
    }
    const [one, two] = await Promise.all([
      prepareDiagnosisCheckout(project, sha), prepareDiagnosisCheckout(project, sha),
    ]);
    expect(one.cwd).not.toBe(two.cwd);
    expect(one.cwd).toContain(`${path.sep}.diagnostics${path.sep}`);
    const commands = mocks.git.mock.calls.map(call => call[1] as string[]);
    expect(commands.filter(cmd => cmd.includes("fetch"))).toHaveLength(2);
    expect(commands.some(cmd => cmd.includes("checkout") && cmd.includes("--detach") && cmd.includes(sha))).toBe(true);
    expect(commands.some(cmd => cmd.includes("reset") || cmd.includes("pull"))).toBe(false);
    await one.cleanup(); await two.cleanup();
    for (const dir of ["thread-123", "diag-example"]) {
      expect(await readFile(path.join(mocks.env.WORK_DIR, dir, "user-change"), "utf8")).toBe("preserve me");
    }
  });

  it("rejects malformed or mismatched commits and removes only its temporary directory", async () => {
    await expect(prepareDiagnosisCheckout(project, "main; rm x")).rejects.toThrow("invalid");
    expect(mocks.git).not.toHaveBeenCalled();
    await expect(prepareDiagnosisCheckout(project, "b".repeat(40))).rejects.toThrow("mismatch");
    expect(await readdir(path.join(mocks.env.WORK_DIR, ".diagnostics"))).toEqual([]);
  });

  it("bounds git execution and suppresses child stderr on failure", async () => {
    mocks.git.mockRejectedValue(new Error("Authorization: private credential"));
    await expect(prepareDiagnosisCheckout(project, sha)).rejects.toThrow("diagnosis git init failed or timed out");
    expect(mocks.git.mock.calls[0][2]).toMatchObject({ timeout: 45_000, maxBuffer: 64 * 1024 });
    expect(await readdir(path.join(mocks.env.WORK_DIR, ".diagnostics"))).toEqual([]);
  });
});

describe("diagnosis source and execution", () => {
  it("uses the failing CI commit and includes its job/step evidence", async () => {
    const reply = vi.fn().mockResolvedValue({});
    await diagnose({ project, title: "failure", prompt: "진단해줘", alertMessage: { reply } as unknown as Message,
      source: { kind: "github-workflow", headSha: sha, runId: 4, runAttempt: 2 } });
    expect(mocks.evidence).toHaveBeenCalledWith(expect.objectContaining({ headSha: sha, runId: 4, runAttempt: 2 }));
    const { prompt, options } = mocks.query.mock.calls[0][0];
    expect(prompt).toContain(sha);
    expect(prompt).toContain("Typecheck");
    expect(options.maxTurns).toBe(15);
    expect(await options.canUseTool("Write", {})).toMatchObject({ behavior: "deny" });
    expect(mocks.record).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(await readdir(path.join(mocks.env.WORK_DIR, ".diagnostics"))).toEqual([]);
  });

  it("uses a verified Sentry release commit and otherwise fetches the current default branch", async () => {
    mocks.resolve.mockResolvedValueOnce(sha);
    const exact = await prepareDiagnosisContext(project, { kind: "sentry", release: "aaaaaaa" });
    expect(exact.evidence).toContain("GitHub로 검증한 SHA");
    await exact.checkout.cleanup();
    const fallback = await prepareDiagnosisContext(project, { kind: "sentry", release: "v2" });
    expect(fallback.evidence).toContain("장애 당시 배포 버전과 다를 수");
    expect(fallback.evidence).toContain(sha);
    expect(mocks.git.mock.calls.some(call => call[1].includes("refs/heads/main") && call[1].includes("fetch"))).toBe(true);
    await fallback.checkout.cleanup();
  });

  it("reports missing CI SHA without running an agent on unrelated code", async () => {
    const reply = vi.fn().mockResolvedValue({});
    await diagnose({ project, title: "failure", prompt: "", alertMessage: { reply } as unknown as Message,
      source: { kind: "github-workflow", runId: 1 } });
    expect(mocks.git).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
    expect(reply.mock.calls[0][0].content).toContain("부족한 정보");
  });

  it("does no checkout/API work when disabled or the daily cap is exhausted", async () => {
    const args = { project, title: "failure", prompt: "", alertMessage: {} as Message,
      source: { kind: "sentry" as const } };
    mocks.env.DIAG_DAILY_CAP = 0;
    await diagnose(args);
    mocks.env.DIAG_DAILY_CAP = 3;
    mocks.count.mockReturnValue(3);
    await diagnose(args);
    expect(mocks.git).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("cleans up the isolated checkout if the agent fails", async () => {
    mocks.query.mockImplementation(async function* () { throw new Error("agent failed"); });
    await expect(diagnose({ project, title: "failure", prompt: "", alertMessage: {} as Message,
      source: { kind: "sentry" } })).rejects.toThrow("agent failed");
    expect(await readdir(path.join(mocks.env.WORK_DIR, ".diagnostics"))).toEqual([]);
  });
});
