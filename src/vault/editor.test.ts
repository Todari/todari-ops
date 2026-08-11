import { describe, expect, it } from "vitest";
import {
  appendIdea,
  completeTask,
  insertTask,
  normalizeTaskText,
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
