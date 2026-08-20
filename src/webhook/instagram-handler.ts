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
  previewUrl: string | null;
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
  let previewUrl: string | null = null;
  if (raw.preview_url !== null && raw.preview_url !== undefined && raw.preview_url !== "") {
    const candidate = boundedString(raw.preview_url, 2_000, false);
    if (candidate === null || !isHttpsUrl(candidate)) return null;
    previewUrl = candidate;
  }

  return {
    account: raw.account,
    mediaId,
    permalink,
    previewUrl,
    caption,
    contentType,
    sourceKey,
    publishedAt: new Date(publishedAt).toISOString(),
  };
}

export function buildInstagramMessage(event: InstagramPostEvent): MessageCreateOptions {
  const account = ACCOUNTS[event.account];
  const targetUrl = event.permalink ?? account.profileUrl;
  const caption = event.caption.trim();
  const [headline, ...bodyLines] = caption.split("\n");
  const body = bodyLines.join("\n").trim();
  const embed = new EmbedBuilder()
    .setColor(account.color)
    .setTitle(
      headline
        ? `새 게시물 · ${truncate(headline, 180)}`
        : `${account.displayName} 새 게시물 업로드 완료`,
    )
    .setURL(targetUrl)
    .setAuthor({ name: `${account.displayName} ${account.handle}` })
    .setTimestamp(new Date(event.publishedAt))
    .setFooter({ text: "Instagram 자동 게시 완료" });

  if (body) embed.setDescription(truncate(body, 1_500));
  if (event.contentType) {
    embed.addFields({
      name: "게시물 유형",
      value: contentTypeLabel(event.contentType, event.account),
      inline: true,
    });
  }
  if (event.previewUrl) embed.setImage(event.previewUrl);

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Link)
          .setLabel(event.permalink ? "게시물 바로 보기" : "Instagram 프로필 열기")
          .setURL(targetUrl),
      ),
    ],
  };
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

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function contentTypeLabel(value: string, account: Account): string {
  const labels: Record<string, string> = {
    preview: "경기 프리뷰",
    pregame_preview: "경기 프리뷰",
    "result-card": "경기 결과",
    flow: "승부의 흐름",
    "race-result": "레이스 결과",
    quali: "예선 결과",
    racepreview: "레이스 프리뷰",
    lastyear: "지난 시즌 돌아보기",
    champ: "챔피언십 순위",
    weekend: "레이스 주말 일정",
    form: "드라이버 폼 가이드",
    stock: "F1 스톡 콘텐츠",
    "integration-test": "연동 테스트",
    "interface-preview": "알림 UI 미리보기",
  };
  if (value === "result") return account === "sector4" ? "레이스 결과" : "경기 결과";
  return labels[value] ?? value;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
