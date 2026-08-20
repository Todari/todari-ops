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
        expect.objectContaining({ name: "실패 단계", value: "섹터4 스케줄러" }),
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
