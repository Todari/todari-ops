// 하루치 "한 일"의 근거를 모아 Markdown 으로 옮긴다. 밤의 자동 데일리 기록(index.ts)과
// 저녁 체크인의 "오늘 한 일 (지금까지)"가 같은 수집기를 쓴다. 봇이 이미 가진 근거만 쓰고
// 사람의 입력을 요구하지 않는다.

import { env } from "../env.js";
import { ghJson } from "../github/api.js";
import { findProjectByRepoFullName, projects, repoFullName } from "../projects.js";
import { eventsSince, type EventKind, type EventRecord } from "../stats/events.js";
import { listVaultNotesAdded } from "../vault/mutations.js";
import { VAULT_PROJECT } from "../vault/repo.js";

export interface DayWindow {
  start: number;
  end: number;
}

export interface RepoCommits {
  fullName: string;
  /** 소유자를 뗀 레포 이름. */
  repo: string;
  /** 커밋 메시지 첫 줄, 일어난 순서. */
  subjects: string[];
}

export interface DayEvidence {
  commits: RepoCommits[];
  /** 검색 한 번(100건)에 담기지 않아 레포별로 나누지 못한 커밋 수. */
  commitsBeyondPage: number;
  /** 커밋 검색이 실패해 그날의 커밋을 알 수 없다. commits 가 비어 있어도 "커밋이 없던 날"이 아니다. */
  commitsUnknown?: boolean;
  events: EventRecord[];
  /** 그날 볼트에 새로 생긴 노트 경로. */
  notes: string[];
  instagram?: string;
  jp?: string;
  /** 그날 아침에 고른 "오늘의 3개"와 완료 여부. */
  picks?: Array<{ note: string; text: string; done?: boolean }>;
  firstTask?: string;
}

export interface Section {
  title: string;
  lines: string[];
}

interface CommitSearchItem {
  repository?: { full_name?: string };
  /** 커밋 작성자에 연결된 GitHub 계정. 연결된 계정이 없으면 null. */
  author?: { login?: string } | null;
  commit?: { message?: string; committer?: { date?: string } };
}

const KST_MS = 9 * 3600_000;
const DAY_MS = 86_400_000;
const MAX_SUBJECTS = 5;
const MAX_LINKS = 10;
const NOTE_TYPES = ["의사결정", "TIL", "트러블슈팅"];
// 데일리는 이 기록 자신이고, 나머지 둘은 "그날 쓴 노트"가 아니다.
const SKIPPED_ROOTS = new Set(["데일리", "Archive", "템플릿"]);
// 적는 순서이기도 하다.
const EVENT_LABELS: Record<EventKind, string> = {
  vercel_deploy: "배포",
  vercel_fail: "배포 실패",
  ci_fail: "CI 실패",
  pr_opened: "PR 열림",
  pr_merged: "PR 머지",
  uptime_down: "장애",
  uptime_recover: "복구",
  sentry_alert: "Sentry",
  diag: "자동진단",
};

/** KST(UTC+9 고정, DST 없음) 하루의 [00:00, 24:00). */
export function kstDayWindow(date: string): DayWindow {
  const start = Date.parse(`${date}T00:00:00+09:00`);
  return { start, end: start + DAY_MS };
}

export function yesterdayKst(now = Date.now()): string {
  return new Date(now + KST_MS - DAY_MS).toISOString().slice(0, 10);
}

/** max 자로 자른다. 이모지(서로게이트 쌍)가 반으로 잘리면 Discord 가 요청을 거부하므로 통째로 뺀다. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, "") + "…";
}

/** 출처 하나가 실패해도 나머지 근거로 계속한다. */
export async function optional<T>(
  source: string,
  fallback: T,
  read: () => T | Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (err) {
    console.warn(`[daily-log] ${source} unavailable:`, err);
    return fallback;
  }
}

/** ms 안에 끝나지 않으면 null. 근거 수집이 늦어도 예약 게시는 제때 나가야 한다. */
export function within<T>(ms: number, work: Promise<T>): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** 커밋·운영 이벤트·새 볼트 노트 — 어느 날짜에나 다시 모을 수 있는 근거. */
export async function collectActivity(date: string): Promise<DayEvidence> {
  const window = kstDayWindow(date);
  const [found, notes] = await Promise.all([
    optional("commits", { commits: [], commitsBeyondPage: 0, commitsUnknown: true }, () => searchCommits(window)),
    optional("vault notes", [], () => listVaultNotesAdded(window.start, window.end)),
  ]);
  const events = await optional("events", [], () =>
    eventsSince(Date.now() - window.start).filter((event) => event.t < window.end),
  );
  return { ...found, events, notes };
}

/** 커밋한 레포를 볼트 노트와 견줄 이름으로: 카탈로그 프로젝트면 그 slug, 아니면 레포 이름. 커밋이 많은 순 그대로다. */
export function activeProjects(commits: RepoCommits[]): string[] {
  return commits.map((repo) => findProjectByRepoFullName(repo.fullName)?.slug ?? repo.repo);
}

