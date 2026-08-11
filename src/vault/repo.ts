import { env } from "../env.js";
import { ensureCheckout, pullLatest } from "../workspaces/checkout.js";
import type { ProjectConfig } from "../projects.js";

// 옵시디언 볼트(지식베이스) 전용 checkout. 코드가 아니라 지식이므로
// projects.ts(=/code·코드베이스 Q&A 라우팅)와 분리한다. Q&A는 읽기 전용이고,
// /task·/idea·/note만 제한된 mutation layer를 통해 커밋·push한다.
export const VAULT_PROJECT: ProjectConfig = {
  slug: "vault",
  name: "Obsidian Vault",
  repoUrl: env.VAULT_REPO_URL,
  defaultBranch: "main",
};

export async function ensureVaultCheckout(): Promise<string> {
  const dir = await ensureCheckout("vault", VAULT_PROJECT);
  await pullLatest(dir); // Mac과 봇 양쪽에서 바뀌므로 매 작업 전 최신화
  return dir;
}
