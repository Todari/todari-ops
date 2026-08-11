import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { env } from "../env.js";
import { captureException } from "../observability/sentry.js";
import { githubAuthEnv } from "../workspaces/checkout.js";
import { appendIdea, completeTask, insertTask } from "./editor.js";
import { ensureVaultCheckout } from "./repo.js";
import { todayKst } from "./state.js";

export type VaultCaptureKind = "task" | "idea" | "note";

export interface VaultTaskRef {
  projectSlug: string;
  note: string;
  text: string;
}

export interface VaultMutationResult {
  changed: boolean;
  path?: string;
  summary: string;
  commit?: string;
}

const BOT_NAME = "todari-ops[bot]";
const BOT_EMAIL = "todari-ops@users.noreply.github.com";
const NOTE_TIMEOUT_MS = 4 * 60_000;
const MAX_CHANGED_FILES = 3;
const MAX_CHANGED_LINES = 200;
const ALLOWED_ROOTS = new Set([
  "프로젝트",
  "이정표",
  "포크레터",
  "공부",
  "창",
  "회고",
  "데일리",
]);

let mutationQueue: Promise<void> = Promise.resolve();

export function applyVaultCapture(
  kind: VaultCaptureKind,
  projectSlug: string | undefined,
  text: string,
): Promise<VaultMutationResult> {
  return serialize(() => applyVaultCaptureNow(kind, projectSlug, text));
}

export function completeVaultTask(ref: VaultTaskRef): Promise<VaultMutationResult> {
  return serialize(() => completeVaultTaskNow(ref));
}

export function noteNameForProject(projectSlug: string | undefined): string {
  if (projectSlug === "jeongpyo") return "이정표";
  if (projectSlug === "forcletter") return "포크레터";
  return projectSlug || "todari-ops";
}

