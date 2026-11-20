import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ GITHUB_TOKEN: "", VAULT_REPO_URL: "" }));
vi.mock("../env.js", () => ({ env }));

it("checks the configured source branch against a real local Git remote", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "vault-remote-test-"));
  env.VAULT_REPO_URL = cwd;
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  try {
    git("init", "-b", "main");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "fixture");
    const revision = git("rev-parse", "HEAD");
    const { getVaultRemoteRevision } = await import("./repo.js");
    expect(await getVaultRemoteRevision()).toBe(revision);
    git("branch", "-m", "different-branch");
    await expect(getVaultRemoteRevision()).rejects.toThrow(/^vault remote revision unavailable$/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
