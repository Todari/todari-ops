export interface ProjectConfig {
  slug: string;
  name: string;
  /** Natural-language aliases accepted by the Discord router. */
  aliases?: string[];
  repoUrl: string;
  defaultBranch: string;
  description?: string;
  /** Production URL polled by the uptime monitor. Omit = not monitored. */
  healthUrl?: string;
  /** Extra Vercel project names when they differ from slug/repo basename. */
  vercelNames?: string[];
}

// Single source of truth for `/code <slug>` routing.
// Add/edit entries to expose new projects to the bot.
//
// Always use https://github.com/... URLs — the bot passes GITHUB_TOKEN in a
// process-scoped HTTP header without persisting it in the remote URL.
export const projects: ProjectConfig[] = [
  {
    slug: "dakbal",
    name: "닭발 헌터",
    aliases: ["닭발헌터", "give-me-a-chicken-foot"],
    repoUrl: "https://github.com/Todari/give-me-a-chicken-foot.git",
    defaultBranch: "main",
    description: "엽떡 닭발 재고 파인더 (Next.js + Playwright)",
  },
  {
    slug: "haengdong",
    name: "행동대장",
    aliases: ["행동대장", "2024-haeng-dong"],
    repoUrl: "https://github.com/Todari/2024-haeng-dong.git",
    defaultBranch: "main",
    healthUrl: "https://haengdong.todari.dev",
    // Vercel project serving 행동대장 is named with a typo.
    vercelNames: ["haegndong-client"],
    description: "모임 정산 (React + NestJS, Todari fork of woowacourse-teams)",
  },
  {
    slug: "metronomdeul",
    name: "메트로놈들",
    aliases: ["메트로놈들", "metro-nomedeul"],
    repoUrl: "https://github.com/Todari/metro-nomedeul.git",
    defaultBranch: "main",
    healthUrl: "https://metronomdeul.site",
    description: "실시간 협업 메트로놈 (Socket.IO + NestJS)",
  },
  {
    slug: "lvti",
    name: "LVTI",
    aliases: ["lovetype", "연애유형"],
    repoUrl: "https://github.com/Todari/lovetype.git",
    defaultBranch: "main",
    healthUrl: "https://lvti.my",
    description: "연애 성격 유형 테스트 (Next.js)",
  },
  {
    slug: "toksai",
    name: "톡사이",
    aliases: ["카카오톡 분석", "대화 분석", "toksai.todari.dev"],
    repoUrl: "https://github.com/Todari/toksai.git",
    defaultBranch: "main",
    healthUrl: "https://api.toksai.todari.dev/health",
    vercelNames: ["toksai"],
    description: "카카오톡 1:1 대화 관계 분석 (NestJS + Next.js)",
  },
  {
    slug: "trade-tower",
    name: "Trade Tower",
    aliases: ["trade tower", "트레이드타워"],
    repoUrl: "https://github.com/yeouido-penthouse-cattower/trade-tower.git",
    defaultBranch: "main",
    description: "AI 자동매매 플랫폼 (NestJS + Redis) — yeouido-penthouse-cattower org",
  },
  {
    slug: "react-pixel-ui",
    name: "React Pixel UI",
    aliases: ["react pixel ui", "픽셀UI"],
    repoUrl: "https://github.com/Todari/react-pixel-ui.git",
    defaultBranch: "main",
    healthUrl: "https://react-pixel-ui.vercel.app",
    description: "픽셀 아트 UI 라이브러리 (npm 패키지)",
  },
  {
    slug: "todari",
    name: "Todari",
    aliases: ["포트폴리오", "todari.dev"],
    repoUrl: "https://github.com/Todari/todari.git",
    defaultBranch: "main",
    healthUrl: "https://todari.dev",
    description: "포트폴리오 사이트 (Next.js + Three.js)",
  },
  {
    slug: "jeongpyo",
    name: "이정표",
    aliases: ["basetie", "이정표"],
    repoUrl: "https://github.com/Todari/jeongpyo.git",
    defaultBranch: "main",
    description: "KBO 티켓 팬투팬 정가 양도 (Go+RN+Next) — 모두의 창업. 로컬 dir은 basetie",
  },
  {
    slug: "forcletter",
    name: "포크레터",
    aliases: ["for-creator", "포크레터"],
    repoUrl: "https://github.com/linkive/for-creator.git",
    defaultBranch: "dev",
    description: "크리에이터 비즈니스 플랫폼 (NestJS + Next.js)",
  },
  {
    slug: "todari-ops",
    name: "todari-ops (self)",
    aliases: ["토다리봇", "토다리 봇", "디스코드 봇", "discord bot"],
    repoUrl: "https://github.com/Todari/todari-ops.git",
    defaultBranch: "main",
    description: "이 봇 자체 — 봇이 자기 자신을 고칠 수 있게. 리모트가 아직 없으면 /code 가 clone 실패함",
  },
];

export function findProject(slug: string): ProjectConfig | undefined {
  const query = slug.trim().toLowerCase();
  return projects.find(
    (p) =>
      p.slug.toLowerCase() === query ||
      p.name.toLowerCase() === query ||
      p.aliases?.some((alias) => alias.toLowerCase() === query),
  );
}

export function repoFullName(p: ProjectConfig): string | null {
  const m = p.repoUrl.match(/^https:\/\/github\.com\/([^/]+\/[^/.]+)/);
  return m ? m[1] : null;
}

export function findProjectByRepoFullName(fullName: string): ProjectConfig | undefined {
  const lower = fullName.toLowerCase();
  return projects.find((p) => repoFullName(p)?.toLowerCase() === lower);
}

/** Loose match for Vercel project names: slug, repo basename, display name, or alias. */
export function findProjectByLooseName(name: string): ProjectConfig | undefined {
  const lower = name.toLowerCase();
  return projects.find(
    (p) =>
      p.slug.toLowerCase() === lower ||
      p.name.toLowerCase() === lower ||
      p.aliases?.some((alias) => alias.toLowerCase() === lower) ||
      repoFullName(p)?.split("/")[1]?.toLowerCase() === lower ||
      p.vercelNames?.some((n) => n.toLowerCase() === lower),
  );
}
