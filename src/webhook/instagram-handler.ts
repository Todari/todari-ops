import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type MessageCreateOptions,
  MessageFlags,
} from "discord.js";
import {
  fetchAlertsChannel,
  fetchDigestChannel,
  fetchInstagramChannel,
  fetchTextChannel,
} from "../discord/alerts.js";
import { env } from "../env.js";
import { getProblemMessage, setProblemMessage, type ProblemMessage } from "./instagram-problems.js";

const ACCOUNTS = {
  jakkuyagu: {
    displayName: "야있날",
    handle: "@yaitnal",
    profileUrl: "https://www.instagram.com/yaitnal/",
    color: 0x1d4ed8,
  },
  sector4: {
    displayName: "섹터4",
    handle: "@sector4.f1",
    profileUrl: "https://www.instagram.com/sector4.f1/",
    color: 0xff2d55,
  },
  jujinmo: {
    displayName: "주진모?",
    handle: "@ju.jin.mo",
    profileUrl: "https://www.instagram.com/ju.jin.mo/",
    color: 0x111111,
  },
  gonggu: {
    displayName: "공구함",
    handle: "@09._.ham",
    profileUrl: "https://www.instagram.com/09._.ham/",
    color: 0xf59e0b,
  },
} as const;

type Account = keyof typeof ACCOUNTS;

// 워치독이 보내는 단계 알림(alert_level)의 표시 정책. 없는 실패 이벤트는 기존 표시 그대로다.
const ALERT_LEVELS = {
  delay: { color: 0xfee75c, title: "게시 지연 · 자동 복구 중", silent: true, mention: false },
  recovered: { color: 0x57f287, title: "지연 게시 완료", silent: true, mention: false },
  action: { color: 0xed4245, title: "운영자 확인 필요", silent: false, mention: true },
  outage: { color: 0xed4245, title: "게시 중단", silent: false, mention: true },
  outage_resolved: { color: 0x57f287, title: "게시 재개", silent: false, mention: false },
  outage_closed: { color: 0x95a5a6, title: "게시 중단 종료 · 새 예정 없음", silent: true, mention: false },
} as const;

type AlertLevel = keyof typeof ALERT_LEVELS;
const ACTION_CHANNEL_LEVELS: ReadonlySet<AlertLevel> = new Set([
  "action",
  "outage",
  "outage_resolved",
  "outage_closed",
]);
// 문제를 닫는 수준. 같은 문제로 먼저 올린 메시지가 있으면 새로 보내지 않고 그 메시지를 고친다.
const CLOSING_LEVELS: ReadonlySet<AlertLevel> = new Set(["recovered", "outage_resolved", "outage_closed"]);

export interface InstagramPostEvent {
  status: "published";
  account: Account;
  mediaId: string;
  permalink: string | null;
  previewUrl: string | null;
  caption: string;
  contentType: string | null;
  sourceKey: string | null;
  qualityReview: InstagramQualityReview | null;
  publishedAt: string;
}

export interface InstagramQualityReview {
  audience: "baseball_fan" | "f1_fan" | "stock_reader";
  overallScore: number;
  scores: Record<string, number>;
  summary: string;
  strengths: string[];
  improvements: string[];
}

export interface InstagramFailureEvent {
  status: "failed";
  account: Account;
  errorType: string;
  errorMessage: string;
  contentType: string | null;
  sourceKey: string | null;
  stage: string | null;
  failureCategory: string | null;
  attempt: number | null;
  nextRetryAt: string | null;
  occurredAt: string;
  alertLevel?: AlertLevel;
}

export interface InstagramDigestEvent {
  status: "digest";
  title: string;
  body: string;
}

export type InstagramEvent = InstagramPostEvent | InstagramFailureEvent | InstagramDigestEvent;

const delivered = new Map<string, { timestamp: number; ttl: number }>();
const SUCCESS_DEDUPE_MS = 7 * 24 * 60 * 60 * 1000;
const FAILURE_DEDUPE_MS = 6 * 60 * 60 * 1000;

