const TASK_HEADING = "## 다음 할 일";
const DATE_MARKER_RE = /📅\s*(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2})/g;

export interface EditResult {
  content: string;
  changed: boolean;
}

export function cleanCaptureText(value: string, max = 500): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

export function insertTask(content: string, rawText: string): EditResult {
  const text = cleanCaptureText(rawText);
  if (!text) return { content, changed: false };

  const checkbox = `- [ ] ${text}`;
  if (content.split(/\r?\n/).some((line) => line.trim() === checkbox)) {
    return { content, changed: false };
  }

  const normalized = content.replace(/\r\n/g, "\n").replace(/\s+$/, "");
  const lines = normalized ? normalized.split("\n") : [];
  const heading = lines.findIndex((line) => line.trim() === TASK_HEADING);

  if (heading < 0) {
    const prefix = normalized ? normalized + "\n\n" : "";
    return {
      content: `${prefix}${TASK_HEADING}\n\n${checkbox}\n`,
      changed: true,
    };
  }

  lines.splice(heading + 1, 0, "", checkbox);
  return {
    content: collapseBlankLines(lines.join("\n")) + "\n",
    changed: true,
  };
}

export function appendIdea(
  content: string,
  rawText: string,
  date: string,
): EditResult {
  const text = cleanCaptureText(rawText, 1000);
  if (!text) return { content, changed: false };
  const bullet = `- ${text}`;
  if (content.split(/\r?\n/).some((line) => line.trim() === bullet)) {
    return { content, changed: false };
  }

  const normalized = content.replace(/\r\n/g, "\n").replace(/\s+$/, "");
  const lines = normalized ? normalized.split("\n") : [];
  const heading = `## ${date}`;
  const index = lines.findIndex((line) => line.trim() === heading);
  if (index >= 0) {
    lines.splice(index + 1, 0, "", bullet);
    return { content: collapseBlankLines(lines.join("\n")) + "\n", changed: true };
  }

  const prefix = normalized ? normalized + "\n\n" : "";
  return {
    content: `${prefix}${heading}\n\n${bullet}\n`,
    changed: true,
  };
}

export function completeTask(content: string, expectedText: string): EditResult {
  const expected = normalizeTaskText(expectedText);
  if (!expected) return { content, changed: false };

  const lines = content.replace(/\r\n/g, "\n").split("\n");
  let inside = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (/^##\s+/.test(line)) {
      inside = line.trim() === TASK_HEADING;
      continue;
    }
    if (!inside) continue;
    const match = line.match(/^(\s*[-*]\s+)\[ \](\s+)(.+)$/);
    if (!match || normalizeTaskText(match[3] ?? "") !== expected) continue;
    lines[i] = `${match[1]}[x]${match[2]}${match[3]}`;
    return { content: lines.join("\n"), changed: true };
  }
  return { content, changed: false };
}

export function normalizeTaskText(value: string): string {
  return value
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\[\[(.+?)\]\]/g, "$1")
    .replace(DATE_MARKER_RE, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s\-·]+|[\s\-·]+$/g, "");
}

function collapseBlankLines(value: string): string {
  return value.replace(/\n{3,}/g, "\n\n");
}

const AUTO_LOG_HEADING = "## 자동 기록";

/**
 * 데일리 노트에서 봇이 쓰는 `## 자동 기록` 구획만 갈아 끼운다(다음 `# `·`## ` 제목 앞까지).
 * 구획 밖의 글은 바이트 그대로 둔다. 구획이 없으면 노트 맨 위에 넣고, 노트가 없으면(null·빈 파일)
 * 구획과 빈 `## 메모`만으로 새 노트를 만든다.
 *
 * 맥과 봇이 같은 날의 노트를 따로 만들거나 고치면 볼트가 양쪽 줄을 이어 붙인다(git union 병합).
 * 그래서 frontmatter 처럼 파일 맨 위에 있어야만 뜻이 통하는 것은 쓰지 않고, 제목으로 시작하는 구획만 쓴다.
 */
export function upsertAutoLog(content: string | null, body: string): EditResult {
  if (!body.trim()) return { content: content ?? "", changed: false };
  // 줄 끝 공백과 파일 끝에 늘어난 빈 줄은 mutation 검증(git diff --check)에 걸려 기록이 통째로 버려진다.
  const block = [AUTO_LOG_HEADING, "", ...body.trim().split("\n").map((line) => line.trimEnd())];
  if (!content?.trim()) {
    return { content: [...block, "", "## 메모", ""].join("\n"), changed: true };
  }

  const lines = content.split("\n");
  let start = lines.findIndex((line) => line.trim() === AUTO_LOG_HEADING);
  let end: number;
  if (start >= 0) {
    const nextHeading = lines.findIndex((line, i) => i > start && /^#{1,2} /.test(line));
    end = nextHeading < 0 ? lines.length : nextHeading;
  } else {
    // 구획이 아직 없다: 노트 맨 위에 넣는다. 사람이 둔 frontmatter 가 있으면 깨지지 않게 그 바로 뒤에.
    start = end = lines[0]?.trim() === "---" ? lines.indexOf("---", 1) + 1 : 0;
  }
  const after = lines.slice(end);
  // 뒤따르는 글과는 한 줄 띄우고(이미 빈 줄이면 그대로), 구획이 파일의 끝이면 줄바꿈으로 닫는다.
  // 뒤에 글이 있으면 그 글은 끝의 줄바꿈 유무까지 그대로다.
  if (after.length === 0 || after[0]?.trim()) block.push("");
  const updated = [...lines.slice(0, start), ...block, ...after].join("\n");
  return { content: updated, changed: updated !== content };
}
