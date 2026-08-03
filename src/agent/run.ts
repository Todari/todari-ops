// NOTE: verify exact SDK exports on first `pnpm install`. The Agent SDK is
// young (0.x), so `query`, `Options`, and message shapes may shift. If imports
// break, see node_modules/@anthropic-ai/claude-agent-sdk/README.md.
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { ThreadChannel } from "discord.js";
import { env } from "../env.js";
import {
  getSession,
  updateSessionId,
  type PermissionMode,
} from "../storage/sessions.js";
import { findProject } from "../projects.js";
import { ensureCheckout } from "../workspaces/checkout.js";
import { askPermission } from "./permissions.js";
import { renderEvent } from "./render.js";
import { logAudit } from "../storage/audit.js";
import { getDiscordClient } from "../discord/client.js";
import { captureException } from "../observability/sentry.js";

interface ActiveTurn {
  abort: AbortController;
  pendingPrompt: string | null;
}

const activeTurns = new Map<string, ActiveTurn>();

export interface StartTurnArgs {
  threadId: string;
  prompt: string;
  isFirstTurn: boolean;
}

export async function startTurn(args: StartTurnArgs): Promise<void> {
  const thread = await getThreadChannel(args.threadId);
  if (!thread) {
    console.error(`[agent] thread ${args.threadId} not found`);
    return;
  }

  const existing = activeTurns.get(args.threadId);
  if (existing) {
    if (existing.pendingPrompt) {
      await thread.send(
        "⏳ 큐에 이미 한 개 대기 중 — 이번 메시지는 무시됨. (1-슬롯 큐)",
      );
    } else {
      existing.pendingPrompt = args.prompt;
      await thread.send("📥 큐에 추가됨 — 현재 턴 끝나면 자동 실행");
    }
    return;
  }

  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
    await thread.send(
      [
        "⚠️ Claude 인증이 없어요. 둘 중 하나가 `.env.production` 에 있어야 합니다:",
        "",
        "**A. Claude Max/Pro 구독 사용 (결제 X)**",
        "```",
        "claude setup-token   # 로컬 터미널에서 실행 → oat_... 토큰 출력",
        "# 그 값을 CLAUDE_CODE_OAUTH_TOKEN= 에 넣기",
        "```",
        "",
        "**B. API key (pay-per-token)**",
        "`ANTHROPIC_API_KEY=sk-ant-...`",
        "",
        "변경 후 EC2 에서:",
        "`docker compose up -d --force-recreate bot`",
      ].join("\n"),
    );
    return;
  }

  const session = await getSession(args.threadId);
  if (!session) {
    await thread.send(
      "⚠️ 이 스레드의 세션 메타가 없어요 (봇 재시작 시 인메모리 세션 소멸). 새 `/code` 로 시작하세요.",
    );
    return;
  }
  const project = findProject(session.projectSlug);
  if (!project) {
    await thread.send(`⚠️ 알 수 없는 프로젝트: \`${session.projectSlug}\``);
    return;
  }

  const abort = new AbortController();
  activeTurns.set(args.threadId, { abort, pendingPrompt: null });

  try {
    let cwd: string;
    try {
      cwd = await ensureCheckout(args.threadId, project);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await thread.send(
        [
          `⚠️ git clone 실패: \`${msg}\``,
          "",
          "**가능한 원인:**",
          "• Private repo + `GITHUB_TOKEN` 미설정 또는 권한 부족",
          "• repo URL 오타 / repo 자체 미존재",
          "",
          "EC2 에서:",
          "```",
          "nano ~/todari-ops/.env.production    # GITHUB_TOKEN=ghp_...",
          "cd ~/todari-ops && docker compose up -d --force-recreate bot",
          "```",
        ].join("\n"),
      );
      return;
    }

    const sdkOptions = buildOptions({
      cwd,
      abort,
      resume: session.sessionId,
      mode: session.permissionMode,
      threadId: args.threadId,
      thread,
    });

    let newSessionId: string | undefined;
    for await (const message of query({ prompt: args.prompt, options: sdkOptions })) {
      await renderEvent(thread, message);
      const maybeId = (message as { session_id?: string }).session_id;
      if (maybeId) newSessionId = maybeId;
    }
    if (newSessionId && newSessionId !== session.sessionId) {
      await updateSessionId(args.threadId, newSessionId);
    }
    await logAudit({
      threadId: args.threadId,
      tool: "turn:complete",
      input: { prompt: args.prompt },
      decision: "ok",
    });
  } catch (err) {
    if (abort.signal.aborted) {
      await thread.send("🛑 취소됨");
    } else {
      console.error("[agent] error:", err);
      captureException(err, { kind: "agent", threadId: args.threadId });
      await thread.send(
        "⚠️ 에러: " + (err instanceof Error ? err.message : String(err)),
      );
    }
  } finally {
    const finished = activeTurns.get(args.threadId);
    activeTurns.delete(args.threadId);
    const queued = finished?.pendingPrompt;
    if (queued && !abort.signal.aborted) {
      void startTurn({
        threadId: args.threadId,
        prompt: queued,
        isFirstTurn: false,
      });
    }
  }
}

export function isTurnActive(threadId: string): boolean {
  return activeTurns.has(threadId);
}

export async function cancelActiveTurn(threadId: string): Promise<boolean> {
  const t = activeTurns.get(threadId);
  if (!t) return false;
  t.pendingPrompt = null;
  t.abort.abort();
  return true;
}

interface BuildOptionsArgs {
  cwd: string;
  abort: AbortController;
  resume: string | undefined;
  mode: PermissionMode;
  threadId: string;
  thread: ThreadChannel;
}

function buildOptions(args: BuildOptionsArgs): Options {
  // Cast to any-light because Options shape may differ between SDK versions.
  const opts: Options = {
    cwd: args.cwd,
    abortController: args.abort,
    resume: args.resume,
    ...(env.CLAUDE_MODEL ? { model: env.CLAUDE_MODEL } : {}),
    permissionMode: args.mode,
    canUseTool: async (toolName, toolInput) => {
      const decision = await askPermission({
        threadId: args.threadId,
        thread: args.thread,
        toolName,
        toolInput,
        mode: args.mode,
      });
      return decision === "deny"
        ? { behavior: "deny", message: "user denied" }
        : { behavior: "allow", updatedInput: toolInput };
    },
  } as Options;
  return opts;
}

async function getThreadChannel(threadId: string): Promise<ThreadChannel | null> {
  const client = getDiscordClient();
  const channel = await client.channels.fetch(threadId);
  if (!channel) return null;
  return channel.isThread() ? (channel as ThreadChannel) : null;
}
