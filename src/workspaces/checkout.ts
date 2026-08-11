import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { env } from "../env.js";
import type { ProjectConfig } from "../projects.js";

export function getWorkDir(threadId: string): string {
  return path.join(env.WORK_DIR, threadId);
}

export async function ensureCheckout(
  threadId: string,
  project: ProjectConfig,
): Promise<string> {
  const dir = getWorkDir(threadId);
  if (existsSync(path.join(dir, ".git"))) {
    return dir;
  }
  await mkdir(dir, { recursive: true });
  await runGit(
    ["clone", "--branch", project.defaultBranch, project.repoUrl, dir],
    githubAuthEnv(),
  );
  return dir;
}

export function githubAuthEnv(token = env.GITHUB_TOKEN): NodeJS.ProcessEnv {
  const gitEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
  };
  if (!token) return gitEnv;

  const credentials = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    ...gitEnv,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${credentials}`,
  };
}

// 이미 clone된 checkout을 원격 최신으로 fast-forward한다. 볼트처럼 계속 바뀌는
// 레포를 매 작업 전 최신 상태로 맞추기 위해 쓴다. ff-only라 로컬 커밋이 갈라지면
// 실패하며, 볼트 mutation layer는 그 경우 전용 캐시를 폐기하고 다시 clone한다.
export async function pullLatest(dir: string): Promise<void> {
  await runGit(
    ["-C", dir, "pull", "--ff-only", "--quiet"],
    githubAuthEnv(),
  );
}

function runGit(args: string[], gitEnv: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn("git", args, { env: gitEnv, stdio: "inherit" });
    p.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git ${args[0]} exited ${code}`));
    });
    p.on("error", reject);
  });
}