export function normalizeInstagramEvent(payload: unknown): InstagramEvent | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const raw = payload as Record<string, unknown>;
  if (raw.status === "digest") {
    const title = boundedString(raw.title, 200, false);
    const body = boundedString(raw.body, 3_500, false);
    if (title === null || body === null) return null;
    return { status: "digest", title, body };
  }
  if (
    raw.account !== "jakkuyagu" &&
    raw.account !== "sector4" &&
    raw.account !== "jujinmo" &&
    raw.account !== "gonggu"
  ) {
    return null;
  }

  const contentType = optionalString(raw.content_type, 80);
  const sourceKey = optionalString(raw.source_key, 200);
  if (contentType === undefined || sourceKey === undefined) return null;

  const status = raw.status ?? "published";
  if (status === "failed") {
    const errorType = boundedString(raw.error_type, 120, false);
    const errorMessage = boundedString(raw.error_message, 1_500, false);
    const occurredAt = boundedString(raw.occurred_at, 80, false);
    const stage = optionalString(raw.stage, 120);
    const failureCategory = optionalString(raw.failure_category, 120);
    const attempt = optionalPositiveInteger(raw.attempt);
    const nextRetryAt = optionalDate(raw.next_retry_at);
    // 모르는 alert_level은 거절하지 않고 없는 것으로 취급해 기존 실패 알림으로 표시한다.
    const alertLevel =
      typeof raw.alert_level === "string" && Object.hasOwn(ALERT_LEVELS, raw.alert_level)
        ? (raw.alert_level as AlertLevel)
        : undefined;
    if (
      errorType === null ||
      errorMessage === null ||
      occurredAt === null ||
      Number.isNaN(Date.parse(occurredAt)) ||
      stage === undefined ||
      failureCategory === undefined ||
      attempt === undefined ||
      nextRetryAt === undefined
    ) {
      return null;
    }
    return {
      status,
      account: raw.account,
      errorType,
      errorMessage,
      contentType,
      sourceKey,
      stage,
      failureCategory,
      attempt,
      nextRetryAt,
      occurredAt: new Date(occurredAt).toISOString(),
      alertLevel,
    };
  }
  if (status !== "published") return null;

  const mediaId = boundedString(raw.media_id, 100, false);
  const caption = boundedString(raw.caption, 2_200, true);
  const publishedAt = boundedString(raw.published_at, 80, false);
  const qualityReview = optionalQualityReview(raw.quality_review);
  if (mediaId === null || caption === null) return null;
  if (
    publishedAt === null || Number.isNaN(Date.parse(publishedAt)) ||
    qualityReview === undefined
  ) return null;

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
    status,
    account: raw.account,
    mediaId,
    permalink,
    previewUrl,
    caption,
    contentType,
    sourceKey,
    qualityReview,
    publishedAt: new Date(publishedAt).toISOString(),
  };
}

