import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { env } from "../env.js";
import type { ProjectConfig } from "../projects.js";
import { githubAuthEnv } from "./checkout.js";

const execFileAsync = promisify(execFile);
export const isCommitSha = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{40}$/i.test(value);

export interface DiagnosisCheckout {
  cwd: string;
  sha: string;
  cleanup: () => Promise<void>;
}

// Each diagnosis owns a temporary clone. Never fetch/reset the user's /code
// checkout or the old diag-<slug> cache; concurrent alerts cannot move HEAD.
export async function prepareDiagnosisCheckout(
  project: ProjectConfig,
  sha?: string,
  signal?: AbortSignal,
): Promise<DiagnosisCheckout> {
  if (sha !== undefined && !isCommitSha(sha)) throw new Error("invalid diagnosis commit SHA");
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(project.slug)) throw new Error("invalid project slug");
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?$/.test(project.repoUrl)) {
    throw new Error("invalid diagnosis repository URL");
  }
  const root = path.resolve(env.WORK_DIR, ".diagnostics");
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, `${project.slug}-`));
  const cleanup = () => rm(cwd, { recursive: true, force: true });
  const git = async (...args: string[]): Promise<string> => {
    try {
      const result = await execFileAsync("git", [
        "-c", "core.hooksPath=/dev/null", "-c", "credential.helper=",
        "-c", "protocol.file.allow=never", "-c", "protocol.ext.allow=never",
        "-C", cwd, ...args,
      ], { env: githubAuthEnv(), timeout: 45_000, maxBuffer: 64 * 1024, signal });
      return result.stdout.trim();
    } catch {
      // Child errors include args/env/stderr. Never expose them in logs or chat.
      throw new Error(`diagnosis git ${args[0]} failed or timed out`);
    }
  };
  try {
    await git("init", "--quiet");
    await git("remote", "add", "origin", project.repoUrl);
    await git("check-ref-format", `refs/heads/${project.defaultBranch}`);
    await git("fetch", "--quiet", "--no-tags", "--depth=30", "origin",
      sha ?? `refs/heads/${project.defaultBranch}`);
    const actualSha = await git("rev-parse", "--verify", "FETCH_HEAD^{commit}");
    if (!isCommitSha(actualSha) || (sha && actualSha.toLowerCase() !== sha.toLowerCase())) {
      throw new Error("diagnosis checkout SHA mismatch");
    }
    await git("checkout", "--quiet", "--detach", actualSha);
    return { cwd, sha: actualSha.toLowerCase(), cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
