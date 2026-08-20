import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type MessageCreateOptions,
} from "discord.js";
import { fetchInstagramChannel } from "../discord/alerts.js";

const ACCOUNTS = {
  jakkuyagu: {
    displayName: "자꾸야구",
    handle: "@jakku.yagu",
    profileUrl: "https://www.instagram.com/jakku.yagu/",
    color: 0x1d4ed8,
  },
  sector4: {
    displayName: "섹터4",
    handle: "@sector4.f1",
    profileUrl: "https://www.instagram.com/sector4.f1/",
    color: 0xff2d55,
  },
} as const;

type Account = keyof typeof ACCOUNTS;

export interface InstagramPostEvent {
  account: Account;
  mediaId: string;
  permalink: string | null;
  caption: string;
  contentType: string | null;
  sourceKey: string | null;
  publishedAt: string;
}

const delivered = new Map<string, number>();
const DEDUPE_MS = 7 * 24 * 60 * 60 * 1000;

export function normalizeInstagramEvent(payload: unknown): InstagramPostEvent | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const raw = payload as Record<string, unknown>;
  if (raw.account !== "jakkuyagu" && raw.account !== "sector4") return null;

  const mediaId = boundedString(raw.media_id, 100, false);
  const caption = boundedString(raw.caption, 2_200, true);
  const contentType = optionalString(raw.content_type, 80);
  const sourceKey = optionalString(raw.source_key, 200);
  const publishedAt = boundedString(raw.published_at, 80, false);
  if (mediaId === null || caption === null || contentType === undefined || sourceKey === undefined) {
    return null;
  }
  if (publishedAt === null || Number.isNaN(Date.parse(publishedAt))) return null;

  let permalink: string | null = null;
  if (raw.permalink !== null && raw.permalink !== undefined && raw.permalink !== "") {
    const candidate = boundedString(raw.permalink, 500, false);
    if (candidate === null || !isInstagramUrl(candidate)) return null;
    permalink = candidate;
  }

  return {
    account: raw.account,
    mediaId,
    permalink,
    caption,
    contentType,
    sourceKey,
    publishedAt: new Date(publishedAt).toISOString(),
  };
}

export function buildInstagramMessage(event: InstagramPostEvent): MessageCreateOptions {
  const account = ACCOUNTS[event.account];
  const targetUrl = event.permalink ?? account.profileUrl;
  const embed = new EmbedBuilder()
    .setColor(account.color)
    .setTitle(`${account.displayName} 게시물 업로드 완료`)
    .setURL(targetUrl)
    .setAuthor({ name: `${account.handle} · Instagram Bot` })
    .setTimestamp(new Date(event.publishedAt))
    .setFooter({ text: `media ${event.mediaId}` });

  if (event.caption.trim()) embed.setDescription(truncate(event.caption.trim(), 1_500));
  if (event.contentType || event.sourceKey) {
    embed.addFields({
      name: "콘텐츠",
      value: [event.contentType, event.sourceKey].filter(Boolean).join(" · "),
    });
  }

  const message: MessageCreateOptions = { embeds: [embed] };
  if (event.permalink) {
    message.components = [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Link)
          .setLabel("Instagram에서 보기")
          .setURL(event.permalink),
      ),
    ];
  }
  return message;
}

/** 같은 게시기의 네트워크 재시도는 한 번만 Discord에 표시한다. */
export async function handleInstagramEvent(event: InstagramPostEvent): Promise<boolean> {
  const now = Date.now();
  for (const [key, timestamp] of delivered) {
    if (now - timestamp > DEDUPE_MS) delivered.delete(key);
  }
  const dedupeKey = `${event.account}:${event.mediaId}`;
  if (delivered.has(dedupeKey)) return false;

  const channel = await fetchInstagramChannel();
  if (!channel) throw new Error("Instagram Discord channel unavailable");
  await channel.send(buildInstagramMessage(event));
  delivered.set(dedupeKey, now);
  return true;
}

function boundedString(value: unknown, max: number, allowEmpty: boolean): string | null {
  if (typeof value !== "string" || value.length > max) return null;
  if (!allowEmpty && value.trim().length === 0) return null;
  return value;
}

function optionalString(value: unknown, max: number): string | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  const result = boundedString(value, max, false);
  return result === null ? undefined : result;
}

function isInstagramUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "instagram.com" || url.hostname === "www.instagram.com")
    );
  } catch {
    return false;
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