/** 지난 days 일 동안 커밋한 프로젝트, 커밋이 많은 순. 아침의 고르기 메뉴가 최근 손댄 프로젝트를 앞세우는 데 쓴다. */
export async function recentlyActiveProjects(days: number): Promise<string[]> {
  const end = Date.now();
  return activeProjects((await searchCommits({ start: end - days * DAY_MS, end })).commits);
}

// GITHUB_TOKEN 주인의 로그인. 봇이 떠 있는 동안 바뀌지 않으므로 알아낸 뒤에는 다시 묻지 않는다.
let tokenLogin: string | undefined;

/** 커밋의 작성자로 볼 GitHub 로그인: DAILY_LOG_AUTHOR, 없으면 봇 토큰의 주인. 알아내지 못하면 undefined. */
async function authorLogin(): Promise<string | undefined> {
  if (env.DAILY_LOG_AUTHOR) return env.DAILY_LOG_AUTHOR;
  // 실패한 조회는 담아 두지 않는다. 다음 수집 때 다시 묻는다.
  tokenLogin ??= (await ghJson<{ login?: string }>("/user"))?.login || undefined;
  return tokenLogin;
}

async function searchCommits(
  window: DayWindow,
): Promise<Pick<DayEvidence, "commits" | "commitsBeyondPage" | "commitsUnknown">> {
  // 작성자로 찾는다. 소유자(user:)로 찾으면 조직 레포에 올라온 다른 사람·봇의 커밋까지 "한 일"로 적힌다.
  const author = await authorLogin();
  let owners = env.DAILY_LOG_OWNERS;
  // 작성자를 알 수 없을 때만 예전처럼 카탈로그 레포 소유자들의 레포 전체를 본다.
  if (!author && owners.length === 0) {
    owners = [...new Set(projects.flatMap((p) => repoFullName(p)?.split("/")[0] ?? []))];
  }
  if (!author && owners.length === 0) return { commits: [], commitsBeyondPage: 0 };
  const vaultRepo = repoFullName(VAULT_PROJECT);
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19) + "Z";
  // 볼트 자동 백업이 검색 한 쪽(100건)을 채우지 않게 질의에서부터 뺀다.
  const q = [
    ...(author ? [`author:${author}`] : []),
    ...owners.map((owner) => `user:${owner}`),
    ...(vaultRepo ? [`-repo:${vaultRepo}`] : []),
    `committer-date:${iso(window.start)}..${iso(window.end)}`,
  ].join(" ");
  const found = await ghJson<{ total_count?: number; items?: CommitSearchItem[] }>(
    `/search/commits?q=${encodeURIComponent(q)}&sort=committer-date&order=desc&per_page=100`,
  );
  // ghJson 은 실패(한도 초과·5xx·시간 초과)해도 던지지 않고 null 을 준다. "커밋이 없었다"와 섞이지 않게 알린다.
  if (!found) return { commits: [], commitsBeyondPage: 0, commitsUnknown: true };
  const items = found.items ?? [];
  // GitHub 은 없는 로그인의 author: 조건을 말없이 버리고 남의 커밋을 돌려준다(200). 그 로그인이 쓴 것만 남긴다.
  const mine = author
    ? items.filter((item) => item.author?.login?.toLowerCase() === author.toLowerCase())
    : items;
  return {
    commits: groupCommits(mine, window, vaultRepo),
    // 걸러진 것이 있으면 조건이 먹히지 않은 검색이다. 그때의 total_count 는 그 사람의 커밋 수가 아니다.
    commitsBeyondPage: mine.length < items.length ? 0 : Math.max(0, (found.total_count ?? 0) - items.length),
  };
}

/** 검색 결과를 레포별로 묶는다. 볼트 레포와 볼트 커밋(자동 백업·봇 기록)은 "한 일"이 아니라 뺀다. */
export function groupCommits(
  items: CommitSearchItem[],
  window: DayWindow,
  vaultRepo: string | null,
): RepoCommits[] {
  const byRepo = new Map<string, string[]>();
  for (const item of items) {
    const fullName = item.repository?.full_name;
    const subject = oneLine((item.commit?.message ?? "").split("\n")[0] ?? "");
    const at = Date.parse(item.commit?.committer?.date ?? "");
    // 검색 범위는 양 끝을 포함하므로 자정 정각 커밋이 이틀에 걸리지 않게 여기서 다시 자른다.
    if (!fullName || !subject || !(at >= window.start && at < window.end)) continue;
    if (fullName.toLowerCase() === vaultRepo?.toLowerCase() || /^vault(?: backup)?:/.test(subject)) {
      continue;
    }
    byRepo.set(fullName, [...(byRepo.get(fullName) ?? []), subject]);
  }
  // 검색 결과는 최신순이다. 기록은 일어난 순서로, 레포는 커밋이 많은 순으로 적는다.
  return [...byRepo]
    .map(([fullName, subjects]) => ({
      fullName,
      repo: fullName.split("/")[1] ?? fullName,
      subjects: subjects.reverse(),
    }))
    .sort((a, b) => b.subjects.length - a.subjects.length);
}

