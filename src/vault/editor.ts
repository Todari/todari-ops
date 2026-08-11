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
