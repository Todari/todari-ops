import {
  ChannelType,
  ThreadAutoArchiveDuration,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";
import { createSession, type PermissionMode } from "../storage/sessions.js";
import { startTurn } from "./run.js";
import type { VaultTaskRef } from "../vault/mutations.js";

// Shared "create thread + session + first turn" path used by both the /code
// slash command and the Triage button on Sentry alerts. Caller is responsible
// for replying to its own interaction; this returns the Thread so the caller
// can mention it in the reply.
export async function spawnSessionThread(args: {
  parent: TextChannel;
  threadName: string;
  projectSlug: string;
  permissionMode: PermissionMode;
  prompt: string;
  sourceTask?: VaultTaskRef;
}): Promise<ThreadChannel> {
  const thread = await args.parent.threads.create({
    name: args.threadName.length > 100 ? args.threadName.slice(0, 99) + "…" : args.threadName,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
    type: ChannelType.PublicThread,
  });
  await createSession({
    threadId: thread.id,
    projectSlug: args.projectSlug,
    permissionMode: args.permissionMode,
    ...(args.sourceTask ? { sourceTask: args.sourceTask } : {}),
  });
  // Fire-and-forget: startTurn streams to the thread itself and traps its own
  // errors (run.ts catch block + Sentry capture). Awaiting would block the
  // caller's interaction-reply path for many seconds.
  void startTurn({ threadId: thread.id, prompt: args.prompt, isFirstTurn: true });
  return thread;
}
