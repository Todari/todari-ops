import { ChannelType, type TextChannel } from "discord.js";
import { env } from "../env.js";
import { getDiscordClient } from "./client.js";

/**
 * 사람이 움직여야 하는 알림에 붙인다. 서버 알림 기본값이 "@멘션만"이라 멘션이 없으면 푸시가 오지 않는다.
 * 복구·성공처럼 조치가 필요 없는 알림에는 붙이지 않는다(docs/alerts.md).
 */
export function ownerMention(): { content: string; allowedMentions: { users: string[] } } {
  return { content: `<@${env.OWNER_DISCORD_ID}>`, allowedMentions: { users: [env.OWNER_DISCORD_ID] } };
}

// Shared by sentry/vercel/github webhook handlers, uptime monitor, digest.
export async function fetchAlertsChannel(): Promise<TextChannel | null> {
  return fetchTextChannel(env.ALERTS_CHANNEL_ID, "alerts");
}

export async function fetchDigestChannel(): Promise<TextChannel | null> {
  const id = env.DIGEST_CHANNEL_ID || env.ALERTS_CHANNEL_ID;
  return fetchTextChannel(id, "digest");
}

// PR 머지처럼 조치가 필요 없는 기록용 채널(#로그-배포). 없으면 alerts로 간다.
export async function fetchDeployLogChannel(): Promise<TextChannel | null> {
  const id = env.DEPLOY_LOG_CHANNEL_ID || env.ALERTS_CHANNEL_ID;
  return fetchTextChannel(id, "deploy-log");
}

export async function fetchInboxChannel(): Promise<TextChannel | null> {
  const id = env.INBOX_CHANNEL_ID || env.ALERTS_CHANNEL_ID;
  return fetchTextChannel(id, "inbox");
}

export async function fetchJpChannel(): Promise<TextChannel | null> {
  const id = env.JP_CHANNEL_ID || env.ALERTS_CHANNEL_ID;
  return id ? fetchTextChannel(id, "jp") : null;
}

export async function fetchInstagramChannel(): Promise<TextChannel | null> {
  return fetchTextChannel(env.INSTAGRAM_CHANNEL_ID, "instagram");
}

export async function fetchTextChannel(id: string, label: string): Promise<TextChannel | null> {
  if (!id) {
    console.warn(`[discord] ${label} channel id empty — drop`);
    return null;
  }
  const client = getDiscordClient();
  const ch = await client.channels.fetch(id).catch(() => null);
  if (!ch || ch.type !== ChannelType.GuildText) {
    console.warn(`[discord] ${label} channel ${id} not a text channel`);
    return null;
  }
  return ch;
}
