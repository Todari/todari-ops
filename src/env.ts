import "dotenv/config";

// REQUIRED to even boot the bot
const REQUIRED = [
  "DISCORD_BOT_TOKEN",
  "DISCORD_APP_ID",
  "DISCORD_GUILD_ID",
  "OWNER_DISCORD_ID",
] as const;

type RequiredKey = (typeof REQUIRED)[number];

const required = Object.fromEntries(
  REQUIRED.map((k) => [k, process.env[k] ?? ""]),
) as Record<RequiredKey, string>;

export const env = {
  ...required,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
  CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "",
  WORK_DIR: process.env.WORK_DIR ?? "./data/work",
  AUDIT_DB_URL: process.env.AUDIT_DB_URL ?? "",
  SENTRY_DSN: process.env.SENTRY_DSN ?? "",
  SENTRY_API_TOKEN: process.env.SENTRY_API_TOKEN ?? "",
  ALERTS_CHANNEL_ID: process.env.ALERTS_CHANNEL_ID ?? "",
  SENTRY_WEBHOOK_SECRET: process.env.SENTRY_WEBHOOK_SECRET ?? "",
  GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET ?? "",
  VERCEL_WEBHOOK_SECRET: process.env.VERCEL_WEBHOOK_SECRET ?? "",
  VAULT_SYNC_SECRET: process.env.VAULT_SYNC_SECRET ?? "",
  INBOX_CHANNEL_ID: process.env.INBOX_CHANNEL_ID ?? "",
  WEBHOOK_ENABLED: (process.env.WEBHOOK_ENABLED ?? "true").toLowerCase() === "true",
  UPTIME_ENABLED: (process.env.UPTIME_ENABLED ?? "true").toLowerCase() === "true",
  UPTIME_INTERVAL_MS: Number(process.env.UPTIME_INTERVAL_MS ?? 300_000),
  RESOURCE_INTERVAL_MS: Number(process.env.RESOURCE_INTERVAL_MS ?? 300_000),
  DIGEST_CHANNEL_ID: process.env.DIGEST_CHANNEL_ID ?? "",
  DIGEST_TIME: process.env.DIGEST_TIME ?? "08:30", // KST HH:MM, empty = disabled
  DIAG_DAILY_CAP: Number(process.env.DIAG_DAILY_CAP ?? 3), // 0 = auto-diagnosis off
  // 봇의 모든 에이전트 세션(/code·자동진단·요약)이 쓰는 모델. SDK 번들 CLI의
  // 기본값(구세대 Sonnet)에 맡기지 않고 명시한다. 빈 값이면 번들 기본값.
  CLAUDE_MODEL: process.env.CLAUDE_MODEL ?? "claude-opus-5",
  CHECKIN_TIME: process.env.CHECKIN_TIME ?? "21:30", // KST HH:MM, empty = disabled
  GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? "",
  VAULT_REPO_URL:
    process.env.VAULT_REPO_URL ??
    "https://github.com/Todari/obsidian-vault.git",
  BOT_PUBLIC_HOST: process.env.BOT_PUBLIC_HOST ?? "alerts.todari.dev",
  ACTION_ALLOWLIST: (process.env.ACTION_ALLOWLIST ?? "Edit,Write,Bash")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  PORT: Number(process.env.PORT ?? 3000),
  NODE_ENV: process.env.NODE_ENV ?? "development",
  JP_CHANNEL_ID: process.env.JP_CHANNEL_ID ?? "",
  JP_PUSH_HOUR: Number(process.env.JP_PUSH_HOUR ?? 8),
  JP_PUSH_MINUTE: Number(process.env.JP_PUSH_MINUTE ?? 10),
  NL_CHANNEL_ID: process.env.NL_CHANNEL_ID ?? "",
};

/** Either path satisfies SDK auth: Pro/Max OAuth OR pay-per-use API key */
export function hasClaudeAuth(): boolean {
  return Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY);
}

export function assertEnv(): void {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`[fatal] missing env: ${missing.join(", ")}`);
    process.exit(1);
  }
  if (!hasClaudeAuth()) {
    console.warn(
      "[warn] neither CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY set — slash commands register, but /code will fail until one is provided",
    );
  } else if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    console.log("[auth] using Claude OAuth (Max/Pro subscription)");
  } else {
    console.log("[auth] using ANTHROPIC_API_KEY (pay-per-token)");
  }
}
