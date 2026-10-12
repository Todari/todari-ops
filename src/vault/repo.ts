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

// 볼트 checkout 의 git 호출에 두는 제한 시간. 볼트 쓰기는 모두 한 큐에서 차례를 기다리므로
// 응답 없는 원격 하나(pull·push)가 큐 전체를 세우지 않게 한다.
export const VAULT_GIT_TIMEOUT_MS = 60_000;
// clone 은 레포 전체(첨부 포함)를 받는다. 느린 날에도 끝나도록 따로 넉넉히 둔다:
// 실패한 쓰기는 checkout 을 버리므로, clone 이 번번이 끊기면 그 뒤의 쓰기가 모두 실패한다.
const VAULT_CLONE_TIMEOUT_MS = 5 * 60_000;

export async function ensureVaultCheckout(): Promise<string> {
  const dir = await ensureCheckout("vault", VAULT_PROJECT, VAULT_CLONE_TIMEOUT_MS);
  await pullLatest(dir, VAULT_GIT_TIMEOUT_MS); // Mac과 봇 양쪽에서 바뀌므로 매 작업 전 최신화
  return dir;
}
