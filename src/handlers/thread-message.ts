import type { Message } from "discord.js";
import { getSession } from "../storage/sessions.js";
import { startTurn } from "../agent/run.js";

// Threads where we've already posted the "session expired" hint after a bot
// restart — avoid spamming the same notice every message in the thread.
const expiredHinted = new Set<string>();

export async function handleThreadMessage(message: Message): Promise<void> {
  const channel = message.channel;
  if (!channel.isThread()) return;
  const session = await getSession(channel.id);
  if (!session) {
    const botId = message.client.user?.id;
    if (botId && channel.ownerId === botId && !expiredHinted.has(channel.id)) {
      expiredHinted.add(channel.id);
      await channel.send(
        "ℹ️ 이 스레드 세션이 만료됐어요 (봇 재시작 시 인메모리 세션 소멸). 텍스트 채널에서 `/code` 로 새 세션을 시작해주세요.",
      );
    }
    return;
  }
  if (!message.content.trim()) return;
  await startTurn({ threadId: channel.id, prompt: message.content, isFirstTurn: false });
}
