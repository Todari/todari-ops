import {
  ButtonBuilder,
  ActionRowBuilder,
  ButtonStyle,
  EmbedBuilder,
  type ThreadChannel,
} from "discord.js";
import { randomUUID } from "node:crypto";
import { env } from "../env.js";
import { logAudit } from "../storage/audit.js";
import { redactSensitive } from "./redact.js";

export type PermissionDecision = "approve" | "approve-once" | "deny";

export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions";

interface Pending {
  resolve: (d: PermissionDecision) => void;
  threadId: string;
  toolName: string;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, Pending>();
const TIMEOUT_MS = 60_000;

const READ_ONLY_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
]);

export interface AskPermissionArgs {
  threadId: string;
  thread: ThreadChannel;
  toolName: string;
  toolInput: unknown;
  mode: PermissionMode;
}

export async function askPermission(args: AskPermissionArgs): Promise<PermissionDecision> {
  const safeInput = redactSensitive(args.toolInput);
  if (args.mode === "bypassPermissions") {
    await logAudit({
      threadId: args.threadId,
      tool: args.toolName,
      input: safeInput,
      decision: "auto-bypass",
    });
    return "approve";
  }
  if (args.mode === "acceptEdits" && (args.toolName === "Edit" || args.toolName === "Write")) {
    await logAudit({
      threadId: args.threadId,
      tool: args.toolName,
      input: safeInput,
      decision: "auto-acceptEdits",
    });
    return "approve";
  }
  if (READ_ONLY_TOOLS.has(args.toolName)) {
    return "approve";
  }
  if (!env.ACTION_ALLOWLIST.includes(args.toolName)) {
    await logAudit({
      threadId: args.threadId,
      tool: args.toolName,
      input: safeInput,
      decision: "auto-deny",
      reason: "not in ACTION_ALLOWLIST",
    });
    return "deny";
  }

  const id = randomUUID();
  const decision = await new Promise<PermissionDecision>((resolve) => {
    const timer = setTimeout(() => {
      if (pending.delete(id)) {
        void logAudit({
          threadId: args.threadId,
          tool: args.toolName,
          input: safeInput,
          decision: "timeout-deny",
        });
        resolve("deny");
      }
    }, TIMEOUT_MS);
    pending.set(id, { resolve, threadId: args.threadId, toolName: args.toolName, timer });
    void sendPrompt(args.thread, id, args.toolName, safeInput);
  });

  await logAudit({
    threadId: args.threadId,
    tool: args.toolName,
    input: safeInput,
    decision,
  });
  return decision;
}

export async function resolvePending(id: string, decision: PermissionDecision): Promise<boolean> {
  const p = pending.get(id);
  if (!p) return false;
  pending.delete(id);
  clearTimeout(p.timer);
  p.resolve(decision);
  return true;
}

async function sendPrompt(
  thread: ThreadChannel,
  id: string,
  toolName: string,
  toolInput: unknown,
): Promise<void> {
  const inputStr = stringifyInput(toolInput);
  const embed = new EmbedBuilder()
    .setColor(0xfacc15)
    .setTitle(`🔐 권한 요청: ${toolName}`)
    .setDescription(
      "```\n" +
        inputStr.slice(0, 1500) +
        (inputStr.length > 1500 ? "\n…(truncated)" : "") +
        "\n```",
    )
    .setFooter({ text: "60초 안에 응답 없으면 자동 거부" });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`perm:approve:${id}`)
      .setLabel("Allow")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`perm:approve-once:${id}`)
      .setLabel("Allow once")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`perm:deny:${id}`)
      .setLabel("Deny")
      .setStyle(ButtonStyle.Danger),
  );
  await thread.send({ embeds: [embed], components: [row] });
}

function stringifyInput(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
