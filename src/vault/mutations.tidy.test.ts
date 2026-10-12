import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: { WORK_DIR: "", GITHUB_TOKEN: "", VAULT_REPO_URL: "", CLAUDE_MODEL: "" },
}));
vi.mock("../env.js", () => ({ env: mocks.env }));
vi.mock("../observability/sentry.js", () => ({ captureException: vi.fn() }));
import { blameVaultNotes, completeVaultTask, tidyVaultTask } from "./mutations.js";

// 금요일 할 일 정리의 볼트 쪽 절반(줄의 나이·마감일 적기·버림 표시)은 git 그 자체라, mutations.test.ts 처럼
// 임시 디렉터리의 실제 레포로 확인한다: origin(맨 레포) ← mac(사람 쪽 작업본) / work/vault(봇의 checkout).
describe("task tidy in the vault checkout", { timeout: 30_000 }, () => {
  const OPS = { projectSlug: "todari-ops", note: "todari-ops" };
  const JEONGPYO = { projectSlug: "jeongpyo", note: "이정표" };
  const at = (iso: string) => Date.parse(iso);
  let root: string;
  let origin: string;
  let mac: string;

  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=mac", "-c", "user.email=mac@example.com", ...args], {
      cwd,
      encoding: "utf8",
    });
  // 개발자 PC의 전역 git 설정이 끼어들지 않게 하고, 봇 컨테이너처럼 git 이 커밋 신원을 추측하지 못하게 한다.
  const isolateGit = () => {
    vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "user.useConfigOnly");
    vi.stubEnv("GIT_CONFIG_VALUE_0", "true");
  };
  /** 사람 쪽(Mac)에서 파일을 쓰고 그 시각의 커밋으로 올린다. */
  function macCommit(when: string, files: Record<string, string>): void {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(mac, file)), { recursive: true });
      writeFileSync(join(mac, file), content);
    }
    vi.stubEnv("GIT_AUTHOR_DATE", when);
    vi.stubEnv("GIT_COMMITTER_DATE", when);
    git(mac, "add", "-A");
    git(mac, "commit", "--quiet", "-m", "vault backup");
    vi.unstubAllEnvs();
    isolateGit();
    git(mac, "push", "--quiet", "origin", "main");
  }
  const published = (file: string) => git(origin, "show", `main:${file}`);
  const head = () => git(origin, "log", "-1", "--format=%H|%an|%s", "main").trim();

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "vault-tidy-"));
    mocks.env.WORK_DIR = join(root, "work");
    origin = join(root, "origin.git");
    mac = join(root, "mac");
    isolateGit();
    git(root, "init", "--quiet", "--bare", "--initial-branch=main", origin);
    git(root, "init", "--quiet", "--initial-branch=main", mac);
    git(mac, "remote", "add", "origin", origin);
    macCommit("2026-08-01T10:00:00+09:00", {
      "프로젝트/todari-ops.md": "# todari-ops\n\n## 다음 할 일\n\n- [ ] 오래된 할 일\n- [ ] 고칠 할 일\n",
      "이정표/이정표.md": "## 다음 할 일\n- [ ] 사업계획서 제출 📅 2026-10-01\n",
    });
    macCommit("2026-09-20T09:00:00+09:00", {
      // 둘째 줄의 문장을 고치고 한 줄을 더했다. 첫 줄은 8월 그대로다.
      "프로젝트/todari-ops.md":
        "# todari-ops\n\n## 다음 할 일\n\n- [ ] 오래된 할 일\n- [ ] **고친** 할 일\n- [ ] 새 할 일\n",
    });
    git(root, "clone", "--quiet", "--branch", "main", origin, join(root, "work", "vault"));
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("reads, per note file, when each line was last changed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const blame = await blameVaultNotes([OPS, JEONGPYO, { projectSlug: "ghost", note: "없는 노트" }]);
    expect([...blame.keys()]).toEqual(["todari-ops", "이정표"]); // 파일이 없는 노트는 빠질 뿐이다
    expect(blame.get("todari-ops")).toEqual([
      { time: at("2026-08-01T10:00:00+09:00"), text: "# todari-ops" },
      { time: at("2026-08-01T10:00:00+09:00"), text: "" },
      { time: at("2026-08-01T10:00:00+09:00"), text: "## 다음 할 일" },
      { time: at("2026-08-01T10:00:00+09:00"), text: "" },
      { time: at("2026-08-01T10:00:00+09:00"), text: "- [ ] 오래된 할 일" },
      { time: at("2026-09-20T09:00:00+09:00"), text: "- [ ] **고친** 할 일" },
      { time: at("2026-09-20T09:00:00+09:00"), text: "- [ ] 새 할 일" },
    ]);
    // 이정표·포크레터는 프로젝트/ 가 아닌 제 폴더의 허브 노트다.
    expect(blame.get("이정표")?.[1]).toEqual({
      time: at("2026-08-01T10:00:00+09:00"),
      text: "- [ ] 사업계획서 제출 📅 2026-10-01",
    });
    vi.restoreAllMocks();
  });

  it("writes next week's due date onto the line, replacing a date that is already there", async () => {
    const plain = await tidyVaultTask({ ...OPS, text: "오래된 할 일" }, "next", "2026-10-23");
    expect(plain).toMatchObject({ changed: true, path: "프로젝트/todari-ops.md" });
    expect(published("프로젝트/todari-ops.md")).toContain("- [ ] 오래된 할 일 📅 2026-10-23\n- [ ] **고친** 할 일\n");
    expect(head()).toMatch(/\|todari-ops\[bot\]\|vault: tidy task \(next week\) via todari-ops$/);

    await tidyVaultTask({ ...JEONGPYO, text: "사업계획서 제출" }, "next", "2026-10-23");
    expect(published("이정표/이정표.md")).toBe("## 다음 할 일\n- [ ] 사업계획서 제출 📅 2026-10-23\n");

    // 손댄 줄은 다시 "방금 바뀐 줄"이 된다. 다음 금요일의 목록에서 뒤로 밀린다.
    const blame = await blameVaultNotes([OPS]);
    const [old, touched] = [blame.get("todari-ops")?.[5], blame.get("todari-ops")?.[4]];
    expect(touched?.text).toBe("- [ ] 오래된 할 일 📅 2026-10-23");
    expect(touched?.time).toBeGreaterThan(old?.time ?? Infinity);
  });

  it("marks a dropped line cancelled and no longer finds it as an open task", async () => {
    const dropped = await tidyVaultTask({ ...OPS, text: "새 할 일" }, "drop", "2026-10-16");
    expect(dropped.changed).toBe(true);
    expect(published("프로젝트/todari-ops.md")).toContain("- [-] 새 할 일 ❌ 2026-10-16\n");
    expect(head()).toMatch(/\|todari-ops\[bot\]\|vault: tidy task \(dropped\) via todari-ops$/);

    const before = head();
    for (const action of ["next", "drop"] as const) {
      expect((await tidyVaultTask({ ...OPS, text: "새 할 일" }, action, "2026-10-23")).changed).toBe(false);
    }
    // 이미 그 날짜가 적힌 줄도 고칠 것이 없다.
    expect((await tidyVaultTask({ ...OPS, text: "오래된 할 일" }, "next", "2026-10-23")).changed).toBe(false);
    expect(head()).toBe(before); // 커밋도 push 도 없다
  });

  it("still completes a task through the same edit path", async () => {
    expect((await completeVaultTask({ ...OPS, text: "고친 할 일" })).changed).toBe(true);
    expect(published("프로젝트/todari-ops.md")).toContain("- [x] **고친** 할 일\n");
    expect(head()).toMatch(/\|todari-ops\[bot\]\|vault: complete task via todari-ops$/);
  });

  it("refuses a date that is not a calendar day", async () => {
    await expect(tidyVaultTask({ ...OPS, text: "오래된 할 일" }, "next", "다음 주")).rejects.toThrow("invalid tidy date");
  });
});