async function serialize<T>(work: () => Promise<T>): Promise<T> {
  const run = mutationQueue.then(work, work);
  mutationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function applyVaultCaptureNow(
  kind: VaultCaptureKind,
  projectSlug: string | undefined,
  text: string,
): Promise<VaultMutationResult> {
  const dir = await prepareVault();
  try {
    let summary = "";
    let displayPath: string | undefined;

    if (kind === "task") {
      const relative = taskNotePath(projectSlug);
      const file = await resolveExistingPath(dir, relative);
      const previous = await readFile(file, "utf8");
      const edit = insertTask(previous, text);
      if (!edit.changed) {
        return { changed: false, path: relative, summary: "이미 같은 할 일이 있습니다." };
      }
      await writeFile(file, edit.content);
      summary = `할 일을 ${relative}에 추가했습니다.`;
      displayPath = relative;
    } else if (kind === "idea") {
      const relative = "창/아이디어 인박스.md";
      const file = await resolveCreatablePath(dir, relative);
      let previous = "";
      try {
        previous = await readFile(file, "utf8");
      } catch {
        previous = [
          "---",
          "type: 프로젝트",
          "상태: 아이디어",
          "스택:",
          "도메인:",
          "레포:",
          "---",
          "",
          "# 아이디어 인박스",
          "",
        ].join("\n");
      }
      const edit = appendIdea(previous, text, todayKst());
      if (!edit.changed) {
        return { changed: false, path: relative, summary: "이미 같은 아이디어가 있습니다." };
      }
      await writeFile(file, edit.content);
      summary = `아이디어를 ${relative}에 추가했습니다.`;
      displayPath = relative;
    } else {
      summary = await editVaultWithAgent(dir, projectSlug, text);
    }

    const files = await validateChanges(dir);
    if (files.length === 0) {
      return { changed: false, summary: summary || "바꿀 내용을 찾지 못했습니다." };
    }
    const commit = await commitAndPush(dir, files, `vault: capture ${kind} via todari-ops`);
    return {
      changed: true,
      ...(displayPath ? { path: displayPath } : {}),
      summary,
      commit,
    };
  } catch (err) {
    await discardVaultCheckout(dir).catch(() => undefined);
    captureException(err, { kind: "vault-mutation", captureKind: kind, projectSlug });
    throw err;
  }
}

async function completeVaultTaskNow(ref: VaultTaskRef): Promise<VaultMutationResult> {
  const dir = await prepareVault();
  try {
    const relative = taskNotePath(ref.projectSlug, ref.note);
    const file = await resolveExistingPath(dir, relative);
    const previous = await readFile(file, "utf8");
    const edit = completeTask(previous, ref.text);
    if (!edit.changed) {
      return {
        changed: false,
        path: relative,
        summary: "완료할 체크박스를 찾지 못했습니다.",
      };
    }
    await writeFile(file, edit.content);
    const files = await validateChanges(dir);
    const commit = await commitAndPush(dir, files, "vault: complete task via todari-ops");
    return {
      changed: true,
      path: relative,
      summary: `${relative}의 할 일을 완료 처리했습니다.`,
      commit,
    };
  } catch (err) {
    await discardVaultCheckout(dir).catch(() => undefined);
    captureException(err, { kind: "vault-task-complete", projectSlug: ref.projectSlug });
    throw err;
  }
}

async function prepareVault(): Promise<string> {
  const expected = path.resolve(env.WORK_DIR, "vault");
  try {
    const dir = await ensureVaultCheckout();
    if (path.resolve(dir) !== expected) {
      throw new Error("unexpected vault checkout path");
    }
    const dirty = await git(dir, ["status", "--porcelain=v1"]);
    if (dirty.trim()) {
      throw new Error("vault checkout has uncommitted changes");
    }
    return dir;
  } catch (err) {
    await discardVaultCheckout(expected).catch(() => undefined);
    throw err;
  }
}

function taskNotePath(projectSlug: string | undefined, note?: string): string {
  if (projectSlug === "jeongpyo") return "이정표/이정표.md";
  if (projectSlug === "forcletter") return "포크레터/포크레터.md";
  return `프로젝트/${note || projectSlug || "todari-ops"}.md`;
}

async function resolveExistingPath(root: string, relative: string): Promise<string> {
  const parts = relative.split("/");
  let current = root;
  for (const part of parts) {
    const entries = await readdir(current);
    const match = entries.find(
      (entry) => entry.normalize("NFC") === part.normalize("NFC"),
    );
    if (!match) throw new Error(`vault path not found: ${relative}`);
    current = path.join(current, match);
  }
  return current;
}

async function resolveCreatablePath(root: string, relative: string): Promise<string> {
  const parts = relative.split("/");
  const leaf = parts.pop();
  if (!leaf) throw new Error("invalid vault path");
  const parent = await resolveExistingPath(root, parts.join("/"));
  await mkdir(parent, { recursive: true });
  const entries = await readdir(parent);
  const existing = entries.find(
    (entry) => entry.normalize("NFC") === leaf.normalize("NFC"),
  );
  return path.join(parent, existing ?? leaf.normalize("NFD"));
}

async function editVaultWithAgent(
  dir: string,
  projectSlug: string | undefined,
  instruction: string,
): Promise<string> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), NOTE_TIMEOUT_MS);
  const prompt = [
    "사용자의 Obsidian 볼트에 대한 한 가지 편집 지시를 수행한다.",
    projectSlug ? `관련 프로젝트 slug: ${projectSlug}` : "관련 프로젝트: 내용에서 보수적으로 판단",
    `지시: ${instruction}`,
    "",
    "규칙:",
    "- 먼저 관련 Markdown을 찾아 읽고 가장 작은 가역적 수정만 한다.",
    "- Markdown 파일 최대 3개만 Edit/Write 한다.",
    "- 삭제·대규모 재구성·첨부파일·.obsidian 수정은 금지한다.",
    "- 대상이나 의도가 모호하면 아무 파일도 수정하지 말고 이유만 답한다.",
    "- 비밀값을 기록하지 않는다.",
    "- 완료 후 변경한 파일과 before→after 요지를 짧게 답한다.",
  ].join("\n");

  const options = {
    cwd: dir,
    abortController: abort,
    ...(env.CLAUDE_MODEL ? { model: env.CLAUDE_MODEL } : {}),
    permissionMode: "default",
    maxTurns: 20,
    canUseTool: async (toolName: string, toolInput: unknown) => {
      if (["Read", "Glob", "Grep"].includes(toolName)) {
        return { behavior: "allow", updatedInput: toolInput };
      }
      if (["Edit", "Write"].includes(toolName)) {
        const input = toolInput as { file_path?: unknown };
        if (
          typeof input.file_path === "string" &&
          await isAllowedMarkdownTarget(dir, input.file_path)
        ) {
          return { behavior: "allow", updatedInput: toolInput };
        }
        return {
          behavior: "deny",
          message: "vault mutation only permits Markdown files in approved vault folders",
        };
      }
      return { behavior: "deny", message: "vault mutation allows Markdown edits only" };
    },
  } as Options;

  let result = "";
  try {
    for await (const message of query({ prompt, options })) {
      const m = message as { type?: string; result?: string };
      if (m.type === "result" && typeof m.result === "string") result = m.result;
    }
  } finally {
    clearTimeout(timer);
  }
  return result.trim().slice(0, 1200) || "볼트 지시를 반영했습니다.";
}