export function buildInstagramMessage(event: InstagramEvent): MessageCreateOptions {
  if (event.status === "digest") {
    return {
      embeds: [
        new EmbedBuilder()
          .setColor(0x8b7cf0)
          .setTitle(event.title)
          .setDescription(truncate(event.body, 3_400))
          .setFooter({ text: "Instagram 포트폴리오 리포트" })
          .setTimestamp(new Date()),
      ],
    };
  }
  if (event.status === "failed") return buildFailureMessage(event);

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
  if (event.qualityReview) {
    const audience = {
      baseball_fan: "야구팬",
      f1_fan: "F1 팬",
      stock_reader: "주식 독자",
    }[event.qualityReview.audience];
    embed.addFields(
      {
        name: `${audience} 관점 품질 점수`,
        value: `**${event.qualityReview.overallScore}/100** · ${truncate(event.qualityReview.summary, 700)}`,
      },
      {
        name: "잘된 점",
        value: truncate(event.qualityReview.strengths.map((item) => `• ${item}`).join("\n"), 900),
        inline: true,
      },
      {
        name: "다음 생성에서 개선",
        value: event.qualityReview.improvements.length
          ? truncate(event.qualityReview.improvements.map((item) => `• ${item}`).join("\n"), 900)
          : "승인 기준에서 추가 개선점 없음",
        inline: true,
      },
    );
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

function buildFailureMessage(event: InstagramFailureEvent): MessageCreateOptions {
  const account = ACCOUNTS[event.account];
  const alert = event.alertLevel ? ALERT_LEVELS[event.alertLevel] : null;
  const embed = new EmbedBuilder()
    .setColor(alert?.color ?? 0xed4245)
    .setTitle(`${account.displayName} ${alert?.title ?? "자동 게시 실패"}`)
    .setURL(account.profileUrl)
    .setAuthor({ name: `${account.displayName} ${account.handle}` })
    .setDescription(event.errorMessage)
    .setTimestamp(new Date(event.occurredAt))
    .setFooter({
      text: alert
        ? "Instagram 게시 감시"
        : event.nextRetryAt
          ? "Instagram 자동 게시 오류 · 원인 기록 후 자동 재시도"
          : "Instagram 자동 게시 오류 · 같은 오류는 6시간 동안 생략",
    })
    .addFields({ name: "오류 종류", value: event.errorType, inline: true });

  if (event.contentType) {
    embed.addFields({
      name: "게시물 유형",
      value: contentTypeLabel(event.contentType, event.account),
      inline: true,
    });
  }
  if (event.stage) {
    embed.addFields({ name: "실패 지점", value: stageLabel(event.stage), inline: true });
  }
  if (event.failureCategory) {
    embed.addFields({
      name: "원인 분류",
      value: failureCategoryLabel(event.failureCategory),
      inline: true,
    });
  }
  if (event.attempt) {
    embed.addFields({ name: "누적 시도", value: `${event.attempt}회`, inline: true });
  }
  if (event.nextRetryAt) {
    embed.addFields({
      name: "다음 재시도",
      value: `<t:${Math.floor(Date.parse(event.nextRetryAt) / 1000)}:R>`,
      inline: true,
    });
  }
  if (event.sourceKey) {
    embed.addFields({ name: "대상", value: `\`${event.sourceKey}\`` });
  }

  const message: MessageCreateOptions = {
    embeds: [embed],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Link)
          .setLabel("Instagram 계정 확인")
          .setURL(account.profileUrl),
      ),
    ],
  };
  if (alert?.silent) message.flags = MessageFlags.SuppressNotifications;
  if (alert?.mention) {
    message.content = `<@${env.OWNER_DISCORD_ID}>`;
    message.allowedMentions = { users: [env.OWNER_DISCORD_ID] };
  }
  return message;
}

