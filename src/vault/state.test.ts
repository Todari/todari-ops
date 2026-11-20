import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: { WORK_DIR: "" },
  remote: vi.fn(),
  rejectRename: false,
}));
vi.mock("../env.js", () => ({ env: mocks.env }));
vi.mock("./repo.js", () => ({ getVaultRemoteRevision: mocks.remote }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (mocks.rejectRename) throw new Error("fixture write failure");
      return actual.rename(...args);
    },
  };
});

const A = "a".repeat(40);
const B = "b".repeat(40);
const INITIAL = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-02T00:00:00.000Z";
let root: string;
let file: string;

beforeEach(() => {
  vi.resetModules();
  mocks.remote.mockReset();
  mocks.remote.mockResolvedValue(A);
  mocks.rejectRename = false;
  root = mkdtempSync(path.join(tmpdir(), "vault-state-test-"));
  file = path.join(root, "vault-state.json");
  mocks.env.WORK_DIR = path.join(root, "work");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const task = (text: string) => ({ text });
const notes = (...texts: string[]) => [{ note: "todari", slug: "todari", tasks: texts.map(task), deadlines: [] }];

it("keeps legacy tasks readable and reports Mac sync as unverified", async () => {
  writeFileSync(file, JSON.stringify({ generatedAt: INITIAL, notes: notes("기존") }));
  const { getVaultState, vaultAgeHours } = await import("./state.js");
  expect(getVaultState()).toEqual({ generatedAt: null, notes: notes("기존") });
  expect(vaultAgeHours(getVaultState())).toBeNull();
});

it("serializes local edits without inventing Mac freshness or losing a task", async () => {
  const { addCapturedVaultTask, completeCapturedVaultTask, getVaultState, setCapturedVaultTaskDue } = await import("./state.js");
  await Promise.all([
    addCapturedVaultTask("todari", "todari", "하나"),
    addCapturedVaultTask("todari", "todari", "둘"),
    setCapturedVaultTaskDue("todari", "todari", "하나", "2026-12-01"),
    completeCapturedVaultTask("todari", "todari", "둘"),
  ]);
  expect(getVaultState()).toMatchObject({
    generatedAt: null,
    localMutationAt: expect.any(String),
    notes: [{ tasks: [{ text: "하나", due: "2026-12-01" }] }],
  });
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(getVaultState());
});

it("rejects both an old timestamp and a revision older than the current Git source", async () => {
  const { addCapturedVaultTask, getVaultState, saveVaultSnapshot } = await import("./state.js");
  await saveVaultSnapshot({ generatedAt: INITIAL, sourceRevision: A, notes: notes("Mac") });
  await addCapturedVaultTask("todari", "todari", "봇");
  expect(await saveVaultSnapshot({ generatedAt: INITIAL, sourceRevision: A, notes: [] })).toBe("stale");
  mocks.remote.mockResolvedValue(B);
  expect(await saveVaultSnapshot({ generatedAt: LATER, sourceRevision: A, notes: [] })).toBe("outdated-revision");
  expect(getVaultState()).toMatchObject({ generatedAt: INITIAL, sourceRevision: A, notes: notes("봇", "Mac") });
  expect(await saveVaultSnapshot({ generatedAt: LATER, sourceRevision: B, notes: notes("봇", "Mac") })).toBe("stored");
  expect(getVaultState()).toMatchObject({ generatedAt: LATER, sourceRevision: B, localMutationAt: expect.any(String) });
  expect(mocks.remote).toHaveBeenCalledTimes(3);
});

it("publishes only after rename and lets queued writes continue after a failure", async () => {
  const { addCapturedVaultTask, getVaultState, saveVaultSnapshot } = await import("./state.js");
  const initial = { generatedAt: INITIAL, sourceRevision: A, notes: notes("기존") };
  await saveVaultSnapshot(initial);
  mocks.rejectRename = true;
  await expect(addCapturedVaultTask("todari", "todari", "실패")).rejects.toThrow("fixture write failure");
  expect(getVaultState()?.notes).toEqual(initial.notes);
  expect(JSON.parse(readFileSync(file, "utf8")).notes).toEqual(initial.notes);
  mocks.rejectRename = false;
  await addCapturedVaultTask("todari", "todari", "재시도");
  expect(getVaultState()?.notes).toEqual(notes("재시도", "기존"));
});

it("normalizes bounded host evidence and retains independent history for each host", async () => {
  const { getVaultState, normalizeVaultState, saveVaultSnapshot } = await import("./state.js");
  const mini = normalizeVaultState({
    generatedAt: INITIAL,
    sourceRevision: A,
    notes: [null],
    operations: {
      hostname: "Test-Mini.local",
      jobs: [
        { job: "vault-push", status: "failed", exit_code: 7, last_attempt: Date.parse(INITIAL) / 1000 },
        { job: "vault-push", status: "success" },
        { job: "untrusted-script", status: "success", output: "private" },
      ],
    },
  });
  expect(mini?.operations).toMatchObject({
    hostname: "test-mini.local",
    jobs: [{ job: "vault-push", status: "failed", exit_code: 7 }],
  });
  const laptop = normalizeVaultState({
    generatedAt: LATER,
    sourceRevision: A,
    notes: [],
    operations: { hostname: "laptop", jobs: [] },
  });
  await saveVaultSnapshot(mini!);
  await saveVaultSnapshot(laptop!);
  expect(getVaultState()?.operations?.map((host) => host.hostname)).toEqual(["laptop", "test-mini.local"]);
  expect(normalizeVaultState({ generatedAt: "2026-02-30T00:00:00Z", sourceRevision: A, notes: [] })).toBeNull();
  expect(normalizeVaultState({ generatedAt: INITIAL, sourceRevision: "bad", notes: [] })).toBeNull();
});
