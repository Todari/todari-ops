import { describe, expect, it } from "vitest";
import {
  appendIdea,
  completeTask,
  insertTask,
  normalizeTaskText,
  upsertAutoLog,
} from "./editor.js";

describe("insertTask", () => {
  it("adds a task at the top of an existing 다음 할 일 section", () => {
    const result = insertTask(
      "# 프로젝트\n\n## 다음 할 일\n\n- [ ] 기존 작업\n\n## 일정\n",
      "새 작업",
    );
    expect(result.changed).toBe(true);
    expect(result.content).toContain("## 다음 할 일\n\n- [ ] 새 작업\n\n- [ ] 기존 작업");
  });

  it("creates the section and avoids exact duplicates", () => {
    const first = insertTask("# 프로젝트\n", "할 일");
    const second = insertTask(first.content, "할 일");
    expect(first.content).toContain("## 다음 할 일\n\n- [ ] 할 일");
    expect(second.changed).toBe(false);
  });
});

describe("appendIdea", () => {
  it("groups ideas by capture date and deduplicates them", () => {
    const first = appendIdea("# 아이디어 인박스\n", "작은 실험", "2026-08-11");
    const second = appendIdea(first.content, "다른 실험", "2026-08-11");
    const duplicate = appendIdea(second.content, "작은 실험", "2026-08-11");
    expect(second.content).toContain(
      "## 2026-08-11\n\n- 다른 실험\n\n- 작은 실험",
    );
    expect(duplicate.changed).toBe(false);
  });
});

describe("completeTask", () => {
  it("checks the matching task while ignoring markdown and due markers", () => {
    const result = completeTask(
      "## 다음 할 일\n\n- [ ] **배포 확인** 📅 2026-08-12\n- [ ] 다른 작업\n",
      "배포 확인",
    );
    expect(result.changed).toBe(true);
    expect(result.content).toContain("- [x] **배포 확인** 📅 2026-08-12");
  });

  it("does not modify tasks outside the target section", () => {
    const result = completeTask("## 보류\n\n- [ ] 배포 확인\n", "배포 확인");
    expect(result.changed).toBe(false);
  });
});

it("normalizes task text like the Mac vault parser", () => {
  expect(normalizeTaskText("**배포 확인** 📅 8/12")).toBe("배포 확인");
});

describe("upsertAutoLog", () => {
  const DATE = "2026-10-11";
  const BODY = "### 코드\n- **todari-ops** 2건: feat: a; fix: b";
  const NEW_NOTE =
    "---\ntype: 데일리\n날짜: 2026-10-11\n---\n## 자동 기록\n\n### 코드\n- **todari-ops** 2건: feat: a; fix: b\n\n## 메모\n";

  it("creates the daily note with frontmatter and an empty 메모 section", () => {
    expect(upsertAutoLog(null, DATE, BODY)).toEqual({ content: NEW_NOTE, changed: true });
    expect(upsertAutoLog("\n", DATE, BODY).content).toBe(NEW_NOTE); // 빈 파일도 새 노트로 본다
  });

  it("replaces only the 자동 기록 section and keeps the text below it byte for byte", () => {
    const mine = "오늘은 배포가 많았다.  \n\n# 회의\n- 메모\n"; // 줄 끝 공백까지 사람이 쓴 그대로
    const next = "### 코드\n- **lvti** 1건: fix: c\n### 운영\n- 배포 1건 (lvti)";
    const result = upsertAutoLog(NEW_NOTE + mine, DATE, next);
    expect(result).toEqual({
      content: `---\ntype: 데일리\n날짜: 2026-10-11\n---\n## 자동 기록\n\n${next}\n\n## 메모\n${mine}`,
      changed: true,
    });
    expect(upsertAutoLog(result.content, DATE, next).changed).toBe(false);
  });

  it("stops at the next level-1 or level-2 heading, not at its own ### headings", () => {
    const note = `## 자동 기록\n\n${BODY}\n### 운영\n- 배포 1건\n# 회의\n- 사람이 쓴 메모\n`;
    expect(upsertAutoLog(note, DATE, BODY).content).toBe(
      `## 자동 기록\n\n${BODY}\n\n# 회의\n- 사람이 쓴 메모\n`,
    );
  });

  it("inserts the section after the frontmatter, or at the top when there is none", () => {
    expect(upsertAutoLog("---\ntags: [a]\n---\n\n아침 메모\n", DATE, BODY).content).toBe(
      `---\ntags: [a]\n---\n## 자동 기록\n\n${BODY}\n\n아침 메모\n`,
    );
    const template = "## 할 일\n- [ ] \n\n## 인박스\n\n## 메모\n";
    expect(upsertAutoLog(template, DATE, BODY).content).toBe(`## 자동 기록\n\n${BODY}\n\n${template}`);
  });

  it("adds no trailing whitespace and no extra blank lines at the end of the file", () => {
    // 둘 다 볼트 mutation 검증(git diff --check)이 거부한다.
    const messy = "### 코드  \n- **todari-ops** 2건: feat: a; fix: b \n\n";
    expect(upsertAutoLog("---\ntype: 데일리\n---\n", DATE, messy).content).toBe(
      `---\ntype: 데일리\n---\n## 자동 기록\n\n${BODY}\n`,
    );
    expect(upsertAutoLog(`## 자동 기록\n\n- 예전 기록\n\n\n`, DATE, messy).content).toBe(
      `## 자동 기록\n\n${BODY}\n`,
    );
  });

  it("writes nothing for an empty body", () => {
    expect(upsertAutoLog(NEW_NOTE, DATE, " \n")).toEqual({ content: NEW_NOTE, changed: false });
    expect(upsertAutoLog(null, DATE, "")).toEqual({ content: "", changed: false });
  });
});
