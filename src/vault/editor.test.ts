import { describe, expect, it } from "vitest";
import {
  appendIdea,
  completeTask,
  dropTask,
  findOpenTask,
  insertTask,
  normalizeTaskText,
  setTaskDue,
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

describe("tidying a task line", () => {
  const NOTE = [
    "# todari-ops",
    "",
    "## 다음 할 일",
    "",
    "- [ ] **배포 확인**",
    "- [ ] 결제 오류 📅 8/12 재현하기",
    "* [ ] [[가격 정책]] 정리 📅 2026-09-01  ", // 줄 끝 공백 두 칸
    "- [x] 끝낸 일",
    "",
    "## 보류",
    "- [ ] 구획 밖의 일",
    "",
  ].join("\n");
  const line = (content: string, n: number) => content.split("\n")[n];

  it("finds the open checkbox by the text the vault snapshot carries, inside 다음 할 일 only", () => {
    const lines = NOTE.split("\n");
    expect(findOpenTask(lines, "배포 확인")).toBe(4);
    expect(findOpenTask(lines, "결제 오류 재현하기")).toBe(5);
    expect(findOpenTask(lines, "가격 정책 정리")).toBe(6);
    for (const missing of ["끝낸 일", "구획 밖의 일", "없는 일", ""]) expect(findOpenTask(lines, missing)).toBe(-1);
  });

  it("matches a line longer than the snapshot's 300 characters by its cut text", () => {
    const long = `긴 할 일 ${"가나다라마바사 ".repeat(50)}끝`;
    const note = `## 다음 할 일\n- [ ] 짧은 일\n- [ ] **${long}** 📅 2026-10-01\n`;
    const snapshot = normalizeTaskText(long).slice(0, 300).trim(); // 스냅샷은 여기까지만 안다
    expect(long.length).toBeGreaterThan(300);
    expect(findOpenTask(note.split("\n"), snapshot)).toBe(2);
    expect(findOpenTask(note.split("\n"), long)).toBe(2);
    expect(completeTask(note, snapshot).content).toContain(`- [x] **${long}** 📅 2026-10-01`);
    expect(findOpenTask(note.split("\n"), snapshot.slice(0, 250))).toBe(-1); // 앞부분이 같다고 같은 할 일은 아니다
  });

  it("setTaskDue appends the date to a plain line and leaves every other line alone", () => {
    const result = setTaskDue(NOTE, "배포 확인", "2026-10-23");
    expect(result.changed).toBe(true);
    expect(line(result.content, 4)).toBe("- [ ] **배포 확인** 📅 2026-10-23");
    expect(result.content.split("\n").filter((_, i) => i !== 4)).toEqual(NOTE.split("\n").filter((_, i) => i !== 4));
  });

  it("setTaskDue replaces an existing 📅 date where it stands, in either date form", () => {
    expect(line(setTaskDue(NOTE, "결제 오류 재현하기", "2026-10-23").content, 5)).toBe(
      "- [ ] 결제 오류 📅 2026-10-23 재현하기",
    );
    // 줄 끝 공백은 볼트 mutation 검증(git diff --check)이 거부하므로 고친 줄에서는 뗀다.
    expect(line(setTaskDue(NOTE, "가격 정책 정리", "2026-10-23").content, 6)).toBe(
      "* [ ] [[가격 정책]] 정리 📅 2026-10-23",
    );
  });

  it("setTaskDue rewrites only the last 📅 when the line carries two", () => {
    const note = [
      "## 다음 할 일",
      "- [ ] 견적 📅 9/1 받은 것 다시 요청 📅 2026-09-20",
      "- [ ] 📅 2026-08-12 발표 자료 📅 9/1 까지 정리",
    ].join("\n");
    expect(line(setTaskDue(note, "견적 받은 것 다시 요청", "2026-10-23").content, 1)).toBe(
      "- [ ] 견적 📅 9/1 받은 것 다시 요청 📅 2026-10-23",
    );
    expect(line(setTaskDue(note, "발표 자료 까지 정리", "2026-10-23").content, 2)).toBe(
      "- [ ] 📅 2026-08-12 발표 자료 📅 2026-10-23 까지 정리",
    );
  });

  it("dropTask marks the line cancelled with the date, keeping the text and an existing 📅", () => {
    expect(line(dropTask(NOTE, "배포 확인", "2026-10-16").content, 4)).toBe("- [-] **배포 확인** ❌ 2026-10-16");
    const dated = dropTask(NOTE, "가격 정책 정리", "2026-10-16");
    expect(line(dated.content, 6)).toBe("* [-] [[가격 정책]] 정리 📅 2026-09-01 ❌ 2026-10-16");
    // 버린 줄은 더 이상 열린 할 일이 아니다.
    expect(findOpenTask(dated.content.split("\n"), "가격 정책 정리")).toBe(-1);
    expect(dropTask(dated.content, "가격 정책 정리", "2026-10-16").changed).toBe(false);
  });

  it("leaves the note unchanged when the line is missing, done, outside the section or already so", () => {
    for (const missing of ["없는 일", "끝낸 일", "구획 밖의 일"]) {
      expect(setTaskDue(NOTE, missing, "2026-10-23")).toEqual({ content: NOTE, changed: false });
      expect(dropTask(NOTE, missing, "2026-10-16")).toEqual({ content: NOTE, changed: false });
    }
    // 이미 그 날짜가 적힌 줄을 다시 쓰면 빈 커밋이 되어 mutation 이 실패한다.
    const dated = setTaskDue(NOTE, "배포 확인", "2026-10-23").content;
    expect(setTaskDue(dated, "배포 확인", "2026-10-23")).toEqual({ content: dated, changed: false });
  });
});

it("normalizes task text like the Mac vault parser", () => {
  expect(normalizeTaskText("**배포 확인** 📅 8/12")).toBe("배포 확인");
});

describe("upsertAutoLog", () => {
  const BODY = "### 코드\n- **todari-ops** 2건: feat: a; fix: b";
  const NEXT = `${BODY}\n### 운영\n- 배포 1건 (lvti)`;
  const NEW_NOTE = `## 자동 기록\n\n${BODY}\n\n## 메모\n`;
  const TEMPLATE = "## 할 일\n- [ ] \n\n## 인박스\n\n## 메모\n"; // 볼트의 템플릿/데일리.md

  it("creates a note of just the 자동 기록 section and an empty 메모, with nothing above the first heading", () => {
    expect(upsertAutoLog(null, BODY)).toEqual({ content: NEW_NOTE, changed: true });
    expect(upsertAutoLog("\n", BODY).content).toBe(NEW_NOTE); // 빈 파일도 새 노트로 본다
  });

  it("replaces only the 자동 기록 section and keeps the text below it byte for byte", () => {
    const mine = "오늘은 배포가 많았다.  \n\n# 회의\n- 메모"; // 줄 끝 공백도, 끝에 줄바꿈이 없는 것도 그대로
    const result = upsertAutoLog(NEW_NOTE + mine, NEXT);
    expect(result).toEqual({ content: `## 자동 기록\n\n${NEXT}\n\n## 메모\n${mine}`, changed: true });
    expect(upsertAutoLog(result.content, NEXT).changed).toBe(false);
  });

  it("stops at the next level-1 or level-2 heading, not at its own ### headings", () => {
    const note = `## 자동 기록\n\n${NEXT}\n# 회의\n- 사람이 쓴 메모\n`;
    expect(upsertAutoLog(note, BODY).content).toBe(`## 자동 기록\n\n${BODY}\n\n# 회의\n- 사람이 쓴 메모\n`);
  });

  it("puts a missing section at the very top and leaves the rest of the note byte for byte", () => {
    expect(upsertAutoLog(TEMPLATE, BODY).content).toBe(`## 자동 기록\n\n${BODY}\n\n${TEMPLATE}`);
    const loose = "\n아침 메모  \n## 할 일\n- [ ] 장보기"; // 빈 줄로 시작하고 줄바꿈 없이 끝난다
    expect(upsertAutoLog(loose, BODY).content).toBe(`## 자동 기록\n\n${BODY}\n${loose}`);
    // 사람이 둔 frontmatter 는 맨 위에 있어야만 frontmatter 다. 그 바로 뒤에 넣는다.
    expect(upsertAutoLog("---\ntags: [a]\n---\n\n아침 메모\n", BODY).content).toBe(
      `---\ntags: [a]\n---\n## 자동 기록\n\n${BODY}\n\n아침 메모\n`,
    );
  });

  it("still owns exactly its section after a union merge joined its note with the Mac's", () => {
    // 볼트는 데일리/*.md 를 git union 드라이버로 병합한다: 양쪽이 같은 날 노트를 만들면 줄이 이어 붙는다.
    for (const merged of [TEMPLATE + NEW_NOTE, NEW_NOTE + TEMPLATE]) {
      expect(upsertAutoLog(merged, NEXT).content).toBe(merged.replace(BODY, NEXT));
    }
  });

  it("adds no trailing whitespace and no extra blank lines at the end of the file", () => {
    // 둘 다 볼트 mutation 검증(git diff --check)이 거부한다.
    const messy = "### 코드  \n- **todari-ops** 2건: feat: a; fix: b \n\n";
    expect(upsertAutoLog(null, messy).content).toBe(NEW_NOTE);
    expect(upsertAutoLog("## 자동 기록\n\n- 예전 기록\n\n\n", messy).content).toBe(`## 자동 기록\n\n${BODY}\n`);
    expect(upsertAutoLog("---\ntags: [a]\n---", messy).content).toBe(`---\ntags: [a]\n---\n## 자동 기록\n\n${BODY}\n`);
  });

  it("writes nothing for an empty body", () => {
    expect(upsertAutoLog(NEW_NOTE, " \n")).toEqual({ content: NEW_NOTE, changed: false });
    expect(upsertAutoLog(null, "")).toEqual({ content: "", changed: false });
  });
});