/** 새 노트를 종류별로 묶는다: 경로에 의사결정·TIL·트러블슈팅 폴더가 있으면 그 종류, 없으면 최상위 폴더. */
export function groupNotes(paths: string[]): Array<[type: string, names: string[]]> {
  const groups = new Map<string, string[]>();
  for (const raw of paths) {
    const dirs = raw.normalize("NFC").split("/");
    const name = (dirs.pop() ?? "").replace(/\.md$/, "");
    const top = dirs[0] ?? "루트";
    if (!name || SKIPPED_ROOTS.has(top) || top.startsWith(".")) continue;
    const type = NOTE_TYPES.find((t) => dirs.some((dir) => dir.endsWith(t))) ?? top;
    groups.set(type, [...(groups.get(type) ?? []), name]);
  }
  const rank = (type: string) => {
    const index = NOTE_TYPES.indexOf(type);
    return index < 0 ? NOTE_TYPES.length : index;
  };
  return [...groups].sort(([a], [b]) => rank(a) - rank(b));
}

/** 근거가 있는 구획만 돌려준다. 볼트 노트의 `### 제목`과 체크인 임베드의 칸이 된다. */
export function renderSections(e: DayEvidence): Section[] {
  const sections: Section[] = [
    { title: "코드", lines: commitLines(e) },
    { title: "운영", lines: eventLines(e.events) },
    { title: "인스타 게시", lines: instagramLines(e.instagram ?? "") },
    { title: "볼트", lines: groupNotes(e.notes).map(noteLine) },
    { title: "일본어", lines: e.jp ? [`- ${oneLine(e.jp)}`] : [] },
    // 체크박스(`- [ ]`)가 아닌 보통 글머리로 쓴다. 체크박스는 볼트에서 새 열린 할 일이 된다.
    {
      title: "오늘의 3개",
      lines: (e.picks ?? []).map((p) => `- ${p.done ? "✅" : "⬜"} ${oneLine(`${p.note} · ${p.text}`)}`),
    },
    { title: "내일 첫 작업", lines: e.firstTask ? [`- ${oneLine(e.firstTask)}`] : [] },
  ];
  return sections.filter((section) => section.lines.length > 0);
}

/** `## 자동 기록` 구획에 들어갈 본문. 근거가 하나도 없으면 빈 문자열. */
export function renderDailyLog(e: DayEvidence): string {
  return renderSections(e)
    .map((section) => [`### ${section.title}`, ...section.lines].join("\n"))
    .join("\n");
}

/** 아침 다이제스트에 싣는 한 줄. 예: `커밋 12 · 배포 3 · 새 노트 2` */
export function summarize(e: DayEvidence): string {
  const count = (kind: EventKind) => e.events.filter((event) => event.kind === kind).length;
  const counts: Array<[string, number]> = [
    ["커밋", e.commits.reduce((sum, repo) => sum + repo.subjects.length, e.commitsBeyondPage)],
    ["배포", count("vercel_deploy")],
    ["장애", count("uptime_down")],
    ["새 노트", groupNotes(e.notes).reduce((sum, [, names]) => sum + names.length, 0)],
  ];
  const parts = counts.filter(([, n]) => n > 0).map(([label, n]) => `${label} ${n}`);
  return parts.join(" · ") || "기록됨";
}

function commitLines(e: DayEvidence): string[] {
  const lines = e.commits.map(({ repo, subjects }) => {
    const shown = subjects.slice(0, MAX_SUBJECTS).map((subject) => clip(subject, 70));
    const more = subjects.length > MAX_SUBJECTS ? ` 외 ${subjects.length - MAX_SUBJECTS}건` : "";
    return `- **${repo}** ${subjects.length}건: ${shown.join("; ")}${more}`;
  });
  if (e.commitsBeyondPage > 0) {
    lines.push(`- 외 ${e.commitsBeyondPage}건 (GitHub 검색 한 번에 담기는 100건 밖)`);
  }
  return lines;
}

function eventLines(events: EventRecord[]): string[] {
  return (Object.keys(EVENT_LABELS) as EventKind[]).flatMap((kind) => {
    const hits = events.filter((event) => event.kind === kind);
    if (hits.length === 0) return [];
    const perProject = new Map<string, number>();
    for (const { project } of hits) {
      if (project) perProject.set(project, (perProject.get(project) ?? 0) + 1);
    }
    const names = [...perProject].map(([name, n]) => (n > 1 ? `${name}×${n}` : name)).join(", ");
    return [`- ${EVENT_LABELS[kind]} ${hits.length}건${names ? ` (${names})` : ""}`];
  });
}

// 실적 문구는 다음 날 기준("어제 게시: …")으로 온다. 그날의 노트에서 "어제"는 틀린 말이라 뗀다.
function instagramLines(brief: string): string[] {
  return brief.replace(/^어제 /, "").split("\n").filter((line) => line.trim());
}

function noteLine([type, names]: [string, string[]]): string {
  const links = names.slice(0, MAX_LINKS).map((name) => `[[${name}]]`).join(", ");
  const more = names.length > MAX_LINKS ? ` 외 ${names.length - MAX_LINKS}건` : "";
  return `- ${type}: ${links}${more}`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
