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
import { isAllowedVaultMarkdownPath, listVaultNotesAdded, writeVaultDailyLog } from "./mutations.js";

const ROOT = "/data/work/vault";

describe("isAllowedVaultMarkdownPath", () => {
  it("allows Markdown inside approved vault roots", () => {
    expect(isAllowedVaultMarkdownPath(ROOT, "프로젝트/todari-ops.md")).toBe(true);
    expect(isAllowedVaultMarkdownPath(ROOT, `${ROOT}/공부/TIL/메모.md`)).toBe(true);
  });

  it("rejects traversal, git metadata, settings, and non-Markdown files", () => {
    expect(isAllowedVaultMarkdownPath(ROOT, "../secret.md")).toBe(false);
    expect(isAllowedVaultMarkdownPath(ROOT, `${ROOT}/.git/config.md`)).toBe(false);
    expect(isAllowedVaultMarkdownPath(ROOT, ".obsidian/plugins/config.md")).toBe(false);
    expect(isAllowedVaultMarkdownPath(ROOT, "프로젝트/첨부.png")).toBe(false);
  });
});

// 자동 데일리 기록의 볼트 쪽 절반은 git 그 자체라, 임시 디렉터리의 실제 레포로 확인한다:
// origin(맨 레포) ← mac(사람 쪽 작업본) / work/vault(봇의 checkout). 레포는 한 번 만들어 이어 쓴다.
describe("daily log in the vault checkout", { timeout: 30_000 }, () => {
  const TEMPLATE = "## 할 일\n- [ ] \n\n## 인박스\n\n## 메모\n";
  const BODY = [
    "### 코드",
    "- **todari-ops** 2건: feat: a; fix: b",
    "### 인스타 게시",
    "게시: 1/3건",
    "· 야있날 game-flow-reel 0/2 ← 미게시 있음",
    "### 볼트",
    "- 의사결정: [[2026-10-11 가격 정책]]",
    "### 일본어",
    "- お疲れ様です (おつかれさまです) — 수고하셨습니다",
  ].join("\n");
  const DAY = { start: Date.parse("2026-10-11T00:00:00+09:00"), end: Date.parse("2026-10-12T00:00:00+09:00") };
  let root: string;
  let origin: string;
  let mac: string;

  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=mac", "-c", "user.email=mac@example.com", ...args], {
      cwd,
      encoding: "utf8",
    });
  /** 사람 쪽(Mac)에서 파일을 쓰고 그 시각의 커밋으로 남긴다. */
  function macCommit(at: string, files: Record<string, string>): void {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(mac, file)), { recursive: true });
      writeFileSync(join(mac, file), content);
    }
    vi.stubEnv("GIT_AUTHOR_DATE", at);
    vi.stubEnv("GIT_COMMITTER_DATE", at);
    git(mac, "add", "-A");
    git(mac, "commit", "--quiet", "-m", "vault backup");
    vi.unstubAllEnvs();
    isolateGit();
  }
  const macPush = () => git(mac, "push", "--quiet", "origin", "main");
  // 개발자 PC의 전역 git 설정(서명·훅·템플릿)이 끼어들지 않게 한다.
  const isolateGit = () => {
    vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  };
  const published = (file: string) => git(origin, "show", `main:${file}`);
  const head = () => git(origin, "log", "-1", "--format=%H|%an|%s", "main").trim();

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "vault-daily-log-"));
    mocks.env.WORK_DIR = join(root, "work");
    origin = join(root, "origin.git");
    mac = join(root, "mac");
    isolateGit();
    git(root, "init", "--quiet", "--bare", "--initial-branch=main", origin);
    git(root, "init", "--quiet", "--initial-branch=main", mac);
    git(mac, "remote", "add", "origin", origin);
    macCommit("2026-10-10T10:00:00+09:00", {
      "데일리/2026-10-10.md": TEMPLATE,
      "프로젝트/todari-ops.md": "## 다음 할 일\n",
    });
    macCommit("2026-10-11T09:00:00+09:00", {
      "이정표/의사결정/2026-10-11 가격 정책.md": "결정\n",
      "공부/TIL/git 날짜.md": "배운 것\n",
      "프로젝트/todari-ops.md": "## 다음 할 일\n\n- [ ] 고친 줄\n", // 수정은 "새 노트"가 아니다
      "프로젝트/첨부.png": "png",
    });
    macCommit("2026-10-12T00:00:00+09:00", { "공부/TIL/다음 날.md": "자정 정각은 다음 날이다\n" });
    macPush();
    git(root, "clone", "--quiet", "--branch", "main", origin, join(root, "work", "vault"));
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("lists the Markdown notes first committed inside the window", async () => {
    const added = await listVaultNotesAdded(DAY.start, DAY.end);
    expect(added.map((file) => file.normalize("NFC")).sort()).toEqual([
      "공부/TIL/git 날짜.md",
      "이정표/의사결정/2026-10-11 가격 정책.md",
    ]);
  });

  it("creates the note, then replaces only its own section after the owner edits it", async () => {
    const created = await writeVaultDailyLog("2026-10-11", BODY);
    expect(created).toMatchObject({ changed: true, path: "데일리/2026-10-11.md" });
    expect(published("데일리/2026-10-11.md")).toBe(
      `---\ntype: 데일리\n날짜: 2026-10-11\n---\n## 자동 기록\n\n${BODY}\n\n## 메모\n`,
    );
    expect(head()).toMatch(/\|todari-ops\[bot\]\|vault: daily log 2026-10-11 via todari-ops$/);

    // 사람이 Mac 에서 메모를 덧붙여 push 한 뒤, 봇이 같은 날 기록을 다시 쓴다.
    git(mac, "pull", "--quiet", "origin", "main");
    const mine = published("데일리/2026-10-11.md") + "배포가 많았던 날  \n";
    macCommit("2026-10-12T09:00:00+09:00", { "데일리/2026-10-11.md": mine });
    macPush();
    const next = `${BODY}\n### 운영\n- 배포 1건 (lvti)`;
    expect((await writeVaultDailyLog("2026-10-11", next)).changed).toBe(true);
    expect(published("데일리/2026-10-11.md")).toBe(mine.replace(BODY, next));

    const before = head();
    expect((await writeVaultDailyLog("2026-10-11", next)).changed).toBe(false);
    expect(head()).toBe(before); // 같은 내용이면 커밋도 push 도 없다
  });

  it("adds the section to a note the owner already started from the template", async () => {
    await writeVaultDailyLog("2026-10-10", BODY);
    expect(published("데일리/2026-10-10.md")).toBe(`## 자동 기록\n\n${BODY}\n\n${TEMPLATE}`);
  });

  it("refuses a date that is not a calendar day", async () => {
    await expect(writeVaultDailyLog("../프로젝트/todari-ops", BODY)).rejects.toThrow("invalid daily log date");
  });
});