/** 같은 게시기의 네트워크 재시도는 한 번만 Discord에 표시한다. */
export async function handleInstagramEvent(event: InstagramEvent): Promise<boolean> {
  const now = Date.now();
  for (const [key, record] of delivered) {
    if (now - record.timestamp > record.ttl) delivered.delete(key);
  }
  // 실패 키에 errorMessage를 넣지 않는다. 재시도마다 문구가 조금씩 달라지는
  // 같은 단계·원인의 실패(예: AI 검수 반복 거절)가 폭풍처럼 반복 표시되는 것을 막고,
  // 단계나 원인 분류가 바뀐 새 실패만 6시간 안에 다시 알린다.
  // 워치독 알림은 stage·원인이 늘 같으므로 alertLevel까지 넣어 같은 job의 후속 단계를 살린다.
  const dedupeKey =
    event.status === "digest"
      ? `digest:${event.title}`
      : event.status === "published"
      ? `published:${event.account}:${event.mediaId}`
      : `failed:${event.account}:${event.sourceKey ?? "unknown"}:${event.stage ?? "unknown"}:${event.failureCategory ?? event.errorType}${event.alertLevel ? `:${event.alertLevel}` : ""}`;
  if (delivered.has(dedupeKey)) return false;

  // 사람이 움직여야 하는 알림만 조치 채널로, 요약은 요약 채널로 보낸다. 나머지는 게시 로그 채널에 남긴다.
  // 워치독은 한 문제의 시작과 끝에 같은 sourceKey를 쓴다. 문제 하나에 메시지 하나를 지킨다.
  const level = event.status === "failed" ? event.alertLevel : undefined;
  const problemKey =
    event.status === "failed" && level && event.sourceKey ? `${event.account}:${event.sourceKey}` : null;
  const closing = !!level && CLOSING_LEVELS.has(level);
  const prior = problemKey ? getProblemMessage(problemKey) : undefined;
  const edited =
    event.status === "failed" && level && closing && prior
      ? await closeProblemMessage(prior, event, level)
      : false;
  if (!edited) {
    const channel =
      event.status === "digest"
        ? await fetchDigestChannel()
        : level && ACTION_CHANNEL_LEVELS.has(level)
          ? await fetchAlertsChannel()
          : await fetchInstagramChannel();
    if (!channel) throw new Error("Instagram Discord channel unavailable");
    const sent = await channel.send(buildInstagramMessage(event));
    if (problemKey && !closing) {
      setProblemMessage(problemKey, { channelId: sent.channelId, messageId: sent.id, at: now });
    }
  }
  if (problemKey && closing && prior) setProblemMessage(problemKey, null);
  delivered.set(dedupeKey, {
    timestamp: now,
    ttl: event.status === "published" ? SUCCESS_DEDUPE_MS : FAILURE_DEDUPE_MS,
  });
  return true;
}

/** 먼저 올린 메시지를 닫힌 상태로 고친다. 고치지 못하면(메시지 삭제 등) false — 호출자가 새로 보낸다. */
async function closeProblemMessage(
  prior: ProblemMessage,
  event: InstagramFailureEvent,
  level: AlertLevel,
): Promise<boolean> {
  try {
    const channel = await fetchTextChannel(prior.channelId, "instagram-problem");
    if (!channel) return false;
    const message = await channel.messages.fetch(prior.messageId);
    const alert = ALERT_LEVELS[level];
    const closedAt = Math.floor(Date.parse(event.occurredAt) / 1000);
    const embed = EmbedBuilder.from(message.embeds[0])
      .setColor(alert.color)
      .setTitle(`${ACCOUNTS[event.account].displayName} ${alert.title}`)
      .addFields({ name: "닫힘", value: `<t:${closedAt}:f> · ${truncate(event.errorMessage, 900)}` });
    // 수정은 푸시를 만들지 않는다. 처음 알림의 멘션은 지운다.
    await message.edit({ content: null, embeds: [embed] });
    return true;
  } catch (err) {
    console.warn("[instagram] problem message edit failed — sending a new one:", err);
    return false;
  }
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

function optionalPositiveInteger(value: unknown): number | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return undefined;
  return value;
}

function optionalDate(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  const raw = boundedString(value, 80, false);
  if (raw === null || Number.isNaN(Date.parse(raw))) return undefined;
  return new Date(raw).toISOString();
}

function optionalQualityReview(value: unknown): InstagramQualityReview | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (
    raw.audience !== "baseball_fan" &&
    raw.audience !== "f1_fan" &&
    raw.audience !== "stock_reader"
  ) return undefined;
  if (
    typeof raw.overall_score !== "number" || !Number.isInteger(raw.overall_score) ||
    raw.overall_score < 0 || raw.overall_score > 100
  ) return undefined;
  const summary = boundedString(raw.summary, 800, false);
  const strengths = boundedStringArray(raw.strengths, 3, 500, 1);
  // A high-scoring review can legitimately have no requested improvements.
  // Rejecting [] made an otherwise successful Sector4 post return HTTP 400.
  const improvements = boundedStringArray(raw.improvements, 3, 500, 0);
  if (summary === null || strengths === null || improvements === null) return undefined;
  if (!raw.scores || typeof raw.scores !== "object" || Array.isArray(raw.scores)) return undefined;
  const scores: Record<string, number> = {};
  for (const [key, score] of Object.entries(raw.scores as Record<string, unknown>)) {
    if (
      !/^[a-z][a-z0-9_]{0,49}$/.test(key) || typeof score !== "number" ||
      !Number.isInteger(score) || score < 0 || score > 100
    ) return undefined;
    scores[key] = score;
  }
  if (Object.keys(scores).length === 0 || Object.keys(scores).length > 12) return undefined;
  return {
    audience: raw.audience,
    overallScore: raw.overall_score,
    scores,
    summary,
    strengths,
    improvements,
  };
}

