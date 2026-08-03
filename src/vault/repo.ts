import { env } from "../env.js";
import { ensureCheckout, pullLatest } from "../workspaces/checkout.js";
import type { ProjectConfig } from "../projects.js";

// 옵시디언 볼트(지식베이스)를 봇이 읽기 위한 레포. 코드가 아니라 지식이므로
// projects.ts(=/code·코드베이스 Q&A 라우팅)와 분리해 둔다. 맥에서 obsidian-git이
// 30분마다 커밋·푸시하므로, 봇은 clone 후 매번 pull 해 최신 볼트를 읽는다.
export const VAULT_PROJECT: ProjectConfig = {
  slug: "vault",
  name: "Obsidian Vault",
  repoUrl: env.VAULT_REPO_URL,
  defaultBranch: "main",
};

export async function ensureVaultCheckout(): Promise<string> {
  const dir = await ensureCheckout("vault", VAULT_PROJECT);
  await pullLatest(dir); // 볼트는 계속 바뀌므로 항상 최신화
  return dir;
}