async function isAllowedMarkdownTarget(root: string, candidate: string): Promise<boolean> {
  if (!isAllowedVaultMarkdownPath(root, candidate)) return false;
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, candidate);
  try {
    const parent = await realpath(path.dirname(resolved));
    const parentRelative = path.relative(resolvedRoot, parent);
    if (parentRelative.startsWith("..") || path.isAbsolute(parentRelative)) return false;
    const info = await lstat(resolved).catch(() => null);
    return !info?.isSymbolicLink();
  } catch {
    return false;
  }
}

export function isAllowedVaultMarkdownPath(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, candidate);
  const relative = path.relative(resolvedRoot, resolved).normalize("NFC").replaceAll("\\", "/");
  const [top] = relative.split("/");
  return Boolean(
    relative &&
    !relative.startsWith("../") &&
    !path.isAbsolute(relative) &&
    relative.endsWith(".md") &&
    top &&
    ALLOWED_ROOTS.has(top),
  );
}

async function validateChanges(dir: string): Promise<string[]> {
  const raw = await git(dir, ["status", "--porcelain=v1", "-z"]);
  const entries = raw.split("\0").filter(Boolean);
  if (entries.length > MAX_CHANGED_FILES) {
    throw new Error(`vault mutation changed too many files: ${entries.length}`);
  }

  const files: string[] = [];
  for (const entry of entries) {
    const statusCode = entry.slice(0, 2);
    const file = entry.slice(3);
    if (!file || /[DRC]/.test(statusCode)) {
      throw new Error(`vault mutation contains a destructive change: ${statusCode}`);
    }
    const normalized = file.normalize("NFC").replaceAll("\\", "/");
    const [root] = normalized.split("/");
    if (
      !normalized.endsWith(".md") ||
      normalized.includes("../") ||
      !root ||
      !ALLOWED_ROOTS.has(root)
    ) {
      throw new Error(`vault mutation touched a forbidden path: ${normalized}`);
    }
    files.push(file);
  }

  if (files.length === 0) return [];
  await git(dir, ["diff", "--check", "--", ...files]);
  let changedLines = 0;
  for (const file of files) {
    const full = path.join(dir, file);
    const info = await stat(full);
    if (info.size > 512_000) {
      throw new Error(`vault mutation file is too large: ${file}`);
    }
    if (entries.some((entry) => entry.startsWith("??") && entry.slice(3) === file)) {
      changedLines += (await readFile(full, "utf8")).split("\n").length;
    }
  }
  const numstat = await git(dir, ["diff", "--numstat", "--", ...files]);
  for (const line of numstat.trim().split("\n").filter(Boolean)) {
    const [added, deleted] = line.split("\t");
    changedLines += Number(added || 0) + Number(deleted || 0);
  }
  if (changedLines > MAX_CHANGED_LINES) {
    throw new Error(`vault mutation is too large: ${changedLines} lines`);
  }
  return files;
}

async function commitAndPush(
  dir: string,
  files: string[],
  message: string,
): Promise<string> {
  await git(dir, ["add", "--", ...files]);
  await git(dir, [
    "-c",
    `user.name=${BOT_NAME}`,
    "-c",
    `user.email=${BOT_EMAIL}`,
    "commit",
    "-m",
    message,
  ]);
  try {
    await git(dir, ["push", "origin", "main"]);
  } catch (firstError) {
    try {
      await git(dir, ["pull", "--rebase", "origin", "main"]);
      await git(dir, ["push", "origin", "main"]);
    } catch (retryError) {
      await git(dir, ["rebase", "--abort"]).catch(() => undefined);
      throw new Error(
        `vault push conflict: ${errorMessage(retryError)} (first: ${errorMessage(firstError)})`,
      );
    }
  }
  return (await git(dir, ["rev-parse", "--short", "HEAD"])).trim();
}

async function discardVaultCheckout(dir: string): Promise<void> {
  const expected = path.resolve(env.WORK_DIR, "vault");
  const resolved = path.resolve(dir);
  if (resolved !== expected || path.basename(resolved) !== "vault") {
    throw new Error("refusing to discard an unexpected vault path");
  }
  // 이 checkout은 봇 전용 캐시다. push 실패 뒤 로컬 커밋이 다음 요청에
  // 섞이지 않도록 정확한 캐시 경로만 버리고 다음 요청에서 다시 clone한다.
  await rm(resolved, { recursive: true, force: true });
}

function git(dir: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: dir,
      env: githubAuthEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`git ${args[0]} exited ${code}: ${stderr.trim()}`));
    });
  });
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