function boundedStringArray(
  value: unknown,
  maxItems: number,
  maxLength: number,
  minItems = 1,
): string[] | null {
  if (
    !Array.isArray(value) || value.length < minItems || value.length > maxItems ||
    value.some((item) => boundedString(item, maxLength, false) === null)
  ) return null;
  return value as string[];
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
    sprintquali: "스프린트 예선 결과",
    sprintresult: "스프린트 결과",
    racepreview: "레이스 프리뷰",
    lastyear: "지난 시즌 돌아보기",
    champ: "챔피언십 순위",
    weekend: "레이스 주말 일정",
    form: "드라이버 폼 가이드",
    history: "서킷 역사",
    circuit: "서킷 데이터 가이드",
    glossary: "F1 용어사전",
    stock: "F1 스톡 콘텐츠",
    "integration-test": "연동 테스트",
    "interface-preview": "알림 UI 미리보기",
    "daily-content": "야있날 일일 콘텐츠",
    "gonggu-daily": "공구 일일 다이제스트",
    premarket_preview: "장전 한 장",
    premarket_hypothesis: "장전 근거 분석",
    close_review: "마감 한 장",
    close_explainer: "장 마감 근거 분석",
    weekly_market_review: "주간 시장 리뷰",
    market_term_explainer: "주식 용어 설명",
    weekly_market_outlook: "다음 주 시장 전망",
    "jujinmo-scheduled": "주진모 예약 작업",
    "sector4-poller": "섹터4 스케줄러",
    "publish-carousel": "캐러셀 게시",
  };
  if (value === "result") return account === "sector4" ? "레이스 결과" : "경기 결과";
  return labels[value] ?? value;
}

function stageLabel(value: string): string {
  const labels: Record<string, string> = {
    daily_schedule: "일일 경기 일정 수집",
    kbo_schedule: "KBO 일정 수집",
    kbo_lineup: "확정 라인업 수집",
    season_results: "시즌 기록 수집",
    naver_preview: "네이버 프리뷰 수집",
    source_snapshot: "사실 스냅샷 검증",
    scheduler_data_probe: "예약 데이터 확인",
    scheduler_preflight: "예약 작업 사전 점검",
    scheduled_agent: "예약 에이전트 실행",
    ai_editorial: "AI 초안·편집",
    ai_scene_selection: "AI 장면 선택",
    ai_editorial_release: "AI 편집·출고 검수",
    render: "카드 렌더",
    visual_review: "AI 시각 검수",
    s3_upload: "미디어 업로드",
    container_create: "Instagram 컨테이너 생성",
    child_container_create: "캐러셀 항목 생성",
    carousel_container_create: "캐러셀 생성",
    container_status: "Instagram 미디어 처리",
    instagram_publish: "Instagram 게시",
    media_publish: "Instagram 최종 게시",
    publish_reconciliation: "게시 성공 여부 대조",
  };
  return labels[value] ?? value;
}

function failureCategoryLabel(value: string): string {
  const labels: Record<string, string> = {
    transient: "일시적 네트워크·서버 오류",
    ai_quality: "AI 생성·검수 미통과",
    source_data: "원천 데이터 미도착·부족",
    source_validation: "원천 데이터 불일치",
    auth: "인증 오류",
    configuration: "설정·요청 오류",
    ambiguous_publish: "게시 응답 불명확 · 중복 대조 필요",
  };
  return labels[value] ?? value;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
