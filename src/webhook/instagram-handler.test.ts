import { describe, expect, it } from "vitest";
import { buildInstagramMessage, normalizeInstagramEvent } from "./instagram-handler.js";

const validPayload = {
  account: "jakkuyagu",
  media_id: "17890000000000000",
  permalink: "https://www.instagram.com/p/example/",
  preview_url: "https://bucket.s3.ap-northeast-2.amazonaws.com/preview.png?signature=test",
  caption: "오늘 경기 프리뷰\n선발 라인업과 관전 포인트를 확인하세요.",
  content_type: "preview",
  source_key: "2026-08-20:preview:game-1",
  quality_review: {
    audience: "baseball_fan",
    overall_score: 84,
    scores: {
      factual_trust: 95,
      information_density: 78,
      game_story: 82,
      fan_interest: 83,
      natural_voice: 80,
      visual_delivery: 86,
    },
    summary: "경기 흐름이 잘 보이지만 한 장면의 맥락은 더 보강할 수 있습니다.",
    strengths: ["득점 전후 점수가 명확합니다."],
    improvements: ["투수 교체 뒤 흐름을 한 문장 더 연결하세요."],
  },
  published_at: "2026-08-20T12:34:56+09:00",
};

describe("Instagram webhook event", () => {
  it("normalizes a signed publisher payload and builds a linked embed", () => {
    const event = normalizeInstagramEvent(validPayload);
    expect(event).not.toBeNull();
    const message = buildInstagramMessage(event!);
    const embed = message.embeds?.[0];
    const json = embed && "toJSON" in embed ? embed.toJSON() : embed;

    expect(json).toMatchObject({
      title: "새 게시물 · 오늘 경기 프리뷰",
      url: validPayload.permalink,
      description: "선발 라인업과 관전 포인트를 확인하세요.",
      image: { url: validPayload.preview_url },
    });
    expect(message.components).toHaveLength(1);
    expect(json).toMatchObject({ author: { name: "야있날 @yaitnal" } });
    expect(json?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "야구팬 관점 품질 점수" }),
        expect.objectContaining({ name: "다음 생성에서 개선" }),
      ]),
    );
    const row = message.components?.[0];
    const rowJson = row && "toJSON" in row ? row.toJSON() : row;
    expect(rowJson).toMatchObject({
      components: [
        {
          label: "게시물 바로 보기",
          url: validPayload.permalink,
        },
      ],
    });
  });

  it("rejects unknown accounts and non-Instagram links", () => {
    expect(normalizeInstagramEvent({ ...validPayload, account: "unknown" })).toBeNull();
    expect(
      normalizeInstagramEvent({ ...validPayload, permalink: "https://example.com/phishing" }),
    ).toBeNull();
  });

  it("allows a notification when permalink lookup was unavailable", () => {
    const event = normalizeInstagramEvent({ ...validPayload, permalink: null });
    expect(event?.status).toBe("published");
    if (!event || event.status !== "published") throw new Error("expected published event");
    expect(event.permalink).toBeNull();
    expect(buildInstagramMessage(event!).components).toHaveLength(1);
  });

  it("keeps compatibility with publishers that have no fan review yet", () => {
    const event = normalizeInstagramEvent({ ...validPayload, quality_review: null });
    expect(event?.status).toBe("published");
    if (!event || event.status !== "published") throw new Error("expected published event");
    expect(event.qualityReview).toBeNull();
  });

  it("accepts an approved quality review with no improvements", () => {
    const event = normalizeInstagramEvent({
      ...validPayload,
      account: "sector4",
      quality_review: {
        audience: "f1_fan",
        overall_score: 94,
        scores: { factual_trust: 95, fan_interest: 94 },
        summary: "사실과 레이스 맥락을 충분히 전달했습니다.",
        strengths: ["전체 순위와 주요 변화를 함께 보여줍니다."],
        improvements: [],
      },
    });

    expect(event?.status).toBe("published");
    if (!event || event.status !== "published") throw new Error("expected published event");
    const message = buildInstagramMessage(event);
    const embed = message.embeds?.[0];
    const json = embed && "toJSON" in embed ? embed.toJSON() : embed;
    expect(json?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "다음 생성에서 개선",
          value: "승인 기준에서 추가 개선점 없음",
        }),
      ]),
    );
  });

  it("accepts jujinmo reel publishes with its own series labels", () => {
    const event = normalizeInstagramEvent({
      account: "jujinmo",
      media_id: "17890000000000001",
      permalink: "https://www.instagram.com/reel/example/",
      caption: "장전 한 장\n오늘 장에서 먼저 볼 세 가지.\n특정 종목의 매수·매도를 권유하지 않습니다.",
      content_type: "premarket_preview",
      source_key: "2026-08-25-premarket",
      quality_review: null,
      published_at: "2026-08-25T08:05:00+09:00",
    });
    expect(event?.status).toBe("published");
    if (!event || event.status !== "published") throw new Error("expected published event");
    const message = buildInstagramMessage(event);
    const embed = message.embeds?.[0];
    const json = embed && "toJSON" in embed ? embed.toJSON() : embed;
    expect(json).toMatchObject({ author: { name: "주진모? @ju.jin.mo" } });
    expect(json?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "게시물 유형", value: "장전 한 장" }),
      ]),
    );
  });

  it("builds a red embed for jujinmo scheduled failures", () => {
    const event = normalizeInstagramEvent({
      account: "jujinmo",
      status: "failed",
      error_type: "RuntimeError",
      error_message: "게시 설정 미완료: IG_ACCESS_TOKEN",
      content_type: "close_review",
      source_key: "2026-08-25-close",
      stage: "scheduler_preflight",
      failure_category: "configuration",
      attempt: 1,
      next_retry_at: null,
      occurred_at: "2026-08-25T16:20:00+09:00",
    });
    expect(event?.status).toBe("failed");
    if (!event || event.status !== "failed") throw new Error("expected failure event");
    const message = buildInstagramMessage(event);
    const embed = message.embeds?.[0];
    const json = embed && "toJSON" in embed ? embed.toJSON() : embed;
    expect(json).toMatchObject({ title: "주진모? 자동 게시 실패" });
  });

  it("rejects non-HTTPS preview images", () => {
    expect(
      normalizeInstagramEvent({ ...validPayload, preview_url: "http://example.com/preview.png" }),
    ).toBeNull();
  });

  it("builds an actionable red embed for a sanitized publish failure", () => {
    const event = normalizeInstagramEvent({
      account: "sector4",
      status: "failed",
      error_type: "RuntimeError",
      error_message: "Instagram Graph API 오류(400): token expired",
      content_type: "sector4-poller",
      source_key: "result-2026-r13",
      stage: "media_publish",
      failure_category: "ambiguous_publish",
      attempt: 2,
      next_retry_at: "2026-08-20T15:00:00+09:00",
      occurred_at: "2026-08-20T14:45:00+09:00",
    });
    expect(event).not.toBeNull();

    const message = buildInstagramMessage(event!);
    const embed = message.embeds?.[0];
    const json = embed && "toJSON" in embed ? embed.toJSON() : embed;
    expect(json).toMatchObject({
      color: 0xed4245,
      title: "섹터4 자동 게시 실패",
      description: "Instagram Graph API 오류(400): token expired",
      author: { name: "섹터4 @sector4.f1" },
    });
    expect(json?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "게시물 유형", value: "섹터4 스케줄러" }),
        expect.objectContaining({ name: "실패 지점", value: "Instagram 최종 게시" }),
        expect.objectContaining({ name: "원인 분류", value: "게시 응답 불명확 · 중복 대조 필요" }),
        expect.objectContaining({ name: "누적 시도", value: "2회" }),
        expect.objectContaining({ name: "대상", value: "`result-2026-r13`" }),
      ]),
    );
  });

  it("rejects malformed failure events", () => {
    expect(
      normalizeInstagramEvent({
        account: "jakkuyagu",
        status: "failed",
        error_type: "RuntimeError",
        error_message: "",
        occurred_at: "not-a-date",
      }),
    ).toBeNull();
  });
});
